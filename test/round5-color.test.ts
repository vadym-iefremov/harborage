import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';

import { BrowserManager } from '../src/daemon/browserManager.js';
import { createToolHandlers, type ToolHandlers } from '../src/daemon/tools/handlers.js';
import { SessionStore } from '../src/daemon/sessions.js';
import { decodePng, getFreePort, paintedContrastRatio, pixelAt, type DecodedPng } from './helpers.js';

/**
 * Round-5 regression suite: the two defects the round-4 work introduced, and
 * the ones next to them.
 *
 * Both came out of surface area round 4 added, and both are the same shape of
 * mistake in opposite directions. Measuring an outlined SVG shape on its
 * stroke is right, and was applied with no regard for whether the stroke puts
 * any ink on screen, so the tool was most confident exactly where it was most
 * wrong: a constant 21:1 from an invisible hairline upward. Detecting closed
 * shadow roots is right, and was computed once per CALL rather than once per
 * element, so one closed root anywhere refused every element in an `all: true`
 * match set, which is the mode an agent uses to audit a whole page.
 *
 * One fixture, one session, one screenshot, because this suite shares a
 * machine with other agents.
 */

const CELL = 60;
// The SVGs are 40px wide over a 24-unit viewBox, so one user unit is 40/24 of
// a CSS pixel and a device pixel is a CSS pixel at devicePixelRatio 1.
const VIEW_SCALE = 40 / 24;
const userUnits = (devicePx: number): number => devicePx / VIEW_SCALE;

/** Device stroke widths chosen to land one either side of each boundary, plus one comfortably clear. */
const HAIRLINE = 0.4;
const PARTIAL = 1.5;
const SOLID = 4;

function strokeCell(id: string, left: number, deviceWidth: number): string {
  return (
    `<div style="position:absolute;left:${left}px;top:0;width:${CELL}px;height:${CELL}px;background:rgb(255,255,255)">` +
    `<svg id="${id}" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="rgb(0,0,0)" ` +
    `stroke-width="${userUnits(deviceWidth)}" style="position:absolute;left:10px;top:10px">` +
    '<rect x="3" y="3" width="18" height="18"/></svg></div>'
  );
}

const HTML = `<!doctype html>
<html><head><style>html,body{margin:0;background:rgb(255,255,255)}</style></head><body>
${strokeCell('hairline', 0, HAIRLINE)}
${strokeCell('partial', CELL, PARTIAL)}
${strokeCell('solid', CELL * 2, SOLID)}

<div style="position:absolute;left:${CELL * 3}px;top:0;width:${CELL}px;height:${CELL}px;background:rgb(255,255,255)">
  <svg id="dashed" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="rgb(0,0,0)" stroke-width="3"
       stroke-dasharray="0 100" style="position:absolute;left:10px;top:10px"><rect x="3" y="3" width="18" height="18"/></svg>
</div>

<div style="position:absolute;left:${CELL * 4}px;top:0;width:${CELL}px;height:${CELL}px;background:rgb(255,255,255)">
  <span id="hiddenText" style="visibility:hidden;font-family:monospace;font-size:40px;font-weight:900;color:rgb(0,0,0)">&#9608;</span>
</div>

<!-- An <svg> container with no fill of its own, wrapping a shape that fills
     white. Its inherited fill is the initial black and describes nothing. -->
<div style="position:absolute;left:${CELL * 5}px;top:0;width:${CELL}px;height:${CELL}px;background:rgb(255,255,255)">
  <svg id="containerDisagrees" width="40" height="40" viewBox="0 0 24 24" style="position:absolute;left:10px;top:10px">
    <rect x="0" y="0" width="24" height="24" fill="rgb(255,255,255)"/>
  </svg>
</div>

<!-- The shape every icon set emits: paths that simply inherit the <svg>'s own
     fill and stroke. This one must keep answering. -->
<div style="position:absolute;left:${CELL * 6}px;top:0;width:${CELL}px;height:${CELL}px;background:rgb(255,255,255)">
  <svg id="containerAgrees" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="rgb(0,0,0)"
       stroke-width="${userUnits(SOLID)}" style="position:absolute;left:10px;top:10px">
    <path d="M4 12h16"/><path d="M12 4v16"/>
  </svg>
</div>

<!-- Batch mode: one ordinary element and one slotted into a CLOSED shadow
     root, both matching the same selector. -->
<div style="position:absolute;left:0;top:${CELL}px;width:${CELL}px;height:${CELL}px;background:rgb(255,255,255)">
  <span class="batch" id="ordinary" style="font-family:monospace;font-size:40px;font-weight:900;color:rgb(0,0,0)">&#9608;</span>
</div>
<div id="closedHost" style="position:absolute;left:${CELL}px;top:${CELL}px;width:${CELL}px;height:${CELL}px">
  <span class="batch" id="closedKid" style="font-family:monospace;font-size:40px;font-weight:900;color:rgb(255,255,255)">&#9608;</span>
</div>
<script>
  document.getElementById('closedHost').attachShadow({ mode: 'closed' }).innerHTML =
    '<div style="width:${CELL}px;height:${CELL}px;background:rgb(255,255,255)"><slot></slot></div>';
</script>
</body></html>`;

