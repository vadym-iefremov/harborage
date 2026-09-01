import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';

import { BrowserManager } from '../src/daemon/browserManager.js';
import { createToolHandlers } from '../src/daemon/tools/handlers.js';
import { SessionStore } from '../src/daemon/sessions.js';
import { getFreePort } from './helpers.js';

/**
 * The fixture round 2 needed and did not have.
 *
 * Round 2's hit test answered "is the element at the point the target, an ancestor of it, or a
 * descendant of it". Two of those three are wrong, and the fixture below is built entirely out
 * of the shapes that prove it. Every intended target carries its own capturing pointerdown
 * listener writing into window.__hbFired, so every assertion in this file can be checked against
 * what a REAL press at the tool's own chosen coordinates actually did, rather than against the
 * string the tool chose to return. That is the whole point: round 2's tests asserted the tool's
 * verdict and nothing else, so they passed while the verdict was wrong.
 *
 * The shapes, and what each one is for:
 *
 *  - #paneNode inside #pane: the React Flow shape. The pane is an ancestor of every node, so a
 *    press that falls through a node onto the pane used to read as a clean hit on the node.
 *  - #scrimBtn under #scrimWrap::after, and #modalBtn under #modalRoot::before: the standard
 *    loading-scrim and modal-backdrop patterns. A pseudo-element retargets to the element it
 *    originates on, so the hit becomes the button's own ANCESTOR.
 *  - #visHidden, #peChild, #clipL, #wrappedInline: four ways for a press aimed at an element's
 *    box to land on that element's ancestor instead while the element's own listeners never run.
 *  - #openHost and #closedHost: the control pair for the shadow drill. Identical geometry; only
 *    the open one can be drilled into, and round 2 failed exactly and only that one.
 *  - #slotWrapper: the same class of bug from the other side. The wrapper lives in a shadow tree
 *    and paints around slotted light-DOM children, so the hit is a node whose DOM parent is the
 *    host, not the wrapper. contains() cannot see that; the flattened tree can.
 *  - #peOverlayTarget and #zeroOpTarget: the two answers that were already right and must stay
 *    right. A pointer-events: none overlay really does let the press through; a zero-opacity one
 *    really does swallow it.
 *  - #nestedDeep: a shadow root inside a shadow root, so the drill's own loop is exercised.
 */
