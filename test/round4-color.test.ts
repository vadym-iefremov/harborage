import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';

import { BrowserManager } from '../src/daemon/browserManager.js';
import { createToolHandlers, type ToolHandlers } from '../src/daemon/tools/handlers.js';
import { SessionStore } from '../src/daemon/sessions.js';
import { inspectTools } from '../src/daemon/tools/defs/inspect.js';
import { decodePng, getFreePort, paintedContrastRatio, pixelAt, type DecodedPng } from './helpers.js';

/**
 * Round-4 regression suite: every way the contrast walk can fail to know what
 * is behind the glyph reaches ONE machine-readable refusal.
 *
 * The failure that produced this file is worth stating plainly, because it is
 * the same failure twice. Round 3 built the refusal machinery and wired
 * exactly one situation to it (gradient text). Six others went on producing a
 * confident 21:1 on text painted at 1.0:1, with passes.aaText true and nothing
 * a program could branch on, while the tool description disclosed all of them
 * in prose. Prose does not help a caller reading a number. So every case below
 * is measured against painted pixels, and every one of them asserts the
 * REFUSAL, not a corrected number: where the walk cannot know, the honest
 * output is null.
 *
 * Same oracle discipline as round 3: helpers.decodePng reads what Chromium
 * rasterised, helpers.paintedContrastRatio recomputes WCAG luminance longhand,
 * and neither shares a line of code with the tool.
 */

const BLOCK = '&#9608;&#9608;';

const HTML = `<!doctype html>
<html><head><style>
  html, body { margin: 0; background: rgb(0, 0, 0); }
  .g { font-family: monospace; font-size: 100px; font-weight: 900; line-height: 110px; }
  .box { position: fixed; width: 300px; height: 120px; }
</style></head>
<body>
  <!-- Every fixture is white-on-white or black-on-black once painted, so a
       tool that reports anything other than "I cannot tell you" is reporting
       a pass on text nobody can see. -->
  <div id="closedHost" style="position: fixed; left: 0; top: 0"><span id="closedSlotted" class="g" style="color: rgb(255,255,255)">${BLOCK}</span></div>

  <div class="box" style="left: 320px; top: 0; background-image: linear-gradient(rgb(255,255,255), rgb(255,255,255))"><span id="gradientAncestor" class="g" style="color: rgb(255,255,255)">${BLOCK}</span></div>

  <div class="box" style="left: 640px; top: 0"><span id="ownImage" class="g" style="display: block; width: 300px; color: rgb(255,255,255); background-image: linear-gradient(rgb(255,255,255), rgb(255,255,255))">${BLOCK}</span></div>

  <div class="box" style="left: 0; top: 140px; background: rgb(255,255,255)"><span id="inverted" class="g" style="color: rgb(0,0,0); filter: invert(1)">${BLOCK}</span></div>

  <div class="box" style="left: 320px; top: 140px; background: rgb(255,255,255)"><span id="blended" class="g" style="color: rgb(255,255,255); mix-blend-mode: difference">${BLOCK}</span></div>

  <div class="box" style="left: 640px; top: 140px; background: rgb(255,255,255)"><div style="position: absolute; inset: 0; backdrop-filter: invert(1)"><span id="behindBackdropFilter" class="g" style="color: rgb(255,255,255)">${BLOCK}</span></div></div>

  <div class="box" style="left: 0; top: 280px"><canvas id="painted" width="300" height="120" style="position: absolute; inset: 0"></canvas><div style="position: absolute; inset: 0"><span id="overCanvas" class="g" style="color: rgb(0,0,0)">${BLOCK}</span></div></div>

  <!-- Chromium never paints background-color on a non-root SVG element, so
       compositing it in invents a backdrop that is not on screen. -->
  <div class="box" style="left: 320px; top: 280px; background: rgb(255,255,255)">
    <svg width="300" height="120"><g style="background-color: rgb(0,0,0)"><text id="svgInsideG" x="0" y="100" fill="rgb(0,0,0)" style="font-family: monospace; font-size: 100px; font-weight: 900">${BLOCK}</text></g></svg>
  </div>

  <!-- An outlined shape: fill: none plus a stroke, which is every mainstream
       icon set. The stroke is deliberately thick enough to sample. -->
  <div class="box" style="left: 640px; top: 280px; background: rgb(255,255,255)">
    <svg width="300" height="120">
      <line id="strokedThick" x1="0" y1="30" x2="300" y2="30" stroke="rgb(238,238,238)" stroke-width="40" fill="none"/>
      <line id="strokedFaded" x1="0" y1="100" x2="300" y2="100" stroke="rgb(0,0,0)" stroke-opacity="0.25" stroke-width="30" fill="none"/>
    </svg>
  </div>

  <!-- Group opacity, as a solid box so the oracle is a flat interior rather
       than an antialiased glyph. -->
  <div class="box" style="left: 0; top: 420px; background: rgb(255,255,255)"><div id="fadedBox" style="position: absolute; left: 0; top: 0; width: 200px; height: 100px; background: rgb(0,0,0); opacity: 0.5"></div></div>

  <!-- A control that must keep being answered, and answered exactly. -->
  <div class="box" style="left: 320px; top: 420px; background: rgb(255,255,255)"><span id="plain" class="g" style="color: rgb(119,119,119)">${BLOCK}</span></div>

  <!-- An opaque ancestor between the text and a gradient further out: the
       gradient cannot change the pixel, so it must NOT be reported. -->
  <div class="box" style="left: 640px; top: 420px; background-image: linear-gradient(rgb(255,0,0), rgb(0,0,255))">
    <div style="position: absolute; inset: 0; background: rgb(255,255,255)"><span id="behindOpaque" class="g" style="color: rgb(119,119,119)">${BLOCK}</span></div>
  </div>
<script>
  document.getElementById('closedHost').attachShadow({ mode: 'closed' }).innerHTML =
    '<div id="closedWrapper" style="width: 300px; height: 120px; background: rgb(255,255,255)"><slot></slot></div>';
  var ctx = document.getElementById('painted').getContext('2d');
  ctx.fillStyle = 'rgb(255,255,255)';
  ctx.fillRect(0, 0, 300, 120);
</script>
</body></html>`;