let server: Server;
let baseUrl: string;
let browserManager: BrowserManager;
let sessions: SessionStore;
let handlers: ToolHandlers;
let sessionId: string;
let capture: DecodedPng;

before(async () => {
  server = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(HTML);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}/`;

  browserManager = new BrowserManager(await getFreePort());
  sessions = new SessionStore(browserManager);
  handlers = createToolHandlers(sessions, {
    debugPort: await getFreePort(),
    screenshotCacheDir: '/dev/null/unused',
    screenshotCacheTtlMs: 1000
  });

  // One session and one screenshot for the whole file.
  const created = await sessions.createSession();
  sessionId = created.sessionId;
  await handlers.resize({ sessionId, width: CELL * 7, height: CELL * 2 } as never);
  await handlers.navigate({ sessionId, url: baseUrl });
  const shot = (await handlers.screenshot({
    sessionId,
    clip: { x: 0, y: 0, width: CELL * 7, height: CELL * 2 }
  } as never)) as { content: { type: string; data?: string }[] };
  const image = shot.content.find(block => block.type === 'image');
  assert.ok(image?.data, 'screenshot returned no inline image data');
  capture = decodePng(Buffer.from(image.data, 'base64'));
});

after(async () => {
  await sessions.closeAll();
  await browserManager.close();
  await new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve())));
});

function payload(result: unknown): Record<string, any> {
  return (result as { structuredContent: Record<string, any> }).structuredContent;
}

async function styleOf(selector: string): Promise<Record<string, any>> {
  const body = payload(await handlers.computed_style({ sessionId, selector } as never));
  assert.ok(body.elements.length > 0, `computed_style matched nothing for ${selector}`);
  return body.elements[0];
}

/**
 * The contrast of the DARKEST pixel the browser actually painted in one cell.
 *
 * That is the right oracle for a stroke. The tool reports the stroke's colour,
 * and the question this suite exists to answer is whether any pixel on screen
 * ever receives it. The darkest painted pixel is the best case; if even that
 * falls short of the reported number, the number describes nothing.
 */
function darkestInkRatio(cellIndex: number, row = 0): number {
  let darkest = 255;
  for (let y = row * CELL; y < (row + 1) * CELL; y += 1) {
    for (let x = cellIndex * CELL; x < (cellIndex + 1) * CELL; x += 1) {
      const value = pixelAt(capture, x, y).r;
      if (value < darkest) darkest = value;
    }
  }
  return paintedContrastRatio({ r: darkest, g: darkest, b: darkest }, { r: 255, g: 255, b: 255 });
}

// ---------------------------------------------------------------------------
// Regression 1: a stroke measured on a colour no pixel receives.
// ---------------------------------------------------------------------------

test('a stroke thinner than one device pixel is refused, because no pixel can reach its colour', async () => {
  const element = await styleOf('#hairline');

  // A stroke of device width w covers at most w of any pixel row it crosses,
  // so below 1 the nominal colour is unattainable by construction. The pixels
  // agree: this hairline's darkest pixel is nowhere near the 21:1 the tool
  // used to quote, and it quoted it with passes.nonText true.
  const painted = darkestInkRatio(0);
  assert.ok(painted < 4, `the fixture must actually paint faintly, its darkest pixel is ${painted.toFixed(2)}:1`);
  assert.equal(element.contrast.ratio, null, `expected a refusal, got ${element.contrast.ratio}`);
  assert.equal(element.contrast.passes, null);
  assert.ok((element.contrast.unaccountedFor as string[]).includes('strokeThinnerThanAPixel'));
  assert.match(String(element.contrast.ratioUnavailable), /device pixel/i);
  assert.equal(element.effective.layerChainIncomplete, true);
});

test('a stroke between one and two device pixels is answered but marked borderline', async () => {
  const element = await styleOf('#partial');

  // In this band it depends on the geometry and on where the edges land on the
  // pixel grid, and the tool cannot know which without rasterising. Measured
  // at 1.0 device pixel: a diagonal reaches the full colour, a circle and a
  // Lucide-shaped path 20.5:1 of a nominal 21:1, an axis-aligned rectangle
  // only 10.53:1. Refusing the whole band would refuse every icon on a real
  // page, so it is answered with the uncertainty attached.
  assert.ok(typeof element.contrast.ratio === 'number', 'this band must stay answerable');
  assert.equal(element.contrast.borderline, true);
  assert.match(String(element.contrast.borderlineNote), /device pixels/);
  // And the payload has to carry the width, or a caller cannot tell this 21:1
  // from a solid one. stroke-width is not in the default property set.
  assert.equal(element.effective.textPaint.property, 'stroke');
  assert.ok(
    Math.abs(element.effective.textPaint.deviceStrokeWidth - PARTIAL) < 0.01,
    `expected a device width near ${PARTIAL}, got ${element.effective.textPaint.deviceStrokeWidth}`
  );
});

test('a stroke at two device pixels or more is answered plainly, and matches the painted ink exactly', async () => {
  const element = await styleOf('#solid');
  const painted = darkestInkRatio(2);

  // A band two device pixels wide always contains a whole pixel in at least
  // one axis whatever its subpixel offset, so the nominal colour is reached.
  assert.ok(
    Math.abs(element.contrast.ratio - painted) < 0.02,
    `expected the painted ${painted.toFixed(4)}:1, got ${element.contrast.ratio}`
  );
  assert.equal(element.contrast.borderline, undefined, 'a solid stroke carries no caveat');
  assert.equal(element.contrast.ratioUnavailable, undefined);
});

test('a stroke whose dashes are all zero length draws no ink, and is refused', async () => {
  const element = await styleOf('#dashed');
  // stroke-dasharray: "0 100" is all gap. The stroke colour is a perfectly
  // good colour and used to be reported as a confident 21:1 off a shape that
  // paints nothing at all.
  assert.ok(darkestInkRatio(3) < 1.05, 'the fixture must genuinely paint nothing');
  assert.equal(element.contrast.ratio, null);
  assert.ok((element.contrast.unaccountedFor as string[]).includes('svgNoFill'));
  assert.match(String(element.contrast.ratioUnavailable), /dash/i);
});

test('an element that paints nothing is refused rather than given a ratio for what it would paint', async () => {
  const element = await styleOf('#hiddenText');
  assert.ok(darkestInkRatio(4) < 1.05, 'the fixture must genuinely paint nothing');
  assert.equal(element.contrast.ratio, null);
  assert.ok((element.contrast.unaccountedFor as string[]).includes('notPainted'));
  assert.match(String(element.contrast.ratioUnavailable), /visibility|display/i);
});

// ---------------------------------------------------------------------------
// SVG containers, which paint no geometry of their own.
// ---------------------------------------------------------------------------

test('an SVG container whose shapes do not use its paint is refused', async () => {
  const element = await styleOf('#containerDisagrees');
  // An <svg> with no fill set inherits the initial black. The rect inside it
  // fills white. Quoting the container's black was a 21:1 off a value nothing
  // on screen is painted with.
  assert.equal(element.contrast.ratio, null);
  assert.ok((element.contrast.unaccountedFor as string[]).includes('svgNoOwnGeometry'));
  assert.match(String(element.contrast.ratioUnavailable), /paints no geometry/i);
});

test('an SVG container whose shapes DO inherit its paint still answers, which is every icon set', async () => {
  const element = await styleOf('#containerAgrees');
  const painted = darkestInkRatio(6);
  // The test is agreement, not containment. Refusing every container would
  // refuse every Lucide, Feather and Heroicons icon, which is the failure the
  // stroke work existed to avoid in the first place.
  assert.ok(
    typeof element.contrast.ratio === 'number',
    `an icon-shaped container must stay answerable, got ${JSON.stringify(element.contrast)}`
  );
  assert.equal(element.effective.textPaint.property, 'stroke');
  assert.ok(
    Math.abs(element.contrast.ratio - painted) < 0.02,
    `expected the painted ${painted.toFixed(4)}:1, got ${element.contrast.ratio}`
  );
});

// ---------------------------------------------------------------------------
// Regression 2: one closed root must not condemn a whole match set.
// ---------------------------------------------------------------------------

test('with all: true, a closed shadow root refuses only the elements whose own chain crosses it', async () => {
  const body = payload(
    await handlers.computed_style({ sessionId, selector: '.batch', all: true, limit: 20 } as never)
  );
  assert.equal(body.returned, 2, 'both elements have to be measured');
  const byId = new Map<string, any>(body.elements.map((element: any) => [element.id, element]));

  // The regression: this was one boolean per CALL applied to every element, so
  // a single closed root anywhere silently zeroed an entire page audit.
  const ordinary = byId.get('ordinary');
  assert.ok(
    typeof ordinary.contrast.ratio === 'number',
    `the ordinary element must still be answered in batch mode, got ${JSON.stringify(ordinary.contrast)}`
  );
  assert.equal(ordinary.contrast.unaccountedFor, undefined);

  const closed = byId.get('closedKid');
  assert.equal(closed.contrast.ratio, null);
  assert.ok((closed.contrast.unaccountedFor as string[]).includes('closedShadowRoot'));

  // And the batch answer has to agree with the single-element answer, or one
  // of the two modes is lying.
  const alone = await styleOf('#ordinary');
  assert.equal(alone.contrast.ratio, ordinary.contrast.ratio);
});

test('the per-element tagging survives being run twice over different match sets', async () => {
  // The tags carry element indices, which are only meaningful within the call
  // that wrote them. A stale tag left by an earlier call would map an old
  // index onto an unrelated element here, so each call clears them first.
  const first = payload(
    await handlers.computed_style({ sessionId, selector: '.batch', all: true, limit: 20 } as never)
  );
  const second = payload(await handlers.computed_style({ sessionId, selector: '#ordinary' } as never));
  const third = payload(
    await handlers.computed_style({ sessionId, selector: '.batch', all: true, limit: 20 } as never)
  );

  const firstOrdinary = first.elements.find((element: any) => element.id === 'ordinary');
  const thirdOrdinary = third.elements.find((element: any) => element.id === 'ordinary');
  assert.equal(typeof firstOrdinary.contrast.ratio, 'number');
  assert.equal(second.elements[0].contrast.ratio, firstOrdinary.contrast.ratio);
  assert.equal(thirdOrdinary.contrast.ratio, firstOrdinary.contrast.ratio, 'repeat calls must not drift');
});

test('computed_style documents the stroke boundaries and the new refusal codes', async () => {
  const { inspectTools } = await import('../src/daemon/tools/defs/inspect.js');
  const { description } = inspectTools.computed_style;
  for (const code of ['strokeThinnerThanAPixel', 'notPainted', 'svgNoOwnGeometry', 'deviceStrokeWidth']) {
    assert.match(description, new RegExp(code), `the description has to name ${code}`);
  }
  // The two numbers a caller needs to reason about a stroke answer, and the
  // fact that the closed-root verdict is per element rather than per call.
  assert.match(description, /device pixel/i);
  assert.match(description, /per ELEMENT rather than per call/);
  assert.ok(!description.includes('—'), 'no em-dashes in a tool description');
});