const FIXTURE_HTML = `<!doctype html>
<html>
<head>
<style>
  body { margin: 0; font: 16px/1.4 monospace; }
  .box { position: absolute; }
  #scrimWrap::after { content: ''; position: absolute; inset: 0; background: rgba(0,0,0,0.25); }
  #modalRoot::before { content: ''; position: absolute; inset: 0; background: rgba(0,0,0,0.35); z-index: 1; }
</style>
</head>
<body>
  <div id="pane" class="box" style="left:20px;top:20px;width:600px;height:120px;background:rgb(240,240,240)">
    <div id="paneNode" style="position:absolute;left:10px;top:10px;width:100px;height:40px;background:rgb(120,160,240)"></div>
  </div>

  <div id="scrimWrap" class="box" style="left:20px;top:160px;width:200px;height:60px;background:rgb(230,230,230)">
    <button id="scrimBtn" style="position:absolute;left:20px;top:10px;width:120px;height:40px">go</button>
  </div>

  <div id="modalRoot" class="box" style="left:240px;top:160px;width:200px;height:60px;background:rgb(230,230,230)">
    <button id="modalBtn" style="position:absolute;left:20px;top:10px;width:120px;height:40px">ok</button>
  </div>

  <div id="visWrap" class="box" style="left:20px;top:240px;width:200px;height:60px;background:rgb(220,220,220)">
    <div id="visHidden" style="position:absolute;left:20px;top:10px;width:120px;height:40px;background:rgb(200,80,80);visibility:hidden"></div>
  </div>

  <div id="peWrap" class="box" style="left:240px;top:240px;width:200px;height:60px;background:rgb(220,220,220)">
    <div id="peChild" style="position:absolute;left:20px;top:10px;width:120px;height:40px;background:rgb(80,200,120);pointer-events:none"></div>
  </div>

  <div id="clipWrap" class="box" style="left:20px;top:320px;width:140px;height:140px;background:rgb(215,215,215)">
    <div id="clipL" style="position:absolute;left:20px;top:20px;width:100px;height:100px;background:rgb(240,180,60);clip-path:polygon(0 0, 40px 0, 40px 60px, 100px 60px, 100px 100px, 0 100px)"></div>
  </div>

  <div id="inlineWrap" class="box" style="left:200px;top:320px;width:300px;background:rgb(215,215,215)">aaaaaaaaaaaaaaaaaaaaaaaaaaaa <span id="wrappedInline">bb cc</span></div>

  <div id="openHost" class="box" style="left:20px;top:480px;width:140px;height:50px"></div>
  <div id="closedHost" class="box" style="left:200px;top:480px;width:140px;height:50px"></div>
  <div id="slotHost" class="box" style="left:380px;top:480px;width:140px;height:50px"><span id="slottedSpan" style="display:block;width:140px;height:50px;background:rgb(160,200,160)">slotted</span></div>
  <div id="nestedHost" class="box" style="left:560px;top:480px;width:140px;height:50px"></div>

  <div id="peOverlayTarget" class="box" style="left:20px;top:560px;width:140px;height:50px;background:rgb(120,120,220)"></div>
  <div id="peOverlay" class="box" style="left:20px;top:560px;width:140px;height:50px;background:rgb(20,20,20);pointer-events:none;z-index:5"></div>

  <div id="zeroOpTarget" class="box" style="left:200px;top:560px;width:140px;height:50px;background:rgb(120,220,120)"></div>
  <div id="zeroOpOverlay" class="box" style="left:200px;top:560px;width:140px;height:50px;background:rgb(20,20,20);opacity:0;z-index:5"></div>

  <div id="cleanTarget" class="box" style="left:380px;top:560px;width:140px;height:50px;background:rgb(220,180,120)"></div>

  <div id="scrollBox" class="box" style="left:20px;top:640px;width:180px;height:80px;overflow:auto;border:1px solid rgb(150,150,150)"><div style="height:400px">tall</div></div>
  <div id="scrollPane" class="box" style="left:240px;top:640px;width:300px;height:120px;overflow:hidden;background:rgb(235,235,235)">
    <div id="scrollInner" style="position:absolute;left:10px;top:10px;width:120px;height:60px;overflow:auto;border:1px solid rgb(150,150,150)"><div style="height:400px">tall</div></div>
  </div>

<script>
  // The oracle. A capturing pointerdown listener directly on each intended target fires if and
  // only if that target is on the composed path of the real event, which is exactly the question
  // the hit test is trying to answer. No inference, no reading of the tool's own output.
  window.__hbFired = {};
  window.__hbArm = function (el, id) {
    if (!el) return;
    el.addEventListener('pointerdown', function () { window.__hbFired[id] = true; }, true);
  };
  var lightIds = ['pane','paneNode','scrimWrap','scrimBtn','modalRoot','modalBtn','visWrap','visHidden',
                  'peWrap','peChild','clipWrap','clipL','inlineWrap','wrappedInline','openHost','closedHost',
                  'slotHost','slottedSpan','nestedHost','peOverlayTarget','peOverlay','zeroOpTarget',
                  'zeroOpOverlay','cleanTarget','scrollBox','scrollInner'];
  for (var i = 0; i < lightIds.length; i += 1) window.__hbArm(document.getElementById(lightIds[i]), lightIds[i]);

  var openRoot = document.getElementById('openHost').attachShadow({ mode: 'open' });
  openRoot.innerHTML = '<div id="openInner" style="width:140px;height:50px;background:rgb(180,140,220)">open</div>';
  window.__hbArm(openRoot.getElementById('openInner'), 'openInner');

  var closedRoot = document.getElementById('closedHost').attachShadow({ mode: 'closed' });
  closedRoot.innerHTML = '<div id="closedInner" style="width:140px;height:50px;background:rgb(140,180,220)">closed</div>';

  // A shadow-tree wrapper that paints around slotted light-DOM children. The wrapper is on the
  // composed path of a press on the slotted span, but the span's DOM parent is the host, so no
  // amount of contains() will ever find the relationship.
  var slotRoot = document.getElementById('slotHost').attachShadow({ mode: 'open' });
  slotRoot.innerHTML = '<div id="slotWrapper" style="width:140px;height:50px;background:rgb(220,200,140);padding:0"><slot></slot></div>';
  window.__hbArm(slotRoot.getElementById('slotWrapper'), 'slotWrapper');

  var outerRoot = document.getElementById('nestedHost').attachShadow({ mode: 'open' });
  outerRoot.innerHTML = '<div id="innerHost" style="width:140px;height:50px"></div>';
  var innerHost = outerRoot.getElementById('innerHost');
  window.__hbArm(innerHost, 'innerHost');
  var innerRoot = innerHost.attachShadow({ mode: 'open' });
  innerRoot.innerHTML = '<div id="nestedDeep" style="width:140px;height:50px;background:rgb(200,160,200)">deep</div>';
  window.__hbArm(innerRoot.getElementById('nestedDeep'), 'nestedDeep');
</script>
</body>
</html>`;

