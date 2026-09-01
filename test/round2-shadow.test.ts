import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';

import { BrowserManager } from '../src/daemon/browserManager.js';
import { createToolHandlers, type ToolHandlers } from '../src/daemon/tools/handlers.js';
import { SessionStore } from '../src/daemon/sessions.js';
import { getFreePort } from './helpers.js';

/**
 * Round-2 regression fixture: real, live shadow DOM (attachShadow in page
 * script, not simulated) plus an iframe nested inside a shadow root, built
 * to reproduce the four defects this file covers against actual Chromium.
 *
 * #shadowOkButton: a button in an open shadow root with nothing on top of
 * it, for element_box's occlusion false positive.
 * #shadowOccludedButton / #shadowOverlay: a button and a real, opaque
 * overlay, both inside the SAME shadow root, so the fix has to keep
 * catching a genuine occlusion rather than just disabling the check.
 * #shadowDarkText on a page painted rgb(10, 10, 10): rgb(30, 30, 30) text is
 * a real ratio of about 1.19:1, unreadable, for computed_style's contrast
 * walk.
 * #shadowFrameHost's shadow root holds an <iframe>, whose inner page has
 * "Confirm payment"; the main (light DOM) page has "Delete account", for
 * find's frame-scoped selector.
 * #shadowDragNode / #shadowDragOverlay: a miniature pointer-event drag
 * sensor and a real overlay, both inside the SAME shadow root, for
 * hitTestPointerPoint's own version of the shadowOccludedButton trap: drag
 * and wheel hit-test through document.elementFromPoint too, and
 * hit.contains(el) alone (needed so an unoccluded shadow element does not
 * read as occluded by its own host) also waves an in-root overlay through,
 * since it retargets to the identical host.
 * #shadowScrollBox / #shadowScrollOverlay: a scrollable container and a real
 * overlay, both inside the SAME shadow root, for the identical trap on
 * wheel's "point". #shadowScrollBoxClean is the same container with nothing
 * on top of it, so readScrollState's own shadow-boundary blindness (it never
 * used to look inside a shadow root at all) has something to prove against.
 */
const INNER_FRAME_HTML = `<!doctype html>
<html><body>
  <button id="innerConfirm">Confirm payment</button>
</body></html>`;

