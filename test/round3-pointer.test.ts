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
    const routes: Record<string, string> = {
      '/body-scrim': BODY_SCRIM_HTML,
      '/multi': MULTI_MATCH_HTML,
      '/offscreen': OFFSCREEN_HTML,
      '/deep': DEEP_HTML,
      '/frame-inner': FRAME_INNER_HTML,
      '/frame-outer': FRAME_OUTER_HTML,
      '/frame-covered': FRAME_COVERED_HTML,
      '/far-apart': FAR_APART_HTML,
      '/scrim-pair': SCRIM_PAIR_HTML,
      '/wheel-listener': WHEEL_LISTENER_HTML,
      '/rot-inner': ROT_INNER_HTML,
      '/rot-ancestor': ROT_ANCESTOR_HTML,
      '/rot-translate': ROT_TRANSLATE_HTML,
      '/zoom-frame': ZOOM_FRAME_HTML,
      ...Object.fromEntries(
        transformCases.filter(one => one.style !== undefined).map(one => [one.path, rotWrapper(one.style as string)])
      )
    };
    const body = routes[path] ?? FIXTURE_HTML;
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
  assert.equal(
    open.body.sourceHit.elementAtPoint.id,
    'openInner',
    'the shadow content really is what is topmost, and saying so on a match costs nothing and explains the verdict'
  );
  assert.equal(open.body.sourceHit.elementAtPoint.containsTarget, false, 'the shadow content is below the host, not above it');

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

// ---------------------------------------------------------------------------
// Round 3, second pass. Four defects an independent adversarial tester found in
// the fixes above, three of them introduced by them, each graded here against
// the same kind of oracle: a real capturing pointerdown listener on the element
// the caller named, which a real press either fires or does not.
// ---------------------------------------------------------------------------

/** 200 intervening levels between #deepRoot and the leaf that actually paints at the point. */
const DEEP_HTML = `<!doctype html>
<html><body style="margin:0">
<div id="deepRoot" style="position:absolute;left:10px;top:10px;width:200px;height:60px;background:rgb(220,220,220)"></div>
<script>
  window.__hbFired = {};
  var cur = document.getElementById('deepRoot');
  for (var i = 0; i < 200; i += 1) {
    var d = document.createElement('div');
    d.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%';
    cur.appendChild(d);
    cur = d;
  }
  cur.style.background = 'rgb(120,160,240)';
  document.getElementById('deepRoot').addEventListener('pointerdown', function () { window.__hbFired.deepRoot = true; }, true);
</script>
</body></html>`;

/** The page an iframe fixture loads INSIDE the frame. */
const FRAME_INNER_HTML = `<!doctype html>
<html><body style="margin:0;background:rgb(238,238,255)">
  <div id="frameTarget" style="position:absolute;left:10px;top:10px;width:300px;height:300px;background:rgb(140,200,255)"></div>
  <div id="frameCover" style="position:absolute;left:120px;top:120px;width:70px;height:70px;background:rgb(255,68,68);z-index:5"></div>
  <!-- Small and near the frame's own origin on purpose: its centre sits at inner (370,30), so the
       main-frame coordinate for it, (440,80), falls well OUTSIDE it. Handing that number to the
       frame's own elementFromPoint, which is what the tool used to do, therefore lands on the
       frame's <html> and produces a confident MISS for an element nothing is covering. A large
       target cannot show this direction: the mis-mapped point stays inside it by accident. -->
  <div id="frameSmall" style="position:absolute;left:330px;top:10px;width:80px;height:40px;background:rgb(140,220,160)"></div>
<script>
  window.__hbFired = {};
  ['frameTarget', 'frameCover', 'frameSmall'].forEach(function (id) {
    document.getElementById(id).addEventListener('pointerdown', function () { window.__hbFired[id] = true; }, true);
  });
</script>
</body></html>`;

/** The same frame, offset from the origin in both axes, and with a border and padding on top. */
const FRAME_OUTER_HTML = `<!doctype html>
<html><body style="margin:0">
  <iframe id="theFrame" src="/frame-inner" style="position:absolute;left:60px;top:40px;width:500px;height:500px;border:4px solid rgb(0,0,0);padding:6px"></iframe>
</body></html>`;