let server: Server;
let baseUrl: string;
let browserManager: BrowserManager;
let sessions: SessionStore;
let handlers: ToolHandlers;

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
});

after(async () => {
  await sessions.closeAll();
  await browserManager.close();
  await new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve())));
});

function payload(result: unknown): Record<string, any> {
  return (result as { structuredContent: Record<string, any> }).structuredContent;
}

async function freshSession(): Promise<string> {
  const { sessionId } = await sessions.createSession();
  await handlers.resize({ sessionId, width: 1000, height: 600 } as never);
  await handlers.navigate({ sessionId, url: baseUrl });
  return sessionId;
}

async function capture(sessionId: string, width = 1000, height = 560): Promise<DecodedPng> {
  const result = (await handlers.screenshot({ sessionId, clip: { x: 0, y: 0, width, height } } as never)) as {
    content: { type: string; data?: string }[];
  };
  const image = result.content.find(block => block.type === 'image');
  assert.ok(image?.data, 'screenshot returned no inline image data to read pixels out of');
  return decodePng(Buffer.from(image.data, 'base64'));
}

async function styleOf(sessionId: string, selector: string): Promise<Record<string, any>> {
  const body = payload(await handlers.computed_style({ sessionId, selector } as never));
  assert.ok(body.elements.length > 0, `computed_style matched nothing for ${selector}`);
  return body.elements[0];
}

/**
 * Asserts that the tool refuses, with the expected code, on an element whose
 * painted truth is `expectedTruth`.
 *
 * The painted ratio is asserted too, which is the part that makes this a
 * regression test rather than a tautology: it proves the fixture really does
 * paint invisible (or perfectly visible) text, so a tool that answered instead
 * of refusing would be answering wrongly and not merely conservatively.
 */
