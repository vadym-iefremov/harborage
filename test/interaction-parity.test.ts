import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { BrowserManager } from '../src/daemon/browserManager.js';
import { createToolHandlers } from '../src/daemon/tools/handlers.js';
import { SessionStore } from '../src/daemon/sessions.js';
import { getFreePort } from './helpers.js';

/**
 * Four fixture pages, each one built around something a synthetic DOM stub
 * cannot fake.
 *
 * The canvas page is the important one: it reproduces how a real drag sensor
 * (dnd-kit's PointerSensor, d3-drag, and React Flow on top of it) actually
 * behaves, rather than moving an element on the first event it sees. A drag
 * there is not one gesture, it is a sequence, and a tool that fires a single
 * move leaves the node exactly where it was while every event handler reports
 * success. That is the false pass these tests exist to catch.
 */
const CANVAS_HTML = `<!doctype html>
<html>
<body style="margin:0">
  <div id="canvas" style="position:relative;width:600px;height:400px;background:rgb(240,240,240)">
    <div id="node" style="position:absolute;left:40px;top:40px;width:80px;height:40px;background:rgb(51,153,255)"></div>
    <div id="slowNode" style="position:absolute;left:40px;top:300px;width:80px;height:40px;background:rgb(255,153,51)"></div>
    <div id="slot" style="position:absolute;left:400px;top:250px;width:100px;height:60px;background:rgb(204,204,204)"></div>
  </div>
<script>
  window.__pointerMoves = 0;
  window.__drops = [];
  window.__sawShift = false;
  window.__lastKeyShift = null;
  window.addEventListener('keydown', function (e) { window.__lastKeyShift = e.shiftKey; });

  var node = document.getElementById('node');
  var dragging = false, activated = false, startX = 0, startY = 0, originLeft = 0, originTop = 0;

  node.addEventListener('pointerdown', function (e) {
    dragging = true;
    activated = false;
    startX = e.clientX;
    startY = e.clientY;
    originLeft = node.offsetLeft;
    originTop = node.offsetTop;
    window.__pointerMoves = 0;
  });
  window.addEventListener('pointermove', function (e) {
    if (!dragging) return;
    window.__pointerMoves++;
    if (e.shiftKey) window.__sawShift = true;
    // A real pointer sensor spends the first qualifying move on STARTING the
    // drag and only begins following from the next one. One move therefore
    // moves nothing, which is precisely why "steps" exists.
    if (!activated) { activated = true; return; }
    node.style.left = (originLeft + e.clientX - startX) + 'px';
    node.style.top = (originTop + e.clientY - startY) + 'px';
  });
  window.addEventListener('pointerup', function () {
    if (!dragging) return;
    dragging = false;
    window.__drops.push({ left: node.offsetLeft, top: node.offsetTop, moves: window.__pointerMoves, shift: window.__sawShift });
  });

  // A long-press sensor: it arms on pointerdown but cancels outright if the
  // pointer moves before the press has been held long enough. Nothing but a
  // real pause between press and move gets this element to travel.
  var slow = document.getElementById('slowNode');
  var slowDragging = false, slowActive = false, slowAt = 0, sx = 0, sy = 0, sl = 0, st = 0;
  slow.addEventListener('pointerdown', function (e) {
    slowDragging = true;
    slowActive = false;
    slowAt = Date.now();
    sx = e.clientX; sy = e.clientY;
    sl = slow.offsetLeft; st = slow.offsetTop;
  });
  window.addEventListener('pointermove', function (e) {
    if (!slowDragging) return;
    if (!slowActive) {
      if (Date.now() - slowAt < 80) { slowDragging = false; return; }
      slowActive = true;
      return;
    }
    slow.style.left = (sl + e.clientX - sx) + 'px';
    slow.style.top = (st + e.clientY - sy) + 'px';
  });
  window.addEventListener('pointerup', function () { slowDragging = false; });
</script>
</body>
</html>`;

/** Native HTML5 drag and drop: a different event family entirely from the canvas page's pointer events. */
const HTML5_HTML = `<!doctype html>
<html>
<body style="margin:0">
  <div id="src" draggable="true" style="width:120px;height:60px;background:rgb(0,128,0)">DRAG ME</div>
  <div id="zone" style="width:240px;height:120px;background:rgb(210,210,210)">DROP HERE</div>
<script>
  window.__h5 = [];
  var src = document.getElementById('src');
  var zone = document.getElementById('zone');
  src.addEventListener('dragstart', function (e) {
    e.dataTransfer.setData('text/plain', 'payload-42');
    window.__h5.push('dragstart');
  });
  zone.addEventListener('dragover', function (e) { e.preventDefault(); window.__h5.push('dragover'); });
  zone.addEventListener('drop', function (e) {
    e.preventDefault();
    window.__h5dropped = e.dataTransfer.getData('text/plain');
    zone.appendChild(src);
    window.__h5.push('drop');
  });
</script>
</body>
</html>`;

