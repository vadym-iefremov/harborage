import { existsSync } from 'node:fs';
import { basename, isAbsolute } from 'node:path';

import type { Locator, Page } from 'playwright';
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
  scrollLeft?: number;
  scrollTop?: number;
  scrollWidth?: number;
  scrollHeight?: number;
  clientWidth?: number;
  clientHeight?: number;
  matches(selector: string): boolean;
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
declare const document: {
  activeElement: PageElement | null;
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
 * The select-all chord a real user would press on this machine. Derived
 * rather than hardcoded: Chromium binds select-all to Meta on macOS and to
 * Control everywhere else, and pressing the wrong one selects nothing at all,
 * silently turning a "replace" back into the append that `fill` exists to
 * prevent.
 */
const selectAllChord = `${process.platform === 'darwin' ? 'Meta' : 'Control'}+a`;

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
function writeResult(base: Record<string, unknown>, actual: string, matched: boolean, expectation: string): ToolResult {
  if (matched) {
    return text({ ...base, value: actual, matched: true });
  }
  return text({
    ...base,
    value: actual,
    matched: false,
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
 * Clears any text the page currently has selected, and arms a probe that
 * notices a native drag starting.
 *
 * Both exist because of the same trap, found the hard way. Pressing inside an
 * existing text selection makes Chromium drag the SELECTION rather than let
 * the page see the gesture: pointermove stops firing entirely from that moment
 * on, so a canvas library gets a pointerdown, nothing, and a pointerup, and
 * leaves its node exactly where it was while every call reports success. A
 * selection left behind by an EARLIER drag is enough to do it, which makes the
 * second drag of a run behave differently from the first. Clearing it keeps a
 * drag meaning the same thing every time; the probe reports the case that is
 * genuinely native so a caller is never guessing which kind of drag ran.
 */
function armDragProbe(page: Page): Promise<void> {
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
  });
}

/** Whether the browser ran the gesture just performed as a native HTML5 drag. */
function readDragProbe(page: Page): Promise<boolean> {
  return page.evaluate(() => (window.__harborageDragStarts ?? 0) > 0).catch(() => false);
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
): Promise<{ index: number; length: number } | null> {
  let cdpSession: { send(method: any, params?: any): Promise<unknown>; detach(): Promise<void> } | undefined;
  try {
    cdpSession = await context.newCDPSession(page);
    const history = (await cdpSession.send('Page.getNavigationHistory')) as {
      currentIndex: number;
      entries: unknown[];
    };
    return { index: history.currentIndex, length: history.entries.length };
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
 * no-op case is stated rather than inferred.
 */
async function historyStep(
  ctx: ToolContext,
  args: { sessionId: string; pageId?: string; waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | 'commit' },
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
  const options = args.waitUntil ? { waitUntil: args.waitUntil } : undefined;
  const response = direction === 'back' ? await target.page.goBack(options) : await target.page.goForward(options);
  const after = await documentIdentity(target.page);
  const url = target.page.url();

  // Same rule navigate uses, for the same reason: a null response alone is
  // ambiguous, so the document's own identity settles it, and an unreadable
  // identity errs toward warning the caller.
  const sameDocument = response === null && (before === null || after === null || before === after);
  const navigated =
    canStep === true || response !== null || url !== previousUrl || (before !== null && after !== null && before !== after);

  return text({
    pageId: target.pageId,
    navigated,
    url,
    title: await target.page.title().catch(() => ''),
    sameDocument: navigated ? sameDocument : false,
    previousUrl,
    ...(history
      ? {
          historyIndex: direction === 'back' ? history.index - 1 : history.index + 1,
          historyLength: history.length
        }
      : {}),
    ...(navigated && sameDocument
      ? {
          note:
            'Same-document step: the URL changed but the document was NOT reloaded. The JS context, in-page state and the console buffer all survive, and the page saw a popstate event rather than a load. This is what a hash or pushState entry looks like going back.'
        }
      : {}),
    ...(!navigated
      ? { note: `Nothing moved: the tab is still on ${previousUrl}. Treat this as a no-op, not a step.` }
      : {})
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
      let node = document.elementFromPoint(px, py);
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
        node = node.parentElement ?? null;
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

/** Tools that drive a tab: moving it somewhere and acting on the page. */
export const interactionTools = defineTools({
  navigate: defineTool({
    description:
      'Navigate a session\'s tab to a URL. A URL differing from the current one only in its hash is a SAME-DOCUMENT navigation: the browser changes the address but does not reload, so the JS context, in-page state (React state, timers, subscriptions) and the console buffer all survive. This tool does not quietly force a reload in that case, because navigating to a hash is a legitimate thing to test. It reports it instead: every result carries a "sameDocument" boolean, present in both the true and the false case, plus a note when it is true. Use reload when you need a real page load.',
    inputSchema: z.object({
      sessionId,
      pageId,
      url: z.string().describe('URL to navigate the tab to.'),
      waitUntil
    }),
    async handler(ctx, args) {
      const target = ctx.sessions.resolve(args.sessionId, args.pageId);
      const before = await documentIdentity(target.page);
      const response = await target.page.goto(args.url, args.waitUntil ? { waitUntil: args.waitUntil } : undefined);
      const after = await documentIdentity(target.page);

      // A response means a document really was fetched and swapped in. A null
      // response is ambiguous on its own, so the identity check settles it.
      // When the identity is unreadable we say "same document", erring toward
      // warning the caller: a spurious warning costs one redundant reload, a
      // missed one costs a false pass.
      const sameDocument = response === null && (before === null || after === null || before === after);

      return text({
        pageId: target.pageId,
        url: target.page.url(),
        title: await target.page.title().catch(() => ''),
        sameDocument,
        ...(sameDocument
          ? {
              note:
                'Same-document navigation: the URL changed but the document was NOT reloaded. The JS context, in-page state and the console buffer all survive untouched, and nothing was re-fetched. Call reload if you need a real page load.'
            }
          : {})
      });
    }
  }),

  reload: defineTool({
    description:
      'Reload a session\'s tab: a real page load that discards the JS context, in-page state and everything the page had built up, and re-fetches the document. This is what navigate deliberately does not do when only the URL hash changes. The current URL, hash included, is kept.',
    inputSchema: z.object({
      sessionId,
      pageId,
      waitUntil
    }),
    async handler(ctx, args) {
      const target = ctx.sessions.resolve(args.sessionId, args.pageId);
      const response = await target.page.reload(args.waitUntil ? { waitUntil: args.waitUntil } : undefined);
      return text({
        pageId: target.pageId,
        url: target.page.url(),
        title: await target.page.title().catch(() => ''),
        status: response?.status()
      });
    }
  }),

  click: defineTool({
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
    description:
      'Set a field\'s contents in a session\'s tab, REPLACING whatever was there. Use type instead to append, or to fire per-character events. For an input, textarea or select this is Playwright\'s atomic fill. For a contenteditable, including rich editors like CodeMirror and Monaco, it focuses the element and replaces through real keyboard events (select-all, delete, insert), because those editors keep their own document model and treat a plain insertion as an insert at their cursor, appending onto the existing value instead of replacing it. Always reads the field back afterwards: the result carries "value" (what the field really contains now), "matched", and a "note" explaining the difference when they disagree.',
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
      return writeResult(
        { pageId: target.pageId, selector: args.selector, requested: args.value },
        actual,
        actual === args.value,
        `Expected exactly ${JSON.stringify(args.value)}.`
      );
    }
  }),

  type: defineTool({
    description:
      'Type text into a session\'s tab character by character, with real key events, so per-character handlers, debounces, autocomplete and anything firing on a keystroke actually run. fill sets the value in one step and cannot exercise those. Does NOT clear the field first: it inserts at the caret, which is what a user typing does, so calling it twice types twice. Pass clear: true to replace the contents instead. Where the caret sits is the browser\'s call, not this tool\'s: focusing an input puts it after the existing text, focusing a contenteditable puts it before, so click the spot first if the insertion point matters. With no selector the keystrokes go to whatever currently has focus. Always reads the field back afterwards: the result carries "value" (what the field really contains now), "previousValue" (what it held BEFORE the call, clear included, so a clear cannot throw something away invisibly), "matched", and a "note" when what landed is not the typed text inserted into what was already there. With clear: true and NO selector it refuses outright when nothing has focus, rather than pressing select-all against the whole document, which on a contenteditable page empties it.',
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

      // Read BEFORE the clear, so "previousValue" means what its name says.
      // Read after, it was always the emptied field on a clearing call, which
      // also made "matched" a comparison against nothing: it could not fail,
      // whatever the clear had just destroyed.
      const before = await readFieldValue(target.page, locator);

      if (args.clear) {
        if (locator) {
          await setFieldValue(target.page, locator, '');
        } else {
          // The same guard fill carries, for the same reason. Select-all is
          // scoped to whatever holds the caret, so pressing it with nothing
          // focused, or with the caret in the document itself, selects the
          // whole page and the delete that follows empties it. On a
          // contenteditable body that silently destroys the document while the
          // call still reports a match. With no selector there is no target to
          // verify focus against, so refuse rather than guess.
          const holder = await target.page.evaluate(() => {
            const el = document.activeElement;
            if (!el) return null;
            return { tag: el.tagName, id: el.id };
          });
          if (holder === null || holder.tag === 'BODY' || holder.tag === 'HTML') {
            throw new Error(
              'type cannot clear without a selector when nothing has focus: the caret is in the document itself, so ' +
                'select-all would select the whole page and the delete after it would empty a contenteditable one. ' +
                'Pass "selector" to name the field, or click into it first. Nothing was typed and nothing was cleared.'
            );
          }
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
        `Expected ${JSON.stringify(args.text)} inserted into ${JSON.stringify(baseline)}.`
      );
    }
  }),

  press_key: defineTool({
    description:
      'Press a key in a session\'s tab, dispatching a real trusted key event. This is the only way to establish keyboard modality, which matters for accessibility checks: Chrome will not set :focus-visible on a button a script focused with .focus(), so a focus ring measured after a programmatic focus reports absent even when it is perfectly fine for a real user pressing Tab. Key syntax is Playwright\'s: Tab, Enter, Escape, ArrowDown, Backspace, a, Control+A, Shift+Tab. With no selector the key goes to whatever currently has focus. Returns where focus ended up and whether that element matches :focus-visible.',
    inputSchema: z.object({
      sessionId,
      pageId,
      key: z
        .string()
        .describe('Key or chord in Playwright syntax, e.g. "Tab", "Enter", "Escape", "ArrowDown", "Control+A", "Shift+Tab".'),
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

      return text({
        pageId: target.pageId,
        key: args.key,
        repeat,
        activeElement,
        focusVisible: activeElement?.focusVisible ?? false
      });
    }
  }),

  hover: defineTool({
    description:
      'Hover the mouse over an element in a session\'s tab, moving the real pointer to it. Synthetic pointerover/mouseover events dispatched from a script only exercise the page\'s own listeners: they cannot satisfy a CSS-only :hover rule, and they cannot open a tooltip that depends on real pointer geometry. This can. Pass x and y together to hover a specific offset from the element\'s top-left corner. Returns whether the element matches :hover afterwards.',
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
      await target.page.hover(args.selector, position ? { position } : undefined);
      const hovering = await target.page
        .locator(args.selector)
        .evaluate((el: PageElement) => el.matches(':hover'))
        .catch(() => false);
      return text({
        pageId: target.pageId,
        selector: args.selector,
        hovering,
        ...(position ? { position } : {})
      });
    }
  }),

  resize: defineTool({
    description:
      'Resize a session\'s tab viewport. This sets the real Playwright viewport, so screenshots taken afterwards are captured at the new size. Resizing through raw CDP (Emulation.setDeviceMetricsOverride) instead changes window.innerWidth but leaves screenshots at the original viewport, which silently makes every responsive screenshot misleading. This tool cannot change deviceScaleFactor: Playwright fixes that per browser context when the context is created, so pass it to create_session instead. Returns the viewport read back from the page.',
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
      return text({ pageId: target.pageId, width: args.width, height: args.height, ...measured });
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
    description:
      'Drag from one point to another in a session\'s tab with a real mouse: press, several intermediate moves, release. One atomic gesture, not a separate grab and drop, because a half-finished drag leaves the page in a state nothing else here can recover. Covers BOTH kinds of dragging: pointer-event canvases (React Flow, dnd-kit, d3-drag, anything moving an element from pointermove) and native HTML5 drag-and-drop (draggable="true" with dragstart/dragover/drop). The same mouse sequence drives both, so there is no mode to choose. Source and target each take a selector (the element\'s centre), a raw x/y viewport point (for a region of a canvas that is not a DOM element), or a selector plus x/y (an offset inside it, e.g. a node\'s drag handle). IF THE DRAG APPEARS TO DO NOTHING, in this order: raise "steps", because most drag libraries spend the first move activating the drag and only start following on later ones, so too few moves fires every event and moves nothing; set "holdMs" if the app uses a long-press or delay-activated drag, which cancels outright when the pointer moves too soon; set "settleMs" if the drop lands but the app has not finished reacting; check the coordinates in the result, which are where the mouse really went. Returns the resolved source and target points, plus \'nativeDrag\': true when the browser ran the gesture as a native HTML5 drag rather than as pointer events, which tells a canvas drag that did nothing exactly why. Clears any existing text selection before pressing, deliberately: a press landing inside a selection left over from an earlier drag makes the browser drag that selection instead, and the page then sees no pointermove at all. Does NOT wait for either element to appear: call wait_for first. Does NOT verify that anything moved, so assert the page state yourself afterwards.',
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

      const steps = args.steps ?? 20;
      const holdMs = args.holdMs ?? 0;
      const settleMs = args.settleMs ?? 0;
      const button = args.button ?? 'left';

      const modifiers = args.modifiers ?? [];

      await armDragProbe(target.page);
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
      const nativeDrag = await readDragProbe(target.page);

      return text({
        pageId: target.pageId,
        source: from,
        target: to,
        steps,
        holdMs,
        settleMs,
        button,
        ...(modifiers.length > 0 ? { modifiers } : {}),
        nativeDrag,
        ...(nativeDrag
          ? {
              note:
                'The browser ran this as a NATIVE HTML5 drag (a dragstart fired), not as a stream of pointer events. That is correct for a draggable="true" element with a drop handler. It is the wrong mechanism for a canvas library, which sees no pointermove at all while a native drag is in flight: something under the press point is draggable by default, such as an image or a link.'
            }
          : {})
      });
    }
  }),

  select_option: defineTool({
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
    description:
      'Go back one entry in a session\'s tab history, the way a user presses the browser Back button. Real history matters wherever an app writes its state into the URL and restores it from a popstate event, and nothing else here exercises that path. When there is no entry to go back to this does NOT quietly succeed: the result says "navigated": false with a note, so a no-op can never read as a step. Otherwise it reports the resulting URL and "sameDocument", exactly as navigate does: true means the URL changed without a reload, so the JS context, in-page state and the console buffer all survived, which is what a hash or pushState step back looks like.',
    inputSchema: z.object({ sessionId, pageId, waitUntil }),
    handler: (ctx, args) => historyStep(ctx, args, 'back')
  }),

  navigate_forward: defineTool({
    description:
      'Go forward one entry in a session\'s tab history, the way a user presses the browser Forward button. The counterpart to navigate_back, and it behaves identically: sitting at the newest entry there is nothing ahead, and the result says "navigated": false with a note rather than looking like a step. Note that navigating anywhere new discards the forward entries, so a forward step is only available directly after a back step.',
    inputSchema: z.object({ sessionId, pageId, waitUntil }),
    handler: (ctx, args) => historyStep(ctx, args, 'forward')
  }),

  wheel: defineTool({
    description:
      'Turn the mouse wheel in a session\'s tab, which is how a canvas is zoomed and how anything with its own scroll container is scrolled. WHERE the wheel lands matters and is not incidental: a canvas zooms toward the pointer, so "point" takes the same shape as drag\'s endpoints (a selector, a raw x/y viewport point, or a selector plus an offset inside it). Omitting it aims at the centre of the viewport, deliberately, rather than at wherever some earlier click or hover happened to leave the pointer. deltaY is positive to scroll down and negative to scroll up, deltaX positive to scroll right, matching a real wheel. MODIFIERS ARE THE PINCH: a browser delivers a trackpad pinch as a wheel event with ctrlKey set, and canvas libraries branch on exactly that, so modifiers: ["Control"] is the only way to test the zoom path in an app whose plain wheel pans. They are held for the whole gesture and released afterwards. Use "repeat" when one large delta and several small ones are not the same thing, which is common: libraries that accumulate deltas, debounce, or clamp per event behave differently, and "delay" spaces the events out for one that debounces. Always reads back what really moved: the result carries the point used, the total deltas dispatched, the scroll offsets before and after (for the page and for whichever container the browser would actually scroll at that point), and "moved". Note that "moved": false is CORRECT for a canvas zoom, because a zoom is a CSS transform rather than a scroll and nothing here can observe it generically: assert the app\'s own state for that. It is a real failure if you expected a scroll. Does NOT dispatch a pinch gesture, a touch event, or a smooth scroll animation of its own.',
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

      return text({
        pageId: target.pageId,
        point,
        deltaX,
        deltaY,
        repeat,
        delay,
        ...(modifiers.length > 0 ? { modifiers } : {}),
        totalDeltaX: deltaX * repeat,
        totalDeltaY: deltaY * repeat,
        scroll: { before, after },
        moved,
        ...(moved
          ? {}
          : {
              note:
                'No scroll offset changed. That is expected and correct for a canvas zoom, which is a CSS transform rather than a scroll and cannot be observed generically here: assert the app\'s own zoom state instead. If a scroll WAS expected, the usual causes are the point not being over the scrollable element, the element already being at that end of its range, or the app requiring a modifier this call did not hold.'
            })
      });
    }
  })
});
