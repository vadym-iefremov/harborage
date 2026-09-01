import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Frame, Locator, Page } from 'playwright';
import * as z from 'zod/v4';

import { sessionCacheDir } from '../../screenshotCache.js';
import { parseCssColor, type ParsedCssColor, type Rgba } from '../color.js';
import { compileNetworkMatch, matchesNetworkEntry } from '../../networkMatch.js';
import type { NetworkEntry } from '../../sessions.js';
import { defineTool, defineTools, text, type ToolResult } from '../types.js';
import { clear, pageId, sessionId } from './common.js';

/** How long a `selector` capture waits for its element before giving up. */
const defaultSelectorTimeoutMs = 5_000;

/** How long `evaluate` waits for an expression to settle before abandoning it. */
const defaultEvaluateTimeoutMs = 30_000;

const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * The capture's real size, read out of the PNG rather than out of what was
 * asked for.
 *
 * That distinction is the whole point. A CDP viewport override can change
 * what the page thinks its size is without changing what a capture actually
 * contains, and an agent comparing its request against its own request will
 * never see the difference. A PNG's IHDR is always the first chunk, so width
 * and height sit at fixed byte offsets 16 and 20 as big-endian uint32s.
 */
export function pngDimensions(buffer: Buffer): { width: number; height: number } {
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(pngSignature)) {
    throw new Error('not a PNG: the buffer does not begin with a PNG signature followed by an IHDR header');
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/**
 * Playwright dims its call log with ANSI escape codes, on the assumption that
 * a message ends up in a terminal. These end up in an agent's transcript
 * instead, where they are noise at best, so they come off here.
 */
const ansiEscape = new RegExp('\\u001b\\[[0-9;]*m', 'g');

/**
 * CDP domains Chromium routes to the BROWSER rather than to the tab a page
 * session is attached to, and which therefore reach straight past session
 * isolation.
 *
 * Measured against real Chromium rather than assumed. From an ordinary
 * page-scoped CDP session, one harborage session could:
 * - `Target.getTargets`: list every other session's tabs, with their URLs,
 *   titles and browserContextIds.
 * - `Target.closeTarget`: close another session's only tab, leaving that
 *   session alive but unusable by every tool that resolves a pageId.
 * - `Target.createTarget` with another session's browserContextId: open a
 *   tab INSIDE that session, which harborage then adopts and makes active,
 *   so the victim's next call that omits pageId runs in a tab an unrelated
 *   agent opened.
 * - `Browser.close`: terminate the single shared Chromium, destroying every
 *   session on the machine.
 *
 * Everything else stays inside the tab on its own: Chromium itself refuses
 * `SystemInfo.getInfo`, and a `browserContextId` on `Storage.getCookies`,
 * from a page session ("only supported on the browser target"), and
 * Playwright refuses `Target.createBrowserContext` and
 * `Target.disposeBrowserContext`. So the guard is exactly these two domains,
 * rather than an allow-list that would defeat the point of a raw escape hatch.
 */
const browserScopedCdpDomains = new Set(['Browser', 'Target']);

/**
 * The refusal message for a command that would leave this session, or null
 * if the command is genuinely confined to the caller's own tab.
 *
 * `Target.getTargetInfo` asked about the caller's own tab is page-scoped, and
 * is how escalate_session finds its own target id, so it stays allowed. Given
 * a `targetId` or a `browserContextId` it reads another session's tab
 * instead, so that form does not.
 */
export function cdpScopeRefusal(method: string, params: unknown): string | null {
  const domain = method.split('.')[0] ?? '';
  if (!browserScopedCdpDomains.has(domain)) return null;

  const named = typeof params === 'object' && params !== null ? (params as Record<string, unknown>) : {};
  const namesAnotherTarget = named.targetId !== undefined || named.browserContextId !== undefined;
  if (method === 'Target.getTargetInfo' && !namesAnotherTarget) return null;

  return (
    `send_cdp_command refuses "${method}": Chromium routes the ${domain} domain to the browser rather than to this ` +
    'session\'s tab, so it reaches every other session sharing this daemon\'s Chromium. Use list_tabs, new_tab, ' +
    'close_tab and select_tab for this session\'s own tabs, escalate_session for a human-drivable CDP URL, and ' +
    'release_session to end a session. Every domain outside Browser and Target is still available here.'
  );
}

function messageOf(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).replace(ansiEscape, '');
}

const clipRegion = z.object({
  x: z.number().min(0).describe('Left edge of the region, in CSS pixels from the left of the viewport.'),
  y: z.number().min(0).describe('Top edge of the region, in CSS pixels from the top of the viewport.'),
  width: z.number().positive().describe('Width of the region in CSS pixels.'),
  height: z.number().positive().describe('Height of the region in CSS pixels.')
});

type ClipRegion = z.infer<typeof clipRegion>;

/**
 * Captures one element. Playwright's own failure text already names the
 * selector, but it names it inside a wall of locator internals, so this
 * restates the two things a caller can act on: which selector failed, and
 * what would make it work.
 */
async function captureElement(page: Page, selector: string, timeoutMs: number): Promise<Buffer> {
  try {
    return await page.locator(selector).screenshot({ type: 'png', timeout: timeoutMs });
  } catch (err) {
    throw new Error(
      `screenshot of selector ${JSON.stringify(selector)} failed after up to ${timeoutMs}ms: ${messageOf(err)}. ` +
        'The selector has to match exactly one element that is attached and visible. Use snapshot to check what is ' +
        'actually on the page, raise timeoutMs if the element renders late, or narrow the selector if it matched several.'
    );
  }
}

/**
 * Captures an explicit region.
 *
 * Playwright's clip is measured against the image it is about to produce, not
 * against the document: without fullPage that image is the viewport, so a
 * region below the fold is "outside the resulting image" and throws. Since
 * fullPage and clip are rejected together anyway, clip has exactly one
 * meaning here, viewport coordinates, and the error says so rather than
 * leaving a caller to guess which of the two coordinate spaces it was in.
 */
async function captureClip(page: Page, clip: ClipRegion): Promise<Buffer> {
  try {
    return await page.screenshot({ type: 'png', clip });
  } catch (err) {
    const viewport = page.viewportSize();
    const size = viewport ? `${viewport.width}x${viewport.height}` : 'unknown';
    throw new Error(
      `screenshot with clip {x:${clip.x}, y:${clip.y}, width:${clip.width}, height:${clip.height}} failed: ` +
        `${messageOf(err)}. The clip is measured from the top left of the current viewport, which is ${size}, so a ` +
        'region below the fold is out of range. Scroll it into view first, or pass selector instead and let it ' +
        'scroll for you.'
    );
  }
}

/**
 * Playwright reports a fault inside an evaluated expression as a V8 stack
 * frame, and the position in that frame counts into the source *after*
 * Playwright has trimmed it. Verified empirically against Playwright 1.62 and
 * against its own `normalizeEvaluationExpression`, which does exactly one
 * line-affecting thing to a string expression: `expression.trim()`. So line
 * and column map 1-based onto the trimmed text, which is why the trimmed text
 * is what gets echoed back.
 *
 * The frames worth reading are the ones nested inside the evaluation
 * ("eval at evaluate (...), <anonymous>:LINE:COL"). Playwright's own harness
 * frames name the same <anonymous> file with unrelated line numbers, so
 * matching on the nesting rather than on <anonymous> is what stops a harness
 * frame being reported as the caller's fault. The first such frame is the
 * innermost one, which is where the throw actually happened.
 */
const evaluatedFrame = /eval at evaluate \([^)]*\),\s*<anonymous>:(\d+):(\d+)\)/;

function faultPosition(message: string, lineCount: number): { line: number; column: number } | undefined {
  const match = evaluatedFrame.exec(message);
  if (!match) return undefined;
  const line = Number(match[1]);
  const column = Number(match[2]);
  // A position outside the expression is not a position we can point at. It
  // would mean the frame did not come from this source after all, and a
  // marker on a line that does not exist is worse than no marker.
  if (!Number.isFinite(line) || line < 1 || line > lineCount) return undefined;
  return { line, column };
}

/** The submitted source, numbered, with the faulting line marked and a caret under the column. */
function numberedSource(source: string, fault?: { line: number; column: number }): string {
  const lines = source.split('\n');
  const gutter = String(lines.length).length;
  const out: string[] = [];
  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    const marked = fault?.line === lineNumber;
    out.push(`${marked ? '> ' : '  '}${String(lineNumber).padStart(gutter)} | ${line}`);
    if (marked) {
      const column = Math.max(1, Math.min(fault.column, line.length + 1));
      out.push(`  ${' '.repeat(gutter)} | ${' '.repeat(column - 1)}^`);
    }
  }
  return out.join('\n');
}

/** A tool result carrying the rendered report as text and the same facts as fields. */
function failure(rendered: string, payload: Record<string, unknown>): ToolResult {
  return { content: [{ type: 'text', text: rendered }], structuredContent: payload, isError: true };
}

// ---------------------------------------------------------------------------
// Diagnostics: computed style, geometry, frames, find
// ---------------------------------------------------------------------------

/**
 * The browser globals the in-page snippets further down actually touch.
 *
 * The daemon's own tsconfig has no "dom" lib on purpose: it is a Node
 * process, and pulling the whole DOM in would let browser APIs leak into
 * daemon code unnoticed. Declaring exactly what these snippets use keeps them
 * type-checked without opening that door. The declarations are module-scoped,
 * so they shadow rather than clash with lib.dom under the test tsconfig.
 */
