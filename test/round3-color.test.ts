import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';

import { BrowserManager } from '../src/daemon/browserManager.js';
import { createToolHandlers, type ToolHandlers } from '../src/daemon/tools/handlers.js';
import { SessionStore } from '../src/daemon/sessions.js';
import { paintedSrgb, parseCssColor } from '../src/daemon/tools/color.js';
import { inspectTools } from '../src/daemon/tools/defs/inspect.js';
import { decodePng, getFreePort, paintedContrastRatio, pixelAt, type DecodedPng } from './helpers.js';

/**
 * Round-3 regression suite for computed_style's contrast reporting.
 *
 * EVERY assertion about a ratio here is grounded in painted pixels, never in
 * a second run of the tool's own arithmetic. That is deliberate, and it is
 * the specific thing round 2 got wrong: its fixes were verified by computing
 * the expected ratio with the same parser and the same compositor the tool
 * uses, so a tool that was confidently wrong agreed with a test that was
 * confidently wrong and the round shipped green. Here the reference is a
 * screenshot: Chromium rasterised it, neither the parser nor the compositor
 * had a hand in it, and helpers.paintedContrastRatio recomputes WCAG
 * luminance longhand rather than importing the tool's version.
 *
 * The fixture uses U+2588 FULL BLOCK at 100px so a glyph has a solid
 * interior. Antialiasing at the edge of an ordinary letterform would make a
 * sampled pixel a blend of text and background, which is exactly the kind of
 * soft reference that lets a wrong number through.
 */

const SVG_NS_GLYPH = '&#9608;&#9608;';

