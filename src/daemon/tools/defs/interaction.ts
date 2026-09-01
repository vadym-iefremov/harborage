import { existsSync } from 'node:fs';
import { basename, isAbsolute } from 'node:path';

import type { Frame, Locator, Page, Response } from 'playwright';
import * as z from 'zod/v4';

import { defineTool, defineTools, text, type ToolContext, type ToolResult } from '../types.js';
import { pageId, sessionId } from './common.js';

/**
 * The handful of browser globals the in-page snippets in this file touch.
 *
 * The daemon's own tsconfig has no "dom" lib, and that is deliberate: it is a
 * Node process, and pulling the whole DOM in would let browser APIs leak into
 * daemon code unnoticed. Declaring exactly what these snippets use keeps them
 * type-checked without opening that door.
 */
interface PageElement {
  tagName: string;
  id: string;
  value?: string;
  textContent: string | null;
  // Every member below is optional for the same reason `value` is: the test
  // tsconfig pulls in lib.dom, and a required member a plain HTMLElement does
  // not have stops these callbacks type-checking under it.
  type?: string;
  multiple?: boolean;
  options?: ArrayLike<PageOptionElement>;
  files?: ArrayLike<PageFile> | null;
  control?: PageElement | null;
  parentElement?: PageElement | null;
  // A real, readable property in Chromium, not merely an HTML attribute: an
  // editor built on the EditContext API attaches one to keep its authoritative
  // text there instead of in the DOM, which is exactly why its presence is
  // what readFieldValue's readback honesty check looks for.
  editContext?: unknown;
  scrollLeft?: number;
  scrollTop?: number;
  scrollWidth?: number;
  scrollHeight?: number;
  clientWidth?: number;
  clientHeight?: number;
  matches(selector: string): boolean;
  getAttribute(name: string): string | null;
  // Loosely typed on purpose: the real DOM signature takes a Node, and the
  // test tsconfig does pull in lib.dom, so anything narrower stops these
  // callbacks type-checking under it.
  contains(other: any): boolean;
}
interface PageOptionElement {
  value: string;
  label: string;
  text: string;
  selected: boolean;
}
interface PageFile {
  name: string;
  size: number;
  type: string;
}
/**
 * PageElement widened with the two members needed to drill through and climb
 * back out of a shadow tree: shadowRoot for hitTestPointerPoint's descent,
 * getRootNode for readScrollState's ascent.
 *
 * Kept off PageElement itself rather than added to it, because
 * Locator.evaluate's real Playwright signature checks a callback's own
 * element parameter against a genuine HTMLElement (the test tsconfig, unlike
 * this file's own, does pull in lib.dom), and getRootNode()'s declared
 * return type here, `{ host?: ShadowDrillElement }`, has no property in
 * common with the real Node a live getRootNode() returns. TypeScript's weak
 * type check rejects that pairing outright, which broke every OTHER
 * locator.evaluate callback in this file, not just the ones that actually
 * touch a shadow tree, the one time this was added directly to PageElement.
 * Applied only where drilling is actually needed, through a cast on
 * document.elementFromPoint's own result, never on a callback's `el`.
 */
interface ShadowDrillElement extends PageElement {
  // Present (possibly null, for a closed root) on any element that is
  // itself a shadow host. Absent entirely on one that is not. The same
  // drill element_box's topmostAtCentre runs; see the matching member on
  // ProbeElement in inspect.ts.
  shadowRoot?: { elementFromPoint?(x: number, y: number): ShadowDrillElement | null } | null;
  // Real signature returns Node, which is not this interface, but callers
  // here only ever read .host off the result, and both a Document and a
  // ShadowRoot structurally satisfy "optionally has a host".
  getRootNode(): { host?: ShadowDrillElement };
}
/**
 * Only the two members the settle snapshot reads. timeOrigin identifies a
 * document (two documents loaded microseconds apart still differ), and the
 * navigation entry is the document's OWN record of the request that produced
 * it, which is the only place a status can be read from the document rather
 * than inferred about it.
 */
declare const performance: {
  timeOrigin: number;
  getEntriesByType(type: string): { name?: string; responseStatus?: number }[];
};

declare const document: {
  activeElement: PageElement | null;
  /** Read by navigate's and reload's settle snapshot, together with performance.timeOrigin, in one crossing. */
  title: string;
  /** Read by the same snapshot, to spot a <meta http-equiv="refresh"> that will move the tab after the call returns. */
  querySelector(selector: string): PageElement | null;
  addEventListener(type: string, handler: () => void, options?: unknown): void;
  removeEventListener(type: string, handler: () => void, options?: unknown): void;
  elementFromPoint(x: number, y: number): PageElement | null;
  scrollingElement: PageElement | null;
};
declare const window: {
  innerWidth: number;
  innerHeight: number;
  devicePixelRatio: number;
  getSelection(): { removeAllRanges(): void } | null;
  getComputedStyle(element: PageElement): { overflowX: string; overflowY: string };
  __harborageDragProbed?: boolean;
  __harborageDragStarts?: number;
};

/** The tags whose contents live in `.value` rather than in their child nodes. */
const formControlTags = ['INPUT', 'TEXTAREA', 'SELECT'];

/**
 * The modifier this machine's own browser binds its editing accelerators to:
 * Meta on macOS, Control everywhere else. Pressing the other one does not
 * throw, it just presses a chord the browser has no accelerator bound to, and
 * that is a trap `press_key` shares with the select-all logic below: a chord
 * built on the wrong platform's modifier reports an ordinary success and
 * silently does nothing.
 */
const platformAcceleratorModifier = process.platform === 'darwin' ? 'Meta' : 'Control';

/** The other one: the modifier that looks plausible but is not this platform's own. */
const nonAcceleratorModifier = platformAcceleratorModifier === 'Meta' ? 'Control' : 'Meta';

/**
 * The select-all chord a real user would press on this machine. Derived
 * rather than hardcoded, for the reason `platformAcceleratorModifier` above
 * exists: pressing the wrong one selects nothing at all, silently turning a
 * "replace" back into the append that `fill` exists to prevent.
 */
const selectAllChord = `${platformAcceleratorModifier}+a`;

/**
 * Why `press_key` should not be trusted at face value when the caller reached
 * for a specific modifier: null when the chord is fine as is, otherwise the
 * note to attach.
 *
 * The chord itself is never rewritten: a page can genuinely listen for
 * ctrl+A on its own regardless of what the OS binds, and silently swapping
 * the modifier would be its own false pass, reporting success for a chord
 * that was never actually pressed. What this catches instead is the trap a
 * page cannot save the caller from: Control+a on macOS presses cleanly and
 * selects nothing, because the browser has no built-in accelerator on that
 * chord at all, so the call reports an ordinary success while nothing
 * happened. ControlOrMeta is exempt: Playwright itself resolves it to
 * whichever modifier is this platform's own, so it is never the wrong one.
 */
function nonAcceleratorChordNote(key: string): string | null {
  const modifiers = key.split('+').slice(0, -1);
  if (modifiers.includes('ControlOrMeta')) return null;
  if (modifiers.includes(platformAcceleratorModifier)) return null;
  if (!modifiers.includes(nonAcceleratorModifier)) return null;
  return (
    `This chord's modifier is "${nonAcceleratorModifier}", but ${process.platform}'s own accelerator modifier is ` +
    `"${platformAcceleratorModifier}". The press above did not throw, and it also did not trigger a browser ` +
    `built-in editing accelerator (select-all and the rest all bind to ${platformAcceleratorModifier} here), so a ` +
    'chord built for one of those can succeed and do nothing at all. Use ' +
    `"${platformAcceleratorModifier}+..." for this platform specifically, or "ControlOrMeta+..." for the portable ` +
    'form that resolves to the right modifier on every platform.'
  );
}

/** Playwright's navigation wait conditions, shared by navigate and reload. */
const waitUntil = z
  .enum(['load', 'domcontentloaded', 'networkidle', 'commit'])
  .optional()
  .describe('Playwright navigation wait condition. Defaults to "load".');

/** An offset inside an element, shared by click and hover: both take it or neither coordinate. */
const selectorPosition = {
  x: z
    .number()
    .optional()
    .describe('Horizontal offset in CSS pixels from the element\'s top-left corner. Must be given together with y.'),
  y: z
    .number()
    .optional()
    .describe('Vertical offset in CSS pixels from the element\'s top-left corner. Must be given together with x.')
};

/** The tag name of whatever a locator points at, uppercase, as the DOM reports it. */
function tagNameOf(locator: Locator): Promise<string> {
  return locator.evaluate((el: PageElement) => el.tagName);
}

/**
 * What the field really holds right now: `.value` for a form control,
 * `textContent` for anything else. Two branches rather than one because a
 * Playwright selector is not always a CSS selector, so the selector case has
 * to go through a Locator, while the focused case has nothing to build one
 * from.
 */
function readFieldValue(page: Page, locator: Locator | null): Promise<string> {
  if (locator) {
    return locator.evaluate(
      (el: PageElement, tags: string[]) => (tags.includes(el.tagName) ? el.value ?? '' : el.textContent ?? ''),
      formControlTags
    );
  }
  return page.evaluate((tags: string[]) => {
    const el = document.activeElement;
    if (!el) return '';
    return tags.includes(el.tagName) ? el.value ?? '' : el.textContent ?? '';
  }, formControlTags);
}

/**
 * Class and attribute markers a real Monaco 0.45.0 and CodeMirror 6.0.1
 * instance were both found to carry, probed directly rather than guessed at:
 * `.monaco-editor` wraps the whole widget and `[data-mode-id]` is Monaco's
 * own language marker, while CodeMirror carries both `.cm-editor` (the outer
 * view) and `.cm-content` (the actual editable node, which is what a
 * selector usually targets). Kept to markers that were actually verified so
 * an ordinary contenteditable that merely LOOKS rich, a role="textbox" widget
 * with no virtualization behind it, does not get flagged for a problem it
 * does not have.
 */
const richEditorMarkers = '.monaco-editor, [data-mode-id], .cm-editor, .cm-content';

/**
 * Why textContent cannot be trusted for a Monaco or CodeMirror instance.
 * Both were probed with a 500-line, ~25000 character document: Monaco's
 * textContent came back around 600 characters, CodeMirror's around 3200,
 * both truncated and with no newline between lines, because the rendered
 * view is a flat run of positioned line elements, not a document tree, and
 * only the lines currently on screen exist in the DOM at all.
 */
const virtualizedEditorWarning =
  'This looks like a Monaco or CodeMirror instance. Both virtualize their lines, so textContent only covers ' +
  'what is currently rendered on screen: a long document reads back truncated, and with no newline between ' +
  'lines, since the rendered view is a flat run of positioned line elements rather than a document tree. ' +
  '"value" below is what the DOM happens to show, not what the editor actually holds. Read the real content ' +
  'through the editor\'s own API instead, with evaluate: monaco.editor.getModels()[0].getValue() for Monaco, or ' +
  'a CodeMirror view\'s state.doc.toString().';

/**
 * Why textContent cannot be trusted for an element with an attached
 * EditContext. Confirmed directly: attaching a real EditContext to a
 * contenteditable element in Chromium left its textContent empty even though
 * the EditContext itself held real text throughout, because the EditContext
 * is the editor's authoritative text store, not the DOM.
 */
const editContextWarning =
  'This element has an EditContext attached. Per the EditContext API, the EditContext itself, not the DOM, is ' +
  'the editor\'s authoritative text store, so textContent can sit empty or stale even right after a write really ' +
  'landed. "value" below is not to be trusted here. Read the real content back through the editor\'s own API ' +
  'instead, with evaluate.';

/**
 * Whether `el`'s textContent can be trusted as a readback, and why not when
 * it cannot. Self-contained on purpose: it runs inside the page through
 * `locator.evaluate`, which serializes only this function's own source, so it
 * takes every message it might return as an argument rather than closing
 * over the module-level constants above.
 */
function richEditorWarning(
  el: PageElement,
  messages: { markers: string; virtualized: string; editContext: string }
): string | null {
  let node: PageElement | null = el;
  for (let hops = 0; node && hops < 8; hops += 1) {
    if (node.matches(messages.markers)) return messages.virtualized;
    node = node.parentElement ?? null;
  }
  return el.editContext ? messages.editContext : null;
}

/**
 * The same check as `richEditorWarning`, for the no-selector case: there is
 * no locator to evaluate against, only whatever currently has focus, so this
 * reads `document.activeElement` itself before walking up from it. Kept as
 * its own top-level function rather than sharing a call to
 * `richEditorWarning` for the same serialization reason: `page.evaluate` only
 * sends the one function it is given, not whatever it happens to call.
 */
function richEditorWarningForFocused(messages: {
  markers: string;
  virtualized: string;
  editContext: string;
}): string | null {
  const el = document.activeElement;
  if (!el) return null;
  let node: PageElement | null = el;
  for (let hops = 0; node && hops < 8; hops += 1) {
    if (node.matches(messages.markers)) return messages.virtualized;
    node = node.parentElement ?? null;
  }
  return el.editContext ? messages.editContext : null;
}

/** Arguments `richEditorWarning`/`richEditorWarningForFocused` are called with, bundled once. */
const richEditorWarningMessages = { markers: richEditorMarkers, virtualized: virtualizedEditorWarning, editContext: editContextWarning };

/** What the field really holds, plus whether that readback is one a rich editor can defeat. */
function readReadbackReliability(page: Page, locator: Locator | null): Promise<string | null> {
  return locator
    ? locator.evaluate(richEditorWarning, richEditorWarningMessages)
    : page.evaluate(richEditorWarningForFocused, richEditorWarningMessages);
}

/**
 * Replaces a field's contents for real.
 *
 * A contenteditable goes through actual keyboard events (focus, select-all,
 * delete, insert) rather than a plain insertion, because CodeMirror and
 * Monaco keep their own document model and treat an insertion as an insert at
 * their own cursor. That is how filling `{{ $json.mode }}` over `result`
 * produced `{{ $json.mode }}result`: the editor never saw the old text go
 * away. Deleting with a key press is what a human does, so the editor handles
 * it the way it handles a human.
 */
async function setFieldValue(page: Page, locator: Locator, value: string): Promise<void> {
  const tagName = await tagNameOf(locator);
  // Playwright's fill has never accepted a <select>, and the error it throws
  // describes the element rather than the way out, so say the way out here.
  if (tagName === 'SELECT') {
    throw new Error(
      'fill cannot set a <select>: it only works on an input, a textarea or a contenteditable. Use select_option instead, which picks by value, by label or by index and reads the resulting selection back.'
    );
  }
  if (formControlTags.includes(tagName)) {
    await locator.fill(value);
    return;
  }
  await locator.focus();

  // Select-all is scoped to whatever holds the caret, so pressing it while
  // focus never landed on the target would select the whole document and the
  // delete below would empty the page. Refuse loudly instead.
  const focused = await locator.evaluate((el: PageElement) => {
    const active = document.activeElement;
    return active !== null && (active === el || el.contains(active));
  });
  if (!focused) {
    throw new Error(
      'fill could not put focus inside the target element, so it stopped rather than pressing select-all against the whole document. Is the selector pointing at an input, a textarea, or a contenteditable?'
    );
  }

  await page.keyboard.press(selectAllChord);
  await page.keyboard.press('Delete');
  if (value.length > 0) {
    await page.keyboard.insertText(value);
  }
}

/**
 * Every tool that writes text reports what the field actually contains
 * afterwards, not merely that the write was attempted. A wrong result that
 * looks like a success is what let a QA agent draw conclusions about a value
 * it never set, so a mismatch is stated in the payload rather than left for
 * the caller to discover by reading the field back themselves.
 */