interface ProbeRect {
  x: number;
  y: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

interface ProbeStyle {
  getPropertyValue(property: string): string;
}

interface ProbeElement {
  tagName: string;
  id: string;
  parentElement: ProbeElement | null;
  children: ArrayLike<ProbeElement>;
  scrollWidth: number;
  scrollHeight: number;
  scrollTop: number;
  scrollLeft: number;
  clientWidth: number;
  clientHeight: number;
  textContent: string | null;
  getBoundingClientRect(): ProbeRect;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  checkVisibility?(options?: Record<string, boolean>): boolean;
  // Loosely typed on purpose: the real DOM signature takes a Node, and the
  // test tsconfig does pull in lib.dom, so anything narrower stops these
  // callbacks type-checking under it.
  contains(other: any): boolean;
  // True once the node is connected all the way to a document, following
  // shadow trees the way the spec requires. Used to tell a chain that
  // stopped at the real document root from one that stopped because the
  // element is detached (mid-mutation, or removed).
  isConnected: boolean;
  // Real signature returns Node, which is not this interface, but callers
  // here only ever read .host off the result, and both a Document and a
  // ShadowRoot structurally satisfy "optionally has a host".
  getRootNode(): { host?: ProbeElement };
  // Present (possibly null, for a closed root) on any element that is
  // itself a shadow host. Absent entirely on one that is not.
  shadowRoot?: { elementFromPoint?(x: number, y: number): ProbeElement | null } | null;
}

declare const document: {
  documentElement: ProbeElement;
  body: ProbeElement | null;
  querySelectorAll(selector: string): ArrayLike<ProbeElement>;
  getElementsByTagName(tag: string): ArrayLike<ProbeElement>;
  elementFromPoint(x: number, y: number): ProbeElement | null;
};
declare const window: {
  innerWidth: number;
  innerHeight: number;
  scrollX: number;
  scrollY: number;
  devicePixelRatio: number;
};
declare function getComputedStyle(element: unknown, pseudoElement?: string | null): ProbeStyle;
declare const CSS: { escape(value: string): string };

/** The property set computed_style fetches when a caller names none. */
const defaultStyleProperties = [
  'color',
  'background-color',
  'font-size',
  'font-weight',
  'font-family',
  'line-height',
  'border',
  'border-color',
  'border-width',
  'border-style',
  'border-radius',
  'outline',
  'outline-color',
  'outline-width',
  'outline-style',
  'outline-offset',
  'box-shadow',
  'opacity',
  'display',
  'visibility'
];

/** Pseudo-classes Chromium's CSS.forcePseudoState can be told to pretend are active. */
const forceablePseudoStates = ['hover', 'focus', 'focus-within', 'focus-visible', 'active', 'visited', 'target'] as const;

/**
 * The attribute computed_style tags matched elements with while it forces a
 * pseudo-state. It exists only because CDP addresses nodes by nodeId and
 * Playwright hands out no nodeIds, so the element has to be findable from the
 * CDP side. Removed again in a finally.
 */
const probeAttribute = 'data-harborage-probe';

/** How many matches a diagnostics tool reports per selector unless told otherwise. */
const defaultMatchLimit = 20;

const opaqueWhite: Rgba = { r: 255, g: 255, b: 255, a: 1 };

/**
 * The colour the browser paints behind a page that declares no background of
 * its own, read out of the page rather than assumed.
 *
 * Assuming white was wrong for every dark-mode site there is. Chromium paints
 * rgb(18, 18, 18) behind a document whose used `color-scheme` is dark, and it
 * does that whether the page asked for dark itself (`color-scheme: dark` in
 * CSS) or the browser was told the user wants it (a `<meta name="color-scheme">`
 * page under emulate_media). In both cases getComputedStyle on the root still
 * reports `rgba(0, 0, 0, 0)`, so nothing about the cascade gives it away: white
 * text over that canvas came out as 1:1 and a confident AA failure.
 *
 * The `Canvas` CSS system colour is exactly this value and resolves through
 * getComputedStyle, so the browser answers the question directly. It needs an
 * element to resolve against, hence the throwaway node, which is removed again
 * before the snippet returns.
 */
const CANVAS_COLOR_PROBE = `(() => {
  var probe = document.createElement('div');
  probe.style.cssText = 'background-color: Canvas; position: fixed; left: -99999px; top: -99999px; width: 0; height: 0';
  document.documentElement.appendChild(probe);
  try {
    return getComputedStyle(probe).backgroundColor;
  } finally {
    probe.remove();
  }
})()`;
const fullyTransparent: Rgba = { r: 0, g: 0, b: 0, a: 0 };

/**
 * Re-exported so the colour parser stays reachable from where it is used.
 * The implementation, including every modern colour space and the reasoning
 * behind clipping out-of-gamut colours rather than gamut-mapping them, lives
 * in ../color.ts.
 */
export { parseCssColor };

/** An opaque "rgb(r, g, b)" string, rounded, which is what a caller can paste back into CSS. */
function formatRgb(color: Rgba): string {
  return `rgb(${Math.round(color.r)}, ${Math.round(color.g)}, ${Math.round(color.b)})`;
}

/** Standard source-over compositing with straight (non-premultiplied) alpha. */
function over(source: Rgba, backdrop: Rgba): Rgba {
  const alpha = source.a + backdrop.a * (1 - source.a);
  if (alpha === 0) return { ...fullyTransparent };
  const mix = (s: number, d: number): number => (s * source.a + d * backdrop.a * (1 - source.a)) / alpha;
  return { r: mix(source.r, backdrop.r), g: mix(source.g, backdrop.g), b: mix(source.b, backdrop.b), a: alpha };
}

interface PaintLayer {
  bg: Rgba;
  opacity: number;
}

/**
 * Paints layers[index..] as one standalone layer over transparency.
 *
 * The recursion is what makes `opacity` come out right. CSS opacity is a
 * group operation: it fades everything the element and its descendants paint,
 * as one unit, against whatever is behind the element. So the inner layers
 * have to be composited first, then the whole result faded, rather than each
 * layer's alpha being multiplied on the way down.
 */
function paintGroup(layers: PaintLayer[], index: number, innermost: Rgba): Rgba {
  const layer = layers[index];
  const inner = index + 1 < layers.length ? paintGroup(layers, index + 1, innermost) : innermost;
  const painted = over(inner, layer.bg);
  return { ...painted, a: painted.a * layer.opacity };
}

/**
 * The pixel a viewer actually sees: the whole ancestor stack composited onto
 * the canvas the browser really paints. The stack already includes the
 * document root, so a page that declares its own background has covered the
 * canvas before this matters; it only shows through for a page that does not,
 * which is precisely the dark-mode case that used to come out white.
 */
function flattenOntoCanvas(layers: PaintLayer[], innermost: Rgba, canvas: Rgba): Rgba {
  if (layers.length === 0) return over(innermost, canvas);
  return over(paintGroup(layers, 0, innermost), canvas);
}

/** WCAG 2.x sRGB channel transfer function. */
function channelLuminance(value: number): number {
  const scaled = value / 255;
  return scaled <= 0.03928 ? scaled / 12.92 : Math.pow((scaled + 0.055) / 1.055, 2.4);
}

/** WCAG 2.x relative luminance. Alpha is ignored: only composite (opaque) colours belong here. */
function relativeLuminance(color: Rgba): number {
  return (
    0.2126 * channelLuminance(color.r) + 0.7152 * channelLuminance(color.g) + 0.0722 * channelLuminance(color.b)
  );
}

/** WCAG 2.x contrast ratio, 1 to 21. */
function contrastRatio(a: Rgba, b: Rgba): number {
  const first = relativeLuminance(a);
  const second = relativeLuminance(b);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * WCAG's "large text": 18pt, which is 24 CSS px, or 14pt (18.667 CSS px) at
 * weight 700 or more. It matters because it moves the AA threshold from
 * 4.5:1 down to 3:1, which is the difference between a real finding and a
 * false one.
 */
function isLargeText(fontSizePx: number, fontWeight: number): boolean {
  if (!Number.isFinite(fontSizePx)) return false;
  if (fontSizePx >= 24) return true;
  return fontWeight >= 700 && fontSizePx >= 18.6667;
}

function round(value: number, places: number): number {
  const factor = Math.pow(10, places);
  return Math.round(value * factor) / factor;
}

interface RawLayer {
  tagName: string;
  id: string;
  backgroundColor: string;
  opacity: string;
}

/** One frame of a tab, with the id and the selector prefix an agent can act on. */
interface FrameNode {
  frame: Frame;
  frameId: string;
  parentFrameId?: string;
}

/**
 * Every frame in a tab, main frame first, each with a positional id.
 *
 * The id is a path ("main", "main/0", "main/0/1") rather than an opaque
 * handle because harborage keeps no per-session state and an id has to be
 * re-derivable from the live page on the next call. The cost of that choice
 * is honest and worth saying out loud: the ids are positional, so adding or
 * removing an iframe renumbers its siblings.
 */
function frameTree(page: Page): FrameNode[] {
  const nodes: FrameNode[] = [];
  const walk = (frame: Frame, frameId: string, parentFrameId?: string): void => {
    nodes.push({ frame, frameId, parentFrameId });
    frame.childFrames().forEach((child, index) => walk(child, `${frameId}/${index}`, frameId));
  };
  walk(page.mainFrame(), 'main');
  return nodes;
}

/** Resolves a frame id from list_frames, or explains which ids do exist. */
function resolveFrame(page: Page, frameId: string | undefined): Frame | undefined {
  if (frameId === undefined) return undefined;
  const nodes = frameTree(page);
  const hit = nodes.find(node => node.frameId === frameId);
  if (!hit) {
    throw new Error(
      `no frame with id ${JSON.stringify(frameId)} in this tab. Ids currently present: ` +
        `${nodes.map(node => node.frameId).join(', ')}. Call list_frames for their urls and selector prefixes. ` +
        'Frame ids are positional, so they shift when the page adds or removes an iframe: re-read them rather ' +
        'than caching one across a navigation.'
    );
  }
  return hit.frame;
}

/**
 * The one selector segment that steps from a frame's parent into the frame,
 * or undefined when the frame has no reachable owning element (the main
 * frame, or a frame that detached mid-call).
 */
async function frameSelectorSegment(frame: Frame): Promise<string | undefined> {
  try {
    const element = await frame.frameElement();
    try {
      const info = await element.evaluate(node => {
        const tag = String((node as unknown as { tagName: string }).tagName).toLowerCase();
        const index = Array.prototype.indexOf.call(document.getElementsByTagName(tag), node);
        return { tag, index: index as number };
      });
      if (info.index < 0) return undefined;
      return `${info.tag} >> nth=${info.index} >> internal:control=enter-frame >> `;
    } finally {
      await element.dispose().catch(() => {});
    }
  } catch {
    return undefined;
  }
}

/**
 * A selector prefix that reaches from the page into this frame, built by
 * chaining one segment per level. Prepending it to any selector lets the
 * tools that take a raw selector (click, fill, screenshot, computed_style,
 * element_box) act inside an iframe without any of them knowing frames exist.
 */
async function frameSelectorPrefix(page: Page, frame: Frame): Promise<string | undefined> {
  if (frame === page.mainFrame()) return '';
  const segments: string[] = [];
  let current: Frame | null = frame;
  while (current && current !== page.mainFrame()) {
    const segment = await frameSelectorSegment(current);
    if (segment === undefined) return undefined;
    segments.unshift(segment);
    current = current.parentFrame();
  }
  return segments.join('');
}

/** The positional frame id (`main`, `main/0`, `main/0/1`) of a live frame, or undefined if it has detached. */
function frameIdOf(page: Page, frame: Frame): string | undefined {
  return frameTree(page).find(node => node.frame === frame)?.frameId;
}

/**
 * The frame whose document a locator's matches actually live in, asked of a
 * resolved element rather than assumed from a `frame` argument.
 *
 * This is the difference between a selector that works and one that presses
 * the wrong button. A Playwright selector can cross a frame boundary on its
 * own, through the `>> internal:control=enter-frame >>` chunk that
 * list_frames hands out as a selectorPrefix, so which document a match
 * resolves in is a property of the SELECTOR, not of the `frame` argument.
 * Two shapes defeat any guard that reads the argument alone: a prefix passed
 * inside the selector with no `frame` argument at all, and a selector that
 * steps one or more frames deeper than the `frame` argument reaches. Both
 * were probed on a real page, and both used to come back certified against
 * one document and then run by the caller against another.
 *
 * Chromium resolves one enter-frame chain to exactly one frame (an ambiguous
 * `iframe >> internal:control=enter-frame` silently takes the first iframe
 * rather than fanning out across all of them), so one resolved element
 * settles it for the whole match set. `fallback` is used when nothing
 * matched, or when no element handle could be taken.
 */
async function locatorResolutionFrame(matches: Locator, fallback: Frame): Promise<Frame> {
  const handle = await matches
    .first()
    .elementHandle({ timeout: 1000 })
    .catch(() => null);
  if (handle === null) return fallback;
  try {
    return (await handle.ownerFrame()) ?? fallback;
  } catch {
    return fallback;
  } finally {
    await handle.dispose().catch(() => {});
  }
}

interface CdpNode {
  nodeId: number;
  attributes?: string[];
  children?: CdpNode[];
  contentDocument?: CdpNode;
  shadowRoots?: CdpNode[];
}

/**
 * Every node carrying the probe attribute, anywhere in the pierced document
 * tree. Walking the tree rather than calling DOM.querySelector is what makes
 * this work inside an iframe: querySelector is scoped to one document, while
 * a pierced DOM.getDocument already contains them all.
 */
function collectProbeNodes(node: CdpNode, into: number[]): void {
  const attributes = node.attributes ?? [];
  for (let index = 0; index < attributes.length; index += 2) {
    if (attributes[index] === probeAttribute) {
      into.push(node.nodeId);
      break;
    }
  }
  for (const child of node.children ?? []) collectProbeNodes(child, into);
  for (const shadowRoot of node.shadowRoots ?? []) collectProbeNodes(shadowRoot, into);
  if (node.contentDocument) collectProbeNodes(node.contentDocument, into);
}

/**
 * Runs `read` with `states` forced on every element the locator matches, then
 * puts the page back exactly as it was.
 *
 * CSS.forcePseudoState is the same mechanism DevTools' "force element state"
 * checkbox uses, and it really does reach getComputedStyle, which is what
 * makes a resting-versus-hover comparison possible at all without synthesising
 * a real pointer. The restore is in a finally because a leaked forced :hover
 * would silently poison every later measurement of the same page.
 */
async function withForcedStates<T>(
  page: Page,
  root: Page | Frame,
  matches: Locator,
  states: readonly string[],
  read: () => Promise<T>
): Promise<T> {
  await matches.evaluateAll((nodes, attribute: string) => {
    const elements = Array.prototype.slice.call(nodes) as ProbeElement[];
    elements.forEach((element, index) => element.setAttribute(attribute, String(index)));
  }, probeAttribute);

  const cdpSession = await page.context().newCDPSession(page);
  const forced: number[] = [];
  try {
    await cdpSession.send('DOM.enable');
    await cdpSession.send('CSS.enable');
    const tree = (await cdpSession.send('DOM.getDocument', { depth: -1, pierce: true })) as unknown as {
      root: CdpNode;
    };
    collectProbeNodes(tree.root, forced);
    for (const nodeId of forced) {
      await cdpSession.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [...states] });
    }
    return await read();
  } finally {
    for (const nodeId of forced) {
      await cdpSession.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] }).catch(() => {});
    }
    await cdpSession.detach().catch(() => {});
    await root
      .evaluate((attribute: string) => {
        const tagged = document.querySelectorAll(`[${attribute}]`);
        for (let index = 0; index < tagged.length; index += 1) tagged[index].removeAttribute(attribute);
      }, probeAttribute)
      .catch(() => {});
  }
}