const HTML = `<!doctype html>
<html><head><style>
  html, body { margin: 0; background: rgb(0, 0, 0); }
  .glyph { font-family: monospace; font-size: 100px; font-weight: 900; line-height: 110px; }
  .box { position: fixed; width: 300px; height: 120px; }
</style></head>
<body>
  <!-- 1. Light DOM slotted into an OPEN shadow root whose wrapper is white.
       White text, white wrapper, black page: invisible, a true 1.0:1. A
       DOM-tree walk sees span -> host -> body and reports 21:1. -->
  <div id="slotHost" style="position: fixed; left: 0; top: 0"><span id="slottedText" class="glyph" style="color: rgb(255,255,255)">${SVG_NS_GLYPH}</span></div>

  <!-- 2. The same shape with a CLOSED root. assignedSlot is specified to
       return null here, so no walk outside the root can see the wrapper. -->
  <div id="closedHost" style="position: fixed; left: 320px; top: 0"><span id="closedSlotted" class="glyph" style="color: rgb(255,255,255)">${SVG_NS_GLYPH}</span></div>

  <!-- 3. SVG text, which takes its colour from fill, not color. -->
  <div id="svgBox" class="box" style="left: 0; top: 140px; background: rgb(255,255,255)">
    <svg width="300" height="120"><text id="svgText" x="0" y="100" fill="rgb(238,238,238)" style="color: rgb(0,0,0); font-family: monospace; font-size: 100px; font-weight: 900">${SVG_NS_GLYPH}</text></svg>
  </div>

  <!-- 4. SVG filled from a paint server, and SVG with no fill at all. -->
  <div id="svgOtherBox" class="box" style="left: 320px; top: 140px; background: rgb(255,255,255)">
    <svg width="300" height="120">
      <defs><linearGradient id="grad"><stop offset="0%" stop-color="rgb(250,250,250)"/><stop offset="100%" stop-color="rgb(244,244,244)"/></linearGradient></defs>
      <text id="svgGradText" x="0" y="60" fill="url(#grad)" style="font-family: monospace; font-size: 50px; font-weight: 900">${SVG_NS_GLYPH}</text>
      <text id="svgNoFill" x="0" y="110" fill="none" style="font-family: monospace; font-size: 40px">no fill</text>
    </svg>
  </div>

  <!-- 5. -webkit-text-fill-color overriding color, with no background-clip. -->
  <div id="fillBox" class="box" style="left: 0; top: 280px; background: rgb(255,255,255)">
    <span id="fillOnly" class="glyph" style="color: rgb(0,0,0); -webkit-text-fill-color: rgb(238,238,238)">${SVG_NS_GLYPH}</span>
  </div>

  <!-- 6. background-clip: text over a gradient: the glyphs are many colours. -->
  <div id="gradBox" class="box" style="left: 0; top: 420px; background: rgb(255,255,255)">
    <span id="gradText" class="glyph" style="color: rgb(0,0,0); background-image: linear-gradient(90deg, rgb(250,250,250), rgb(244,244,244)); -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent">${SVG_NS_GLYPH}</span>
  </div>

  <!-- 7. background-clip: text with a background COLOUR and no image. The
       colour is lifted off the page and painted onto the glyphs, so it is one
       colour after all and a ratio is answerable. -->
  <div id="clipColourBox" class="box" style="left: 320px; top: 420px; background: rgb(255,255,255)">
    <span id="clipColour" class="glyph" style="color: rgb(0,0,0); background-color: rgb(238,238,238); -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent">${SVG_NS_GLYPH}</span>
  </div>

  <!-- 8. An ordinary control: nothing clever, must still match the pixels. -->
  <div id="plainBox" class="box" style="left: 0; top: 560px; background: rgb(255,255,255)">
    <span id="plainText" class="glyph" style="color: rgb(119,119,119)">${SVG_NS_GLYPH}</span>
  </div>

  <!-- 9. A wide-gamut backdrop carrying alpha, which is where clipping in the
       wrong place used to move the answer across a threshold. -->
  <div id="wideBox" class="box" style="left: 320px; top: 560px; background: rgb(0,0,0)">
    <div style="position: absolute; inset: 0; background: color(display-p3 1 0 0 / 0.7)">
      <span id="wideText" class="glyph" style="color: rgb(255,255,255)">${SVG_NS_GLYPH}</span>
    </div>
  </div>
<script>
  var openHost = document.getElementById('slotHost');
  openHost.attachShadow({ mode: 'open' }).innerHTML =
    '<div id="whiteWrapper" style="width: 300px; height: 120px; background: rgb(255,255,255)"><slot></slot></div>';
  var closedHost = document.getElementById('closedHost');
  closedHost.attachShadow({ mode: 'closed' }).innerHTML =
    '<div id="closedWrapper" style="width: 300px; height: 120px; background: rgb(255,255,255)"><slot></slot></div>';
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
  await handlers.navigate({ sessionId, url: baseUrl });
  return sessionId;
}

/** A capture of the whole fixture, decoded to raw RGBA. The oracle everything below leans on. */
async function capture(sessionId: string, width = 660, height = 700): Promise<DecodedPng> {
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
 * Asserts the tool's ratio against the ratio between two PAINTED pixels.
 *
 * The tolerance is a ratio point, not a percentage, and 0.02 is roughly what
 * 8-bit quantisation of the two sampled pixels is worth. Anything the tool
 * gets structurally wrong misses by whole ratio points, as every reproduction
 * in this file did before its fix.
 */
function assertMatchesPaint(
  element: Record<string, any>,
  image: DecodedPng,
  glyph: [number, number],
  backdrop: [number, number],
  label: string
): number {
  const paintedGlyph = pixelAt(image, glyph[0], glyph[1]);
  const paintedBackdrop = pixelAt(image, backdrop[0], backdrop[1]);
  const truth = paintedContrastRatio(paintedGlyph, paintedBackdrop);
  assert.ok(
    typeof element.contrast.ratio === 'number',
    `${label}: expected a ratio, got ${JSON.stringify(element.contrast)}`
  );
  assert.ok(
    Math.abs(element.contrast.ratio - truth) < 0.02,
    `${label}: browser painted glyph ${JSON.stringify(paintedGlyph)} on ${JSON.stringify(paintedBackdrop)}, a true ` +
      `${truth.toFixed(4)}:1, but computed_style reported ${element.contrast.ratio}:1`
  );
  return truth;
}

// ---------------------------------------------------------------------------
// Cause E: the walk has to climb the flattened tree, not the DOM tree.
// ---------------------------------------------------------------------------

test('computed_style composites slotted light DOM through the shadow wrapper that actually paints behind it', async () => {
  const sessionId = await freshSession();
  const image = await capture(sessionId);
  const el = await styleOf(sessionId, '#slottedText');

  // White text slotted into a white shadow wrapper on a black page. The
  // browser paints white on white: invisible, 1.0:1. A parentElement walk
  // jumps from the span straight to the host, never sees #whiteWrapper, and
  // composites white text onto the black page for a confident 21:1 that
  // passed both AA and AAA.
  const truth = assertMatchesPaint(el, image, [30, 60], [280, 20], 'slotted white-on-white');
  assert.ok(truth < 1.05, `the fixture must actually be invisible, painted ratio was ${truth}`);
  assert.equal(el.contrast.passes.aaText, false, 'invisible text must not be reported as passing AA');
  assert.equal(el.contrast.passes.aaaText, false);
  assert.equal(el.effective.backgroundColor, 'rgb(255, 255, 255)', 'the wrapper inside the shadow tree is the backdrop');

  // The stack has to show the walk actually went through the slot, not just
  // arrive at a plausible number by another route.
  const tagNames = el.effective.layers.map((layer: any) => layer.tagName);
  assert.ok(tagNames.includes('slot'), `the slot must appear in the composited stack, got ${JSON.stringify(tagNames)}`);
  assert.ok(
    el.effective.layers.some((layer: any) => layer.id === 'whiteWrapper'),
    'the shadow-tree wrapper is the layer the DOM walk used to miss, so it has to be in the stack'
  );
  assert.equal(el.effective.textPaint?.crossedSlot, true, 'crossing a slot is worth saying out loud');
  assert.equal(el.effective.layerChainIncomplete, undefined, 'a connected, fully walked element is not incomplete');

  await sessions.releaseSession(sessionId);
});

test('the round-2 shadow-host walk still lands exactly on the painted pixels', async () => {
  // The flattened walk replaced the parentElement walk wholesale, so the case
  // round 2 fixed has to be re-proved rather than assumed to have survived.
  const sessionId = await freshSession();
  const image = await capture(sessionId);
  const el = await styleOf(sessionId, '#plainText');
  assertMatchesPaint(el, image, [30, 620], [280, 580], 'ordinary grey text on white');
  assert.equal(el.effective.textPaint, undefined, 'an ordinary element gets no textPaint block');

  await sessions.releaseSession(sessionId);
});

test('content slotted into a CLOSED shadow root is a known gap, and the description says so rather than hiding it', async () => {
  const sessionId = await freshSession();
  const image = await capture(sessionId);
  const el = await styleOf(sessionId, '#closedSlotted');

  // The painted truth is identical to the open-root case: white on white.
  const paintedGlyph = pixelAt(image, 350, 60);
  const paintedBackdrop = pixelAt(image, 600, 20);
  const truth = paintedContrastRatio(paintedGlyph, paintedBackdrop);
  assert.ok(truth < 1.05, `the closed-root fixture must also be invisible, painted ratio was ${truth}`);

  // assignedSlot is specified to return null inside a closed root and no DOM
  // API outside the root can see the slot, so the walk cannot reach the
  // wrapper. This pins the gap in the suite instead of leaving it invisible:
  // if a later round closes it, this assertion is what says so.
  assert.ok(
    Math.abs(el.contrast.ratio - truth) > 1,
    'if the closed-root case now matches the painted pixels, the fix landed and this test and the tool ' +
      'description both need updating to stop calling it a gap'
  );
  assert.match(inspectTools.computed_style.description, /CLOSED shadow root/);
  assert.match(inspectTools.computed_style.description, /assignedSlot/);

  await sessions.releaseSession(sessionId);
});

// ---------------------------------------------------------------------------
// Which property paints the glyphs.
// ---------------------------------------------------------------------------

test('computed_style measures SVG text on its fill, which is the colour the browser paints', async () => {
  const sessionId = await freshSession();
  const image = await capture(sessionId);
  const el = await styleOf(sessionId, '#svgText');

  // fill is rgb(238,238,238) on white, a real 1.16:1. color is still black,
  // so quoting color gave a confident 21:1 AA and AAA pass.
  const truth = assertMatchesPaint(el, image, [30, 200], [280, 160], 'SVG text on white');
  assert.ok(truth < 1.3, `the fixture must be near-invisible, painted ratio was ${truth}`);
  assert.equal(el.styles.color, 'rgb(0, 0, 0)', 'color is still black, which is exactly the trap');
  assert.equal(el.effective.textPaint.property, 'fill');
  assert.equal(el.contrast.passes.aaText, false);

  await sessions.releaseSession(sessionId);
});

test('computed_style uses -webkit-text-fill-color in preference to color, because that is what paints', async () => {
  const sessionId = await freshSession();
  const image = await capture(sessionId);
  const el = await styleOf(sessionId, '#fillOnly');

  assertMatchesPaint(el, image, [30, 340], [280, 300], '-webkit-text-fill-color over white');
  assert.equal(el.styles.color, 'rgb(0, 0, 0)');
  assert.equal(el.effective.textPaint.property, '-webkit-text-fill-color');
  assert.equal(el.effective.textPaint.value, 'rgb(238, 238, 238)');
  assert.equal(el.contrast.passes.aaText, false);

  await sessions.releaseSession(sessionId);
});

test('background-clip: text with a background colour paints that colour onto the glyphs, and off the page behind them', async () => {
  const sessionId = await freshSession();
  const image = await capture(sessionId);
  const el = await styleOf(sessionId, '#clipColour');

  // -webkit-text-fill-color is transparent, so what shows through the glyph
  // is the background colour, clipped to the text. And that background is NOT
  // behind the text any more, so it must come out of the layer stack.
  assertMatchesPaint(el, image, [350, 480], [600, 440], 'background-clip: text with a colour');
  const ownLayer = el.effective.layers[el.effective.layers.length - 1];
  assert.equal(ownLayer.clippedToText, true, 'the element\'s own background moved onto the glyphs');
  assert.equal(el.effective.backgroundColor, 'rgb(255, 255, 255)', 'the backdrop is the box, not the lifted background');

  await sessions.releaseSession(sessionId);
});

// ---------------------------------------------------------------------------
// Where no single ratio exists, refusing to quote one.
// ---------------------------------------------------------------------------

test('gradient text gets no ratio at all rather than a confident wrong one', async () => {
  const sessionId = await freshSession();
  const image = await capture(sessionId);
  const el = await styleOf(sessionId, '#gradText');

  // Painted near-white on white, a true 1.05:1. The old answer was 21:1.
  const paintedGlyph = pixelAt(image, 30, 480);
  const paintedBackdrop = pixelAt(image, 280, 440);
  const truth = paintedContrastRatio(paintedGlyph, paintedBackdrop);
  assert.ok(truth < 1.2, `the fixture must be near-invisible, painted ratio was ${truth}`);

  assert.equal(el.contrast.ratio, null, 'many-coloured glyphs cannot have one ratio, so none is quoted');
  assert.equal(el.contrast.passes, null, 'and no pass or fail verdict either');
  assert.match(String(el.contrast.ratioUnavailable), /background-clip/);
  assert.match(String(el.contrast.ratioUnavailable), /screenshot/i, 'a refusal has to say what to do instead');
  // The real backdrop is still useful and still reported.
  assert.equal(el.effective.backgroundColor, 'rgb(255, 255, 255)');

  await sessions.releaseSession(sessionId);
});

test('SVG filled from a paint server, and SVG with no fill, are refused rather than answered', async () => {
  const sessionId = await freshSession();

  const gradient = await styleOf(sessionId, '#svgGradText');
  assert.equal(gradient.contrast.ratio, null);
  assert.equal(gradient.contrast.passes, null);
  assert.match(String(gradient.contrast.ratioUnavailable), /paint server|gradient|pattern/i);

  const noFill = await styleOf(sessionId, '#svgNoFill');
  assert.equal(noFill.contrast.ratio, null);
  assert.equal(noFill.contrast.passes, null);
  assert.match(String(noFill.contrast.ratioUnavailable), /stroke/i, 'the caller needs to be told where the colour went');

  await sessions.releaseSession(sessionId);
});

// ---------------------------------------------------------------------------
// Finding 10: a wide-gamut colour carrying alpha.
// ---------------------------------------------------------------------------

test('a wide-gamut backdrop with alpha composites to the pixel Chromium paints, not to a pre-clipped one', async () => {
  const sessionId = await freshSession();
  const image = await capture(sessionId);
  const el = await styleOf(sessionId, '#wideText');

  // color(display-p3 1 0 0 / 0.7) over black. Clipping the colour to the sRGB
  // corner first and then compositing gives rgb(179, 0, 0); Chromium clips
  // the PREMULTIPLIED colour and paints rgb(195, 0, 0).
  const paintedBackdrop = pixelAt(image, 600, 580);
  assert.ok(
    Math.abs(paintedBackdrop.r - 195) <= 1 && paintedBackdrop.g === 0 && paintedBackdrop.b === 0,
    `the fixture is only meaningful if Chromium paints past the sRGB corner, it painted ${JSON.stringify(paintedBackdrop)}`
  );
  assertMatchesPaint(el, image, [350, 620], [600, 580], 'white on a wide-gamut backdrop with alpha');
  assert.ok(Array.isArray(el.effective.outOfGamutColors) && el.effective.outOfGamutColors.length > 0);

  await sessions.releaseSession(sessionId);
});

test('every wide-gamut-with-alpha combination in a 588 case sweep agrees with the painted pixels on every WCAG verdict', async () => {
  const wideColors = [
    'color(display-p3 1 0 0)',
    'color(display-p3 0 1 0)',
    'color(display-p3 0 0 1)',
    'color(display-p3 1 1 0)',
    'color(rec2020 1 0.2 0)',
    'oklch(0.9 0.4 140)',
    'oklch(0.7 0.35 20)'
  ];
  const alphas = [0.1, 0.2, 0.3, 0.4, 0.5, 0.7, 0.9];
  const backdrops = ['rgb(255,255,255)', 'rgb(0,0,0)', 'rgb(128,128,128)'];
  const textColors: [string, { r: number; g: number; b: number }][] = [
    ['rgb(0,0,0)', { r: 0, g: 0, b: 0 }],
    ['rgb(255,255,255)', { r: 255, g: 255, b: 255 }],
    ['rgb(119,119,119)', { r: 119, g: 119, b: 119 }],
    ['rgb(30,60,90)', { r: 30, g: 60, b: 90 }]
  ];

  const cellPx = 24;
  const columns = 21;
  const swatches: { wide: string; alpha: number; backdrop: string }[] = [];
  for (const backdrop of backdrops) {
    for (const wide of wideColors) {
      for (const alpha of alphas) swatches.push({ wide, alpha, backdrop });
    }
  }
  const rows = Math.ceil(swatches.length / columns);

  // Each swatch is a backdrop with a wide-gamut overlay on it, and the four
  // text colours sit inside the overlay as 1px spans so computed_style has
  // something whose composited backdrop is that overlay.
  const sweepHtml =
    `<!doctype html><html><head><style>html,body{margin:0;background:rgb(200,200,200)}` +
    `.cell{position:absolute;width:${cellPx}px;height:${cellPx}px}.ov{position:absolute;inset:0}` +
    `.t{position:absolute;left:0;top:0;font-size:1px;line-height:1px}</style></head><body>` +
    swatches
      .map((swatch, index) => {
        const x = (index % columns) * cellPx;
        const y = Math.floor(index / columns) * cellPx;
        const withAlpha = swatch.wide.replace(/\)$/, ` / ${swatch.alpha})`);
        const spans = textColors
          .map(([css], textIndex) => `<span class="t" id="t${index}_${textIndex}" style="color:${css}">x</span>`)
          .join('');
        return (
          `<div class="cell" style="left:${x}px;top:${y}px;background:${swatch.backdrop}">` +
          `<div class="ov" style="background:${withAlpha}">${spans}</div></div>`
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

  const { sessionId } = await sessions.createSession();
  try {
    await handlers.resize({ sessionId, width: columns * cellPx, height: rows * cellPx } as never);
    await handlers.navigate({ sessionId, url: `http://127.0.0.1:${sweepPort}/` });
    const image = await capture(sessionId, columns * cellPx, rows * cellPx);

    const body = payload(await handlers.computed_style({ sessionId, selector: '.t', all: true, limit: 1000 } as never));
    assert.equal(body.returned, swatches.length * textColors.length, 'the sweep has to actually measure every case');
    const byId = new Map<string, any>(body.elements.map((element: any) => [element.id, element]));

    let flips = 0;
    let worstDelta = 0;
    let worstCase = '';
    const flipDetail: string[] = [];
    swatches.forEach((swatch, index) => {
      // Sampled near the bottom right of the cell, clear of the 1px spans in
      // its top left corner, so the pixel is the composited backdrop alone.
      const painted = pixelAt(image, (index % columns) * cellPx + cellPx - 4, Math.floor(index / columns) * cellPx + cellPx - 4);
      textColors.forEach(([css, rgb], textIndex) => {
        const element = byId.get(`t${index}_${textIndex}`);
        assert.ok(element, `the sweep lost case t${index}_${textIndex}`);
        const truth = paintedContrastRatio(rgb, painted);
        const reported = element.contrast.ratio as number;
        const delta = Math.abs(truth - reported);
        if (delta > worstDelta) {
          worstDelta = delta;
          worstCase = `${swatch.wide} / ${swatch.alpha} on ${swatch.backdrop}, text ${css}: painted ${truth.toFixed(4)}:1, reported ${reported}:1`;
        }
        for (const threshold of [3, 4.5, 7]) {
          if (truth >= threshold !== reported >= threshold) {
            flips += 1;
            if (flipDetail.length < 6) {
              flipDetail.push(
                `${threshold}:1 on ${swatch.wide} / ${swatch.alpha} over ${swatch.backdrop} with text ${css}: ` +
                  `painted ${truth.toFixed(3)}:1 (pixel ${painted.r},${painted.g},${painted.b}) but reported ${reported}:1 ` +
                  `(backdrop ${element.effective.backgroundColor})`
              );
            }
            break;
          }
        }
      });
    });

    // Before the premultiplied clip, this same sweep flipped 44 of 588
    // verdicts: a real pass reported as a failure and the reverse. A verdict
    // is the thing an accessibility report acts on, so the bar is zero.
    assert.equal(flips, 0, `wide-gamut-with-alpha flipped ${flips} WCAG verdicts:\n${flipDetail.join('\n')}`);
    // 0.08 is what quantising two 8-bit pixels is worth. A modelling error
    // shows up in whole ratio points, as the pre-fix worst case (2.47) did.
    assert.ok(worstDelta < 0.1, `worst disagreement with the painted pixels was ${worstDelta.toFixed(4)} on ${worstCase}`);
  } finally {
    await sessions.releaseSession(sessionId);
    await new Promise<void>((resolve, reject) => sweepServer.close(err => (err ? reject(err) : resolve())));
  }
});