/** The same frame again, this time buried under a modal that lives in the PARENT document. */
const FRAME_COVERED_HTML = `<!doctype html>
<html><body style="margin:0">
  <iframe id="theFrame" src="/frame-inner" style="position:absolute;left:20px;top:30px;width:400px;height:400px;border:0"></iframe>
  <div id="parentModal" style="position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:99"></div>
</body></html>`;

/** A page tall enough that scrolling one endpoint into view moves the other one off screen. */
const FAR_APART_HTML = `<!doctype html>
<html><body style="margin:0;height:4000px">
  <div id="nearTop" style="position:absolute;left:20px;top:20px;width:140px;height:60px;background:rgb(120,200,140)"></div>
  <div id="farDown" style="position:absolute;left:20px;top:3000px;width:140px;height:60px;background:rgb(200,140,120)"></div>
<script>
  window.__hbFired = {};
  ['nearTop', 'farDown'].forEach(function (id) {
    document.getElementById(id).addEventListener('pointerdown', function () { window.__hbFired[id] = true; }, true);
  });
</script>
</body></html>`;

/** A button under its wrapper's ::after scrim, once in a shadow root and once in the light DOM. */
const SCRIM_PAIR_HTML = `<!doctype html>
<html><head><style>
  body { margin: 0 }
  #shadowScrimWrap::after { content: ''; position: absolute; inset: 0; background: rgba(0,0,0,0.2) }
  #lightScrimWrap::after { content: ''; position: absolute; inset: 0; background: rgba(0,0,0,0.2) }
</style></head><body>
  <div id="shadowScrimWrap" style="position:absolute;left:10px;top:10px;width:200px;height:60px;background:rgb(238,238,238)">
    <div id="scrimHost" style="position:absolute;left:20px;top:10px;width:120px;height:40px"></div>
  </div>
  <div id="lightScrimWrap" style="position:absolute;left:10px;top:100px;width:200px;height:60px;background:rgb(238,238,238)">
    <button id="lightScrimBtn" style="position:absolute;left:20px;top:10px;width:120px;height:40px"></button>
  </div>
<script>
  window.__hbFired = {};
  var root = document.getElementById('scrimHost').attachShadow({ mode: 'open' });
  root.innerHTML = '<button id="shadowScrimBtn" style="position:absolute;left:0;top:0;width:120px;height:40px"></button>';
  root.getElementById('shadowScrimBtn').addEventListener('pointerdown', function () { window.__hbFired.shadowScrimBtn = true; }, true);
  document.getElementById('lightScrimBtn').addEventListener('pointerdown', function () { window.__hbFired.lightScrimBtn = true; }, true);
</script>
</body></html>`;

/** A wheel target with a listener of its own, for proving the event was delivered before the readback. */
const WHEEL_LISTENER_HTML = `<!doctype html>
<html><body style="margin:0">
  <div id="wheelPad" style="position:absolute;left:20px;top:20px;width:300px;height:200px;background:rgb(200,220,240)"></div>
<script>
  window.__wheels = 0;
  document.getElementById('wheelPad').addEventListener('wheel', function () { window.__wheels += 1; }, { passive: true });
</script>
</body></html>`;

const FRAME_PREFIX = 'iframe >> internal:control=enter-frame >> ';

/** Reads the oracle inside a subframe rather than the main document. */
async function oracleFiredInFrame(sessionId: string, id: string): Promise<boolean> {
  const frames = payload(await handlers.list_frames({ sessionId })).frames;
  const frame = frames.find((entry: any) => entry.frameId !== 'main').frameId;
  const result = await handlers.evaluate({ sessionId, frame, expression: `!!window.__hbFired[${JSON.stringify(id)}]` });
  return payload(result).result as boolean;
}

async function resetOracleInFrame(sessionId: string): Promise<void> {
  const frames = payload(await handlers.list_frames({ sessionId })).frames;
  const frame = frames.find((entry: any) => entry.frameId !== 'main').frameId;
  await handlers.evaluate({ sessionId, frame, expression: 'window.__hbFired = {}, "ok"' });
}