function writeResult(
  base: Record<string, unknown>,
  actual: string,
  matched: boolean,
  expectation: string,
  readbackWarning?: string | null
): ToolResult {
  // A rich editor's own textContent readback cannot be trusted, so "matched"
  // is not computed at all here: reporting true would be the false pass this
  // whole file exists to avoid, and reporting false would look like a real
  // write failure when the write may well have landed exactly as asked.
  // Neither claim is honest, so neither is made.
  if (readbackWarning) {
    return text({ ...base, value: actual, readbackReliable: false, note: readbackWarning });
  }
  if (matched) {
    return text({ ...base, value: actual, matched: true, readbackReliable: true });
  }
  return text({
    ...base,
    value: actual,
    matched: false,
    readbackReliable: true,
    note:
      `The field does not contain what was expected. ${expectation} It now contains ${JSON.stringify(actual)}. ` +
      'The page may have rewritten, truncated or reformatted the input, or the write may have landed somewhere other than the intended element. Trust "value", not the request.'
  });
}

/**
 * Whether `actual` is `before` with `typed` inserted at one point in it.
 *
 * Typing goes in at the caret, and where the caret sits is the browser's call:
 * an input puts it after the existing text, a contenteditable before it. So a
 * flat `before + typed` comparison would report a mismatch for a perfectly
 * correct insertion. This still catches everything that matters: text the page
 * rewrote, truncated, or that never landed at all.
 */
function isInsertionOf(before: string, typed: string, actual: string): boolean {
  if (actual.length !== before.length + typed.length) return false;
  for (let i = 0; i <= before.length; i += 1) {
    if (before.slice(0, i) + typed + before.slice(i) === actual) return true;
  }
  return false;
}

/**
 * A document's identity: a number fixed for the life of one document. Needed
 * because `page.goto()` returning null does not by itself mean the document
 * survived. It is also null for `about:blank` and for non-HTTP schemes, where
 * a new document really was created.
 */
function documentIdentity(page: Page): Promise<number | null> {
  return page.evaluate(() => performance.timeOrigin).catch(() => null);
}

/** A real pause, for drag's hold and settle knobs. */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** How long resolving one pointer endpoint's selector is allowed to take before the tool gives up on it. */
const POINTER_ENDPOINT_TIMEOUT_MS = 5000;

/** A pointer endpoint as the caller gave it, before it becomes a viewport point. */
interface PointerEndpoint {
  selector?: string;
  x?: number;
  y?: number;
}

/** A pointer endpoint after resolution: the viewport point the mouse really visits. */
interface PointerPoint {
  selector?: string;
  x: number;
  y: number;
}

/**
 * Clears any text the page currently has selected, arms a probe that notices
 * a native drag starting, and returns the identity of the document it was
 * armed on (readDragProbe below needs it).
 *
 * The selection-clearing exists because of a trap found the hard way.
 * Pressing inside an existing text selection makes Chromium drag the
 * SELECTION rather than let the page see the gesture: pointermove stops
 * firing entirely from that moment on, so a canvas library gets a
 * pointerdown, nothing, and a pointerup, and leaves its node exactly where
 * it was while every call reports success. A selection left behind by an
 * EARLIER drag is enough to do it, which makes the second drag of a run
 * behave differently from the first. Clearing it keeps a drag meaning the
 * same thing every time.
 *
 * The document identity is returned for a second, quieter trap in the same
 * family: the counter this arms lives on ONE document, and if the gesture
 * itself navigates the page away (a native drag started on a plain link, or
 * an unrelated navigation mid-gesture), the listener and the counter both
 * leave with it. Nothing throws when that happens: a fresh document reads
 * window.__harborageDragStarts as undefined, which reads back as an ordinary,
 * quiet "no drag happened" exactly like a genuine negative would. Only
 * comparing where the probe was armed against where it is read, in
 * readDragProbe, catches that.
 */
function armDragProbe(page: Page): Promise<number> {
  return page.evaluate(() => {
    window.getSelection()?.removeAllRanges();
    window.__harborageDragStarts = 0;
    // Installed once per document and left in place rather than added and
    // removed around each drag: a listener per gesture would pile up on a page
    // that is dragged repeatedly, and a fresh document zeroes this anyway.
    if (!window.__harborageDragProbed) {
      window.__harborageDragProbed = true;
      document.addEventListener(
        'dragstart',
        function () {
          window.__harborageDragStarts = (window.__harborageDragStarts ?? 0) + 1;
        },
        true
      );
    }
    return performance.timeOrigin;
  });
}

/**
 * Whether the browser ran the gesture just performed as a native HTML5 drag,
 * null when that cannot be answered honestly.
 *
 * This is the same trap hover's readback fix targets, one level earlier: a
 * read that cannot be trusted is not the same thing as a read that ran and
 * found nothing, and collapsing the two into "false" reports genuine
 * ignorance as though it were negative evidence. `armedOn`, the document
 * identity armDragProbe was run on, is compared against the document
 * identity right now. They differ exactly when the gesture navigated the
 * page away, which leaves the counter on a document that no longer exists;
 * reading window.__harborageDragStarts on whatever loaded in its place
 * returns undefined without a single check ever throwing, and that used to
 * read back as a clean, confident "false". An outright evaluate failure (a
 * destroyed execution context caught mid-navigation) folds into the same
 * null.
 */
async function readDragProbe(page: Page, armedOn: number): Promise<boolean | null> {
  const now = await documentIdentity(page);
  if (now === null || now !== armedOn) return null;
  return page.evaluate(() => (window.__harborageDragStarts ?? 0) > 0).catch(() => null);
}

/**
 * Turns one pointer endpoint into the viewport point the mouse will visit.
 *
 * Three shapes, because a canvas app needs all three: a selector alone means
 * the element's centre, a selector with an offset means a spot inside it (the
 * drag handle in a node's header, not its middle), and a bare x/y means a
 * region of a canvas that is not a DOM element at all and has no selector to
 * name it. Shared by drag and wheel: a wheel has to land on a point too,
 * because a canvas zooms toward the pointer.
 */