function assertRefused(
  element: Record<string, any>,
  image: DecodedPng,
  glyph: [number, number],
  backdrop: [number, number],
  code: string,
  expectedTruth: number
): void {
  const paintedGlyph = pixelAt(image, glyph[0], glyph[1]);
  const paintedBackdrop = pixelAt(image, backdrop[0], backdrop[1]);
  const truth = paintedContrastRatio(paintedGlyph, paintedBackdrop);
  assert.ok(
    Math.abs(truth - expectedTruth) < 0.05,
    `the fixture is only meaningful if it paints ${expectedTruth}:1, it painted ${truth.toFixed(4)}:1 ` +
      `(glyph ${JSON.stringify(paintedGlyph)}, backdrop ${JSON.stringify(paintedBackdrop)})`
  );
  assert.equal(element.contrast.ratio, null, `expected no ratio for ${code}, got ${element.contrast.ratio}`);
  assert.equal(element.contrast.passes, null, 'a refused ratio carries no pass or fail verdict either');
  assert.ok(
    (element.contrast.unaccountedFor as string[]).includes(code),
    `expected the ${code} code, got ${JSON.stringify(element.contrast.unaccountedFor)}`
  );
  assert.ok(
    typeof element.contrast.ratioUnavailable === 'string' && element.contrast.ratioUnavailable.length > 0,
    'a refusal has to say why in words as well as in a code'
  );
  assert.equal(
    element.effective.layerChainIncomplete,
    true,
    'the one flag meaning "the stack does not account for what is painted" has to fire here'
  );
}

// ---------------------------------------------------------------------------
// Seven ways to get a confident 21:1 on text nobody can see.
// ---------------------------------------------------------------------------

test('a chain crossing a closed shadow root is refused, not answered at 21:1', async () => {
  const sessionId = await freshSession();
  const image = await capture(sessionId);
  assertRefused(await styleOf(sessionId, '#closedSlotted'), image, [30, 60], [280, 20], 'closedShadowRoot', 1);
  await sessions.releaseSession(sessionId);
});

test('a gradient on an ancestor is refused: there is no single backdrop colour to measure against', async () => {
  const sessionId = await freshSession();
  const image = await capture(sessionId);
  assertRefused(await styleOf(sessionId, '#gradientAncestor'), image, [350, 60], [600, 20], 'backgroundImage', 1);
  await sessions.releaseSession(sessionId);
});

test('the element\'s OWN background image is refused too, not just an ancestor\'s', async () => {
  const sessionId = await freshSession();
  const image = await capture(sessionId);
  // Sampled inside the element's own painted box, between the two glyphs,
  // because the point of this case is that the element covers its own backdrop.
  assertRefused(await styleOf(sessionId, '#ownImage'), image, [670, 60], [900, 60], 'backgroundImage', 1);
  await sessions.releaseSession(sessionId);
});

test('a filter on the text element is refused: it recolours everything inside it', async () => {
  const sessionId = await freshSession();
  const image = await capture(sessionId);
  assertRefused(await styleOf(sessionId, '#inverted'), image, [30, 200], [280, 160], 'filter', 1);
  await sessions.releaseSession(sessionId);
});

test('mix-blend-mode is refused: it is not the source-over this composites with', async () => {
  const sessionId = await freshSession();
  const image = await capture(sessionId);
  // This one is the mirror image of the others: the tool used to under-report
  // it at 1:1 on text that is really painted at a perfect 21:1, which produces
  // a false accessibility finding rather than a missed one. Both are wrong.
  assertRefused(await styleOf(sessionId, '#blended'), image, [350, 200], [600, 160], 'mixBlendMode', 21);
  await sessions.releaseSession(sessionId);
});

test('an intervening backdrop-filter is refused: it recolours what is behind the text', async () => {
  const sessionId = await freshSession();
  const image = await capture(sessionId);
  assertRefused(await styleOf(sessionId, '#behindBackdropFilter'), image, [670, 200], [920, 160], 'backdropFilter', 21);
  await sessions.releaseSession(sessionId);
});

test('a painted canvas under a transparent container is refused: only ancestors can be composited', async () => {
  const sessionId = await freshSession();
  const image = await capture(sessionId);
  assertRefused(await styleOf(sessionId, '#overCanvas'), image, [30, 340], [280, 300], 'foreignPainter', 21);
  await sessions.releaseSession(sessionId);
});