// --- Defect: an iframe not at the origin desynchronises the hit test ---------

test('drag: an element in an offset iframe with nothing on it is a clean hit, not a fabricated ancestor miss', async () => {
  const sessionId = await sessionOn('/frame-outer');
  await resetOracleInFrame(sessionId);

  // The mouse goes to a MAIN-frame coordinate; the hit test used to hand that same number to
  // the FRAME's own elementFromPoint, which measures from the frame's own origin. With the
  // frame at (60,40) plus a 4px border and 6px padding, the two spaces differ by 70x50, and
  // the tool reported a confident miss naming the frame's <html> with the whole ancestor
  // remedy attached, for a press that really did reach the element.
  const body = payload(
    await handlers.drag({ sessionId, source: { selector: `${FRAME_PREFIX}#frameSmall` }, target: { x: 900, y: 20 }, steps: 3 })
  );
  const fired = await oracleFiredInFrame(sessionId, 'frameSmall');

  assert.equal(fired, true, 'the fixture is wrong if a real press at these coordinates did NOT reach the element');
  assert.equal(body.sourceHit.matchesTarget, true, 'the press provably reached the element, so the tool must not call it a miss');
  assert.equal(body.sourceHit.elementAtPoint, null, 'nothing is on top of it, so there is nothing to name');
  assert.equal(body.matched, true);
  assert.ok(!('note' in body), 'and a clean hit in a frame earns no note, least of all the ancestor remedy');

  await sessions.releaseSession(sessionId);
});

test('drag: an element in an offset iframe covered at its own centre is a miss, not a false pass', async () => {
  const sessionId = await sessionOn('/frame-outer');
  await resetOracleInFrame(sessionId);

  // The mirror of the case above, and the dangerous one. #frameTarget is 300x300, so the
  // mis-mapped point still landed inside it, on a part nothing covers, while the real press
  // went to #frameCover at the true centre. The tool reported a clean hit with no note at all.
  const body = payload(
    await handlers.drag({ sessionId, source: { selector: `${FRAME_PREFIX}#frameTarget` }, target: { x: 900, y: 20 }, steps: 3 })
  );
  const targetFired = await oracleFiredInFrame(sessionId, 'frameTarget');
  const coverFired = await oracleFiredInFrame(sessionId, 'frameCover');

  assert.equal(coverFired, true, 'the fixture is wrong if the cover did not take the press');
  assert.equal(targetFired, false, 'the fixture is wrong if the press reached the target through the cover');
  assert.equal(body.sourceHit.matchesTarget, false, 'the element never saw the press, so this must not read as a clean hit');
  assert.equal(body.sourceHit.elementAtPoint.id, 'frameCover', 'and what really took it has to be named');
  assert.equal(body.matched, false);

  await sessions.releaseSession(sessionId);
});

test('wheel: the same offset iframe, the same verdict', async () => {
  const sessionId = await sessionOn('/frame-outer');
  const body = payload(await handlers.wheel({ sessionId, point: { selector: `${FRAME_PREFIX}#frameTarget` }, deltaY: 60 }));

  assert.equal(body.pointHit.matchesTarget, false, 'wheel resolves its point the same way drag does and must reach the same answer');
  assert.equal(body.pointHit.elementAtPoint.id, 'frameCover');
  assert.equal(body.matched, false);

  await sessions.releaseSession(sessionId);
});