const SELECT_HTML = `<!doctype html>
<html>
<body>
  <select id="single">
    <option value="a">Alpha</option>
    <option value="b">Beta</option>
    <option value="c">Gamma</option>
  </select>
  <select id="multi" multiple size="3">
    <option value="x">Ex</option>
    <option value="y">Why</option>
    <option value="z">Zed</option>
  </select>
  <!-- Snaps the selection back to its first option, so a readback that merely
       echoed the request would look identical to one that is real. -->
  <select id="sticky">
    <option value="p">Pee</option>
    <option value="q">Queue</option>
  </select>
<script>
  window.__changes = [];
  var sticky = document.getElementById('sticky');
  sticky.addEventListener('change', function () { sticky.value = 'p'; });
  ['single', 'multi', 'sticky'].forEach(function (id) {
    document.getElementById(id).addEventListener('change', function () { window.__changes.push(id); });
  });
</script>
</body>
</html>`;

const UPLOAD_HTML = `<!doctype html>
<html>
<body>
  <input id="visibleFile" type="file">
  <!-- The overwhelmingly common real shape: the input is hidden and a styled
       button in front of it is what a user actually clicks. -->
  <input id="hiddenFile" type="file" style="display:none">
  <input id="multiFile" type="file" multiple>
  <label id="labelledFile">Pick one<input id="insideLabel" type="file"></label>
  <input id="notAFile" type="text">
<script>
  window.__fileChanges = [];
  Array.prototype.forEach.call(document.querySelectorAll('input[type=file]'), function (input) {
    input.addEventListener('change', function () {
      window.__fileChanges.push({
        id: input.id,
        names: Array.prototype.map.call(input.files, function (f) { return f.name; })
      });
    });
  });
</script>
</body>
</html>`;

/**
 * The two wheel shapes that behave nothing alike. A plain overflow container,
 * where a wheel is a scroll and `scrollTop` is the proof, and a canvas-shaped
 * element that branches on `ctrlKey` the way a real zoomable canvas does:
 * plain wheel is ignored, ctrl+wheel scales. Browsers deliver a trackpad
 * pinch as exactly that ctrl+wheel, so this is the pinch path, not a stand-in
 * for it. Nothing about the second one is observable as a scroll, which is
 * the case the tool has to be honest about.
 */
const WHEEL_HTML = `<!doctype html>
<html>
<body style="margin:0">
  <div id="box" style="position:absolute;left:20px;top:20px;width:200px;height:150px;overflow:auto">
    <div style="width:1000px;height:2000px;background:linear-gradient(rgb(255,255,255),rgb(0,0,0))"></div>
  </div>
  <div id="zoomer" style="position:absolute;left:300px;top:20px;width:300px;height:300px;overflow:hidden">
    <div id="zoomContent" style="width:100%;height:100%;background:rgb(0,100,200);transform:scale(1)"></div>
  </div>
<script>
  window.__wheels = [];
  window.__anyWheels = [];
  window.__scale = 1;
  window.__lastKeyCtrl = null;

  window.addEventListener('keydown', function (e) { window.__lastKeyCtrl = e.ctrlKey; });
  window.addEventListener('wheel', function (e) {
    window.__anyWheels.push({ x: e.clientX, y: e.clientY });
  }, { passive: true });

  var zoomer = document.getElementById('zoomer');
  zoomer.addEventListener('wheel', function (e) {
    window.__wheels.push({ ctrl: e.ctrlKey, shift: e.shiftKey, dx: e.deltaX, dy: e.deltaY, x: e.clientX, y: e.clientY });
    // The branch a zoomable canvas actually takes: a plain wheel is somebody
    // else's business, only ctrl+wheel is a zoom.
    if (!e.ctrlKey) return;
    e.preventDefault();
    window.__scale = Math.max(0.1, window.__scale - e.deltaY / 500);
    document.getElementById('zoomContent').style.transform = 'scale(' + window.__scale + ')';
  }, { passive: false });
</script>
</body>
</html>`;