const OUTER_HTML = `<!doctype html>
<html>
<head>
<style>
  html, body { margin: 0; background: rgb(10, 10, 10); }
</style>
</head>
<body>
  <button id="mainDelete" style="position: fixed; left: 500px; top: 500px;">Delete account</button>
  <div id="shadowHost"></div>
  <div id="shadowFrameHost"></div>
<script>
  var host = document.getElementById('shadowHost');
  var root = host.attachShadow({ mode: 'open' });
  root.innerHTML =
    '<button id="shadowOkButton" style="position: fixed; left: 20px; top: 20px; width: 100px; height: 40px;">' +
      'Confirm payment' +
    '</button>' +
    '<span id="shadowDarkText" style="position: fixed; left: 20px; top: 80px; color: rgb(30, 30, 30);">' +
      'unreadable on a dark page' +
    '</span>' +
    '<div id="shadowOccludedWrap" style="position: fixed; left: 20px; top: 140px; width: 120px; height: 50px;">' +
      '<button id="shadowOccludedButton" style="position: absolute; inset: 0; width: 100%; height: 100%;">' +
        'Occluded button' +
      '</button>' +
      '<div id="shadowOverlay" style="position: absolute; inset: 0; width: 100%; height: 100%; background: rgba(0, 0, 0, 0.01);"></div>' +
    '</div>' +
    '<div id="shadowDragWrap" style="position: fixed; left: 20px; top: 220px; width: 120px; height: 50px;">' +
      '<div id="shadowDragNode" style="position: absolute; left: 0px; top: 0px; width: 100%; height: 100%; background: rgb(51, 153, 255);"></div>' +
      '<div id="shadowDragOverlay" style="position: absolute; inset: 0; width: 100%; height: 100%; background: rgba(0, 0, 0, 0.01);"></div>' +
    '</div>' +
    '<div id="shadowScrollBox" style="position: fixed; left: 160px; top: 220px; width: 150px; height: 80px; overflow: auto; border: 1px solid rgb(153, 153, 153);">' +
      '<div style="height: 400px;">tall content</div>' +
    '</div>' +
    '<div id="shadowScrollOverlay" style="position: fixed; left: 160px; top: 220px; width: 150px; height: 80px; background: rgba(0, 0, 0, 0.01);"></div>' +
    '<div id="shadowScrollBoxClean" style="position: fixed; left: 320px; top: 220px; width: 150px; height: 80px; overflow: auto; border: 1px solid rgb(153, 153, 153);">' +
      '<div style="height: 400px;">tall content</div>' +
    '</div>';

  // A real pointer-event drag sensor in miniature, the same shape
  // round2-pointer.test.ts's own #occludedNode fixture uses, just queried
  // off the shadow root: without it a covered node moving anyway would hide
  // the exact bug this fixture exists to reproduce.
  var dragNode = root.getElementById('shadowDragNode');
  var shadowDragging = false, shadowStartX = 0, shadowOriginLeft = 0;
  dragNode.addEventListener('pointerdown', function (e) {
    shadowDragging = true;
    shadowStartX = e.clientX;
    shadowOriginLeft = dragNode.offsetLeft;
  });
  window.addEventListener('pointermove', function (e) {
    if (!shadowDragging) return;
    dragNode.style.left = (shadowOriginLeft + e.clientX - shadowStartX) + 'px';
  });
  window.addEventListener('pointerup', function () { shadowDragging = false; });

  var frameHost = document.getElementById('shadowFrameHost');
  var frameRoot = frameHost.attachShadow({ mode: 'open' });
  var iframe = document.createElement('iframe');
  iframe.id = 'kidFrame';
  iframe.src = '/inner';
  iframe.style.cssText = 'position: fixed; left: 300px; top: 20px; width: 300px; height: 200px;';
  frameRoot.appendChild(iframe);

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
let handlers: ToolHandlers;

before(async () => {
  server = createServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(req.url === '/inner' ? INNER_FRAME_HTML : OUTER_HTML);
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

/** Evaluates an expression in the session's tab and returns its value. */
async function evaluate<T>(sessionId: string, expression: string): Promise<T> {
  const result = await handlers.evaluate({ sessionId, expression });
  return payload(result).result as T;
}

// ---------------------------------------------------------------------------
// Defect 1: find must never hand back a frame-scoped selector that silently
// is not frame-scoped.
// ---------------------------------------------------------------------------

test('find refuses to emit a selector for a frame whose owning iframe lives inside a shadow root', async () => {
  const sessionId = await freshSession();

  // Confirm the fixture actually reproduces the underlying condition:
  // list_frames must itself report the frame as selectorPrefixUnavailable,
  // otherwise this test would not be exercising the code path at all.
  const frames = payload(await handlers.list_frames({ sessionId }));
  const kid = frames.frames.find((f: any) => f.url.endsWith('/inner'));
  assert.ok(kid, `expected to find the nested iframe's frame, got ${JSON.stringify(frames.frames)}`);
  assert.equal(kid.selectorPrefix, undefined, 'the owning iframe sits inside a shadow root, so no prefix should be produced');
  assert.ok(
    typeof kid.selectorPrefixUnavailable === 'string' && kid.selectorPrefixUnavailable.length > 0,
    'list_frames must say plainly why no prefix could be built'
  );

  const found = payload(await handlers.find({ sessionId, frame: kid.frameId, text: 'Confirm payment' }));
  assert.equal(found.matched, 1, `expected to find the inner button, got ${JSON.stringify(found)}`);
  assert.ok(
    typeof found.frameSelectorUnavailable === 'string' && found.frameSelectorUnavailable.length > 0,
    'find must say plainly why no selector could be built for this frame'
  );
  assert.equal(found.elements.length, 1);
  const element = found.elements[0];
  // The old bug: this came back as a bare, unprefixed selector (an empty
  // prefix silently substituted for the unavailable one) that resolvesToTarget
  // certified as good, because resolvesToTarget was only ever checked inside
  // the frame's own document. That selector, run through click, matched
  // "Delete account" on the main page instead of "Confirm payment" inside the
  // frame. selector must now be null, and resolvesToTarget must not certify
  // it as usable.
  assert.equal(element.selector, null, 'no selector may be emitted for a frame whose prefix is unavailable');
  assert.equal(element.resolvesToTarget, false);
  assert.equal(element.text, 'Confirm payment');

  await sessions.releaseSession(sessionId);
});