test('a modal in the parent document is caught by BOTH call sites, since a pointer event cannot cross a frame boundary', async () => {
  const sessionId = await sessionOn('/frame-covered');
  await resetOracleInFrame(sessionId);

  const body = payload(
    await handlers.drag({ sessionId, source: { selector: `${FRAME_PREFIX}#frameTarget` }, target: { x: 900, y: 20 }, steps: 3 })
  );
  const fired = await oracleFiredInFrame(sessionId, 'frameTarget');
  const el = payload(await handlers.element_box({ sessionId, selectors: [`${FRAME_PREFIX}#frameTarget`] })).results[0].elements[0];

  assert.equal(fired, false, 'the fixture is wrong if the press got through a full-screen parent-document modal');
  assert.equal(body.sourceHit.matchesTarget, false, 'drag has to see one document out');
  assert.equal(body.sourceHit.elementAtPoint.id, 'parentModal');
  assert.equal(body.sourceHit.elementAtPoint.inAncestorFrame, true, 'the remedy differs: nothing inside the frame can fix this');
  assert.match(String(body.note), /ANCESTOR FRAME/, 'and the note has to say so rather than blaming a z-index inside the frame');

  assert.equal(el.topmostAtCentre, false, 'element_box measures inside the frame, but the answer it gives is about a real click');
  assert.equal(el.occludedBy.id, 'parentModal');
  assert.equal(el.occludedBy.inAncestorFrame, true);

  await sessions.releaseSession(sessionId);
});

// --- Defect: the walk cap was a silent cliff --------------------------------

test('a target 200 levels above the node that paints at the point is not reported as occluded', async () => {
  const sessionId = await sessionOn('/deep');

  await resetOracle(sessionId);
  const body = payload(await handlers.drag({ sessionId, source: { selector: '#deepRoot' }, target: { x: 600, y: 20 }, steps: 3 }));
  const fired = await oracleFired(sessionId, 'deepRoot');
  const el = payload(await handlers.element_box({ sessionId, selectors: ['#deepRoot'] })).results[0].elements[0];

  assert.equal(fired, true, 'the press really does reach #deepRoot: it is on the composed path of the leaf');
  assert.equal(body.sourceHit.matchesTarget, true, 'a cap of 200 made this a confident miss naming the leaf, with the ancestor remedy attached');
  assert.equal(body.matched, true);
  assert.equal(el.topmostAtCentre, true, 'and element_box carried the identical cliff');
  assert.equal(el.occludedBy, null);

  await sessions.releaseSession(sessionId);
});

// --- Defect: containsTarget did not cross a shadow boundary -----------------

test('a scrim over an ancestor gets the same diagnosis whether or not a shadow root is in the way', async () => {
  const sessionId = await sessionOn('/scrim-pair');

  await resetOracle(sessionId);
  const shadow = payload(
    await handlers.drag({ sessionId, source: { selector: '#shadowScrimBtn' }, target: { x: 600, y: 400 }, steps: 3 })
  );
  const light = payload(
    await handlers.drag({ sessionId, source: { selector: '#lightScrimBtn' }, target: { x: 600, y: 400 }, steps: 3 })
  );
  assert.equal(await oracleFired(sessionId, 'shadowScrimBtn'), false, 'the scrim really does swallow the press in both shapes');
  assert.equal(await oracleFired(sessionId, 'lightScrimBtn'), false);

  // The verdict was already right in both. What flipped was the DIAGNOSIS, and only because
  // Node.contains() does not cross a shadow boundary: the shadow shape got the overlay remedy
  // and sent the caller hunting for a z-index that does not exist.
  assert.equal(shadow.sourceHit.matchesTarget, false);
  assert.equal(light.sourceHit.matchesTarget, false);
  assert.equal(shadow.sourceHit.elementAtPoint.containsTarget, true, 'the wrapper IS an ancestor of the shadow button in the flattened tree');
  assert.equal(light.sourceHit.elementAtPoint.containsTarget, true);
  assert.match(String(shadow.note), /ANCESTOR/);

  const boxes = payload(await handlers.element_box({ sessionId, selectors: ['#shadowScrimBtn', '#lightScrimBtn'] })).results;
  assert.equal(boxes[0].elements[0].occludedBy.containsTarget, true, 'element_box shared the same contains() bug and needs the same mirror walk');
  assert.equal(boxes[1].elements[0].occludedBy.containsTarget, true);

  await sessions.releaseSession(sessionId);
});

// --- Defect: drag's own target scroll invalidated its source point ----------