const HISTORY_HTML = `<!doctype html>
<html>
<body>
  <h1>history fixture</h1>
<script>
  window.__popstates = 0;
  window.addEventListener('popstate', function () { window.__popstates++; });
</script>
</body>
</html>`;

const PAGES: Record<string, string> = {
  '/canvas': CANVAS_HTML,
  '/html5': HTML5_HTML,
  '/select': SELECT_HTML,
  '/upload': UPLOAD_HTML,
  '/wheel': WHEEL_HTML,
  '/history': HISTORY_HTML
};

let server: Server;
let baseUrl: string;
let browserManager: BrowserManager;
let sessions: SessionStore;
let handlers: ReturnType<typeof createToolHandlers>;
let fileDir: string;
let fileOne: string;
let fileTwo: string;

before(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]!.split('#')[0]!;
    const body = PAGES[path] ?? HISTORY_HTML;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    // Keeps every back/forward step a real navigation rather than a
    // back/forward-cache restore, so these assertions describe one thing.
    res.setHeader('cache-control', 'no-store');
    res.end(body);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;

  fileDir = mkdtempSync(join(tmpdir(), 'harborage-upload-'));
  fileOne = join(fileDir, 'alpha.txt');
  fileTwo = join(fileDir, 'beta.txt');
  writeFileSync(fileOne, 'alpha contents');
  writeFileSync(fileTwo, 'beta contents');

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
  rmSync(fileDir, { recursive: true, force: true });
  await new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve())));
});

/** A fresh session already sitting on one of the fixture pages. */
async function sessionOn(path: string): Promise<string> {
  const { sessionId } = await sessions.createSession();
  await handlers.navigate({ sessionId, url: `${baseUrl}${path}` });
  return sessionId;
}

function payload(result: unknown): Record<string, unknown> {
  return (result as { structuredContent: Record<string, unknown> }).structuredContent;
}

async function evaluate<T>(sessionId: string, expression: string): Promise<T> {
  const result = await handlers.evaluate({ sessionId, expression });
  return payload(result).result as T;
}

// ---------------------------------------------------------------------------
// drag: the canvas case
// ---------------------------------------------------------------------------

test('drag moves a pointer-driven canvas node to a raw viewport point', async () => {
  const sessionId = await sessionOn('/canvas');

  // The node sits at (40, 40) and is 80x40, so its centre is (80, 60).
  const body = payload(
    await handlers.drag({ sessionId, source: { selector: '#node' }, target: { x: 300, y: 200 } })
  );

  const left = await evaluate<number>(sessionId, "document.getElementById('node').offsetLeft");
  const top = await evaluate<number>(sessionId, "document.getElementById('node').offsetTop");
  assert.equal(left, 260, 'the node must actually be somewhere else afterwards, not merely have seen events');
  assert.equal(top, 180);

  const drops = await evaluate<{ left: number; top: number; moves: number }[]>(sessionId, 'window.__drops');
  assert.equal(drops.length, 1, 'the gesture must end with a real pointerup, or nothing is ever committed');
  assert.ok(drops[0]!.moves > 1, 'a canvas drag needs more than one intermediate move');

  assert.deepEqual(
    body.source,
    { selector: '#node', x: 80, y: 60, matchedElements: 1 },
    'drag should report where it really pressed, and how many elements the selector matched: a unique selector says 1 rather than saying nothing'
  );
  assert.deepEqual(body.target, { x: 300, y: 200 }, 'drag should report where it really released');
  assert.equal(body.nativeDrag, false, 'a pointer-driven canvas must not be run as a native HTML5 drag');

  await sessions.releaseSession(sessionId);
});

test('drag with steps 1 leaves the node where it was, which is why the default is higher', async () => {
  const sessionId = await sessionOn('/canvas');

  await handlers.drag({ sessionId, source: { selector: '#node' }, target: { x: 300, y: 200 }, steps: 1 });

  const left = await evaluate<number>(sessionId, "document.getElementById('node').offsetLeft");
  assert.equal(left, 40, 'one move is consumed starting the drag, so the node never travels: the documented failure');

  const moves = await evaluate<number>(sessionId, 'window.__pointerMoves');
  assert.equal(moves, 1, 'steps must control the number of intermediate moves exactly');

  await sessions.releaseSession(sessionId);
});