test('layerChainIncomplete now actually fires, and names what was unaccounted for', async () => {
  // It used to be driven by element.isConnected alone. computed_style resolves
  // elements through Playwright locators, which only ever match the live
  // document, so nothing reachable through the tool could set it: one flag
  // that never fired, sitting beside seven situations that should have set it.
  const sessionId = await freshSession();
  const codes = new Set<string>();
  for (const selector of [
    '#closedSlotted',
    '#gradientAncestor',
    '#ownImage',
    '#inverted',
    '#blended',
    '#behindBackdropFilter',
    '#overCanvas'
  ]) {
    const element = await styleOf(sessionId, selector);
    assert.equal(element.effective.layerChainIncomplete, true, `${selector} must set layerChainIncomplete`);
    assert.deepEqual(
      element.effective.unaccountedFor,
      element.contrast.unaccountedFor,
      'the codes have to agree wherever they are read from'
    );
    for (const code of element.contrast.unaccountedFor as string[]) codes.add(code);
  }
  assert.deepEqual(
    [...codes].sort(),
    ['backdropFilter', 'backgroundImage', 'closedShadowRoot', 'filter', 'foreignPainter', 'mixBlendMode'].sort(),
    `expected one distinct code per failure mode, got ${JSON.stringify([...codes])}`
  );
  await sessions.releaseSession(sessionId);
});

// ---------------------------------------------------------------------------
// The refusal has to stay narrow enough to be worth having.
// ---------------------------------------------------------------------------

test('a gradient hidden behind an opaque ancestor is NOT reported, because it cannot change the pixel', async () => {
  const sessionId = await freshSession();
  const image = await capture(sessionId);
  const element = await styleOf(sessionId, '#behindOpaque');
  const truth = paintedContrastRatio(pixelAt(image, 670, 480), pixelAt(image, 920, 440));
  assert.ok(
    typeof element.contrast.ratio === 'number',
    `a covered gradient must not make this unanswerable, got ${JSON.stringify(element.contrast)}`
  );
  assert.ok(
    Math.abs(element.contrast.ratio - truth) < 0.02,
    `expected the painted ${truth.toFixed(4)}:1, got ${element.contrast.ratio}`
  );
  assert.equal(element.effective.backgroundColor, 'rgb(255, 255, 255)');
  await sessions.releaseSession(sessionId);
});

test('an ordinary element is still answered, exactly, and carries no flags at all', async () => {
  const sessionId = await freshSession();
  const image = await capture(sessionId);
  const element = await styleOf(sessionId, '#plain');
  const truth = paintedContrastRatio(pixelAt(image, 350, 480), pixelAt(image, 600, 440));
  assert.ok(Math.abs(element.contrast.ratio - truth) < 0.02, `expected ${truth.toFixed(4)}, got ${element.contrast.ratio}`);
  assert.equal(element.effective.layerChainIncomplete, undefined);
  assert.equal(element.contrast.ratioUnavailable, undefined);
  assert.equal(element.contrast.borderline, undefined);
  await sessions.releaseSession(sessionId);
});

// ---------------------------------------------------------------------------
// SVG: what Chromium paints, and what it does not.
// ---------------------------------------------------------------------------

test('background-color on a non-root SVG element is not composited, because Chromium never paints it', async () => {
  const sessionId = await freshSession();
  const image = await capture(sessionId);
  const element = await styleOf(sessionId, '#svgInsideG');
  // Black text inside <g style="background-color: black"> on a white page.
  // The <g> background was being composited in, so the tool reported 1:1 on
  // text the browser paints at a perfect 21:1: a false failure invented out
  // of a declaration that has no effect on screen.
  const truth = paintedContrastRatio(pixelAt(image, 350, 340), pixelAt(image, 600, 300));
  assert.ok(Math.abs(truth - 21) < 0.05, `the fixture must paint 21:1, painted ${truth.toFixed(4)}`);
  assert.ok(
    Math.abs(element.contrast.ratio - truth) < 0.02,
    `expected the painted ${truth.toFixed(4)}:1, got ${element.contrast.ratio}`
  );
  assert.equal(element.effective.backgroundColor, 'rgb(255, 255, 255)', 'the <g> background is not on screen');
  await sessions.releaseSession(sessionId);
});

