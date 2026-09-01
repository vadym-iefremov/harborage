import { existsSync } from 'node:fs';
import { basename, isAbsolute } from 'node:path';

import type { ElementHandle, Frame, Locator, Page, Response } from 'playwright';
import * as z from 'zod/v4';

import {
  documentChangedNote,
  documentChangedPayload,
  isAbortedError,
  isTimeoutError,
  NAVIGATION_SETTLE_MS,
  NAVIGATION_TIMEOUT_MS,
  type PageSnapshot,
  type PendingNavigation,
  pendingNavigationPayload,
  performNavigation,
  settleAfterNavigation,
  watchNavigationActivity
} from '../navigation.js';
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
  // The three members the flattened-tree walk in hitTestPointerPoint climbs
  // by. assignedSlot is what makes slotted content work: a light-DOM node
  // distributed into a <slot> is PAINTED inside the shadow tree, so its
  // flattened parent is that slot, while its DOM parentNode stays the host.
  // Walking parentNode alone skips every element of the shadow tree that
  // wraps it, which is the half of Cause B that contains() can never see.
  assignedSlot?: FlatNode | null;
  parentNode?: FlatNode | null;
  nodeType?: number;
}

/**
 * One step of the flattened tree: an element, a ShadowRoot, or the Document.
 *
 * Deliberately not an element type, because the walk genuinely passes through
 * nodes that are not elements. A ShadowRoot reports nodeType 11 and carries a
 * host to step out through; a Document reports 9 and carries neither, which is
 * where the walk stops.
 */
interface FlatNode {
  nodeType?: number;
  host?: FlatNode | null;
  assignedSlot?: FlatNode | null;
  parentNode?: FlatNode | null;
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
  // The whole-subtree marker search runs through the native querySelector
  // rather than a hand-rolled walk: it is one call into the engine instead of
  // thousands of round trips through this interface, and it cannot miss a
  // level the way a budgeted walk can.
  querySelector?(selectors: string): TreeWalkElement | null;
  // Present on a form control. A readonly or disabled one accepts no write at
  // all, and Playwright waits for it to become editable rather than saying so.
  readOnly?: boolean;
  disabled?: boolean;
  // Present on a text-holding input or textarea: how a selection is scoped to
  // that control's own value, which is the form-control half of what a Range
  // does for a contenteditable.
  setSelectionRange?(start: number, end: number): void;
  // Present (possibly null, for a closed root) only on a shadow host.
  // activeElement is the half that matters most here: document.activeElement
  // retargets to the host, so the element that really holds the caret inside
  // an open shadow root is only reachable by descending this.
  shadowRoot?: {
    activeElement?: TreeWalkElement | null;
    children?: ArrayLike<TreeWalkElement>;
    querySelector?(selectors: string): TreeWalkElement | null;
  } | null;
  // Real signature returns Node; callers here only ever read .host off it,
  // and both a Document and a ShadowRoot satisfy "optionally has a host".
  getRootNode(): { host?: TreeWalkElement };
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

/**
 * The handful of Event members the write fence touches. Declared rather than
 * pulled from lib.dom for the same reason everything else in this file is:
 * the daemon's tsconfig has no "dom" lib on purpose.
 */
interface PageEvent {
  key?: string;
  cancelable?: boolean;
  preventDefault(): void;
  stopPropagation(): void;
  stopImmediatePropagation(): void;
}

/**
 * Chromium's AbortController, declared for one narrow use: it is how the write
 * fence removes every listener it installed without holding a reference to any
 * of them. That matters because those listeners have to be anonymous function
 * EXPRESSIONS passed straight to addEventListener. Naming them, even by
 * assigning one to a const, makes esbuild's keepNames rewrite it into a
 * `__name(...)` call against a helper that exists in the bundle and not in the
 * page, and Playwright serializes only the function's own source, so the whole
 * evaluate dies with "__name is not defined". One signal removes them all.
 */
declare const AbortController: { new (): { signal: unknown; abort(): void } };

declare const document: {
  activeElement: PageElement | null;
  /** Read by navigate's and reload's settle snapshot, together with performance.timeOrigin, in one crossing. */
  title: string;
  /** Read by the same snapshot, to spot a <meta http-equiv="refresh"> that will move the tab after the call returns. */
  querySelector(selector: string): PageElement | null;
  addEventListener(type: string, handler: (event: PageEvent) => void, options?: unknown): void;
  removeEventListener(type: string, handler: (event: PageEvent) => void, options?: unknown): void;
  elementFromPoint(x: number, y: number): PageElement | null;
  scrollingElement: PageElement | null;
  // Used to scope a deletion to one element's own contents instead of
  // pressing the browser's select-all, which the browser scopes for you.
  createRange(): PageRange;
};
/** The handful of Range members selectElementContents touches. */
interface PageRange {
  startContainer: unknown;
  endContainer: unknown;
  selectNodeContents(node: unknown): void;
}
declare const window: {
  innerWidth: number;
  innerHeight: number;
  devicePixelRatio: number;
  getSelection(): {
    removeAllRanges(): void;
    addRange(range: PageRange): void;
    rangeCount: number;
    getRangeAt(index: number): PageRange;
  } | null;
  getComputedStyle(element: PageElement): {
    overflowX: string;
    overflowY: string;
    borderLeftWidth: string;
    borderTopWidth: string;
    paddingLeft: string;
    paddingTop: string;
  };
  // Used to wait out one renderer frame after dispatching an input event, so a
  // readback cannot run before the page's own listeners have. See wheel.
  requestAnimationFrame(callback: () => void): number;
  __harborageDragProbed?: boolean;
  __harborageDragStarts?: number;
  // The write fence's own state: see installWriteFence. Kept on window
  // because the listeners it installs have to be removable from a later
  // evaluate, which cannot close over anything from the one that made them.
  __harborageWriteFence?: { blocked: boolean; controller?: { abort(): void } };
};

/**
 * An <iframe> element, as seen from its PARENT document.
 *
 * Reached only through a cast inside a callback, never as a callback's own
 * `el` parameter, for the reason ShadowDrillElement's comment gives at
 * length. Playwright types frameElement() as ElementHandle<SVGElement |
 * HTMLElement>, and under the test tsconfig (which does pull in lib.dom) a
 * narrower declared parameter stops the callback type-checking.
 *
 * offsetWidth and offsetHeight are the LAYOUT border box, in CSS pixels
 * before any transform; getBoundingClientRect is the same box after every
 * ancestor transform has been applied. The ratio between them is the scale
 * factor the point has to be divided by on the way in, which is what makes a
 * transformed iframe map correctly rather than silently by a translation.
 */
interface FrameHostElement extends PageElement {
  offsetWidth?: number;
  offsetHeight?: number;
  getBoundingClientRect(): { left: number; top: number; width: number; height: number };
}

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
 * Markers for editors that VIRTUALIZE: only the lines currently on screen
 * exist in the DOM at all, so textContent reads back truncated.
 *
 * Every one of these was measured against a real instance holding a 400-line,
 * 19889-character document, not taken from memory:
 *
 *   Monaco 0.45.0     `.monaco-editor`, ~600 characters rendered
 *   CodeMirror 6.0.1  `.cm-editor` (the view) and `.cm-content` (the editable
 *                     node a selector usually names), ~3200 rendered
 *   CodeMirror 5      `.CodeMirror`, 1191 rendered, with the gutter's line
 *                     NUMBERS interleaved into the text
 *   Ace               `.ace_editor`, 1707 rendered, including glyphs from its
 *                     hidden character-measurement layer
 *
 * `[data-mode-id]` is Monaco's own language marker and used to be listed bare.
 * It is not distinctive enough for that: it is a generic attribute name, and
 * an ordinary page wrapping its app in `<div data-mode-id="dark">` had every
 * write under it, plain inputs and textareas included, reported as an
 * untrustworthy readback advising monaco.editor.getModels(). It is qualified
 * to a descendant of `.monaco-editor` now, which is the only place it means
 * Monaco.
 */
const virtualizedEditorMarkers = '.monaco-editor, .monaco-editor [data-mode-id], .cm-editor, .cm-content, .CodeMirror, .ace_editor';

/**
 * Markers for rich-TEXT editors, which keep a document model that the DOM only
 * renders. They do not virtualize, and they defeat a textContent readback a
 * different way, so they get their own message rather than being folded in
 * above and described inaccurately.
 *
 * Measured the same way, same document:
 *
 *   Quill 2.0.2   `.ql-editor` inside `.ql-container`
 *   ProseMirror   `.ProseMirror` (which is also what TipTap renders, confirmed
 *                 in @tiptap/core's own bundle)
 *   Lexical       `[data-lexical-editor]`
 *   Slate         `[data-slate-editor]`, confirmed in slate-react's source
 *
 * All three that were instantiated rendered the whole 19889 characters, and
 * all three returned them with every line break gone: textContent runs the
 * blocks together, so a document that reads back "correct" by length is
 * already wrong by structure.
 */
const richTextEditorMarkers = '.ql-editor, .ProseMirror, [data-slate-editor], [data-lexical-editor]';

/**
 * Why textContent cannot be trusted for a virtualizing editor. Both numbers
 * below are measured: Monaco's textContent came back around 600 characters
 * and CodeMirror 6's around 3200, out of 25000, both truncated and with no
 * newline between lines, because the rendered view is a flat run of positioned
 * line elements rather than a document tree and only the lines currently on
 * screen exist in the DOM. CodeMirror 5 and Ace add their own noise on top:
 * gutter line numbers and a hidden measurement layer respectively, both of
 * which land in textContent as though they were the document's own text.
 */
const virtualizedEditorWarning =
  'This looks like a virtualizing code editor (Monaco, CodeMirror 5 or 6, or Ace). They keep only the lines ' +
  'currently on screen in the DOM, so textContent reads back truncated for a long document, with no newline ' +
  'between lines, and can carry the gutter\'s line numbers or a hidden measurement layer along with the text. ' +
  '"value" below is what the DOM happens to show, not what the editor actually holds. Read the real content ' +
  'through the editor\'s own API instead, with evaluate: monaco.editor.getModels()[0].getValue() for Monaco, a ' +
  'CodeMirror 6 view\'s state.doc.toString(), cm.getValue() for CodeMirror 5, or ace.edit(el).getValue() for Ace.';

/**
 * Why textContent cannot be trusted for a rich-text editor. Different failure,
 * so a different message: the text is all there, and every line break is not.
 * Measured on Quill, ProseMirror and Lexical holding a 400-line document, all
 * of which returned the full 19489 characters as one unbroken run. Anything
 * that is not text, an image, an embed, a mention chip, has no textContent at
 * all, so a document can read back "as requested" while differing from it in
 * every way that matters.
 */
const richTextEditorWarning =
  'This looks like a rich-text editor (Quill, ProseMirror, TipTap, Slate or Lexical). Its document model is not ' +
  'the DOM: textContent runs the blocks together with every line break gone, and anything that is not text, an ' +
  'image, an embed, a mention, contributes nothing to it at all. A single-line value can read back looking exactly ' +
  'right while a structured document is silently wrong, so "matched" is not claimed either way here. Read the real ' +
  'content through the editor\'s own API instead, with evaluate: quill.getText() or quill.getContents() for Quill, ' +
  'a ProseMirror or TipTap view\'s state.doc.toJSON(), or editor.getEditorState().toJSON() for Lexical.';

/**
 * Why a readback taken from an element that CONTAINS an editor is only partly
 * trustworthy. Deliberately narrower than the two messages above: nothing here
 * says the readback was truncated, because the element's own text was not, and
 * nothing here points at an editor API for a value the caller may never have
 * been asking about.
 */
const containedVirtualizedWarning =
  'This element is not itself an editor, but it CONTAINS a virtualizing code editor (Monaco, CodeMirror or Ace), ' +
  'whose rendered view forms part of the text read back below. Its own text is read back accurately; the embedded ' +
  'editor\'s part of it is only what happens to be on screen, so a long embedded document appears truncated and ' +
  'without line breaks. Nothing here says the value below is wrong, only that the part contributed by the editor ' +
  'cannot be compared against that editor\'s real document. Read that separately through the editor\'s own API if ' +
  'it matters, or name a narrower element that excludes it.';

/** The same, for an embedded rich-text editor, whose failure is structural rather than truncating. */
const containedRichTextWarning =
  'This element is not itself an editor, but it CONTAINS a rich-text editor (Quill, ProseMirror, TipTap, Slate or ' +
  'Lexical), whose rendered view forms part of the text read back below. Its own text is read back accurately; the ' +
  'embedded editor contributes its text with every line break gone and every non-text node, image, embed or ' +
  'mention, missing entirely. Nothing here says the value below is wrong, only that the part contributed by the ' +
  'editor cannot be compared against that editor\'s real document. Read that separately through its own API if it ' +
  'matters, or name a narrower element that excludes it.';

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

/** The two marker sets, bundled for the single argument the in-page pass takes. */
const editorMarkers = { virtualized: virtualizedEditorMarkers, richText: richTextEditorMarkers };

/** Which family of editor a target belongs to, or null for an ordinary element. */
type EditorKind = 'virtualized' | 'richText' | null;

/**
 * One element, described in the only terms the write tools actually need:
 * what it is, whether text can go into it, WHAT A DELETION AIMED AT IT WOULD
 * DESTROY, and whether reading it back afterwards means anything.
 *
 * Facts only, no wording. Every message these drive is built in Node below,
 * so the in-page half stays small and there is exactly one place to change
 * what a refusal says.
 */
interface TextTargetReport {
  /** Uppercase tag name, as the DOM reports it. */
  tag: string;
  id: string;
  /** The first couple of class names, the only handle a refusal has when there is no id. */
  classes: string;
  /** The normalized `type` of an INPUT, null for every other tag. */
  inputType: string | null;
  /** A form control that will not accept a write however it is aimed. */
  readOnly: boolean;
  disabled: boolean;
  /**
   * The element is itself an editing host: a `contenteditable` root, not
   * merely something sitting inside one.
   *
   * This is the distinction the previous guard did not make, and it is the
   * whole defect. `isContentEditable` is INHERITED, true on every descendant
   * of an editing host, and a select-all is scoped to the HOST, not to the
   * element it was aimed at. So a guard that accepted anything with
   * isContentEditable let a clear aimed at a widget inside a WYSIWYG region
   * delete the entire region. Measured: a page went from three canvas nodes
   * and 91 characters to one node and 14, reported as matched: true with no
   * note at all.
   */
  isEditingHost: boolean;
  /** The editing host that owns this element, described enough to name it in a refusal. Null when there is none. */
  editingHost: { tag: string; id: string; classes: string } | null;
  /** Which family of editor's readback this element's textContent cannot answer for. */
  editorKind: EditorKind;
  /**
   * Whether the element IS (or is inside) that editor, or merely CONTAINS one.
   *
   * The distinction is the difference between two very different sentences.
   * When the marker is at or above the element, its textContent IS the
   * editor's rendered view and the whole readback is suspect. When the marker
   * is only below it, the readback is this element's own text, which is
   * complete and correct except for the region the embedded editor renders.
   * Saying the second is the first produced a warning about truncation, and
   * advice to call monaco.editor.getModels(), over a readback of
   * "ZSee code here." that was neither truncated nor Monaco.
   */
  editorAt: 'target' | 'descendant' | null;
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
  /**
   * Whether the caret holder's text would actually appear in the target's own
   * textContent readback.
   *
   * Not the same question as caretInsideTarget, which is what this used to be
   * set from, and the difference is three ordinary configurations that were
   * being described with a sentence that was simply false. A form control's
   * `value` is never part of an ancestor's textContent. A shadow tree's text
   * is never part of its host's. Both are "inside" and neither is covered.
   */
  caretTextInTargetReadback: boolean;
}

/**
 * Everything the write tools need to know about an element before they type
 * into it, gathered in one pass inside the page.
 *
 * It is deliberately called two different ways, and tells them apart by the
 * shape of its first argument: `locator.evaluate(fn, arg)` invokes
 * `fn(element, arg)`, while `page.evaluate(fn, arg)` invokes `fn(arg)`. That
 * small trick buys something worth having. This logic decides whether a write
 * happens at all and whether its readback may be believed, and earlier rounds
 * of work on this file each fixed one of a pair of near-identical copies of it
 * and left the other one wrong. There is one copy now, so a fix cannot reach
 * the selector case and miss the focused case. An adversarial pass looking
 * specifically for a disagreement between the two shapes, shadow cases
 * included, found none.
 *
 * Written as flat loops with no inner functions, which is not a style choice:
 * the test runner transpiles through esbuild with keepNames on, and esbuild
 * rewrites a nested function declaration into a `__name(...)` call against a
 * helper that exists in the bundle and not in the page. Playwright serializes
 * only this function's own source, so that helper arrives undefined and every
 * call throws "__name is not defined" inside the browser.
 */
function inspectTextTarget(
  elOrMarkers: PageElement | { virtualized: string; richText: string },
  maybeMarkers?: { virtualized: string; richText: string }
): TextTargetInspection {
  const isMarkerArg =
    elOrMarkers !== null &&
    typeof elOrMarkers === 'object' &&
    typeof (elOrMarkers as { virtualized?: unknown }).virtualized === 'string';
  const markers = (isMarkerArg ? elOrMarkers : maybeMarkers) as { virtualized: string; richText: string };
  const named = isMarkerArg ? null : (elOrMarkers as unknown as TreeWalkElement);

  // The element that really has the caret. document.activeElement RETARGETS
  // to the shadow host, so on a page whose editor lives in an open shadow
  // root it names a plain <div> that can hold no text and whose textContent
  // does not include the editor's. Bounded rather than a bare while: a
  // malformed shadow tree must not turn a readback into a hang.
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
    if (which === 1 && node === nodes[0]) {
      reports[1] = reports[0];
      continue;
    }

    // Which editor family's readback this element's textContent cannot answer
    // for. Looked for AT the element, ABOVE it (stepping out of a shadow tree
    // through its host wherever the parent chain runs out), and ANYWHERE
    // BELOW it.
    //
    // Below is a full subtree search, not a fixed number of levels. A level
    // budget was tried and was the wrong shape: two levels was fitted to
    // Acres's `[data-testid="expression-editor-input"]` wrapper and landed one
    // level short of Acres's OWN outer test ids, `param-source` and
    // `field-source`, which are the stable ids a QA agent actually aims at. A
    // 14589-character write through one of those reported matched: true with a
    // readback that began with CodeMirror's aria-live announcer. The question
    // is not how close the editor is; it is whether the text about to be read
    // back contains an editor's render. Flagging a panel that genuinely
    // contains one is the honest answer, because its textContent really does
    // include that truncated render.
    let editorKind: EditorKind = null;
    let editorAt: 'target' | 'descendant' | null = null;
    let step: TreeWalkElement | null = node;
    for (let hops = 0; step && hops < 8 && editorKind === null; hops += 1) {
      if (step.matches(markers.virtualized)) editorKind = 'virtualized';
      else if (step.matches(markers.richText)) editorKind = 'richText';
      else step = step.parentElement ?? step.getRootNode().host ?? null;
    }
    if (editorKind !== null) editorAt = 'target';
    if (editorKind === null && node.querySelector) {
      if (node.querySelector(markers.virtualized)) editorKind = 'virtualized';
      else if (node.querySelector(markers.richText)) editorKind = 'richText';
      if (editorKind !== null) editorAt = 'descendant';
    }
    // querySelector does not cross a shadow boundary, so open roots in the
    // subtree are walked separately, under a node budget so a huge page
    // cannot turn one readback into a long pause.
    if (editorKind === null) {
      let frontier: TreeWalkElement[] = [node];
      let budget = 400;
      while (frontier.length > 0 && budget > 0 && editorKind === null) {
        const next: TreeWalkElement[] = [];
        for (const parent of frontier) {
          const root = parent.shadowRoot;
          if (root?.querySelector) {
            if (root.querySelector(markers.virtualized)) editorKind = 'virtualized';
            else if (root.querySelector(markers.richText)) editorKind = 'richText';
            if (editorKind !== null) {
              editorAt = 'descendant';
              break;
            }
          }
          const kids = parent.children;
          for (let i = 0; kids && i < kids.length && budget > 0; i += 1) {
            next.push(kids[i]);
            budget -= 1;
          }
        }
        frontier = next;
      }
    }

    // The editing host that owns this element, and whether the element IS it.
    // An editing host is an element carrying the contenteditable attribute
    // itself (or the body once designMode is on); a descendant merely
    // INHERITS isContentEditable and is not a host. That distinction is what
    // decides how much a deletion aimed here would destroy.
    let isEditingHost = false;
    let editingHost: { tag: string; id: string; classes: string } | null = null;
    if (node.isContentEditable === true) {
      let host: TreeWalkElement | null = node;
      for (let hops = 0; host && hops < 64; hops += 1) {
        const attr = host.getAttribute('contenteditable');
        const declares = attr === '' || attr === 'true' || attr === 'plaintext-only';
        const parent: TreeWalkElement | null = host.parentElement ?? host.getRootNode().host ?? null;
        if (declares || parent === null || parent.isContentEditable !== true) break;
        host = parent;
      }
      if (host) {
        isEditingHost = host === node;
        editingHost = {
          tag: host.tagName,
          id: host.id,
          classes: (host.getAttribute('class') ?? '').split(/\s+/).filter(Boolean).slice(0, 2).join(' ')
        };
      }
    }

    reports[which] = {
      tag: node.tagName,
      id: node.id,
      // Two names at most: enough to identify a widget, short enough that a
      // utility-class-heavy element does not bury the rest of the message.
      classes: (node.getAttribute('class') ?? '').split(/\s+/).filter(Boolean).slice(0, 2).join(' '),
      // `.type` on an INPUT is the normalized IDL property, not the raw
      // attribute, so an omitted or unrecognised type reads back as "text".
      inputType: node.tagName === 'INPUT' ? node.type ?? 'text' : null,
      readOnly: node.readOnly === true,
      disabled: node.disabled === true,
      isEditingHost,
      editingHost,
      editorKind,
      editorAt,
      editContext: Boolean(node.editContext)
    };
  }