test('drag does not press at coordinates its own target scroll invalidated', async () => {
  const sessionId = await sessionOn('/far-apart');
  await resetOracle(sessionId);

  // Resolving #farDown scrolls the page ~3000px, which moves #nearTop off screen. drag used to
  // measure the source BEFORE that scroll and then press at the stale coordinate, landing on
  // <html> and reporting an ancestor miss that blamed a scrim. Both endpoints are prepared
  // before either is measured now, so the numbers are consistent, and the case that remains
  // genuinely impossible (two points that cannot be on screen together) is named as itself.
  const body = payload(
    await handlers.drag({ sessionId, source: { selector: '#nearTop' }, target: { selector: '#farDown' }, steps: 3 })
  );

  assert.ok(
    !/scrim|z-index/i.test(String(body.note ?? '')) || /cannot be on screen at the same time/.test(String(body.note)),
    `the note must name the real cause rather than blaming an overlay: ${JSON.stringify(body.note ?? null)}`
  );
  assert.match(
    String(body.note),
    /outside the viewport|cannot be on screen at the same time/,
    'the actual cause is that the two endpoints do not fit on screen together, and that has to be said'
  );

  await sessions.releaseSession(sessionId);
});

// --- Defect: elementAtPoint was hidden on a match --------------------------

test('a body-anchored point is never less informative than the same coordinates passed raw', async () => {
  const sessionId = await sessionOn();

  // "body" is on the composed path of every point, correctly, so this IS a match. Blanking
  // elementAtPoint on a match meant the selector form reported strictly less about the same
  // point than the raw form did, for no reason.
  const anchored = payload(
    await handlers.drag({ sessionId, source: { selector: 'body', x: 240, y: 585 }, target: { x: 700, y: 20 }, steps: 3 })
  );
  const raw = payload(await handlers.drag({ sessionId, source: { x: 240, y: 585 }, target: { x: 700, y: 20 }, steps: 3 }));

  assert.equal(anchored.sourceHit.matchesTarget, true, 'a press anywhere really does run body\'s listeners');
  assert.ok(anchored.sourceHit.elementAtPoint, 'and what is really topmost there must still be reported');
  assert.equal(
    anchored.sourceHit.elementAtPoint.id,
    raw.sourceHit.elementAtPoint.id,
    'the two forms name the same point, so they must name the same element'
  );

  await sessions.releaseSession(sessionId);
});

// --- Defect: wheel returned before the renderer had run the listener --------

test('wheel has delivered its event to the page by the time it returns, even when nothing scrolls', async () => {
  const sessionId = await sessionOn('/wheel-listener');

  // Nothing on this page is scrollable, which is exactly the shape that used to leave the
  // readback unguarded: readSettledScrollState's first two reads agree immediately, so it
  // returns without ever sleeping, and the only thing standing between the CDP dispatch and
  // the read was luck. Measured unfired in 2 of 20 trials at idle before the fix.
  for (let trial = 0; trial < 12; trial += 1) {
    await evaluate(sessionId, 'window.__wheels = 0, "ok"');
    await handlers.wheel({ sessionId, point: { selector: '#wheelPad' }, deltaY: 40 });
    assert.equal(
      await evaluate<number>(sessionId, 'window.__wheels'),
      1,
      `the page must have seen the wheel event by the time the call returned (trial ${trial})`
    );
  }

  await sessions.releaseSession(sessionId);
});

// ---------------------------------------------------------------------------
// Round 4. A transformed iframe, which the frame chain above got wrong by
// dividing bounding boxes: getBoundingClientRect returns the AXIS-ALIGNED bbox
// of the TRANSFORMED border box, so under rotation rect.width / offsetWidth is
// not the scale and the bbox corner is not the content corner. The error is
// near zero at the frame's centre and largest at its edges, which is how it
// survived the first round of frame testing, and skewX passed by luck for the
// same reason rather than because skew was handled.
//
// Every case below puts a SMALL target hard against the frame's corner, where
// the error is biggest, and grades against a real capturing pointerdown
// listener inside the frame.
// ---------------------------------------------------------------------------