test('drag takes a selector plus an offset for the source and a selector for the target', async () => {
  const sessionId = await sessionOn('/canvas');

  // Press 5px in from the node's top-left, i.e. (45, 45), and release at the
  // slot's centre, (450, 280): a delta of (405, 235).
  const body = payload(
    await handlers.drag({
      sessionId,
      source: { selector: '#node', x: 5, y: 5 },
      target: { selector: '#slot' }
    })
  );

  assert.deepEqual(body.source, { selector: '#node', x: 45, y: 45, matchedElements: 1 });
  assert.deepEqual(body.target, { selector: '#slot', x: 450, y: 280, matchedElements: 1 });

  assert.equal(await evaluate(sessionId, "document.getElementById('node').offsetLeft"), 445);
  assert.equal(await evaluate(sessionId, "document.getElementById('node').offsetTop"), 275);

  await sessions.releaseSession(sessionId);
});

test('drag holds the press before moving when asked, which a long-press sensor requires', async () => {
  const sessionId = await sessionOn('/canvas');

  await handlers.drag({ sessionId, source: { selector: '#slowNode' }, target: { x: 400, y: 340 } });
  assert.equal(
    await evaluate(sessionId, "document.getElementById('slowNode').offsetLeft"),
    40,
    'moving immediately must cancel a long-press drag, exactly as it does in a real app'
  );

  await handlers.drag({ sessionId, source: { selector: '#slowNode' }, target: { x: 400, y: 340 }, holdMs: 150 });
  assert.equal(
    await evaluate(sessionId, "document.getElementById('slowNode').offsetLeft"),
    360,
    'holdMs is what makes a long-press drag possible at all'
  );

  await sessions.releaseSession(sessionId);
});

test('drag holds modifier keys down for the whole gesture, which is how a canvas box-selects', async () => {
  const sessionId = await sessionOn('/canvas');

  await handlers.drag({
    sessionId,
    source: { selector: '#node' },
    target: { x: 300, y: 200 },
    modifiers: ['Shift']
  });

  const drops = await evaluate<{ shift: boolean }[]>(sessionId, 'window.__drops');
  assert.equal(drops[0]!.shift, true, 'the modifier must be down during the moves, not only at the press');

  // Held for the gesture and released after it: a modifier left stuck down
  // would silently change every later interaction in the session.
  await handlers.press_key({ sessionId, key: 'a' });
  assert.equal(
    await evaluate(sessionId, 'window.__lastKeyShift'),
    false,
    'the modifier must be released afterwards, or every later key and click carries it'
  );

  await sessions.releaseSession(sessionId);
});

test('a second drag behaves exactly like the first, despite the selection the first one left behind', async () => {
  const sessionId = await sessionOn('/canvas');

  await handlers.drag({ sessionId, source: { selector: '#node' }, target: { x: 300, y: 200 } });
  assert.equal(await evaluate(sessionId, "document.getElementById('node').offsetLeft"), 260);

  // Pressing inside the text selection the first drag left behind makes
  // Chromium drag the SELECTION: pointermove stops firing, and the canvas
  // library sees a press and a release with nothing in between.
  const body = payload(
    await handlers.drag({ sessionId, source: { selector: '#node' }, target: { x: 500, y: 300 } })
  );

  assert.equal(body.nativeDrag, false, 'the gesture must not degrade into a native selection drag');
  assert.equal(await evaluate(sessionId, "document.getElementById('node').offsetLeft"), 460);
  assert.equal(await evaluate(sessionId, "document.getElementById('node').offsetTop"), 280);

  await sessions.releaseSession(sessionId);
});

test('drag rejects a source and a target it cannot resolve, rather than dragging somewhere arbitrary', async () => {
  const sessionId = await sessionOn('/canvas');

  await assert.rejects(() => handlers.drag({ sessionId, source: {}, target: { x: 1, y: 1 } }), /source/i);
  await assert.rejects(
    () => handlers.drag({ sessionId, source: { selector: '#node' }, target: {} }),
    /target/i
  );
  await assert.rejects(
    () => handlers.drag({ sessionId, source: { x: 10 }, target: { x: 1, y: 1 } }),
    /both/i
  );
  await assert.rejects(
    () => handlers.drag({ sessionId, source: { selector: '#nothingHere' }, target: { x: 1, y: 1 } }),
    /#nothingHere/
  );

  await sessions.releaseSession(sessionId);
});

// ---------------------------------------------------------------------------
// drag: the native HTML5 case
// ---------------------------------------------------------------------------

