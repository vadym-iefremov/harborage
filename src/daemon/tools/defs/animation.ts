import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { CDPSession, Page } from 'playwright';
import * as z from 'zod/v4';

import { sessionCacheDir } from '../../screenshotCache.js';
import { defineTool, defineTools, text } from '../types.js';
import { pageId, sessionId } from './common.js';

/**
 * An animation is the one thing a browser tool cannot report by looking once.
 * Everything else here answers "what is true now"; this answers "what happened
 * over an interval", and the two are not the same question.
 *
 * Two channels, always both, because each is confidently wrong on its own.
 * `getAnimations()` says what the page INTENDED: it reports playState
 * "running" identically for an element that is visible, one at
 * visibility:hidden, one at opacity:0, one positioned off-screen and one
 * buried under an opaque overlay. Trusting it alone is a silent false pass by
 * construction. Pixels say what actually RENDERED, but cannot see a schedule,
 * an easing curve, or the difference between finished and never started.
 *
 * Where they disagree is the most useful thing this tool produces, and it is
 * reported as a typed status rather than resolved into a verdict.
 */

/**
 * The browser globals the in-page snippets below reach for. The daemon's
 * tsconfig has no "dom" lib on purpose, so these are declared narrowly here
 * rather than opening the whole DOM to daemon code, the same way network.ts
 * declares the one `navigator` field it reads back.
 */
interface EvaluatedRect {
  x: number;
  y: number;
  width: number;
  height: number;
  top: number;
  left: number;
  right: number;
  bottom: number;
}
interface EvaluatedElement {
  tagName: string;
  id: string;
  getBoundingClientRect(): EvaluatedRect;
}
interface EvaluatedAnimation {
  id: string;
  playState: string;
  animationName?: string;
  transitionProperty?: string;
  effect?: {
    target?: EvaluatedElement;
    getTiming?(): { duration?: number | string; delay?: number; iterations?: number };
  };
}
declare const document: {
  body: EvaluatedElement | null;
  documentElement: EvaluatedElement | null;
  getAnimations?: () => EvaluatedAnimation[];
};
declare function getComputedStyle(el: EvaluatedElement): { backgroundColor: string };
declare const window: { innerWidth: number; innerHeight: number };
declare function btoa(data: string): string;
/**
 * Decoding goes through createImageBitmap rather than `new Image()` for a
 * reason that is not style: an Image needs an onload callback, and every
 * inner function in a snippet this file serializes into the page is rewritten
 * by esbuild's keep-names transform into a `__name(...)` call against a helper
 * that exists in the bundle and not in the page. createImageBitmap is a bare
 * await, so the snippet carries no inner function at all.
 */
interface EvaluatedImage {
  readonly width: number;
  readonly height: number;
}
declare function fetch(input: string): Promise<{ blob(): Promise<unknown> }>;
declare function createImageBitmap(data: unknown): Promise<EvaluatedImage>;
interface EvaluatedCanvasContext {
  fillStyle: string;
  font: string;
  textBaseline: string;
  clearRect(x: number, y: number, w: number, h: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number): void;
  drawImage(image: EvaluatedImage, ...rest: number[]): void;
  getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray };
}
interface EvaluatedCanvas {
  width: number;
  height: number;
  getContext(id: '2d', opts?: { willReadFrequently?: boolean }): EvaluatedCanvasContext | null;
  convertToBlob(opts: { type: string }): Promise<{ arrayBuffer(): Promise<ArrayBuffer> }>;
}
declare const OffscreenCanvas: { new (w: number, h: number): EvaluatedCanvas };

/** Per-pixel summed |dR|+|dG|+|dB| above which two pixels count as different. */
const diffThreshold = 24;

/** Coarse grid used to split changed pixels into disjoint regions. */
const regionGridWidth = 40;
const regionGridHeight = 30;

/** Beyond this a capture is refused rather than filling the daemon's heap with PNGs. */
const maxDurationMs = 30_000;

/** Frames returned in the contact sheet, clamped to a range that stays readable. */
const minFrames = 4;
const maxFrames = 24;

/** Cap on decoded frames fed to the differ, so a 30s capture cannot stall the daemon. */
const maxAnalysedFrames = 30;

interface RawFrame {
  data: string;
  t: number;
}