/** Tools that read something back out of a tab: page state, pixels, buffers, raw CDP. */
export const inspectTools = defineTools({
  evaluate: defineTool({
    description:
      'Evaluate JavaScript in a session\'s tab and return the resolved value, JSON-serialized. ' +
      'The expression is a whole script, not one line: multi-line source, several statements and const/let ' +
      'declarations all work, and the value of the last expression is what comes back. A promise is awaited, so ' +
      '"(async () => { const r = await fetch(\'/api\'); return r.status; })()" returns the status, not a promise. ' +
      'Traps worth knowing: a bare function such as "() => 42" is evaluated but never called, so it silently ' +
      'returns undefined (write "(() => 42)()" instead); an expression starting with the function keyword gets ' +
      'wrapped in parentheses before evaluation, so "function f() {} f()" is a syntax error; and a bare object ' +
      'literal parses as a block, so return "({ a: 1 })". Anything not JSON-serializable (a DOM node, a function, ' +
      'window) comes back as undefined or an empty object, so return a plain summary of it instead. When the ' +
      'expression throws, the error echoes the source with line numbers and marks the line that faulted.',
    inputSchema: z.object({
      sessionId,
      pageId,
      frame: z
        .string()
        .optional()
        .describe(
          'Frame id from list_frames to evaluate inside, e.g. "main/0" for the first iframe. Defaults to the ' +
            'tab\'s main frame. Each frame has its own JavaScript context, so a variable set in one is not ' +
            'visible in another.'
        ),
      expression: z
        .string()
        .describe('JavaScript evaluated in the page context. The resolved value is JSON-serialized back.'),
      timeoutMs: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe(
          'How long to wait for the expression to settle, in milliseconds (default 30000, 0 waits forever). ' +
            'On timeout the expression keeps running in the page: this bounds the tool call, it does not cancel ' +
            'the work.'
        )
    }),
    async handler(ctx, args) {
      const target = ctx.sessions.resolve(args.sessionId, args.pageId);
      const evaluationRoot: Page | Frame = resolveFrame(target.page, args.frame) ?? target.page;
      const inFrame = args.frame !== undefined ? { frame: args.frame } : {};
      const timeoutMs = args.timeoutMs ?? defaultEvaluateTimeoutMs;
      // Playwright trims before evaluating, so this is the text its line and
      // column numbers actually refer to.
      const source = args.expression.trim();

      // Playwright's page.evaluate takes no timeout of its own (its third
      // argument is exposeFunctions, nothing more), and an expression that
      // never settles only fails when V8 happens to garbage-collect the
      // pending promise: observed at roughly 30s with "Resulting promise was
      // garbage collected", which is luck, not a bound. Hence racing it here.
      // Promise.race has already attached handlers to the evaluation, so its
      // later rejection stays handled and never surfaces as an unhandled
      // rejection in the daemon.
      const pending = evaluationRoot.evaluate(args.expression);
      const timedOut = Symbol('timeout');
      let timer: NodeJS.Timeout | undefined;

      try {
        const raced: unknown =
          timeoutMs === 0
            ? await pending
            : await Promise.race([
                pending,
                new Promise<typeof timedOut>(resolve => {
                  timer = setTimeout(() => resolve(timedOut), timeoutMs);
                })
              ]);

        if (raced === timedOut) {
          return failure(
            `evaluate timed out after ${timeoutMs}ms waiting for this expression to settle. It is still running in ` +
              'the page: the timeout only stops harborage waiting for it. Raise timeoutMs, or make the expression ' +
              'settle on its own. The expression, as evaluated:\n' +
              numberedSource(source),
            {
              pageId: target.pageId,
              ...inFrame,
              error: `evaluate timed out after ${timeoutMs}ms`,
              timedOut: true,
              timeoutMs,
              positionKnown: false,
              expression: source
            }
          );
        }

        return text({ pageId: target.pageId, ...inFrame, result: raced });
      } catch (err) {
        const message = messageOf(err);
        const headline = message.split('\n')[0]?.replace(/^page\.evaluate:\s*/, '') ?? message;
        const fault = faultPosition(message, source.split('\n').length);

        return failure(
          `evaluate failed: ${headline}\n` +
            (fault
              ? `Fault at line ${fault.line}, column ${fault.column} of the expression as evaluated. Leading ` +
                'whitespace is trimmed off before evaluation, so the numbers count from the first line shown here:\n'
              : 'No source position was reported for this error, which is normal for a syntax error, so no line is ' +
                'marked. The expression, as evaluated:\n') +
            numberedSource(source, fault),
          {
            pageId: target.pageId,
            ...inFrame,
            error: headline,
            positionKnown: fault !== undefined,
            ...(fault ? { line: fault.line, column: fault.column } : {}),
            expression: source,
            stack: message
          }
        );
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
  }),

  snapshot: defineTool({
    description:
      'Get an AI-readable accessibility snapshot of a session\'s tab (structure and text, not pixels). ' +
      'Iframe contents are included inline, nested under the iframe node, with their refs prefixed by frame ' +
      '("ref=f1e2"). Pass frame (from list_frames) to snapshot one frame on its own instead, which is much ' +
      'smaller when only part of the page matters. ' +
      'The "ref=eN" ids in the output are NOT selectors: click and fill will not take them. Use find to get a ' +
      'selector those tools accept.',
    inputSchema: z.object({
      sessionId,
      pageId,
      frame: z
        .string()
        .optional()
        .describe('Frame id from list_frames to snapshot instead of the whole tab. Defaults to the main frame.')
    }),
    async handler(ctx, args) {
      const target = ctx.sessions.resolve(args.sessionId, args.pageId);
      const snapshotRoot: Page | Frame = resolveFrame(target.page, args.frame) ?? target.page;
      const snapshot = await snapshotRoot.locator('body').ariaSnapshot({ mode: 'ai' });
      return text({
        pageId: target.pageId,
        ...(args.frame !== undefined ? { frame: args.frame } : {}),
        url: snapshotRoot.url(),
        snapshot
      });
    }
  }),

  screenshot: defineTool({
    description:
      'Capture pixels from a session\'s tab as a PNG. Every result reports the capture\'s real width and height, ' +
      'read back out of the PNG itself rather than from what was requested, so a viewport that is not what you ' +
      'assumed is visible without opening the file. Those two are DEVICE pixels, so at a deviceScaleFactor of 2 a ' +
      '375x600 viewport reports 750x1200: cssWidth, cssHeight and deviceScaleFactor come back alongside them, and ' +
      'cssWidth/cssHeight are the ones to compare against a clip or an element box, which are CSS pixels. ' +
      'Scope: the default is the whole viewport. Pass selector to capture one element, or clip for an explicit ' +
      'region, when what you care about is a small part of a large page. selector, clip and fullPage are mutually ' +
      'exclusive, and a contradictory combination is rejected rather than quietly half-applied. ' +
      'What comes back depends on mode: "inline" (the default) returns the PNG as base64 image data, which you can ' +
      'look at directly. "cached" returns a file path and nothing viewable, so seeing it costs a separate file read. ' +
      'Choose "inline" when you intend to look at the image now, and "cached" for bulk or repeated captures you do ' +
      'not want filling up the conversation.',
    inputSchema: z.object({
      sessionId,
      pageId,
      fullPage: z
        .boolean()
        .optional()
        .describe(
          'Capture the full scrollable page instead of just the viewport. Cannot be combined with selector or clip.'
        ),
      selector: z
        .string()
        .optional()
        .describe(
          'CSS or Playwright selector for a single element to capture, scrolled into view first. Must match exactly ' +
            'one attached, visible element. Cannot be combined with clip or fullPage.'
        ),
      clip: clipRegion
        .optional()
        .describe(
          'Explicit region to capture, in CSS pixels measured from the top left of the current viewport, the same ' +
            'coordinates getBoundingClientRect returns. A region reaching past the edge of the viewport is ' +
            'truncated to what is on screen, and the reported width and height are what you actually got. For ' +
            'something below the fold, scroll it into view first, or use selector, which scrolls for you. Cannot be ' +
            'combined with selector or fullPage.'
        ),
      timeoutMs: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('How long to wait for selector to match, in milliseconds (default 5000). Ignored without selector.'),
      mode: z
        .enum(['inline', 'cached'])
        .optional()
        .describe(
          '"inline" (default): return the PNG as base64 image data, written nowhere. ' +
            '"cached": write the PNG into this session\'s own directory of the local cache, which auto-expires ' +
            'after HARBORAGE_SCREENSHOT_CACHE_TTL_MS, and return only a reference to it (path, cacheId, width, ' +
            'height, expiresAt). Nothing viewable comes back in this mode: read the path to see the image.'
        )
    }),
    async handler(ctx, args) {
      const target = ctx.sessions.resolve(args.sessionId, args.pageId);

      // Rejecting a contradiction beats honouring one argument and dropping
      // the other: a silently ignored argument is exactly how an agent ends
      // up trusting evidence that answers a different question.
      if (args.selector !== undefined && args.clip !== undefined) {
        throw new Error(
          'screenshot takes selector or clip, not both: they are two ways of asking for the same thing. Pass ' +
            'selector to capture an element, or clip to capture a fixed region.'
        );
      }
      if (args.fullPage && (args.selector !== undefined || args.clip !== undefined)) {
        throw new Error(
          'screenshot cannot combine fullPage with selector or clip: fullPage captures the whole scrollable page, ' +
            'while selector and clip capture one part of it. Pick one.'
        );
      }

      const buffer =
        args.selector !== undefined
          ? await captureElement(target.page, args.selector, args.timeoutMs ?? defaultSelectorTimeoutMs)
          : args.clip !== undefined
            ? await captureClip(target.page, args.clip)
            : await target.page.screenshot({ type: 'png', fullPage: args.fullPage ?? false });

      const { width, height } = pngDimensions(buffer);
      // The PNG is in DEVICE pixels while clip, selector geometry and the
      // viewport are all in CSS pixels. At a deviceScaleFactor of 2 those sit
      // side by side in one payload as 200 and 400 for the same edge, and a
      // truncated clip then reads as untruncated: asking for 200x200 at the
      // bottom right of a 375x600 viewport really returns 75x100 CSS pixels and
      // used to report "width: 150, height: 200", which against the request
      // says the height was not clipped at all. Both scales are reported now.
      const deviceScaleFactor = await target.page
        .evaluate(() => window.devicePixelRatio)
        .catch(() => 1);
      const scope =
        args.selector !== undefined
          ? 'element'
          : args.clip !== undefined
            ? 'clip'
            : args.fullPage
              ? 'fullPage'
              : 'viewport';
      const common = {
        pageId: target.pageId,
        scope,
        ...(args.selector !== undefined ? { selector: args.selector } : {}),
        ...(args.clip !== undefined ? { clip: args.clip } : {}),
        width,
        height,
        deviceScaleFactor,
        cssWidth: Math.round((width / deviceScaleFactor) * 100) / 100,
        cssHeight: Math.round((height / deviceScaleFactor) * 100) / 100,
        sizeBytes: buffer.length
      };

      if (args.mode === 'cached') {
        const { screenshotCacheDir, screenshotCacheTtlMs } = ctx.config;
        // One directory per session, so parallel agents cannot read each
        // other's evidence out of a shared namespace.
        const dir = sessionCacheDir(screenshotCacheDir, target.session.id);
        await mkdir(dir, { recursive: true });
        const cacheId = randomUUID();
        const filePath = join(dir, `${cacheId}.png`);
        await writeFile(filePath, buffer);
        return text({
          ...common,
          mode: 'cached',
          cacheId,
          path: filePath,
          expiresAt: new Date(Date.now() + screenshotCacheTtlMs).toISOString()
        });
      }

      // Default: inline base64, never written to disk. The image block stays
      // first so a caller reading content[0] still finds the picture, and the
      // dimensions ride alongside it rather than replacing it.
      const meta = { ...common, mode: 'inline' };
      return {
        content: [
          { type: 'image', data: buffer.toString('base64'), mimeType: 'image/png' },
          { type: 'text', text: JSON.stringify(meta, null, 2) }
        ],
        structuredContent: meta
      };
    }
  }),

  read_console: defineTool({
    description:
      'Read buffered browser console messages for a session (optionally filtered to one tab). Buffering starts at ' +
      'create_session, so this returns history, not just future messages. The buffer is bounded ' +
      '(HARBORAGE_CONSOLE_BUFFER_SIZE, 200 by default) and drops the oldest messages once full. Every result ' +
      'reports total (messages currently in the buffer), returned (messages this call\'s filters matched) and ' +
      'dropped (messages the buffer has evicted since it was last fully cleared). total: 200, returned: 0, ' +
      'dropped: 0 means the filter genuinely matched nothing that is still there; dropped > 0 means real messages ' +
      'are already gone and no filter will bring them back, so read sooner or clear right after the action you ' +
      'care about next time. ' +
      'clear: true removes only the messages this call returned, per the clear field below; a call with no ' +
      'narrowing (no pageId, no types, no textIncludes) therefore drains the whole buffer, and that specific case ' +
      'also resets dropped to 0, since that is a fresh observation window starting. A narrowed clear leaves dropped ' +
      'exactly as it was: those losses are still real for whatever is left unread.',
    inputSchema: z.object({
      sessionId,
      pageId,
      clear,
      types: z
        .array(z.string())
        .optional()
        .describe(
          'Keep only messages of these console types, e.g. ["error", "warning"] for just the problems. Types come ' +
            'from the browser: "log", "info", "warning", "error", "debug", "trace" and friends.'
        ),
      textIncludes: z
        .string()
        .optional()
        .describe('Keep only messages whose text contains this substring, matched case-insensitively.')
    }),
    async handler(ctx, args) {
      const wanted = args.types !== undefined ? new Set(args.types.map(t => t.toLowerCase())) : undefined;
      const needle = args.textIncludes?.toLowerCase();

      const matches = (entry: { type: string; text: string }): boolean => {
        if (wanted !== undefined && !wanted.has(entry.type.toLowerCase())) return false;
        if (needle !== undefined && !entry.text.toLowerCase().includes(needle)) return false;
        return true;
      };

      // The filter is pushed into the store rather than applied to what comes
      // back, because `clear` is handled in there. Filtering on the way out
      // would drain the whole buffer while returning only the matches, silently
      // destroying entries the caller never saw. total and dropped are read
      // first, without clearing, so they describe the window this call is
      // about to close out rather than the (possibly just-reset) state after.
      const before = ctx.sessions.getConsoleMessages(args.sessionId, args.pageId, false);
      const result = ctx.sessions.getConsoleMessages(args.sessionId, args.pageId, args.clear ?? false, matches);

      return text({ total: before.entries.length, returned: result.entries.length, dropped: before.dropped, messages: result.entries });
    }
  }),

  list_network_requests: defineTool({
    description:
      'List buffered network requests and responses for a session (optionally filtered to one tab). Buffering ' +
      'starts at create_session, and the buffer is bounded (HARBORAGE_NETWORK_BUFFER_SIZE, 400 by default): once ' +
      'it is full the oldest entries are dropped. Every result reports total (entries currently in the buffer), ' +
      'returned (entries this call\'s filters matched) and dropped (entries evicted from the buffer since it was ' +
      'last fully cleared). total: 400, returned: 0, dropped: 0 means the filter genuinely matched nothing that is ' +
      'still there; dropped > 0 means real traffic is already gone, no filter recovers it, and the fix is capture, ' +
      'not read: set a capture filter (see below) or clear right before the action you care about so less has to ' +
      'fit in the ring. ' +
      'This matters most on a page that keeps its own dev tooling open, a Vite/webpack dev server being the ' +
      'canonical case: dozens to hundreds of module-chunk requests can fill the whole buffer in the first second ' +
      'of a single page load, evicting the one API call an agent actually wanted before anyone gets to filter for ' +
      'it. A high dropped count with the traffic you wanted nowhere in returned is that happening, not a bug in ' +
      'this tool. ' +
      'To stop it at the source rather than reading around it: create_session takes an optional ' +
      'networkCaptureFilter, and set_network_capture_filter changes or clears one on a session that is already ' +
      'running, which is the common case since the flood is usually only obvious after it has already happened. ' +
      'Both take the same urlIncludes / urlMatches / method / resourceType / direction vocabulary as the filters ' +
      'below, so whatever narrows a read here can be pasted straight into a capture filter to stop the eviction ' +
      'instead of just working around it. ' +
      'One HTTP exchange shows up as two entries: a request entry carrying method and resourceType, and a response ' +
      'entry carrying status. No single filter spans both, so "the POST that failed" is two calls, one with ' +
      'method: "POST" and one with minStatus: 400. Filters combine with AND. ' +
      'clear: true removes only the entries this call returned, per the clear field below; a call with no ' +
      'narrowing (no pageId, no urlIncludes/urlMatches/method/minStatus/maxStatus/resourceType/direction) ' +
      'therefore drains the whole buffer, and that specific case also resets dropped and filteredAtCapture to 0, ' +
      'since that is a fresh observation window starting. A narrowed clear leaves both counters exactly as they ' +
      'were: those losses are still real for whatever is left unread.',
    inputSchema: z.object({
      sessionId,
      pageId,
      clear,
      urlIncludes: z
        .string()
        .optional()
        .describe('Keep only entries whose URL contains this substring, matched case-insensitively.'),
      urlMatches: z
        .string()
        .optional()
        .describe(
          'Keep only entries whose URL matches this JavaScript regular expression source, e.g. "/api/.*/save$".'
        ),
      method: z
        .string()
        .optional()
        .describe(
          'Keep only request entries with this HTTP method, matched case-insensitively. This drops every response ' +
            'entry, since responses carry no method.'
        ),
      minStatus: z
        .number()
        .int()
        .optional()
        .describe(
          'Keep only response entries with a status at or above this, so minStatus: 400 is "just the failures". ' +
            'This drops every request entry, since requests carry no status.'
        ),
      maxStatus: z
        .number()
        .int()
        .optional()
        .describe('Keep only response entries with a status at or below this. Combine with minStatus for a range.'),
      resourceType: z
        .string()
        .optional()
        .describe(
          'Keep only entries of this Playwright resource type, e.g. "document", "xhr", "fetch", "image", "script". ' +
            'Only request entries carry one.'
        ),
      direction: z.enum(['request', 'response']).optional().describe('Keep only one side of each exchange.')
    }),
    async handler(ctx, args) {
      const criteria = compileNetworkMatch({
        urlIncludes: args.urlIncludes,
        urlMatches: args.urlMatches,
        method: args.method,
        resourceType: args.resourceType,
        minStatus: args.minStatus,
        maxStatus: args.maxStatus,
        direction: args.direction
      });
      const matches = (entry: NetworkEntry): boolean => matchesNetworkEntry(entry, criteria);

      // Same reasoning as read_console: the predicate goes into the store so
      // `clear` removes exactly what was returned, never more, and total /
      // dropped are read before the (possibly clearing) real read runs.
      const before = ctx.sessions.getNetworkEntries(args.sessionId, args.pageId, false);
      const result = ctx.sessions.getNetworkEntries(args.sessionId, args.pageId, args.clear ?? false, matches);

      return text({
        total: before.entries.length,
        returned: result.entries.length,
        dropped: before.dropped,
        // 0 whenever no capture filter is set, which is the common case, so
        // this only shows up as a live number once a caller has opted in.
        filteredAtCapture: before.filteredOut,
        requests: result.entries
      });
    }
  }),

  computed_style: defineTool({
    description:
      'Read getComputedStyle for the elements a selector matches, and work out what those colours actually look ' +
      'like on screen. This exists so that measuring contrast stops being hand-rolled: an agent compositing ' +
      'colours through a canvas gets a number nobody can check, and pollutes the console it is about to assert on. ' +
      'Per element you get three things. "styles": the raw computed values for the properties asked for (colour, ' +
      'background colour, font size and weight, border, outline, box-shadow, opacity, display and visibility by ' +
      'default). "effective": the colour and background composited down the ancestor chain, so a background of ' +
      '"rgba(0, 0, 0, 0)" or a half-transparent overlay reports what the eye sees instead of what the cascade ' +
      'literally says, with the stack it composited shown as layers. "contrast": the WCAG 2.x contrast ratio ' +
      'between those two effective colours, plus the thresholds that apply and whether they are met. ' +
      'WCAG thresholds used: 4.5:1 for normal text at level AA, 3:1 for large text (18pt, which is 24px, or 14pt ' +
      '/ 18.67px at weight 700 or more), 7:1 and 4.5:1 for the same two cases at AAA, and 3:1 for non-text ' +
      'contrast (borders, icons, focus indicators) under 1.4.11. largeText in the result says which text rule was ' +
      'applied. ' +
      'What the compositing does NOT account for, and these are common: background images and gradients, CSS ' +
      'filters, blend modes, backdrop-filter, box shadows and text shadows, transforms, and anything a sibling or ' +
      'an overlay paints on top (element_box\'s topmostAtCentre is what catches that last one). It composites ' +
      'background-color and opacity only, up to the document root of the frame the element is in, onto the canvas the ' +
      'browser really paints behind the page, and it reports colours it could not parse rather than guessing. ' +
      'The ancestor walk crosses shadow boundaries: an element inside an open or closed shadow root has its chain ' +
      'continued through the shadow host, not stopped at the shadow root, because that host is what genuinely ' +
      'paints behind it. Measured against real Chromium: text at rgb(30, 30, 30) inside a shadow root on a page ' +
      'painted rgb(10, 10, 10), a real ratio of about 1.1:1 and unreadable, used to stop at the shadow root and ' +
      'report a confident 16.67:1 AA pass composited onto an assumed white canvas. On the rare occasion the chain ' +
      'still cannot reach the document (a detached element being measured mid-mutation), effective.layerChainIncomplete ' +
      'is true and the ratio should be read as unreliable rather than final. ' +
      'Colour syntaxes understood: rgb()/rgba() and hsl()/hsla() in both the legacy comma form and the modern ' +
      'space form with a slash alpha, hwb(), lab(), lch(), oklab(), oklch(), color() in the predefined spaces ' +
      'srgb, srgb-linear, display-p3, a98-rgb, prophoto-rgb, rec2020, xyz, xyz-d50 and xyz-d65, and the keyword ' +
      'transparent, each with percentage components, "none" components and an alpha channel. That matters on a ' +
      'Tailwind v4 page, which emits oklab() and oklch() for most colours and for every colour carrying alpha. ' +
      'color-mix() and currentColor need no special handling because getComputedStyle has already resolved them, ' +
      'into an oklab() and into an rgb() respectively. Anything left that cannot be parsed is still listed in ' +
      'effective.unparsedColors with a warning, and is treated as transparent rather than guessed at, so a ' +
      'result carrying no warning is one where every colour was genuinely understood. ' +
      'Out-of-sRGB-gamut colours are CLIPPED per channel, not gamut-mapped: that is what Chromium itself paints ' +
      'on an sRGB screen, and WCAG luminance is only defined over sRGB. When clipping happened the colours it ' +
      'happened to are listed in effective.outOfGamutColors, so a caller can tell a plain sRGB measurement from ' +
      'one that went through a wide-gamut colour. That ' +
      'canvas is read from the page through the CSS "Canvas" system colour rather than assumed to be white, so a ' +
      'dark-mode page that paints no background of its own composites onto rgb(18, 18, 18) the way it looks on ' +
      'screen; effective.canvasColor reports which one was used. Reading it appends a zero-sized node to the ' +
      'document for the length of one getComputedStyle call and removes it again, the same kind of temporary ' +
      'mutation the states option makes. If that read itself fails, canvasReadFailed is true on the top-level ' +
      'result and the assumed-white fallback is used, so a dark-mode page whose canvas could not be read is not ' +
      'mistaken for one that was genuinely measured white. When any of the unmodelled features above are in play ' +
      'the ratio is a strong hint, not a verdict: look at a screenshot too.',
    inputSchema: z.object({
      sessionId,
      pageId,
      frame: z
        .string()
        .optional()
        .describe('Frame id from list_frames to resolve the selector inside. Defaults to the tab\'s main frame.'),
      selector: z
        .string()
        .describe(
          'Playwright selector (CSS, text=, role=, etc.) for the elements to measure. A frame selectorPrefix from ' +
            'list_frames can be prepended to reach inside an iframe.'
        ),
      properties: z
        .array(z.string().min(1))
        .optional()
        .describe(
          'CSS property names to fetch, in kebab-case, e.g. ["color", "border-bottom-width"]. Defaults to a set ' +
            'covering colour, background colour, font size and weight, line height, border, outline, box-shadow, ' +
            'opacity, display and visibility. Shorthands such as "border" can come back empty when the four sides ' +
            'differ, which is why the longhands are in the default set too.'
        ),
      pseudoElement: z
        .string()
        .optional()
        .describe(
          'Read a pseudo-element instead of the element itself, e.g. "::before" or "::after". The pseudo-element ' +
            'is treated as painting on top of its host, so compositing and contrast account for the host behind it.'
        ),
      states: z
        .array(z.enum(forceablePseudoStates))
        .optional()
        .describe(
          'Pseudo-classes to force while measuring, e.g. ["hover"] or ["focus-visible"], which is how you compare ' +
            'a resting style against a hover or focus style without moving a real pointer. Forced through the ' +
            'Chrome DevTools Protocol, the same mechanism as DevTools\' "force element state", and released again ' +
            'before the call returns. Caveat worth knowing: to address the elements over CDP they are tagged with ' +
            'a temporary data-harborage-probe attribute for the duration of the call, so a page whose CSS or ' +
            'MutationObserver reacts to attribute changes can in principle notice.'
        ),
      all: z
        .boolean()
        .optional()
        .describe(
          'Return every matching element instead of only the first (default false). matched always reports the ' +
            'true total either way, so a selector that quietly matched twelve things is visible without this.'
        ),
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Cap on elements returned when all is true (default 20). Ignored otherwise.')
    }),
    async handler(ctx, args) {
      const target = ctx.sessions.resolve(args.sessionId, args.pageId);
      const frame = resolveFrame(target.page, args.frame);
      const root: Page | Frame = frame ?? target.page;
      const properties = args.properties ?? defaultStyleProperties;
      const limit = args.all ? (args.limit ?? defaultMatchLimit) : 1;
      const matches = root.locator(args.selector);
      const matched = await matches.count();

      interface StyleProbe {
        tagName: string;
        id: string;
        classes: string | null;
        text: string;
        styles: Record<string, string>;
        layers: RawLayer[];
        color: string;
        fontSizePx: number;
        fontWeight: number;
        // False when the ancestor walk below could not reach the document,
        // most often a detached element mid-mutation. See where this is
        // consumed for what that means for the reported ratio.
        reachedRoot: boolean;
      }

      const read = (): Promise<StyleProbe[]> =>
        matches.evaluateAll(
          (nodes, arg: { properties: string[]; pseudoElement: string | null; limit: number }) => {
            const elements = Array.prototype.slice.call(nodes, 0, arg.limit) as ProbeElement[];
            const out: StyleProbe[] = [];
            for (const element of elements) {
              const own = getComputedStyle(element, arg.pseudoElement);
              const styles: Record<string, string> = {};
              for (const property of arg.properties) styles[property] = own.getPropertyValue(property);

              const layers: RawLayer[] = [];
              let node: ProbeElement | null = element;
              while (node) {
                const style = getComputedStyle(node);
                layers.push({
                  tagName: String(node.tagName).toLowerCase(),
                  id: node.id || '',
                  backgroundColor: style.getPropertyValue('background-color'),
                  opacity: style.getPropertyValue('opacity')
                });
                const parent: ProbeElement | null = node.parentElement;
                if (parent) {
                  node = parent;
                  continue;
                }
                // parentElement stops dead at a shadow boundary: the top node
                // inside an open OR closed shadow root has parentElement null
                // even though it is visually painted directly on top of its
                // host. Measured against real Chromium: a <span> at
                // rgb(30, 30, 30) inside a shadow root, on a page painted
                // rgb(10, 10, 10) (a real ratio of about 1.1:1, unreadable),
                // used to stop the walk right there and composite onto an
                // assumed white canvas, reporting a confident 16.6712:1 AA
                // pass. getRootNode().host steps across the boundary onto the
                // host element, which is what actually paints behind the
                // shadow tree, and the loop continues climbing from there.
                const rootNode = node.getRootNode();
                node = rootNode.host ?? null;
              }
              layers.reverse();
              if (arg.pseudoElement) {
                layers.push({
                  tagName: String(element.tagName).toLowerCase() + arg.pseudoElement,
                  id: element.id || '',
                  backgroundColor: own.getPropertyValue('background-color'),
                  opacity: own.getPropertyValue('opacity')
                });
              }

              const text = (element.textContent || '').replace(/\s+/g, ' ').trim();
              out.push({
                tagName: String(element.tagName).toLowerCase(),
                id: element.id || '',
                classes: element.getAttribute('class'),
                text: text.length > 80 ? `${text.slice(0, 80)}...` : text,
                styles,
                layers,
                color: own.getPropertyValue('color'),
                fontSizePx: parseFloat(own.getPropertyValue('font-size')),
                fontWeight: parseFloat(own.getPropertyValue('font-weight')),
                // isConnected follows shadow trees the way the spec requires,
                // so it is true for an element inside a shadow root whose
                // host is itself in the document. Checked on the element
                // itself rather than at each step of the walk above: if the
                // element is connected, the walk is guaranteed to reach the
                // document by climbing parentElement and shadow hosts alone.
                reachedRoot: element.isConnected
              });
            }
            return out;
          },
          { properties, pseudoElement: args.pseudoElement ?? null, limit }
        ) as Promise<StyleProbe[]>;

      const probes =
        args.states !== undefined && args.states.length > 0
          ? await withForcedStates(target.page, root, matches, args.states, read)
          : await read();

      // Asked of the frame the elements are in, not of the page: a same-origin
      // iframe can carry its own color-scheme.
      let canvasReadFailed = false;
      const rawCanvas = await root.evaluate<string>(CANVAS_COLOR_PROBE).catch(() => {
        // A previous round (748d000) replaced an assumed-white canvas with a
        // real read specifically because dark-mode pages were being reported
        // as passing AA on text nobody could read. If the read itself throws
        // (a detached frame, a mid-navigation race), falling back to the same
        // white silently reintroduces exactly that bug with no trace of it in
        // the payload. canvasReadFailed makes the fallback visible instead.
        canvasReadFailed = true;
        return 'rgb(255, 255, 255)';
      });
      const parsedCanvas = parseCssColor(rawCanvas);
      const canvasColor: Rgba = parsedCanvas ?? { ...opaqueWhite };

      const elements = probes.map((probe, index) => {
        const unparsed: string[] = [];
        const clipped: string[] = [];
        if (parsedCanvas?.outOfGamut === true) clipped.push(`canvas: ${rawCanvas}`);
        const paintLayers: PaintLayer[] = probe.layers.map(layer => {
          const parsed = parseCssColor(layer.backgroundColor);
          if (parsed === null) unparsed.push(`${layer.tagName}: ${layer.backgroundColor}`);
          else if (parsed.outOfGamut) clipped.push(`${layer.tagName}: ${layer.backgroundColor}`);
          const opacity = Number(layer.opacity);
          return { bg: parsed ?? { ...fullyTransparent }, opacity: Number.isFinite(opacity) ? opacity : 1 };
        });
        const textColor: ParsedCssColor | null = parseCssColor(probe.color);
        if (textColor === null) unparsed.push(`color: ${probe.color}`);
        else if (textColor.outOfGamut) clipped.push(`color: ${probe.color}`);

        const background = flattenOntoCanvas(paintLayers, { ...fullyTransparent }, canvasColor);
        const foreground = flattenOntoCanvas(paintLayers, textColor ?? { ...fullyTransparent }, canvasColor);
        const largeText = isLargeText(probe.fontSizePx, probe.fontWeight);
        const aaText = largeText ? 3 : 4.5;
        const aaaText = largeText ? 4.5 : 7;
        const ratio = round(contrastRatio(foreground, background), 4);

        return {
          index,
          tagName: probe.tagName,
          ...(probe.id ? { id: probe.id } : {}),
          ...(probe.classes ? { classes: probe.classes } : {}),
          ...(probe.text ? { text: probe.text } : {}),
          ...(args.pseudoElement ? { pseudoElement: args.pseudoElement } : {}),
          styles: probe.styles,
          effective: {
            color: formatRgb(foreground),
            backgroundColor: formatRgb(background),
            canvasColor: formatRgb(canvasColor),
            layers: probe.layers.map((layer, layerIndex) => ({
              tagName: layer.tagName,
              ...(layer.id ? { id: layer.id } : {}),
              backgroundColor: layer.backgroundColor,
              opacity: paintLayers[layerIndex].opacity
            })),
            ...(unparsed.length > 0
              ? {
                  unparsedColors: unparsed,
                  warning:
                    'Some colours could not be parsed and were treated as transparent, so the composited ' +
                    'result and the contrast ratio below are unreliable for this element.'
                }
              : {}),
            ...(clipped.length > 0
              ? {
                  outOfGamutColors: clipped,
                  gamutNote:
                    'These colours fall outside sRGB and were clipped per channel on the way in, which is what ' +
                    'Chromium paints on an sRGB screen. The ratio is right for that rendering. On a wide-gamut ' +
                    'display the colour shown is not exactly this one.'
                }
              : {}),
            ...(probe.reachedRoot === false
              ? {
                  layerChainIncomplete: true,
                  layerChainWarning:
                    'The ancestor walk used to build this stack did not reach the document, most likely because ' +
                    'the element is detached from the page (removed, or measured mid-mutation). There is no real ' +
                    'canvas behind it to composite onto, so the ratio below is not reliable.'
                }
              : {})
          },
          contrast: {
            ratio,
            foreground: formatRgb(foreground),
            background: formatRgb(background),
            fontSizePx: Number.isFinite(probe.fontSizePx) ? probe.fontSizePx : null,
            fontWeight: Number.isFinite(probe.fontWeight) ? probe.fontWeight : null,
            largeText,
            thresholds: { aaText, aaaText, nonText: 3 },
            passes: { aaText: ratio >= aaText, aaaText: ratio >= aaaText, nonText: ratio >= 3 }
          }
        };
      });

      return text({
        pageId: target.pageId,
        ...(args.frame !== undefined ? { frame: args.frame } : {}),
        selector: args.selector,
        ...(args.states !== undefined && args.states.length > 0 ? { forcedStates: args.states } : {}),
        matched,
        returned: elements.length,
        properties,
        ...(canvasReadFailed
          ? {
              canvasReadFailed: true,
              canvasWarning:
                'The page\'s Canvas system colour could not be read, so every element below falls back to an ' +
                'assumed rgb(255, 255, 255) background. On a dark-mode page that fallback is wrong, and every ' +
                'ratio composited against it is unreliable.'
            }
          : {}),
        elements
      });
    }
  }),

  element_box: defineTool({
    description:
      'Measure elements: bounding box, client and scroll dimensions, whether they are inside the viewport, ' +
      'whether they are really visible, and whether anything would take a click aimed at them. ' +
      'It takes a list of selectors rather than one, because the question that actually comes up is a comparison ' +
      '("are these three left-aligned?", "is this row taller than that one?") and one call is far cheaper and far ' +
      'easier to read than one call per element. ' +
      'Coordinates are CSS pixels relative to the top left of the viewport, exactly what getBoundingClientRect ' +
      'returns, which is also the coordinate space screenshot\'s clip expects. documentBox is the same point with ' +
      'the current scroll offset added, for comparing things that are not on screen together. Inside an iframe ' +
      'the coordinates are relative to that frame\'s own viewport, not the page\'s. ' +
      'visible is Chromium\'s own checkVisibility (so an ancestor being display:none counts) plus a non-zero box, ' +
      'and hiddenReasons says which test failed rather than leaving you to guess. topmostAtCentre is a HIT TEST, ' +
      'not a paint test: false means something else would receive a click there, and occludedBy names it, which is ' +
      'how a fully transparent overlay that swallows clicks gets caught. The mirror case is the one to watch: an ' +
      'opaque overlay with pointer-events: none completely hides an element on screen while this still reports ' +
      'topmostAtCentre true and occludedBy null, correctly, because the click does reach through it. The hit test ' +
      'accounts for shadow DOM: an element inside an open or closed shadow root that is genuinely unoccluded ' +
      'reports topmostAtCentre true and occludedBy null, not the shadow host, because the point is re-tested ' +
      'against the shadow root itself rather than trusted at the host it retargets to first. An actual overlay ' +
      'sitting on top of that element inside the same shadow root is still caught, at whatever nesting depth of ' +
      'shadow roots it is at. For "is it actually visible to a human", take a screenshot. ' +
      'The point tested comes back as hitTestPoint, with hitTestPointIsCentre alongside it, because an element ' +
      'whose centre falls outside the viewport is tested at the nearest point inside it instead: without that, ' +
      'occludedBy could name something sitting nowhere near the middle of the element. ' +
      'What it does NOT do: it never waits. A selector whose element has not rendered yet comes back as ' +
      'matched: 0, not as a timeout, so settle the page first. It hit-tests one point, so an element covered only ' +
      'at its edges still reports topmostAtCentre true. It does not tell you what an element looks like: use ' +
      'computed_style for colour and screenshot for pixels.',
    inputSchema: z.object({
      sessionId,
      pageId,
      frame: z
        .string()
        .optional()
        .describe('Frame id from list_frames to resolve the selectors inside. Defaults to the tab\'s main frame.'),
      selectors: z
        .array(z.string().min(1))
        .min(1)
        .describe(
          'Playwright selectors to measure, one result block per selector, in the order given. A frame ' +
            'selectorPrefix from list_frames can be prepended to any of them.'
        ),
      all: z
        .boolean()
        .optional()
        .describe('Return every element each selector matches instead of only the first (default false).'),
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Cap on elements returned per selector when all is true (default 20). Ignored otherwise.')
    }),
    async handler(ctx, args) {
      const target = ctx.sessions.resolve(args.sessionId, args.pageId);
      const frame = resolveFrame(target.page, args.frame);
      const root: Page | Frame = frame ?? target.page;
      const limit = args.all ? (args.limit ?? defaultMatchLimit) : 1;

      const viewport = await root.evaluate(() => ({
        width: window.innerWidth,
        height: window.innerHeight,
        scrollX: window.scrollX,
        scrollY: window.scrollY,
        devicePixelRatio: window.devicePixelRatio
      }));

      const results = [];
      for (const selector of args.selectors) {
        const matches = root.locator(selector);
        const matched = await matches.count();
        const elements =
          matched === 0
            ? []
            : await matches.evaluateAll((nodes, arg: { limit: number }) => {
                // No inner named functions in an in-page snippet: esbuild's
                // keep-names transform (which the test runner applies) rewrites
                // them into calls to a __name helper that does not exist in the
                // page, and the snippet dies with a ReferenceError.
                const scrolls = ['auto', 'scroll', 'overlay'];
                const elements = Array.prototype.slice.call(nodes, 0, arg.limit) as ProbeElement[];
                return elements.map((element, index) => {
                  const rect = element.getBoundingClientRect();
                  const style = getComputedStyle(element);
                  const isRoot = element === document.documentElement || element === document.body;
                  const overflowX = style.getPropertyValue('overflow-x');
                  const overflowY = style.getPropertyValue('overflow-y');
                  const scrollable =
                    ((isRoot || scrolls.indexOf(overflowY) >= 0) && element.scrollHeight > element.clientHeight + 1) ||
                    ((isRoot || scrolls.indexOf(overflowX) >= 0) && element.scrollWidth > element.clientWidth + 1);

                  const rendered =
                    typeof element.checkVisibility === 'function'
                      ? element.checkVisibility({
                          checkOpacity: true,
                          checkVisibilityCSS: true,
                          opacityProperty: true,
                          visibilityProperty: true,
                          contentVisibilityAuto: true
                        })
                      : rect.width > 0 && rect.height > 0;
                  const visible = rendered && rect.width > 0 && rect.height > 0;

                  const hiddenReasons: string[] = [];
                  if (style.getPropertyValue('display') === 'none') hiddenReasons.push('display: none on the element itself');
                  const visibility = style.getPropertyValue('visibility');
                  if (visibility !== 'visible') hiddenReasons.push(`visibility: ${visibility}`);
                  if (parseFloat(style.getPropertyValue('opacity')) === 0) hiddenReasons.push('opacity: 0');
                  if (rect.width === 0 || rect.height === 0) hiddenReasons.push('the element has a zero-sized box');
                  if (!visible && hiddenReasons.length === 0) {
                    hiddenReasons.push('not rendered, most likely because an ancestor is display: none, hidden, or fully transparent');
                  }

                  const overlapX = Math.max(0, Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0));
                  const overlapY = Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0));
                  const area = rect.width * rect.height;
                  const coverage = area > 0 ? (overlapX * overlapY) / area : 0;
                  const inViewport = coverage > 0;

                  let topmostAtCentre: boolean | null = null;
                  let occludedBy: { tagName: string; id: string; classes: string | null } | null = null;
                  let hitTestPoint: { x: number; y: number } | null = null;
                  let hitTestPointIsCentre: boolean | null = null;
                  if (inViewport && visible) {
                    // Clamped into the viewport, because elementFromPoint answers
                    // null outside it. That means the point tested is NOT the
                    // centre whenever the centre is off screen, and an unrelated
                    // element sitting at the clamped point would otherwise be
                    // reported as occluding this one under a field called
                    // topmostAtCentre. Both the point and the fact that it moved
                    // are reported for that reason.
                    const trueX = rect.left + rect.width / 2;
                    const trueY = rect.top + rect.height / 2;
                    const centreX = Math.min(Math.max(trueX, 0), window.innerWidth - 1);
                    const centreY = Math.min(Math.max(trueY, 0), window.innerHeight - 1);
                    hitTestPoint = { x: Math.round(centreX * 100) / 100, y: Math.round(centreY * 100) / 100 };
                    hitTestPointIsCentre = centreX === trueX && centreY === trueY;
                    // document.elementFromPoint retargets into the shadow host for
                    // ANYTHING inside a shadow tree, open or closed, and
                    // Node.contains() does not cross that boundary the other way:
                    // confirmed directly against real Chromium, a shadow host does
                    // not contain() its own shadow content, because a node's parent
                    // inside a shadow tree is the shadow root, not the host. So a
                    // plain unoccluded <button> inside an open shadow root, nothing
                    // on top of it, came back with hit equal to its own host
                    // <div id="host">, topmostAtCentre false and occludedBy naming
                    // the host, a fabricated overlay on every web component on the
                    // page. Loosening the check to also accept hit.contains(element)
                    // would not have rescued that case either, for the same reason:
                    // it still needs hit to actually BE (an ancestor of) element,
                    // and the host never is. What actually fixes it is recovering
                    // the real topmost node so the comparison has something true to
                    // find, which is also what keeps a real overlay honest: an
                    // overlay sitting on top of the element inside the SAME shadow
                    // root drills down to become `hit` itself, a SIBLING of
                    // element, not an ancestor, so it still fails every comparison
                    // and is reported as the occluder. ShadowRoot.elementFromPoint,
                    // unlike Document's, does not retarget, so re-querying the same
                    // point against
                    // hit.shadowRoot recovers what is actually topmost inside the
                    // shadow tree, and repeating it handles shadow roots nested in
                    // shadow roots. hitTestPointerPoint in interaction.ts (drag and
                    // wheel's hit test) runs the identical drill for the identical
                    // reason; kept as a second copy rather than a shared helper
                    // because both run as in-page snippets under a tsconfig with no
                    // dom lib, each with its own minimal element shim, so sharing
                    // would cost more than it saves. If one changes, change the
                    // other.
                    let hit = document.elementFromPoint(centreX, centreY);
                    let shadowDrillDepth = 0;
                    while (hit && hit.shadowRoot && typeof hit.shadowRoot.elementFromPoint === 'function' && shadowDrillDepth < 20) {
                      const deeper = hit.shadowRoot.elementFromPoint(centreX, centreY);
                      if (!deeper || deeper === hit) break;
                      hit = deeper;
                      shadowDrillDepth += 1;
                    }
                    if (hit) {
                      topmostAtCentre = hit === element || element.contains(hit) || hit.contains(element);
                      if (!topmostAtCentre) {
                        occludedBy = {
                          tagName: String(hit.tagName).toLowerCase(),
                          id: hit.id || '',
                          classes: hit.getAttribute('class')
                        };
                      }
                    }
                  }

                  return {
                    index,
                    tagName: String(element.tagName).toLowerCase(),
                    id: element.id || '',
                    box: {
                      x: Math.round(rect.x * 100) / 100,
                      y: Math.round(rect.y * 100) / 100,
                      width: Math.round(rect.width * 100) / 100,
                      height: Math.round(rect.height * 100) / 100
                    },
                    documentBox: {
                      x: Math.round((rect.left + window.scrollX) * 100) / 100,
                      y: Math.round((rect.top + window.scrollY) * 100) / 100
                    },
                    client: { width: element.clientWidth, height: element.clientHeight },
                    scroll: {
                      width: element.scrollWidth,
                      height: element.scrollHeight,
                      top: Math.round(element.scrollTop * 100) / 100,
                      left: Math.round(element.scrollLeft * 100) / 100
                    },
                    scrollable,
                    inViewport,
                    viewportCoverage: Math.round(coverage * 100) / 100,
                    visible,
                    hiddenReasons,
                    topmostAtCentre,
                    occludedBy,
                    hitTestPoint,
                    hitTestPointIsCentre,
                    position: style.getPropertyValue('position'),
                    zIndex: style.getPropertyValue('z-index')
                  };
                });
              }, { limit });

        results.push({ selector, matched, returned: elements.length, elements });
      }

      return text({
        pageId: target.pageId,
        ...(args.frame !== undefined ? { frame: args.frame } : {}),
        viewport,
        results
      });
    }
  }),

  list_frames: defineTool({
    description:
      'List every frame in a session\'s tab: the main frame plus each iframe, nested ones included. ' +
      'Each entry carries a frameId, which evaluate, snapshot, computed_style, element_box and find accept as ' +
      'their "frame" argument, and a selectorPrefix, which is the thing that makes the rest of harborage work ' +
      'inside an iframe: prepend it to any selector and click, fill, screenshot, computed_style and element_box ' +
      'will resolve that selector inside the frame, with no frame argument of their own. So ' +
      '"iframe >> nth=0 >> internal:control=enter-frame >> #submit" is a perfectly good selector for click. ' +
      'Frame ids are positional paths ("main", "main/0", "main/0/1") derived from the live page rather than ' +
      'stored, because harborage keeps no per-session state. The consequence is worth planning around: they ' +
      'shift when the page adds or removes an iframe, so read them again after a navigation rather than caching ' +
      'one. ' +
      'A prefix is safe to paste in front of a selector you pass to find as well, and find will tell you where it ' +
      'landed: its "resolvedFrame" is read back off the matched element rather than assumed, and the selectors it ' +
      'returns are re-qualified from the main document, so they already carry the whole chain and must NOT be ' +
      'prefixed a second time. Two prefixes in a row try to enter a frame twice and match nothing. ' +
      'One trap worth knowing about the raw prefix form: "iframe >> internal:control=enter-frame" with several ' +
      'iframes in the document silently enters the FIRST one rather than complaining, which is why the prefixes ' +
      'here always pin an explicit "nth=". Keep the nth when you paste one. ' +
      'THAT nth IS POSITIONAL, exactly like the frame ids, and it goes stale the same way: it means "the Nth iframe ' +
      'in the document right now", so a page that inserts an iframe ahead of the target one leaves the prefix ' +
      'pointing at a different frame, with no error, and a click through it presses whatever is in that one ' +
      'instead. A prefix is a snapshot, not a handle. Re-read it after anything that could add or remove an ' +
      'iframe, which includes ads, consent banners, embedded players and any lazy mount, and prefer acting soon ' +
      'after reading rather than caching one across steps. ' +
      'What it does NOT do: it does not reach into shadow DOM. For an ELEMENT that is fine, because Playwright ' +
      'selectors already pierce open shadow roots on their own and need no prefix. For a FRAME it is the one case ' +
      'that cannot be served at all: an iframe living inside a shadow root has no addressable owning element, so ' +
      'no prefix can be built for it and selectorPrefixUnavailable is what comes back. Reach into such a frame ' +
      'with evaluate, snapshot, computed_style, element_box or find using its frameId, which need no prefix. ' +
      'A frame that is still loading may report about:blank. A cross-origin frame is listed and reachable the ' +
      'same way as a same-origin one, but its selectorPrefix is missing if its owning element could not be read.',
    inputSchema: z.object({ sessionId, pageId }),
    async handler(ctx, args) {
      const target = ctx.sessions.resolve(args.sessionId, args.pageId);
      const nodes = frameTree(target.page);
      const frames = await Promise.all(
        nodes.map(async node => {
          const selectorPrefix = await frameSelectorPrefix(target.page, node.frame);
          return {
            frameId: node.frameId,
            ...(node.parentFrameId !== undefined ? { parentFrameId: node.parentFrameId } : {}),
            isMainFrame: node.frameId === 'main',
            name: node.frame.name(),
            url: node.frame.url(),
            detached: node.frame.isDetached(),
            ...(selectorPrefix !== undefined
              ? { selectorPrefix }
              : {
                  selectorPrefixUnavailable:
                    'the owning iframe element could not be read, so no selector can reach into this frame from ' +
                    'outside and this frame is reachable only by frameId. The usual cause is an iframe living ' +
                    'inside a shadow root: the prefix builder indexes iframes with document.getElementsByTagName, ' +
                    'which does not pierce shadow roots. Do NOT substitute an empty prefix, since a bare selector ' +
                    'resolves in the MAIN document instead of this frame and click would press whatever it happens ' +
                    'to hit there. Use evaluate, snapshot, computed_style, element_box or find with frame set to ' +
                    'this frameId, all of which take a frame id directly and need no prefix.'
                })
          };
        })
      );

      return text({ pageId: target.pageId, url: target.page.url(), count: frames.length, frames });
    }
  }),

  find: defineTool({
    description:
      'Locate elements and get back a selector you can hand straight to click, fill or screenshot. ' +
      'That is the point of it. snapshot returns accessibility-tree refs like "ref=e12", and those refs are NOT ' +
      'accepted by click or fill, so an agent that found something in a snapshot still has to re-derive a ' +
      'selector for it. find closes that loop from the other end: every result carries a selector that has been ' +
      'checked against the live page, with selectorHits (how many elements it really resolves to), ' +
      'resolvesToTarget (whether one of them is the element described here) and unique (both, exactly once). ' +
      'READ resolvesToTarget BEFORE USING A SELECTOR: false means it points somewhere else, or nowhere. That ' +
      'happens for an element inside a shadow root, which Playwright finds but a CSS path cannot reach, and the ' +
      'result carries a note whenever it does. ' +
      'FRAMES: every selector returned is absolute from the MAIN document, already carrying whatever ' +
      '">> internal:control=enter-frame >>" chain is needed to reach the element, so hand it to click or fill as ' +
      'it is and never prefix it a second time. How the search reached the frame does not matter: the frame ' +
      'argument, a selectorPrefix from list_frames pasted inside the selector, or a selector that steps several ' +
      'frames deeper than either. "resolvedFrame" reports the frame id the matches ACTUALLY resolved in, read ' +
      'back off the element itself rather than assumed from the frame argument, and a "frameNote" appears ' +
      'whenever that is not the frame you asked about, which is what a selector crossing a boundary of its own ' +
      'looks like. This matters because resolvesToTarget is checked in the document the matches resolved in, so a ' +
      'selector certified in one document and run by the caller in another certifies nothing: that is how a ' +
      '"Confirm payment" button inside an iframe used to come back as a bare path that pressed "Delete account" ' +
      'in the page behind it. When the owning iframe element cannot be read at all (for instance because the ' +
      'iframe sits inside a shadow root), no working selector can be composed: every result comes back with ' +
      'selector null and a top-level frameSelectorUnavailable explaining why, rather than a selector that looks ' +
      'fine but actually runs in the wrong document. Reach those elements with evaluate, snapshot, computed_style ' +
      'or element_box and a frame id instead. ONE CAVEAT ON THOSE FRAME-CROSSING SELECTORS: the "nth=" pinned into ' +
      'the prefix is positional, so it means "the Nth iframe in the document right now". If the page inserts an ' +
      'iframe ahead of the target one before you act, the same selector quietly enters a different frame and ' +
      'clicks whatever is there, reporting a perfectly ordinary success. It is the same staleness the element ' +
      'path below has, one level up. Act on a frame-crossing selector promptly, and re-run find rather than ' +
      'reusing one across steps on a page that mounts iframes as it goes. Search by ' +
      'visible text, by ARIA role and accessible name, by test id, or by a raw selector, and combine a raw ' +
      'selector with the others to scope the search to part of the page. ' +
      'Each result also carries the element\'s tag, trimmed text, key attributes, box, and whether it is visible ' +
      'and enabled, so choosing between several candidates rarely needs a second call. ' +
      'What it does NOT do: it does not compute ARIA roles or the full accessibility tree, which is snapshot\'s ' +
      'job, and it does not click anything. It does not wait for elements to appear. By default it returns only ' +
      'visible elements, so a result of zero can mean "present but hidden": re-run with visibleOnly false to ' +
      'tell those two apart. The generated selector is a snapshot of the DOM as it is right now, so a ' +
      'position-based one (an nth-of-type path, used when the element has no id or test id) can go stale if the ' +
      'page re-renders in between.',
    inputSchema: z.object({
      sessionId,
      pageId,
      frame: z
        .string()
        .optional()
        .describe(
          'Frame id from list_frames to search inside. Returned selectors come back already carrying the prefix ' +
            'for whichever frame the matches really landed in, so they work with click and fill as they are. ' +
            'Optional even for a frame: a selectorPrefix pasted inside "selector" reaches the same place, and ' +
            'either way "resolvedFrame" reports where the search actually ended up.'
        ),
      selector: z
        .string()
        .optional()
        .describe(
          'Raw Playwright selector. On its own it is the search. Combined with role, text or testId it scopes ' +
            'the search to the descendants of what it matches.'
        ),
      role: z
        .string()
        .optional()
        .describe('ARIA role to match, e.g. "button", "link", "textbox", "heading". Pair with name to narrow it.'),
      name: z
        .string()
        .optional()
        .describe('Accessible name to match alongside role. Substring and case-insensitive unless exact is true.'),
      text: z
        .string()
        .optional()
        .describe('Visible text to match. Substring and case-insensitive unless exact is true.'),
      testId: z.string().optional().describe('Value of the element\'s data-testid attribute.'),
      exact: z
        .boolean()
        .optional()
        .describe('Match name and text exactly, case-sensitively and whole-string (default false).'),
      visibleOnly: z
        .boolean()
        .optional()
        .describe(
          'Only return elements that are actually visible (default true). Set false to find something that is ' +
            'present but hidden, which is the difference between "not rendered" and "rendered but invisible".'
        ),
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Cap on elements returned (default 20). matched still reports the true total.')
    }),
    async handler(ctx, args) {
      if (args.selector === undefined && args.role === undefined && args.text === undefined && args.testId === undefined) {
        throw new Error(
          'find needs something to search for: pass selector, role, text or testId. Passing a selector alone ' +
            'searches with it; passing it alongside role, text or testId scopes the search to its descendants.'
        );
      }

      const target = ctx.sessions.resolve(args.sessionId, args.pageId);
      const frame = resolveFrame(target.page, args.frame);
      const root: Page | Frame = frame ?? target.page;
      const limit = args.limit ?? defaultMatchLimit;
      const exact = args.exact ?? false;

      const scope: Locator = root.locator(args.selector ?? ':root');
      let matches: Locator;
      if (args.role !== undefined) {
        matches = scope.getByRole(args.role as Parameters<Locator['getByRole']>[0], {
          ...(args.name !== undefined ? { name: args.name, exact } : {})
        });
      } else if (args.testId !== undefined) {
        matches = scope.getByTestId(args.testId);
      } else if (args.text !== undefined) {
        matches = scope.getByText(args.text, { exact });
      } else {
        matches = scope;
      }
      if (args.visibleOnly !== false) matches = matches.filter({ visible: true });

      const matched = await matches.count();

      // WHICH DOCUMENT WILL THE RETURNED SELECTOR RUN IN? Everything below
      // hangs off answering that honestly, because resolvesToTarget is
      // computed by evaluateAll, which runs in whichever document the matches
      // resolved in, while the selector it certifies is run by the caller
      // wherever the emitted prefix points. When those two documents are not
      // the same, resolvesToTarget certifies nothing.
      //
      // The `frame` ARGUMENT is not a safe answer to that question. A
      // Playwright selector crosses frames on its own through
      // ">> internal:control=enter-frame >>", which is exactly what
      // list_frames tells agents to paste in front of a selector, so the
      // matches can end up one or more frames away from wherever the argument
      // pointed. Probed on a real page: `find` with the prefix inside the
      // selector and no `frame` argument returned a bare
      // "html > body > button", certified inside the iframe, and the
      // follow-up click pressed "Delete account" in the main document. The
      // same thing happened with `frame` set and the selector reaching one
      // frame deeper than the prefix. So the frame is read back off a
      // resolved element instead, and the prefix is rebuilt from THAT frame,
      // which makes the emitted selector absolute from the main document and
      // unambiguous (an ambiguous "iframe >> internal:control=enter-frame"
      // silently takes the first iframe; the rebuilt prefix pins the index).
      const searchRoot = frame ?? target.page.mainFrame();
      const resolutionFrame = matched === 0 ? searchRoot : await locatorResolutionFrame(matches, searchRoot);
      const resolvedFrame = frameIdOf(target.page, resolutionFrame);
      // frameSelectorPrefix returns undefined when the owning iframe element
      // could not be addressed (list_frames hits the same case, and reports
      // it as selectorPrefixUnavailable rather than guessing). The most
      // common cause is an iframe living inside a shadow root: the segment
      // builder indexes it with document.getElementsByTagName, which does
      // not pierce shadow roots. Falling back to '' here used to be silent:
      // a selector meant to enter a frame came back with no prefix at all,
      // and click then ran it against the MAIN document instead. When the
      // prefix is unavailable no usable selector is emitted at all: see
      // frameSelectorUnavailable below.
      const framePrefix = await frameSelectorPrefix(target.page, resolutionFrame);
      const frameSelectorUnavailable = framePrefix === undefined;
      const prefix = framePrefix ?? '';
      // The matches came from a different frame than the caller asked about,
      // which is worth saying out loud: the caller's own selector took them
      // there, and the selectors handed back are re-qualified from the main
      // document rather than being the caller's prefix plus a path.
      const crossedFrame = resolvedFrame !== (args.frame ?? 'main');

      const elements =
        matched === 0
          ? []
          : await matches.evaluateAll((nodes, arg: { limit: number; attributes: string[] }) => {
              // Deliberately written without any inner named function: esbuild's
              // keep-names transform (which the test runner applies) rewrites
              // those into calls to a __name helper that does not exist in the
              // page, and the whole snippet dies with a ReferenceError.
              const found = Array.prototype.slice.call(nodes, 0, arg.limit) as ProbeElement[];
              return found.map((element, index) => {
                // Candidate selectors, most durable first. The last one is a
                // positional path, which always exists but goes stale fastest.
                const candidates: string[] = [];
                const tag = String(element.tagName).toLowerCase();
                if (element.id) candidates.push(`#${CSS.escape(element.id)}`);
                for (const attribute of ['data-testid', 'data-test-id', 'data-test', 'name']) {
                  const value = element.getAttribute(attribute);
                  if (value) candidates.push(`${tag}[${attribute}="${value.replace(/(["\\])/g, '\\$1')}"]`);
                }

                const parts: string[] = [];
                let node: ProbeElement | null = element;
                while (node) {
                  if (node === document.documentElement) {
                    parts.unshift('html');
                    break;
                  }
                  const nodeTag = String(node.tagName).toLowerCase();
                  const parent: ProbeElement | null = node.parentElement;
                  if (!parent) {
                    parts.unshift(nodeTag);
                    break;
                  }
                  let position = 0;
                  let total = 0;
                  for (let sibling = 0; sibling < parent.children.length; sibling += 1) {
                    const child = parent.children[sibling];
                    if (String(child.tagName).toLowerCase() !== nodeTag) continue;
                    total += 1;
                    if (child === node) position = total;
                  }
                  parts.unshift(total > 1 ? `${nodeTag}:nth-of-type(${position})` : nodeTag);
                  node = parent;
                }
                candidates.push(parts.join(' > '));

                let selector = candidates[candidates.length - 1];
                let unique = false;
                for (const candidate of candidates) {
                  let hits: ArrayLike<ProbeElement> | null = null;
                  try {
                    hits = document.querySelectorAll(candidate);
                  } catch {
                    hits = null;
                  }
                  if (hits !== null && hits.length === 1 && hits[0] === element) {
                    selector = candidate;
                    unique = true;
                    break;
                  }
                }

                // unique false was the only signal, and it reads as "several
                // candidates, pick carefully". The worse case it was hiding is a
                // selector that resolves to a DIFFERENT element, or to nothing:
                // the positional path is built by walking parentElement, which
                // stops dead at a shadow boundary, so an element inside an open
                // shadow root yields a path relative to the shadow root that the
                // document may well match somewhere else entirely. Playwright
                // pierces shadow roots and click does not require uniqueness, so
                // that selector went straight into a click on the wrong thing.
                let selectorHits = 0;
                let resolvesToTarget = false;
                try {
                  const resolved = document.querySelectorAll(selector);
                  selectorHits = resolved.length;
                  for (let i = 0; i < resolved.length; i += 1) {
                    if (resolved[i] === element) resolvesToTarget = true;
                  }
                } catch {
                  selectorHits = 0;
                }
                const inShadowRoot = (element as unknown as { getRootNode(): unknown }).getRootNode() !== document;

                const rect = element.getBoundingClientRect();
                const attributes: Record<string, string> = {};
                for (const attribute of arg.attributes) {
                  const value = element.getAttribute(attribute);
                  if (value !== null) attributes[attribute] = value;
                }
                const rendered =
                  typeof element.checkVisibility === 'function'
                    ? element.checkVisibility({
                        checkOpacity: true,
                        checkVisibilityCSS: true,
                        opacityProperty: true,
                        visibilityProperty: true,
                        contentVisibilityAuto: true
                      })
                    : rect.width > 0 && rect.height > 0;
                const raw = (element.textContent || '').replace(/\s+/g, ' ').trim();
                return {
                  index,
                  selector,
                  unique,
                  selectorHits,
                  resolvesToTarget,
                  inShadowRoot,
                  tagName: tag,
                  text: raw.length > 120 ? `${raw.slice(0, 120)}...` : raw,
                  attributes,
                  visible: rendered && rect.width > 0 && rect.height > 0,
                  enabled: !element.hasAttribute('disabled') && element.getAttribute('aria-disabled') !== 'true',
                  box: {
                    x: Math.round(rect.x * 100) / 100,
                    y: Math.round(rect.y * 100) / 100,
                    width: Math.round(rect.width * 100) / 100,
                    height: Math.round(rect.height * 100) / 100
                  }
                };
              });
            }, {
              limit,
              attributes: [
                'id',
                'name',
                'type',
                'role',
                'href',
                'value',
                'title',
                'alt',
                'placeholder',
                'aria-label',
                'data-testid'
              ]
            });

      // The prefix is unavailable, so no result below can carry a working
      // selector: composing one with an empty prefix would silently resolve
      // in the wrong document (see the comment where framePrefix is
      // computed). Every selector comes back null rather than guessing.
      if (frameSelectorUnavailable) {
        return text({
          pageId: target.pageId,
          ...(args.frame !== undefined ? { frame: args.frame } : {}),
          ...(resolvedFrame !== undefined ? { resolvedFrame } : {}),
          matched,
          returned: elements.length,
          frameSelectorUnavailable:
            `these elements resolved inside frame ${JSON.stringify(resolvedFrame ?? 'unknown')}, and the owning ` +
            'iframe element for it could not be read (often because it sits inside a shadow root), so no selector ' +
            'can be built that reaches into it from outside. Every selector below is null for that reason: do not ' +
            'substitute a bare or empty prefix, since that would resolve in the main document instead of this ' +
            'frame and click would press whatever it happens to hit there. Use evaluate, snapshot, computed_style ' +
            'or element_box with frame set to this id instead, which take a frame id directly and need no prefix.',
          elements: elements.map(element => ({ ...element, selector: null, resolvesToTarget: false }))
        });
      }

      const unusable = elements.filter(element => !element.resolvesToTarget);
      const crossedFrameNote = crossedFrame
        ? `These elements resolved inside frame ${JSON.stringify(resolvedFrame ?? 'unknown')}, not ` +
          `${JSON.stringify(args.frame ?? 'main')}: the selector you passed crossed a frame boundary of its own ` +
          '(that is what ">> internal:control=enter-frame >>" does). Every selector below has been re-qualified ' +
          'from the MAIN document to reach that frame, so hand them to click or fill as they are rather than ' +
          'prefixing them again, which would try to enter a frame twice.'
        : undefined;
      return text({
        pageId: target.pageId,
        ...(args.frame !== undefined ? { frame: args.frame } : {}),
        ...(resolvedFrame !== undefined ? { resolvedFrame } : {}),
        matched,
        returned: elements.length,
        ...(crossedFrameNote !== undefined ? { frameNote: crossedFrameNote } : {}),
        ...(unusable.length > 0
          ? {
              note:
                `${unusable.length} of the ${elements.length} selector(s) below do NOT resolve to the element they ` +
                'describe: resolvesToTarget is false. ' +
                (unusable.some(element => element.inShadowRoot)
                  ? 'These elements live inside a shadow root, and a CSS path cannot cross that boundary, so the ' +
                    'generated path is relative to the shadow root and the document may match something else with ' +
                    'it. Reach them through their host component instead, or through a testId or id the host ' +
                    'exposes. '
                  : '') +
                'Do NOT hand such a selector to click or fill: click acts on the first match without complaining, ' +
                'so it would press whatever else the selector happens to hit.'
            }
          : {}),
        elements: elements.map(element => ({ ...element, selector: `${prefix}${element.selector}` }))
      });
    }
  }),

  send_cdp_command: defineTool({
    description:
      'Send a raw Chrome DevTools Protocol command directly to a session\'s tab and get the structured result back. ' +
      'This is the agent-facing counterpart to escalate_session\'s human-facing CDP access. ' +
      'IT ATTACHES A FRESH DEVTOOLS SESSION PER CALL AND DETACHES BEFORE RETURNING, and that makes a whole class ' +
      'of commands silently useless here: Chromium scopes every Emulation.set*Override to the session that set it ' +
      'and reverts it the instant that session detaches, so Emulation.setUserAgentOverride, setTimezoneOverride, ' +
      'setLocaleOverride and setDeviceMetricsOverride all return a clean success while the override is already ' +
      'gone by the time you read it. Network.emulateNetworkConditions goes the same way. Use set_user_agent, ' +
      'set_timezone, set_locale, resize, set_offline and set_network_conditions instead: those hold a CDP session ' +
      'open for the life of the tab, which is the only way any of it sticks. ' +
      'Not for captures: Page.captureScreenshot hands back bare base64 with no dimensions and no route into the ' +
      'screenshot cache, so use the screenshot tool, with selector or clip, for anything you want to look at. ' +
      'The Browser and Target domains are REFUSED, because Chromium routes them to the browser rather than to your ' +
      'tab: through them one session could list, close and even open tabs inside other sessions, and close the ' +
      'shared Chromium every session on this machine is using. Use list_tabs, new_tab, close_tab and select_tab for ' +
      'your own tabs instead. Target.getTargetInfo about your own tab (no targetId) is still allowed. ' +
      'Also note this tool DETACHES after every call, so any Emulation.set*Override sent through it is reverted ' +
      'before the result comes back: use set_user_agent, set_timezone, set_locale and set_network_conditions, which ' +
      'hold their CDP session open.',
    inputSchema: z.object({
      sessionId,
      pageId,
      method: z
        .string()
        .describe('Chrome DevTools Protocol method name, e.g. "Page.getLayoutMetrics" or "Network.getResponseBody".'),
      params: z.unknown().optional().describe('Params object for the CDP method, if the method takes any.')
    }),
    async handler(ctx, args) {
      // Before resolving anything: a command that would leave this session is
      // refused outright rather than sent and then regretted.
      const refusal = cdpScopeRefusal(args.method, args.params);
      if (refusal !== null) throw new Error(refusal);

      const target = ctx.sessions.resolve(args.sessionId, args.pageId);
      const cdpSession = await target.session.context.newCDPSession(target.page);
      try {
        // `method` is a runtime string, not one of Playwright's literal CDP
        // method types. This is deliberately the agent-facing "raw" escape
        // hatch, so the cast is the point, not a workaround. Called directly
        // on `cdpSession` (not detached into a standalone function) so its
        // internal `this` binding stays intact.
        const result = await cdpSession.send(args.method as Parameters<typeof cdpSession.send>[0], args.params as never);
        return text({ sessionId: args.sessionId, pageId: target.pageId, method: args.method, result });
      } finally {
        await cdpSession.detach().catch(() => {});
      }
    }
  })
});