test('drag completes a native HTML5 drag and drop, moving the element into the drop zone', async () => {
  const sessionId = await sessionOn('/html5');

  const body = payload(await handlers.drag({ sessionId, source: { selector: '#src' }, target: { selector: '#zone' } }));

  const parent = await evaluate<string>(sessionId, "document.getElementById('src').parentElement.id");
  assert.equal(parent, 'zone', 'the drop handler must actually run, not merely the dragstart');
  assert.equal(
    await evaluate(sessionId, 'window.__h5dropped'),
    'payload-42',
    'the dataTransfer payload must survive the whole gesture'
  );

  const events = await evaluate<string[]>(sessionId, 'window.__h5');
  assert.ok(events.includes('dragstart'), 'expected a dragstart');
  assert.equal(body.nativeDrag, true, 'drag must say which of the two mechanisms actually ran');
  assert.ok(events.includes('dragover'), 'expected at least one dragover over the zone');
  assert.ok(events.includes('drop'), 'expected a drop');

  await sessions.releaseSession(sessionId);
});

// ---------------------------------------------------------------------------
// select_option
// ---------------------------------------------------------------------------

test('select_option selects by value, by label and by index, and reads the selection back', async () => {
  const sessionId = await sessionOn('/select');

  const byValue = payload(await handlers.select_option({ sessionId, selector: '#single', values: ['b'] }));
  assert.equal(await evaluate(sessionId, "document.getElementById('single').value"), 'b');
  assert.deepEqual(byValue.selected, [{ value: 'b', label: 'Beta', index: 1 }]);
  assert.equal(byValue.matched, true);
  assert.equal(byValue.multiple, false);

  const byLabel = payload(await handlers.select_option({ sessionId, selector: '#single', labels: ['Gamma'] }));
  assert.equal(await evaluate(sessionId, "document.getElementById('single').value"), 'c');
  assert.deepEqual(byLabel.selected, [{ value: 'c', label: 'Gamma', index: 2 }]);

  const byIndex = payload(await handlers.select_option({ sessionId, selector: '#single', indexes: [0] }));
  assert.equal(await evaluate(sessionId, "document.getElementById('single').value"), 'a');
  assert.deepEqual(byIndex.selected, [{ value: 'a', label: 'Alpha', index: 0 }]);

  const changes = await evaluate<string[]>(sessionId, 'window.__changes');
  assert.equal(changes.length, 3, 'each selection must fire a real change event');

  await sessions.releaseSession(sessionId);
});

test('select_option selects several options in a multi-select and can clear them', async () => {
  const sessionId = await sessionOn('/select');

  const body = payload(await handlers.select_option({ sessionId, selector: '#multi', values: ['x', 'z'] }));
  assert.equal(body.multiple, true);
  assert.deepEqual(
    (body.selected as { value: string }[]).map(o => o.value),
    ['x', 'z']
  );
  assert.equal(body.matched, true);

  const cleared = payload(await handlers.select_option({ sessionId, selector: '#multi', values: [] }));
  assert.deepEqual(cleared.selected, [], 'an empty list must deselect everything');
  assert.equal(cleared.matched, true);
  assert.equal(
    await evaluate(sessionId, "document.getElementById('multi').selectedOptions.length"),
    0
  );

  await sessions.releaseSession(sessionId);
});

test('select_option reports what the page actually settled on when it overrides the choice', async () => {
  const sessionId = await sessionOn('/select');

  const body = payload(await handlers.select_option({ sessionId, selector: '#sticky', values: ['q'] }));

  assert.deepEqual(
    (body.selected as { value: string }[]).map(o => o.value),
    ['p'],
    'the readback must be the real selection, not an echo of the request'
  );
  assert.equal(body.matched, false);
  assert.equal(typeof body.note, 'string', 'a mismatch must be stated, not returned as a bare success');

  await sessions.releaseSession(sessionId);
});

test('select_option insists on exactly one of values, labels or indexes', async () => {
  const sessionId = await sessionOn('/select');

  await assert.rejects(() => handlers.select_option({ sessionId, selector: '#single' }), /exactly one/i);
  await assert.rejects(
    () => handlers.select_option({ sessionId, selector: '#single', values: ['a'], indexes: [1] }),
    /exactly one/i
  );

  await sessions.releaseSession(sessionId);
});

test('fill points at select_option instead of throwing a raw Playwright error on a select', async () => {
  const sessionId = await sessionOn('/select');

  await assert.rejects(
    () => handlers.fill({ sessionId, selector: '#single', value: 'b' }),
    /select_option/,
    'fill has never worked on a <select>, so it must name the tool that does'
  );

  await sessions.releaseSession(sessionId);
});