test('find still returns a working, prefixed selector for a frame that is NOT inside a shadow root', async () => {
  const sessionId = await freshSession();
  const found = payload(await handlers.find({ sessionId, text: 'Delete account' }));
  assert.equal(found.matched, 1);
  const element = found.elements[0];
  assert.notEqual(element.selector, null, 'a main-page element must still get a real, usable selector');
  assert.equal(element.resolvesToTarget, true);
  assert.equal(found.frameSelectorUnavailable, undefined);

  await sessions.releaseSession(sessionId);
});

// ---------------------------------------------------------------------------
// Defect 2: computed_style must composite through the shadow host, not stop
// at the shadow boundary.
// ---------------------------------------------------------------------------

test('computed_style composites text inside a shadow root through the host onto the real page background', async () => {
  const sessionId = await freshSession();
  const result = payload(await handlers.computed_style({ sessionId, selector: '#shadowDarkText' }));
  assert.equal(result.matched, 1, `expected computed_style to reach into the shadow root, got ${JSON.stringify(result)}`);
  const el = result.elements[0];

  // rgb(30, 30, 30) text on an rgb(10, 10, 10) page: a real ratio of about
  // 1.19:1, nowhere near AA. The old walk stopped at the <span> itself
  // (parentElement is null at the top of a shadow root) and composited onto
  // an assumed white canvas instead, reporting a confident 16.6712:1 pass.
  assert.equal(el.effective.backgroundColor, 'rgb(10, 10, 10)', 'the walk must reach the real page background through the shadow host');
  assert.ok(el.contrast.ratio < 1.3, `expected a ratio under 1.3 for unreadable text, got ${el.contrast.ratio}`);
  assert.equal(el.contrast.passes.aaText, false, 'this text must not be reported as passing AA');
  assert.equal(el.effective.layerChainIncomplete, undefined, 'a connected element must reach the document root');

  // The layer stack itself must show the walk actually left the shadow root:
  // more than just the <span>, starting from <html> (layers is reported
  // outermost-first, element itself last).
  assert.ok(el.effective.layers.length > 1, `expected the layer chain to cross the shadow boundary, got ${JSON.stringify(el.effective.layers)}`);
  assert.equal(el.effective.layers[0].tagName, 'html');
  assert.equal(el.effective.layers[el.effective.layers.length - 1].tagName, 'span');
  assert.ok(
    el.effective.layers.some((layer: any) => layer.id === 'shadowHost'),
    'the shadow host itself must appear in the chain: that is the boundary the walk had to cross'
  );

  await sessions.releaseSession(sessionId);
});

// ---------------------------------------------------------------------------
// Defect 3: element_box must not report a shadow-DOM element as occluded by
// its own host, while still catching a real overlay inside the same root.
// ---------------------------------------------------------------------------

test('element_box reports an unoccluded shadow-DOM button as topmost, not occluded by its own host', async () => {
  const sessionId = await freshSession();
  const result = payload(await handlers.element_box({ sessionId, selectors: ['#shadowOkButton'] }));
  const el = result.results[0].elements[0];
  assert.equal(el.visible, true);
  assert.equal(el.occludedBy, null, `expected no occluder, got ${JSON.stringify(el.occludedBy)}`);
  assert.equal(el.topmostAtCentre, true, 'a button with nothing on top of it must be reported as topmost');

  await sessions.releaseSession(sessionId);
});