interface DeclaredAnimation {
  name: string | null;
  target: string | null;
  playState: string;
  durationMs: number | null;
  delayMs: number | null;
  iterations: number | null;
  inViewport: boolean | null;
}

interface DeclaredChannel {
  supported: boolean;
  backgroundColor: string;
  animations: DeclaredAnimation[];
}

interface TimelineRow {
  frame: number;
  tMs: number;
  adjacentPct: number;
  sinceAnchorPct: number;
  nonBackgroundPx: number;
  bbox: { x: number; y: number; w: number; h: number } | null;
  regions: { x: number; y: number; w: number; h: number }[];
}

/**
 * Reads the declared channel. Called MID-FLIGHT: sampled after the animation
 * ends every playState reads "finished" and the cross-check says nothing.
 */
async function readDeclared(page: Page): Promise<DeclaredChannel> {
  return (await page.evaluate(() => {
    const backgroundColor = ((): string => {
      for (const el of [document.body, document.documentElement]) {
        if (!el) continue;
        const c = getComputedStyle(el).backgroundColor;
        if (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') return c;
      }
      return 'rgb(255, 255, 255)';
    })();
    if (typeof document.getAnimations !== 'function') {
      return { supported: false, backgroundColor, animations: [] };
    }
    return {
      supported: true,
      backgroundColor,
      animations: document.getAnimations().map(a => {
        const timing = a.effect?.getTiming?.() ?? {};
        const el = a.effect?.target;
        const rect = el?.getBoundingClientRect?.();
        return {
          name: a.animationName ?? a.transitionProperty ?? a.id ?? null,
          target: el ? el.tagName + (el.id ? `#${el.id}` : '') : null,
          playState: a.playState,
          durationMs: typeof timing.duration === 'number' ? timing.duration : null,
          delayMs: typeof timing.delay === 'number' ? timing.delay : null,
          iterations: typeof timing.iterations === 'number' ? timing.iterations : null,
          inViewport: rect
            ? rect.right > 0 && rect.left < window.innerWidth && rect.bottom > 0 && rect.top < window.innerHeight
            : null
        };
      })
    };
  })) as DeclaredChannel;
}

/**
 * Diffs the captured frames inside a browser page, so canvas does the pixel
 * work and the daemon needs no image library.
 *
 * Two diffs per frame, and the second one is not redundant. `adjacentPct`
 * compares against the previous frame; `sinceAnchorPct` compares against the
 * first. A genuinely running four-second opacity fade produces ZERO adjacent
 * change on every frame at native capture rate, because it needs roughly
 * 165ms to move one pixel past the threshold. A liveness check built on
 * adjacent diffs alone reports that animation as a dead page.
 */
async function analyseFrames(
  work: Page,
  frames: RawFrame[],
  backgroundColor: string,
  width: number,
  height: number
): Promise<TimelineRow[]> {
  return (await work.evaluate(
    async (input: {
      frames: RawFrame[];
      backgroundColor: string;
      vw: number;
      vh: number;
      threshold: number;
      gw: number;
      gh: number;
    }) => {
      // Everything below is written out longhand. This function is serialized
      // and re-evaluated inside the browser, where nothing else from this
      // module exists, and a nested function expression becomes a call to a
      // `__name` helper that is not there either. A local helper here fails at
      // runtime, in the page, with a ReferenceError that names none of this.
      const { frames: fs, backgroundColor: bgCss, vw, vh, threshold, gw, gh } = input;

      const parsed = bgCss.match(/\d+/g) ?? ['255', '255', '255'];
      const bgR = Number(parsed[0]);
      const bgG = Number(parsed[1]);
      const bgB = Number(parsed[2]);

      const canvas = new OffscreenCanvas(vw, vh);
      const cx = canvas.getContext('2d', { willReadFrequently: true })!;
      const cellW = vw / gw;
      const cellH = vh / gh;

      const firstBlob = await (await fetch('data:image/png;base64,' + fs[0].data)).blob();
      cx.clearRect(0, 0, vw, vh);
      cx.drawImage(await createImageBitmap(firstBlob), 0, 0);
      const anchor = cx.getImageData(0, 0, vw, vh).data.slice();

      let previous: Uint8ClampedArray | null = null;
      const rows: TimelineRow[] = [];

      for (let i = 0; i < fs.length; i++) {
        const blob = await (await fetch('data:image/png;base64,' + fs[i].data)).blob();
        cx.clearRect(0, 0, vw, vh);
        cx.drawImage(await createImageBitmap(blob), 0, 0);
        const cur = cx.getImageData(0, 0, vw, vh).data.slice();

        // Emptiness against the page's OWN background colour. A white-based
        // test reads every frame of a dark theme as non-empty and could never
        // report a blank screen there.
        let nonBackground = 0;
        for (let p = 0; p < cur.length; p += 4) {
          if (Math.abs(cur[p] - bgR) + Math.abs(cur[p + 1] - bgG) + Math.abs(cur[p + 2] - bgB) > threshold) {
            nonBackground++;
          }
        }

        // Pass one: against the PREVIOUS frame.
        let adjacentN = 0;
        if (previous) {
          for (let p = 0; p < cur.length; p += 4) {
            const d =
              Math.abs(previous[p] - cur[p]) +
              Math.abs(previous[p + 1] - cur[p + 1]) +
              Math.abs(previous[p + 2] - cur[p + 2]);
            if (d > threshold) adjacentN++;
          }
        }

        // Pass two: against the ANCHOR frame. Not redundant. A genuinely
        // running four-second fade produces zero adjacent change on every
        // frame at capture rate, because it needs roughly 165ms to move one
        // pixel past the threshold.
        let anchorN = 0;
        let minX = vw;
        let minY = vh;
        let maxX = -1;
        let maxY = -1;
        const grid = new Uint8Array(gw * gh);
        for (let p = 0; p < cur.length; p += 4) {
          const d =
            Math.abs(anchor[p] - cur[p]) +
            Math.abs(anchor[p + 1] - cur[p + 1]) +
            Math.abs(anchor[p + 2] - cur[p + 2]);
          if (d > threshold) {
            anchorN++;
            const q = p / 4;
            const x = q % vw;
            const y = (q - x) / vw;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
            grid[Math.floor(y / cellH) * gw + Math.floor(x / cellW)] = 1;
          }
        }

        // Disjoint regions, because one union box is useless on a page
        // transition: content leaving left and entering right collapses into a
        // single box spanning the viewport and says nothing.
        const seen = new Uint8Array(gw * gh);
        const regions: { x: number; y: number; w: number; h: number; cells: number }[] = [];
        for (let g = 0; g < grid.length; g++) {
          if (!grid[g] || seen[g]) continue;
          const stack: number[] = [g];
          seen[g] = 1;
          let x1 = gw;
          let y1 = gh;
          let x2 = -1;
          let y2 = -1;
          let cells = 0;
          while (stack.length) {
            const k = stack.pop()!;
            const gx = k % gw;
            const gy = (k - gx) / gw;
            cells++;
            if (gx < x1) x1 = gx;
            if (gx > x2) x2 = gx;
            if (gy < y1) y1 = gy;
            if (gy > y2) y2 = gy;
            const neighbours = [k + 1, k - 1, k + gw, k - gw];
            const sameRow = [true, true, false, false];
            for (let n = 0; n < 4; n++) {
              const nk = neighbours[n];
              if (nk < 0 || nk >= gw * gh || seen[nk] || !grid[nk]) continue;
              if (sameRow[n] && Math.floor(nk / gw) !== gy) continue;
              seen[nk] = 1;
              stack.push(nk);
            }
          }
          regions.push({
            x: Math.round(x1 * cellW),
            y: Math.round(y1 * cellH),
            w: Math.round((x2 - x1 + 1) * cellW),
            h: Math.round((y2 - y1 + 1) * cellH),
            cells
          });
        }
        regions.sort((p, q) => q.cells - p.cells);

        rows.push({
          frame: i,
          tMs: Math.round(fs[i].t),
          adjacentPct: Number(((100 * adjacentN) / (vw * vh)).toFixed(3)),
          sinceAnchorPct: Number(((100 * anchorN) / (vw * vh)).toFixed(3)),
          nonBackgroundPx: nonBackground,
          bbox: maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX, h: maxY - minY },
          regions: regions.slice(0, 4).map(r => ({ x: r.x, y: r.y, w: r.w, h: r.h }))
        });
        previous = cur;
      }
      return rows;
    },
    {
      frames,
      backgroundColor,
      vw: width,
      vh: height,
      threshold: diffThreshold,
      gw: regionGridWidth,
      gh: regionGridHeight
    }
  )) as TimelineRow[];
}

