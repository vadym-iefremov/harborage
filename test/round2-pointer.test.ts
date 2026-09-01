import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';

import { BrowserManager } from '../src/daemon/browserManager.js';
import { createToolHandlers } from '../src/daemon/tools/handlers.js';
import { SessionStore } from '../src/daemon/sessions.js';
import { getFreePort } from './helpers.js';

/**
 * A fixture built around the one thing drag and wheel never used to check: what is really
 * drawn on top of the point they aim for.
 *
 * #occludedNode sits under #overlay, a transparent sibling sized and positioned to match it
 * exactly, the shape a loading spinner or a tooltip layer takes in a real app far more often
 * than a full-page modal backdrop does. #btn/#btnLabel and #ancestorParent/#ancestorChild
 * exist to prove the hit test does not turn every normal DOM nesting into a false failure: a
 * click aimed at a button's centre is received by whatever inline element paints there, and a
 * child with pointer-events:none hands the hit straight to its parent. #clean has nothing on
 * top of it at all. #scrollBox and #scrollOverlay repeat the same occlusion for wheel, which
 * shares resolvePointerPoint's blind spot with drag.
 */
const FIXTURE_HTML = `<!doctype html>
<html>
<body style="margin:0">
  <div id="clean" style="position:absolute;left:20px;top:20px;width:80px;height:40px;background:rgb(100,200,100)"></div>

  <button id="btn" style="position:absolute;left:20px;top:100px;width:100px;height:40px;padding:0;border:0">
    <span id="btnLabel" style="display:block;width:100%;height:100%"></span>
  </button>

  <div id="ancestorParent" style="position:absolute;left:20px;top:180px;width:100px;height:40px;background:rgb(200,200,100)">
    <span id="ancestorChild" style="pointer-events:none;display:block;width:100%;height:100%"></span>
  </div>

  <div id="occludedNode" style="position:absolute;left:20px;top:260px;width:80px;height:40px;background:rgb(51,153,255)"></div>
  <div id="overlay" style="position:absolute;left:20px;top:260px;width:80px;height:40px;background:transparent;z-index:5"></div>

  <div id="scrollBox" style="position:absolute;left:20px;top:340px;width:150px;height:80px;overflow:auto;border:1px solid rgb(153,153,153)">
    <div style="height:400px">tall content</div>
  </div>
  <div id="scrollOverlay" style="position:absolute;left:20px;top:340px;width:150px;height:80px;background:transparent;z-index:5"></div>

  <div id="cleanScrollBox" style="position:absolute;left:220px;top:340px;width:150px;height:80px;overflow:auto;border:1px solid rgb(153,153,153)">
    <div style="height:400px">tall content</div>
  </div>

<script>
  // A real pointer-event drag sensor in miniature: without it a covered node moving anyway
  // would hide the exact bug this fixture exists to reproduce.
  var node = document.getElementById('occludedNode');
  var dragging = false, startX = 0, originLeft = 0;
  node.addEventListener('pointerdown', function (e) {
    dragging = true;
    startX = e.clientX;
    originLeft = node.offsetLeft;
  });
  window.addEventListener('pointermove', function (e) {
    if (!dragging) return;
    node.style.left = (originLeft + e.clientX - startX) + 'px';
  });
  window.addEventListener('pointerup', function () { dragging = false; });
</script>
</body>
</html>`;

let server: Server;
let baseUrl: string;
let browserManager: BrowserManager;
let sessions: SessionStore;
let handlers: ReturnType<typeof createToolHandlers>;