test('paintedSrgb leaves every fully opaque colour exactly where clipping left it', () => {
  // The premultiplied clip has to be invisible on ordinary sRGB pages, or the
  // fix for the wide-gamut case is a regression everywhere else. At alpha 1
  // the two clips are the same operation, which is the reason it is.
  for (const value of [
    'rgb(119, 119, 119)',
    'oklab(0.5 0.1 0.05)',
    'color(display-p3 1 0 0)',
    'oklch(0.9 0.4 140)',
    'lab(100 0 0)',
    'color(srgb 0.5 0.25 0.125)'
  ]) {
    const parsed = parseCssColor(value);
    assert.ok(parsed !== null, `${value} must parse`);
    const painted = paintedSrgb(parsed);
    assert.deepEqual(
      [painted.r, painted.g, painted.b, painted.a],
      [parsed.r, parsed.g, parsed.b, parsed.a],
      `${value} is opaque, so painting it must not move it`
    );
  }

  // And with alpha it must let a channel past the sRGB corner in proportion
  // to that alpha, which is the whole point.
  const p3Red = parseCssColor('color(display-p3 1 0 0 / 0.7)');
  assert.ok(p3Red !== null);
  assert.equal(p3Red.r, 255, 'the standalone clipped colour is still the sRGB corner');
  const painted = paintedSrgb(p3Red);
  assert.ok(painted.r > 255, `expected the painted red channel past 255, got ${painted.r}`);
  assert.equal(painted.g, 0, 'a negative channel is clipped away before it ever meets a backdrop');
  // display-p3 red is about 1.093 of sRGB red, so at alpha 0.7 the
  // premultiplied channel is only 195 of 255 and nothing is clipped at all.
  // Push the alpha high enough for it to hit the corner and the clip lands on
  // the PREMULTIPLIED value, never on the straight one.
  const nearlyOpaque = parseCssColor('color(display-p3 1 0 0 / 0.95)');
  assert.ok(nearlyOpaque !== null);
  const pinned = paintedSrgb(nearlyOpaque);
  assert.ok(Math.abs(pinned.r * pinned.a - 255) < 1e-9, 'the premultiplied channel is what the clip pins to 255');
  assert.ok(pinned.r > 255, 'while the straight channel stays past the corner, which is what composites correctly');
});

test('computed_style documents the flattened-tree walk, SVG fill and the refusals', () => {
  const { description } = inspectTools.computed_style;
  assert.match(description, /FLATTENED|flattened/);
  assert.match(description, /slot/i);
  assert.match(description, /fill/);
  assert.match(description, /-webkit-text-fill-color/);
  assert.match(description, /background-clip/);
  assert.match(description, /ratioUnavailable/);
  assert.ok(!description.includes('—'), 'no em-dashes in a tool description');
});