/** A small target at the frame's own origin, with a big decoy across the middle where a mis-mapped point lands. */
const ROT_INNER_HTML = `<!doctype html>
<html><head><style>html,body{margin:0;background:rgb(238,238,255)}</style></head><body>
  <div id="rotDecoy" style="position:absolute;left:0;top:0;width:400px;height:300px;background:rgb(255,221,221)"></div>
  <div id="rotBtn" style="position:absolute;left:6px;top:6px;width:34px;height:26px;background:rgb(140,200,255);z-index:3"></div>
<script>
  window.__hbFired = {};
  ['rotBtn', 'rotDecoy'].forEach(function (id) {
    document.getElementById(id).addEventListener('pointerdown', function () { window.__hbFired[id] = true; }, true);
  });
</script>
</body></html>`;

const rotWrapper = (style: string) =>
  `<!doctype html><html><head><style>body{margin:0}</style></head><body>` +
  `<iframe src="/rot-inner" style="position:absolute;left:250px;top:180px;width:400px;height:300px;${style}"></iframe>` +
  `</body></html>`;

/** An iframe inside an ancestor that is itself rotated, which cannot be mapped and must say so. */
const ROT_ANCESTOR_HTML = `<!doctype html>
<html><head><style>body{margin:0}</style></head><body>
  <div style="transform:rotate(15deg);transform-origin:0 0">
    <iframe src="/rot-inner" style="position:absolute;left:250px;top:180px;width:400px;height:300px;border:0"></iframe>
  </div>
</body></html>`;

/** The same iframe under a pure-translation ancestor, the compositing hint that must keep working. */
const ROT_TRANSLATE_HTML = `<!doctype html>
<html><head><style>body{margin:0}</style></head><body>
  <div style="transform:translate3d(30px,20px,0)">
    <iframe src="/rot-inner" style="position:absolute;left:250px;top:180px;width:400px;height:300px;border:0"></iframe>
  </div>
</body></html>`;

/** CSS zoom on the iframe: broken below this tool, so the only honest answer is that there is none. */
const ZOOM_FRAME_HTML = `<!doctype html>
<html><head><style>body{margin:0}</style></head><body>
  <iframe src="/rot-inner" style="position:absolute;left:250px;top:180px;width:400px;height:300px;border:0;zoom:1.4"></iframe>
</body></html>`;

const transformCases: { name: string; path: string; style?: string }[] = [
  { name: 'no transform, as a control', path: '/rot-flat', style: 'border:0' },
  { name: 'rotated 20 degrees about its centre', path: '/rot-20', style: 'border:0;transform:rotate(20deg);transform-origin:50% 50%' },
  { name: 'rotated 45 degrees about its centre', path: '/rot-45', style: 'border:0;transform:rotate(45deg);transform-origin:50% 50%' },
  { name: 'rotated 45 degrees with a border and padding', path: '/rot-45bp', style: 'border:5px solid rgb(0,0,0);padding:7px;transform:rotate(45deg);transform-origin:50% 50%' },
  // A GUARD, not a reproduction: this one passed against the broken bbox-ratio code too, even
  // though that code was just as wrong about skew (bbox width 509 against offsetWidth 400). It
  // is kept because it must not break, not as evidence that skew is handled. The rotation cases
  // above are the ones that actually failed before the fix.
  { name: 'skewed by skewX(20deg)', path: '/rot-skew', style: 'border:0;transform:skewX(20deg)' },
  { name: 'rotated and scaled about its top-left corner', path: '/rot-scale', style: 'border:0;transform:rotate(-30deg) scale(1.2);transform-origin:0 0' },
  { name: 'under a pure-translation ancestor', path: '/rot-translate' }
];