/** Composes chosen frames into one labelled contact sheet, cropped to `crop`. */
async function buildContactSheet(
  work: Page,
  frames: RawFrame[],
  crop: { x: number; y: number; w: number; h: number },
  columns: number
): Promise<{ base64: string; width: number; height: number }> {
  return (await work.evaluate(
    async (input: {
      frames: RawFrame[];
      crop: { x: number; y: number; w: number; h: number };
      columns: number;
    }) => {
      // Longhand for the same reason as analyseFrames: an inner function
      // here becomes a __name call that does not exist in the page.
      const { frames: fs, crop: c, columns: cols } = input;
      const rows = Math.ceil(fs.length / cols);
      const gap = 4;
      const labelH = 16;
      const fullW = cols * c.w + (cols + 1) * gap;
      const fullH = rows * (c.h + labelH) + (rows + 1) * gap;
      // Anything larger is downscaled by the reader anyway, so do it here and
      // report the scale rather than paying for pixels that get thrown away.
      const scale = Math.min(1, 1568 / Math.max(fullW, fullH));
      const canvas = new OffscreenCanvas(Math.round(fullW * scale), Math.round(fullH * scale));
      const cx = canvas.getContext('2d')!;
      cx.fillStyle = '#2b2b2b';
      cx.fillRect(0, 0, canvas.width, canvas.height);
      for (let i = 0; i < fs.length; i++) {
        const blob = await (await fetch('data:image/png;base64,' + fs[i].data)).blob();
        const bitmap = await createImageBitmap(blob);
        const r = Math.floor(i / cols);
        const col = i % cols;
        const x = (gap + col * (c.w + gap)) * scale;
        const y = (gap + r * (c.h + labelH + gap)) * scale;
        cx.fillStyle = '#ffffff';
        cx.font = Math.round(11 * scale) + 'px system-ui, sans-serif';
        cx.textBaseline = 'top';
        cx.fillText(i + 1 + '  ' + Math.round(fs[i].t) + 'ms', x, y);
        cx.drawImage(bitmap, c.x, c.y, c.w, c.h, x, y + labelH * scale, c.w * scale, c.h * scale);
      }
      const blob = await canvas.convertToBlob({ type: 'image/png' });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      return { base64: btoa(binary), width: canvas.width, height: canvas.height };
    },
    { frames, crop, columns }
  )) as { base64: string; width: number; height: number };
}