test('element_box still catches a real overlay sitting on top of a shadow-DOM element in the same root', async () => {
  const sessionId = await freshSession();
  const result = payload(await handlers.element_box({ sessionId, selectors: ['#shadowOccludedButton'] }));
  const el = result.results[0].elements[0];
  assert.equal(el.visible, true);
  assert.equal(el.topmostAtCentre, false, 'the overlay genuinely swallows the click; the fix must not blind the check to real occlusion');
  assert.ok(el.occludedBy, 'occludedBy must name something');
  assert.equal(el.occludedBy.id, 'shadowOverlay', `expected the overlay to be named, got ${JSON.stringify(el.occludedBy)}`);

  await sessions.releaseSession(sessionId);
});

// ---------------------------------------------------------------------------
// Defect 5 (this round): hitTestPointerPoint, drag and wheel's own shared hit
// test, has to run the same shadow drill element_box does.
//
// Confirmed directly against real Chromium, running these four tests
// against the pre-fix code: without the drill, hit.contains(el) does NOT
// cross the shadow boundary (Node.contains() follows parentNode, and a
// shadow root's host is not its content's parentNode), so
// document.elementFromPoint's retargeting to the host made EVERY selector
// inside a shadow root read as occluded by that host, occluded or not.
// #shadowDragNode and #shadowScrollBox, which have nothing genuinely wrong
// with them, failed matchesTarget before this fix exactly like
// #shadowOccludedButton did before element_box's own fix. The drill fixes
// both directions at once: an unoccluded element now compares correctly
// against the real topmost node instead of the host, and a real overlay
// sitting on top of it INSIDE THE SAME shadow root is still caught and
// named, rather than either being missed or misattributed to the host.
// ---------------------------------------------------------------------------

test('drag names the overlay covering a source inside a shadow root, in the same root as the target', async () => {
  const sessionId = await freshSession();
  const startLeft = await evaluate<number>(
    sessionId,
    "document.getElementById('shadowHost').shadowRoot.getElementById('shadowDragNode').offsetLeft"
  );

  const body = payload(
    await handlers.drag({ sessionId, source: { selector: '#shadowDragNode' }, target: { x: 500, y: 500 }, steps: 5 })
  );

  assert.equal(
    body.sourceHit.matchesTarget,
    false,
    'the overlay lives in the SAME shadow root as the target, so it retargets to the identical host and must not be waved through by hit.contains(el)'
  );
  assert.ok(body.sourceHit.elementAtPoint, 'elementAtPoint must name something');
  assert.equal(
    body.sourceHit.elementAtPoint.id,
    'shadowDragOverlay',
    `expected the overlay to be named, got ${JSON.stringify(body.sourceHit.elementAtPoint)}`
  );
  assert.equal(body.matched, false, 'a mismatched endpoint has to fail the top-level matched flag, not just a nested one');
  assert.equal(typeof body.note, 'string');
  assert.match(String(body.note), /shadowDragOverlay/, 'the note has to name what really received the press');

  // The trap this fixture exists to catch: without the fix, this call reported matched: true
  // for exactly this gesture, while the node underneath, provably, never moved at all.
  const endLeft = await evaluate<number>(
    sessionId,
    "document.getElementById('shadowHost').shadowRoot.getElementById('shadowDragNode').offsetLeft"
  );
  assert.equal(endLeft, startLeft, 'the overlay really did swallow the gesture: the node underneath never moved, which is the silent false pass a flipped flag alone would not prove');

  await sessions.releaseSession(sessionId);
});

test('drag reports a clean pass for an unoccluded element inside a shadow root', async () => {
  const sessionId = await freshSession();

  const body = payload(
    await handlers.drag({ sessionId, source: { selector: '#shadowOkButton' }, target: { x: 500, y: 500 }, steps: 5 })
  );

  assert.equal(body.sourceHit.matchesTarget, true, 'an unoccluded shadow-DOM element must not read as occluded by its own host');
  assert.equal(body.sourceHit.elementAtPoint, null);
  assert.equal(body.matched, true);
  assert.ok(!('note' in body), 'a clean, non-native drag must carry no note at all');

  await sessions.releaseSession(sessionId);
});