test('an outlined SVG shape is measured on its stroke, which is the only colour it paints', async () => {
  const sessionId = await freshSession();
  const image = await capture(sessionId);

  // fill: none plus a stroke is every Lucide, Feather and Heroicons outline
  // icon. Refusing them all was technically honest and useless: on the live
  // Acres page it refused 26 of 117 elements, all of them icons whose
  // non-text contrast is exactly what a caller wants to know.
  const thick = await styleOf(sessionId, '#strokedThick');
  const thickTruth = paintedContrastRatio(pixelAt(image, 790, 310), pixelAt(image, 790, 348));
  assert.equal(thick.effective.textPaint.property, 'stroke');
  assert.ok(
    Math.abs(thick.contrast.ratio - thickTruth) < 0.02,
    `expected the painted ${thickTruth.toFixed(4)}:1, got ${thick.contrast.ratio}`
  );

  // stroke-opacity fades the stroke on its own, before any group opacity.
  const faded = await styleOf(sessionId, '#strokedFaded');
  const fadedTruth = paintedContrastRatio(pixelAt(image, 790, 380), pixelAt(image, 790, 348));
  assert.equal(faded.effective.textPaint.property, 'stroke');
  assert.ok(
    Math.abs(faded.contrast.ratio - fadedTruth) < 0.02,
    `expected the painted ${fadedTruth.toFixed(4)}:1 with stroke-opacity folded in, got ${faded.contrast.ratio}`
  );

  await sessions.releaseSession(sessionId);
});

// ---------------------------------------------------------------------------
// Group opacity, quantised the way Chromium quantises it.
// ---------------------------------------------------------------------------

test('group opacity is quantised to an 8-bit alpha, matching the painted pixel at every opacity', async () => {
  const sessionId = await freshSession();
  const image = await capture(sessionId);
  const element = await styleOf(sessionId, '#fadedBox');
  const painted = pixelAt(image, 100, 470);
  // Black at opacity 0.5 over white. round(255 * 0.5) = 128 was the old
  // answer; Chromium renders the group into an 8-bit surface, so the fraction
  // it multiplies by is round(0.5 * 255) / 255 and the pixel is 127.
  assert.equal(painted.r, 127, `expected the browser to paint 127, it painted ${painted.r}`);
  assert.equal(element.effective.backgroundColor, 'rgb(127, 127, 127)');
  await sessions.releaseSession(sessionId);
});

test('the 8-bit opacity model matches painted pixels across 99 opacities, and the naive one does not', async () => {
  const sessionId = await freshSession();
  const cell = 40;
  const opacities: number[] = [];
  for (let step = 1; step <= 99; step += 1) opacities.push(step / 100);
  const sweepHtml =
    '<!doctype html><html><head><style>html,body{margin:0;background:rgb(255,255,255)}' +
    `.d{position:absolute;left:0;width:${cell}px;height:${cell}px;background:rgb(0,0,0)}</style></head><body>` +
    opacities.map((o, i) => `<div class="d" style="top:${i * cell}px;opacity:${o}"></div>`).join('') +
    '</body></html>';
  const sweepServer = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(sweepHtml);
  });
  await new Promise<void>(resolve => sweepServer.listen(0, '127.0.0.1', resolve));
  const sweepPort = (sweepServer.address() as { port: number }).port;

  try {
    await handlers.resize({ sessionId, width: cell + 20, height: opacities.length * cell } as never);
    await handlers.navigate({ sessionId, url: `http://127.0.0.1:${sweepPort}/` });
    const image = await capture(sessionId, cell, opacities.length * cell);

    let quantisedMisses = 0;
    let naiveMisses = 0;
    let worst = '';
    opacities.forEach((opacity, index) => {
      const painted = pixelAt(image, cell / 2, index * cell + cell / 2).r;
      const quantised = 255 - Math.round(255 * opacity);
      const naive = Math.round(255 * (1 - opacity));
      if (quantised !== painted) {
        quantisedMisses += 1;
        if (!worst) worst = `opacity ${opacity}: model ${quantised}, painted ${painted}`;
      }
      if (naive !== painted) naiveMisses += 1;
    });
    // The model the tool now uses has to be exact, and the one it used to use
    // has to be provably not, or this test is not measuring anything.
    assert.equal(quantisedMisses, 0, `the 8-bit opacity model missed ${quantisedMisses} of 99: ${worst}`);
    assert.ok(naiveMisses > 0, 'the naive model has to actually be wrong somewhere, or this proves nothing');
  } finally {
    await sessions.releaseSession(sessionId);
    await new Promise<void>((resolve, reject) => sweepServer.close(err => (err ? reject(err) : resolve())));
  }
});