export const animationTools = defineTools({
  record_animation: defineTool({
    description:
      'Record a running animation and report BOTH what the page declares it is animating and what actually ' +
      'rendered on screen. These are different questions and they disagree in exactly the cases that matter: ' +
      'getAnimations() reports playState "running" identically for an element that is visible, one at ' +
      'visibility:hidden, one at opacity:0, one positioned off-screen and one covered by an opaque overlay, so ' +
      'the declared channel alone cannot tell you a user would see anything. Pixels cannot see a schedule or an ' +
      'easing curve. Where the two disagree is reported as agreement.status, and that disagreement is usually the ' +
      'most useful thing in the result. ' +
      'THE PAGE MUST ALREADY BE LOADED for a click or evaluate trigger. For an animation that plays on page load ' +
      '(a logo intro, a splash, a hero reveal) do NOT navigate first and then call this: the animation is over ' +
      'before recording starts, and you get one frame and no change. Use trigger {type:"navigate", url} instead, ' +
      'which starts recording before navigating. ' +
      'Frames come from a CDP screencast, not a loop of screenshots, so the capture does not pace the animation it ' +
      'is measuring. A page that stops repainting emits no frames at all, which is why a stall is detected from ' +
      'gaps between frame timestamps rather than from frames that show no change. ' +
      'A navigate capture reports paint gaps as paint_gaps_during_navigation, not as a stall: a loading page ' +
      'legitimately stops painting while it waits on the network, and real sites produce gaps of a second or ' +
      'more on a clean load. To judge smoothness, record an already-loaded page with a click or evaluate trigger. ' +
      'This tool reports measurements and does NOT decide whether an animation is correct. agreement.status ' +
      '"mismatch" means the two channels disagree, not that there is a bug: a deliberately hidden element gives ' +
      'the same signature as a broken one, and only you know which was intended.',
    inputSchema: z.object({
      sessionId,
      pageId,
      trigger: z
        .discriminatedUnion('type', [
          z.object({
            type: z.literal('click'),
            selector: z.string().min(1).describe('Selector to click to start the animation.')
          }),
          z.object({
            type: z.literal('evaluate'),
            expression: z
              .string()
              .min(1)
              .describe('JavaScript evaluated in the page to start the animation, e.g. adding a class.')
          }),
          z.object({
            type: z.literal('navigate'),
            url: z.string().min(1).describe('URL to navigate to AFTER recording starts, for load-time animations.')
          }),
          z.object({ type: z.literal('none') })
        ])
        .describe(
          'How the animation is started. "none" records something already running, such as a spinner. ' +
            '"navigate" is the one to use for anything that plays on page load, because recording begins before ' +
            'the navigation rather than after it.'
        ),
      durationMs: z
        .number()
        .int()
        .positive()
        .max(maxDurationMs)
        .describe(
          `How long to record for, after the trigger. Recording stops at this deadline whether or not the ` +
            `animation finished, and observedMs in the result tells you which happened. Set it LONGER than the ` +
            `animation you expect. Capped at ${maxDurationMs}ms.`
        ),
      target: z
        .string()
        .optional()
        .describe(
          'CSS selector to crop the returned contact sheet to. USUALLY OMIT THIS. With no target the crop is ' +
            'derived from where pixels actually changed, which for a logo or a button is tighter than the ' +
            'element\'s own box and costs fewer tokens. Pass a target only to ignore other things moving on the ' +
            'page, such as a ticking clock. Naming a wrapper that fills the viewport makes the result larger and ' +
            'harder to read, not more precise. THIS CROPS THE IMAGE ONLY: every number in observed is measured ' +
            'across the whole viewport regardless, so a blank area outside the crop still shows in nonBackgroundPx.'
        ),
      frames: z
        .number()
        .int()
        .min(minFrames)
        .max(maxFrames)
        .optional()
        .describe(
          `How many frames the contact sheet carries (default 12). Frames are chosen where change actually ` +
            `happens, not on an even clock, because an evenly spaced sample of a 2s window containing a 120ms ` +
            `interaction mostly shows a static page. Range ${minFrames} to ${maxFrames}.`
        ),
      mode: z
        .enum(['inline', 'cached'])
        .optional()
        .describe(
          'Where the contact sheet goes. "inline" (default) returns it as image data you can look at now. ' +
            '"cached" writes a PNG and returns its path, costing a separate read to see, which is the right ' +
            'choice for bulk captures you do not intend to look at.'
        )
    }),
    // The click trigger drives the session's one virtual mouse. Without this
    // a concurrent drag and this call interleave their presses and both
    // report success while corrupting each other.
    serializesInput: true,
    async handler(ctx, args) {
      const target = ctx.sessions.resolve(args.sessionId, args.pageId);
      const page = target.page;
      const viewport = page.viewportSize();
      if (!viewport) {
        return text({
          error: 'no_viewport',
          message:
            'This tab reports no viewport size, so frames cannot be measured against a known geometry. ' +
            'Create the session with an explicit viewport, or use resize, then record again.'
        });
      }

      const wantFrames = args.frames ?? 12;
      const captured: RawFrame[] = [];
      let firstTimestamp: number | null = null;
      let cdp: CDPSession | undefined;

      try {
        cdp = await target.session.context.newCDPSession(page);
        const onFrame = (payload: { data: string; metadata: { timestamp: number }; sessionId: number }): void => {
          const t = payload.metadata.timestamp * 1000;
          if (firstTimestamp === null) firstTimestamp = t;
          captured.push({ data: payload.data, t: t - firstTimestamp });
          void cdp?.send('Page.screencastFrameAck', { sessionId: payload.sessionId }).catch(() => {});
        };
        cdp.on('Page.screencastFrame', onFrame as never);
        await cdp.send('Page.startScreencast', {
          format: 'png',
          everyNthFrame: 1,
          maxWidth: viewport.width,
          maxHeight: viewport.height
        });

        // Recording is live BEFORE the trigger runs, which is the whole reason
        // a load-time animation is capturable at all.
        if (args.trigger.type === 'click') await page.click(args.trigger.selector);
        else if (args.trigger.type === 'evaluate') await page.evaluate(args.trigger.expression);
        else if (args.trigger.type === 'navigate') await page.goto(args.trigger.url);

        // Declared channel read mid-flight, for the reason in readDeclared.
        const settle = Math.min(200, Math.max(40, Math.round(args.durationMs * 0.2)));
        await page.waitForTimeout(settle);
        const declared = await readDeclared(page);

        await page.waitForTimeout(Math.max(0, args.durationMs - settle));
        await cdp.send('Page.stopScreencast').catch(() => {});
        cdp.off('Page.screencastFrame', onFrame as never);

        if (captured.length === 0) {
          return text({
            capture: { requestedMs: args.durationMs, observedMs: 0, rawFrames: 0, framesReturned: 0 },
            declared,
            agreement: {
              status: 'undetermined',
              codes: ['no_frames_captured'],
              note:
                'The page produced no frames at all during the capture window. A page that never repaints emits ' +
                'nothing, so this cannot distinguish a static page from one that failed to render.'
            }
          });
        }

        const observedMs = Math.round(captured[captured.length - 1].t);
        const stride = Math.max(1, Math.ceil(captured.length / maxAnalysedFrames));
        const analysed = captured.filter((_, i) => i % stride === 0);

        // The scratch page for canvas work goes in its OWN context, never in
        // the session's. Created inside session.context it registers as a tab
        // of that session, and closing it leaves the session's active-tab
        // pointer dangling, so the NEXT call fails with PageNotFoundError.
        // Found by running this against a real site twice in a row.
        const workContext = await target.session.context.browser()?.newContext();
        if (!workContext) {
          return text({
            error: 'no_browser_for_analysis',
            message:
              'The browser behind this session is gone, so the captured frames cannot be measured. ' +
              'Frames were recorded but not analysed; create a fresh session and record again.'
          });
        }
        const work = await workContext.newPage();
        let timeline: TimelineRow[];
        let sheet: { base64: string; width: number; height: number } | null = null;
        let crop: { x: number; y: number; w: number; h: number } | null = null;
        let cropSource: 'caller' | 'derived' = 'derived';
        let cropReason = '';
        try {
          await work.goto('about:blank');
          timeline = await analyseFrames(work, analysed, declared.backgroundColor, viewport.width, viewport.height);

          const pad = 12;
          if (args.target !== undefined) {
            cropSource = 'caller';
            const box = await page
              .locator(args.target)
              .first()
              .boundingBox()
              .catch(() => null);
            if (box) {
              crop = {
                x: Math.max(0, Math.round(box.x - pad)),
                y: Math.max(0, Math.round(box.y - pad)),
                w: Math.min(viewport.width, Math.round(box.width + pad * 2)),
                h: Math.min(viewport.height, Math.round(box.height + pad * 2))
              };
              cropReason = `bounds of ${args.target}`;
            } else {
              cropReason = `selector ${args.target} matched nothing; using the whole viewport`;
            }
          }
          if (!crop) {
            let x1 = viewport.width;
            let y1 = viewport.height;
            let x2 = 0;
            let y2 = 0;
            let any = false;
            for (const row of timeline) {
              if (!row.bbox) continue;
              any = true;
              x1 = Math.min(x1, row.bbox.x);
              y1 = Math.min(y1, row.bbox.y);
              x2 = Math.max(x2, row.bbox.x + row.bbox.w);
              y2 = Math.max(y2, row.bbox.y + row.bbox.h);
            }
            if (any) {
              crop = {
                x: Math.max(0, x1 - pad),
                y: Math.max(0, y1 - pad),
                w: Math.min(viewport.width, x2 + pad) - Math.max(0, x1 - pad),
                h: Math.min(viewport.height, y2 + pad) - Math.max(0, y1 - pad)
              };
              const frac = (crop.w * crop.h) / (viewport.width * viewport.height);
              if (cropSource === 'derived') {
                cropReason = `union of changed pixels, ${Math.round(frac * 100)}% of viewport`;
              }
            } else {
              crop = { x: 0, y: 0, w: viewport.width, h: viewport.height };
              if (cropSource === 'derived') cropReason = 'no pixels changed anywhere; using the whole viewport';
            }
          }

          // Change-weighted frame choice: an even sample of a long window
          // containing a short burst mostly shows a static page.
          const weights = timeline.map((r, i) => (i === 0 ? 0 : r.adjacentPct + 0.001));
          const total = weights.reduce((s, w) => s + w, 0);
          const picked: number[] = [0];
          let acc = 0;
          const want = total / Math.max(1, wantFrames - 1);
          for (let i = 1; i < weights.length && picked.length < wantFrames; i++) {
            acc += weights[i];
            if (acc >= want) {
              picked.push(i);
              acc = 0;
            }
          }
          for (let i = 1; i < analysed.length && picked.length < wantFrames; i++) {
            if (!picked.includes(i)) picked.push(i);
          }
          picked.sort((p, q) => p - q);
          sheet = await buildContactSheet(
            work,
            picked.map(i => analysed[i]),
            crop,
            Math.min(4, Math.max(1, picked.length))
          );
        } finally {
          await workContext.close().catch(() => {});
        }

        // --- cross-check -------------------------------------------------
        const post = timeline.slice(1);
        const codes: string[] = [];
        const maxSinceAnchor = post.length ? Math.max(...post.map(r => r.sinceAnchorPct)) : 0;
        const anyPixelChange = maxSinceAnchor > 0;
        const declaredAnimating =
          declared.supported && declared.animations.some(a => a.playState === 'running' || a.playState === 'finished');

        if (!declared.supported) codes.push('declared_channel_unavailable');
        // `every` on an empty array is vacuously true, and an invisible
        // element produces no frames, so this guard is exactly where the
        // claim would otherwise be most wrong.
        if (post.length < 2) codes.push('insufficient_frames_for_timeline');
        if (declaredAnimating && !anyPixelChange) {
          codes.push('declared_animating_but_no_pixel_change');
          if (declared.animations.some(a => a.inViewport === false)) codes.push('declared_target_outside_viewport');
          if (post.length > 0 && post.every(r => r.nonBackgroundPx === 0)) codes.push('viewport_empty_throughout');
        }
        if (!declaredAnimating && anyPixelChange) codes.push('pixels_changed_with_no_declared_animation');
        if (declaredAnimating && anyPixelChange) codes.push('declared_and_observed_agree');

        // A stall is the page not repainting, so it shows as a gap between
        // frame TIMESTAMPS. It never shows as a zero-change frame, because
        // no frame is emitted at all.
        // During a navigation the page legitimately stops painting while it
        // waits on the network, so gaps here are ordinary load behaviour and
        // not jank. Measured on three real sites: MDN produced 503ms and
        // 1131ms gaps on a clean load. The gaps are still reported, because
        // they are real, but they are not labelled as stalls under a navigate
        // trigger, since that label would send someone hunting a bug that is
        // not there.
        const gapsAreLoadWaits = args.trigger.type === 'navigate';
        const stalls: { fromMs: number; toMs: number; durationMs: number }[] = [];
        if (captured.length > 4) {
          const deltas = captured.slice(1).map((f, i) => f.t - captured[i].t).sort((p, q) => p - q);
          const median = deltas[Math.floor(deltas.length / 2)] || 16;
          const limit = Math.max(median * 4, 100);
          for (let i = 1; i < captured.length; i++) {
            const d = captured[i].t - captured[i - 1].t;
            if (d > limit) {
              stalls.push({
                fromMs: Math.round(captured[i - 1].t),
                toMs: Math.round(captured[i].t),
                durationMs: Math.round(d)
              });
            }
          }
        }
        if (stalls.length) codes.push(gapsAreLoadWaits ? 'paint_gaps_during_navigation' : 'repaint_stall_detected');

        // A quiet interval is frames arriving normally with nothing changing.
        // Common and legitimate (the pause between staggered items), so it is
        // reported as a measurement and never called a defect.
        const quietIntervals: { fromMs: number; toMs: number; durationMs: number; viewportEmptyThroughout: boolean }[] =
          [];
        for (let i = 1; i < post.length; i++) {
          const progressing = post[i].sinceAnchorPct > post[i - 1].sinceAnchorPct;
          if (post[i].adjacentPct === 0 && !progressing) {
            let j = i;
            while (
              j + 1 < post.length &&
              post[j + 1].adjacentPct === 0 &&
              post[j + 1].sinceAnchorPct <= post[j].sinceAnchorPct
            ) {
              j++;
            }
            const span = post[j].tMs - post[i - 1].tMs;
            if (span >= 100) {
              quietIntervals.push({
                fromMs: post[i - 1].tMs,
                toMs: post[j].tMs,
                durationMs: span,
                viewportEmptyThroughout: post.slice(i, j + 1).every(r => r.nonBackgroundPx === 0)
              });
            }
            i = j;
          }
        }
        if (quietIntervals.some(q => q.viewportEmptyThroughout)) codes.push('viewport_empty_interval');

        const status = codes.includes('declared_animating_but_no_pixel_change')
          ? 'mismatch'
          : codes.includes('declared_and_observed_agree')
            ? 'agree'
            : 'undetermined';

        const meta = {
          capture: {
            requestedMs: args.durationMs,
            observedMs,
            rawFrames: captured.length,
            analysedFrames: analysed.length,
            framesReturned: sheet ? Math.min(wantFrames, analysed.length) : 0,
            effectiveFps: observedMs > 0 ? Math.round((captured.length / observedMs) * 1000) : 0,
            trigger: args.trigger.type
          },
          region: {
            crop,
            source: cropSource,
            reason: cropReason,
            note: 'This crops the returned image only. Every value in observed is measured across the whole viewport.'
          },
          declared: {
            ...declared,
            limitation:
              'Keyframe-level easing is not exposed by getAnimations(), so an ease-out curve reports as its ' +
              'effect-level value. playState reflects intent, not whether anything was visible.'
          },
          observed: {
            scope: 'viewport',
            timeline: timeline.map(r => ({
              tMs: r.tMs,
              adjacentPct: r.adjacentPct,
              sinceAnchorPct: r.sinceAnchorPct,
              nonBackgroundPx: r.nonBackgroundPx,
              regions: r.regions
            })),
            note:
              'adjacentPct compares against the previous frame; sinceAnchorPct against the first. A slow fade ' +
              'shows zero adjacentPct while sinceAnchorPct climbs, so read sinceAnchorPct before concluding ' +
              'nothing happened.'
          },
          agreement: {
            status,
            codes,
            stalls,
            stallsNote: gapsAreLoadWaits
              ? 'Captured across a navigation, so these gaps include ordinary waits on the network and are NOT ' +
                'evidence of jank. Re-record with a click or evaluate trigger on an already-loaded page to judge ' +
                'smoothness.'
              : null,
            quietIntervals,
            discriminators: {
              maxChangeSinceAnchorPct: maxSinceAnchor,
              minNonBackgroundPx: post.length ? Math.min(...post.map(r => r.nonBackgroundPx)) : null,
              declaredAnimationCount: declared.animations.length
            }
          }
        };

        if (!sheet) return text(meta);

        if (args.mode === 'cached') {
          const { screenshotCacheDir, screenshotCacheTtlMs } = ctx.config;
          const dir = sessionCacheDir(screenshotCacheDir, target.session.id);
          await mkdir(dir, { recursive: true });
          const cacheId = randomUUID();
          const filePath = join(dir, `${cacheId}.png`);
          await writeFile(filePath, Buffer.from(sheet.base64, 'base64'));
          return text({
            ...meta,
            contactSheet: {
              mode: 'cached',
              cacheId,
              path: filePath,
              width: sheet.width,
              height: sheet.height,
              expiresAt: new Date(Date.now() + screenshotCacheTtlMs).toISOString()
            }
          });
        }

        const withSheet = {
          ...meta,
          contactSheet: { mode: 'inline', width: sheet.width, height: sheet.height }
        };
        return {
          content: [
            { type: 'image' as const, data: sheet.base64, mimeType: 'image/png' },
            { type: 'text' as const, text: JSON.stringify(withSheet, null, 2) }
          ],
          structuredContent: withSheet
        };
      } finally {
        await cdp?.detach().catch(() => {});
      }
    }
  })
});