// ---------------------------------------------------------------------------
// file_upload
// ---------------------------------------------------------------------------

test('file_upload attaches a file to a visible input and reads the attachment back', async () => {
  const sessionId = await sessionOn('/upload');

  const body = payload(await handlers.file_upload({ sessionId, selector: '#visibleFile', paths: [fileOne] }));

  assert.deepEqual(
    (body.files as { name: string }[]).map(f => f.name),
    ['alpha.txt'],
    'the readback must come from the input\'s own FileList'
  );
  assert.equal(body.matched, true);
  assert.equal((body.files as { size: number }[])[0]!.size, 'alpha contents'.length);

  const changes = await evaluate<{ id: string; names: string[] }[]>(sessionId, 'window.__fileChanges');
  assert.deepEqual(changes, [{ id: 'visibleFile', names: ['alpha.txt'] }], 'the page must see a real change event');

  await sessions.releaseSession(sessionId);
});

test('file_upload works on a display:none input, which is how nearly every styled uploader is built', async () => {
  const sessionId = await sessionOn('/upload');

  const body = payload(await handlers.file_upload({ sessionId, selector: '#hiddenFile', paths: [fileOne] }));

  assert.deepEqual((body.files as { name: string }[]).map(f => f.name), ['alpha.txt']);
  assert.equal(body.matched, true);
  assert.equal(await evaluate(sessionId, "document.getElementById('hiddenFile').files[0].name"), 'alpha.txt');

  await sessions.releaseSession(sessionId);
});

test('file_upload attaches several files at once and clears with an empty list', async () => {
  const sessionId = await sessionOn('/upload');

  const body = payload(
    await handlers.file_upload({ sessionId, selector: '#multiFile', paths: [fileOne, fileTwo] })
  );
  assert.deepEqual((body.files as { name: string }[]).map(f => f.name), ['alpha.txt', 'beta.txt']);
  assert.equal(body.matched, true);

  const cleared = payload(await handlers.file_upload({ sessionId, selector: '#multiFile', paths: [] }));
  assert.deepEqual(cleared.files, [], 'an empty list must clear the selection');
  assert.equal(await evaluate(sessionId, "document.getElementById('multiFile').files.length"), 0);

  await sessions.releaseSession(sessionId);
});

test('file_upload follows a <label> to the file input it controls', async () => {
  const sessionId = await sessionOn('/upload');

  const body = payload(await handlers.file_upload({ sessionId, selector: '#labelledFile', paths: [fileTwo] }));

  assert.deepEqual(
    (body.files as { name: string }[]).map(f => f.name),
    ['beta.txt'],
    'the readback must follow the label to its control, not report the label\'s own empty list'
  );
  assert.equal(body.matched, true);
  assert.equal(await evaluate(sessionId, "document.getElementById('insideLabel').files[0].name"), 'beta.txt');

  await sessions.releaseSession(sessionId);
});

test('file_upload names the path that is missing rather than failing inside Playwright', async () => {
  const sessionId = await sessionOn('/upload');

  const missing = join(fileDir, 'nope.txt');
  await assert.rejects(
    () => handlers.file_upload({ sessionId, selector: '#visibleFile', paths: [fileOne, missing] }),
    (err: Error) => {
      assert.match(err.message, /nope\.txt/, 'the error must name the path that does not exist');
      return true;
    }
  );

  await assert.rejects(
    () => handlers.file_upload({ sessionId, selector: '#visibleFile', paths: ['alpha.txt'] }),
    /absolute/i,
    'a relative path is ambiguous between the caller and the daemon, so it must be refused'
  );

  await sessions.releaseSession(sessionId);
});

test('file_upload refuses a selector that is not a file input, naming what it found', async () => {
  const sessionId = await sessionOn('/upload');

  await assert.rejects(
    () => handlers.file_upload({ sessionId, selector: '#notAFile', paths: [fileOne] }),
    /file/i
  );

  await sessions.releaseSession(sessionId);
});

// ---------------------------------------------------------------------------
// navigate_back / navigate_forward
// ---------------------------------------------------------------------------

test('navigate_back says plainly when there is nothing to go back to', async () => {
  const { sessionId } = await sessions.createSession();

  const body = payload(await handlers.navigate_back({ sessionId }));

  assert.equal(body.navigated, false, 'a no-op must never look like a success');
  assert.equal(typeof body.note, 'string', 'the no-op must be explained, not left for the caller to spot');
  assert.equal(body.url, 'about:blank');

  await sessions.releaseSession(sessionId);
});

