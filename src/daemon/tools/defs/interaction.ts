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
 * PageElement widened with what a DOM walk needs to go UP, DOWN and across a
 * shadow boundary, plus the one member that answers "is this an editing host".
 *
 * Kept off PageElement itself for the reason ShadowDrillElement's comment
 * gives at length: getRootNode()'s declared return type here has no property
 * in common with the real Node a live getRootNode() returns, TypeScript's
 * weak type check rejects that pairing outright, and the one time such a
 * member was added to PageElement directly it broke every OTHER
 * locator.evaluate callback in this file rather than just the walking ones.
 * So this type is only ever reached through a cast INSIDE a callback, never
 * as a callback's own `el` parameter.
 */
interface TreeWalkElement extends PageElement {
  // True on the element itself AND on anything inside an editing host, which
  // is exactly the question "can a keystroke put text here" wants answered.
  isContentEditable?: boolean;
  children?: ArrayLike<TreeWalkElement>;
  parentElement?: TreeWalkElement | null;
  // Present (possibly null, for a closed root) only on a shadow host.
  // activeElement is the half that matters most here: document.activeElement
  // retargets to the host, so the element that really holds the caret inside
  // an open shadow root is only reachable by descending this.
  shadowRoot?: { activeElement?: TreeWalkElement | null; children?: ArrayLike<TreeWalkElement> } | null;
  // Real signature returns Node; callers here only ever read .host off it,
  // and both a Document and a ShadowRoot satisfy "optionally has a host".
  getRootNode(): { host?: TreeWalkElement };
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
 * The modifier this machine's own browser binds its CLIPBOARD and select-all
 * accelerators to: Meta on macOS, Control everywhere else. Pressing the other
 * one does not throw, and a chord built for select-all on the wrong modifier
 * reaches no such accelerator, which is the trap `press_key` shares with the
 * select-all logic below.
 *
 * What must NOT be read into that: "the other modifier does nothing". On
 * macOS it does plenty. Blink honours the emacs editing bindings there, so
 * inside a text field Control+a moves the caret to the start of the line,
 * Control+e to the end, and Control+k deletes from the caret to the end of the
 * line. All three measured directly in a real input, not inferred.
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
 * page cannot save the caller from: on macOS the browser has no select-all
 * accelerator bound to Control at all, so a chord written for one arrives
 * somewhere the caller did not intend.
 *
 * The note says that WITHOUT asserting what the press did or did not do,
 * which is the correction this text needed. It used to state that the press
 * "did not trigger a browser built-in editing accelerator", and that claim is
 * measurably false: in a real macOS input Control+a moved the caret from 5 to
 * 0, Control+e from 5 to 11, and Control+k deleted half the field. A caller
 * told "this did nothing" after Control+k presses again and destroys more
 * text, which is the opposite of what a warning is for. The firing logic
 * itself was never wrong and is unchanged.
 *
 * ControlOrMeta is exempt: Playwright itself resolves it to whichever
 * modifier is this platform's own, so it is never the wrong one.
 */
function nonAcceleratorChordNote(key: string): string | null {
  const modifiers = key.split('+').slice(0, -1);
  if (modifiers.includes('ControlOrMeta')) return null;
  if (modifiers.includes(platformAcceleratorModifier)) return null;
  if (!modifiers.includes(nonAcceleratorModifier)) return null;
  return (
    `This chord's modifier is "${nonAcceleratorModifier}", but ${process.platform}'s own accelerator modifier is ` +
    `"${platformAcceleratorModifier}". The press did not throw, and that is the only thing this result establishes: ` +
    'what the chord actually did is the browser\'s and the page\'s call, not this tool\'s, and it is not read back ' +
    'here. Two different things can go wrong behind that, in opposite directions. Select-all and the other editing ' +
    `accelerators are bound to "${platformAcceleratorModifier}" on this platform, so a chord written for one of them ` +
    'reaches no accelerator and can report an ordinary success having selected nothing. And "Control" is not inert ' +
    'on macOS: Chromium honours the emacs editing bindings, so in a text field Control+a moves the caret to the ' +
    'start of the line, Control+e to the end, and Control+k DELETES from the caret to the end of the line. All three ' +
    'measured directly. So do not read this note as "nothing happened", and do not press again on that assumption: ' +
    'read the field back with fill, type or evaluate before concluding anything. Use ' +
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
 *
 * The focused branch descends into open shadow roots rather than trusting
 * `document.activeElement` on its own. That property RETARGETS: on a page
 * whose editor lives in an open shadow root it names the shadow HOST, and a
 * host's textContent does not include its shadow tree at all. Measured
 * directly: a no-selector `type` into a shadow-DOM CodeMirror landed the text
 * and this readback came back as the empty string, which `writeResult` then
 * reported as a failed write with a reliable readback. The host is simply the
 * wrong element to read, so the walk keeps descending until it reaches the one
 * that really has the caret.
 */
function readFieldValue(page: Page, locator: Locator | null): Promise<string> {
  if (locator) {
    return locator.evaluate(
      (el: PageElement, tags: string[]) => (tags.includes(el.tagName) ? el.value ?? '' : el.textContent ?? ''),
      formControlTags
    );
  }
  return page.evaluate((tags: string[]) => {
    let el = document.activeElement as TreeWalkElement | null;
    // Bounded rather than a bare while: a shadow tree that somehow hosts
    // itself must not turn a readback into a hang.
    for (let hops = 0; hops < 32; hops += 1) {
      const inner = el?.shadowRoot?.activeElement;
      if (!inner) break;
      el = inner;
    }
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
 * `<input>` types that are form controls but hold no typed text at all.
 *
 * A deny-list rather than an allow-list on purpose: `input.type` is read as
 * the IDL property, and the browser normalizes any value it does not
 * recognise to "text", so an input type this list does not name is one that
 * really does take typed text, including ones invented after this was written.
 */
const nonTextInputTypes = [
  'checkbox',
  'radio',
  'button',
  'submit',
  'reset',
  'image',
  'file',
  'color',
  'range',
  'hidden'
];

/**
 * One element, described in the only terms the write tools actually need:
 * what it is, whether text can go into it, and whether reading it back
 * afterwards means anything.
 *
 * Facts only, no wording. Every message these drive is built in Node below,
 * so the in-page half stays small and there is exactly one place to change
 * what a refusal says.
 */
interface TextTargetReport {
  /** Uppercase tag name, as the DOM reports it. */
  tag: string;
  id: string;
  /** The normalized `type` of an INPUT, null for every other tag. */
  inputType: string | null;
  /**
   * The first couple of class names, which is often the only handle a
   * refusal has to offer. A CodeMirror's editable node carries no id at all,
   * so `<div>` on its own tells a caller nothing, while `<div
   * class="cm-content">` is the selector they need next.
   */
  classes: string;
  /** Inside an editing host: its own `contenteditable`, or an ancestor's. */
  editable: boolean;
  /** A verified Monaco or CodeMirror marker at, just above, or just below this element. */
  rich: boolean;
  /** An EditContext is attached, so the DOM is not this element's text store at all. */
  editContext: boolean;
}

/** A target's description plus where the caret really sits relative to it. */
interface TextTargetInspection {
  /** The element the caller named, or the caret holder when there was no selector. Null when neither exists. */
  target: TextTargetReport | null;
  /** The element that really has the caret, shadow boundaries crossed. Null when nothing has focus. */
  caret: TextTargetReport | null;
  /** The caret holder IS the target. */
  caretIsTarget: boolean;
  /** The caret holder sits INSIDE the target, shadow boundaries crossed. */
  caretInsideTarget: boolean;
}

/**
 * Everything the write tools need to know about an element before they type
 * into it, gathered in one pass inside the page.
 *
 * It is deliberately called two different ways, and tells them apart by the
 * type of its first argument: `locator.evaluate(fn, arg)` invokes
 * `fn(element, arg)`, while `page.evaluate(fn, arg)` invokes `fn(arg)`. That
 * small trick buys something worth having. This logic decides whether a write
 * happens at all and whether its readback may be believed, and the two
 * previous rounds of work on this file each fixed one of a pair of
 * near-identical copies of it and left the other one wrong. There is one copy
 * now, so a fix cannot reach the selector case and miss the focused case.
 *
 * Self-contained for the usual reason: Playwright serializes only this
 * function's own source, so a call out to a module-level helper would arrive
 * in the page as undefined. Every inner declaration below is here for that
 * reason and not out of preference.
 */
function inspectTextTarget(elOrMarkers: PageElement | string, maybeMarkers?: string): TextTargetInspection {
  const markers = typeof elOrMarkers === 'string' ? elOrMarkers : (maybeMarkers as string);
  const named = typeof elOrMarkers === 'string' ? null : (elOrMarkers as unknown as TreeWalkElement);

  // Written as flat loops with no inner functions, which is not a style
  // choice. The test runner transpiles this file through esbuild with
  // keepNames on, and esbuild rewrites a nested function declaration into a
  // `__name(...)` call against a helper that exists in the bundle and not in
  // the page. Playwright serializes only this function's own source, so that
  // helper arrives undefined and every call throws "__name is not defined"
  // inside the browser. The flat shape the rest of this file's in-page
  // snippets use is the shape that survives serialization.

  // The element that really has the caret. document.activeElement RETARGETS
  // to the shadow host, so on a page whose editor lives in an open shadow
  // root it names a plain <div> that can hold no text and whose textContent
  // does not include the editor's. That is how a write into a shadow-DOM
  // CodeMirror came back as an empty field and a failed write, with
  // readbackReliable: true stamped over the top of it. Bounded rather than a
  // bare while: a malformed shadow tree must not turn a readback into a hang.
  let caretNode = document.activeElement as TreeWalkElement | null;
  for (let hops = 0; hops < 32; hops += 1) {
    const inner = caretNode?.shadowRoot?.activeElement;
    if (!inner) break;
    caretNode = inner;
  }

  const targetNode = named ?? caretNode;
  const nodes: (TreeWalkElement | null)[] = [targetNode, caretNode];
  const reports: (TextTargetReport | null)[] = [null, null];

  for (let which = 0; which < 2; which += 1) {
    const node = nodes[which];
    if (!node) continue;
    // The no-selector case inspects one element as both target and caret;
    // describing it twice would only cost two more tree walks.
    if (which === 1 && node === nodes[0]) {
      reports[1] = reports[0];
      continue;
    }

    // A verified rich-editor marker AT or ABOVE the element, stepping out of
    // a shadow tree through its host wherever the parent chain runs out.
    // Eight hops, the budget the parentElement-only walk this replaces used.
    let rich = false;
    let step: TreeWalkElement | null = node;
    for (let hops = 0; step && hops < 8; hops += 1) {
      if (step.matches(markers)) {
        rich = true;
        break;
      }
      step = step.parentElement ?? step.getRootNode().host ?? null;
    }

    // And at most two levels BELOW it, a shadow root counting as one level.
    //
    // Deliberately shallow, and this is the rule worth justifying. Acres puts
    // its real CodeMirror behind `[data-testid="expression-editor-input"]`,
    // whose only child IS the `.cm-editor` root, and a test id named "-input"
    // is exactly what a QA agent aims at: the markers can sit one hop BELOW
    // the named element rather than at or above it, which an upward-only walk
    // can never see. Two levels covers that wrapper and one more around it.
    // An unbounded querySelector would not do: from <body>, or from a panel
    // that merely CONTAINS an editor somewhere, it would flag a readback that
    // legitimately covers far more than the editor, and the marker list was
    // kept to markers verified on real Monaco and CodeMirror precisely so
    // that nothing gets flagged for a problem it does not have. Under-firing
    // costs a false claim about one element; over-firing costs the meaning of
    // the flag everywhere.
    let frontier: TreeWalkElement[] = rich ? [] : [node];
    for (let depth = 0; depth < 2 && !rich && frontier.length > 0; depth += 1) {
      const next: TreeWalkElement[] = [];
      for (const parent of frontier) {
        const own = parent.children;
        for (let i = 0; own && i < own.length; i += 1) next.push(own[i]);
        const shadow = parent.shadowRoot?.children;
        for (let i = 0; shadow && i < shadow.length; i += 1) next.push(shadow[i]);
      }
      for (const kid of next) {
        if (kid.matches(markers)) {
          rich = true;
          break;
        }
      }
      frontier = next;
    }

    reports[which] = {
      tag: node.tagName,
      id: node.id,
      // `.type` on an INPUT is the normalized IDL property, not the raw
      // attribute, so an omitted or unrecognised type reads back as "text".
      inputType: node.tagName === 'INPUT' ? node.type ?? 'text' : null,
      // Two names at most: enough to identify a widget, short enough that a
      // utility-class-heavy element does not bury the rest of the message.
      classes: (node.getAttribute('class') ?? '').split(/\s+/).filter(Boolean).slice(0, 2).join(' '),
      editable: node.isContentEditable === true,
      rich,
      editContext: Boolean(node.editContext)
    };
  }

  // Whether the caret sits inside the target. Node.contains does not cross a
  // shadow boundary, so the containment test walks the parent chain and steps
  // out through each host instead.
  let caretInsideTarget = false;
  if (caretNode && targetNode && caretNode !== targetNode) {
    let step: TreeWalkElement | null = caretNode;
    for (let hops = 0; step && hops < 64; hops += 1) {
      if (step === targetNode) {
        caretInsideTarget = true;
        break;
      }
      step = step.parentElement ?? step.getRootNode().host ?? null;
    }
  }

  return {
    target: reports[0],
    caret: reports[1],
    caretIsTarget: caretNode !== null && caretNode === targetNode,
    caretInsideTarget
  };
}

/**
 * Runs `inspectTextTarget` against the named element, or against whatever
 * holds the caret when there is no selector to name one.
 *
 * The cast is the Node-side half of the two-call-shapes trick documented on
 * `inspectTextTarget`: page.evaluate passes its argument as the FIRST
 * parameter, which is exactly what that function is written to expect.
 */
function inspectTarget(page: Page, locator: Locator | null): Promise<TextTargetInspection> {
  return locator
    ? locator.evaluate(inspectTextTarget, richEditorMarkers)
    : page.evaluate(inspectTextTarget as (markers: string) => TextTargetInspection, richEditorMarkers);
}

/**
 * Whether an element can actually hold typed text.
 *
 * This is the question the guards used to get wrong by asking a different one.
 * Taking FOCUS is not taking TEXT: React Flow gives every canvas node
 * `tabindex="0"` so it can handle arrow keys, so an ordinary click on an Acres
 * node leaves `document.activeElement` on a plain `<div>`, and a guard that
 * rejected only BODY and HTML waved it straight through. Tag name cannot
 * answer this; what the element does with a keystroke can.
 */
function canReceiveText(report: TextTargetReport): boolean {
  if (report.tag === 'TEXTAREA') return true;
  // A SELECT is a form control that holds no typed text either. It gets its
  // own message rather than the generic one, so it is not answered here.
  if (report.tag === 'INPUT') return !nonTextInputTypes.includes(report.inputType ?? 'text');
  return report.editable;
}

/** How an element is named in a refusal: `<div id="wrap">`, or `<input type="checkbox">` when there is no id. */
function describeTextTarget(report: TextTargetReport): string {
  const type = report.tag === 'INPUT' && report.inputType ? ` type="${report.inputType}"` : '';
  const id = report.id ? ` id="${report.id}"` : '';
  // The class only earns its place when there is no id to name the element by.
  const classes = !report.id && report.classes ? ` class="${report.classes}"` : '';
  return `<${report.tag.toLowerCase()}${type}${id}${classes}>`;
}

/** The tool that can act on a form control which takes no typed text, when there is one. */
function toolForNonTextControl(report: TextTargetReport): string {
  if (report.tag !== 'INPUT') return '';
  const type = report.inputType ?? 'text';
  if (type === 'file') return 'Use file_upload to give a file input a file. ';
  if (type === 'checkbox' || type === 'radio') return 'Use click to toggle it. ';
  if (type === 'button' || type === 'submit' || type === 'reset' || type === 'image') return 'Use click to press it. ';
  if (type === 'range' || type === 'color') {
    return 'A range or colour input is driven by the pointer, not the keyboard: use drag, or set it through evaluate and dispatch the input event the page listens for. ';
  }
  return '';
}

/**
 * Why a write was refused, in one message, shared by `fill` and by `type`'s
 * no-selector guard because the mistake is the same one approached from two
 * directions: an element that can take focus is not an element that can take
 * text.
 *
 * The harm this exists to stop was measured, not reasoned about. On the real
 * Acres canvas, an ordinary click on a node followed by `type` with
 * `clear: true` pressed select-all and Delete at document level, React Flow
 * handled the Delete as "remove the selected node", and the flow went from
 * three nodes to two while the result said `matched: false`, which reads as
 * "nothing happened". On a fixture, `fill` aimed at a plain `<div>` wrapper
 * whose focused child was a contenteditable wrote into the CHILD and reported
 * `matched: true` against the wrapper's textContent. Both are writes into an
 * element the caller never named, and neither is something to do quietly.
 */
function refusalForUnwritableTarget(lead: string, target: TextTargetReport, inspection: TextTargetInspection): string {
  const reason =
    target.tag === 'INPUT'
      ? `${describeTextTarget(target)} is a form control, but not one that holds typed text`
      : `${describeTextTarget(target)} is not an input, a textarea, or a contenteditable, so a keystroke has nowhere to land in it`;

  const caret = inspection.caret;
  const caretNote =
    caret && inspection.caretInsideTarget && canReceiveText(caret)
      ? `The caret is actually on ${describeTextTarget(caret)} INSIDE it, so the select-all and Delete would have gone to ` +
        'THAT element: the write would have landed somewhere the selector never named, and the readback would have ' +
        'been the named element\'s textContent rather than the written field\'s. Point the selector at it instead. '
      : caret && !inspection.caretIsTarget && canReceiveText(caret)
        ? `The caret is on ${describeTextTarget(caret)}, somewhere else on the page entirely. `
        : '';

  // Worth saying even when nothing is focused yet, which is the ordinary way
  // this refusal is met: a QA agent aims at a test id and has clicked nothing.
  // Without this the message would name the element and stop, leaving the one
  // fact that gets the caller unstuck unsaid, and Acres's own expression field
  // is exactly that shape: `[data-testid="expression-editor-input"]` is a
  // wrapper whose only child is the `.cm-editor` root.
  const richNote =
    caret?.rich || target.rich
      ? 'There is a verified Monaco or CodeMirror marker at or just below this element, so it is the wrapper around a ' +
        'rich editor rather than the editor itself. Point the selector at the editable node inside it (".cm-content" ' +
        'for CodeMirror, the [data-mode-id] node for Monaco), and read its value back through the editor\'s own API ' +
        'rather than the DOM. '
      : '';

  return `${lead}: ${reason}. ` + caretNote + richNote + toolForNonTextControl(target);
}

/** Why this element's textContent readback cannot be believed, or null when it can. */
function readbackWarningFor(target: TextTargetReport | null): string | null {
  if (!target) return null;
  if (target.rich) return virtualizedEditorWarning;
  return target.editContext ? editContextWarning : null;
}

/** What the field really holds, plus whether that readback is one a rich editor can defeat. */
async function readReadbackReliability(page: Page, locator: Locator | null): Promise<string | null> {
  const { target } = await inspectTarget(page, locator);
  return readbackWarningFor(target);
}

/**
 * Refuses a WRITE whose selector matches more than one element, in this file's
 * own voice rather than Playwright's.
 *
 * click and hover act on the first match and say so in a note, because looking
 * at the wrong element is recoverable. A write is not: fill and type change
 * the page, and Playwright's strict mode is exactly what stops them writing
 * into an arbitrary one of several matches. The strictness is right. What was
 * wrong is that it surfaced as a raw "strict mode violation" thrown from deep
 * inside a readback, naming neither the tool that refused nor the way out,
 * while hover had proper guidance for the identical situation.
 */
async function assertSingleWriteTarget(tool: string, locator: Locator, selector: string): Promise<void> {
  const matched = await locator.count().catch(() => undefined);
  if (matched === undefined || matched <= 1) return;
  throw new Error(
    `${tool} will not write into ${JSON.stringify(selector)}: it matches ${matched} elements, and picking one of them ` +
      'would change the page rather than merely look at the wrong thing. Playwright selectors also pierce open shadow ' +
      'roots, so a positional path can match more of the page than it looks like it does. Narrow the selector, append ' +
      '" >> nth=0" to name one match explicitly, or use find to confirm which element you meant. Nothing was written.'
  );
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
 *
 * Before any of that it asks whether the named element can hold typed text at
 * all, which is a different question from what its tag is and from where focus
 * happens to be. The guard this replaces asked only whether focus had landed
 * at OR INSIDE the target, and "inside" is what made it dangerous: naming a
 * plain wrapper whose focused child was a contenteditable passed the guard and
 * wrote into the CHILD.
 */
async function setFieldValue(page: Page, locator: Locator, value: string): Promise<void> {
  const inspection = await inspectTarget(page, locator);
  const target = inspection.target;
  if (target === null) {
    throw new Error(
      'fill could not read the element the selector resolved to, so it wrote nothing rather than typing into something it could not identify.'
    );
  }

  // Playwright's fill has never accepted a <select>, and the error it throws
  // describes the element rather than the way out, so say the way out here.
  if (target.tag === 'SELECT') {
    throw new Error(
      'fill cannot set a <select>: it only works on an input, a textarea or a contenteditable. Use select_option instead, which picks by value, by label or by index and reads the resulting selection back.'
    );
  }

  if (!canReceiveText(target)) {
    throw new Error(
      refusalForUnwritableTarget('fill was pointed at an element that cannot receive text', target, inspection) +
        'Nothing was written.'
    );
  }

  if (formControlTags.includes(target.tag)) {
    await locator.fill(value);
    return;
  }

  await locator.focus();

  // Select-all is scoped to whatever holds the caret, so pressing it while
  // focus never landed on the target would select the whole document and the
  // delete below would empty the page. Refuse loudly instead.
  //
  // "Landed on the target" is read through inspectTextTarget's shadow-piercing
  // walk. document.activeElement retargets to the shadow host, so the identity
  // test this replaces could not see focus that had genuinely landed inside an
  // open shadow root: fill on a shadow-DOM contenteditable threw this error
  // every single time while the element was, in fact, focused, and the write
  // never happened at all.
  const afterFocus = await inspectTarget(page, locator);
  if (!afterFocus.caretIsTarget && !afterFocus.caretInsideTarget) {
    throw new Error(
      'fill could not put focus inside the target element, so it stopped rather than pressing select-all against the whole document. ' +
        (afterFocus.caret
          ? `The caret is on ${describeTextTarget(afterFocus.caret)}, which is outside the element named. `
          : 'Nothing has focus at all. ') +
        'Is the selector pointing at an input, a textarea, or a contenteditable? Nothing was written.'
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
 * no-op case is stated rather than inferred, and it is consulted again after
 * the step for the same reason: whether an entry EXISTED to step to says
 * nothing about whether the step actually landed there, since a page can
 * catch the popstate event this fires and step itself right back.
 * "navigated" is decided on evidence of real movement alone: a genuine HTTP
 * response, a changed URL, or a changed document identity.
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

  // Re-read rather than doing arithmetic on the PRE-step `history` above.
  // Probed against a back-trapping SPA (a popstate handler that re-pushes its
  // own URL, exactly what a route guard or an unsaved-changes interceptor
  // does): the trap does not merely leave the index where it was, it moves
  // the browser back and then pushes a fresh entry forward again, so
  // `history.index - 1` corroborated a step that never really landed the
  // caller anywhere. Only a fresh read of Chromium's own history tells the
  // truth about where the tab ended up.
  const afterHistory = await readNavigationHistory(target.session.context, target.page);

  // Same rule navigate uses, for the same reason: a null response alone is
  // ambiguous, so the document's own identity settles it, and an unreadable
  // identity errs toward warning the caller.
  const sameDocument = response === null && (before === null || after === null || before === after);
  // `canStep` was dropped from this check. It only says a history entry
  // EXISTS to step to, not that the step actually happened, and it used to
  // sit first in this expression, short-circuiting the three terms that
  // genuinely measure movement. Probed against a back-trapping SPA: canStep
  // was true (there really was an entry to go back to), the trap re-pushed
  // the same URL, and the result still came back "navigated": true, "url"
  // unchanged from "previousUrl", a clean pass for a back button that did
  // nothing. What is left below is evidence a step really happened: a real
  // HTTP response came back, the URL is different, or the document's own
  // identity changed.
  const navigated = response !== null || url !== previousUrl || (before !== null && after !== null && before !== after);

  const notes: string[] = [];
  if (navigated && sameDocument) {
    notes.push(
      'Same-document step: the URL changed but the document was NOT reloaded. The JS context, in-page state and the console buffer all survive, and the page saw a popstate event rather than a load. This is what a hash or pushState entry looks like going back.'
    );
  }
  if (!navigated) {
    notes.push(
      `Nothing moved: the tab is still on ${previousUrl}, even though there was a ${direction} entry to step to. ` +
        'This is what a route guard or an unsaved-changes interceptor looks like from the outside: the page saw the ' +
        'popstate event this step fired and re-pushed its own URL right back, so the browser genuinely tried to move ' +
        'and the page genuinely stopped it. Treat this as a blocked step, not a no-op.'
    );
  }

  return text({
    pageId: target.pageId,
    navigated,
    url,
    title: await target.page.title().catch(() => ''),
    sameDocument: navigated ? sameDocument : false,
    previousUrl,
    ...(afterHistory ? { historyIndex: afterHistory.index, historyLength: afterHistory.length } : {}),
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

/** Tools that drive a tab: moving it somewhere and acting on the page. */
export const interactionTools = defineTools({
  navigate: defineTool({
    description:
      'Navigate a session\'s tab to a URL. A URL differing from the current one only in its hash is a SAME-DOCUMENT navigation: the browser changes the address but does not reload, so the JS context, in-page state (React state, timers, subscriptions) and the console buffer all survive. This tool does not quietly force a reload in that case, because navigating to a hash is a legitimate thing to test. It reports it instead: every result carries a "sameDocument" boolean, present in both the true and the false case, plus a note when it is true. Use reload when you need a real page load. ' +
      'This is the most-called tool in the whole surface, and it reports the real HTTP outcome rather than treating a rendered page as success: every result carries "status" (the HTTP status code) and "ok" (whether it was in the 200 to 299 range), exactly as reload does, so navigating to a URL that answers 404 or 500 does not read as an ordinary success just because something rendered, which matters most for an SPA shell that paints its own error state under a failing response. "status" and "ok" are both null when there genuinely is no HTTP response to report a status FOR, which is not a failure: a same-document navigation, about:blank, or a non-HTTP scheme such as data: or javascript:. A note explains which of those it was, so a null status is never mistaken for a navigation that silently failed.',
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

      // navigate is the most-called tool here, and until now it discarded
      // `response` the moment sameDocument was settled: a URL that answered
      // 404 or 500 came back looking like an ordinary success, and for an SPA
      // shell that renders its own error state under a failing response even
      // "title" gave nothing away. Reported the same way reload already
      // reports it, so the two tools agree on what a caller should read.
      const status = response?.status() ?? null;
      const ok = response?.ok() ?? null;

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

      return text({
        pageId: target.pageId,
        url: target.page.url(),
        title: await target.page.title().catch(() => ''),
        sameDocument,
        status,
        ok,
        ...(notes.length ? { note: notes.join(' ') } : {})
      });
    }
  }),

  reload: defineTool({
    description:
      'Reload a session\'s tab: a real page load that discards the JS context, in-page state and everything the page had built up, and re-fetches the document. This is what navigate deliberately does not do when only the URL hash changes. The current URL, hash included, is kept. The result carries "status" (the HTTP status code of the reload) and "ok" (whether it was in the 200 to 299 range), exactly as navigate does, both null on the rare reload with no HTTP response to report, such as one landing on about:blank.',
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
        status: response?.status() ?? null,
        ok: response?.ok() ?? null
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
      'Set a field\'s contents in a session\'s tab, REPLACING whatever was there. Use type instead to append, or to fire per-character events. For an input, textarea or select this is Playwright\'s atomic fill. For a contenteditable, including rich editors like CodeMirror and Monaco, it focuses the element and replaces through real keyboard events (select-all, delete, insert), because those editors keep their own document model and treat a plain insertion as an insert at their cursor, appending onto the existing value instead of replacing it. ' +
      'The selector has to name an element that can actually HOLD typed text, and that is checked before anything is written: a text-holding input, a textarea, or something inside a contenteditable. Naming anything else is refused with a message saying what it is. That includes the case that looks like it works: a plain wrapper <div> around a focused field passed the old guard and the write went into the CHILD, reported as a clean success against the wrapper\'s textContent, so a value landed in an element the caller never named. It also refuses a <select> (use select_option), a checkbox, radio, button or file input (click, or file_upload), and a selector matching several elements, because choosing one of them would change the page rather than merely look at the wrong thing. ' +
      'Reads the field back afterwards, but that readback is DOM textContent, and for a real Monaco or CodeMirror instance textContent is not the whole story: both virtualize their lines, so it only covers what is currently rendered and reads back truncated for anything long, and an element with an EditContext attached keeps its real text there rather than in the DOM at all. The markers that detect one of these are looked for at the named element, above it (out through any open shadow root), and up to two levels below it, because a selector aimed at a wrapper one hop above the editor root is the ordinary case: Acres\'s own CodeMirror sits behind [data-testid="expression-editor-input"], whose only child is the .cm-editor root. When the target looks like one of these the result says so plainly: "readbackReliable" is false, "matched" is not claimed either way, and "note" names the editor\'s own API to read the value through instead (e.g. monaco.editor.getModels()[0].getValue()). For an ordinary field the result carries "value" (what the field really contains now), "matched", "readbackReliable": true, and a "note" explaining the difference when value and the request disagree.',
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
      // Before anything is read or written. A multi-match selector used to
      // surface as a raw Playwright strict-mode error thrown from deep inside
      // a readback, naming neither the tool that refused nor the way out,
      // while hover had proper guidance for the identical situation.
      await assertSingleWriteTarget('fill', locator, args.selector);
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
      'Type text into a session\'s tab character by character, with real key events, so per-character handlers, debounces, autocomplete and anything firing on a keystroke actually run. fill sets the value in one step and cannot exercise those. Does NOT clear the field first: it inserts at the caret, which is what a user typing does, so calling it twice types twice. Pass clear: true to replace the contents instead. Where the caret sits is the browser\'s call, not this tool\'s: focusing an input puts it after the existing text, focusing a contenteditable puts it before, so click the spot first if the insertion point matters. ' +
      'With no selector the keystrokes go to whatever currently has focus, and this refuses unless that element can actually HOLD typed text: a text-holding input, a textarea, or something inside a contenteditable. Taking focus is not the same as taking text, and the difference is destructive. React Flow gives canvas nodes tabindex="0" so they can handle arrow keys, so an ordinary click on an Acres node leaves focus on a plain <div>; with clear: true the select-all and Delete that follow reach the canvas, which reads Delete as "remove the selected node". Measured on the real app: three nodes before the call, two after, reported as matched: false. Without clear, reading that same <div> back returns its rendered text and inline CSS rather than any field\'s value. The caret holder is resolved through open shadow roots, because document.activeElement reports the shadow HOST rather than the element that really has focus. A selector matching several elements is refused too, since choosing one of them would change the page. ' +
      'Reads the field back afterwards, but that readback is DOM textContent, and for a real Monaco or CodeMirror instance textContent is not the whole story: both virtualize their lines, so it only covers what is currently rendered and reads back truncated for anything long, and an element with an EditContext attached keeps its real text there rather than in the DOM at all. Those markers are looked for at the target, above it (out through any open shadow root) and up to two levels below it, so a selector aimed at a wrapper just above the editor root is still recognised. When the target looks like one of these the result says so plainly: "readbackReliable" is false, "matched" is not claimed either way, and "note" names the editor\'s own API to read the value through instead. For an ordinary field the result carries "value" (what the field really contains now), "previousValue" (what it held BEFORE the call, clear included, so a clear cannot throw something away invisibly), "matched", "readbackReliable": true, and a "note" when what landed is not the typed text inserted into what was already there.',
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

      // Before anything is read or written, the same reason fill checks first:
      // a selector matching several elements would have this tool pick one and
      // change it, and Playwright's own refusal arrived as a bare strict-mode
      // error from inside a readback.
      if (locator !== null && args.selector !== undefined) {
        await assertSingleWriteTarget('type', locator, args.selector);
      }

      // Runs before ANYTHING else, including the very first readback below.
      //
      // The question is whether the caret holder can RECEIVE TEXT, not what
      // its tag is. The guard this replaces rejected only BODY and HTML, and
      // that is not the same test: React Flow gives every canvas node
      // tabindex="0" so it can handle arrow keys, so an ordinary click on an
      // Acres node leaves document.activeElement on a plain <div>, which
      // sailed through. With clear: true the select-all and Delete that
      // followed went to the canvas, which handles Delete as "remove the
      // selected node". Measured on the real app: three nodes before the call,
      // two after, and a result saying matched: false, which reads as nothing
      // happened. Without clear, the same call read that <div> back and
      // returned 1176 characters of rendered widget text and inline CSS as
      // both previousValue and value, stamped readbackReliable: true.
      //
      // The caret holder is resolved THROUGH open shadow roots, because
      // document.activeElement retargets to the shadow host: a page whose
      // editor lives in a shadow root reported a plain host <div> here, passed
      // the old tag test on that basis, landed the write in the editor, and
      // read the host's own (empty) textContent back as the field's value.
      if (locator === null) {
        const inspection = await inspectTarget(target.page, null);
        const holder = inspection.caret;
        // BODY and HTML keep a refusal of their own even when the page has
        // made them editable, because "can it receive text" is then genuinely
        // yes and still the wrong thing to act on: the readback would be the
        // whole document's text, and a clear would empty the page.
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
        if (!canReceiveText(holder)) {
          throw new Error(
            refusalForUnwritableTarget(
              'type has no selector, and the element that currently has focus cannot receive text',
              holder,
              inspection
            ) +
              'The element only has focus because something gave it a tabindex, which is what a canvas, a tree or a ' +
              'list widget does so it can handle arrow keys; that is not the same as being a field.' +
              (args.clear
                ? ' With clear: true the select-all and Delete would have gone to the document, and a widget that ' +
                  'reads Delete as "remove the selected item" acts on it: this has been measured deleting a node from ' +
                  'a React Flow canvas.'
                : ' Reading it back would return its rendered text and inline CSS rather than any field\'s value.') +
              ' Pass "selector" to name the field, or click into the field itself first. Nothing was typed' +
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
            'what you meant, and this tool does not read the effect back. On a platform whose select-all is bound to ' +
            'Meta, Control+a reaches no select-all accelerator; it is also not a no-op, because Chromium honours the ' +
            'macOS emacs bindings, so Control+a moves the caret to the start of the line, Control+e to the end, and ' +
            'Control+k deletes to the end of the line. Use ControlOrMeta+ for a platform editing accelerator ' +
            '(select-all and the rest): Playwright resolves it to Meta on macOS and Control everywhere else, so it ' +
            'does the right thing on every platform this runs on.'
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
      'A selector matching NOTHING is waited for, not failed immediately, because an element that appears a moment later is still one to hover: the cost is that such a call spends the whole timeout before giving up. When it does, the error says so in plain terms, and says whether the selector still matches nothing (a selector problem: check it with find, or wait_for the element first) or matches something the pointer could not be moved to (a page problem: hidden, still animating, zero-sized or covered, which element_box and computed_style can show). ' +
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
      // Playwright WAITS for a selector rather than failing straight away,
      // which is the right behaviour (an element that appears a moment later
      // is still an element to hover) and the reason a selector matching
      // nothing costs the whole timeout. What was wrong is what the caller got
      // for that wait: a raw Playwright TimeoutError, with none of the
      // guidance the rest of this file gives for the same class of mistake.
      // The wait is kept; only the explanation is added, with the match count
      // re-read afterwards so the message can tell "never appeared" apart from
      // "appeared but could not be acted on".
      const startedAt = Date.now();
      try {
        await target.page.hover(args.selector, position ? { position } : undefined);
      } catch (err) {
        if (!(err instanceof Error) || err.name !== 'TimeoutError') throw err;
        const waitedMs = Date.now() - startedAt;
        const stillMatching = await target.page.locator(args.selector).count().catch(() => undefined);
        if (stillMatching === 0) {
          throw new Error(
            `hover found nothing to hover: ${JSON.stringify(args.selector)} matched no elements when the call ` +
              `started and still matches none ${waitedMs}ms later, which is why this took as long as it did. ` +
              'Playwright waits for a selector to appear rather than failing immediately, so the whole timeout is ' +
              'spent on an element that never arrives. Check the selector with find, or wait for the element with ' +
              'wait_for first when it is meant to appear in response to something else. The pointer was not moved.'
          );
        }
        throw new Error(
          `hover could not act on ${JSON.stringify(args.selector)} within ${waitedMs}ms, even though it matches ` +
            `${stillMatching ?? 'some'} element(s) now. Playwright hovers only an element that is visible, stable ` +
            'and actually hit-testable at the point it aims at, so this is a real finding about the page rather ' +
            'than a selector typo: the element is hidden, still animating, zero-sized, or covered by something ' +
            'else. element_box reports its geometry and whether anything is on top of it, and computed_style ' +
            'reports the visibility. The pointer was not moved.'
        );
      }
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
    description:
      'Go back one entry in a session\'s tab history, the way a user presses the browser Back button. Real history matters wherever an app writes its state into the URL and restores it from a popstate event, and nothing else here exercises that path. When there is no entry to go back to this does NOT quietly succeed: the result says "navigated": false with a note, so a no-op can never read as a step. Nor does it quietly succeed when there WAS an entry to go to but the step never actually landed: a page can catch the popstate event this fires and push its own URL right back, which is exactly what a route guard or an unsaved-changes interceptor does, and "navigated" is false with a note for that too, so a back button an app is trapping the user on cannot read as a clean pass. Otherwise it reports the resulting URL and "sameDocument", exactly as navigate does: true means the URL changed without a reload, so the JS context, in-page state and the console buffer all survived, which is what a hash or pushState step back looks like. "historyIndex" and "historyLength" are always read fresh from the browser\'s own history after the step, not computed from where the tab was before it, so they describe where the tab really ended up.',
    inputSchema: z.object({ sessionId, pageId, waitUntil }),
    handler: (ctx, args) => historyStep(ctx, args, 'back')
  }),

  navigate_forward: defineTool({
    description:
      'Go forward one entry in a session\'s tab history, the way a user presses the browser Forward button. The counterpart to navigate_back, and it behaves identically: sitting at the newest entry there is nothing ahead, and the result says "navigated": false with a note rather than looking like a step, and the same is true when there was an entry to go to but a page trapped the step and pushed its own URL right back. Note that navigating anywhere new discards the forward entries, so a forward step is only available directly after a back step.',
    inputSchema: z.object({ sessionId, pageId, waitUntil }),
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