for (const shape of transformCases) {
  test(`drag and element_box agree with a real press for an iframe ${shape.name}`, async () => {
    const sessionId = await sessionOn(shape.path);
    await resetOracleInFrame(sessionId);

    const body = payload(
      await handlers.drag({ sessionId, source: { selector: `${FRAME_PREFIX}#rotBtn` }, target: { selector: `${FRAME_PREFIX}#rotBtn` }, steps: 1 })
    );
    const btnFired = await oracleFiredInFrame(sessionId, 'rotBtn');
    const decoyFired = await oracleFiredInFrame(sessionId, 'rotDecoy');

    assert.equal(btnFired, true, `the fixture is wrong if a real press at ${JSON.stringify(body.source)} did not reach #rotBtn`);
    assert.equal(decoyFired, false, 'and the decoy across the middle must not be what took it');
    assert.equal(body.sourceHit.matchesTarget, true, 'the press provably reached the element, so this must not read as a miss');
    assert.equal(body.matched, true);

    const el = payload(await handlers.element_box({ sessionId, selectors: [`${FRAME_PREFIX}#rotBtn`] })).results[0].elements[0];
    assert.equal(el.topmostAtCentre, true, 'element_box maps the same geometry and must reach the same answer');
    assert.equal(el.occludedBy, null, 'blaming the parent document for swallowing a click that landed is a fabricated diagnosis');

    await sessions.releaseSession(sessionId);
  });
}

test('an iframe inside a rotated ancestor is reported as unmappable, not as occluded', async () => {
  const sessionId = await sessionOn('/rot-ancestor');

  // P0 is recovered by subtracting the element's own transform from its viewport bbox, which
  // only works when nothing above it rotates, scales or skews. That is checked rather than
  // hoped for, and the honest answer when it fails is that there is no answer.
  const body = payload(
    await handlers.drag({ sessionId, source: { selector: `${FRAME_PREFIX}#rotBtn` }, target: { x: 900, y: 20 }, steps: 2 })
  );
  assert.equal(body.sourceHit.matchesTarget, null, 'unmappable is not the same as missed');
  assert.equal(body.matched, null, 'and it must not fold into a clean pass either');
  assert.equal(body.sourceHit.elementAtPoint, null, 'naming an occluder here would be an invention');
  assert.match(String(body.note), /scaled, rotated or skewed/, 'the note has to name the actual reason');

  const el = payload(await handlers.element_box({ sessionId, selectors: [`${FRAME_PREFIX}#rotBtn`] })).results[0].elements[0];
  assert.equal(el.topmostAtCentre, null);
  assert.equal(el.occludedBy, null);
  assert.match(String(el.topmostUnknownReason), /scaled, rotated or skewed/);

  await sessions.releaseSession(sessionId);
});

test('CSS zoom on an iframe is admitted rather than answered, in both tools', async () => {
  const sessionId = await sessionOn('/zoom-frame');

  // Coordinate mapping across a frame boundary under CSS zoom is broken BELOW this tool.
  // Playwright's own click times out on this element and a press at its own boundingBox
  // coordinate does not fire the listener, so the mouse cannot reach it from here at all.
  // That is verified in probe/r4-zoom-rot.ts rather than here, because reproducing it costs a
  // full 30s Playwright timeout per run and this suite shares one laptop.
  //
  // Which of the two honest answers comes back depends on the geometry, and both are asserted
  // together on purpose: when the mis-mapped resolved point still lands on the iframe, the
  // verdict is null (on the frame, unmappable inside it); when it lands off the iframe
  // entirely, the verdict is false (it provably did not reach the frame). The invariant that
  // matters, and the one that was broken, is that NEITHER tool may report a clean hit for an
  // element nothing can click, and that whichever answer comes back names zoom as the cause
  // instead of sending the caller after an overlay that is not there.
  const body = payload(
    await handlers.drag({ sessionId, source: { selector: `${FRAME_PREFIX}#rotBtn` }, target: { x: 900, y: 20 }, steps: 2 })
  );
  assert.notEqual(body.sourceHit.matchesTarget, true, 'a clean hit on an element nothing can click is the false pass');
  assert.notEqual(body.matched, true);
  assert.match(String(body.note), /CSS zoom/, 'the note must name zoom rather than send the caller after an overlay');

  const el = payload(await handlers.element_box({ sessionId, selectors: [`${FRAME_PREFIX}#rotBtn`] })).results[0].elements[0];
  assert.notEqual(el.topmostAtCentre, true, 'reporting true for an element nothing can click was the defect');
  assert.match(
    String(el.topmostUnknownReason ?? el.occludedBy?.tagName ?? ''),
    /CSS zoom|iframe/,
    'and element_box has to explain itself too'
  );

  await sessions.releaseSession(sessionId);
});