test('navigate_back and navigate_forward walk real cross-document history', async () => {
  const sessionId = await sessionOn('/history?first');
  await handlers.navigate({ sessionId, url: `${baseUrl}/history?second` });

  const back = payload(await handlers.navigate_back({ sessionId }));
  assert.equal(back.navigated, true);
  assert.equal(back.url, `${baseUrl}/history?first`);
  assert.equal(back.sameDocument, false, 'a different document really was loaded');
  assert.equal(back.previousUrl, `${baseUrl}/history?second`);

  const forward = payload(await handlers.navigate_forward({ sessionId }));
  assert.equal(forward.navigated, true);
  assert.equal(forward.url, `${baseUrl}/history?second`);
  assert.equal(forward.sameDocument, false);

  const atTip = payload(await handlers.navigate_forward({ sessionId }));
  assert.equal(atTip.navigated, false, 'there is nothing ahead of the newest entry');
  assert.equal(atTip.url, `${baseUrl}/history?second`);

  await sessions.releaseSession(sessionId);
});

test('navigate_back through a hash change is same-document, and the JS context survives it', async () => {
  const sessionId = await sessionOn('/history');
  await evaluate(sessionId, 'window.__qaMarker = "alive"');
  await handlers.navigate({ sessionId, url: `${baseUrl}/history#one` });
  await handlers.navigate({ sessionId, url: `${baseUrl}/history#two` });

  const popstatesBefore = await evaluate<number>(sessionId, 'window.__popstates');
  const body = payload(await handlers.navigate_back({ sessionId }));

  assert.equal(body.navigated, true);
  assert.equal(body.url, `${baseUrl}/history#one`);
  assert.equal(body.sameDocument, true, 'a hash step back does not reload, and the result must say so');
  assert.equal(typeof body.note, 'string', 'a same-document step needs the same warning navigate gives');

  assert.equal(await evaluate(sessionId, 'window.__qaMarker'), 'alive', 'the JS context really does survive');
  assert.equal(
    await evaluate<number>(sessionId, 'window.__popstates'),
    popstatesBefore + 1,
    'the app must see the popstate it restores state from'
  );

  const forward = payload(await handlers.navigate_forward({ sessionId }));
  assert.equal(forward.url, `${baseUrl}/history#two`);
  assert.equal(forward.sameDocument, true);
  assert.equal(await evaluate<number>(sessionId, 'window.__popstates'), popstatesBefore + 2);

  await sessions.releaseSession(sessionId);
});

// ---------------------------------------------------------------------------
// wheel
// ---------------------------------------------------------------------------

test('wheel scrolls the container under the point and reports the scroll it caused', async () => {
  const sessionId = await sessionOn('/wheel');

  const body = payload(await handlers.wheel({ sessionId, point: { selector: '#box' }, deltaY: 200 }));

  const scrollTop = await evaluate<number>(sessionId, "document.getElementById('box').scrollTop");
  assert.ok(scrollTop > 0, `the container must actually have scrolled, got scrollTop ${scrollTop}`);

  assert.equal(body.moved, true, 'a wheel that scrolled something must say so');
  const after = body.scroll as { after: { target?: { id: string; y: number } } };
  assert.equal(after.after.target?.id, 'box', 'the readback must name what actually scrolled');
  assert.equal(after.after.target?.y, scrollTop, 'the reported offset must be the real one');
  assert.deepEqual(body.point, { selector: '#box', x: 120, y: 95, matchedElements: 1 });
  assert.equal(body.totalDeltaY, 200);

  await sessions.releaseSession(sessionId);
});

test('wheel repeats dispatch separate events, because one big delta is not ten small ones', async () => {
  const oneShot = await sessionOn('/wheel');
  await handlers.wheel({ sessionId: oneShot, point: { selector: '#box' }, deltaY: 40 });
  const single = await evaluate<number>(oneShot, "document.getElementById('box').scrollTop");
  await sessions.releaseSession(oneShot);

  const sessionId = await sessionOn('/wheel');
  const body = payload(
    await handlers.wheel({ sessionId, point: { selector: '#box' }, deltaY: 40, repeat: 5, delay: 5 })
  );

  const repeated = await evaluate<number>(sessionId, "document.getElementById('box').scrollTop");
  assert.equal(repeated, single * 5, 'each repeat must be its own wheel event, not one merged delta');
  assert.equal(body.repeat, 5);
  assert.equal(body.totalDeltaY, 200, 'the total is the delta times the repeat count, and must be reported');

  await sessions.releaseSession(sessionId);
});

