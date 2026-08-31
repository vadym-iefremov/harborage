import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Frame, Locator, Page } from 'playwright';
import * as z from 'zod/v4';

import { sessionCacheDir } from '../../screenshotCache.js';
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

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const opaqueWhite: Rgba = { r: 255, g: 255, b: 255, a: 1 };
const fullyTransparent: Rgba = { r: 0, g: 0, b: 0, a: 0 };

/**
 * Parses the colour syntaxes getComputedStyle actually returns in Chromium:
 * "rgb(r, g, b)", "rgba(r, g, b, a)" and the keyword "transparent". Anything
 * else (a wide-gamut color() function, say) returns null, and the caller
 * reports that it could not composite rather than inventing a number.
 */
export function parseCssColor(value: string): Rgba | null {
  const raw = value.trim().toLowerCase();
  if (raw === 'transparent') return { ...fullyTransparent };
  const match = /^rgba?\(([^)]*)\)$/.exec(raw);
  if (!match) return null;
  const parts = match[1].split(/[\s,/]+/).filter(part => part.length > 0);
  if (parts.length < 3) return null;
  const channel = (part: string): number =>
    part.endsWith('%') ? (Number(part.slice(0, -1)) * 255) / 100 : Number(part);
  const alphaPart = parts[3];
  const alpha =
    alphaPart === undefined ? 1 : alphaPart.endsWith('%') ? Number(alphaPart.slice(0, -1)) / 100 : Number(alphaPart);
  const color: Rgba = { r: channel(parts[0]), g: channel(parts[1]), b: channel(parts[2]), a: alpha };
  if (![color.r, color.g, color.b, color.a].every(n => Number.isFinite(n))) return null;
  return color;
}

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
 * an opaque white canvas. White because that is what a browser paints behind
 * a page that declares no background of its own, and because the stack
 * already includes the document root, so a page that does declare one has
 * covered it before this matters.
 */