before(async () => {
  server = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(FIXTURE_HTML);
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

/** The `structuredContent` of a tool result, typed loosely: these tests assert on individual fields. */
function payload(result: unknown): Record<string, any> {
  return (result as { structuredContent: Record<string, any> }).structuredContent;
}

/** Evaluates an expression in the session's tab and returns its value. */
async function evaluate<T>(sessionId: string, expression: string): Promise<T> {
  const result = await handlers.evaluate({ sessionId, expression });
  return payload(result).result as T;
}

/** A fresh session already sitting on the fixture page. */
async function freshSession(): Promise<string> {
  const { sessionId } = await sessions.createSession();
  await handlers.navigate({ sessionId, url: baseUrl });
  return sessionId;
}

// ---------------------------------------------------------------------------
// drag: an occluded endpoint is reported honestly, not as a clean pass
// ---------------------------------------------------------------------------

test('drag names the overlay covering its source, and does not report a clean pass', async () => {
  const sessionId = await freshSession();
  const startLeft = await evaluate<number>(sessionId, "document.getElementById('occludedNode').offsetLeft");

  const body = payload(
    await handlers.drag({ sessionId, source: { selector: '#occludedNode' }, target: { x: 300, y: 300 }, steps: 5 })
  );

  assert.equal(body.sourceHit.matchesTarget, false, 'the overlay, not the node, is really under the press point');
  assert.equal(body.sourceHit.elementAtPoint.id, 'overlay', 'the covering element must be named the way element_box names one');
  assert.equal(body.matched, false, 'a mismatched endpoint has to fail the top-level matched flag, not just a nested one');
  assert.equal(typeof body.note, 'string');
  assert.match(String(body.note), /overlay/, 'the note has to name what really received the press');

  // The trap this fixture exists to catch: without the hit test, this call would have
  // returned exactly the same shape whether or not the node actually moved.
  const endLeft = await evaluate<number>(sessionId, "document.getElementById('occludedNode').offsetLeft");
  assert.equal(endLeft, startLeft, 'the overlay really did swallow the gesture: the node underneath never moved');

  await sessions.releaseSession(sessionId);
});

test('drag reports a clean pass for an unoccluded target', async () => {
  const sessionId = await freshSession();

  const body = payload(await handlers.drag({ sessionId, source: { selector: '#clean' }, target: { x: 300, y: 300 }, steps: 5 }));

  assert.equal(body.sourceHit.matchesTarget, true);
  assert.equal(body.sourceHit.elementAtPoint, null);
  assert.equal(body.matched, true);
  assert.ok(!('note' in body), 'a clean, non-native drag must carry no note at all');

  await sessions.releaseSession(sessionId);
});

test('drag treats a hit on a descendant of the named element as a clean pass', async () => {
  const sessionId = await freshSession();

  // #btnLabel fills #btn exactly, so elementFromPoint at the button's own centre returns
  // the span, not the button. A strict identity check would call this occluded even though
  // a real click at that point opens the button just fine.
  const body = payload(await handlers.drag({ sessionId, source: { selector: '#btn' }, target: { x: 300, y: 300 }, steps: 5 }));

  assert.equal(body.sourceHit.matchesTarget, true, 'a hit on a descendant of the target is still a hit on the target');
  assert.equal(body.sourceHit.elementAtPoint, null);
  assert.equal(body.matched, true);

  await sessions.releaseSession(sessionId);
});

test('drag reports a hit that landed on an ancestor of the named element as a miss, and says it was an ancestor', async () => {
  const sessionId = await freshSession();

  // This test used to assert the opposite, and it was wrong. #ancestorChild has
  // pointer-events: none, so the browser's own hit test skips it and hands the point to
  // #ancestorParent: a real pointerdown here never runs a single listener on #ancestorChild,
  // which is exactly what the caller asked about. Round 2 accepted it because the predicate
  // also allowed hit.contains(el), and that clause is what made <body>, <html> and every
  // container on the page count as a clean hit on anything inside them. round3-pointer.test.ts
  // proves the corrected answer against a real pointerdown listener on the element itself.
  const body = payload(
    await handlers.drag({ sessionId, source: { selector: '#ancestorChild' }, target: { x: 300, y: 300 }, steps: 5 })
  );

  assert.equal(body.sourceHit.matchesTarget, false, 'the press provably goes to the parent, so this is not a hit on the child');
  assert.equal(body.sourceHit.elementAtPoint.id, 'ancestorParent', 'what really received the press has to be named');
  assert.equal(
    body.sourceHit.elementAtPoint.containsTarget,
    true,
    'an ancestor taking the press is a different diagnosis from an overlay taking it, and the caller cannot tell from a tag name'
  );
  assert.equal(body.matched, false);
  assert.match(String(body.note), /ANCESTOR/, 'the note has to give the remedy for this shape, not the z-index advice for an overlay');

  await sessions.releaseSession(sessionId);
});

test('drag does not invent a failure for a raw point with no selector to compare against', async () => {
  const sessionId = await freshSession();

  const body = payload(await handlers.drag({ sessionId, source: { x: 60, y: 280 }, target: { x: 300, y: 300 }, steps: 5 }));

  assert.equal(body.sourceHit.matchesTarget, null, 'nothing was named, so there is nothing to have matched or missed');
  assert.ok(!('matched' in body), 'with no selector on either endpoint there is nothing this call actually checked');

  await sessions.releaseSession(sessionId);
});

test('drag reports an occluded target endpoint independently of a clean source', async () => {
  const sessionId = await freshSession();

  const body = payload(
    await handlers.drag({ sessionId, source: { selector: '#clean' }, target: { selector: '#occludedNode' }, steps: 5 })
  );

  assert.equal(body.sourceHit.matchesTarget, true);
  assert.equal(body.targetHit.matchesTarget, false);
  assert.equal(body.targetHit.elementAtPoint.id, 'overlay');
  assert.equal(body.matched, false, 'one occluded endpoint is enough to fail the overall flag');
  assert.match(String(body.note), /target/, 'the note has to say which endpoint missed, not just that one did');

  await sessions.releaseSession(sessionId);
});

// ---------------------------------------------------------------------------
// wheel: shares resolvePointerPoint's blind spot, and the same fix
// ---------------------------------------------------------------------------

test('wheel names the overlay covering its point, and does not report a clean pass', async () => {
  const sessionId = await freshSession();

  const body = payload(await handlers.wheel({ sessionId, point: { selector: '#scrollBox' }, deltaY: 50 }));

  assert.equal(body.pointHit.matchesTarget, false);
  assert.equal(body.pointHit.elementAtPoint.id, 'scrollOverlay');
  assert.equal(body.matched, false);
  assert.match(String(body.note), /scrollOverlay/, 'the note has to name the real coverer');

  // The overlay is not itself scrollable and sits outside #scrollBox's own ancestor chain,
  // so nothing actually scrolled either: both signals agree this event never reached the box.
  assert.equal(body.moved, false);

  await sessions.releaseSession(sessionId);
});

test('wheel reports a clean pass and a real scroll for an unoccluded container', async () => {
  const sessionId = await freshSession();

  const body = payload(await handlers.wheel({ sessionId, point: { selector: '#cleanScrollBox' }, deltaY: 50 }));

  assert.equal(body.pointHit.matchesTarget, true);
  assert.equal(body.pointHit.elementAtPoint, null);
  assert.equal(body.matched, true);
  assert.equal(body.moved, true, 'an unoccluded scroll container really does scroll');
  assert.ok(!('note' in body), 'a clean pass that really scrolled needs no note');

  await sessions.releaseSession(sessionId);
});

test('wheel does not invent a failure for a raw point with no selector to compare against', async () => {
  const sessionId = await freshSession();

  const body = payload(await handlers.wheel({ sessionId, point: { x: 60, y: 380 }, deltaY: 50 }));

  assert.equal(body.pointHit.matchesTarget, null);
  assert.ok(!('matched' in body), 'a raw point names nothing, so there is nothing to report as matched or missed');

  await sessions.releaseSession(sessionId);
});