async function resolvePointerPoint(
  page: Page,
  spec: PointerEndpoint,
  tool: string,
  which: string,
  timeout: number
): Promise<PointerPoint> {
  const hasSelector = spec.selector !== undefined;
  const hasX = spec.x !== undefined;
  const hasY = spec.y !== undefined;

  if (hasX !== hasY) {
    throw new Error(`${tool}'s ${which} needs both "x" and "y", or neither. Only one was given.`);
  }
  if (!hasSelector && !hasX) {
    throw new Error(
      `${tool} needs a ${which}: give ${which}.selector for the element's centre, ${which}.x and ${which}.y for a point in the viewport, or a selector together with x and y for an offset inside that element.`
    );
  }
  if (!hasSelector) {
    return { x: spec.x as number, y: spec.y as number };
  }

  const selector = spec.selector as string;
  const locator = page.locator(selector);
  try {
    await locator.waitFor({ state: 'attached', timeout });
    await locator.scrollIntoViewIfNeeded({ timeout });
  } catch {
    throw new Error(
      `${tool} could not resolve its ${which} selector ${JSON.stringify(selector)} within ${timeout}ms. If the element appears late, call wait_for first: ${tool} does not wait for a page to settle.`
    );
  }

  const box = await locator.boundingBox({ timeout }).catch(() => null);
  if (!box) {
    throw new Error(
      `${tool} found the ${which} selector ${JSON.stringify(selector)} but it has no layout box, so there is no point to aim at. It is probably display:none or zero-sized.`
    );
  }

  return hasX
    ? { selector, x: box.x + (spec.x as number), y: box.y + (spec.y as number) }
    : { selector, x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** How a covering element is named, the same shape element_box's occludedBy uses. */
interface TopmostElement {
  tagName: string;
  id: string;
  classes: string | null;
}

/**
 * Whether a resolved pointer point really belongs to the element a caller named, and what
 * is there if it does not.
 *
 * resolvePointerPoint only ever measures a bounding box: it has no opinion on what is drawn
 * on top of that box, so a selector that used to be safe to press stays "resolved" correctly
 * even after a modal or a loading spinner covers it completely. The mouse still goes to the
 * right coordinates; the coordinates just no longer belong to the element the caller thinks
 * they do. element_box catches exactly this for a plain click target with elementFromPoint,
 * and this reuses the same test rather than inventing a second one.
 *
 * The match is deliberately wider than element_box's topmostAtCentre, which only accepts the
 * element itself or a descendant of it. A descendant is still accepted here for the same
 * reason (a click aimed at a <button>'s centre is received by whatever inline element paints
 * there, and the button still opens). An ANCESTOR is accepted too, which topmostAtCentre is
 * not asked to do: a selector can legitimately name a node nested inside the thing that
 * really receives pointer events, such as a label inside a bigger draggable region, or a
 * canvas whose interactive overlay is the target's own parent. Rejecting that as an
 * "occlusion" would turn a normal, working drag into a false failure. Anything that is
 * neither the target, an ancestor, nor a descendant of it really is a different element
 * receiving the gesture, and that is what gets reported.
 *
 * A raw x/y endpoint names no element, so there is nothing to compare against: matchesTarget
 * comes back null rather than false, which would read as a failure that was never checked.
 * elementAtPoint is still filled in when something is there, purely as a diagnostic: a canvas
 * drag that silently does nothing is much faster to debug once you know the point actually
 * landed on a debug banner rather than the canvas.
 */
async function hitTestPointerPoint(
  page: Page,
  point: PointerPoint
): Promise<{ matchesTarget: boolean | null; elementAtPoint: TopmostElement | null }> {
  if (point.selector === undefined) {
    const elementAtPoint = await page.evaluate((arg: { x: number; y: number }) => {
      // Drilled the same way the selector branch below is, and for the same reason: without
      // it, a raw point sitting inside a shadow tree would always be reported as the shadow
      // host itself, which is a useless answer for a diagnostic field whose whole point is
      // naming what is really there. Cast rather than declared, per ShadowDrillElement's own
      // comment: document's shared declaration stays PageElement so every other call in this
      // file keeps type-checking against a real HTMLElement.
      let hit = document.elementFromPoint(arg.x, arg.y) as ShadowDrillElement | null;
      let shadowDrillDepth = 0;
      while (hit && hit.shadowRoot && typeof hit.shadowRoot.elementFromPoint === 'function' && shadowDrillDepth < 20) {
        const deeper = hit.shadowRoot.elementFromPoint(arg.x, arg.y);
        if (!deeper || deeper === hit) break;
        hit = deeper;
        shadowDrillDepth += 1;
      }
      return hit ? { tagName: String(hit.tagName).toLowerCase(), id: hit.id || '', classes: hit.getAttribute('class') } : null;
    }, point);
    return { matchesTarget: null, elementAtPoint };
  }

  // A fresh locator rather than the one resolvePointerPoint already built: this runs
  // immediately afterwards against the same page, so it resolves to the same element, and
  // reusing it here would mean threading a Locator through resolvePointerPoint's return
  // value for every caller that never needs it.
  const locator = page.locator(point.selector);
  return locator.evaluate((el: PageElement, arg: { x: number; y: number }) => {
    // document.elementFromPoint retargets into the shadow host for ANYTHING inside a shadow
    // tree, open or closed, and Node.contains() does not cross that boundary the other way:
    // confirmed directly against real Chromium, a shadow host does not contain() its own
    // shadow content, because a node's parent inside a shadow tree is the shadow root, not the
    // host. So without drilling, hit === el, el.contains(hit) and hit.contains(el) are ALL
    // false for anything inside a shadow root, occluded or not: a real drag or wheel target
    // with nothing whatsoever on top of it read as occluded by its own host, the drag/wheel
    // version of the bug element_box's topmostAtCentre had before its own fix (see inspect.ts).
    // Drilling through hit.shadowRoot.elementFromPoint recovers the real topmost node inside
    // the shadow tree, so the three comparisons above work again exactly as they do in the
    // light DOM: hit === el for a clean unoccluded target, and hit.contains(el) / el.contains(hit)
    // for an ordinary ancestor/descendant nesting, now evaluated within the shadow root's own
    // tree instead of against a host outside it. That is also what keeps a real overlay honest
    // once the drill is added: an overlay sitting on top of the target INSIDE THAT SAME shadow
    // root drills down to become `hit` itself, a SIBLING of `el`, not an ancestor, so it fails
    // all three comparisons and is reported as the occluder, rather than being missed (as it
    // was without the drill) or waved through as an ancestor it never structurally was.
    // ShadowRoot.elementFromPoint, unlike Document's, does not retarget, so re-querying the
    // same point against hit.shadowRoot is what makes this work, and repeating it handles
    // shadow roots nested in shadow roots. Kept in step with element_box's identical drill in
    // inspect.ts; if one changes, change the other.
    let hit = document.elementFromPoint(arg.x, arg.y) as ShadowDrillElement | null;
    let shadowDrillDepth = 0;
    while (hit && hit.shadowRoot && typeof hit.shadowRoot.elementFromPoint === 'function' && shadowDrillDepth < 20) {
      const deeper = hit.shadowRoot.elementFromPoint(arg.x, arg.y);
      if (!deeper || deeper === hit) break;
      hit = deeper;
      shadowDrillDepth += 1;
    }
    if (!hit) return { matchesTarget: false, elementAtPoint: null };
    const matchesTarget = hit === el || el.contains(hit) || hit.contains(el);
    return {
      matchesTarget,
      elementAtPoint: matchesTarget
        ? null
        : { tagName: String(hit.tagName).toLowerCase(), id: hit.id || '', classes: hit.getAttribute('class') }
    };
  }, point);
}

/** How `elementAtPoint` is named in a sentence, for the note a mismatched hit test writes. */
function describeElement(el: TopmostElement | null): string {
  if (!el) return 'nothing that elementFromPoint could find';
  const id = el.id ? ` id=${JSON.stringify(el.id)}` : '';
  const classes = el.classes ? ` class=${JSON.stringify(el.classes)}` : '';
  return `<${el.tagName}${id}${classes}>`;
}

/** A pointer endpoint's schema, shared by drag's source and target and by wheel's point, so all three mean the same thing. */
const pointerEndpoint = z
  .object({
    selector: z
      .string()
      .optional()
      .describe(
        'Playwright selector of the element. On its own this means the element\'s centre. Together with x and y it means an offset inside the element, which is how you grab a node by its header rather than its middle.'
      ),
    x: z
      .number()
      .optional()
      .describe(
        'Horizontal position in CSS pixels. With a selector it is an offset from the element\'s top-left corner; without one it is a raw viewport coordinate, which is what a canvas region with no DOM element of its own needs. Must be given together with y.'
      ),
    y: z
      .number()
      .optional()
      .describe('Vertical position in CSS pixels, read the same way as x. Must be given together with x.')
  })
  .describe('A point on the page: a selector, a raw viewport point, or a selector plus an offset inside it.');

/** The options selected in a `<select>` right now, read from the element itself. */
function readSelection(locator: Locator): Promise<{ multiple: boolean; selected: { value: string; label: string; index: number }[] }> {
  return locator.evaluate((el: PageElement) => {
    const options = el.options ?? [];
    const selected: { value: string; label: string; index: number }[] = [];
    for (let i = 0; i < options.length; i += 1) {
      const option = options[i];
      if (option.selected) {
        selected.push({ value: option.value, label: option.label || option.text, index: i });
      }
    }
    return { multiple: el.multiple === true, selected };
  });
}

/** The files attached to an `<input type="file">` right now, read from its own FileList. */
function readAttachedFiles(locator: Locator): Promise<{ name: string; size: number; type: string }[]> {
  return locator.evaluate((el: PageElement) => {
    // setInputFiles retargets a <label> to its control, so the readback has
    // to follow it there or it would report an empty list for a real upload.
    const input = el.tagName === 'LABEL' && el.control ? el.control : el;
    const files = input.files ?? [];
    const out: { name: string; size: number; type: string }[] = [];
    for (let i = 0; i < files.length; i += 1) {
      out.push({ name: files[i].name, size: files[i].size, type: files[i].type });
    }
    return out;
  });
}

/**
 * Where the tab sits in its own back/forward list, straight from Chromium.
 *
 * `page.goBack()` resolving to null cannot tell "there was no entry to go to"
 * apart from "went back, and it was a same-document step". Those mean opposite
 * things to a caller, and guessing between them from the URL is exactly the
 * silent no-op-as-success this tool exists to avoid. Chromium knows outright,
 * so ask it. Returns null if the query is unavailable, and the caller falls
 * back to inference.
 */
async function readNavigationHistory(
  context: { newCDPSession(page: Page): Promise<{ send(method: any, params?: any): Promise<unknown>; detach(): Promise<void> }> },
  page: Page
): Promise<{ index: number; length: number; urls: string[] } | null> {
  let cdpSession: { send(method: any, params?: any): Promise<unknown>; detach(): Promise<void> } | undefined;
  try {
    cdpSession = await context.newCDPSession(page);
    const history = (await cdpSession.send('Page.getNavigationHistory')) as {
      currentIndex: number;
      entries: unknown[];
    };
    // The entry URLs were already in this payload and were being discarded.
    // They are the only way to answer "did the step land on the entry it
    // aimed at", which an index alone cannot: a guard calling
    // location.replace swaps the entry's contents in place, so the index
    // moves exactly one the right way while the tab ends up on a page the
    // caller never asked for.
    return {
      index: history.currentIndex,
      length: history.entries.length,
      urls: history.entries.map(entry => String((entry as { url?: unknown }).url ?? ''))
    };
  } catch {
    return null;
  } finally {
    await cdpSession?.detach().catch(() => {});
  }
}

/**
 * One step through the tab's history, shared by navigate_back and
 * navigate_forward because the only thing that differs is the direction.
 *
 * Reports "navigated" separately from the resulting URL, because the two
 * failure modes look identical from the outside: `page.goBack()` resolves to
 * null both when there was nothing to go back to and when the step was a
 * same-document one. Chromium's own history is consulted first so the
 * no-op case is stated rather than inferred, and it is consulted again after
 * the step for the same reason: whether an entry EXISTED to step to says
 * nothing about whether the step actually landed there, since a page can
 * catch the popstate event this fires and step itself right back.
 * "navigated" is decided on evidence of real movement alone: a genuine HTTP
 * response, a changed URL, or a changed document identity.
 */
async function historyStep(
  ctx: ToolContext,
  args: {
    sessionId: string;
    pageId?: string;
    waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | 'commit';
    settleMs?: number;
    timeoutMs?: number;
  },
  direction: 'back' | 'forward'
): Promise<ToolResult> {
  const target = ctx.sessions.resolve(args.sessionId, args.pageId);
  const previousUrl = target.page.url();
  const history = await readNavigationHistory(target.session.context, target.page);
  const canStep =
    history === null ? null : direction === 'back' ? history.index > 0 : history.index < history.length - 1;

  if (canStep === false) {
    return text({
      pageId: target.pageId,
      navigated: false,
      url: previousUrl,
      title: await target.page.title().catch(() => ''),
      sameDocument: false,
      previousUrl,
      historyIndex: history?.index,
      historyLength: history?.length,
      note:
        `There is no ${direction} entry in this tab's history, so nothing happened: the tab is still on ${previousUrl}. ` +
        (direction === 'forward'
          ? 'Forward entries only exist directly after a back step, and navigating anywhere new discards them.'
          : 'This tab has not been anywhere else yet.')
    });
  }

  const before = await documentIdentity(target.page);
  // What this step is AIMING at, captured before it happens. The index alone
  // is not enough: a guard that calls location.replace from its popstate
  // handler swaps the entry's contents in place, so the index still moves
  // exactly one the right way while the tab lands on a page the caller never
  // asked for. Reproduced on a real SPA: index 16 to 15, "navigated": true,
  // "sameDocument": true, and a note promising the JS context survived, while
  // the tab was actually on a freshly loaded /login.
  const expectedIndex = history === null ? null : direction === 'back' ? history.index - 1 : history.index + 1;
  const expectedUrl = history === null || expectedIndex === null ? null : (history.urls[expectedIndex] ?? null);

  const watch = watchNavigationActivity(target.page);
  let response: Response | null = null;
  let timedOut = false;
  let settled: PageSnapshot;
  let stillMoving: boolean;
  const timeoutMs = args.timeoutMs ?? NAVIGATION_TIMEOUT_MS;
  const settleMs = args.settleMs ?? NAVIGATION_SETTLE_MS;
  try {
    try {
      const options = { timeout: timeoutMs, ...(args.waitUntil ? { waitUntil: args.waitUntil } : {}) };
      response = direction === 'back' ? await target.page.goBack(options) : await target.page.goForward(options);
    } catch (error) {
      // A beforeunload handler makes the step hang until the timeout and then
      // die on a raw Playwright error, which is a poor way to report the very
      // thing this tool documents: a page refusing to let the step happen.
      // Reported as the blocked step it is.
      if (!isTimeoutError(error)) throw error;
      timedOut = true;
    }
    // THE SETTLE, which this call site never had. goBack resolves as soon as
    // the traversal commits, and a guard's own navigation has not started
    // yet at that moment, so reading url and identity here described a
    // document that was about to be thrown away. This is the sibling call
    // site navigate's fix did not reach.
    ({ snapshot: settled, stillMoving } = await settleAfterNavigation(target.page, watch.activity, timedOut ? 0 : settleMs));
  } finally {
    watch.stop();
  }

  const url = settled.url;
  const afterHistory = await readNavigationHistory(target.session.context, target.page);

  // Same rule navigate uses, for the same reason: a null response alone is
  // ambiguous, so the document's own identity settles it, and an unreadable
  // identity errs toward warning the caller. Read from the SETTLED document,
  // so a guard that did a full page load can no longer be reported as a
  // same-document step whose JS context survived.
  const sameDocument =
    response === null && (before === null || settled.identity === null || before === settled.identity) && !timedOut;

  // Evidence the tab moved at all: a real HTTP response, a changed URL, or a
  // changed document identity. `canStep` is deliberately not part of this: it
  // only says an entry EXISTED to step to.
  const moved = response !== null || url !== previousUrl || (before !== null && settled.identity !== null && before !== settled.identity);

  // Three separate things have to hold for a step to count, and each of them
  // was found in production by an adversary attacking the previous two:
  // the tab moved, it ended on the index the step aimed at, and the entry it
  // landed on is the one it aimed at.
  const landedOnExpectedIndex = expectedIndex === null || afterHistory === null ? null : afterHistory.index === expectedIndex;
  // A NEW document is what separates a guard hijacking the step from an app
  // relabelling its own URL after arriving. location.replace and
  // location.assign both load a whole new document, which is the attack this
  // check exists for. history.replaceState does not, and an SPA tidying its
  // URL on arrival is a healthy, extremely common thing that must not be
  // reported as a blocked step: the round before this one turned a true
  // "ok" into null by making exactly that mistake in navigate, and the same
  // trap is here. So a URL that differs only without a document change
  // counts as having landed, and is still disclosed through "url".
  const loadedNewDocument =
    response !== null || (before !== null && settled.identity !== null && before !== settled.identity);
  const landedOnExpectedUrl = expectedUrl === null ? null : url === expectedUrl || !loadedNewDocument;
  const navigated = moved && landedOnExpectedIndex !== false && landedOnExpectedUrl !== false && !timedOut;

  const indexDelta = history === null || afterHistory === null ? null : afterHistory.index - history.index;
  const notes: string[] = [];
  if (navigated && sameDocument) {
    notes.push(
      'Same-document step: the URL changed but the document was NOT reloaded. The JS context, in-page state and the console buffer all survive, and the page saw a popstate event rather than a load. This is what a hash or pushState entry looks like going back.'
    );
  }
  if (timedOut) {
    notes.push(
      `Blocked: the ${direction} step did not finish within ${timeoutMs}ms and the tab is still on ${url}. A beforeunload handler is the usual cause, since it asks the browser to stay and this session dismisses that dialog rather than leaving. Treat this as a step the page refused, not as a tool failure. Raise "timeoutMs" if the page is merely slow.`
    );
  } else if (!navigated && moved) {
    // It moved, but not to where the step pointed. Say which way it went and
    // where it ended up, because "url" is the field a caller acts on.
    const parts: string[] = [
      `The tab moved, but this ${direction} step did not land where it aimed.`
    ];
    if (expectedUrl !== null && url !== expectedUrl) {
      parts.push(`It aimed at ${expectedUrl} and ended on ${url}, having loaded a whole new document to get there.`);
    }
    if (indexDelta !== null) {
      const magnitude = Math.abs(indexDelta);
      parts.push(
        indexDelta === 0
          ? `Chromium's own history index is back where it started (${afterHistory?.index}).`
          : `Chromium's own history index went from ${history?.index} to ${afterHistory?.index}, ${magnitude} entr${magnitude === 1 ? 'y' : 'ies'} ${indexDelta < 0 ? 'back' : 'forward'}, where a single ${direction} step moves one ${direction}.`
      );
    }
    parts.push(
      'That is a page intercepting the popstate this step fired and moving the tab itself, which is what a route guard, an unsaved-changes interceptor or a client-side auth bounce to a login page does. Treat this as a blocked step. ' +
        '"url", "title" and "sameDocument" all describe where the tab REALLY ended up, read after the page finished moving, so act on them rather than assuming the tab stayed put.'
    );
    notes.push(parts.join(' '));
  } else if (!navigated) {
    notes.push(
      `Nothing moved: the tab is still on ${previousUrl}, even though there was a ${direction} entry to step to. ` +
        'This is what a route guard or an unsaved-changes interceptor looks like from the outside: the page saw the ' +
        'popstate event this step fired and re-pushed its own URL right back, so the browser genuinely tried to move ' +
        'and the page genuinely stopped it. Treat this as a blocked step, not a no-op.'
    );
  }
  const pending: PendingNavigation | undefined = stillMoving
    ? {
        reason: `the tab was still navigating when the ${settleMs}ms settle window closed, so this describes a document that may already have been replaced`,
        afterMs: settleMs
      }
    : settled.pendingRefresh !== null
      ? {
          reason: `this document carries a meta refresh that fires in ${settled.pendingRefresh.seconds}s, so the tab will move on its own after this call returns`,
          afterMs: Math.round(settled.pendingRefresh.seconds * 1000)
        }
      : undefined;
  if (pending) notes.push(`This answer may already be out of date: ${pending.reason}.`);

  return text({
    pageId: target.pageId,
    navigated,
    url,
    title: settled.title,
    sameDocument: navigated ? sameDocument : false,
    previousUrl,
    ...(timedOut ? { timedOut: true } : {}),
    ...(history ? { previousHistoryIndex: history.index } : {}),
    ...(expectedUrl !== null ? { expectedUrl } : {}),
    ...(afterHistory ? { historyIndex: afterHistory.index, historyLength: afterHistory.length } : {}),
    ...pendingNavigationPayload(pending),
    ...(notes.length ? { note: notes.join(' ') } : {})
  });
}

/**
 * What is scrolled right now, both for the page and for whatever the wheel
 * would actually scroll at a given point.
 *
 * A wheel event does not say what it moved, and the thing under the pointer is
 * usually not the thing that scrolls: the browser walks up from the element at
 * the point to the first ancestor whose content overflows it. This walks the
 * same way, so "did anything move" can be answered instead of assumed.
 */
interface ScrollState {
  page: { x: number; y: number };
  target?: { tag: string; id: string; x: number; y: number };
}

function readScrollState(page: Page, x: number, y: number): Promise<ScrollState> {
  return page.evaluate(
    ([px, py]: [number, number]) => {
      const scroller = document.scrollingElement;
      const state: ScrollState = { page: { x: scroller?.scrollLeft ?? 0, y: scroller?.scrollTop ?? 0 } };
      // document.elementFromPoint retargets into the shadow host for anything inside a shadow
      // tree (the same trap hitTestPointerPoint above drills through), so without this a point
      // sitting over a scrollable container that lives INSIDE a shadow root would never even
      // see that container: the walk below would start at the host, which is not itself
      // scrollable, and climb its own ancestors instead, missing the real target entirely.
      // Cast rather than declared, per ShadowDrillElement's own comment above.
      let node = document.elementFromPoint(px, py) as ShadowDrillElement | null;
      let shadowDrillDepth = 0;
      while (node && node.shadowRoot && typeof node.shadowRoot.elementFromPoint === 'function' && shadowDrillDepth < 20) {
        const deeper = node.shadowRoot.elementFromPoint(px, py);
        if (!deeper || deeper === node) break;
        node = deeper;
        shadowDrillDepth += 1;
      }
      while (node) {
        // Overflowing content is not enough: an overflow:hidden box holds
        // content it will never scroll, and a canvas that zooms by scaling its
        // contents inside one would otherwise look like it had scrolled.
        const style = window.getComputedStyle(node);
        const scrollable = /^(auto|scroll|overlay)$/;
        const overflowsY = (node.scrollHeight ?? 0) > (node.clientHeight ?? 0) && scrollable.test(style.overflowY);
        const overflowsX = (node.scrollWidth ?? 0) > (node.clientWidth ?? 0) && scrollable.test(style.overflowX);
        if (overflowsY || overflowsX) {
          state.target = { tag: node.tagName.toLowerCase(), id: node.id, x: node.scrollLeft ?? 0, y: node.scrollTop ?? 0 };
          break;
        }
        const parent = (node.parentElement ?? null) as ShadowDrillElement | null;
        if (parent) {
          node = parent;
          continue;
        }
        // parentElement stops dead at a shadow boundary, the same way it did in
        // computed_style's layer walk (inspect.ts): the top node inside an open or closed
        // shadow root has parentElement null even though a real ancestor of it, the host,
        // sits right outside. getRootNode().host steps across the boundary so a scrollable
        // ancestor outside the shadow tree is still found rather than the walk stopping
        // short and silently reporting no scrollable target at all.
        node = node.getRootNode().host ?? null;
      }
      return state;
    },
    [x, y] as [number, number]
  );
}

/**
 * Offsets are compared, not identities: what scrolls at a point can change
 * shape mid-gesture, and a container that merely appeared or vanished while
 * sitting at offset zero has not scrolled anything.
 */
function sameScrollState(a: ScrollState, b: ScrollState): boolean {
  return (
    a.page.x === b.page.x &&
    a.page.y === b.page.y &&
    (a.target?.x ?? 0) === (b.target?.x ?? 0) &&
    (a.target?.y ?? 0) === (b.target?.y ?? 0)
  );
}

/**
 * The scroll state once it has stopped changing.
 *
 * Chromium applies a wheel on the compositor, so a read taken immediately
 * after dispatching one can still return the old offsets, and a smooth or
 * animated scroll keeps moving for longer than that. Reading once would make
 * "nothing moved" a coin flip; this returns as soon as two reads agree.
 */
async function readSettledScrollState(page: Page, x: number, y: number): Promise<ScrollState> {
  let previous = await readScrollState(page, x, y);
  const deadline = Date.now() + 300;
  while (Date.now() < deadline) {
    await sleep(25);
    const next = await readScrollState(page, x, y);
    if (sameScrollState(previous, next)) return next;
    previous = next;
  }
  return previous;
}

/** One main-frame document response, kept so a navigation's final document can be given its own status. */
interface DocumentResponse {
  /** The Playwright Response object, kept only to compare by identity against the one the navigation returned. */
  response: Response;
  url: string;
  status: number;
  ok: boolean;
}

/** What the tab is showing right now, read in one crossing so no two fields can come from different documents. */
interface PageSnapshot {
  identity: number | null;
  url: string;
  title: string;
  /**
   * The URL the CURRENT document's own navigation fetched, from its
   * PerformanceNavigationTiming entry. This is not page.url(): a page that
   * calls history.replaceState rewrites page.url() while this stays the
   * address that was actually requested, which is the only way to tell a
   * client-side route rewrite (nothing was fetched) apart from a client-side
   * redirect (a different document was fetched).
   */
  documentUrl: string | null;
  /** The HTTP status of the current document, from the document's own timing entry. Null when it had no HTTP response. */
  documentStatus: number | null;
  /** A meta refresh sitting in the document, which will move the tab after this call returns. */
  pendingRefresh: { seconds: number; url: string } | null;
}

/** Why a payload may already be out of date by the time it is read. */
interface PendingNavigation {
  reason: string;
  url?: string;
  afterMs?: number;
}

/** How long navigate and reload watch for a page that moves itself, unless the caller says otherwise. */
const NAVIGATION_SETTLE_MS = 500;

/** A navigation is treated as still in flight if the tab moved this recently when the window closed. */
const NAVIGATION_QUIET_MS = 60;

/** How long the tail wait for a mid-flight navigation may add on top of the settle window. */
const NAVIGATION_TAIL_MS = 400;

/** Default ceiling for one navigation call, matching Playwright's own default. */
const NAVIGATION_TIMEOUT_MS = 30_000;

/** A URL with any fragment removed, since a fragment never reaches the server and so never has a status of its own. */
function withoutHash(url: string): string {
  const hash = url.indexOf('#');
  return hash === -1 ? url : url.slice(0, hash);
}

/** Anything that would move the tab again, watched for the life of one navigation call. */
interface NavigationActivity {
  documents: DocumentResponse[];
  lastAt: number;
}

/**
 * url, title, document identity, the current document's own fetched address
 * and status, and any meta refresh still pending, all read in ONE crossing
 * into the page.
 *
 * Reading them separately is how navigate came to describe two documents at
 * once: page.url() answered from one document and page.title() from the next.
 * It is also two round trips instead of one, which doubled the settle cost on
 * a page whose main thread was busy.
 */
async function readPageSnapshot(page: Page): Promise<PageSnapshot> {
  const read = await page
    .evaluate(() => {
      const entry = performance.getEntriesByType('navigation')[0];
      const meta = document.querySelector('meta[http-equiv="refresh" i]');
      const content = meta ? meta.getAttribute('content') : null;
      let pendingRefresh: { seconds: number; url: string } | null = null;
      if (content) {
        const match = /^\s*([\d.]+)\s*(?:;\s*url\s*=\s*(.*?)\s*)?$/i.exec(content);
        if (match) {
          pendingRefresh = { seconds: Number(match[1]), url: (match[2] ?? '').replace(/^['"]|['"]$/g, '') };
        }
      }
      return {
        identity: performance.timeOrigin,
        title: document.title,
        documentUrl: typeof entry?.name === 'string' ? entry.name : null,
        // responseStatus is 0 for a document that never came over HTTP
        // (about:blank, a data: or blob: URL), which is a real answer and not
        // a missing one, so it is normalised to null rather than reported.
        documentStatus: typeof entry?.responseStatus === 'number' && entry.responseStatus > 0 ? entry.responseStatus : null,
        pendingRefresh
      };
    })
    .catch(() => null);
  return {
    identity: read?.identity ?? null,
    url: page.url(),
    title: read?.title ?? '',
    documentUrl: read?.documentUrl ?? null,
    documentStatus: read?.documentStatus ?? null,
    pendingRefresh: read?.pendingRefresh ?? null
  };
}

/**
 * Watches for the whole settle window, then reports what the tab finally
 * settled on.
 *
 * The previous version returned on the FIRST quiet 10ms poll, which made the
 * advertised 500ms a fiction: a redirect fired 20ms after load was already
 * past it, and an adversary sweeping delays found 20, 30, 50, 80, 150, 300
 * and 499ms all escaping. There is no signal a page can give that it will not
 * navigate again, so exiting early on the absence of one was never sound. The
 * window is watched in full instead, and it is a real number a caller can
 * reason about and raise.
 *
 * A short tail follows it, because measuring in the middle of a navigation is
 * its own kind of wrong answer: if the tab moved in the last moments of the
 * window, this waits for it to stop, up to a bounded extra. Whatever is still
 * moving when that runs out is reported as still moving rather than presented
 * as settled.
 */
async function settleAfterNavigation(
  page: Page,
  activity: NavigationActivity,
  settleMs: number
): Promise<{ snapshot: PageSnapshot; stillMoving: boolean }> {
  if (settleMs > 0) await sleep(settleMs);
  const tailDeadline = Date.now() + NAVIGATION_TAIL_MS;
  while (Date.now() - activity.lastAt < NAVIGATION_QUIET_MS && Date.now() < tailDeadline) {
    await sleep(20);
  }
  const stillMoving = Date.now() - activity.lastAt < NAVIGATION_QUIET_MS;
  return { snapshot: await readPageSnapshot(page), stillMoving };
}

/**
 * Watches a tab's main frame for anything that would move it again, for the
 * life of one call.
 *
 * Both halves are needed. The response listener catches a document being
 * fetched, which is what a client-side redirect and a meta refresh do, and it
 * is what lets the final document be given its own status. framenavigated
 * also catches the same-document kind, so a page that is rewriting its own
 * URL in a loop is not mistaken for a page at rest.
 */
function watchNavigationActivity(page: Page): { activity: NavigationActivity; stop: () => void } {
  const activity: NavigationActivity = { documents: [], lastAt: Date.now() };
  const onResponse = (response: Response): void => {
    try {
      const request = response.request();
      if (request.frame() !== page.mainFrame()) return;
      if (request.resourceType() !== 'document') return;
      activity.documents.push({ response, url: response.url(), status: response.status(), ok: response.ok() });
      activity.lastAt = Date.now();
    } catch {
      // A request whose frame has already gone throws when asked for it.
      // Nothing to record, and nothing worth failing the navigation over.
    }
  };
  const onNavigated = (frame: Frame): void => {
    if (frame === page.mainFrame()) activity.lastAt = Date.now();
  };
  page.on('response', onResponse);
  page.on('framenavigated', onNavigated);
  return {
    activity,
    stop: () => {
      page.off('response', onResponse);
      page.off('framenavigated', onNavigated);
    }
  };
}

/** A navigation measured end to end: what was fetched, what the tab finally settled on, and whether those are the same document. */
interface NavigationOutcome {
  /** The response for the request the navigation itself made. Null when nothing was fetched over HTTP. */
  response: Response | null;
  /** The tab once it stopped replacing its own document. */
  settled: PageSnapshot;
  /** Every main-frame document response seen during the call, in order. */
  documents: DocumentResponse[];
  /** The response that produced the document `settled` describes, if one was recorded. */
  finalDocument: DocumentResponse | undefined;
  /** Status of the document `settled` describes, NOT of whatever the first request answered. */
  status: number | null;
  ok: boolean | null;
  /** True when the page fetched a DIFFERENT document after the response was measured. */
  documentChanged: boolean;
  /** Set when the answer may already be out of date: still navigating, a meta refresh pending, or the call timed out. */
  pending: PendingNavigation | undefined;
  /** True when the navigation itself did not finish inside the caller's timeout. */
  timedOut: boolean;
}

/**
 * Runs one navigation and measures the document the caller will actually be
 * looking at when the answer comes back.
 *
 * Shared by navigate and reload because the defect was shared: both used to
 * report the status of the response THEY caused beside a url and title read
 * fresh afterwards, and those are different documents the moment the page
 * redirects itself.
 *
 * The hard question this answers is "is the document on screen the one this
 * navigation fetched?", and the honest source for it is the document's own
 * PerformanceNavigationTiming entry, not a URL comparison. A page calling
 * history.replaceState changes its URL without fetching anything, and matching
 * on URL used to read that as a client-side redirect and blank out a perfectly
 * good 200: an over-correction that hit the single most common shape there
 * is, since almost every client-side router rewrites its URL on first paint.
 */
async function performNavigation(
  page: Page,
  run: (timeout: number) => Promise<Response | null>,
  options: { settleMs?: number; timeoutMs?: number } = {}
): Promise<NavigationOutcome> {
  const settleMs = options.settleMs ?? NAVIGATION_SETTLE_MS;
  const timeoutMs = options.timeoutMs ?? NAVIGATION_TIMEOUT_MS;
  const watch = watchNavigationActivity(page);

  let response: Response | null = null;
  let timedOut = false;
  let settled: PageSnapshot;
  let stillMoving: boolean;
  try {
    try {
      response = await run(timeoutMs);
    } catch (error) {
      // A page that replaces itself with itself never lets goto resolve, so
      // the call used to die on a raw Playwright timeout with nothing said
      // about why. A timeout here is reported rather than thrown, because
      // what the tab IS showing and the chain of documents behind it are the
      // whole diagnosis. Anything that is not a timeout is a real failure and
      // still propagates.
      if (!isTimeoutError(error)) throw error;
      timedOut = true;
    }
    ({ snapshot: settled, stillMoving } = await settleAfterNavigation(page, watch.activity, timedOut ? 0 : settleMs));
  } finally {
    watch.stop();
  }

  const documents = watch.activity.documents;
  // Is the document on screen the one this navigation fetched? Asked of the
  // document itself. The URL fallback is for the rare case where the timing
  // entry is unreadable.
  const ownUrl = response === null ? null : withoutHash(response.url());
  const documentIsOwn =
    response !== null &&
    (settled.documentUrl !== null ? withoutHash(settled.documentUrl) === ownUrl : withoutHash(settled.url) === ownUrl);

  const finalKey = withoutHash(settled.documentUrl ?? settled.url);
  const finalDocument = documentIsOwn
    ? documents.find(entry => entry.response === response)
    : documents.filter(entry => withoutHash(entry.url) === finalKey).at(-1);

  // Playwright's own Response is preferred wherever it describes the document
  // being reported, since it is authoritative about the status and about ok().
  // The document's timing entry only fills in for a document goto never
  // returned, which is exactly the redirected-to case.
  const status =
    response === null ? null : documentIsOwn ? response.status() : (finalDocument?.status ?? settled.documentStatus ?? null);
  const ok =
    response === null
      ? null
      : documentIsOwn
        ? response.ok()
        : status === null
          ? null
          : status >= 200 && status < 300;

  const documentChanged = response !== null && !documentIsOwn;

  let pending: PendingNavigation | undefined;
  if (timedOut) {
    pending = {
      reason:
        `the navigation did not finish within ${timeoutMs}ms and the tab was still moving when this call gave up. ` +
        `${documents.length} main-frame document(s) were fetched, which is what a redirect loop looks like`,
      afterMs: timeoutMs
    };
  } else if (stillMoving) {
    pending = {
      reason: `the tab was still navigating when the ${settleMs}ms settle window closed, so this describes a document that may already have been replaced`,
      afterMs: settleMs
    };
  } else if (settled.pendingRefresh !== null) {
    pending = {
      reason: `this document carries a meta refresh that fires in ${settled.pendingRefresh.seconds}s, which is after this call returns, so the tab will move on its own`,
      ...(settled.pendingRefresh.url ? { url: new URL(settled.pendingRefresh.url, settled.url).href } : {}),
      afterMs: Math.round(settled.pendingRefresh.seconds * 1000)
    };
  }

  return { response, settled, documents, finalDocument, status, ok, documentChanged, pending, timedOut };
}

/** True for a Playwright timeout, which is reported rather than thrown, unlike a real navigation failure. */
function isTimeoutError(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name;
  const message = String((error as { message?: string } | null)?.message ?? '');
  return name === 'TimeoutError' || /Timeout .*exceeded/i.test(message);
}

/**
 * The note a caller needs when the page moved itself, worded for whichever
 * tool is reporting it. Kept in one place so navigate and reload cannot drift
 * into explaining the same situation differently.
 */
function documentChangedNote(outcome: NavigationOutcome, what: string): string {
  const response = outcome.response;
  if (response === null) return '';
  return (
    `The page moved itself after the response was measured: the ${what} of ${response.url()} answered ${response.status()}, and the document now on screen was fetched from ${outcome.settled.documentUrl ?? outcome.settled.url}. That is a client-side redirect (location.assign or replace, a meta refresh, or a router bouncing an unauthenticated visitor), and "documentChanged" lists every main-frame document this call saw, in order. ` +
    (outcome.status !== null
      ? `"status" and "ok" describe the document "url" and "title" describe, this last one, NOT the ${response.status()} that started the chain.`
      : 'The final document has no HTTP response of its own to report (about:blank, a data: URL or a blob:), so "status" and "ok" are null rather than carrying the earlier document\'s status.')
  );
}

/** The documentChanged block both navigate and reload attach, or nothing when the document held still. */
function documentChangedPayload(outcome: NavigationOutcome): Record<string, unknown> {
  if (!outcome.documentChanged || outcome.response === null) return {};
  return {
    documentChanged: {
      from: { url: outcome.response.url(), status: outcome.response.status(), ok: outcome.response.ok() },
      to: { url: outcome.settled.documentUrl ?? outcome.settled.url, status: outcome.status, ok: outcome.ok },
      documents: outcome.documents.map(entry => ({ url: entry.url, status: entry.status, ok: entry.ok }))
    }
  };
}

/** The pendingNavigation block and its note, shared by navigate, reload and the history steps. */
function pendingNavigationPayload(pending: PendingNavigation | undefined): Record<string, unknown> {
  return pending === undefined ? {} : { pendingNavigation: pending };
}

/** Tools that drive a tab: moving it somewhere and acting on the page. */
export const interactionTools = defineTools({
  navigate: defineTool({
    // Serialized per session, the same way click is, and for the same reason
    // the history steps are. Two navigations issued without awaiting each
    // other tear each other's request down: probed directly, concurrent
    // navigate calls rejected with "net::ERR_ABORTED" and concurrent reloads
    // rejected with "net::ERR_ABORTED; maybe frame was detached?", both of
    // them failures reported for work the browser had partly done. Queuing
    // them makes the second act on the tab the first one left behind, which
    // is what a caller issuing two in a row means, and it also keeps a click
    // from landing in the middle of a navigation.
    serializesInput: true,
    description:
      'Navigate a session\'s tab to a URL. A URL differing from the current one only in its hash is a SAME-DOCUMENT navigation: the browser changes the address but does not reload, so the JS context, in-page state (React state, timers, subscriptions) and the console buffer all survive. This tool does not quietly force a reload in that case, because navigating to a hash is a legitimate thing to test. It reports it instead: every result carries a "sameDocument" boolean, present in both the true and the false case, plus a note when it is true. Use reload when you need a real page load. ' +
      'This is the most-called tool in the whole surface, and it reports the real HTTP outcome rather than treating a rendered page as success: every result carries "status" (the HTTP status code) and "ok" (whether it was in the 200 to 299 range), exactly as reload does, so navigating to a URL that answers 404 or 500 does not read as an ordinary success just because something rendered, which matters most for an SPA shell that paints its own error state under a failing response. "status" and "ok" are both null when there genuinely is no HTTP response to report a status FOR, which is not a failure: a same-document navigation, about:blank, or a non-HTTP scheme such as data: or javascript:. A note explains which of those it was, so a null status is never mistaken for a navigation that silently failed. ' +
      'ONE PAYLOAD ALWAYS DESCRIBES ONE DOCUMENT. "status" and "ok" belong to the document "url" and "title" describe, not to whatever the first request happened to answer, and the call watches for a real, stated window ("settleMs", 500ms by default, watched in FULL rather than exited early) before reading any of them, so a client-side redirect fired inside that window is caught rather than missed. That matters because a client-side redirect is an ordinary shape: a 200 shell that runs location.replace on a failing route, a meta refresh chain, or a router bouncing an unauthenticated visitor to a login page. When one happens the result also carries "documentChanged", holding the response the navigation itself measured ("from"), the document finally described ("to"), and every main-frame document this call saw, in order, plus a note saying so. So ok: true beside a login page title, or beside a 500 error page, is a shape you will not see here. If the final document has no HTTP response of its own, because it ended on about:blank or a data: URL, "status" and "ok" are null rather than carrying the earlier document\'s status. A redirect fired LATER than the window is not caught, and rather than being silent about that the result says so: "pendingNavigation" appears whenever the tab was still moving when the window closed, or the document being described carries a meta refresh that has not fired yet, so a caller can raise settleMs or simply look again. Calls are serialized per session, so two navigations issued without awaiting each other queue instead of aborting each other. A page that never stops navigating, one that replaces itself with itself, does not hang the call and does not throw a raw timeout either: it comes back with "timedOut": true, a "pendingNavigation" naming the redirect loop, and a description of whatever the tab was showing when "timeoutMs" ran out.',
    inputSchema: z.object({
      sessionId,
      pageId,
      url: z.string().describe('URL to navigate the tab to.'),
      waitUntil,
      settleMs: z
        .number()
        .int()
        .min(0)
        .max(30_000)
        .optional()
        .describe(
          'How long to keep watching for the page to move itself before measuring it, in milliseconds. Defaults to 500. This is a real window, watched in full: a client-side redirect fired inside it is caught and reported, and one fired after it is not. Raise it for an app whose auth bounce waits on a token check or a first fetch, which is easily past 500ms. Set it to 0 to skip the wait entirely when you know the page is static and want the call as fast as possible, accepting that a redirect will then be missed.'
        ),
      timeoutMs: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(
          'How long the navigation itself may take before this call gives up on it, in milliseconds. Defaults to 30000. Giving up is REPORTED, not thrown: the result describes whatever the tab is showing, with "timedOut": true and a "pendingNavigation" saying the page was still moving, which is what a redirect loop looks like from the outside.'
        )
    }),
    async handler(ctx, args) {
      const target = ctx.sessions.resolve(args.sessionId, args.pageId);
      const before = await documentIdentity(target.page);
      const outcome = await performNavigation(
        target.page,
        timeout => target.page.goto(args.url, { timeout, ...(args.waitUntil ? { waitUntil: args.waitUntil } : {}) }),
        { settleMs: args.settleMs, timeoutMs: args.timeoutMs }
      );
      const { response, settled } = outcome;

      // A response means a document really was fetched and swapped in. A null
      // response is ambiguous on its own, so the identity check settles it.
      // When the identity is unreadable we say "same document", erring toward
      // warning the caller: a spurious warning costs one redundant reload, a
      // missed one costs a false pass.
      const sameDocument = response === null && (before === null || settled.identity === null || before === settled.identity);

      const notes: string[] = [];
      if (sameDocument) {
        notes.push(
          'Same-document navigation: the URL changed but the document was NOT reloaded. The JS context, in-page state and the console buffer all survive untouched, and nothing was re-fetched, so there is no HTTP response to report a status for either: "status" and "ok" are null for that reason, not because anything failed. Call reload if you need a real page load.'
        );
      } else if (response === null) {
        // about:blank lands here: sameDocument is false for it (a fresh
        // document really was created), but goto() still resolves to a null
        // response, since nothing was fetched over HTTP. Same for a
        // non-HTTP scheme such as data: or javascript:. Without this, both
        // came back with "status": null and no explanation, indistinguishable
        // from a request that failed before a response ever arrived.
        notes.push(
          'This navigation produced no HTTP response, so "status" and "ok" are null: that is what about:blank and a non-HTTP scheme (for instance data: or javascript:) look like, not a failure. The document did change, a fresh one was created, just not through anything this tool can report an HTTP status for.'
        );
      }
      if (outcome.documentChanged) notes.push(documentChangedNote(outcome, 'navigation'));
      if (outcome.pending) notes.push(`This answer may already be out of date: ${outcome.pending.reason}. Read "pendingNavigation", and call navigate or reload again, or raise "settleMs", if you need the document it settles on.`);

      return text({
        pageId: target.pageId,
        url: settled.url,
        title: settled.title,
        sameDocument,
        status: outcome.status,
        ok: outcome.ok,
        ...(outcome.timedOut ? { timedOut: true } : {}),
        ...documentChangedPayload(outcome),
        ...pendingNavigationPayload(outcome.pending),
        ...(notes.length ? { note: notes.join(' ') } : {})
      });
    }
  }),

  reload: defineTool({
    // Serialized per session, the same way click is, and for the same reason
    // the history steps are. Two navigations issued without awaiting each
    // other tear each other's request down: probed directly, concurrent
    // navigate calls rejected with "net::ERR_ABORTED" and concurrent reloads
    // rejected with "net::ERR_ABORTED; maybe frame was detached?", both of
    // them failures reported for work the browser had partly done. Queuing
    // them makes the second act on the tab the first one left behind, which
    // is what a caller issuing two in a row means, and it also keeps a click
    // from landing in the middle of a navigation.
    serializesInput: true,
    description:
      'Reload a session\'s tab: a real page load that discards the JS context, in-page state and everything the page had built up, and re-fetches the document. This is what navigate deliberately does not do when only the URL hash changes. The current URL, hash included, is kept. The result carries "status" (the HTTP status code) and "ok" (whether it was in the 200 to 299 range), exactly as navigate does, both null on the rare reload with no HTTP response to report, such as one landing on about:blank. ONE PAYLOAD ALWAYS DESCRIBES ONE DOCUMENT, on the same terms navigate reports it and through the same machinery: "status" and "ok" belong to the document "url" and "title" describe, not to whatever the reload request itself answered, and the call watches for the same real, stated window ("settleMs", 500ms by default) before reading any of them, with the same "pendingNavigation" and "timedOut" reporting when a page moves later than that or never stops moving, and serialized per session the same way. Reloading a 200 shell that redirects walks the same chain a first visit does, so a reload is no safer than a navigate here: it is usually MORE exposed, because the pages an agent reloads repeatedly are the ones it is waiting on. When the page moves itself the result carries "documentChanged", holding the response the reload measured ("from"), the document finally described ("to"), and every main-frame document this call saw, in order, plus a note. A final document with no HTTP response of its own reports null rather than inheriting the earlier status.',
    inputSchema: z.object({
      sessionId,
      pageId,
      waitUntil,
      settleMs: z
        .number()
        .int()
        .min(0)
        .max(30_000)
        .optional()
        .describe(
          'How long to keep watching for the page to move itself before measuring it, in milliseconds. Defaults to 500. This is a real window, watched in full: a client-side redirect fired inside it is caught and reported, and one fired after it is not. Raise it for an app whose auth bounce waits on a token check or a first fetch, which is easily past 500ms. Set it to 0 to skip the wait entirely when you know the page is static and want the call as fast as possible, accepting that a redirect will then be missed.'
        ),
      timeoutMs: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(
          'How long the navigation itself may take before this call gives up on it, in milliseconds. Defaults to 30000. Giving up is REPORTED, not thrown: the result describes whatever the tab is showing, with "timedOut": true and a "pendingNavigation" saying the page was still moving, which is what a redirect loop looks like from the outside.'
        )
    }),
    async handler(ctx, args) {
      const target = ctx.sessions.resolve(args.sessionId, args.pageId);
      // Measured exactly the way navigate measures itself, through the same
      // helper rather than a second implementation of it. Reloading a shell
      // that redirects walks the same chain a first visit does, so a reload
      // reporting the shell's own status beside the redirect target's title
      // was the identical defect: "status": 200, "ok": true next to a 500
      // error page. Nothing about a reload makes that shape rarer, since the
      // pages that do it are exactly the ones an agent reloads while waiting
      // for a fix.
      const outcome = await performNavigation(
        target.page,
        timeout => target.page.reload({ timeout, ...(args.waitUntil ? { waitUntil: args.waitUntil } : {}) }),
        { settleMs: args.settleMs, timeoutMs: args.timeoutMs }
      );

      const notes: string[] = [];
      if (outcome.response === null) {
        notes.push(
          'This reload produced no HTTP response, so "status" and "ok" are null: that is what reloading about:blank or a non-HTTP scheme (for instance data:) looks like, not a failure.'
        );
      }
      if (outcome.documentChanged) notes.push(documentChangedNote(outcome, 'reload'));
      if (outcome.pending) notes.push(`This answer may already be out of date: ${outcome.pending.reason}. Read "pendingNavigation", and reload again, or raise "settleMs", if you need the document it settles on.`);

      return text({
        pageId: target.pageId,
        url: outcome.settled.url,
        title: outcome.settled.title,
        status: outcome.status,
        ok: outcome.ok,
        ...(outcome.timedOut ? { timedOut: true } : {}),
        ...documentChangedPayload(outcome),
        ...pendingNavigationPayload(outcome.pending),
        ...(notes.length ? { note: notes.join(' ') } : {})
      });
    }
  }),

  click: defineTool({
    serializesInput: true,
    description:
      'Click an element in a session\'s tab with a real mouse press, at the element\'s centre by default. Pass x and y together to click a specific offset from the element\'s top-left corner, which is how you prove a dead band or an off-by-a-few-pixels hit area inside a control. Note that a right or middle click fires mousedown/mouseup/auxclick/contextmenu, not a click event. ' +
      'This does NOT require the selector to be unique: when it matches several elements the FIRST one is clicked, and no error is raised. The result carries "matchedElements" for that reason, with a note whenever it is more than one, because Playwright selectors pierce open shadow roots and a positional path can match far more of the page than it appears to. Read it before concluding the right thing was pressed. ' +
      'It also does not verify that the click had any effect: Playwright waits for the element to be visible, stable, enabled and actually hit-testable at the point it aims at, and fails loudly when it is not, but a click that lands on a live element and does nothing is reported as a success. Assert the page state yourself afterwards.',
    inputSchema: z.object({
      sessionId,
      pageId,
      selector: z.string().describe('Playwright selector (CSS, text=, role=, etc.) of the element to click.'),
      ...selectorPosition,
      button: z.enum(['left', 'right', 'middle']).optional().describe('Mouse button to press. Defaults to "left".'),
      clickCount: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('Number of clicks in one burst, e.g. 2 for a double click. Defaults to 1.')
    }),
    async handler(ctx, args) {
      if ((args.x === undefined) !== (args.y === undefined)) {
        throw new Error(
          'click needs both "x" and "y" to click a point inside the element, or neither to click its centre. Only one was given.'
        );
      }
      const target = ctx.sessions.resolve(args.sessionId, args.pageId);
      const position = args.x !== undefined && args.y !== undefined ? { x: args.x, y: args.y } : undefined;
      // Counted before the click, because the click can change the page. A
      // selector matching several elements is the quiet half of the worst
      // failure this tool can produce: page.click is not strict, so it acts on
      // the first match and reports the same ok:true either way, and find can
      // hand over a selector that matches something other than the element it
      // just described.
      const matchedElements = await target.page.locator(args.selector).count().catch(() => undefined);
      await target.page.click(args.selector, {
        ...(position ? { position } : {}),
        ...(args.button ? { button: args.button } : {}),
        ...(args.clickCount !== undefined ? { clickCount: args.clickCount } : {})
      });
      return text({
        ok: true,
        pageId: target.pageId,
        selector: args.selector,
        button: args.button ?? 'left',
        clickCount: args.clickCount ?? 1,
        ...(position ? { position } : {}),
        ...(matchedElements !== undefined ? { matchedElements } : {}),
        ...(matchedElements !== undefined && matchedElements > 1
          ? {
              note:
                `This selector matched ${matchedElements} elements and the FIRST one was clicked. Playwright's ` +
                'selectors pierce open shadow roots, so a positional path can match more of the page than it looks ' +
                'like it does. Narrow the selector, or confirm with find which element you meant, before trusting ' +
                'that the right thing was pressed.'
            }
          : {})
      });
    }
  }),

  fill: defineTool({
    serializesInput: true,
    description:
      'Set a field\'s contents in a session\'s tab, REPLACING whatever was there. Use type instead to append, or to fire per-character events. For an input, textarea or select this is Playwright\'s atomic fill. For a contenteditable, including rich editors like CodeMirror and Monaco, it focuses the element and replaces through real keyboard events (select-all, delete, insert), because those editors keep their own document model and treat a plain insertion as an insert at their cursor, appending onto the existing value instead of replacing it. Reads the field back afterwards, but that readback is DOM textContent, and for a real Monaco or CodeMirror instance textContent is not the whole story: both virtualize their lines, so it only covers what is currently rendered and reads back truncated for anything long, and an element with an EditContext attached keeps its real text there rather than in the DOM at all. When the target looks like one of these the result says so plainly: "readbackReliable" is false, "matched" is not claimed either way, and "note" names the editor\'s own API to read the value through instead (e.g. monaco.editor.getModels()[0].getValue()). For an ordinary field the result carries "value" (what the field really contains now), "matched", "readbackReliable": true, and a "note" explaining the difference when value and the request disagree.',
    inputSchema: z.object({
      sessionId,
      pageId,
      selector: z
        .string()
        .describe('Playwright selector of the field to fill: an input, textarea, select, or any contenteditable element.'),
      value: z.string().describe('Text the field should contain afterwards. An empty string clears it.')
    }),
    async handler(ctx, args) {
      const target = ctx.sessions.resolve(args.sessionId, args.pageId);
      const locator = target.page.locator(args.selector);
      await setFieldValue(target.page, locator, args.value);
      const actual = await readFieldValue(target.page, locator);
      const readbackWarning = await readReadbackReliability(target.page, locator);
      return writeResult(
        { pageId: target.pageId, selector: args.selector, requested: args.value },
        actual,
        actual === args.value,
        `Expected exactly ${JSON.stringify(args.value)}.`,
        readbackWarning
      );
    }
  }),

  type: defineTool({
    serializesInput: true,
    description:
      'Type text into a session\'s tab character by character, with real key events, so per-character handlers, debounces, autocomplete and anything firing on a keystroke actually run. fill sets the value in one step and cannot exercise those. Does NOT clear the field first: it inserts at the caret, which is what a user typing does, so calling it twice types twice. Pass clear: true to replace the contents instead. Where the caret sits is the browser\'s call, not this tool\'s: focusing an input puts it after the existing text, focusing a contenteditable puts it before, so click the spot first if the insertion point matters. With no selector the keystrokes go to whatever currently has focus, and if NOTHING has focus this refuses outright rather than guessing: with no field to type into or read back, the only thing "no selector" could act on is the document itself, which on a contenteditable page means select-all-and-delete on clear would empty the page, and even without clear, reading the caret holder back would return document.activeElement, which is <body>, so the result would carry the entire page\'s text as "value" instead of any one field\'s. Reads the field back afterwards, but that readback is DOM textContent, and for a real Monaco or CodeMirror instance textContent is not the whole story: both virtualize their lines, so it only covers what is currently rendered and reads back truncated for anything long, and an element with an EditContext attached keeps its real text there rather than in the DOM at all. When the target looks like one of these the result says so plainly: "readbackReliable" is false, "matched" is not claimed either way, and "note" names the editor\'s own API to read the value through instead. For an ordinary field the result carries "value" (what the field really contains now), "previousValue" (what it held BEFORE the call, clear included, so a clear cannot throw something away invisibly), "matched", "readbackReliable": true, and a "note" when what landed is not the typed text inserted into what was already there.',
    inputSchema: z.object({
      sessionId,
      pageId,
      selector: z
        .string()
        .optional()
        .describe('Playwright selector of the field to type into. Omit to type into whatever currently has focus.'),
      text: z.string().describe('Text to type, one character at a time.'),
      delay: z
        .number()
        .min(0)
        .optional()
        .describe('Milliseconds to pause between characters. Defaults to 0. Raise it to exercise debounces and in-flight state.'),
      clear: z
        .boolean()
        .optional()
        .describe('If true, clears the field before typing (default false: type appends at the caret, like a real user).')
    }),
    async handler(ctx, args) {
      const target = ctx.sessions.resolve(args.sessionId, args.pageId);
      const locator = args.selector === undefined ? null : target.page.locator(args.selector);

      // Runs before ANYTHING else, including the very first readback below.
      // With no selector, "nothing has focus" is not just a clear-time danger
      // (select-all against the whole document): reading the field back is
      // document.activeElement too, and an unfocused page's activeElement is
      // <body>, so its textContent is the entire page rather than any field's.
      // That produced a result with a multi-thousand-character page dump
      // masquerading as a field's value, twice over (previousValue and value
      // both), for a call that never told the caller anything about a field
      // at all. Refusing outright is the same call fill's own focus guard
      // makes, just made before the read that clear alone used to gate.
      if (locator === null) {
        const holder = await target.page.evaluate(() => {
          const el = document.activeElement;
          if (!el) return null;
          return { tag: el.tagName, id: el.id };
        });
        if (holder === null || holder.tag === 'BODY' || holder.tag === 'HTML') {
          throw new Error(
            'type has no selector and nothing has focus, so there is no field to act on: the caret is in the ' +
              'document itself. Reading it back would return document.activeElement, which on an unfocused page is ' +
              '<body>, so "value" would be the whole page\'s text rather than any one field\'s' +
              (args.clear
                ? ', and clearing would press select-all against the whole document too, with the delete after it ' +
                  'emptying a contenteditable page'
                : '') +
              '. Pass "selector" to name the field, or click into it first. Nothing was typed' +
              (args.clear ? ' and nothing was cleared.' : '.')
          );
        }
      }

      // Read BEFORE the clear, so "previousValue" means what its name says.
      // Read after, it was always the emptied field on a clearing call, which
      // also made "matched" a comparison against nothing: it could not fail,
      // whatever the clear had just destroyed.
      const before = await readFieldValue(target.page, locator);

      if (args.clear) {
        if (locator) {
          await setFieldValue(target.page, locator, '');
        } else {
          // Focus was already confirmed real above, so this is exactly the
          // select-all-and-delete fill's own contenteditable path performs,
          // just against whatever currently holds the caret rather than a
          // locator, because there is no selector to build one from.
          await target.page.keyboard.press(selectAllChord);
          await target.page.keyboard.press('Delete');
        }
      }

      // What the field holds going into the typing: the same as `before` on an
      // ordinary call, and the emptied field on a clearing one. The insertion
      // check runs against this, while the caller is shown `before`.
      const baseline = args.clear ? await readFieldValue(target.page, locator) : before;
      const options = args.delay !== undefined ? { delay: args.delay } : undefined;
      if (locator) {
        await locator.pressSequentially(args.text, options);
      } else {
        await target.page.keyboard.type(args.text, options);
      }
      const actual = await readFieldValue(target.page, locator);
      const readbackWarning = await readReadbackReliability(target.page, locator);

      // Typing inserts rather than replaces, so what to expect afterwards is
      // the previous contents with the typed text somewhere inside them, not
      // the typed text alone.
      return writeResult(
        {
          pageId: target.pageId,
          ...(args.selector !== undefined ? { selector: args.selector } : {}),
          typed: args.text,
          cleared: args.clear ?? false,
          previousValue: before
        },
        actual,
        isInsertionOf(baseline, args.text, actual),
        `Expected ${JSON.stringify(args.text)} inserted into ${JSON.stringify(baseline)}.`,
        readbackWarning
      );
    }
  }),

  press_key: defineTool({
    serializesInput: true,
    description:
      'Press a key in a session\'s tab, dispatching a real trusted key event. This is the only way to establish keyboard modality, which matters for accessibility checks: Chrome will not set :focus-visible on a button a script focused with .focus(), so a focus ring measured after a programmatic focus reports absent even when it is perfectly fine for a real user pressing Tab. Key syntax is Playwright\'s: Tab, Enter, Escape, ArrowDown, Backspace, a, Control+A, Shift+Tab. With no selector the key goes to whatever currently has focus. Returns where focus ended up and whether that element matches :focus-visible.',
    inputSchema: z.object({
      sessionId,
      pageId,
      key: z
        .string()
        .describe(
          'Key or chord in Playwright syntax: Enter, Escape, ArrowDown, Backspace, a, Shift+Tab, and so on. Some ' +
            'names are stricter than they look: Return and Esc both throw ("Unknown key"), it is Enter and Escape. ' +
            'Cmd throws too, it is Meta. A modifier chord that merely presses fine is not the same as one that does ' +
            'anything: Control+a on a platform whose select-all is bound to Meta reports an ordinary success and ' +
            'selects nothing, because the browser has no accelerator on that chord at all. Use ControlOrMeta+ for a ' +
            'platform editing accelerator (select-all and the rest): Playwright resolves it to Meta on macOS and ' +
            'Control everywhere else, so it does the right thing on every platform this runs on.'
        ),
      selector: z
        .string()
        .optional()
        .describe('Playwright selector to press the key against. Omit to send it to whatever currently has focus.'),
      repeat: z.number().int().min(1).optional().describe('How many times to press the key. Defaults to 1.'),
      delay: z.number().min(0).optional().describe('Milliseconds to pause between repeats. Defaults to 0.')
    }),
    async handler(ctx, args) {
      const target = ctx.sessions.resolve(args.sessionId, args.pageId);
      const repeat = args.repeat ?? 1;
      const locator = args.selector === undefined ? null : target.page.locator(args.selector);

      for (let i = 0; i < repeat; i += 1) {
        if (i > 0 && args.delay) {
          await new Promise(resolve => setTimeout(resolve, args.delay));
        }
        if (locator) {
          await locator.press(args.key);
        } else {
          await target.page.keyboard.press(args.key);
        }
      }

      const activeElement = await target.page.evaluate(() => {
        const el = document.activeElement;
        if (!el) return null;
        return {
          tag: el.tagName.toLowerCase(),
          id: el.id,
          text: (el.textContent ?? '').trim().slice(0, 80),
          focusVisible: el.matches(':focus-visible')
        };
      });

      const note = nonAcceleratorChordNote(args.key);
      return text({
        pageId: target.pageId,
        key: args.key,
        repeat,
        platform: process.platform,
        activeElement,
        focusVisible: activeElement?.focusVisible ?? false,
        ...(note ? { note } : {})
      });
    }
  }),

  hover: defineTool({
    serializesInput: true,
    description:
      'Hover the mouse over an element in a session\'s tab, moving the real pointer to it. Synthetic pointerover/mouseover events dispatched from a script only exercise the page\'s own listeners: they cannot satisfy a CSS-only :hover rule, and they cannot open a tooltip that depends on real pointer geometry. This can. Pass x and y together to hover a specific offset from the element\'s top-left corner. ' +
      'This does NOT require the selector to be unique: like click, when it matches several elements the FIRST one is hovered, and no error is raised. The result carries "matchedElements" for that reason, with a note whenever it is more than one, because Playwright selectors pierce open shadow roots and a positional path can match far more of the page than it appears to. Read it before concluding the right thing was hovered. ' +
      'Returns whether the element matches :hover afterwards as "hovering", read back against the exact element that was hovered rather than the bare selector, because reading a multi-match selector through evaluate is strict mode where hovering it is not: without that, hovering a selector matching several elements used to come back as "hovering": false, the opposite of what really happened, since the readback threw on the ambiguity and the failure was swallowed into a false negative. On the rare occasion the readback genuinely cannot run at all, for instance because the hover triggered something that removed the element from the DOM, "hovering" is null rather than false, with a note explaining why, so a readback that could not run is never mistaken for a confirmed "not hovering".',
    inputSchema: z.object({
      sessionId,
      pageId,
      selector: z.string().describe('Playwright selector of the element to hover.'),
      ...selectorPosition
    }),
    async handler(ctx, args) {
      if ((args.x === undefined) !== (args.y === undefined)) {
        throw new Error(
          'hover needs both "x" and "y" to hover a point inside the element, or neither to hover its centre. Only one was given.'
        );
      }
      const target = ctx.sessions.resolve(args.sessionId, args.pageId);
      const position = args.x !== undefined && args.y !== undefined ? { x: args.x, y: args.y } : undefined;
      // Counted before the hover, the same reason click counts before its own
      // act: page.hover is not strict either, so with a selector matching
      // several elements it silently hovers the FIRST one and reports the
      // same result either way.
      const matchedElements = await target.page.locator(args.selector).count().catch(() => undefined);
      await target.page.hover(args.selector, position ? { position } : undefined);
      // Read back against .first(), not the bare locator. locator.evaluate IS
      // strict mode, so on a selector matching several elements it used to
      // throw where page.hover just silently acted on the first one, and the
      // .catch below turned that throw into "hovering": false: a hover that
      // genuinely landed reported as though it had done nothing at all.
      // .first() targets the exact element page.hover already acted on, so
      // the readback can no longer disagree with the act on that account.
      // A .catch still guards a readback failing for a real reason, such as
      // the hover itself removing the element from the DOM, and that is
      // reported as "hovering": null, not false, so it is never misread as a
      // confirmed "not hovering".
      const hovering = await target.page
        .locator(args.selector)
        .first()
        .evaluate((el: PageElement) => el.matches(':hover'))
        .catch(() => null);

      const notes: string[] = [];
      if (matchedElements !== undefined && matchedElements > 1) {
        notes.push(
          `This selector matched ${matchedElements} elements and the FIRST one was hovered. Playwright's ` +
            'selectors pierce open shadow roots, so a positional path can match more of the page than it looks ' +
            'like it does. Narrow the selector, or confirm with find which element you meant, before trusting ' +
            'that the right thing was hovered.'
        );
      }
      if (hovering === null) {
        notes.push(
          'The hover itself completed, but the readback that checks :hover afterwards could not run, most likely ' +
            'because the hover triggered something that removed the element from the DOM. "hovering" is null for ' +
            'that reason, not false: a real "not hovering" only comes from a readback that actually ran.'
        );
      }

      return text({
        pageId: target.pageId,
        selector: args.selector,
        hovering,
        ...(position ? { position } : {}),
        ...(matchedElements !== undefined ? { matchedElements } : {}),
        ...(notes.length ? { note: notes.join(' ') } : {})
      });
    }
  }),

  resize: defineTool({
    description:
      'Resize a session\'s tab viewport. This sets the real Playwright viewport, so screenshots taken afterwards are captured at the new size. Resizing through raw CDP (Emulation.setDeviceMetricsOverride) instead changes window.innerWidth but leaves screenshots at the original viewport, which silently makes every responsive screenshot misleading. This tool cannot change deviceScaleFactor: Playwright fixes that per browser context when the context is created, so pass it to create_session instead. Always reads the viewport back out of the page afterwards: the result carries innerWidth/innerHeight, "matched", and a "note" when the page disagrees with the size that was set, which is what a CSS zoom on the root element or a leftover device-metrics override looks like.',
    inputSchema: z.object({
      sessionId,
      pageId,
      width: z.number().int().min(1).describe('Viewport width in CSS pixels.'),
      height: z.number().int().min(1).describe('Viewport height in CSS pixels.')
    }),
    async handler(ctx, args) {
      const target = ctx.sessions.resolve(args.sessionId, args.pageId);
      await target.page.setViewportSize({ width: args.width, height: args.height });
      const measured = await target.page.evaluate(() => ({
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio
      }));
      // Read back AND compared, the same way fill, type, select_option,
      // file_upload and set_storage do. Reporting the measurement without
      // saying whether it agrees leaves a mismatch for the caller to notice
      // with no reason to look for one: a CSS zoom or scale on the root
      // element, or a device-metrics override left in force, moves
      // innerWidth without moving the viewport a screenshot is captured at.
      const matched = measured.innerWidth === args.width && measured.innerHeight === args.height;
      return text({
        pageId: target.pageId,
        width: args.width,
        height: args.height,
        ...measured,
        matched,
        ...(matched
          ? {}
          : {
              note:
                `The viewport was set to ${args.width}x${args.height}, but the page reports ` +
                `${measured.innerWidth}x${measured.innerHeight}. The usual causes are a CSS zoom or scale on the ` +
                'root element, a scrollbar the page reserves, or an Emulation.setDeviceMetricsOverride still in ' +
                'force. Trust "width"/"height" for the size a screenshot will be captured at, and ' +
                'innerWidth/innerHeight for what the page\'s own media queries and layout code see.'
            })
      });
    }
  }),

  wait_for: defineTool({
    description:
      'Wait for a condition in a session\'s tab, instead of sleeping for a guessed number of milliseconds. Give EITHER selector (with an optional state: visible, hidden, attached, detached) OR expression, a JavaScript expression polled until it is truthy. Exactly one of the two: passing both, or neither, is an error. Returns how long it actually waited, which is worth reading: a wait that returns in 0ms was already satisfied before you asked. It also returns "everMatched", which is what makes state "hidden" and "detached" safe to trust: BOTH of those are satisfied by an element that is not in the DOM at all, so a mistyped selector otherwise returns success in milliseconds having proved nothing. everMatched false means the wait was satisfied by absence, and the result says so in a note. On timeout it throws an error naming what it was waiting for and for how long, not a bare Playwright timeout.',
    inputSchema: z.object({
      sessionId,
      pageId,
      selector: z.string().optional().describe('Playwright selector to wait for. Mutually exclusive with "expression".'),
      state: z
        .enum(['visible', 'hidden', 'attached', 'detached'])
        .optional()
        .describe('State the selector must reach. Defaults to "visible". Only valid together with "selector".'),
      expression: z
        .string()
        .optional()
        .describe(
          'JavaScript expression evaluated in the page and polled until it is truthy, e.g. "document.querySelectorAll(\'.row\').length > 3". Mutually exclusive with "selector".'
        ),
      timeoutMs: z.number().int().min(1).optional().describe('How long to wait before giving up. Defaults to 10000.')
    }),
    async handler(ctx, args) {
      const hasSelector = args.selector !== undefined;
      const hasExpression = args.expression !== undefined;
      if (hasSelector === hasExpression) {
        throw new Error(
          `wait_for needs exactly one of "selector" or "expression": ${hasSelector ? 'both were given' : 'neither was given'}.`
        );
      }
      if (!hasSelector && args.state !== undefined) {
        throw new Error('wait_for\'s "state" describes a selector, so it is only valid together with "selector".');
      }

      const target = ctx.sessions.resolve(args.sessionId, args.pageId);
      const timeout = args.timeoutMs ?? 10_000;
      const state = args.state ?? 'visible';
      const waitedFor = hasSelector
        ? `selector ${JSON.stringify(args.selector)} to be ${state}`
        : `expression ${JSON.stringify(args.expression)} to be truthy`;
      const startedAt = Date.now();

      // "hidden" and "detached" are BOTH satisfied by an element that is not in
      // the DOM at all, so a mistyped selector in "wait for the modal to close"
      // returns success in a couple of milliseconds having proved nothing. That
      // is the one shape of wait that can pass while nothing was ever waited
      // for, so whether the selector ever matched anything is recorded rather
      // than left to be inferred from waitedMs.
      const absenceSatisfies = hasSelector && (state === 'hidden' || state === 'detached');
      let everMatched = absenceSatisfies ? (await target.page.locator(args.selector as string).count()) > 0 : true;

      try {
        if (args.selector !== undefined) {
          await target.page.locator(args.selector).waitFor({ state, timeout });
        } else {
          await target.page.waitForFunction(args.expression as string, undefined, { timeout });
        }
      } catch (err) {
        const waitedMs = Date.now() - startedAt;
        // A bare Playwright timeout names the locator it gave up on and
        // nothing about what the caller was actually waiting for, so it gets
        // rewritten rather than passed through.
        if (err instanceof Error && err.name === 'TimeoutError') {
          throw new Error(`wait_for gave up after ${waitedMs}ms waiting for ${waitedFor}.`);
        }
        throw new Error(
          `wait_for failed after ${waitedMs}ms waiting for ${waitedFor}: ${err instanceof Error ? err.message : String(err)}`
        );
      }

      // Re-checked after the wait as well: an element that was there and then
      // went away really was waited for, and only a selector matching nothing
      // at either end is the empty case worth warning about.
      if (absenceSatisfies && !everMatched) {
        everMatched = (await target.page.locator(args.selector as string).count()) > 0;
      }

      return text({
        pageId: target.pageId,
        satisfied: true,
        waitedMs: Date.now() - startedAt,
        waitedFor,
        everMatched,
        ...(everMatched
          ? {}
          : {
              note:
                `The selector ${JSON.stringify(args.selector)} never matched anything, before or after the wait, and ` +
                `"${state}" is satisfied by an element that is not in the DOM at all. So this wait was satisfied by ` +
                'ABSENCE rather than by anything happening. That is exactly what a mistyped selector looks like: ' +
                'check it with snapshot or find before reading this as proof the element went away.'
            })
      });
    }
  }),

  drag: defineTool({
    serializesInput: true,
    description:
      'Drag from one point to another in a session\'s tab with a real mouse: press, several intermediate moves, release. One atomic gesture, not a separate grab and drop, because a half-finished drag leaves the page in a state nothing else here can recover. Covers BOTH kinds of dragging: pointer-event canvases (React Flow, dnd-kit, d3-drag, anything moving an element from pointermove) and native HTML5 drag-and-drop (draggable="true" with dragstart/dragover/drop). The same mouse sequence drives both, so there is no mode to choose. Source and target each take a selector (the element\'s centre), a raw x/y viewport point (for a region of a canvas that is not a DOM element), or a selector plus x/y (an offset inside it, e.g. a node\'s drag handle). IF THE DRAG APPEARS TO DO NOTHING, in this order: raise "steps", because most drag libraries spend the first move activating the drag and only start following on later ones, so too few moves fires every event and moves nothing; set "holdMs" if the app uses a long-press or delay-activated drag, which cancels outright when the pointer moves too soon; set "settleMs" if the drop lands but the app has not finished reacting; check the coordinates in the result, which are where the mouse really went. Returns the resolved source and target points, plus \'nativeDrag\': true when the browser ran the gesture as a native HTML5 drag rather than as pointer events, which tells a canvas drag that did nothing exactly why; false when the probe genuinely ran and saw no native drag start; and null, with a note, on the rare gesture that navigates the page away before the probe can be read, since a fresh document\'s own counter is not evidence about the document that navigated away, and reporting that as false would be exactly the kind of unearned negative this field exists to avoid. ' +
      'A resolved selector is only a bounding box, and a box says nothing about what is drawn on top of it, so BOTH endpoints are hit-tested with elementFromPoint before the mouse ever moves, the same test element_box runs for a plain click target. sourceHit and targetHit each carry matchesTarget (true when the point really belongs to the named selector, an ancestor of it, or a descendant of it; null for a raw x/y endpoint, which names nothing to compare against) and elementAtPoint (what is really there, named the way element_box\'s occludedBy is, whenever that differs from a clean match). The hit test accounts for shadow DOM the same way element_box does: an endpoint inside an open or closed shadow root that is genuinely unoccluded reports matchesTarget true, not false against its own host, and a real overlay sitting on top of it INSIDE THAT SAME shadow root is still caught rather than waved through by the retargeting that makes the first case work. When a selector\'s point does not reach its own element the top-level result carries "matched": false and a "note" naming the endpoint and what covered it instead, so a press that silently lands on a modal or a loading overlay cannot read as a normal drag. This does NOT throw for an occluded endpoint: a canvas point that is deliberately under a transparent hit-testing overlay, or a selector naming a node nested inside the thing that truly receives the gesture, are both real drags, so check "matched" rather than assuming a resolved call pressed what it was asked to. ' +
      'Clears any existing text selection before pressing, deliberately: a press landing inside a selection left over from an earlier drag makes the browser drag that selection instead, and the page then sees no pointermove at all. Does NOT wait for either element to appear: call wait_for first. Does NOT verify that anything moved, so assert the page state yourself afterwards.',
    inputSchema: z.object({
      sessionId,
      pageId,
      source: pointerEndpoint.describe('Where the drag starts: the point that gets pressed.'),
      target: pointerEndpoint.describe('Where the drag ends: the point where the button is released.'),
      steps: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(
          'How many intermediate mousemove events to send between press and release. Defaults to 20. This exists because a single move from A to B silently does nothing in most drag libraries: they consume the first move activating the drag, and HTML5 drop targets need dragover to fire over them while the pointer is there. Lower it only to reproduce that failure deliberately.'
        ),
      holdMs: z
        .number()
        .min(0)
        .optional()
        .describe(
          'Milliseconds to hold the press still before moving. Defaults to 0. Long-press and delay-activated drags cancel themselves if the pointer moves too soon, so they need this set above their activation delay.'
        ),
      settleMs: z
        .number()
        .min(0)
        .optional()
        .describe(
          'Milliseconds to pause at the target after the last move, before releasing. Defaults to 0. Raise it when the drop target only registers after a debounce or an animation.'
        ),
      button: z
        .enum(['left', 'middle', 'right'])
        .optional()
        .describe('Mouse button to drag with. Defaults to "left". Use "middle" for a canvas that pans on a middle-button drag.'),
      modifiers: z
        .array(z.enum(['Alt', 'Control', 'Meta', 'Shift']))
        .optional()
        .describe(
          'Modifier keys held down for the whole gesture and released after it, e.g. ["Shift"] for a canvas that box-selects on a shift-drag, or ["Alt"] for one that duplicates. Held from before the press until after the release, because a library reading the modifier on pointermove sees nothing if it is only down at the press.'
        ),
      timeoutMs: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('How long to spend resolving each endpoint selector before failing. Defaults to 5000.')
    }),
    async handler(ctx, args) {
      const target = ctx.sessions.resolve(args.sessionId, args.pageId);
      const timeout = args.timeoutMs ?? POINTER_ENDPOINT_TIMEOUT_MS;
      const from = await resolvePointerPoint(target.page, args.source, 'drag', 'source', timeout);
      const to = await resolvePointerPoint(target.page, args.target, 'drag', 'target', timeout);

      // Checked before the mouse ever moves, not after: an overlay that would swallow the
      // press is true right now, and pressing anyway would tell it the drag succeeded no
      // matter what the covering element does with the event. mouse.move/down/up bypass
      // Playwright's own actionability checks entirely (that is the whole reason this tool
      // exists, to reach a pointer-event canvas rather than a Locator), so nothing else here
      // would ever have caught this.
      const sourceHit = await hitTestPointerPoint(target.page, from);
      const targetHit = await hitTestPointerPoint(target.page, to);

      const steps = args.steps ?? 20;
      const holdMs = args.holdMs ?? 0;
      const settleMs = args.settleMs ?? 0;
      const button = args.button ?? 'left';

      const modifiers = args.modifiers ?? [];

      const dragProbeArmedOn = await armDragProbe(target.page);
      const mouse = target.page.mouse;
      for (const modifier of modifiers) {
        await target.page.keyboard.down(modifier);
      }
      let pressed = false;
      try {
        await mouse.move(from.x, from.y);
        await mouse.down({ button });
        pressed = true;
        if (holdMs > 0) await sleep(holdMs);
        await mouse.move(to.x, to.y, { steps });
        if (settleMs > 0) await sleep(settleMs);
        await mouse.up({ button });
        pressed = false;
      } finally {
        // The button is released here, not only on the happy path. This tool
        // is one call rather than a grab and a drop precisely so a button can
        // never be stranded down between calls, and anything throwing between
        // the press and the release would have stranded one anyway: every
        // later click in the session would then be a drag, undetectable from
        // outside. A modifier left down would do the same to every later key
        // press, so it gets the same treatment.
        if (pressed) await mouse.up({ button }).catch(() => {});
        for (const modifier of [...modifiers].reverse()) {
          await target.page.keyboard.up(modifier).catch(() => {});
        }
      }
      const nativeDrag = await readDragProbe(target.page, dragProbeArmedOn);

      // Occlusion is reported, not thrown on, and that is a deliberate choice rather than
      // an oversight: a canvas point deliberately sitting under a transparent hit-testing
      // overlay, or a selector naming a child of the element that actually receives the
      // gesture, are both legitimate drags that a hard failure would break for no reason.
      // What matters is that a caller can never mistake "the mouse visited the coordinates"
      // for "the press reached the element it was told to press", so a mismatch is
      // surfaced loudly in the result instead: the same matched/note shape fill, wheel and
      // every other tool in this file already use for "it ran, but not on what you meant".
      const mismatched = (['source', 'target'] as const).filter(
        which => (which === 'source' ? sourceHit : targetHit).matchesTarget === false
      );
      const anySelectorGiven = from.selector !== undefined || to.selector !== undefined;

      // Two independent things can each want to attach a note (an occluded endpoint, and a
      // native drag), and a result only has one "note" field. Building the notes as a list
      // and joining them, rather than two separate spreads each keyed "note", is what stops
      // the second one from silently overwriting the first: object spread applies keys in
      // the order they are listed, so two literal `note:` spreads back to back would lose
      // whichever one lost that race, and that is precisely the kind of thing this tool
      // exists to never do to a caller.
      const notes: string[] = [];
      if (mismatched.length > 0) {
        notes.push(
          `The press did not land on the ${mismatched.join(' or ')} selector's own element: ` +
            mismatched
              .map(which => `at ${which}, ${describeElement((which === 'source' ? sourceHit : targetHit).elementAtPoint)} received it instead`)
              .join('; ') +
            '. Coordinates still went where the box math said, but something else was really on top of the point at press time, which is exactly how a modal, a loading overlay or a sibling drawn later swallows a drag while this call still reports a clean gesture. If that element is meant to be there (a transparent hit-testing overlay over a canvas, say) this is not a failure; otherwise raise its z-index down out of the way or point the selector at what is really on top.'
        );
      }
      if (nativeDrag) {
        notes.push(
          'The browser ran this as a NATIVE HTML5 drag (a dragstart fired), not as a stream of pointer events. That is correct for a draggable="true" element with a drop handler. It is the wrong mechanism for a canvas library, which sees no pointermove at all while a native drag is in flight: something under the press point is draggable by default, such as an image or a link.'
        );
      } else if (nativeDrag === null) {
        notes.push(
          'Whether this ran as a native HTML5 drag could not be determined: the gesture appears to have navigated the page away, so the document the probe was armed on is gone. A fresh document\'s own counter starting at zero is not evidence about the document that navigated away, so "nativeDrag" is null here rather than false. If a native drag was in fact the reason the page navigated (dragging a plain link, for instance), that is itself worth checking directly.'
        );
      }

      return text({
        pageId: target.pageId,
        source: from,
        target: to,
        sourceHit,
        targetHit,
        steps,
        holdMs,
        settleMs,
        button,
        ...(modifiers.length > 0 ? { modifiers } : {}),
        nativeDrag,
        ...(anySelectorGiven ? { matched: mismatched.length === 0 } : {}),
        ...(notes.length > 0 ? { note: notes.join(' ') } : {})
      });
    }
  }),

  select_option: defineTool({
    serializesInput: true,
    description:
      'Choose one or more options in a native <select> in a session\'s tab. This is the only way to drive a native select: click cannot open its popup, because the popup is drawn by the operating system and is not in the page at all, and fill throws on a select outright. Pick by exactly one of values (the option\'s value attribute), labels (its visible text) or indexes (its position, counting from 0). Pass several to a multi-select; pass an empty list to deselect everything. Fires a real change event, so anything listening for one runs. Always reads the selection back afterwards: the result carries "selected" (value, label and index of every option really selected now), "multiple", "matched", and a "note" explaining the difference when the page settled on something other than what was asked for. Does NOT work on a custom dropdown built from divs: those are ordinary elements, so use click.',
    inputSchema: z.object({
      sessionId,
      pageId,
      selector: z.string().describe('Playwright selector of the <select> element.'),
      values: z
        .array(z.string())
        .optional()
        .describe('Option value attributes to select. An empty array deselects everything. Mutually exclusive with labels and indexes.'),
      labels: z
        .array(z.string())
        .optional()
        .describe('Visible option labels to select, matched exactly. Mutually exclusive with values and indexes.'),
      indexes: z
        .array(z.number().int().min(0))
        .optional()
        .describe('Option positions to select, counting from 0. Mutually exclusive with values and labels.')
    }),
    async handler(ctx, args) {
      const given = (['values', 'labels', 'indexes'] as const).filter(key => args[key] !== undefined);
      if (given.length !== 1) {
        throw new Error(
          `select_option needs exactly one of "values", "labels" or "indexes": ${given.length === 0 ? 'none were given' : `${given.join(' and ')} were given together`}.`
        );
      }

      const target = ctx.sessions.resolve(args.sessionId, args.pageId);
      const locator = target.page.locator(args.selector);

      const tagName = await tagNameOf(locator);
      if (tagName !== 'SELECT') {
        throw new Error(
          `select_option only drives a native <select>, and ${JSON.stringify(args.selector)} points at a <${tagName.toLowerCase()}>. A dropdown built from ordinary elements is driven with click.`
        );
      }

      if (args.values !== undefined) {
        await locator.selectOption(args.values.map(value => ({ value })));
      } else if (args.labels !== undefined) {
        await locator.selectOption(args.labels.map(label => ({ label })));
      } else {
        await locator.selectOption((args.indexes as number[]).map(index => ({ index })));
      }

      const { multiple, selected } = await readSelection(locator);
      const by = args.values !== undefined ? 'values' : args.labels !== undefined ? 'labels' : 'indexes';
      const requested = (args.values ?? args.labels ?? args.indexes) as (string | number)[];
      const actual: (string | number)[] = selected.map(option =>
        by === 'values' ? option.value : by === 'labels' ? option.label : option.index
      );
      const matched =
        actual.length === requested.length && requested.every(want => actual.some(got => got === want));

      const base = { pageId: target.pageId, selector: args.selector, by, requested, selected, multiple };
      if (matched) {
        return text({ ...base, matched: true });
      }
      return text({
        ...base,
        matched: false,
        note:
          `The select does not hold what was asked for. Requested ${by} ${JSON.stringify(requested)}, but it now holds ${JSON.stringify(actual)}. ` +
          'The page may rewrite the selection in its own change handler, or the options may have been re-rendered underneath. Trust "selected", not the request.'
      });
    }
  }),

  file_upload: defineTool({
    serializesInput: true,
    description:
      'Attach files to an <input type="file"> in a session\'s tab, and fire the change event the page listens for. Works on a hidden or styled-over input, which is how nearly every real uploader is built: point the selector at the input itself, not at the visible button in front of it, because the input never needs to be clickable for this. Paths are read by the daemon process, so they must be absolute paths to files on the machine the daemon runs on, and each one is checked for existence first: a missing file is reported by name rather than as a Playwright failure. Pass an empty list to clear the current selection. Always reads back the input\'s own FileList afterwards: the result carries "files" (name, size and MIME type of what is really attached now), "matched", and a "note" when the two disagree. Does NOT respond to an operating-system file chooser that some earlier click already opened: there is no such dialog to answer here, targeting the underlying input is what replaces it.',
    inputSchema: z.object({
      sessionId,
      pageId,
      selector: z
        .string()
        .describe('Playwright selector of the file input, or of a <label> whose control is one. It may be hidden.'),
      paths: z
        .array(z.string())
        .describe('Absolute paths to the files to attach, on the machine running the daemon. An empty array clears the selection.')
    }),
    async handler(ctx, args) {
      for (const path of args.paths) {
        if (!isAbsolute(path)) {
          throw new Error(
            `file_upload needs absolute paths: ${JSON.stringify(path)} is relative, and the daemon's working directory is not the caller's, so a relative path means two different files.`
          );
        }
        if (!existsSync(path)) {
          throw new Error(`file_upload could not find ${JSON.stringify(path)} on the machine running the daemon.`);
        }
      }

      const target = ctx.sessions.resolve(args.sessionId, args.pageId);
      const locator = target.page.locator(args.selector);

      const kind = await locator.evaluate((el: PageElement) => ({
        tag: el.tagName,
        type: (el.type ?? '').toLowerCase()
      }));
      if (kind.tag !== 'LABEL' && !(kind.tag === 'INPUT' && kind.type === 'file')) {
        throw new Error(
          `file_upload needs an <input type="file">, and ${JSON.stringify(args.selector)} points at a <${kind.tag.toLowerCase()}>${kind.tag === 'INPUT' ? ` of type "${kind.type}"` : ''}. Point it at the input itself, even if the input is hidden behind a styled button.`
        );
      }

      await locator.setInputFiles(args.paths);

      const files = await readAttachedFiles(locator);
      const expected = args.paths.map(path => basename(path));
      const attached = files.map(file => file.name);
      const matched = attached.length === expected.length && expected.every((name, i) => attached[i] === name);

      const base = { pageId: target.pageId, selector: args.selector, requested: args.paths, files };
      if (matched) {
        return text({ ...base, matched: true });
      }
      return text({
        ...base,
        matched: false,
        note:
          `The input does not hold the files that were attached. Expected ${JSON.stringify(expected)}, but it holds ${JSON.stringify(attached)}. ` +
          'The page may clear or filter the selection in its own change handler. Trust "files", not the request.'
      });
    }
  }),

  navigate_back: defineTool({
    // Serialized per session, the same way click is. Two history steps issued
    // without awaiting each other tore each other's navigation down and BOTH
    // rejected with "net::ERR_ABORTED; maybe frame was detached?", while
    // Chromium's own history showed the tab had moved one entry: two failures
    // reported for one step that actually happened. Queuing them makes the
    // second step act on the tab the first one left behind, which is what a
    // caller issuing two back steps means.
    serializesInput: true,
    description:
      'Go back one entry in a session\'s tab history, the way a user presses the browser Back button. Real history matters wherever an app writes its state into the URL and restores it from a popstate event, and nothing else here exercises that path. When there is no entry to go back to this does NOT quietly succeed: the result says "navigated": false with a note, so a no-op can never read as a step. Nor does it quietly succeed when there WAS an entry to go to but the step never actually landed. A page can catch the popstate event this fires and push its own entries on top, which is what a route guard, an unsaved-changes interceptor or a client-side auth bounce does, and it takes two shapes: the page re-pushes the URL the tab was already on, so nothing appears to move, or it pushes somewhere else entirely, so the URL changes and the tab ends up level with or FURTHER FORWARD than where it started. Both report "navigated": false with a note naming what happened, because neither is a step back. The verdict is settled against Chromium\'s own navigation history rather than against the URL, and against THREE things, because each of the first two alone was found to pass a guarded step: the tab has to have moved, it has to end on the history index the step aimed at (one back, not three), and it has to end on the ENTRY it aimed at. That last one is what catches a guard calling location.replace, which swaps an entry\'s contents in place so the index still moves exactly one the right way while the tab lands on a login page. "previousHistoryIndex", "historyIndex" and "expectedUrl" are all reported so the movement can be checked rather than taken on trust. A guard does not act until it receives the popstate event this step fires, so its own navigation begins AFTER the step resolves: this waits a real, stated window ("settleMs", 500ms by default) for that before measuring anything, which is why "url", "title" and "sameDocument" describe the document that finally loaded rather than the one the guard was about to throw away. A step the page refuses outright, which is what a beforeunload handler does, is reported as a blocked step with "timedOut": true rather than thrown as a raw timeout. Calls are serialized per session, so two history steps issued without awaiting each other queue instead of tearing each other down. "url" always says where the tab really ended up, blocked or not, so read it rather than assuming a blocked step left the tab where it was. Otherwise it reports the resulting URL and "sameDocument", exactly as navigate does: true means the URL changed without a reload, so the JS context, in-page state and the console buffer all survived, which is what a hash or pushState step back looks like. "historyIndex" and "historyLength" are always read fresh from the browser\'s own history after the step, not computed from where the tab was before it, so they describe where the tab really ended up.',
    inputSchema: z.object({
      sessionId,
      pageId,
      waitUntil,
      settleMs: z
        .number()
        .int()
        .min(0)
        .max(30_000)
        .optional()
        .describe(
          'How long to keep watching for the page to move itself after the step, in milliseconds. Defaults to 500. A route guard does not act until it receives the popstate event this step fires, so its own navigation begins AFTER the step resolves: without this window the result would describe the document the guard was about to throw away. Raise it for a guard that waits on a token check.'
        ),
      timeoutMs: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(
          'How long the step itself may take before this call gives up, in milliseconds. Defaults to 30000. Giving up is REPORTED as a blocked step, not thrown: a beforeunload handler asking the browser to stay is the usual reason, and it comes back with "navigated": false, "timedOut": true and a note.'
        )
    }),
    handler: (ctx, args) => historyStep(ctx, args, 'back')
  }),

  navigate_forward: defineTool({
    // Serialized per session, the same way click is. Two history steps issued
    // without awaiting each other tore each other's navigation down and BOTH
    // rejected with "net::ERR_ABORTED; maybe frame was detached?", while
    // Chromium's own history showed the tab had moved one entry: two failures
    // reported for one step that actually happened. Queuing them makes the
    // second step act on the tab the first one left behind, which is what a
    // caller issuing two back steps means.
    serializesInput: true,
    description:
      'Go forward one entry in a session\'s tab history, the way a user presses the browser Forward button. The counterpart to navigate_back, and it behaves identically: sitting at the newest entry there is nothing ahead, and the result says "navigated": false with a note rather than looking like a step. The same is true when there was an entry to go to but a page trapped the step, whether it pushed the tab\'s own URL straight back or pushed it somewhere else: a forward step counts only when the tab really moved, ended on the index one FORWARD of where it started, and ended on the entry it aimed at, so an overshoot and an entry swapped out underneath it are both caught. "previousHistoryIndex", "historyIndex" and "expectedUrl" report the readings, it waits the same "settleMs" window for a guard\'s own navigation to land before measuring, and it reports a refused step rather than throwing a raw timeout. Note that navigating anywhere new discards the forward entries, so a forward step is only available directly after a back step.',
    inputSchema: z.object({
      sessionId,
      pageId,
      waitUntil,
      settleMs: z
        .number()
        .int()
        .min(0)
        .max(30_000)
        .optional()
        .describe(
          'How long to keep watching for the page to move itself after the step, in milliseconds. Defaults to 500. A route guard does not act until it receives the popstate event this step fires, so its own navigation begins AFTER the step resolves: without this window the result would describe the document the guard was about to throw away. Raise it for a guard that waits on a token check.'
        ),
      timeoutMs: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(
          'How long the step itself may take before this call gives up, in milliseconds. Defaults to 30000. Giving up is REPORTED as a blocked step, not thrown: a beforeunload handler asking the browser to stay is the usual reason, and it comes back with "navigated": false, "timedOut": true and a note.'
        )
    }),
    handler: (ctx, args) => historyStep(ctx, args, 'forward')
  }),

  wheel: defineTool({
    serializesInput: true,
    description:
      'Turn the mouse wheel in a session\'s tab, which is how a canvas is zoomed and how anything with its own scroll container is scrolled. WHERE the wheel lands matters and is not incidental: a canvas zooms toward the pointer, so "point" takes the same shape as drag\'s endpoints (a selector, a raw x/y viewport point, or a selector plus an offset inside it). Omitting it aims at the centre of the viewport, deliberately, rather than at wherever some earlier click or hover happened to leave the pointer. deltaY is positive to scroll down and negative to scroll up, deltaX positive to scroll right, matching a real wheel. MODIFIERS ARE THE PINCH: a browser delivers a trackpad pinch as a wheel event with ctrlKey set, and canvas libraries branch on exactly that, so modifiers: ["Control"] is the only way to test the zoom path in an app whose plain wheel pans. They are held for the whole gesture and released afterwards. Use "repeat" when one large delta and several small ones are not the same thing, which is common: libraries that accumulate deltas, debounce, or clamp per event behave differently, and "delay" spaces the events out for one that debounces. Always reads back what really moved: the result carries the point used, the total deltas dispatched, the scroll offsets before and after (for the page and for whichever container the browser would actually scroll at that point), and "moved". Note that "moved": false is CORRECT for a canvas zoom, because a zoom is a CSS transform rather than a scroll and nothing here can observe it generically: assert the app\'s own state for that. It is a real failure if you expected a scroll. ' +
      'Resolving "point" only measures a box, it says nothing about what is drawn on top of it, and mouse.wheel dispatches at raw coordinates with none of Playwright\'s own actionability checks in the way, so the point is hit-tested with elementFromPoint before the event fires, the same test element_box runs for a plain click target. "pointHit" carries matchesTarget (true when the point really belongs to the named selector, an ancestor of it, or a descendant of it; null when point has no selector, which names nothing to compare against) and elementAtPoint (what is really there, named the way element_box\'s occludedBy is, whenever that differs from a clean match, or just informationally for a selector-less point when something is cheap to report). The hit test accounts for shadow DOM the same way element_box does: a point inside an open or closed shadow root that is genuinely unoccluded reports matchesTarget true, not false against its own host, and a real overlay sitting on top of it INSIDE THAT SAME shadow root is still caught rather than waved through by the retargeting that makes the first case work. "scroll" is drilled the same way: a scrollable container that lives inside a shadow root is found and reported on, not just the shadow host\'s own ancestors. When a selector\'s point does not reach its own element the result carries "matched": false and a "note" naming what covered it, so a wheel that silently scrolled or zoomed the wrong container cannot read as having hit the one asked for. This does NOT throw for an occluded point: a canvas point deliberately under a transparent hit-testing overlay is a real target, so check "matched" rather than assuming a resolved call landed where it was aimed. Does NOT dispatch a pinch gesture, a touch event, or a smooth scroll animation of its own.',
    inputSchema: z.object({
      sessionId,
      pageId,
      point: pointerEndpoint
        .optional()
        .describe(
          'Where the wheel event lands. Defaults to the centre of the viewport. Aim it deliberately whenever the app zooms toward the pointer or has more than one scrollable region.'
        ),
      deltaX: z
        .number()
        .optional()
        .describe('Horizontal wheel delta per event, in CSS pixels. Positive scrolls right. Defaults to 0.'),
      deltaY: z
        .number()
        .optional()
        .describe('Vertical wheel delta per event, in CSS pixels. Positive scrolls down, negative scrolls up. Defaults to 0.'),
      repeat: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(
          'How many separate wheel events to dispatch, each carrying the full delta, so the total is the delta times this. Defaults to 1. Raise it because one big delta and several small ones are genuinely different inputs: a library that accumulates, debounces or clamps per event responds to the second and not the first.'
        ),
      delay: z
        .number()
        .min(0)
        .optional()
        .describe('Milliseconds to pause between repeats. Defaults to 0. Raise it for a handler that debounces or animates between events.'),
      modifiers: z
        .array(z.enum(['Alt', 'Control', 'Meta', 'Shift']))
        .optional()
        .describe(
          'Modifier keys held down for every event and released afterwards. ["Control"] is what a trackpad pinch looks like to a page, and is usually what a canvas zooms on; ["Shift"] is what many apps pan horizontally on.'
        ),
      timeoutMs: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('How long to spend resolving the point\'s selector before failing. Defaults to 5000.')
    }),
    async handler(ctx, args) {
      const deltaX = args.deltaX ?? 0;
      const deltaY = args.deltaY ?? 0;
      if (deltaX === 0 && deltaY === 0) {
        throw new Error(
          'wheel needs a non-zero "deltaX" or "deltaY": both were zero, which would dispatch an event that moves nothing and look like a success.'
        );
      }

      const target = ctx.sessions.resolve(args.sessionId, args.pageId);
      const timeout = args.timeoutMs ?? POINTER_ENDPOINT_TIMEOUT_MS;
      // The default is derived rather than inherited on purpose: mouse.wheel
      // dispatches at the current pointer position, so without this a wheel
      // would silently land wherever an unrelated earlier call left the mouse.
      const point: PointerPoint = args.point
        ? await resolvePointerPoint(target.page, args.point, 'wheel', 'point', timeout)
        : await target.page.evaluate(() => ({
            x: Math.round(window.innerWidth / 2),
            y: Math.round(window.innerHeight / 2)
          }));

      // Same reason drag hit-tests before pressing: resolving "point" only measures a box,
      // it does not check what is actually drawn on top of it, and mouse.wheel dispatches
      // at raw coordinates with none of Playwright's own actionability checks in the way.
      // Run even when the point has no selector: elementFromPoint is cheap, and it can be
      // the difference between "the zoomed canvas got the event" and "a debug banner did".
      const pointHit = await hitTestPointerPoint(target.page, point);

      const repeat = args.repeat ?? 1;
      const delay = args.delay ?? 0;
      const modifiers = args.modifiers ?? [];

      await target.page.mouse.move(point.x, point.y);
      const before = await readScrollState(target.page, point.x, point.y);

      for (const modifier of modifiers) {
        await target.page.keyboard.down(modifier);
      }
      try {
        for (let i = 0; i < repeat; i += 1) {
          if (i > 0 && delay > 0) await sleep(delay);
          await target.page.mouse.wheel(deltaX, deltaY);
        }
      } finally {
        // Same reason drag releases in a finally: a modifier left stuck down
        // would quietly change every later key press and click in this session.
        for (const modifier of [...modifiers].reverse()) {
          await target.page.keyboard.up(modifier).catch(() => {});
        }
      }

      const after = await readSettledScrollState(target.page, point.x, point.y);
      const moved = !sameScrollState(before, after);

      // Two independent things can each want a note (the point missing its own element, and
      // a scroll that did not move), and joined into a list rather than each being a separate
      // spread with its own "note" key for the same reason drag's notes are: two literal
      // `note:` spreads back to back would let the second one silently overwrite the first.
      const notes: string[] = [];
      if (pointHit.matchesTarget === false) {
        notes.push(
          `The wheel event did not land on the point's own selector's element: ${describeElement(pointHit.elementAtPoint)} received it instead. ` +
            'Coordinates still went where the box math said, but something else was really on top of the point when the event fired, which would make the wheel scroll or zoom whatever that covering element is rather than the one named. If that element is meant to be there (a transparent hit-testing overlay over a canvas, say) this is not a failure; otherwise raise its z-index down out of the way or point the selector at what is really on top.'
        );
      }
      if (!moved) {
        notes.push(
          'No scroll offset changed. That is expected and correct for a canvas zoom, which is a CSS transform rather than a scroll and cannot be observed generically here: assert the app\'s own zoom state instead. If a scroll WAS expected, the usual causes are the point not being over the scrollable element, the element already being at that end of its range, or the app requiring a modifier this call did not hold.'
        );
      }

      return text({
        pageId: target.pageId,
        point,
        pointHit,
        deltaX,
        deltaY,
        repeat,
        delay,
        ...(modifiers.length > 0 ? { modifiers } : {}),
        totalDeltaX: deltaX * repeat,
        totalDeltaY: deltaY * repeat,
        scroll: { before, after },
        moved,
        ...(point.selector !== undefined ? { matched: pointHit.matchesTarget !== false } : {}),
        ...(notes.length > 0 ? { note: notes.join(' ') } : {})
      });
    }
  })
});