function flattenOntoCanvas(layers: PaintLayer[], innermost: Rgba): Rgba {
  if (layers.length === 0) return over(innermost, opaqueWhite);
  return over(paintGroup(layers, 0, innermost), opaqueWhite);
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
      'assumed is visible without opening the file. ' +
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
      '(HARBORAGE_CONSOLE_BUFFER_SIZE, 200 by default) and drops the oldest messages once full, so a message that ' +
      'is missing may have been evicted rather than never logged. Every result reports total (messages in the ' +
      'buffer) next to returned (messages that matched), so you can see how much a filter hid. ' +
      'clear: true drains the entire buffer for the session, not only the messages a filter returned.',
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
      const entries = ctx.sessions.getConsoleMessages(args.sessionId, args.pageId, args.clear ?? false);
      const wanted = args.types !== undefined ? new Set(args.types.map(t => t.toLowerCase())) : undefined;
      const needle = args.textIncludes?.toLowerCase();

      const messages = entries.filter(entry => {
        if (wanted !== undefined && !wanted.has(entry.type.toLowerCase())) return false;
        if (needle !== undefined && !entry.text.toLowerCase().includes(needle)) return false;
        return true;
      });

      return text({ total: entries.length, returned: messages.length, messages });
    }
  }),

  list_network_requests: defineTool({
    description:
      'List buffered network requests and responses for a session (optionally filtered to one tab). Buffering starts ' +
      'at create_session, and the buffer is bounded (HARBORAGE_NETWORK_BUFFER_SIZE, 200 by default): once it is ' +
      'full the oldest entries are dropped, so an empty result can mean "evicted", not "never happened". Every ' +
      'result reports total (entries in the buffer) next to returned (entries that matched), so you can see how ' +
      'much a filter hid. ' +
      'One HTTP exchange shows up as two entries: a request entry carrying method and resourceType, and a response ' +
      'entry carrying status. No single filter spans both, so "the POST that failed" is two calls, one with ' +
      'method: "POST" and one with minStatus: 400. Filters combine with AND. ' +
      'clear: true drains the entire buffer for the session, not only the entries a filter returned.',
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
      let pattern: RegExp | undefined;
      if (args.urlMatches !== undefined) {
        try {
          pattern = new RegExp(args.urlMatches);
        } catch (err) {
          throw new Error(`urlMatches is not a valid regular expression: ${messageOf(err)}`);
        }
      }

      const entries = ctx.sessions.getNetworkEntries(args.sessionId, args.pageId, args.clear ?? false);
      const needle = args.urlIncludes?.toLowerCase();
      const method = args.method?.toUpperCase();

      const requests = entries.filter(entry => {
        if (args.direction !== undefined && entry.direction !== args.direction) return false;
        if (needle !== undefined && !entry.url.toLowerCase().includes(needle)) return false;
        if (pattern !== undefined && !pattern.test(entry.url)) return false;
        if (method !== undefined && entry.method?.toUpperCase() !== method) return false;
        if (args.resourceType !== undefined && entry.resourceType !== args.resourceType) return false;
        if (args.minStatus !== undefined && !(entry.status !== undefined && entry.status >= args.minStatus)) return false;
        if (args.maxStatus !== undefined && !(entry.status !== undefined && entry.status <= args.maxStatus)) return false;
        return true;
      });

      // total counts the buffer, returned counts the matches: an agent seeing
      // "0 of 200" knows its filter was wrong, while "0 of 0" says the traffic
      // genuinely was not there, or has already aged out.
      return text({ total: entries.length, returned: requests.length, requests });
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
      'background-color and opacity only, up to the document root of the frame the element is in, onto an opaque ' +
      'white canvas, and it reports colours it could not parse rather than guessing. When any of those features ' +
      'are in play the ratio is a strong hint, not a verdict: look at a screenshot too.',
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
                node = node.parentElement;
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
                fontWeight: parseFloat(own.getPropertyValue('font-weight'))
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

      const elements = probes.map((probe, index) => {
        const unparsed: string[] = [];
        const paintLayers: PaintLayer[] = probe.layers.map(layer => {
          const parsed = parseCssColor(layer.backgroundColor);
          if (parsed === null) unparsed.push(`${layer.tagName}: ${layer.backgroundColor}`);
          const opacity = Number(layer.opacity);
          return { bg: parsed ?? { ...fullyTransparent }, opacity: Number.isFinite(opacity) ? opacity : 1 };
        });
        const textColor = parseCssColor(probe.color);
        if (textColor === null) unparsed.push(`color: ${probe.color}`);

        const background = flattenOntoCanvas(paintLayers, { ...fullyTransparent });
        const foreground = flattenOntoCanvas(paintLayers, textColor ?? { ...fullyTransparent });
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
                    'Some colours could not be parsed as rgb/rgba and were treated as transparent, so the ' +
                    'composited result and the contrast ratio below are unreliable for this element.'
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
        elements
      });
    }
  }),

  element_box: defineTool({
    description:
      'Measure elements: bounding box, client and scroll dimensions, whether they are inside the viewport, ' +
      'whether they are really visible, and whether anything is painted on top of them. ' +
      'It takes a list of selectors rather than one, because the question that actually comes up is a comparison ' +
      '("are these three left-aligned?", "is this row taller than that one?") and one call is far cheaper and far ' +
      'easier to read than one call per element. ' +
      'Coordinates are CSS pixels relative to the top left of the viewport, exactly what getBoundingClientRect ' +
      'returns, which is also the coordinate space screenshot\'s clip expects. documentBox is the same point with ' +
      'the current scroll offset added, for comparing things that are not on screen together. Inside an iframe ' +
      'the coordinates are relative to that frame\'s own viewport, not the page\'s. ' +
      'visible is Chromium\'s own checkVisibility (so an ancestor being display:none counts) plus a non-zero box, ' +
      'and hiddenReasons says which test failed rather than leaving you to guess. topmostAtCentre hit-tests the ' +
      'centre point: false means something else would receive a click there, and occludedBy names it, which is ' +
      'how a fully transparent overlay that swallows clicks gets caught. ' +
      'What it does NOT do: it never waits. A selector whose element has not rendered yet comes back as ' +
      'matched: 0, not as a timeout, so settle the page first. It hit-tests one point, the centre, so an element ' +
      'covered only at its edges still reports topmostAtCentre true. It does not tell you what an element looks ' +
      'like: use computed_style for colour and screenshot for pixels.',
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
                  if (inViewport && visible) {
                    const centreX = Math.min(Math.max(rect.left + rect.width / 2, 0), window.innerWidth - 1);
                    const centreY = Math.min(Math.max(rect.top + rect.height / 2, 0), window.innerHeight - 1);
                    const hit = document.elementFromPoint(centreX, centreY);
                    if (hit) {
                      topmostAtCentre = hit === element || element.contains(hit);
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
      'What it does NOT do: it does not reach into shadow DOM (Playwright selectors already pierce open shadow ' +
      'roots on their own, so no prefix is needed there), and a frame that is still loading may report ' +
      'about:blank. A cross-origin frame is listed and reachable the same way as a same-origin one, but its ' +
      'selectorPrefix is missing if its owning element could not be read.',
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
                    'the owning iframe element could not be read, so this frame is reachable only by frameId'
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
      'checked against the live page and is flagged unique when it resolves to exactly one element. Search by ' +
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
          'Frame id from list_frames to search inside. Returned selectors come back already carrying that ' +
            'frame\'s prefix, so they work with click and fill as they are.'
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
      const prefix = frame ? ((await frameSelectorPrefix(target.page, frame)) ?? '') : '';
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

      return text({
        pageId: target.pageId,
        ...(args.frame !== undefined ? { frame: args.frame } : {}),
        matched,
        returned: elements.length,
        elements: elements.map(element => ({ ...element, selector: `${prefix}${element.selector}` }))
      });
    }
  }),

  send_cdp_command: defineTool({
    description:
      'Send a raw Chrome DevTools Protocol command directly to a session\'s tab and get the structured result back. ' +
      'This is the agent-facing counterpart to escalate_session\'s human-facing CDP access. ' +
      'Not for captures: Page.captureScreenshot hands back bare base64 with no dimensions and no route into the ' +
      'screenshot cache, so use the screenshot tool, with selector or clip, for anything you want to look at.',
    inputSchema: z.object({
      sessionId,
      pageId,
      method: z
        .string()
        .describe('Chrome DevTools Protocol method name, e.g. "Page.getLayoutMetrics" or "Network.getResponseBody".'),
      params: z.unknown().optional().describe('Params object for the CDP method, if the method takes any.')
    }),
    async handler(ctx, args) {
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