/**
 * A second page, served separately because its backdrop covers everything: a ::before on <body>
 * itself. That is the worst case for the old predicate, because <body> contains every element on
 * the page, so every selector on this page reported a clean hit while nothing was reachable.
 */
const BODY_SCRIM_HTML = `<!doctype html>
<html>
<head><style>
  body { margin: 0; }
  body::before { content: ''; position: fixed; inset: 0; background: rgba(0,0,0,0.4); z-index: 99; }
</style></head>
<body>
  <button id="buriedBtn" style="position:absolute;left:20px;top:20px;width:140px;height:44px">buy</button>
<script>
  window.__hbFired = {};
  document.getElementById('buriedBtn').addEventListener('pointerdown', function () { window.__hbFired.buriedBtn = true; }, true);
</script>
</body>
</html>`;

/** Eleven elements matching one selector, the Acres .react-flow__node shape that finding 5 is about. */
const MULTI_MATCH_HTML = `<!doctype html>
<html><body style="margin:0">
<div id="rows"></div>
<script>
  var html = '';
  for (var i = 0; i < 11; i += 1) {
    html += '<div class="row" id="row' + i + '" style="position:absolute;left:20px;top:' + (20 + i * 50) + 'px;width:120px;height:40px;background:rgb(200,200,240)"></div>';
  }
  document.getElementById('rows').innerHTML = html;
  window.__hbFired = {};
  document.getElementById('row0').addEventListener('pointerdown', function () { window.__hbFired.row0 = true; }, true);
</script>
</body></html>`;

/** An element whose true centre is off screen, with an unrelated bar sitting at the clamped point. */
const OFFSCREEN_HTML = `<!doctype html>
<html><body style="margin:0">
  <div id="bar" style="position:fixed;left:0;top:300px;width:200px;height:40px;background:rgb(220,80,80);z-index:9"></div>
  <div id="wide" style="position:absolute;left:-260px;top:200px;width:300px;height:240px;background:rgb(120,200,120)"></div>
</body></html>`;

let server: Server;
let baseUrl: string;
let browserManager: BrowserManager;
let sessions: SessionStore;
let handlers: ReturnType<typeof createToolHandlers>;