test('wheel names the overlay covering a point inside a shadow root, in the same root as the scrollable container', async () => {
  const sessionId = await freshSession();

  const body = payload(await handlers.wheel({ sessionId, point: { selector: '#shadowScrollBox' }, deltaY: 50 }));

  assert.equal(
    body.pointHit.matchesTarget,
    false,
    'the overlay lives in the SAME shadow root as the scroll box, so it retargets to the identical host and must not be waved through'
  );
  assert.ok(body.pointHit.elementAtPoint, 'elementAtPoint must name something');
  assert.equal(body.pointHit.elementAtPoint.id, 'shadowScrollOverlay', `expected the overlay to be named, got ${JSON.stringify(body.pointHit.elementAtPoint)}`);
  assert.equal(body.matched, false);
  assert.match(String(body.note), /shadowScrollOverlay/, 'the note has to name the real coverer');

  // The overlay is not itself scrollable, so nothing actually scrolled either: both signals
  // agree this event never reached the box.
  assert.equal(body.moved, false);

  await sessions.releaseSession(sessionId);
});

test('wheel reports a clean pass and a real scroll for an unoccluded scrollable container inside a shadow root', async () => {
  const sessionId = await freshSession();

  const body = payload(await handlers.wheel({ sessionId, point: { selector: '#shadowScrollBoxClean' }, deltaY: 50 }));

  assert.equal(body.pointHit.matchesTarget, true, 'an unoccluded shadow-DOM point must not read as occluded by its own host');
  assert.equal(body.pointHit.elementAtPoint, null);
  assert.equal(body.matched, true);
  assert.ok(!('note' in body), 'a clean pass that really scrolled needs no note');

  // Exercises readScrollState's own shadow-boundary blindness: document.elementFromPoint
  // retargets straight to the shadow host, which is not itself scrollable, so without
  // drilling through hit.shadowRoot the walk would never find #shadowScrollBoxClean at all
  // and this would report moved: false for a scroll that genuinely happened.
  assert.equal(body.moved, true, 'readScrollState must drill into the shadow root to find the real scrollable container, not stop at its host');

  await sessions.releaseSession(sessionId);
});

// ---------------------------------------------------------------------------
// Defect 4: an explicit pageId must not silently re-point the session's
// default tab.
// ---------------------------------------------------------------------------

test('a call with an explicit pageId does not change what a later call omitting pageId targets', async () => {
  const created = await handlers.create_session({});
  const { sessionId, pageId: first } = payload(created) as { sessionId: string; pageId: string };
  const opened = payload(await handlers.new_tab({ sessionId }));
  const second = opened.pageId as string;

  // new_tab makes the new tab active, matching what select_tab documents.
  const activeAfterOpen = payload(await handlers.evaluate({ sessionId, expression: '"probe"' }));
  assert.equal(activeAfterOpen.pageId, second);

  // A one-off read against the FIRST tab, passed explicitly. Before this fix,
  // resolve() rewrote activePageId as a side effect of this single call, so
  // every later call omitting pageId would silently target tab one instead
  // of tab two, with no error and nothing in the response to say so.
  await handlers.screenshot({ sessionId, pageId: first });

  const activeAfterRead = payload(await handlers.evaluate({ sessionId, expression: '"probe"' }));
  assert.equal(activeAfterRead.pageId, second, 'an explicit pageId on one call must not retarget later calls that omit it');

  // select_tab remains the one documented way to actually switch it.
  await handlers.select_tab({ sessionId, pageId: first });
  const activeAfterSelect = payload(await handlers.evaluate({ sessionId, expression: '"probe"' }));
  assert.equal(activeAfterSelect.pageId, first);

  await handlers.release_session({ sessionId });
});