test('translucent text near a threshold is marked borderline rather than given a verdict', async () => {
  const sessionId = await freshSession();
  const borderlineHtml =
    '<!doctype html><html><head><style>html,body{margin:0;background:rgb(255,255,255)}' +
    '.g{font-family:monospace;font-size:100px;font-weight:900;line-height:110px;color:rgb(0,0,0)}</style></head><body>' +
    '<span id="nearAA" class="g" style="opacity:0.532">&#9608;</span>' +
    '<span id="farFromAny" class="g" style="opacity:0.95">&#9608;</span>' +
    '</body></html>';
  const borderlineServer = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(borderlineHtml);
  });
  await new Promise<void>(resolve => borderlineServer.listen(0, '127.0.0.1', resolve));
  const port = (borderlineServer.address() as { port: number }).port;

  try {
    await handlers.navigate({ sessionId, url: `http://127.0.0.1:${port}/` });
    // 16px text, so the AA threshold is 4.5. Black at opacity 0.532 over white
    // composites to about 4.478, which is inside the 0.25 the text rasteriser
    // can move it: the browser paints the glyph one 8-bit step darker than the
    // same colour in a <div>, which puts the real ratio at about 4.54, on the
    // other side of the line.
    const near = await styleOf(sessionId, '#nearAA');
    assert.equal(near.contrast.borderline, true, `expected borderline at ${near.contrast.ratio}, near 4.5`);
    assert.match(String(near.contrast.borderlineNote), /rasteriser|gamma/i);
    assert.ok(typeof near.contrast.ratio === 'number', 'borderline is a caveat on an answer, not a refusal');

    const far = await styleOf(sessionId, '#farFromAny');
    assert.equal(far.contrast.borderline, undefined, 'a ratio nowhere near a threshold must not be marked');
  } finally {
    await sessions.releaseSession(sessionId);
    await new Promise<void>((resolve, reject) => borderlineServer.close(err => (err ? reject(err) : resolve())));
  }
});

// ---------------------------------------------------------------------------
// forced-colors, reachable through harborage's own emulate_media.
// ---------------------------------------------------------------------------

test('forced-colors: active is refused, because the browser has replaced every colour in the cascade', async () => {
  const sessionId = await freshSession();
  const before = await styleOf(sessionId, '#plain');
  assert.ok(typeof before.contrast.ratio === 'number', 'the control has to be answerable before the emulation');

  await handlers.emulate_media({ sessionId, forcedColors: 'active' } as never);
  const during = await styleOf(sessionId, '#plain');
  assert.equal(during.contrast.ratio, null, 'author colours are not what is painted under forced colours');
  assert.ok((during.contrast.unaccountedFor as string[]).includes('forcedColors'));
  assert.match(String(during.contrast.ratioUnavailable), /forced-colors/);

  // And it has to come back, or the refusal is a one-way door.
  await handlers.emulate_media({ sessionId, forcedColors: 'none' } as never);
  const after = await styleOf(sessionId, '#plain');
  assert.ok(typeof after.contrast.ratio === 'number', 'the refusal must lift when the emulation does');

  await sessions.releaseSession(sessionId);
});

// ---------------------------------------------------------------------------
// The wide-gamut overflow Chromium wraps rather than clamping.
// ---------------------------------------------------------------------------

