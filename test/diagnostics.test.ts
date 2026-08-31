import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';

import { BrowserManager } from '../src/daemon/browserManager.js';
import { createToolHandlers } from '../src/daemon/tools/handlers.js';
import { SessionStore } from '../src/daemon/sessions.js';
import { inspectTools } from '../src/daemon/tools/defs/inspect.js';
import { getFreePort } from './helpers.js';

/**
 * Fixtures for the diagnostics tools: computed style, geometry, frames and
 * find.
 *
 * The colours are chosen so a contrast ratio can be asserted exactly rather
 * than approximately. #777777 on white is 4.478:1, which is the interesting
 * case precisely because it is just under the 4.5:1 AA threshold: a tool that
 * rounded, or that used a different luminance formula, would say it passes.
 * The half-white-over-blue pair exists because its computed background-color
 * is rgba(255,255,255,0.5), which is not what the eye sees, and compositing
 * is the only way to get 6.416:1 out of it.
 */
const INNER_HTML = `<!doctype html>
<html><body style="background: rgb(0,128,0)">
  <button id="innerBtn">Inner Button</button>
  <p id="innerText" style="color: rgb(0,0,0); background-color: rgb(255,255,255)">inner paragraph</p>
</body></html>`;

const OUTER_HTML = `<!doctype html>
<html>
<head>
<style>
  html, body { margin: 0; background-color: rgb(255,255,255); font-family: sans-serif; }
  #exact { color: rgb(119,119,119); background-color: rgb(255,255,255); font-size: 16px; font-weight: 400; }
  #largeText { color: rgb(119,119,119); background-color: rgb(255,255,255); font-size: 24px; font-weight: 400; }
  #blueBase { background-color: rgb(0,0,255); width: 300px; height: 100px; }
  #halfWhite { background-color: rgba(255,255,255,0.5); color: rgb(0,0,0); width: 200px; height: 50px; font-size: 16px; }
  #faded { color: rgb(0,0,0); opacity: 0.5; background-color: transparent; font-size: 16px; }
  #withBefore::before { content: "before"; color: rgb(1,2,3); font-size: 11px; }
  #hoverMe { background-color: rgb(0,0,255); width: 80px; height: 20px; }
  #hoverMe:hover { background-color: rgb(255,0,0); }
  #focusMe { outline-style: none; }
  #focusMe:focus { outline-color: rgb(255,255,0); outline-style: solid; outline-width: 3px; }
  .swatch { background-color: rgb(10,20,30); color: rgb(240,240,240); }
  #boxA { position: absolute; left: 900px; top: 400px; width: 120px; height: 40px; background-color: rgb(200,200,200); }
  #boxB { position: absolute; left: 900px; top: 460px; width: 120px; height: 40px; background-color: rgb(200,200,200); }
  #boxC { position: absolute; left: 915px; top: 520px; width: 120px; height: 40px; background-color: rgb(200,200,200); }
  #scroller { width: 100px; height: 50px; overflow: auto; position: absolute; left: 900px; top: 580px; }
  #scrollerInner { width: 400px; height: 500px; }
  #hiddenBox { display: none; }
  #farBelow { position: absolute; top: 5000px; left: 0; width: 50px; height: 50px; background-color: rgb(0,255,0); }
  #covered { position: absolute; left: 600px; top: 620px; width: 100px; height: 40px; }
  #coverer { position: absolute; left: 600px; top: 620px; width: 100px; height: 40px; background-color: rgba(0,0,0,0.01); z-index: 5; }
</style>
</head>
<body>
  <p id="exact">exact contrast sample</p>
  <p id="largeText">large text sample</p>
  <div id="blueBase"><div id="halfWhite">half white over blue</div></div>
  <p id="faded">faded text</p>
  <p id="withBefore">has a before</p>
  <div id="hoverMe"></div>
  <button id="focusMe">focus me</button>
  <div class="swatch">one</div>
  <div class="swatch">two</div>
  <div class="swatch">three</div>
  <div id="boxA"></div>
  <div id="boxB"></div>
  <div id="boxC"></div>
  <div id="scroller"><div id="scrollerInner"></div></div>
  <div id="hiddenBox">hidden text</div>
  <div id="farBelow"></div>
  <button id="covered">Covered Button</button>
  <div id="coverer"></div>
  <button data-testid="save-btn" aria-label="Save document">Save</button>
  <button>Cancel</button>
  <a href="/somewhere">A link</a>
  <iframe id="kidFrame" name="kid" src="/inner"></iframe>
<script>
  window.__clicks = [];
  document.addEventListener('click', function (e) {
    var t = e.target;
    window.__clicks.push(t.id || (t.textContent || '').trim());
  });
</script>
</body>
</html>`;