  // Whether the caret sits inside the target, and whether its text would
  // actually turn up in the target's own textContent readback. Node.contains
  // does not cross a shadow boundary, so the walk steps out through each host
  // instead, and remembers whether it had to.
  let caretInsideTarget = false;
  let crossedShadow = false;
  if (caretNode && targetNode && caretNode !== targetNode) {
    let up: TreeWalkElement | null = caretNode;
    for (let hops = 0; up && hops < 64; hops += 1) {
      if (up === targetNode) {
        caretInsideTarget = true;
        break;
      }
      const parent: TreeWalkElement | null = up.parentElement ?? null;
      if (parent) {
        up = parent;
      } else {
        up = up.getRootNode().host ?? null;
        crossedShadow = true;
      }
    }
  }
  const caretTag = caretNode ? caretNode.tagName : '';
  const caretIsFormControl = caretTag === 'INPUT' || caretTag === 'TEXTAREA' || caretTag === 'SELECT';

  return {
    target: reports[0],
    caret: reports[1],
    caretIsTarget: caretNode !== null && caretNode === targetNode,
    caretInsideTarget,
    // A form control's value lives in `.value`, never in an ancestor's
    // textContent, and a shadow tree's text never reaches its host's. Both
    // are "inside" and neither is covered.
    caretTextInTargetReadback: caretInsideTarget && !crossedShadow && !caretIsFormControl
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
    ? locator.evaluate(inspectTextTarget, editorMarkers)
    : page.evaluate(
        inspectTextTarget as (markers: { virtualized: string; richText: string }) => TextTargetInspection,
        editorMarkers
      );
}

/**
 * Whether an element can actually hold typed text AND own the deletion that
 * replacing its contents would perform.
 *
 * The question this asks has been wrong twice. First it asked what the tag
 * was, which let a React Flow canvas node through because a plain <div> with
 * a tabindex is not BODY. Then it asked whether `isContentEditable` was true,
 * which is worse, because that property is INHERITED: every descendant of an
 * editing host reports true, and a select-all is scoped to the HOST. A widget
 * inside a WYSIWYG region passed, and clearing it deleted the whole region.
 *
 * The question that actually matters is what a deletion aimed here would
 * destroy. A form control scopes it to its own value, which is safe. An
 * editing host scopes it to itself, which is safe and is exactly what the
 * caller named. Anything else scopes it to something larger than the caller
 * named, or to the document, and must be refused.
 *
 * One thing this function is NOT responsible for, because the symptoms point
 * here and the cause is elsewhere: clicking a widget inside a contenteditable
 * region focuses the REGION, not the widget, so on that path this returns
 * true correctly and the caret really is on an element that owns its region.
 * What makes a no-selector clear dangerous there is that nothing named the
 * region, which is handled in `type`'s own guard. See the long comment on it
 * before concluding this function has a hole.
 */
function canReceiveText(report: TextTargetReport): boolean {
  if (report.tag === 'TEXTAREA') return true;
  // A SELECT is a form control that holds no typed text either. It gets its
  // own message rather than the generic one, so it is not answered here.
  if (report.tag === 'INPUT') return !nonTextInputTypes.includes(report.inputType ?? 'text');
  return report.isEditingHost;
}

/** How an element is named in a refusal: `<div id="wrap">`, `<input type="checkbox">`, `<div class="cm-content">`. */
function describeTextTarget(report: { tag: string; id: string; classes: string; inputType?: string | null }): string {
  const type = report.tag === 'INPUT' && report.inputType ? ` type="${report.inputType}"` : '';
  const id = report.id ? ` id="${report.id}"` : '';
  // The class only earns its place when there is no id to name the element by.
  const classes = !report.id && report.classes ? ` class="${report.classes}"` : '';
  return `<${report.tag.toLowerCase()}${type}${id}${classes}>`;
}

/**
 * The selector a caller would most plausibly retry with, built from what the
 * element actually carries: its id when it has one, otherwise its first class.
 * Deliberately a hint rather than a guarantee, because an element with neither
 * cannot be named from its own attributes at all.
 */
function cssPathHint(report: { tag: string; id: string; classes: string }): string {
  if (report.id) return `#${report.id}`;
  const first = report.classes.split(' ').filter(Boolean)[0];
  return first ? `.${first}` : report.tag.toLowerCase();
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
 * text, and an element that merely SITS INSIDE an editable region does not own
 * that region.
 *
 * The harm this exists to stop was measured, not reasoned about. On the real
 * Acres canvas, an ordinary click on a node followed by `type` with
 * `clear: true` pressed select-all and Delete at document level, React Flow
 * handled the Delete as "remove the selected node", and the flow went from
 * three nodes to two while the result said `matched: false`. On a page whose
 * canvas sat inside a `contenteditable` region the same call destroyed the
 * whole region, three nodes and 91 characters down to one node and 14, and
 * reported `matched: true` with no note at all. And `fill` aimed at a plain
 * `<div>` wrapper whose focused child was a contenteditable wrote into the
 * CHILD and reported `matched: true` against the wrapper's textContent.
 */
function refusalForUnwritableTarget(lead: string, target: TextTargetReport, inspection: TextTargetInspection): string {
  const named = describeTextTarget(target);
  let reason: string;
  if (target.tag === 'INPUT') {
    reason = `${named} is a form control, but not one that holds typed text`;
  } else if (target.editingHost && !target.isEditingHost) {
    // The dangerous case, and the one worth spelling out: this element looks
    // editable because isContentEditable is inherited, but the editing region
    // it belongs to is larger than it.
    reason =
      `${named} sits inside a contenteditable region but is not the editable element itself. Replacing its ` +
      `contents means selecting and deleting, and a selection there is scoped to the editing host, ` +
      `${describeTextTarget(target.editingHost)}, not to this element: it would destroy that whole region, ` +
      'not the part that was named';
  } else {
    reason = `${named} is not an input, a textarea, or a contenteditable, so a keystroke has nowhere to land in it`;
  }

  const instead =
    target.editingHost && !target.isEditingHost
      ? `Name ${describeTextTarget(target.editingHost)} if replacing the whole region is what you meant, or write into ` +
        'this element through evaluate if it is not. '
      : '';

  const caret = inspection.caret;
  const caretNote =
    caret && inspection.caretInsideTarget && canReceiveText(caret)
      ? `The caret is on ${describeTextTarget(caret)} INSIDE it, so a write here would have gone to THAT element: ` +
        'somewhere the selector never named, with the readback taken from the named element instead. Point the ' +
        'selector at it. '
      : caret && !inspection.caretIsTarget && canReceiveText(caret)
        ? `The caret is on ${describeTextTarget(caret)}, somewhere else on the page entirely. `
        : '';

  // Worth saying even when nothing is focused yet, which is the ordinary way
  // this refusal is met: a QA agent aims at a test id and has clicked nothing.
  const editorNote =
    caret?.editorKind || target.editorKind
      ? 'There is a verified editor marker at or below this element, so it is a wrapper around an editor rather ' +
        'than the editor itself. Point the selector at the editable node inside it (".cm-content" for CodeMirror ' +
        '6, ".ql-editor" for Quill, ".ProseMirror" for ProseMirror or TipTap), and read its value back through the ' +
        'editor\'s own API rather than the DOM. '
      : '';

  return `${lead}: ${reason}. ` + caretNote + editorNote + instead + toolForNonTextControl(target);
}

/** Why this element's textContent readback cannot be believed, or null when it can. */
function readbackWarningFor(target: TextTargetReport | null): string | null {
  if (!target) return null;
  // A container that merely CONTAINS an editor gets its own sentence. Saying
  // the editor's sentence here claimed a truncation that had not happened and
  // pointed at an API belonging to an element nothing was written to, over a
  // readback that was complete and correct. What is true of a container is
  // narrower and still worth saying: part of what it reads back is an editor's
  // rendered view, and that part cannot be trusted to match that editor's own
  // document.
  if (target.editorAt === 'descendant' && target.editorKind !== null) {
    return target.editorKind === 'virtualized' ? containedVirtualizedWarning : containedRichTextWarning;
  }
  if (target.editorKind === 'virtualized') return virtualizedEditorWarning;
  if (target.editorKind === 'richText') return richTextEditorWarning;
  return target.editContext ? editContextWarning : null;
}

/** What the field really holds, plus whether that readback is one an editor can defeat. */
async function readReadbackReliability(page: Page, locator: Locator | null): Promise<string | null> {
  const { target } = await inspectTarget(page, locator);
  return readbackWarningFor(target);
}

/**
 * Refuses a WRITE whose selector matches more than one element, in this file's
 * own voice rather than Playwright's, and hands back the count it measured so
 * a later failure can say what it actually saw rather than guessing.
 *
 * click and hover act on the first match and say so in a note, because looking
 * at the wrong element is recoverable. A write is not: fill and type change
 * the page, and Playwright's strict mode is exactly what stops them writing
 * into an arbitrary one of several matches. The strictness is right. What was
 * wrong is that it surfaced as a raw "strict mode violation" thrown from deep
 * inside a readback, naming neither the tool that refused nor the way out.
 */
async function assertSingleWriteTarget(tool: string, locator: Locator, selector: string): Promise<number | undefined> {
  const matched = await locator.count().catch(() => undefined);
  if (matched === undefined || matched <= 1) return matched;
  throw new Error(
    `${tool} will not write into ${JSON.stringify(selector)}: it matches ${matched} elements, and picking one of them ` +
      'would change the page rather than merely look at the wrong thing. Playwright selectors also pierce open shadow ' +
      'roots, so a positional path can match more of the page than it looks like it does. Narrow the selector, append ' +
      '" >> nth=0" to name one match explicitly, or use find to confirm which element you meant. Nothing was written.'
  );
}

/**
 * Where a typed character actually went, when that is not simply the element
 * the caller named.
 *
 * `type` with a selector does NOT refuse a target that cannot hold text, and
 * that stays deliberate: routing real keystrokes at a focused widget is a
 * legitimate thing to want, and press_key alone does not cover it. But
 * `pressSequentially` focuses the locator and then types at whatever holds the
 * caret, so when the focus attempt does not land, the characters go somewhere
 * else entirely and the result still names the caller's selector. Reproduced:
 * `type` aimed at a plain <div> while an input was focused put the text in the
 * INPUT, and reported the div's unchanged textContent with a note saying the
 * write "may have landed somewhere other than the intended element". It knew.
 * It just did not say where. Refusing is the wrong fix; saying so is.
 */
interface WriteDestination {
  /** Where the characters really went, named the way a refusal names an element. */
  note: string;
  /**
   * Whether reading the NAMED element back still says anything about the
   * typing. Only true when the caret holder's text genuinely appears in the
   * named element's own textContent, which rules out a focused form control
   * and anything behind a shadow boundary.
   */
  readbackStillCovers: boolean;
}

/**
 * Compares where the caret really ended up against the element the caller
 * named, after the focus attempt and before a single character is sent, and
 * again after the last one.
 *
 * Null when the two agree throughout, which is the ordinary case and adds
 * nothing to the result. The caret holder comes from the same shadow-piercing
 * descent readFieldValue uses, so an editor inside an open shadow root is
 * named as itself rather than as the host document.activeElement retargets to.
 */
function typingDestination(before: TextTargetInspection, after: TextTargetInspection): WriteDestination | null {
  // Focus moved DURING the typing, which the before-check alone cannot see.
  // Measured with a page that moves focus after the third keystroke: "ab"
  // landed in the named field and "cdef" in another one, and the result said
  // matched: false and blamed the page for rewriting the input.
  if (before.caretIsTarget && !after.caretIsTarget) {
    return {
      note:
        'Focus moved away from the element this selector names WHILE the characters were being typed: it held the ' +
        `caret when typing started and ${after.caret ? describeTextTarget(after.caret) : 'nothing at all'} held it ` +
        'when typing finished. Some of the characters went to one and the rest to the other, and which is which is ' +
        'not something this tool can tell you, so "matched" is not claimed. Read both elements back before drawing ' +
        'any conclusion.',
      readbackStillCovers: false
    };
  }
  if (before.caretIsTarget) return null;
  if (before.caret === null) {
    return {
      note:
        'Nothing had focus when the characters were sent, so they went to the document rather than into the element ' +
        'this selector names: focusing it did not move the caret there. "value" below is that element read back, ' +
        'which nothing was typed into, so "matched" is not claimed either way. Name a field, or click into one first.',
      readbackStillCovers: false
    };
  }
  if (before.caretInsideTarget) {
    return {
      note:
        `The caret sat on ${describeTextTarget(before.caret)} INSIDE the element this selector names, so that is ` +
        'the element the characters actually went into. ' +
        (before.caretTextInTargetReadback
          ? '"value" below is the named element read back, and its textContent does cover that child, so the ' +
            'comparison still means something. Name the inner element directly if you want a readback of just it.'
          : 'The named element\'s readback does NOT cover it: a form control keeps its text in .value rather than in ' +
            'any ancestor\'s textContent, and a shadow tree\'s text never reaches its host\'s, so "value" below is ' +
            'blind to the write and "matched" is not claimed. Name the inner element to read it back.'),
      readbackStillCovers: before.caretTextInTargetReadback
    };
  }
  return {
    note:
      'The characters did not go into the element this selector names. Focusing it did not move the caret there, so ' +
      `they went to ${describeTextTarget(before.caret)}, which is neither that element nor anything inside it. ` +
      '"value" below is the named element read back, which nothing was typed into, so "matched" is not claimed ' +
      'either way. That is a real result if you meant to drive a widget that keeps focus elsewhere; if you meant to ' +
      'fill a field, name the field.',
    readbackStillCovers: false
  };
}

/**
 * Turns Playwright's bare TimeoutError into the guidance the rest of this file
 * gives, or hands back whatever else was thrown, untouched.
 *
 * Playwright WAITS for a selector rather than failing straight away, which is
 * the right behaviour (an element that appears a moment later is still one to
 * act on) and the reason a selector matching nothing costs the whole timeout.
 * What was wrong is what the caller got for that wait: a raw TimeoutError,
 * naming neither the tool nor the way out.
 *
 * Two things this must not do, both of which it did. It must not assert a
 * measurement it never took: it used to say the selector "matched no elements
 * when the call started" on the strength of a count taken only AFTER the
 * failure, which was flatly false in a case where the call had counted one
 * match at the start and then destroyed it. And it must not say "Nothing was
 * written" once a write has been attempted, for the same reason. Both facts
 * are now passed in by the caller, which is the only place that knows them.
 */
async function selectorActionFailure(
  tool: string,
  page: Page,
  selector: string,
  err: unknown,
  waitedMs: number,
  nothingHappened: string,
  matchedAtStart: number | undefined,
  alreadyActed: boolean
): Promise<unknown> {
  if (!(err instanceof Error) || err.name !== 'TimeoutError') return err;
  const stillMatching = await page.locator(selector).count().catch(() => undefined);
  const atStart =
    matchedAtStart === undefined
      ? 'How many elements it matched when the call started was not measured'
      : `It matched ${matchedAtStart} element(s) when the call started`;
  const tail = alreadyActed
    ? 'This failure came AFTER the write was attempted, so the page may already have changed: read it back before ' +
      'assuming otherwise.'
    : nothingHappened;

  if (stillMatching === 0) {
    return new Error(
      `${tool} could not finish on ${JSON.stringify(selector)}: it matches no elements now, ${waitedMs}ms in, which ` +
        `is why this took as long as it did. ${atStart}. Playwright waits for a selector to appear rather than ` +
        'failing immediately, so a selector that never matches spends the whole timeout. Check the selector with ' +
        'find, or wait for the element with wait_for first when it is meant to appear in response to something ' +
        `else. ${tail}`
    );
  }
  return new Error(
    `${tool} could not act on ${JSON.stringify(selector)} within ${waitedMs}ms, even though it matches ` +
      `${stillMatching ?? 'some'} element(s) now. ${atStart}. Playwright acts only on an element that is visible, ` +
      'stable, enabled and actually writable, so this is a real finding about the page rather than a selector typo: ' +
      'the element is hidden, still animating, zero-sized, disabled, readonly, or covered by something else. ' +
      `element_box reports its geometry and whether anything is on top of it, and computed_style the visibility. ${tail}`
  );
}

/**
 * PageElement widened with the two listener methods the write fence needs.
 * A separate interface reached through a cast inside the callback, never a
 * callback's own `el` parameter, for the reason ShadowDrillElement's comment
 * gives: widening PageElement itself breaks every other locator.evaluate in
 * this file under the test tsconfig's lib.dom.
 */
/**
 * Anything the fence can be installed on. Both `Locator` and `ElementHandle`
 * satisfy it: the no-selector clear has only a handle to the focused element,
 * and the selector paths have a locator, and both need the same protection.
 */
interface FenceTarget {
  evaluate(fn: (el: PageElement, guardSelection: boolean) => boolean, arg: boolean): Promise<boolean>;
}

/**
 * A form control that has to be emptied, reached either by a selector or by a
 * handle to whatever holds focus. Structural rather than Playwright's own
 * Locator or ElementHandle<T>, whose default type parameter is `Node`: this
 * file's tsconfig has no "dom" lib, so naming either does not compile.
 *
 * `selectText` is on here because it is how a control gets emptied without a
 * key. Measured on a text input, a number input, an email input, a date input
 * and a textarea: selectText dispatches no events at all and leaves the
 * control's own text selected, and the insertText that follows replaces
 * exactly that.
 */
interface ClearableField extends FenceTarget {
  fill(value: string): Promise<void>;
  selectText(): Promise<void>;
  // Both shapes of Playwright's own overloaded evaluate: the fence passes an
  // argument, the readback does not. Declared here rather than widened on
  // FenceTarget so nothing else in this file loses the argument's type.
  evaluate(fn: (el: PageElement, guardSelection: boolean) => boolean, arg: boolean): Promise<boolean>;
  evaluate(fn: (el: PageElement) => string): Promise<string>;
}

interface FenceElement extends PageElement {
  addEventListener(type: string, handler: (event: PageEvent) => void, options?: unknown): void;
  removeEventListener(type: string, handler: (event: PageEvent) => void, options?: unknown): void;
}

/**
 * Keeps a write inside the element the caller named, at the moment the write
 * is actually dispatched rather than one round trip earlier.
 *
 * Read this together with the change that made it small. Rounds two and three
 * fought the scope of the deletion, and got that right: a Range over the
 * target's own contents bounds what the browser's default deletion touches.
 * Neither addressed the DELIVERY. A literal Delete key was still pressed, and
 * a key event reaches every ancestor. Measured: filling an inline
 * contenteditable label inside a canvas node deleted the whole node, because
 * the canvas listens for Delete and removes whatever is focused. The selection
 * was scoped correctly and the sibling content survived. The keystroke did the
 * damage, not the deletion.
 *
 * That keystroke is gone now. Every write path replaces text with
 * keyboard.insertText over a live selection, which dispatches no key event at
 * all, so an ancestor's Delete handler has nothing to hear in either phase.
 * See setFieldValue for the measurements. What is left for this fence to do is
 * narrower and still real:
 *
 * A capture listener on `document` runs before anything else in the page (only
 * a window-level capture listener could precede it) and answers the question
 * the previous round trip could not answer atomically: is the selection STILL
 * inside the target at the moment the event is dispatched? A page that moves
 * the selection on `selectionchange` fires after the evaluate that placed and
 * verified the Range has already returned, so verifying in one round trip and
 * writing in the next is a real window however small it is. Checking inside
 * the dispatch is not a smaller window, it is no window: if the selection has
 * moved, the event is cancelled and stopped dead before any handler, the
 * editor's included, can act on it. `beforeinput` is cancelable, so the check
 * covers the insert as well as a key.
 *
 * `beforeinput` is guarded but not stopped from bubbling, because a
 * text-change notification reaching the application is legitimate: the caller
 * did ask for the text to change.
 *
 * The keydown half of the guard, and the bubble listeners that stop a key
 * going further up from the target, are kept even though nothing here presses
 * a key any more. They are there for exactly the failure that produced
 * Finding 2: `locator.fill('')` dispatched a real Delete that none of this
 * code pressed, on a path nobody had enumerated. If a future Playwright
 * reintroduces a keystroke into a path that reaches this fence, the key is
 * bounded rather than loose, and round4-write's key-log tests fail loudly
 * rather than the behaviour changing quietly.
 *
 * One thing it still cannot do, and it is a DOM invariant rather than an
 * oversight: an ancestor's CAPTURE-phase handler runs before the event reaches
 * the target at all, so nothing installed at or below the target can prevent
 * it. Blocking it would mean stopping the event above the target, which would
 * also stop the editor from seeing it. That matters only where a key is still
 * pressed, which after this change is `type`'s own characters and whatever
 * `press_key` is told to press, and never a Delete.
 */
async function installWriteFence(target: FenceTarget, guardSelection: boolean): Promise<boolean> {
  return target
    .evaluate((raw: PageElement, guard: boolean) => {
      const el = raw as unknown as FenceElement;
      const controller = new AbortController();
      const state: { blocked: boolean; controller?: { abort(): void } } = { blocked: false, controller };
      window.__harborageWriteFence = state;
      const options = { capture: true, signal: controller.signal };

      // Every handler below is an anonymous function expression passed
      // straight to addEventListener, and the selection check is spelled out
      // inside each one rather than shared. Both are forced: naming a function
      // here, even by assigning it to a const, makes esbuild rewrite it into a
      // `__name(...)` call that does not exist in the page. This exact block
      // was written the readable way first and failed with "__name is not
      // defined" on every call.
      if (guard) {
        document.addEventListener(
          'keydown',
          function (event: PageEvent) {
            const selection = window.getSelection();
            const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
            if (range !== null && el.contains(range.startContainer) && el.contains(range.endContainer)) return;
            state.blocked = true;
            event.preventDefault();
            event.stopImmediatePropagation();
          },
          options
        );
        document.addEventListener(
          'beforeinput',
          function (event: PageEvent) {
            const selection = window.getSelection();
            const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
            if (range !== null && el.contains(range.startContainer) && el.contains(range.endContainer)) return;
            state.blocked = true;
            event.preventDefault();
            event.stopImmediatePropagation();
          },
          options
        );
      }
      el.addEventListener(
        'keydown',
        function (event: PageEvent) {
          event.stopPropagation();
        },
        { signal: controller.signal }
      );
      el.addEventListener(
        'keyup',
        function (event: PageEvent) {
          event.stopPropagation();
        },
        { signal: controller.signal }
      );
      return true;
    }, guardSelection)
    .catch(() => false);
}

/** Takes the fence down and reports whether it had to cancel anything. Always safe to call. */
async function removeWriteFence(page: Page): Promise<boolean> {
  return page
    .evaluate(() => {
      const state = window.__harborageWriteFence;
      state?.controller?.abort();
      window.__harborageWriteFence = undefined;
      return state?.blocked ?? false;
    })
    .catch(() => false);
}

/**
 * Selects exactly the contents of one element and nothing else, then reports
 * whether that actually took.
 *
 * This replaces pressing the platform select-all chord, and the replacement is
 * the point rather than an optimisation. Select-all is scoped by the BROWSER,
 * to the focused form control or to the editing host or to the document, and
 * none of those is necessarily the element the caller named. Worse, it is a
 * separate round trip from the guard that checked what was focused, so a page
 * with an ordinary global shortcut handler could move focus on the chord
 * itself and redirect the Delete that followed. Measured: focus sat on a plain
 * <input> when the guard ran, the chord moved it to a canvas node, and the
 * Delete removed that node while the input was untouched and the result blamed
 * the page for rewriting the input.
 *
 * A Range placed over the element's own contents cannot do either. It is
 * scoped structurally rather than by whatever happens to be focused, and it is
 * set in the same round trip that verifies it, so there is no window between
 * deciding and acting. What follows it is an insertText over that Range and no
 * key at all: see setFieldValue for why the Delete that used to follow is gone
 * and what was measured on the live CodeMirror 6 in Acres to retire it.
 */
async function selectElementContents(locator: Locator): Promise<boolean> {
  return locator.evaluate((el: PageElement) => {
    const selection = window.getSelection();
    if (!selection) return false;
    const range = document.createRange();
    range.selectNodeContents(el as unknown as never);
    selection.removeAllRanges();
    selection.addRange(range);
    // Verified rather than assumed: an editor can normalize or reject a
    // selection it does not like, and a deletion aimed at a selection that
    // never took would fall through to whatever was selected before.
    const now = selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
    return now !== null && el.contains(now.startContainer) && el.contains(now.endContainer);
  });
}

/**
 * Sets a form control's value without letting a Delete key out.
 *
 * This exists because of Finding 2, which is a fact about Playwright rather
 * than about this code. Measured on a text input and on a textarea:
 * `locator.fill('X')` dispatches beforeinput/textInput/input with inputType
 * insertText and NO key event, while `locator.fill('')` dispatches a real
 * `keydown: Delete`. So clearing an inline rename input inside a canvas node
 * deleted the node, while the identical call with a non-empty value was
 * harmless, through a key none of this code pressed. The 30 seconds Playwright
 * then spent waiting for the element it had just caused to be removed is how
 * the report came back as a timeout blaming the selector.
 *
 * A non-empty value keeps `locator.fill`, which is already keyless. An empty
 * one selects the control's own text with `selectText`, which was measured to
 * dispatch nothing at all, and empties it with `keyboard.insertText('')`,
 * which was measured to dispatch beforeinput/input with inputType insertText
 * and no key, on a text input, a number input, an email input and a textarea.
 *
 * insertText is inert on the inputs the browser renders as a picker rather
 * than as text: on `<input type="date">` it dispatched nothing and left the
 * value alone. So the result is READ BACK and the old `fill('')` is used as a
 * fallback when it did not take. That fallback is not a hole: Playwright sets
 * a date, time, colour or range input's value directly, and it was measured
 * dispatching only input and change on a date input, no key. The keystroke is
 * confined to the text-like controls, which are exactly the ones insertText
 * handles, so the fallback is never the destructive path.
 */
async function clearOrFillFormControl(
  page: Page,
  field: ClearableField,
  value: string,
  toolName: string
): Promise<void> {
  const fenced = await installWriteFence(field, false);
  try {
    if (!fenced) {
      throw new Error(
        `${toolName} could not install the guard that keeps a write's keystrokes inside the target element, so it ` +
          'stopped rather than writing unguarded. Nothing was written.'
      );
    }
    if (value.length > 0) {
      await field.fill(value);
      return;
    }
    await field.selectText();
    await page.keyboard.insertText('');
    const after = await field.evaluate((el: PageElement) => el.value ?? '').catch(() => '');
    if (after !== '') {
      // Reached only by a picker-style input, which Playwright empties by
      // assignment rather than by a key. See the note above.
      await field.fill('');
    }
  } finally {
    await removeWriteFence(page);
  }
}

/**
 * Replaces a field's contents for real.
 *
 * A contenteditable is replaced by placing a Range over its own contents and
 * writing over it with `keyboard.insertText`, which dispatches no key event of
 * any kind. Two earlier attempts are worth recording, because the difference
 * between them is the whole point of this path.
 *
 * Setting the text programmatically does not work. CodeMirror and Monaco keep
 * their own document model and treat a DOM edit as something other than an
 * edit: `document.execCommand('delete')` over a correctly placed Range on the
 * live CodeMirror 6 in Acres reported success and left the old text in the
 * model, so the insert that followed produced `{{ $json.mode }}1` out of `1`.
 *
 * Pressing Delete does work, and it is what this path used to do, and it is
 * what destroyed user data: the key reaches every ancestor, so a canvas that
 * treats Delete as "remove the selected node" removed one.
 *
 * insertText is the third answer and it is both. Measured on the live
 * CodeMirror 6 in Acres, through the editor's own `state.doc.toString()`, with
 * a Range over the whole content and no key pressed at all: a doc of
 * `{{ $json.mode }}` became `1`, which is the case the Delete was kept for,
 * and the case execCommand failed. Measured with a page-wide capture listener
 * at the same time: the only event dispatched was `beforeinput: insertText`.
 * An empty value goes the same way, verified on the same editor: `ABCDEF`
 * became the empty string under `insertText('')`, again with no key. And the
 * replacement stays inside the selection rather than taking the editing host:
 * on `<span>AAA</span><span>BBB</span><span>CCC</span>` with only the middle
 * span selected, the host read back `AAAZZZCCC`.
 *
 * What is NOT done the way a human does it is the selecting: see
 * selectElementContents.
 *
 * Before any of that it asks whether the named element can hold typed text and
 * owns the region a deletion would clear, which is a different question from
 * what its tag is, from where focus happens to be, and from whether
 * isContentEditable is true on it.
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

  // Caught here rather than left to Playwright, which waits for the element to
  // become editable and then times out: a readonly input cost the full 30
  // seconds and was then explained as "hidden, still animating, zero-sized or
  // covered", none of which was true.
  if (target.readOnly || target.disabled) {
    throw new Error(
      `fill cannot write into ${describeTextTarget(target)}: it is ${target.disabled ? 'disabled' : 'readonly'}, so ` +
        'no amount of waiting will make it accept text. That is a finding about the page, not about the selector: ' +
        'whatever is meant to enable it has not happened yet. Nothing was written.'
    );
  }

  // BODY and HTML are refused even when the page has genuinely made them
  // editable, by a contenteditable attribute or by designMode. "Can it receive
  // text" is then honestly yes, and it is still the wrong thing to write into:
  // the region is the whole document, so replacing its contents deletes the
  // page. Measured on a contenteditable body: fill reduced the page to the one
  // word it was given.
  if (target.tag === 'BODY' || target.tag === 'HTML') {
    throw new Error(
      `fill will not replace the contents of <${target.tag.toLowerCase()}>: the page has made the document itself ` +
        'editable, so the editing region is the entire page and replacing it would delete everything on it. Name ' +
        'the specific element you meant. Nothing was written.'
    );
  }

  if (!canReceiveText(target)) {
    throw new Error(
      refusalForUnwritableTarget('fill was pointed at an element that cannot receive text', target, inspection) +
        'Nothing was written.'
    );
  }

  if (formControlTags.includes(target.tag)) {
    await clearOrFillFormControl(page, locator as unknown as ClearableField, value, 'fill');
    return;
  }

  await locator.focus();

  // Focus still has to have landed, because the insert that follows goes to
  // whatever holds the caret. Read through inspectTextTarget's
  // shadow-piercing walk: document.activeElement retargets to the shadow host,
  // so the identity test this replaces could not see focus that had genuinely
  // landed inside an open shadow root, and fill on a shadow-DOM contenteditable
  // threw this error every single time while the element was, in fact, focused.
  const afterFocus = await inspectTarget(page, locator);
  if (!afterFocus.caretIsTarget && !afterFocus.caretInsideTarget) {
    throw new Error(
      'fill could not put focus inside the target element, so it stopped rather than deleting anything. ' +
        (afterFocus.caret
          ? `The caret is on ${describeTextTarget(afterFocus.caret)}, which is outside the element named. `
          : 'Nothing has focus at all. ') +
        'Is the selector pointing at an input, a textarea, or a contenteditable? Nothing was written.'
    );
  }

  const selected = await selectElementContents(locator);
  if (!selected) {
    throw new Error(
      'fill could not place a selection over the target element\'s own contents, so it stopped rather than writing ' +
        'over whatever else happened to be selected. The element may be inside a widget that manages its own ' +
        'selection. Nothing was written.'
    );
  }

  // One insertText over the live selection, and no key. See this function's
  // note for what was measured on the live CodeMirror 6 in Acres, for both an
  // empty and a non-empty value.
  const fenced = await installWriteFence(locator as unknown as FenceTarget, true);
  let blocked = false;
  try {
    if (!fenced) {
      throw new Error(
        'fill could not install the guard that keeps a replacement inside the target element, so it stopped rather ' +
          'than writing unguarded. Nothing was written.'
      );
    }
    await page.keyboard.insertText(value);
  } finally {
    blocked = await removeWriteFence(page);
  }

  // The fence cancels rather than lets through, so this is a report of
  // something that did NOT happen: the selection had moved out of the target
  // between being placed and the write being dispatched, and the write was
  // stopped before any handler saw it.
  if (blocked) {
    throw new Error(
      'fill placed a selection over the target element and the page moved it somewhere else before the write ' +
        'landed, so the write was cancelled rather than allowed to replace whatever was selected by then. This is ' +
        'what a page that reasserts its own selection on selectionchange does. The element was not written to, and ' +
        'nothing else was overwritten either. Try again, or set the value through evaluate if the page will not ' +
        'leave a selection alone.'
    );
  }

  return replaceKeylesslyOrFallBack(page, locator, target, value);
}

/**
 * Checks that the keyless replacement actually replaced, and presses a key
 * only when a page has proved it will not accept anything else.
 *
 * A page CAN refuse an insert. `beforeinput` is cancelable, so a handler may
 * preventDefault it and apply its own edit, and one that inserts at the range
 * START without removing the range CONTENTS turns a replacement into a
 * prepend. That is the round-2 append bug, reachable again through a different
 * door, and it is why this function exists rather than the write being trusted
 * because it was dispatched.
 *
 * The retry is gated on the readback being trustworthy, and that gate is the
 * whole design rather than caution. A virtualizing editor renders only what is
 * on screen and a rich-text editor drops every line break, so their textContent
 * disagrees with the requested value most of the time even when the write was
 * perfect. Retrying on that disagreement would press a Delete on every write to
 * exactly the editors this round exists to keep keys away from. So: where the
 * readback can be believed, a mismatch is real and a key is worth pressing;
 * where it cannot, nothing is inferred and no key is pressed.
 *
 * Note which pages this can and cannot reach. It cannot fire on the harmful
 * shape, an inline contenteditable label inside a canvas that deletes nodes on
 * Delete, because a plain contenteditable accepts the insertText and there is
 * no mismatch to retry. Measured: that fixture reads back the requested value
 * with beforeinput insertText as the only event dispatched. It fires on a page
 * that actively rejected the insert, where a key is the only thing left, and
 * the caller is told a key was pressed rather than left to assume none was.
 */
async function replaceKeylesslyOrFallBack(
  page: Page,
  locator: Locator,
  target: TextTargetReport,
  value: string
): Promise<void> {
  // Untrustworthy readback: nothing can be concluded from a comparison, so
  // nothing is. See above.
  if (readbackWarningFor(target) !== null) return;

  const landed = await readFieldValue(page, locator).catch(() => value);
  if (landed === value) return;

  // Not "the readback disagrees", but "the readback disagrees in the specific
  // shape of a refused insert": what was asked for is there, with the old
  // content still hanging off one end of it. A refused insert prepends or
  // appends, so it is one of those two, and an empty value is covered because
  // anything starts with the empty string.
  //
  // The looser test cost a keystroke on writes that had in fact succeeded. A
  // multi-line value is the ordinary case: insertText puts a line break into a
  // contenteditable as a <br>, which textContent does not render as a newline,
  // so "a\nb" reads back as "ab" and compares unequal to a correct write. Under
  // the looser test that pressed a Delete, on a plain contenteditable, which is
  // exactly the element inside a canvas node this round exists to protect.
  if (!landed.startsWith(value) && !landed.endsWith(value)) return;

  // Re-select first: the failed insert has already changed the contents, so
  // the Range placed before it no longer covers them.
  const reselected = await selectElementContents(locator);
  if (!reselected) return;

  const fenced = await installWriteFence(locator as unknown as FenceTarget, true);
  if (!fenced) return;
  try {
    await page.keyboard.press('Delete');
    if (value.length > 0) await page.keyboard.insertText(value);
  } finally {
    await removeWriteFence(page);
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
  readbackWarning?: string | null,
  destination?: WriteDestination | null
): ToolResult {
  const destinationNote = destination?.note;
  const withDestination = (rest: string): string => (destinationNote ? `${destinationNote} ${rest}` : rest);

  // A rich editor's own textContent readback cannot be trusted, so "matched"
  // is not computed at all here: reporting true would be the false pass this
  // whole file exists to avoid, and reporting false would look like a real
  // write failure when the write may well have landed exactly as asked.
  // Neither claim is honest, so neither is made.
  if (readbackWarning) {
    return text({ ...base, value: actual, readbackReliable: false, note: withDestination(readbackWarning) });
  }
  // The same refusal to claim, for the other reason a readback can fail to
  // answer the question: the characters went somewhere the named element does
  // not cover, so comparing that element against the request says nothing
  // about whether the typing worked. The readback itself is still honest, so
  // readbackReliable stays true; it is "matched" that has no answer.
  if (destination && !destination.readbackStillCovers) {
    return text({ ...base, value: actual, readbackReliable: true, note: destination.note });
  }
  if (matched) {
    return text({
      ...base,
      value: actual,
      matched: true,
      readbackReliable: true,
      ...(destinationNote ? { note: destinationNote } : {})
    });
  }
  return text({
    ...base,
    value: actual,
    matched: false,
    readbackReliable: true,
    note: withDestination(
      `The field does not contain what was expected. ${expectation} It now contains ${JSON.stringify(actual)}. ` +
        'The page may have rewritten, truncated or reformatted the input, or the write may have landed somewhere other than the intended element. Trust "value", not the request.'
    )
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
  /**
   * How many elements the selector really matched, absent for a raw x/y
   * endpoint. Reported for the same reason click and hover report it: a
   * selector that matches eleven nodes still resolves, the FIRST one is what
   * gets pressed, and a caller who does not know that reads a perfectly
   * ordinary result as proof the node they meant was the one dragged.
   */
  matchedElements?: number;
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
 * An endpoint whose selector has been waited for and scrolled into view, but NOT yet measured.
 *
 * The split between preparing and measuring exists because of a bug drag had all to itself.
 * drag resolved its source completely, then resolved its target, and resolving the target calls
 * scrollIntoViewIfNeeded, which scrolls the page out from under the source point that was
 * already measured. The gesture then pressed at coordinates that could be thousands of pixels
 * stale. The hit test did catch it, so it was never a false pass, but it reported <html> with
 * containsTarget true and sent the caller hunting for a scrim, never mentioning that the tool's
 * own second endpoint had moved the first.
 *
 * Preparing both endpoints before measuring either one fixes it exactly: every scroll this call
 * is going to perform has already happened by the time any box is read. It cannot be fixed by
 * re-resolving the source afterwards, because that would scroll again and invalidate the target
 * in turn, and two elements far enough apart genuinely cannot both be on screen at once. That
 * case is now reported rather than papered over: see drag's off-screen note.
 */
interface PreparedEndpoint {
  selector?: string;
  offsetX?: number;
  offsetY?: number;
  locator?: Locator;
  matchedElements?: number;
  raw?: { x: number; y: number };
}

/**
 * Waits for one pointer endpoint's selector and scrolls it into view, without measuring it.
 *
 * Three shapes, because a canvas app needs all three: a selector alone means the element's
 * centre, a selector with an offset means a spot inside it (the drag handle in a node's header,
 * not its middle), and a bare x/y means a region of a canvas that is not a DOM element at all
 * and has no selector to name it. Shared by drag and wheel: a wheel has to land on a point too,
 * because a canvas zooms toward the pointer.
 */
async function preparePointerEndpoint(
  page: Page,
  spec: PointerEndpoint,
  tool: string,
  which: string,
  timeout: number
): Promise<PreparedEndpoint> {
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
    return { raw: { x: spec.x as number, y: spec.y as number } };
  }

  const selector = spec.selector as string;
  const all = page.locator(selector);
  // .first(), and not the bare locator, because waitFor, scrollIntoViewIfNeeded and boundingBox
  // are all STRICT MODE: on a selector matching several elements they throw rather than pick
  // one. That throw used to land in the catch below and be rewritten as a timeout, so an
  // ambiguous selector burned the whole endpoint timeout and then handed the caller advice
  // about an element appearing late, which can never help when the element is already there
  // eleven times over. ".react-flow__node" on a canvas with eleven nodes is exactly that shape.
  // Taking the first match is what click and hover already do, so drag and wheel now mean the
  // same thing by the same selector as the rest of this file; the count comes back on the
  // resolved point, and both tools attach a note, so the ambiguity is reported rather than
  // silently resolved.
  const locator = all.first();
  try {
    await locator.waitFor({ state: 'attached', timeout });
    await locator.scrollIntoViewIfNeeded({ timeout });
  } catch {
    throw new Error(
      `${tool} could not resolve its ${which} selector ${JSON.stringify(selector)} within ${timeout}ms. If the element appears late, call wait_for first: ${tool} does not wait for a page to settle.`
    );
  }

  // Counted after the wait, never before: an element that has not attached yet counts zero, and
  // a count taken then would report an ambiguity that does not exist or miss one that does.
  const matchedElements = await all.count().catch(() => undefined);
  return {
    selector,
    locator,
    ...(hasX ? { offsetX: spec.x as number, offsetY: spec.y as number } : {}),
    ...(matchedElements === undefined ? {} : { matchedElements })
  };
}

/**
 * Reads a prepared endpoint's box and turns it into the viewport point the mouse will visit.
 *
 * Deliberately performs no scrolling of its own. Every scroll a call is going to do has
 * happened by the time this runs, so a point measured here is still valid when the mouse
 * reaches it.
 */
async function measurePointerEndpoint(
  prepared: PreparedEndpoint,
  tool: string,
  which: string,
  timeout: number
): Promise<PointerPoint> {
  if (prepared.raw) return { x: prepared.raw.x, y: prepared.raw.y };

  const selector = prepared.selector as string;
  const box = await (prepared.locator as Locator).boundingBox({ timeout }).catch(() => null);
  if (!box) {
    throw new Error(
      `${tool} found the ${which} selector ${JSON.stringify(selector)} but it has no layout box, so there is no point to aim at. It is probably display:none or zero-sized.`
    );
  }

  const point =
    prepared.offsetX === undefined
      ? { selector, x: box.x + box.width / 2, y: box.y + box.height / 2 }
      : { selector, x: box.x + prepared.offsetX, y: box.y + (prepared.offsetY as number) };
  return prepared.matchedElements === undefined ? point : { ...point, matchedElements: prepared.matchedElements };
}

/** Prepare and measure in one step, for a tool with only one endpoint and so nothing to invalidate. */
async function resolvePointerPoint(
  page: Page,
  spec: PointerEndpoint,
  tool: string,
  which: string,
  timeout: number
): Promise<PointerPoint> {
  return measurePointerEndpoint(await preparePointerEndpoint(page, spec, tool, which, timeout), tool, which, timeout);
}

/**
 * How far the flattened-tree walk and the shadow drill are allowed to run.
 *
 * Both are guards against a malformed or hostile tree, NOT expected limits,
 * and both are now high enough that no real document reaches them: the
 * previous walk cap of 200 was reachable (measured: 199 intervening levels
 * passed, 200 failed) by recursive tree UIs and deeply nested rich text, and
 * hitting it produced a confident MISS naming the leaf, with the "an ancestor
 * is on top" remedy that could not possibly apply. A cap that is hit is now
 * reported as an UNKNOWN answer rather than a wrong one, so raising the
 * numbers is a second line of defence rather than the fix.
 */
const HIT_TEST_WALK_CAP = 10000;
const HIT_TEST_DRILL_CAP = 100;

/** How a covering element is named, the same shape element_box's occludedBy uses. */
interface TopmostElement {
  tagName: string;
  id: string;
  classes: string | null;
  /**
   * Whether this element is an ANCESTOR of the one the caller named, in the
   * flattened tree, null when there was nothing named to be an ancestor of.
   *
   * Worth a field of its own because the two shapes need opposite remedies. An
   * unrelated element on top is an overlay: move it, or aim at it instead. An
   * ANCESTOR on top means the point is inside the caller's element's box but
   * outside anything that element actually hit-tests, so the event reaches the
   * ancestor and the element's own listeners never run at all. That is what
   * pointer-events: none, visibility: hidden, a ::before or ::after scrim
   * painted by the ancestor, a clip-path cut-out, and a wrapped inline whose
   * box centre falls between its line boxes all look like from here, and none
   * of them are fixed by changing a z-index.
   *
   * Computed by walking UP the flattened tree from the named element, the exact
   * mirror of the walk that decides matchesTarget, and NOT by Node.contains().
   * contains() does not cross a shadow boundary, so a button inside an open
   * shadow root under its light-DOM wrapper's ::after scrim used to report
   * false here and get the overlay remedy, while the byte-identical light-DOM
   * shape on the same page reported true and got the right one. The verdict was
   * correct in both; only the diagnosis flipped, and only because a shadow root
   * happened to be in the way.
   */
  containsTarget: boolean | null;
  /**
   * Set when the thing that took the event is not in the same document as the
   * element named, because an ancestor FRAME was covered. The remedy is
   * different again: nothing inside the frame can fix it.
   */
  inAncestorFrame?: boolean;
}

/** What a hit test concluded, including the case where it honestly could not conclude. */
interface PointerHit {
  matchesTarget: boolean | null;
  elementAtPoint: TopmostElement | null;
  /**
   * Present only when matchesTarget is null DESPITE a selector having been
   * given, which means a cap was hit and the answer is unknown rather than
   * negative. Kept distinct from the ordinary matchesTarget null (a raw x/y
   * endpoint, which named nothing to check) by that field's presence.
   */
  unknownReason?: string;
}

/**
 * The chain of <iframe> elements from the main frame down to the frame the
 * locator's element actually lives in, outermost first. Empty for the main
 * frame, which is the overwhelmingly common case.
 *
 * This exists because of a coordinate-space bug that made drag and wheel lie
 * in BOTH directions for any iframe not positioned at exactly (0, 0).
 * resolvePointerPoint takes its point from Playwright's boundingBox, which is
 * relative to the MAIN frame's viewport, and the mouse correctly goes to that
 * pixel. The hit test then ran through locator.evaluate, which executes inside
 * the FRAME's document, and handed that main-frame coordinate to the frame's
 * own elementFromPoint. The two spaces differ by the iframe's offset, so an
 * iframe at (0, 100) produced a confident false failure naming the frame's
 * <html>, and an iframe at (60, 40) over a large target produced a false PASS,
 * because the mis-mapped point landed on an uncovered part of the same element
 * while the real press went to a cover the tool never saw. list_frames tells
 * callers to prepend a frame prefix to any selector and drag and wheel accept
 * one, so this was a reachable path rather than a corner.
 *
 * Walking the chain, rather than simply translating the point, also closes a
 * hole that was there before: something in a PARENT document covering the
 * iframe swallows the event before it ever reaches the frame, and a hit test
 * that only ever looks inside the frame cannot see that at all.
 *
 * Costs two round trips on every hit test with a selector, one for the element
 * handle and one for its owning frame, and that is deliberate rather than
 * conditional. The alternative was sniffing the selector string for
 * Playwright's internal enter-frame step, which is the only string form that
 * can reach a subframe today, and making a correctness-critical answer depend
 * on a substring of an internal selector-engine name is exactly the kind of
 * shortcut this round exists to remove.
 */
async function pointerFrameChain(locator: Locator): Promise<ElementHandle[]> {
  const handle = await locator.elementHandle().catch(() => null);
  if (!handle) return [];
  const chain: ElementHandle[] = [];
  try {
    let frame = await handle.ownerFrame();
    while (frame && frame.parentFrame()) {
      const frameElement = await frame.frameElement();
      chain.unshift(frameElement);
      frame = frame.parentFrame();
    }
  } catch {
    // A frame detached mid-walk. Whatever is left is not a usable chain, and
    // guessing from a partial one would be worse than saying nothing.
    for (const entry of chain) await entry.dispose().catch(() => {});
    return [];
  } finally {
    await handle.dispose().catch(() => {});
  }
  return chain;
}

/**
 * Whether a real pointer event at a resolved point would reach the element a caller named, and
 * what would receive it instead when it would not.
 *
 * resolvePointerPoint only ever measures a bounding box: it has no opinion on what is drawn
 * on top of that box, so a selector that used to be safe to press stays "resolved" correctly
 * even after a modal or a loading spinner covers it completely. The mouse still goes to the
 * right coordinates; the coordinates just no longer belong to the element the caller thinks
 * they do. element_box asks the identical question for a plain click target, and shares the
 * identical in-page walk.
 *
 * The test is the browser's own answer, not an approximation of it. A pointerdown at (x, y)
 * dispatches on the deepest node the hit test finds there and then propagates up the FLATTENED
 * tree, so the elements whose listeners run are exactly the elements on that composed path.
 * matchesTarget is therefore "the named element is on the composed path of the true topmost
 * node at this point", built in two steps: drill document.elementFromPoint through open shadow
 * roots to the real deepest node, then climb with assignedSlot first and parentNode second,
 * stepping from a ShadowRoot (nodeType 11) to its host.
 *
 * That encodes an asymmetry which the predicate this replaced had exactly backwards. An
 * ANCESTOR of the hit node is on the path, so a <button> whose centre is painted by its own
 * inline label, or a parent that receives a press because its child is pointer-events: none,
 * both match. A DESCENDANT of the hit node is NOT on the path, and the old code accepted one:
 * it asked hit.contains(el) as well, which meant <body> and <html> matched every selector on
 * the page, and any container an element sits inside counted as a hit on the element. On a
 * React Flow canvas the pane is an ancestor of every node, so a drag endpoint that fell just
 * outside a node landed on the pane and was reported as a clean hit on the node, while the
 * node provably never moved and the pane panned instead.
 *
 * Walking the flattened tree rather than the DOM tree is also what fixes the shadow cases in
 * both directions. Targeting a shadow HOST used to fail: the drill descends past the host into
 * its own shadow content, which is neither the host nor reachable from it by contains(), so the
 * tool named the target's own child as the coverer while the page's listener on the host fired.
 * The host is on the composed path of its shadow content, so it now matches, and no "stop the
 * drill at the target" special case is needed. Slotted content is the same bug from the other
 * side: a shadow-tree wrapper painting around light-DOM children it slots in is on the composed
 * path of a press on those children, but the slotted node's parentNode is the HOST, not the
 * wrapper, so contains() cannot see the relationship in either direction. assignedSlot can.
 *
 * Note that <body> and <html> are on the composed path of every point, so a caller who really
 * does name "body" matches everywhere. That is correct, not a loophole: a press anywhere on the
 * page does run body's listeners. elementAtPoint is filled in whenever the topmost node is not
 * the named element ITSELF, match or no match, so naming "body" with an offset still tells you
 * what is really at that point rather than being strictly less informative than passing the
 * same coordinates raw.
 *
 * A pointer event does not propagate across a frame boundary, so the composed path of an
 * element inside an iframe is bounded by that frame's document. The frame chain above is walked
 * first for exactly that reason: each ancestor frame has to actually receive the event at that
 * point before the question of what happens inside it means anything.
 *
 * A raw x/y endpoint names no element, so there is nothing to compare against: matchesTarget
 * comes back null rather than false, which would read as a failure that was never checked.
 * elementAtPoint is still filled in when something is there, purely as a diagnostic: a canvas
 * drag that silently does nothing is much faster to debug once you know the point actually
 * landed on a debug banner rather than the canvas.
 *
 * The in-page snippet below is deliberately a second copy of element_box's, in inspect.ts,
 * rather than a shared helper: both run under a tsconfig with no dom lib, each against its own
 * minimal element shim, so sharing would cost more than it saves. What is shared is the exact
 * algorithm: the shadow drill, the composed-path walk, the mirrored ancestor walk behind
 * containsTarget, and both caps. What is NOT shared, and must not be assumed to be, is the
 * frame handling: this tool aims a real mouse at a MAIN-frame coordinate and therefore has to
 * verify every ancestor frame on the way down, while element_box measures and hit-tests
 * entirely within one frame's own coordinate space. Each file says so at its own copy.
 */
async function hitTestPointerPoint(page: Page, point: PointerPoint): Promise<PointerHit> {
  if (point.selector === undefined) {
    const elementAtPoint = await page.evaluate((arg: { x: number; y: number; drillCap: number }) => {
      // Drilled the same way the selector branch below is, and for the same reason: without
      // it, a raw point sitting inside a shadow tree would always be reported as the shadow
      // host itself, which is a useless answer for a diagnostic field whose whole point is
      // naming what is really there. Cast rather than declared, per ShadowDrillElement's own
      // comment: document's shared declaration stays PageElement so every other call in this
      // file keeps type-checking against a real HTMLElement.
      let hit = document.elementFromPoint(arg.x, arg.y) as ShadowDrillElement | null;
      let shadowDrillDepth = 0;
      while (hit && hit.shadowRoot && typeof hit.shadowRoot.elementFromPoint === 'function') {
        if (shadowDrillDepth >= arg.drillCap) break;
        const deeper = hit.shadowRoot.elementFromPoint(arg.x, arg.y);
        if (!deeper || deeper === hit) break;
        hit = deeper;
        shadowDrillDepth += 1;
      }
      return hit
        ? { tagName: String(hit.tagName).toLowerCase(), id: hit.id || '', classes: hit.getAttribute('class'), containsTarget: null }
        : null;
    }, { x: point.x, y: point.y, drillCap: HIT_TEST_DRILL_CAP });
    return { matchesTarget: null, elementAtPoint };
  }

  // .first(), because locator.evaluate is strict mode and would throw outright on the same
  // multi-match selector resolvePointerPoint just took the first match of. A fresh locator
  // rather than the one resolvePointerPoint already built: this runs immediately afterwards
  // against the same page, so it resolves to the same element, and reusing it would mean
  // threading a Locator through resolvePointerPoint's return value for every caller that
  // never needs one.
  const locator = page.locator(point.selector).first();

  // Descend the frame chain first, translating the point into each frame's own coordinate
  // space and checking at every level that the event really reaches the next frame down.
  const chain = await pointerFrameChain(locator);
  let local = { x: point.x, y: point.y };
  try {
    for (const frameElement of chain) {
      const step = await frameElement.evaluate(
        (element: unknown, arg: { x: number; y: number; drillCap: number }) => {
          const host = element as FrameHostElement;
          let hit = document.elementFromPoint(arg.x, arg.y) as ShadowDrillElement | null;
          let shadowDrillDepth = 0;
          while (hit && hit.shadowRoot && typeof hit.shadowRoot.elementFromPoint === 'function') {
            if (shadowDrillDepth >= arg.drillCap) break;
            const deeper = hit.shadowRoot.elementFromPoint(arg.x, arg.y);
            if (!deeper || deeper === hit) break;
            hit = deeper;
            shadowDrillDepth += 1;
          }
          // An <iframe> has no rendered light-DOM children of its own, so the only clean
          // answer at this point is the iframe element itself. Anything else, including the
          // frame's own ancestors when something with pointer-events: none is in the way, is
          // the parent document swallowing the event before the frame ever sees it.
          const reaches = (hit as unknown) === (host as unknown);
          const rect = host.getBoundingClientRect();
          const style = window.getComputedStyle(host);
          const scaleX = host.offsetWidth ? rect.width / host.offsetWidth : 1;
          const scaleY = host.offsetHeight ? rect.height / host.offsetHeight : 1;
          // The child document is painted in the iframe's CONTENT box, so the origin is the
          // border box plus border and padding, each scaled the same way the box was.
          const originX = rect.left + ((parseFloat(style.borderLeftWidth) || 0) + (parseFloat(style.paddingLeft) || 0)) * scaleX;
          const originY = rect.top + ((parseFloat(style.borderTopWidth) || 0) + (parseFloat(style.paddingTop) || 0)) * scaleY;
          return {
            reaches,
            x: (arg.x - originX) / (scaleX || 1),
            y: (arg.y - originY) / (scaleY || 1),
            hit: hit
              ? {
                  tagName: String(hit.tagName).toLowerCase(),
                  id: hit.id || '',
                  classes: hit.getAttribute('class'),
                  containsTarget: false,
                  inAncestorFrame: true
                }
              : null
          };
        },
        { x: local.x, y: local.y, drillCap: HIT_TEST_DRILL_CAP }
      );
      if (!step.reaches) return { matchesTarget: false, elementAtPoint: step.hit };
      local = { x: step.x, y: step.y };
    }
  } finally {
    for (const frameElement of chain) await frameElement.dispose().catch(() => {});
  }

  return locator.evaluate(
    (el: PageElement, arg: { x: number; y: number; walkCap: number; drillCap: number }) => {
      // Step one: the true topmost node. document.elementFromPoint retargets to the shadow HOST
      // for anything inside a shadow tree, open or closed, so on its own it never names what is
      // really there. ShadowRoot.elementFromPoint does not retarget, so re-querying the same
      // point against hit.shadowRoot recovers the real node, and repeating it handles shadow
      // roots nested in shadow roots. A closed root reports shadowRoot null, so the drill stops
      // at the host, which is the honest answer: nothing outside can see into a closed root.
      let hit = document.elementFromPoint(arg.x, arg.y) as ShadowDrillElement | null;
      let shadowDrillDepth = 0;
      let truncated = false;
      while (hit && hit.shadowRoot && typeof hit.shadowRoot.elementFromPoint === 'function') {
        if (shadowDrillDepth >= arg.drillCap) {
          truncated = true;
          break;
        }
        const deeper = hit.shadowRoot.elementFromPoint(arg.x, arg.y);
        if (!deeper || deeper === hit) break;
        hit = deeper;
        shadowDrillDepth += 1;
      }
      if (!hit) return { matchesTarget: false, elementAtPoint: null };

      // Step two: climb the flattened tree from that node, which is the path a real pointerdown
      // propagates along, and look for the element the caller named. assignedSlot is tried FIRST
      // and that order matters: a slotted light-DOM node's flattened parent is the <slot> it was
      // distributed into, inside the shadow tree, while its parentNode is the host outside it, so
      // checking parentNode first skips every shadow-tree element that paints around it. The
      // nodeType 11 step is the shadow root itself, which is not an element and has no parent of
      // its own; hopping to its host is what carries the walk back out into the light DOM.
      let matchesTarget = false;
      let node: FlatNode | null = hit as FlatNode;
      let steps = 0;
      while (node) {
        if ((node as unknown) === (el as unknown)) {
          matchesTarget = true;
          break;
        }
        if (steps >= arg.walkCap) {
          truncated = true;
          break;
        }
        node = node.assignedSlot ?? (node.nodeType === 11 ? (node.host ?? null) : (node.parentNode ?? null));
        steps += 1;
      }

      // The mirror walk, UP from the named element, answering whether the thing that took the
      // event is an ancestor of it. Node.contains() was used here and was wrong: it does not
      // cross a shadow boundary, so the identical scrim-over-a-button shape reported one
      // diagnosis in the light DOM and the opposite one inside a shadow root.
      let containsTarget = false;
      if (!matchesTarget) {
        let up: FlatNode | null = el as unknown as FlatNode;
        let upSteps = 0;
        while (up) {
          if ((up as unknown) === (hit as unknown)) {
            containsTarget = true;
            break;
          }
          if (upSteps >= arg.walkCap) {
            truncated = true;
            break;
          }
          up = up.assignedSlot ?? (up.nodeType === 11 ? (up.host ?? null) : (up.parentNode ?? null));
          upSteps += 1;
        }
      }

      const elementAtPoint =
        (hit as unknown) === (el as unknown)
          ? null
          : {
              tagName: String(hit.tagName).toLowerCase(),
              id: hit.id || '',
              classes: hit.getAttribute('class'),
              containsTarget
            };
      // A cap that was actually reached means the walk gave up, not that the element is not
      // there. Reporting that as a confident miss is what produced the "an ancestor is on top"
      // remedy for a tree that simply happened to be deep, so it is reported as unknown.
      if (truncated && !matchesTarget) {
        return {
          matchesTarget: null,
          elementAtPoint,
          unknownReason:
            'The hit test gave up before it could answer: the DOM at this point is nested deeper than the ' +
            'walk is allowed to run, so whether a press here reaches the named element is UNKNOWN rather ' +
            'than known to be false. Nothing here is evidence of an overlay. Aim at a shallower element, ' +
            'or check the page for a runaway nesting loop.'
        };
      }
      return { matchesTarget, elementAtPoint };
    },
    { x: local.x, y: local.y, walkCap: HIT_TEST_WALK_CAP, drillCap: HIT_TEST_DRILL_CAP }
  );
}

/** How `elementAtPoint` is named in a sentence, for the note a mismatched hit test writes. */
function describeElement(el: TopmostElement | null): string {
  if (!el) return 'nothing that elementFromPoint could find';
  const id = el.id ? ` id=${JSON.stringify(el.id)}` : '';
  const classes = el.classes ? ` class=${JSON.stringify(el.classes)}` : '';
  const where = el.inAncestorFrame ? ', in an ancestor frame' : '';
  return `<${el.tagName}${id}${classes}>${where}`;
}

/**
 * The remedy sentence for a missed endpoint, which differs by how the element that took the
 * press is related to the one that was named.
 *
 * An ancestor taking the press is the more confusing of the two, and the more common: the point
 * really is inside the named element's box, so the coordinates look right, but it is outside
 * anything that element hit-tests, so the element's own handlers never run. Telling that caller
 * to change a z-index sends them after an overlay that does not exist.
 */
function missRemedy(el: TopmostElement | null): string {
  if (el?.inAncestorFrame) {
    return (
      'That element is in an ANCESTOR FRAME, not in the same document as the selector: the point never ' +
      'reaches the iframe at all, so nothing inside the frame receives the event and nothing inside the ' +
      'frame can fix it. Something in the parent document is covering the iframe, or the iframe itself is ' +
      'pointer-events: none. Deal with the parent document first.'
    );
  }
  if (el?.containsTarget) {
    return (
      'That element is an ANCESTOR of the selector in the DOM, not an overlay: the point is inside the named element\'s ' +
      'bounding box but outside anything it actually hit-tests, so the ancestor receives the event and the named ' +
      'element\'s own handlers never run. The usual causes are pointer-events: none or visibility: hidden on the ' +
      'element itself, a ::before or ::after painted by the ancestor over it, a clip-path or border-radius cut-out ' +
      'whose box centre falls in the removed part, an inline that wraps so its box centre lands between its line ' +
      'boxes, and an offset that simply falls off the element onto the container behind it. Aim at a point that is ' +
      'really on the element, or name the ancestor if the ancestor is what you meant to press. Changing a z-index ' +
      'will not help.'
    );
  }
  return (
    'Coordinates still went where the box math said, but something else was really on top of the point, which is ' +
    'exactly how a modal, a loading overlay or a sibling drawn later swallows a gesture while the call still looks ' +
    'clean. If that element is meant to be there (a transparent hit-testing overlay over a canvas, say) this is not ' +
    'a failure; otherwise move it out of the way or point the selector at what is really on top.'
  );
}

/**
 * The note an ambiguous endpoint selector earns, empty when there is nothing ambiguous.
 *
 * Shared by drag and wheel so both say the same thing click and hover already say about the
 * same situation, rather than each inventing its own wording for "the first one is what ran".
 */
function multiMatchNote(points: { which: string; point: PointerPoint }[]): string[] {
  return points
    .filter(entry => (entry.point.matchedElements ?? 1) > 1)
    .map(
      entry =>
        `The ${entry.which} selector ${JSON.stringify(entry.point.selector)} matched ${entry.point.matchedElements} elements ` +
        'and the FIRST one was used, the same way click and hover resolve an ambiguous selector. Playwright selectors ' +
        'also pierce open shadow roots, so a positional path can match far more of the page than it looks like it ' +
        'should. Narrow the selector, or add ">> nth=N", if the first match is not the one you meant.'
    );
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
      // A refused step reaches here two ways depending on how Chromium
      // abandons it, a timeout or an outright abort, and both mean the same
      // thing to a caller: the page would not let the step happen. Treated
      // identically rather than one of them escaping as a raw error.
      if (!isTimeoutError(error) && !isAbortedError(error)) throw error;
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
          'How long to keep watching for the page to move itself before measuring it, in milliseconds. Defaults to 500, and that window is real: it is watched in FULL rather than exited as soon as things look quiet, because there is no signal a page can give that it will NOT navigate again, so the only way to know is to watch. A client-side redirect fired inside the window is caught and reported; one fired after it is not. BEFORE YOU LOWER THIS TO SAVE LATENCY, know what you are buying and what you are giving up. Setting it to 0 makes the call as fast as it used to be and makes "status", "ok", "url" and "title" describe the document as of the moment the response arrived, which is the right answer for a static page and the WRONG one for any page that moves itself: a 200 shell that bounces to a login page then reports ok: true beside the shell it was about to discard. Lowering it rather than zeroing it does not remove that risk, it moves it: a redirect timed just past whatever window you choose produces no "pendingNavigation" either, because at the moment the window closes nothing has happened yet and there is nothing to warn about. Raise it instead for an app whose auth bounce waits on a token check or a first fetch, which is easily past 500ms.'
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
        ...(outcome.blocked ? { blocked: true } : {}),
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
          'How long to keep watching for the page to move itself before measuring it, in milliseconds. Defaults to 500, and that window is real: it is watched in FULL rather than exited as soon as things look quiet, because there is no signal a page can give that it will NOT navigate again, so the only way to know is to watch. A client-side redirect fired inside the window is caught and reported; one fired after it is not. BEFORE YOU LOWER THIS TO SAVE LATENCY, know what you are buying and what you are giving up. Setting it to 0 makes the call as fast as it used to be and makes "status", "ok", "url" and "title" describe the document as of the moment the response arrived, which is the right answer for a static page and the WRONG one for any page that moves itself: a 200 shell that bounces to a login page then reports ok: true beside the shell it was about to discard. Lowering it rather than zeroing it does not remove that risk, it moves it: a redirect timed just past whatever window you choose produces no "pendingNavigation" either, because at the moment the window closes nothing has happened yet and there is nothing to warn about. Raise it instead for an app whose auth bounce waits on a token check or a first fetch, which is easily past 500ms.'
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
        ...(outcome.blocked ? { blocked: true } : {}),
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
      'Set a field\'s contents in a session\'s tab, REPLACING whatever was there. Use type instead to append, or to fire per-character events. ' +
      'This DISPATCHES NO KEY EVENT on any ordinary page, whatever the value and whatever the element, and that is worth relying on rather than being an implementation detail. A contenteditable, including a rich editor like CodeMirror or Monaco, gets a Range placed over its own contents and one insertText written over it: no select-all chord, no Delete. A form control with a non-empty value gets Playwright\'s fill, which is itself an insertText. A form control being CLEARED gets its own text selected and an empty insertText, because Playwright\'s own fill("") dispatches a real Delete key while fill("X") dispatches none, and that asymmetry is how clearing an inline rename input inside a canvas deleted the canvas node. An input the browser renders as a picker rather than as text (date, time, colour, range) is set by assignment, also without a key. ' +
      'The reason this matters: a key event reaches every ancestor listening for it, in both the capture and the bubble phase, and an application that treats Delete as "remove the selected thing" will act on a Delete aimed at a text field inside it. That is not preventable once the key is dispatched, so it is not dispatched. ' +
      'ONE CASE STILL PRESSES A KEY, and it is named here rather than left implied. `beforeinput` is cancelable, so a page can refuse the insert and apply its own edit, and one that inserts at the selection START without removing the selection CONTENTS turns a replacement into a prepend. Where the readback can be believed and it disagrees with what was asked for, that is what happened, so a real Delete is pressed once and the replacement is retried. It cannot fire on the shape that loses data, because an ordinary contenteditable accepts the insertText and there is nothing to retry, and it is deliberately not attempted at all on a virtualizing or rich-text editor, whose readback disagrees with the requested value most of the time even when the write was perfect. ' +
      'Replacement also cannot reach outside the element you named: an insertText over a Range replaces exactly that Range. Verified on a contenteditable holding three spans with only the middle one selected, which read back with the outer two intact. ' +
      'The selector still has to name an element that can hold typed text AND own the region a replacement would cover, and both are checked before anything is written, because a selection is scoped by the browser: to a form control\'s own value, or to the whole contenteditable EDITING HOST, never to whatever element you happened to name. So this accepts a text-holding input, a textarea, or an element that is itself a contenteditable root. It refuses an element that merely SITS INSIDE an editable region, because isContentEditable is inherited and a replacement there can take the whole region: measured on a page whose canvas sat inside one, a clear took it from three nodes and 91 characters to one node and 14. The refusal names the host so you can decide whether you meant it. It also refuses <body> and <html> even on a contenteditable or designMode page, a <select> (use select_option), a checkbox, radio, button or file input (click, or file_upload), a readonly or disabled control (said at once rather than after the full timeout), and a selector matching several elements. A selector matching nothing is waited for the way Playwright waits for any selector and then explained, saying what it measured and when. ' +
      'A page that reasserts its own selection can still move it between the Range being placed and the write being dispatched. That window is checked inside the dispatch rather than before it, so when it happens the write is cancelled before any handler sees it and this says so, rather than writing somewhere else and reporting success. ' +
      'Reads the field back afterwards, but that readback is DOM textContent, which two families of editor defeat in different ways. Virtualizing code editors (Monaco, CodeMirror 5 and 6, Ace) keep only the lines currently on screen in the DOM, so a long document reads back truncated, with no newlines, and can carry gutter line numbers or a hidden measurement layer along with the text. Rich-text editors (Quill, ProseMirror, TipTap, Slate, Lexical) render everything and lose every line break, and anything that is not text contributes nothing at all. An element with an EditContext attached keeps its real text outside the DOM entirely. All of these markers are looked for at the named element, above it (out through any open shadow root), and ANYWHERE in its subtree, because a selector aimed at a wrapper is the ordinary case and how far above the editor it sits is not the question: whether the text about to be read back contains an editor\'s render is. When the target is one of these the result says so plainly: "readbackReliable" is false, "matched" is not claimed either way, and "note" names the editor\'s own API to read the value through instead. For an ordinary field the result carries "value" (what the field really contains now), "matched", "readbackReliable": true, and a "note" explaining the difference when value and the request disagree.',
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
      const matchedAtStart = await assertSingleWriteTarget('fill', locator, args.selector);
      // Everything that touches the selector runs inside this, so a selector
      // that matches nothing produces the same explanation hover gives rather
      // than a raw Playwright TimeoutError thrown out of a readback. Our own
      // refusals are ordinary Errors and pass straight through untouched.
      //
      // `wrote` is tracked because the explanation used to end "Nothing was
      // written" unconditionally, and a failure can arrive AFTER the write: a
      // clear that destroyed the element the locator pointed at made the
      // readback time out, and the caller was told nothing had happened to a
      // page that had just been emptied.
      const startedAt = Date.now();
      let wrote = false;
      try {
        await setFieldValue(target.page, locator, args.value);
        wrote = true;
        const actual = await readFieldValue(target.page, locator);
        const readbackWarning = await readReadbackReliability(target.page, locator);
        return writeResult(
          { pageId: target.pageId, selector: args.selector, requested: args.value },
          actual,
          actual === args.value,
          `Expected exactly ${JSON.stringify(args.value)}.`,
          readbackWarning
        );
      } catch (err) {
        throw await selectorActionFailure(
          'fill',
          target.page,
          args.selector,
          err,
          Date.now() - startedAt,
          'Nothing was written.',
          matchedAtStart,
          wrote
        );
      }
    }
  }),

  type: defineTool({
    serializesInput: true,
    description:
      'Type text into a session\'s tab character by character, with real key events, so per-character handlers, debounces, autocomplete and anything firing on a keystroke actually run. fill sets the value in one step and cannot exercise those. Does NOT clear the field first: it inserts at the caret, which is what a user typing does, so calling it twice types twice. Pass clear: true to replace the contents instead. Where the caret sits is the browser\'s call, not this tool\'s: focusing an input puts it after the existing text, focusing a contenteditable puts it before, so click the spot first if the insertion point matters. ' +
      'THIS IS THE TOOL THAT PRESSES KEYS, and it is worth knowing exactly which. The characters of "text" go out as real keydown/keyup pairs, so they reach every ancestor listening for a keystroke, in the capture phase as well as the bubble phase, and nothing can stop that: capture reaches an ancestor before the event reaches the field at all. If the application binds a bare letter as a shortcut, typing that letter into a field inside it will fire the shortcut. That is what "real key events" means and it is usually what you want. What is NOT dispatched any more is a Delete: clear: true empties the field with a selection and an insertText, dispatching no key at all, so an application that treats Delete as "remove the selected thing" no longer sees one. The single exception is a page that cancels the insert and applies its own edit, where one Delete is pressed and the clear retried: see fill, which does the clearing. press_key is the tool for pressing anything else, and the same capture-phase reasoning applies to it. ' +
      'With no selector the keystrokes go to whatever currently has focus, and this refuses unless that element can actually HOLD typed text: a text-holding input, a textarea, or a contenteditable root. Taking focus is not the same as taking text, and the difference is destructive. React Flow gives canvas nodes tabindex="0" so they can handle arrow keys, so an ordinary click on an Acres node leaves focus on a plain <div>; typing into it does not go where you meant. Reading that same <div> back returns its rendered text and inline CSS rather than any field\'s value. ' +
      'clear: true is refused outright when the caret sits in a contenteditable EDITING REGION rather than a form control, because with no selector nothing named what is about to be replaced and the region can be an entire document. Note that clicking a widget inside such a region focuses the REGION, not the widget: on a page whose canvas sat inside one this took it from three nodes and 91 characters to one node and 14. The message names the region, so passing it as "selector" is all the retry needs. Typing without clear is unaffected, since an insertion has no blast radius. The caret holder is resolved through open shadow roots, because document.activeElement reports the shadow HOST rather than the element that really has focus. A selector matching several elements is refused too, since choosing one of them would change the page, and one matching NOTHING is waited for and then explained rather than surfacing as a bare Playwright timeout. ' +
      'With a selector, this does NOT refuse a target that cannot hold text, because routing real keystrokes at a focused widget is a legitimate thing to want and press_key alone does not cover it. What it will not do is let you believe the characters went where you aimed them. Playwright focuses the located element and then types at whatever holds the caret, so when the focus attempt does not land the text goes somewhere else entirely: the caret holder is compared against the named element before a single character is sent, and when they differ the result names the element that really received the text and does not claim "matched", since reading back an element nothing was typed into answers a different question. ' +
      'Reads the field back afterwards, but that readback is DOM textContent, which virtualizing code editors (Monaco, CodeMirror 5 and 6, Ace) defeat by rendering only what is on screen, and rich-text editors (Quill, ProseMirror, TipTap, Slate, Lexical) defeat by losing every line break and every non-text node. An element with an EditContext attached keeps its real text outside the DOM entirely. Those markers are looked for at the target, above it (out through any open shadow root) and anywhere in its subtree, so a wrapper any distance above the editor root is still recognised. When the target is one of these the result says so plainly: "readbackReliable" is false, "matched" is not claimed either way, and "note" names the editor\'s own API to read the value through instead. For an ordinary field the result carries "value" (what the field really contains now), "previousValue" (what it held BEFORE the call, clear included, so a clear cannot throw something away invisibly), "matched", "readbackReliable": true, and a "note" when what landed is not the typed text inserted into what was already there.',
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
      let matchedAtStart: number | undefined;
      if (locator !== null && args.selector !== undefined) {
        matchedAtStart = await assertSingleWriteTarget('type', locator, args.selector);
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
        // Said precisely here rather than left to the selection step below,
        // which can only report that it could not place one: a readonly or
        // disabled control is a fact about the page worth naming.
        if (holder.readOnly || holder.disabled) {
          throw new Error(
            `type cannot write into ${describeTextTarget(holder)}, the element that currently has focus: it is ` +
              `${holder.disabled ? 'disabled' : 'readonly'}, so no keystroke will change it. That is a finding ` +
              'about the page, not about this call. Nothing was typed' +
              (args.clear ? ' and nothing was cleared.' : '.')
          );
        }

        // A no-selector CLEAR on an editing host is refused even though the
        // host can genuinely receive text, and this is the case that looks
        // safe and is not.
        //
        // READ THIS BEFORE CHANGING THE GUARD, because the evidence points at
        // the wrong cause and two rounds of review derived it wrongly from
        // exactly these symptoms. Clicking a widget inside a contenteditable
        // region does NOT focus the widget, even one carrying tabindex="0".
        // Chromium focuses the REGION, so document.activeElement is the
        // editing host itself. That means canReceiveText was answering
        // correctly here: the caret really was on an element that owns its own
        // editing region. The isContentEditable-is-inherited bug is real, it
        // is fixed, and it is a DIFFERENT bug: it is what let a write aimed at
        // a widget by SELECTOR destroy the surrounding region. It is not what
        // made this no-selector path destructive.
        //
        // What makes this path destructive is narrower and has nothing to do
        // with which element got focus: with no selector, nothing named the
        // region about to be emptied. Measured on a page whose canvas sat
        // inside one: three nodes and 91 characters before the call, one node
        // and 14 after, reported as matched: true.
        //
        // So the rule that decides this is the same one fill uses, applied
        // where there is no selector: a deletion may only be aimed at a region
        // the caller actually named, and with no selector the caller named
        // nothing while the region can be an entire document. A focused input
        // or textarea is exempt because its region is its own value, which is
        // bounded and is what "the focused field" plainly means. The message
        // names the host, so the retry is one argument away. Do not try to
        // narrow this by asking whether the region "looks large", or holds
        // other focusable widgets, or is body: that is the same fudge factor
        // the level budget was, and it failed for the same reason.
        if (args.clear && !formControlTags.includes(holder.tag) && holder.isEditingHost) {
          throw new Error(
            `type will not clear ${describeTextTarget(holder)} without being told to: it is a contenteditable ` +
              'editing region, not a field, and with no selector nothing named it. Clearing it deletes everything ' +
              'inside it, which on a page that puts widgets inside an editable region is far more than the field ' +
              'that looks focused. Note that clicking a widget inside such a region focuses the REGION, not the ' +
              `widget. Pass selector: ${JSON.stringify(cssPathHint(holder))} if clearing the whole region is what ` +
              'you meant, or name the specific field. Nothing was typed and nothing was cleared.'
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
                ? ' With clear: true there is nothing here that scopes what would be replaced: with no selector ' +
                  'nothing named the field, and a widget holding focus does not own an editing region of its own, so ' +
                  'the region is whatever the browser decides, up to the whole document. Naming the field is what ' +
                  'bounds it.'
                : ' Reading it back would return its rendered text and inline CSS rather than any field\'s value.') +
              ' Pass "selector" to name the field, or click into the field itself first. Nothing was typed' +
              (args.clear ? ' and nothing was cleared.' : '.')
          );
        }
      }

      // Everything from here on touches the selector, so a selector matching
      // nothing gets the same explanation hover gives instead of a raw
      // Playwright TimeoutError. Our own refusals are ordinary Errors and pass
      // through untouched, and the no-selector path has no selector to explain.
      const startedAt = Date.now();
      let wrote = false;
      try {
        // Read BEFORE the clear, so "previousValue" means what its name says.
        // Read after, it was always the emptied field on a clearing call, which
        // also made "matched" a comparison against nothing: it could not fail,
        // whatever the clear had just destroyed.
        const before = await readFieldValue(target.page, locator);

        if (args.clear) {
          wrote = true;
          if (locator) {
            await setFieldValue(target.page, locator, '');
          } else {
            // No key is pressed here, and that is the point. This path used to
            // press Delete itself, which made it destructive while the SAME
            // clear on the SAME element was safe with a selector. Measured on
            // a canvas whose nodes hold an inline rename input, with an
            // ordinary canvas-level Delete handler: the node was removed, and
            // the result carried previousValue "two" and the whole page's text
            // as "value", blaming the page for rewriting the input.
            //
            // Handing it to Playwright's fill was not the answer either, and
            // that is Finding 2: fill('') dispatches a real Delete of its own.
            // It goes through the same select-then-insertText clear the
            // selector path uses, which was measured to dispatch no key at
            // all. See clearOrFillFormControl.
            //
            // The handle comes from the same shadow-piercing descent
            // readFieldValue uses, so a control inside an open shadow root is
            // cleared rather than its host.
            const focusedHandle = await target.page.evaluateHandle(() => {
              let el = document.activeElement as TreeWalkElement | null;
              for (let hops = 0; hops < 32; hops += 1) {
                const inner = el?.shadowRoot?.activeElement;
                if (!inner) break;
                el = inner;
              }
              return el;
            });
            // Cast because the handle's generic comes from the callback's own
            // return type, which is this file's hand-rolled element interface
            // rather than a real Element, so asElement() cannot narrow to
            // anything useful on its own.
            const focusedElement = focusedHandle.asElement() as unknown as ClearableField | null;
            try {
              if (!focusedElement) {
                throw new Error(
                  'type could not resolve the focused element to clear it, so it stopped rather than clearing ' +
                    'something it could not identify. Nothing was typed and nothing was cleared.'
                );
              }
              await clearOrFillFormControl(target.page, focusedElement, '', 'type');
            } finally {
              await focusedHandle.dispose();
            }
          }
        }

        // What the field holds going into the typing: the same as `before` on an
        // ordinary call, and the emptied field on a clearing one. The insertion
        // check runs against this, while the caller is shown `before`.
        const baseline = args.clear ? await readFieldValue(target.page, locator) : before;
        const options = args.delay !== undefined ? { delay: args.delay } : undefined;

        // The focus attempt is made HERE rather than left to
        // pressSequentially, which does it silently, so that where the caret
        // really ended up can be compared against the element the caller named
        // before a single character is sent. pressSequentially focuses again
        // straight after, which is a no-op on an element that already has
        // focus and lands in the same place on one that does not.
        let beforeTyping: TextTargetInspection | null = null;
        if (locator) {
          await locator.focus().catch(() => undefined);
          beforeTyping = await inspectTarget(target.page, locator);
        }

        wrote = true;
        if (locator) {
          await locator.pressSequentially(args.text, options);
        } else {
          await target.page.keyboard.type(args.text, options);
        }

        // Checked again AFTER the characters, not only before them. A page
        // that moves focus partway through a slow type sends the rest of the
        // keystrokes somewhere else, which the before-check cannot see:
        // measured with delay: 10, "ab" landed in the named field and "cdef"
        // in another one, reported as matched: false blaming the page for
        // rewriting the input.
        const destination =
          locator && beforeTyping ? typingDestination(beforeTyping, await inspectTarget(target.page, locator)) : null;

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
          readbackWarning,
          destination
        );
      } catch (err) {
        if (args.selector === undefined) throw err;
        throw await selectorActionFailure(
          'type',
          target.page,
          args.selector,
          err,
          Date.now() - startedAt,
          'Nothing was typed.',
          matchedAtStart,
          wrote
        );
      }
    }
  }),

  press_key: defineTool({
    serializesInput: true,
    description:
      'Press a key in a session\'s tab, dispatching a real trusted key event. This is the only way to establish keyboard modality, which matters for accessibility checks: Chrome will not set :focus-visible on a button a script focused with .focus(), so a focus ring measured after a programmatic focus reports absent even when it is perfectly fine for a real user pressing Tab. Key syntax is Playwright\'s: Tab, Enter, Escape, ArrowDown, Backspace, a, Control+A, Shift+Tab. With no selector the key goes to whatever currently has focus. Returns where focus ended up and whether that element matches :focus-visible, descending into OPEN shadow roots to get there: document.activeElement retargets to the shadow HOST, so a key press into an editor inside a shadow root would otherwise be reported as focus sitting on a plain host div with no text. "inShadowRoot" is true when the walk crossed a boundary to find the element. ' +
      'The key reaches EVERY ancestor of the focused element, not just the element itself, and in the capture phase before it reaches the element at all. That is the DOM\'s dispatch order and nothing here can narrow it. So a Delete pressed while a text field inside a canvas has focus is also a Delete delivered to the canvas, and an application that treats it as "remove the selected node" will remove one. This tool presses what you name and reports where it landed; it does not and cannot bound what else hears it. If the intent is to change a field\'s contents rather than to exercise a key handler, use fill or type with clear: true, which replace text with a selection and an insertText and dispatch no key at all. ' +
      'One limit worth knowing, because it is the single case this field can be wrong: focus inside a CLOSED shadow root reports the HOST, not the element that actually received the key, and "inShadowRoot" reads false. A closed root is invisible to page JavaScript, and a host holding focus itself is indistinguishable from a host whose closed root holds it, so the case cannot be flagged rather than misreported. Read "inShadowRoot": false as "no open shadow boundary was crossed", not as "focus is not in a shadow root". If a page uses closed roots and it matters which element took the key, send_cdp_command can see inside them: DOM.getDocument with pierce: true, or Accessibility.getFullAXTree, whose nodes carry a "focused" property and a backendDOMNodeId to resolve with DOM.describeNode. That is deliberately not done here, because it costs an accessibility-tree query on every press, measured at about 10ms against 2ms for this call as it stands, on a field that reports where focus is rather than making a claim about text.',
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

      // The REPORT descends into open shadow roots, for the same reason
      // readFieldValue does: document.activeElement retargets to the shadow
      // HOST, so a key press into an editor inside a shadow root used to be
      // reported as focus sitting on a plain host <div> with empty text, while
      // the element that actually received the keystroke was invisible to the
      // result. The note's firing logic below is untouched and does not depend
      // on this: it reads the chord, not the page.
      const activeElement = await target.page.evaluate(() => {
        let el = document.activeElement as TreeWalkElement | null;
        let crossed = false;
        for (let hops = 0; hops < 32; hops += 1) {
          const inner = el?.shadowRoot?.activeElement;
          if (!inner) break;
          el = inner;
          crossed = true;
        }
        if (!el) return null;
        return {
          tag: el.tagName.toLowerCase(),
          id: el.id,
          text: (el.textContent ?? '').trim().slice(0, 80),
          focusVisible: el.matches(':focus-visible'),
          inShadowRoot: crossed
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
      // The wait is kept; only the explanation is added. fill and type route
      // through the same helper, so there is one wording to keep honest.
      const startedAt = Date.now();
      try {
        await target.page.hover(args.selector, position ? { position } : undefined);
      } catch (err) {
        throw await selectorActionFailure(
          'hover',
          target.page,
          args.selector,
          err,
          Date.now() - startedAt,
          'The pointer was not moved.',
          matchedElements,
          false
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
      'A resolved selector is only a bounding box, and a box says nothing about what is drawn on top of it, so BOTH endpoints are hit-tested before the mouse ever moves, with the same test element_box runs for a plain click target. The question it answers is the one that matters: would a real pointerdown at these coordinates reach the element you named? A pointerdown dispatches on the deepest node at the point and propagates up the FLATTENED tree, so matchesTarget is "the named element is on the composed path of whatever is really topmost there". sourceHit and targetHit each carry it (null for a raw x/y endpoint, which names nothing to compare against) alongside elementAtPoint, which names what really received the press whenever that is not a match. ' +
      'Read the asymmetry carefully, because it is easy to get backwards and this tool used to have it backwards: an ANCESTOR of the element that took the press is on the composed path and MATCHES (a <button> whose centre is painted by its own inline label, or a parent that receives the press because its child is pointer-events: none), while a DESCENDANT of it is NOT and does not. So a drag endpoint that falls just outside a canvas node and lands on the pane behind it is a MISS, not a hit on the node, even though the pane contains the node. Note that <body> and <html> are on the composed path of every point, so a selector naming "body" matches everywhere, correctly: a press anywhere really does run body\'s listeners. When elementAtPoint is an ancestor of your selector it says so with "containsTarget": true, because that is a different diagnosis from an overlay and needs a different remedy: the point is inside your element\'s box but outside anything it hit-tests, which is what pointer-events: none, visibility: hidden, a ::before or ::after scrim on a wrapper, a clip-path cut-out, a wrapped inline, or an offset that simply falls off the element all look like. Changing a z-index will not help any of those. ' +
      'Shadow DOM is handled by the same walk, in both directions: an endpoint inside an open or closed shadow root that is genuinely unoccluded matches rather than reading as occluded by its own host; a shadow HOST matches when the press lands on its own shadow content, because the host is on that content\'s composed path; a shadow-tree wrapper matches when the press lands on light-DOM children slotted into it; and a real overlay sitting on top of a target INSIDE THAT SAME shadow root is still caught and named. When a selector\'s point does not reach its own element the top-level result carries "matched": false and a "note" naming the endpoint, what took the press, and what to do about it, so a press that silently lands on a modal, a loading overlay or the container behind a node cannot read as a normal drag. This does NOT throw for a missed endpoint: a canvas point deliberately under a transparent hit-testing overlay is a real drag, so check "matched" rather than assuming a resolved call pressed what it was asked to. ' +
      'elementAtPoint is filled in whenever the topmost node is not the named element ITSELF, on a match as well as on a miss, so naming "body" with an offset tells you exactly as much about that point as passing the same coordinates raw would. "matched" is true, false, or NULL: null means the hit test could not answer, not that it passed, which currently happens only when the DOM at that point is nested deeper than the walk is allowed to run. A note always says which. ' +
      'A frame-prefixed selector from list_frames is fully supported and hit-tested in the MAIN frame\'s coordinate space, which is where the mouse actually goes. Every ancestor frame is checked on the way down, because a pointer event cannot cross a frame boundary: if something in a PARENT document covers the iframe, the press never reaches the frame at all, and that is reported with elementAtPoint carrying "inAncestorFrame": true and a note saying nothing inside the frame can fix it. ' +
      'Both endpoints are waited for and scrolled into view BEFORE either is measured, because resolving one endpoint scrolls the page and would otherwise leave the other one\'s coordinates stale. When the two cannot be on screen at the same time, which no single mouse gesture can do, the result says exactly that rather than letting the hit test blame an overlay at a clamped point. ' +
      'Neither endpoint selector has to be unique. Like click and hover, a selector matching several elements resolves to the FIRST one and no error is raised; the resolved source and target each carry "matchedElements", with a note whenever it is more than one. That is worth knowing before you read a result: ".react-flow__node" on a canvas with eleven nodes resolves happily to whichever one is first in the DOM. ' +
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
      // BOTH endpoints are waited for and scrolled into view BEFORE either is measured.
      // Resolving an endpoint scrolls it into view, and scrolling moves everything else on the
      // page, so measuring the source and then resolving the target used to leave the source
      // point stale by however far the page scrolled. Measured at 2320px stale in one case: the
      // press landed on <html> and the note blamed a scrim, never mentioning that this call's
      // own second endpoint had moved the first.
      const sourcePrepared = await preparePointerEndpoint(target.page, args.source, 'drag', 'source', timeout);
      const targetPrepared = await preparePointerEndpoint(target.page, args.target, 'drag', 'target', timeout);
      const from = await measurePointerEndpoint(sourcePrepared, 'drag', 'source', timeout);
      const to = await measurePointerEndpoint(targetPrepared, 'drag', 'target', timeout);

      // Two elements far enough apart genuinely cannot both be on screen at once, and no
      // ordering of the resolution fixes that: it is a real property of the gesture being
      // asked for. Naming it here is the difference between a caller seeing the actual cause
      // and chasing the phantom overlay the hit test is about to report at a clamped point.
      const viewport = target.page.viewportSize();
      const offScreen = viewport
        ? (['source', 'target'] as const).filter(which => {
            const point = which === 'source' ? from : to;
            return point.x < 0 || point.y < 0 || point.x >= viewport.width || point.y >= viewport.height;
          })
        : [];

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
      // An endpoint whose hit test gave up is UNKNOWN, not clean. Folding it into the true
      // branch of "matched" would turn "we could not tell" into "it landed correctly", which is
      // the exact shape of unearned confidence this tool exists to avoid.
      const unknown = (['source', 'target'] as const).filter(
        which => (which === 'source' ? sourceHit : targetHit).unknownReason !== undefined
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
      notes.push(...multiMatchNote([{ which: 'source', point: from }, { which: 'target', point: to }]));
      if (offScreen.length > 0) {
        notes.push(
          `The resolved ${offScreen.join(' and ')} point is outside the viewport, so the mouse could not actually ` +
            'visit it. Both endpoints were scrolled into view before either was measured, so this is not a stale ' +
            'coordinate: it means the two endpoints cannot be on screen at the same time, which no single mouse ' +
            'gesture can do. Scroll or zoom so both are visible, drag in stages, or use raw x/y coordinates for a ' +
            'point you know is on screen. Whatever the hit test reports for that endpoint is about a clamped point ' +
            'rather than the element.'
        );
      }
      for (const which of unknown) {
        notes.push(`At ${which}: ${(which === 'source' ? sourceHit : targetHit).unknownReason}`);
      }
      if (mismatched.length > 0) {
        notes.push(
          `The press did not land on the ${mismatched.join(' or ')} selector's own element: ` +
            mismatched
              .map(which => `at ${which}, ${describeElement((which === 'source' ? sourceHit : targetHit).elementAtPoint)} received it instead`)
              .join('; ') +
            '. ' +
            // Deduplicated: both endpoints missing for the same reason would otherwise print the
            // same paragraph of advice twice in one note.
            Array.from(new Set(mismatched.map(which => missRemedy((which === 'source' ? sourceHit : targetHit).elementAtPoint)))).join(' ')
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
        ...(anySelectorGiven ? { matched: mismatched.length > 0 ? false : unknown.length > 0 ? null : true } : {}),
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
      'Resolving "point" only measures a box, it says nothing about what is drawn on top of it, and mouse.wheel dispatches at raw coordinates with none of Playwright\'s own actionability checks in the way, so the point is hit-tested before the event fires, with the same test drag and element_box run. It answers whether a real pointer event at those coordinates would reach the element named, by checking that element against the COMPOSED PATH of whatever is really topmost at the point. "pointHit" carries matchesTarget (null when point has no selector, which names nothing to compare against) and elementAtPoint, naming what really received the event whenever that is not a match. ' +
      'The asymmetry is the part to read carefully: an ANCESTOR of the element that took the event is on the composed path and matches, a DESCENDANT of it is not. A wheel aimed at a point that falls outside a scroll container and onto the pane behind it is therefore a MISS, not a hit on the container, even though the pane contains it. That combination, a clean-looking hit with nothing scrolled, is exactly what a canvas zoom looks like, so getting it wrong lets a dead wheel be explained away as a zoom. When elementAtPoint is an ancestor of your selector it says so with "containsTarget": true, which means the point is inside your element\'s box but outside anything it hit-tests (pointer-events: none, a pseudo-element scrim on a wrapper, a clip-path cut-out, or an offset that falls off the element): a z-index change will not fix any of those. Shadow DOM is handled in both directions, so an unoccluded element inside an open or closed shadow root matches, a shadow host matches when the event lands on its own shadow content, and a real overlay inside the same shadow root is still caught and named. "scroll" is drilled the same way: a scrollable container that lives inside a shadow root is found and reported on, not just the shadow host\'s own ancestors. When a selector\'s point does not reach its own element the result carries "matched": false and a "note" naming what took the event and what to do about it. This does NOT throw for a missed point: a canvas point deliberately under a transparent hit-testing overlay is a real target, so check "matched" rather than assuming a resolved call landed where it was aimed. ' +
      'A frame-prefixed selector from list_frames is hit-tested in the MAIN frame\'s coordinate space, which is where the event actually goes, and every ancestor frame is checked on the way down: a pointer event cannot cross a frame boundary, so something in a PARENT document covering the iframe means the wheel never reaches the frame at all, reported with "inAncestorFrame": true. "matched" is true, false, or NULL, where null means the hit test could not answer rather than that it passed. ' +
      'Waits for a real renderer round trip after dispatching, so by the time this returns the page has run its own wheel handlers. Without that the readback could observe a page that had not yet seen the event, which was invisible whenever something DID scroll and wide open whenever nothing did. ' +
      'The point\'s selector does not have to be unique. Like click and hover, a selector matching several elements resolves to the FIRST one with no error; the resolved point carries "matchedElements", with a note whenever it is more than one. Does NOT dispatch a pinch gesture, a touch event, or a smooth scroll animation of its own.',
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

      // Chromium returns from the CDP wheel dispatch BEFORE the renderer has necessarily run
      // the page's own listeners, so reading straight back can observe a page that has not yet
      // seen the event. Measured directly with a probe that bypassed this tool: the listener
      // was still unfired in 2 of 20 trials at idle and 3 of 150 under load. What used to hide
      // it is readSettledScrollState's sleep(25) poll, and only by accident: when nothing on
      // the page is scrollable its first two reads agree immediately and it returns without
      // ever sleeping, so the mask is exactly one 25ms tick with no structural relationship to
      // event delivery. Two chained animation frames are a real renderer round trip, so this
      // waits for the thing that actually matters instead of for a duration that usually
      // covers it. Swallowed on failure because a gesture that navigated the page away has no
      // renderer left to wait for, and that is not a wheel failure.
      await target.page
        .evaluate(() => new Promise<void>(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve()))))
        .catch(() => {});

      const after = await readSettledScrollState(target.page, point.x, point.y);
      const moved = !sameScrollState(before, after);

      // Two independent things can each want a note (the point missing its own element, and
      // a scroll that did not move), and joined into a list rather than each being a separate
      // spread with its own "note" key for the same reason drag's notes are: two literal
      // `note:` spreads back to back would let the second one silently overwrite the first.
      const notes: string[] = [];
      notes.push(...multiMatchNote([{ which: 'point', point }]));
      if (pointHit.unknownReason !== undefined) {
        notes.push(pointHit.unknownReason);
      }
      if (pointHit.matchesTarget === false) {
        notes.push(
          `The wheel event did not land on the point's own selector's element: ${describeElement(pointHit.elementAtPoint)} received it instead, ` +
            'so the wheel scrolled or zoomed whatever that element is rather than the one named. ' +
            missRemedy(pointHit.elementAtPoint)
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
        ...(point.selector !== undefined
          ? { matched: pointHit.matchesTarget === false ? false : pointHit.unknownReason !== undefined ? null : true }
          : {}),
        ...(notes.length > 0 ? { note: notes.join(' ') } : {})
      });
    }
  })
});