test('wheel with Control held is the trackpad pinch, and it is the only thing that zooms', async () => {
  const sessionId = await sessionOn('/wheel');

  await handlers.wheel({ sessionId, point: { selector: '#zoomer' }, deltaY: -250 });
  assert.equal(await evaluate(sessionId, 'window.__scale'), 1, 'a plain wheel must not take the zoom branch');
  assert.equal(
    (await evaluate<{ ctrl: boolean }[]>(sessionId, 'window.__wheels'))[0]!.ctrl,
    false,
    'a plain wheel must arrive with ctrlKey false'
  );

  const body = payload(
    await handlers.wheel({ sessionId, point: { selector: '#zoomer' }, deltaY: -250, modifiers: ['Control'] })
  );

  const wheels = await evaluate<{ ctrl: boolean; dy: number }[]>(sessionId, 'window.__wheels');
  assert.equal(wheels[1]!.ctrl, true, 'the modifier must reach the wheel event itself, not just the keyboard');
  assert.equal(await evaluate(sessionId, 'window.__scale'), 1.5, 'the zoom branch must really have run');

  // A canvas zoom is a transform, not a scroll, so nothing observable moved.
  // Saying "moved: false" plainly is the point: the alternative is a result
  // that reads like a success whether or not the zoom happened.
  assert.equal(body.moved, false);
  assert.equal(typeof body.note, 'string', 'a wheel that scrolled nothing must explain what that does and does not mean');

  await sessions.releaseSession(sessionId);
});

test('wheel releases its modifiers afterwards rather than leaving them stuck down', async () => {
  const sessionId = await sessionOn('/wheel');

  await handlers.wheel({ sessionId, point: { selector: '#zoomer' }, deltaY: -100, modifiers: ['Control'] });
  await handlers.press_key({ sessionId, key: 'a' });

  assert.equal(
    await evaluate(sessionId, 'window.__lastKeyCtrl'),
    false,
    'a modifier left down would silently change every later key and click in this session'
  );

  await sessions.releaseSession(sessionId);
});

test('wheel lands exactly where it was aimed, which is what makes zoom-toward-pointer testable', async () => {
  const sessionId = await sessionOn('/wheel');

  await handlers.wheel({ sessionId, point: { x: 420, y: 140 }, deltaY: 10 });
  await handlers.wheel({ sessionId, point: { selector: '#zoomer', x: 5, y: 7 }, deltaY: 10 });

  const wheels = await evaluate<{ x: number; y: number }[]>(sessionId, 'window.__wheels');
  assert.deepEqual({ x: wheels[0]!.x, y: wheels[0]!.y }, { x: 420, y: 140 }, 'a raw point must be used verbatim');
  assert.deepEqual({ x: wheels[1]!.x, y: wheels[1]!.y }, { x: 305, y: 27 }, 'an offset must be measured from the element');

  await sessions.releaseSession(sessionId);
});

test('wheel with no point uses the viewport centre, not wherever an earlier call left the pointer', async () => {
  const sessionId = await sessionOn('/wheel');

  // The trap: mouse.wheel dispatches at the current pointer position, so
  // without a deliberate default a wheel would silently inherit the last
  // hover or drag from some unrelated earlier call.
  await handlers.hover({ sessionId, selector: '#box' });

  const body = payload(await handlers.wheel({ sessionId, deltaY: 50 }));

  const centre = await evaluate<{ x: number; y: number }>(
    sessionId,
    '({ x: Math.round(window.innerWidth / 2), y: Math.round(window.innerHeight / 2) })'
  );
  assert.deepEqual(body.point, centre, 'the default point must be derived, not inherited');

  const seen = await evaluate<{ x: number; y: number }[]>(sessionId, 'window.__anyWheels');
  assert.deepEqual(seen[seen.length - 1], centre, 'and the event must really land there');

  await sessions.releaseSession(sessionId);
});

test('wheel refuses a delta of nothing rather than dispatching a no-op', async () => {
  const sessionId = await sessionOn('/wheel');
  await assert.rejects(() => handlers.wheel({ sessionId, point: { x: 100, y: 100 } }), /delta/i);
  await sessions.releaseSession(sessionId);
});