let server: Server;
let baseUrl: string;
let browserManager: BrowserManager;
let sessions: SessionStore;
let handlers: ReturnType<typeof createToolHandlers>;

before(async () => {
  server = createServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(req.url === '/inner' ? INNER_HTML : OUTER_HTML);
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

async function freshSession(): Promise<string> {
  const { sessionId } = await sessions.createSession();
  await handlers.navigate({ sessionId, url: baseUrl });
  return sessionId;
}

function payload(result: unknown): Record<string, any> {
  return (result as { structuredContent: Record<string, any> }).structuredContent;
}

async function evaluate<T>(sessionId: string, expression: string): Promise<T> {
  const result = await handlers.evaluate({ sessionId, expression });
  return payload(result).result as T;
}

/** The single element `computed_style` returns for a one-match selector. */
async function styleOf(sessionId: string, args: Record<string, unknown>): Promise<Record<string, any>> {
  const body = payload(await handlers.computed_style({ sessionId, ...args } as never));
  assert.ok(body.elements.length > 0, `computed_style matched nothing for ${JSON.stringify(args)}`);
  return body.elements[0];
}

// ---------------------------------------------------------------------------
// computed_style
// ---------------------------------------------------------------------------

test('computed_style returns the documented default properties without being asked for them', async () => {
  const sessionId = await freshSession();
  const el = await styleOf(sessionId, { selector: '#exact' });

  for (const property of ['color', 'background-color', 'font-size', 'font-weight', 'opacity', 'display', 'visibility']) {
    assert.ok(property in el.styles, `the default property set must include ${property}`);
  }
  assert.equal(el.styles.color, 'rgb(119, 119, 119)');
  assert.equal(el.styles['background-color'], 'rgb(255, 255, 255)');
  assert.equal(el.styles['font-size'], '16px');

  await sessions.releaseSession(sessionId);
});

test('computed_style honours an explicit property list and returns nothing else', async () => {
  const sessionId = await freshSession();
  const el = await styleOf(sessionId, { selector: '#exact', properties: ['color', 'font-size'] });

  assert.deepEqual(Object.keys(el.styles).sort(), ['color', 'font-size']);

  await sessions.releaseSession(sessionId);
});

test('computed_style measures a known contrast ratio exactly, and does not round it over the AA line', async () => {
  const sessionId = await freshSession();
  const el = await styleOf(sessionId, { selector: '#exact' });

  // #777777 on #ffffff. Hand-computed from the WCAG relative-luminance
  // formula: 4.478089:1, which is BELOW the 4.5:1 AA threshold for normal text.
  assert.ok(
    Math.abs(el.contrast.ratio - 4.478089) < 0.005,
    `expected a ratio of about 4.478, got ${el.contrast.ratio}`
  );
  assert.equal(el.contrast.largeText, false, '16px at weight 400 is not WCAG large text');
  assert.equal(el.contrast.thresholds.aaText, 4.5);
  assert.equal(el.contrast.thresholds.aaaText, 7);
  assert.equal(el.contrast.thresholds.nonText, 3);
  assert.equal(el.contrast.passes.aaText, false, '4.478 must not be rounded up into a pass');
  assert.equal(el.contrast.passes.nonText, true);

  await sessions.releaseSession(sessionId);
});

test('computed_style applies the large-text threshold when the text really is large', async () => {
  const sessionId = await freshSession();
  const el = await styleOf(sessionId, { selector: '#largeText' });

  assert.equal(el.contrast.largeText, true, '24px is WCAG large text');
  assert.equal(el.contrast.thresholds.aaText, 3);
  assert.equal(el.contrast.passes.aaText, true, '4.478 clears the 3:1 large-text threshold');

  await sessions.releaseSession(sessionId);
});

test('computed_style composites a semi-transparent background over its ancestors', async () => {
  const sessionId = await freshSession();
  const el = await styleOf(sessionId, { selector: '#halfWhite' });

  // The naive answer, which is exactly what an agent reading getComputedStyle
  // alone would have believed.
  assert.equal(el.styles['background-color'], 'rgba(255, 255, 255, 0.5)');

  // 50% white over rgb(0,0,255) is rgb(127.5, 127.5, 255).
  assert.equal(el.effective.backgroundColor, 'rgb(128, 128, 255)');
  assert.equal(el.effective.color, 'rgb(0, 0, 0)');
  assert.ok(
    Math.abs(el.contrast.ratio - 6.415747) < 0.005,
    `expected about 6.416 after compositing, got ${el.contrast.ratio}`
  );
  assert.ok(Array.isArray(el.effective.layers) && el.effective.layers.length >= 3, 'the composited stack must be shown');

  await sessions.releaseSession(sessionId);
});

test('computed_style folds opacity into the effective colours', async () => {
  const sessionId = await freshSession();
  const el = await styleOf(sessionId, { selector: '#faded' });

  // Black text at opacity 0.5 over white reads as rgb(127.5,127.5,127.5).
  assert.equal(el.effective.color, 'rgb(128, 128, 128)');
  assert.ok(
    Math.abs(el.contrast.ratio - 3.976653) < 0.005,
    `expected about 3.977 once opacity is folded in, got ${el.contrast.ratio}`
  );
  assert.equal(el.contrast.passes.aaText, false);

  await sessions.releaseSession(sessionId);
});

test('computed_style reads a pseudo-element rather than its host', async () => {
  const sessionId = await freshSession();
  const el = await styleOf(sessionId, { selector: '#withBefore', pseudoElement: '::before' });

  assert.equal(el.styles.color, 'rgb(1, 2, 3)');
  assert.equal(el.styles['font-size'], '11px');
  assert.equal(el.pseudoElement, '::before');

  const host = await styleOf(sessionId, { selector: '#withBefore' });
  assert.notEqual(host.styles.color, 'rgb(1, 2, 3)', 'the host must not be reported as the pseudo-element');

  await sessions.releaseSession(sessionId);
});

test('computed_style can force a pseudo-state, and puts the state back afterwards', async () => {
  const sessionId = await freshSession();

  const resting = await styleOf(sessionId, { selector: '#hoverMe' });
  assert.equal(resting.styles['background-color'], 'rgb(0, 0, 255)');

  const hovered = await styleOf(sessionId, { selector: '#hoverMe', states: ['hover'] });
  assert.equal(hovered.styles['background-color'], 'rgb(255, 0, 0)', 'a forced :hover must reach getComputedStyle');

  const restingAgain = await styleOf(sessionId, { selector: '#hoverMe' });
  assert.equal(restingAgain.styles['background-color'], 'rgb(0, 0, 255)', 'the forced state must be released');

  const focused = await styleOf(sessionId, { selector: '#focusMe', states: ['focus'] });
  assert.equal(focused.styles['outline-color'], 'rgb(255, 255, 0)');
  assert.equal(focused.styles['outline-width'], '3px');

  await sessions.releaseSession(sessionId);
});

test('computed_style compares several matching elements in one call', async () => {
  const sessionId = await freshSession();
  const body = payload(await handlers.computed_style({ sessionId, selector: '.swatch', all: true } as never));

  assert.equal(body.matched, 3);
  assert.equal(body.elements.length, 3);
  for (const el of body.elements) assert.equal(el.styles['background-color'], 'rgb(10, 20, 30)');

  const first = payload(await handlers.computed_style({ sessionId, selector: '.swatch' } as never));
  assert.equal(first.matched, 3, 'matched must still report the true total');
  assert.equal(first.elements.length, 1, 'without all:true only the first match comes back');

  await sessions.releaseSession(sessionId);
});

test('computed_style leaves the page console alone', async () => {
  const sessionId = await freshSession();
  await handlers.computed_style({ sessionId, selector: '#exact' } as never);
  await handlers.element_box({ sessionId, selectors: ['#exact'] } as never);

  const console_ = payload(await handlers.read_console({ sessionId }));
  assert.equal(console_.total, 0, 'measuring must not write into the console it is often read alongside');

  await sessions.releaseSession(sessionId);
});

test('computed_style says plainly what its compositing does not account for', () => {
  const { description } = inspectTools.computed_style;
  assert.match(description, /image|gradient/i);
  assert.match(description, /filter/i);
  assert.match(description, /blend/i);
  assert.match(description, /WCAG/);
});

// ---------------------------------------------------------------------------
// element_box
// ---------------------------------------------------------------------------

test('element_box measures several selectors in one call so alignment is comparable', async () => {
  const sessionId = await freshSession();
  const body = payload(await handlers.element_box({ sessionId, selectors: ['#boxA', '#boxB', '#boxC'] } as never));

  assert.equal(body.results.length, 3);
  const [a, b, c] = body.results.map((r: any) => r.elements[0]);
  assert.equal(a.box.x, b.box.x, 'boxA and boxB really are left-aligned');
  assert.notEqual(a.box.x, c.box.x, 'boxC really is not');
  assert.equal(c.box.x - a.box.x, 15);
  assert.equal(a.box.width, 120);
  assert.equal(a.box.height, 40);
  assert.ok(body.viewport.width > 0 && body.viewport.height > 0);

  await sessions.releaseSession(sessionId);
});

test('element_box reports client and scroll dimensions, and whether a box actually scrolls', async () => {
  const sessionId = await freshSession();
  const body = payload(await handlers.element_box({ sessionId, selectors: ['#scroller', '#boxA'] } as never));
  const scroller = body.results[0].elements[0];
  const plain = body.results[1].elements[0];

  assert.equal(scroller.scroll.width, 400);
  assert.equal(scroller.scroll.height, 500);
  assert.ok(scroller.client.width < 400 && scroller.client.height < 500);
  assert.equal(scroller.scrollable, true);
  assert.equal(plain.scrollable, false);

  await sessions.releaseSession(sessionId);
});

test('element_box distinguishes in the viewport from merely present', async () => {
  const sessionId = await freshSession();
  const body = payload(await handlers.element_box({ sessionId, selectors: ['#exact', '#farBelow'] } as never));

  assert.equal(body.results[0].elements[0].inViewport, true);
  assert.equal(body.results[1].elements[0].inViewport, false);
  assert.equal(body.results[1].elements[0].visible, true, 'off screen is not the same as not rendered');

  await sessions.releaseSession(sessionId);
});

test('element_box explains why something is not visible instead of just saying false', async () => {
  const sessionId = await freshSession();
  const body = payload(await handlers.element_box({ sessionId, selectors: ['#hiddenBox'] } as never));
  const el = body.results[0].elements[0];

  assert.equal(el.visible, false);
  assert.match(el.hiddenReasons.join(' '), /display/i);

  await sessions.releaseSession(sessionId);
});

test('element_box notices an element that is painted over by something else', async () => {
  const sessionId = await freshSession();
  const body = payload(await handlers.element_box({ sessionId, selectors: ['#covered', '#boxA'] } as never));
  const covered = body.results[0].elements[0];
  const clear = body.results[1].elements[0];

  assert.equal(covered.topmostAtCentre, false, 'a near-transparent overlay still swallows the click');
  assert.equal(covered.occludedBy.id, 'coverer');
  assert.equal(clear.topmostAtCentre, true);

  await sessions.releaseSession(sessionId);
});

test('element_box reports a selector that matched nothing as zero matches, not as an error', async () => {
  const sessionId = await freshSession();
  const body = payload(await handlers.element_box({ sessionId, selectors: ['#exact', '#nothingHere'] } as never));

  assert.equal(body.results[1].matched, 0);
  assert.deepEqual(body.results[1].elements, []);
  assert.equal(body.results[0].matched, 1);

  await sessions.releaseSession(sessionId);
});

// ---------------------------------------------------------------------------
// frames
// ---------------------------------------------------------------------------

test('list_frames enumerates every frame with a stable id and a usable selector prefix', async () => {
  const sessionId = await freshSession();
  const body = payload(await handlers.list_frames({ sessionId } as never));

  assert.equal(body.count, 2, 'the main frame and the one iframe');
  const main = body.frames.find((f: any) => f.isMainFrame);
  const kid = body.frames.find((f: any) => !f.isMainFrame);
  assert.equal(main.frameId, 'main');
  assert.equal(main.selectorPrefix, '');
  assert.equal(kid.frameId, 'main/0');
  assert.equal(kid.name, 'kid');
  assert.match(kid.url, /\/inner$/);
  assert.equal(kid.parentFrameId, 'main');
  assert.match(kid.selectorPrefix, /enter-frame/);

  await sessions.releaseSession(sessionId);
});

test('a selector prefix from list_frames reaches inside the iframe from any selector-taking tool', async () => {
  const sessionId = await freshSession();
  const frames = payload(await handlers.list_frames({ sessionId } as never));
  const kid = frames.frames.find((f: any) => !f.isMainFrame);

  const el = await styleOf(sessionId, { selector: `${kid.selectorPrefix}#innerText` });
  assert.equal(el.styles.color, 'rgb(0, 0, 0)');
  assert.equal(el.styles['background-color'], 'rgb(255, 255, 255)');

  await handlers.click({ sessionId, selector: `${kid.selectorPrefix}#innerBtn` });

  await sessions.releaseSession(sessionId);
});

test('evaluate and snapshot can be pointed at a frame by id', async () => {
  const sessionId = await freshSession();

  const outer = await evaluate<string>(sessionId, 'location.pathname');
  assert.equal(outer, '/');

  const inner = payload(await handlers.evaluate({ sessionId, frame: 'main/0', expression: 'location.pathname' } as never));
  assert.equal(inner.result, '/inner');
  assert.equal(inner.frame, 'main/0');

  const snap = payload(await handlers.snapshot({ sessionId, frame: 'main/0' } as never));
  assert.match(String(snap.snapshot), /Inner Button/);
  assert.doesNotMatch(String(snap.snapshot), /Cancel/, 'a frame-scoped snapshot must contain only that frame');
  assert.equal(snap.frame, 'main/0');
  assert.match(String(snap.url), /\/inner$/, 'the reported url must be the frame\'s, not the tab\'s');

  // A whole-tab snapshot does descend into the iframe, which is worth pinning
  // down: the tool description used to claim the opposite, and an agent that
  // believed it would have gone looking for a frame tool it did not need.
  const outerSnap = payload(await handlers.snapshot({ sessionId }));
  assert.match(String(outerSnap.snapshot), /Inner Button/);
  assert.match(String(outerSnap.snapshot), /Cancel/);

  await sessions.releaseSession(sessionId);
});

test('an unknown frame id is refused with the ids that do exist', async () => {
  const sessionId = await freshSession();
  await assert.rejects(
    () => handlers.evaluate({ sessionId, frame: 'main/9', expression: '1' } as never),
    (err: Error) => {
      assert.match(err.message, /main\/9/);
      assert.match(err.message, /list_frames/);
      return true;
    }
  );
  await sessions.releaseSession(sessionId);
});

// ---------------------------------------------------------------------------
// find
// ---------------------------------------------------------------------------

test('find hands back a selector that click actually accepts, closing the snapshot ref gap', async () => {
  const sessionId = await freshSession();
  const body = payload(await handlers.find({ sessionId, text: 'Cancel' } as never));

  assert.equal(body.matched, 1);
  const hit = body.elements[0];
  assert.equal(hit.tagName, 'button');
  assert.equal(hit.unique, true, 'the returned selector must resolve to exactly one element');
  assert.ok(!hit.selector.includes('ref='), 'a snapshot ref is not something click can take');

  await handlers.click({ sessionId, selector: hit.selector });
  const clicks = await evaluate<string[]>(sessionId, 'window.__clicks');
  assert.deepEqual(clicks, ['Cancel']);

  await sessions.releaseSession(sessionId);
});

test('find locates by role and accessible name, and by test id', async () => {
  const sessionId = await freshSession();

  const byRole = payload(await handlers.find({ sessionId, role: 'button', name: 'Save document' } as never));
  assert.equal(byRole.matched, 1);
  assert.equal(byRole.elements[0].attributes['data-testid'], 'save-btn');

  const byTestId = payload(await handlers.find({ sessionId, testId: 'save-btn' } as never));
  assert.equal(byTestId.matched, 1);
  assert.equal(byTestId.elements[0].selector, byRole.elements[0].selector, 'the same element must get the same selector');

  await sessions.releaseSession(sessionId);
});

test('find skips invisible elements unless asked not to', async () => {
  const sessionId = await freshSession();

  const visible = payload(await handlers.find({ sessionId, selector: '#hiddenBox' } as never));
  assert.equal(visible.matched, 0);

  const all = payload(await handlers.find({ sessionId, selector: '#hiddenBox', visibleOnly: false } as never));
  assert.equal(all.matched, 1);
  assert.equal(all.elements[0].visible, false);

  await sessions.releaseSession(sessionId);
});

test('find inside a frame returns a selector that already carries the frame prefix', async () => {
  const sessionId = await freshSession();
  const body = payload(await handlers.find({ sessionId, frame: 'main/0', text: 'Inner Button' } as never));

  assert.equal(body.matched, 1);
  assert.match(body.elements[0].selector, /enter-frame/);
  await handlers.click({ sessionId, selector: body.elements[0].selector });

  await sessions.releaseSession(sessionId);
});

test('find refuses a call that names no query at all', async () => {
  const sessionId = await freshSession();
  await assert.rejects(
    () => handlers.find({ sessionId } as never),
    (err: Error) => {
      assert.match(err.message, /selector|role|text|testId/);
      return true;
    }
  );
  await sessions.releaseSession(sessionId);
});

test('snapshot says that iframe contents are included and that refs are not selectors', () => {
  const { description } = inspectTools.snapshot;
  assert.match(description, /iframe/i);
  assert.match(description, /ref/);
  assert.match(description, /find/);
});

test('find says which tools its selector can be handed to', () => {
  const { description } = inspectTools.find;
  assert.match(description, /click/);
  assert.match(description, /snapshot/);
  assert.match(description, /ref/);
});