before(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    const body =
      path === '/body-scrim'
        ? BODY_SCRIM_HTML
        : path === '/multi'
          ? MULTI_MATCH_HTML
          : path === '/offscreen'
            ? OFFSCREEN_HTML
            : FIXTURE_HTML;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(body);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;

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

async function evaluate<T>(sessionId: string, expression: string): Promise<T> {
  const result = await handlers.evaluate({ sessionId, expression });
  return payload(result).result as T;
}

async function sessionOn(path = '/'): Promise<string> {
  const { sessionId } = await sessions.createSession();
  await handlers.navigate({ sessionId, url: `${baseUrl}${path}` });
  return sessionId;
}

/** Clears the oracle's record so one gesture's result cannot be read as another's. */
function resetOracle(sessionId: string): Promise<unknown> {
  return evaluate(sessionId, 'window.__hbFired = {}, "ok"');
}

/** Whether the intended target's own pointerdown listener fired. The ground truth. */
function oracleFired(sessionId: string, id: string): Promise<boolean> {
  return evaluate<boolean>(sessionId, `!!window.__hbFired[${JSON.stringify(id)}]`);
}

/**
 * Presses at a raw viewport point with a real mouse and nothing else.
 *
 * Goes through drag with a selector-less source and target so the gesture is a genuine
 * mouse.move + mouse.down + mouse.up at those exact coordinates. No selector means no hit test
 * verdict is produced at all, so this cannot smuggle the thing under test into the oracle.
 */
async function pressAt(sessionId: string, x: number, y: number): Promise<void> {
  await handlers.drag({ sessionId, source: { x, y }, target: { x, y }, steps: 1 });
}

/**
 * Runs drag against one endpoint spec, and returns the tool's verdict next to the oracle's.
 *
 * The drag itself is the real gesture: it presses at the coordinates the tool resolved, so the
 * listener on `expectId` fires exactly when a real pointer event reached that element.
 */
async function dragVerdictVsOracle(
  sessionId: string,
  source: Record<string, unknown>,
  expectId: string
): Promise<{ verdict: boolean | null; fired: boolean; body: Record<string, any> }> {
  await resetOracle(sessionId);
  const body = payload(await handlers.drag({ sessionId, source, target: { x: 700, y: 20 }, steps: 3 }));
  const fired = await oracleFired(sessionId, expectId);
  return { verdict: body.sourceHit.matchesTarget, fired, body };
}

// ---------------------------------------------------------------------------
// Cause A: an ancestor at the point is not a hit on the target
// ---------------------------------------------------------------------------

// centreMisses says whether the element's own CENTRE misses it, which is the only point
// element_box ever tests. The pane case is a drag-only shape: its miss comes from an offset
// falling off the node, and element_box has no notion of an offset.
const ancestorMissCases: { name: string; source: Record<string, unknown>; id: string; coverer: string; centreMisses: boolean }[] = [
  // The Acres shape: an offset that falls off the node and onto the pane behind it.
  { name: 'a drag endpoint just outside a node lands on the pane', source: { selector: '#paneNode', x: 200, y: 20 }, id: 'paneNode', coverer: 'pane', centreMisses: false },
  { name: 'a button under its own wrapper\'s ::after scrim', source: { selector: '#scrimBtn' }, id: 'scrimBtn', coverer: 'scrimWrap', centreMisses: true },
  { name: 'a button under a modal root\'s ::before backdrop', source: { selector: '#modalBtn' }, id: 'modalBtn', coverer: 'modalRoot', centreMisses: true },
  { name: 'a visibility: hidden target', source: { selector: '#visHidden' }, id: 'visHidden', coverer: 'visWrap', centreMisses: true },
  { name: 'a pointer-events: none target', source: { selector: '#peChild' }, id: 'peChild', coverer: 'peWrap', centreMisses: true },
  { name: 'a clip-path L whose box centre is in the cut-out', source: { selector: '#clipL' }, id: 'clipL', coverer: 'clipWrap', centreMisses: true },
  { name: 'a wrapped inline whose box centre falls between its line boxes', source: { selector: '#wrappedInline' }, id: 'wrappedInline', coverer: 'inlineWrap', centreMisses: true }
];

for (const shape of ancestorMissCases) {
  test(`drag: ${shape.name} is reported as a miss, and the oracle agrees`, async () => {
    const sessionId = await sessionOn();
    const { verdict, fired, body } = await dragVerdictVsOracle(sessionId, shape.source, shape.id);

    assert.equal(fired, false, `the fixture is wrong if a real press at these coordinates DID reach #${shape.id}`);
    assert.equal(verdict, false, `the press provably never reached #${shape.id}, so matchesTarget must not be true`);
    assert.ok(body.sourceHit.elementAtPoint, 'the element that really received the press has to be named');
    assert.equal(body.sourceHit.elementAtPoint.id, shape.coverer, `expected #${shape.coverer} to be named, got ${JSON.stringify(body.sourceHit.elementAtPoint)}`);
    assert.equal(body.sourceHit.elementAtPoint.containsTarget, true, 'this shape is an ANCESTOR taking the press, which is worth saying: the remedy is different from an overlay');
    assert.equal(body.matched, false);
    assert.match(String(body.note), new RegExp(shape.coverer));

    await sessions.releaseSession(sessionId);
  });
}

test('drag: a body::before backdrop buries every selector on the page, and is not waved through', async () => {
  const sessionId = await sessionOn('/body-scrim');

  await resetOracle(sessionId);
  const body = payload(await handlers.drag({ sessionId, source: { selector: '#buriedBtn' }, target: { x: 400, y: 400 }, steps: 3 }));
  const fired = await oracleFired(sessionId, 'buriedBtn');

  assert.equal(fired, false, 'the fixture is wrong if the press reached the button through a fixed, opaque-ish backdrop');
  assert.equal(body.sourceHit.matchesTarget, false, '<body> contains everything, which is exactly why containment is the wrong test');
  assert.equal(body.sourceHit.elementAtPoint.tagName, 'body');
  assert.equal(body.matched, false);

  await sessions.releaseSession(sessionId);
});

// ---------------------------------------------------------------------------
// Cause B: the shadow drill must not descend past the target
// ---------------------------------------------------------------------------

test('drag: an open shadow host is a clean hit, and the closed one it is a control for behaves identically', async () => {
  const sessionId = await sessionOn();

  const open = await dragVerdictVsOracle(sessionId, { selector: '#openHost' }, 'openHost');
  assert.equal(open.fired, true, 'the host really does receive the press: it is on the composed path of its own shadow content');
  assert.equal(open.verdict, true, 'an open shadow host must not be reported as occluded by its own shadow content');
  assert.equal(open.body.sourceHit.elementAtPoint, null);

  const closed = await dragVerdictVsOracle(sessionId, { selector: '#closedHost' }, 'closedHost');
  assert.equal(closed.fired, true);
  assert.equal(closed.verdict, true, 'the closed host was always right; open and closed have identical geometry and must agree');

  await sessions.releaseSession(sessionId);
});

test('drag: a shadow-tree wrapper painting around slotted light-DOM children is a clean hit', async () => {
  const sessionId = await sessionOn();

  const { verdict, fired } = await dragVerdictVsOracle(sessionId, { selector: '#slotWrapper' }, 'slotWrapper');

  assert.equal(fired, true, 'the wrapper is in the composed path of a press on its slotted child: its listener really fires');
  assert.equal(
    verdict,
    true,
    'the slotted span\'s DOM parent is the host, not the wrapper, so contains() can never see this: the flattened tree can'
  );

  await sessions.releaseSession(sessionId);
});

test('drag: a target nested two shadow roots deep is a clean hit', async () => {
  const sessionId = await sessionOn();

  const deep = await dragVerdictVsOracle(sessionId, { selector: '#nestedDeep' }, 'nestedDeep');
  assert.equal(deep.fired, true);
  assert.equal(deep.verdict, true);

  const outer = await dragVerdictVsOracle(sessionId, { selector: '#nestedHost' }, 'nestedHost');
  assert.equal(outer.fired, true, 'the outer host is on the composed path of its grandchild shadow content');
  assert.equal(outer.verdict, true);

  await sessions.releaseSession(sessionId);
});

// ---------------------------------------------------------------------------
// The answers that were already right, guarded against the fix
// ---------------------------------------------------------------------------

test('drag: a pointer-events: none overlay is still a clean hit', async () => {
  const sessionId = await sessionOn();
  const { verdict, fired, body } = await dragVerdictVsOracle(sessionId, { selector: '#peOverlayTarget' }, 'peOverlayTarget');

  assert.equal(fired, true, 'a pointer-events: none overlay really does let the press through');
  assert.equal(verdict, true);
  assert.equal(body.sourceHit.elementAtPoint, null);

  await sessions.releaseSession(sessionId);
});

test('drag: a zero-opacity overlay is still caught and named', async () => {
  const sessionId = await sessionOn();
  const { verdict, fired, body } = await dragVerdictVsOracle(sessionId, { selector: '#zeroOpTarget' }, 'zeroOpTarget');

  assert.equal(fired, false, 'an invisible overlay still swallows the press');
  assert.equal(verdict, false);
  assert.equal(body.sourceHit.elementAtPoint.id, 'zeroOpOverlay');
  assert.equal(body.sourceHit.elementAtPoint.containsTarget, false, 'a sibling overlay is not an ancestor: the two need different remedies');

  await sessions.releaseSession(sessionId);
});

test('drag: an ordinary unoccluded element is still a clean hit', async () => {
  const sessionId = await sessionOn();
  const { verdict, fired, body } = await dragVerdictVsOracle(sessionId, { selector: '#cleanTarget' }, 'cleanTarget');

  assert.equal(fired, true);
  assert.equal(verdict, true);
  assert.ok(!('note' in body), 'a clean, non-native drag must carry no note at all');

  await sessions.releaseSession(sessionId);
});

// ---------------------------------------------------------------------------
// element_box: the same predicate, the same oracle
// ---------------------------------------------------------------------------

for (const shape of ancestorMissCases.filter(one => one.centreMisses)) {
  test(`element_box: ${shape.name} does not report topmostAtCentre true`, async () => {
    const sessionId = await sessionOn();
    const el = payload(await handlers.element_box({ sessionId, selectors: [`#${shape.id}`] })).results[0].elements[0];

    if (el.topmostAtCentre === null) {
      // visibility: hidden never reaches the hit test at all, which is its own honest answer.
      assert.equal(el.visible, false, 'a null hit test needs a reason, and "not visible" is the only one that applies here');
      await sessions.releaseSession(sessionId);
      return;
    }

    // The oracle: press at the exact point element_box says it tested.
    await resetOracle(sessionId);
    await pressAt(sessionId, el.hitTestPoint.x, el.hitTestPoint.y);
    const fired = await oracleFired(sessionId, shape.id);

    assert.equal(fired, false, `the fixture is wrong if a real press at ${JSON.stringify(el.hitTestPoint)} DID reach #${shape.id}`);
    assert.equal(el.topmostAtCentre, false, 'the tool must agree with the page about whether a click gets there');
    assert.equal(el.occludedBy.id, shape.coverer);
    assert.equal(el.occludedBy.containsTarget, true);

    await sessions.releaseSession(sessionId);
  });
}

test('element_box: an open shadow host is topmost, matching the closed control and the oracle', async () => {
  const sessionId = await sessionOn();
  const result = payload(await handlers.element_box({ sessionId, selectors: ['#openHost', '#closedHost', '#slotWrapper', '#nestedHost'] }));

  for (const [index, id] of ['openHost', 'closedHost', 'slotWrapper', 'nestedHost'].entries()) {
    const el = result.results[index].elements[0];
    await resetOracle(sessionId);
    await pressAt(sessionId, el.hitTestPoint.x, el.hitTestPoint.y);
    const fired = await oracleFired(sessionId, id);
    assert.equal(fired, true, `a real press at #${id}'s centre reaches it`);
    assert.equal(el.topmostAtCentre, true, `#${id} must be reported as topmost, not occluded by its own shadow content`);
    assert.equal(el.occludedBy, null);
  }

  await sessions.releaseSession(sessionId);
});

test('element_box: a zero-opacity overlay is still caught, a pointer-events: none one still is not', async () => {
  const sessionId = await sessionOn();
  const result = payload(await handlers.element_box({ sessionId, selectors: ['#zeroOpTarget', '#peOverlayTarget'] }));

  const covered = result.results[0].elements[0];
  await resetOracle(sessionId);
  await pressAt(sessionId, covered.hitTestPoint.x, covered.hitTestPoint.y);
  assert.equal(await oracleFired(sessionId, 'zeroOpTarget'), false);
  assert.equal(covered.topmostAtCentre, false);
  assert.equal(covered.occludedBy.id, 'zeroOpOverlay');

  const through = result.results[1].elements[0];
  await resetOracle(sessionId);
  await pressAt(sessionId, through.hitTestPoint.x, through.hitTestPoint.y);
  assert.equal(await oracleFired(sessionId, 'peOverlayTarget'), true);
  assert.equal(through.topmostAtCentre, true);
  assert.equal(through.occludedBy, null);

  await sessions.releaseSession(sessionId);
});

// ---------------------------------------------------------------------------
// Finding 10: an off-screen centre is not evidence of an overlay
// ---------------------------------------------------------------------------

test('element_box does not blame an overlay for an element whose centre is off screen', async () => {
  const sessionId = await sessionOn('/offscreen');
  const el = payload(await handlers.element_box({ sessionId, selectors: ['#wide'] })).results[0].elements[0];

  assert.equal(el.hitTestPointIsCentre, false, 'the fixture is wrong if this element\'s centre is on screen');
  assert.equal(el.topmostAtCentre, null, 'the point tested is not the centre, so a failure there is not evidence about the element');
  assert.equal(el.occludedBy, null, 'naming the bar at the clamped point as an occluder is the defect');
  assert.match(String(el.topmostUnknownReason), /scroll/i, 'the caller has to be told what to do instead: scroll it into view first');

  await sessions.releaseSession(sessionId);
});

// ---------------------------------------------------------------------------
// Finding 5: a multi-match endpoint is not "the element appears late"
// ---------------------------------------------------------------------------

test('drag takes the first match of a multi-match endpoint and says so, instead of timing out', async () => {
  const sessionId = await sessionOn('/multi');
  await resetOracle(sessionId);

  const startedAt = Date.now();
  const body = payload(await handlers.drag({ sessionId, source: { selector: '.row' }, target: { x: 500, y: 400 }, steps: 3 }));
  const elapsed = Date.now() - startedAt;

  assert.ok(elapsed < 3000, `a multi-match selector must fail fast or resolve fast, took ${elapsed}ms`);
  assert.equal(body.source.matchedElements, 11, 'the caller has to be told the selector was ambiguous');
  assert.equal(await oracleFired(sessionId, 'row0'), true, 'the FIRST match is what was really pressed');
  assert.match(String(body.note), /11/, 'the ambiguity has to reach the note, not just a field');

  await sessions.releaseSession(sessionId);
});

test('wheel takes the first match of a multi-match point and says so, instead of timing out', async () => {
  const sessionId = await sessionOn('/multi');

  const startedAt = Date.now();
  const body = payload(await handlers.wheel({ sessionId, point: { selector: '.row' }, deltaY: 50 }));
  const elapsed = Date.now() - startedAt;

  assert.ok(elapsed < 3000, `a multi-match selector must not burn the endpoint timeout, took ${elapsed}ms`);
  assert.equal(body.point.matchedElements, 11);
  assert.match(String(body.note), /11/);

  await sessions.releaseSession(sessionId);
});

test('a genuinely absent selector still says the element may appear late', async () => {
  const sessionId = await sessionOn('/multi');
  await assert.rejects(
    () => handlers.drag({ sessionId, source: { selector: '#nothing-here' }, target: { x: 400, y: 400 }, steps: 3, timeoutMs: 300 }),
    /appears late/,
    'the wait_for advice is right for an element that is genuinely not there yet, and only for that'
  );
  await sessions.releaseSession(sessionId);
});

// ---------------------------------------------------------------------------
// wheel: the same predicate, with a real scroll as the oracle
// ---------------------------------------------------------------------------

test('wheel does not report a clean hit when an ancestor pane takes the event', async () => {
  const sessionId = await sessionOn();

  // The offset falls outside #scrollInner and onto #scrollPane, which is overflow: hidden and
  // scrolls nothing. Round 2 read that as a clean hit and explained the dead scroll away.
  const body = payload(await handlers.wheel({ sessionId, point: { selector: '#scrollInner', x: 200, y: 30 }, deltaY: 120 }));

  assert.equal(body.pointHit.matchesTarget, false);
  assert.equal(body.pointHit.elementAtPoint.id, 'scrollPane');
  assert.equal(body.matched, false);
  assert.equal(await evaluate<number>(sessionId, "document.getElementById('scrollInner').scrollTop"), 0, 'nothing scrolled, and the verdict must agree');

  await sessions.releaseSession(sessionId);
});

test('wheel still reports a clean hit and a real scroll for an unoccluded container', async () => {
  const sessionId = await sessionOn();
  const body = payload(await handlers.wheel({ sessionId, point: { selector: '#scrollBox' }, deltaY: 120 }));

  assert.equal(body.pointHit.matchesTarget, true);
  assert.equal(body.matched, true);
  assert.equal(body.moved, true);
  assert.ok(await evaluate<number>(sessionId, "document.getElementById('scrollBox').scrollTop") > 0, 'the box really scrolled');

  await sessions.releaseSession(sessionId);
});