test('a wide-gamut colour with alpha inside an opacity group is refused, and only then', async () => {
  const sessionId = await freshSession();
  const wideColors = ['color(display-p3 0 1 0 / .35)', 'color(display-p3 1 0 0 / .35)', 'oklch(0.9 0.4 140 / .35)'];
  const layerCounts = [1, 2, 3];
  const opacities = [1, 0.7, 0.4];
  const backdrops = ['rgb(255,255,255)', 'rgb(0,0,0)'];
  const cell = 22;
  const columns = 18;
  const cases: { wide: string; layers: number; opacity: number; backdrop: string }[] = [];
  for (const backdrop of backdrops) {
    for (const wide of wideColors) {
      for (const layers of layerCounts) {
        for (const opacity of opacities) cases.push({ wide, layers, opacity, backdrop });
      }
    }
  }
  const rows = Math.ceil(cases.length / columns);
  const sweepHtml =
    '<!doctype html><html><head><style>html,body{margin:0;background:rgb(128,128,128)}' +
    `.c{position:absolute;width:${cell}px;height:${cell}px}.o{position:absolute;inset:0}` +
    '.t{position:absolute;left:0;top:0;font-size:1px;line-height:1px;color:rgb(0,0,0)}</style></head><body>' +
    cases
      .map((entry, index) => {
        const x = (index % columns) * cell;
        const y = Math.floor(index / columns) * cell;
        let inner = `<span class="t" id="t${index}">x</span>`;
        for (let depth = 0; depth < entry.layers; depth += 1) {
          inner = `<div class="o" style="background:${entry.wide}">${inner}</div>`;
        }
        return (
          `<div class="c" style="left:${x}px;top:${y}px;background:${entry.backdrop}">` +
          `<div class="o" style="opacity:${entry.opacity}">${inner}</div></div>`
        );
      })
      .join('') +
    '</body></html>';
  const sweepServer = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(sweepHtml);
  });
  await new Promise<void>(resolve => sweepServer.listen(0, '127.0.0.1', resolve));
  const sweepPort = (sweepServer.address() as { port: number }).port;

  try {
    await handlers.resize({ sessionId, width: columns * cell, height: rows * cell } as never);
    await handlers.navigate({ sessionId, url: `http://127.0.0.1:${sweepPort}/` });
    const image = await capture(sessionId, columns * cell, rows * cell);
    const body = payload(await handlers.computed_style({ sessionId, selector: '.t', all: true, limit: 500 } as never));
    const byId = new Map<string, any>(body.elements.map((element: any) => [element.id, element]));

    let divergedAndAnswered = 0;
    let agreedAndRefused = 0;
    let diverged = 0;
    const complaints: string[] = [];
    cases.forEach((entry, index) => {
      const painted = pixelAt(image, (index % columns) * cell + cell - 3, Math.floor(index / columns) * cell + cell - 3);
      const element = byId.get(`t${index}`);
      assert.ok(element, `the sweep lost case t${index}`);
      const parsed = /rgb\((\d+), (\d+), (\d+)\)/.exec(element.effective.backgroundColor);
      assert.ok(parsed, 'every case still reports a composited backdrop, even when the ratio is refused');
      const delta = Math.max(
        Math.abs(Number(parsed[1]) - painted.r),
        Math.abs(Number(parsed[2]) - painted.g),
        Math.abs(Number(parsed[3]) - painted.b)
      );
      const refused = (element.contrast.unaccountedFor ?? []).includes('wideGamutOverflow');
      const shape = `${entry.wide} x${entry.layers} at opacity ${entry.opacity} over ${entry.backdrop}`;
      if (delta > 2) {
        diverged += 1;
        if (!refused) {
          divergedAndAnswered += 1;
          if (complaints.length < 5) {
            complaints.push(`answered but wrong: ${shape} painted ${painted.r},${painted.g},${painted.b} vs ${element.effective.backgroundColor}`);
          }
        }
      } else if (refused) {
        agreedAndRefused += 1;
        if (complaints.length < 5) complaints.push(`refused needlessly: ${shape}`);
      }
    });

    // The sweep only proves something if it contains real divergence.
    assert.ok(diverged > 0, 'this sweep has to contain cases Chromium actually paints differently');
    assert.equal(divergedAndAnswered, 0, `quoted a ratio where the paint diverges:\n${complaints.join('\n')}`);
    assert.equal(agreedAndRefused, 0, `refused where the paint agrees, which would make the refusal noise:\n${complaints.join('\n')}`);
  } finally {
    await sessions.releaseSession(sessionId);
    await new Promise<void>((resolve, reject) => sweepServer.close(err => (err ? reject(err) : resolve())));
  }
});

test('computed_style documents the refusal codes rather than only describing the situations in prose', () => {
  const { description } = inspectTools.computed_style;
  for (const code of [
    'unaccountedFor',
    'backgroundImage',
    'backdropFilter',
    'mixBlendMode',
    'foreignPainter',
    'forcedColors',
    'wideGamutOverflow',
    'closedShadowRoot',
    'borderline'
  ]) {
    assert.match(description, new RegExp(code), `the description has to name the ${code} code`);
  }
  assert.match(description, /stroke/, 'outlined SVG shapes are measured on their stroke, which has to be documented');
  assert.ok(!description.includes('—'), 'no em-dashes in a tool description');
});
