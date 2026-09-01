import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';

import { BrowserManager } from '../src/daemon/browserManager.js';
import { createToolHandlers } from '../src/daemon/tools/handlers.js';
import { SessionStore } from '../src/daemon/sessions.js';
import { interactionTools } from '../src/daemon/tools/defs/interaction.js';
import { getFreePort } from './helpers.js';

/**
 * Round 5. Rounds two and three fought the SCOPE of the deletion and got it
 * right: a Range over the target's own contents bounds what the browser's
 * default deletion touches. Neither of them touched the DELIVERY. A literal
 * Delete key was still pressed, and a key event reaches every ancestor, so a
 * canvas that treats Delete as "remove the selected node" removed one from a
 * write aimed precisely at one legitimate editing host inside it. Round 4's
 * fence stopped the bubble phase and could not stop the capture phase, because
 * capture reaches an ancestor before the event reaches the target at all.
 *
 * The key is gone rather than fenced. Every assertion below is about the
 * absence of a keystroke, measured by a WINDOW-level capture listener, which
 * runs before anything else in the page including the fence's own document
 * listener. So these answer "was a key dispatched at all", not "did something
 * survive the guard", and a fix that merely suppressed the key later would
 * fail them.
 *
 * Two independent oracles throughout, because either alone can be satisfied by
 * accident: the event log, and the page's own list of surviving nodes.
 */

const LOGGER = `
  window.__keys = [];
  window.__caps = [];
  window.__bubbles = [];
  window.addEventListener('keydown', function (e) { window.__keys.push('keydown:' + e.key); }, true);
  window.addEventListener('keyup', function (e) { window.__keys.push('keyup:' + e.key); }, true);
  window.addEventListener('beforeinput', function (e) { window.__keys.push('beforeinput:' + e.inputType); }, true);
`;

/**
 * A canvas that deletes whichever node holds focus on Delete, with one handler
 * per phase. The capture handler is the one round 4 could not stop, so it is
 * the one that matters here; the bubble handler is kept so a regression that
 * removed the fence entirely is distinguishable from one that removed the key.
 */
const CANVAS_HANDLERS = `
  function nodeOf(el) { while (el && !(el.classList && el.classList.contains('node'))) el = el.parentElement; return el; }
  document.getElementById('canvas').addEventListener('keydown', function (e) {
    if (e.key !== 'Delete' && e.key !== 'Backspace') return;
    window.__caps.push(e.key);
    var n = nodeOf(document.activeElement) || nodeOf(window.getSelection().anchorNode);
    if (n) n.remove();
  }, true);
  document.getElementById('canvas').addEventListener('keydown', function (e) {
    if (e.key !== 'Delete' && e.key !== 'Backspace') return;
    window.__bubbles.push(e.key);
    var n = nodeOf(document.activeElement) || nodeOf(window.getSelection().anchorNode);
    if (n) n.remove();
  }, false);
`;

const PAGES: Record<string, string> = {
  // An inline contenteditable label inside a canvas node. This is the exact
  // shape that took a real Acres canvas from three nodes to two.
  '/canvas-ce': `<!doctype html><html><body>
<div id="canvas">
  <div class="node" data-id="n1"><span class="label" id="l1" contenteditable="true">one</span></div>
  <div class="node" data-id="n2"><span class="label" id="l2" contenteditable="true">two</span></div>
  <div class="node" data-id="n3"><span class="label" id="l3" contenteditable="true">three</span></div>
</div>
<script>${LOGGER}${CANVAS_HANDLERS}</script>
</body></html>`,

  // The same canvas with a rename INPUT instead, which is the path Playwright's
  // own fill takes and where Finding 2 lives.
  '/canvas-input': `<!doctype html><html><body>
<div id="canvas">
  <div class="node" data-id="n1"><input class="rename" id="i1" value="one"></div>
  <div class="node" data-id="n2"><input class="rename" id="i2" value="two"></div>
  <div class="node" data-id="n3"><textarea class="rename" id="t3">three</textarea></div>
</div>
<script>${LOGGER}${CANVAS_HANDLERS}</script>
</body></html>`,

  // Sibling call sites, and a plain control to pin Playwright's own behaviour
  // against directly.
  '/siblings': `<!doctype html><html><body>
<select id="sel"><option value="a">A</option><option value="b">B</option><option value="c">C</option></select>
<input id="file" type="file">
<input id="text" value="ORIGINAL">
<input id="text2" value="ORIGINAL">
<textarea id="ta">ORIGINAL</textarea>
<div id="ce" contenteditable="true">ORIGINAL</div>
<script>${LOGGER}</script>
</body></html>`,

  // Three siblings inside one editing host, only the middle one named, so a
  // replacement that quietly took the host is visible rather than
  // indistinguishable from a correct one.
  '/scope': `<!doctype html><html><body>
<div id="host" contenteditable="true"><span id="a">AAA</span><span id="b">BBB</span><span id="c">CCC</span></div>
<script>${LOGGER}</script>
</body></html>`,

  // A page that REFUSES an insert: it cancels beforeinput and applies its own
  // edit, inserting at the range start without removing the range contents, so
  // a replacement becomes a prepend. No shipping editor was found doing this,
  // and the live CodeMirror 6 in Acres does not, but a page can be written this
  // way and a keyless write cannot make it accept one. This is the only shape
  // that still gets a Delete out of a write path.
  '/refuses': `<!doctype html><html><body>
<div id="editor" contenteditable="true">result</div>
<script>
  ${LOGGER}
  document.getElementById('editor').addEventListener('beforeinput', function (e) {
    if (!e.inputType || e.inputType.indexOf('insert') !== 0) return;
    e.preventDefault();
    var t = e.data != null ? e.data : '';
    var range = window.getSelection().getRangeAt(0);
    range.insertNode(document.createTextNode(t));
    range.collapse(false);
  });
</script>
</body></html>`
};

let server: Server;
let baseUrl: string;
let browserManager: BrowserManager;
let sessions: SessionStore;
let handlers: ReturnType<typeof createToolHandlers>;

before(async () => {
  server = createServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(PAGES[(req.url ?? '/').split('?')[0]] ?? '<!doctype html><html><body>none</body></html>');
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

async function open(path: string): Promise<string> {
  const { sessionId } = await sessions.createSession();
  await handlers.navigate({ sessionId, url: baseUrl + path });
  return sessionId;
}
function payload(result: unknown): Record<string, unknown> {
  return (result as { structuredContent: Record<string, unknown> }).structuredContent;
}
async function ev<T>(sessionId: string, expression: string): Promise<T> {
  return payload(await handlers.evaluate({ sessionId, expression })).result as T;
}
async function keys(sessionId: string): Promise<string[]> {
  return ev<string[]>(sessionId, 'window.__keys');
}
async function resetKeys(sessionId: string): Promise<void> {
  await ev(sessionId, 'window.__keys = []; window.__caps = []; window.__bubbles = []; 1');
}
async function canvasState(sessionId: string): Promise<{ nodes: string[]; caps: string[]; bubbles: string[] }> {
  return ev(
    sessionId,
    '({ nodes: Array.from(document.querySelectorAll(".node")).map(n=>n.dataset.id), caps: window.__caps, bubbles: window.__bubbles })'
  );
}
/** The assertion this whole round is about, stated once. */
function assertNoKeyDispatched(log: string[], what: string): void {
  const pressed = log.filter(entry => entry.startsWith('keydown:') || entry.startsWith('keyup:'));
  assert.deepEqual(pressed, [], `${what} dispatched key events: ${JSON.stringify(log)}`);
}

/**
 * Playwright's own behaviour, asserted directly against locator.fill rather
 * than through a handler, because it is the thing an upgrade can change under
 * us and it is the thing the clear path is built around. Measured on
 * Playwright 1.62: fill("X") dispatches beforeinput/input with inputType
 * insertText and no key at all, while fill("") dispatches a real keydown
 * Delete with inputType deleteContentForward.
 *
 * If this test goes red after a Playwright bump, that is the point of it. Read
 * the new log before touching clearOrFillFormControl: a fill that stopped
 * pressing Delete would make the select-then-insertText clear unnecessary, and
 * a fill that started pressing one for a NON-empty value would make it
 * necessary in a place nothing currently protects.
 */
test('Playwright fill dispatches a Delete key for an empty value and no key for a non-empty one', async () => {
  const s = await open('/siblings');
  const page = sessions.resolve(s).page as unknown as { locator(sel: string): { fill(v: string): Promise<void> } };

  await resetKeys(s);
  await page.locator('#text').fill('NON EMPTY');
  const nonEmpty = await keys(s);
  assert.deepEqual(
    nonEmpty.filter(k => k.startsWith('keydown:')),
    [],
    `Playwright's fill with a non-empty value now presses a key: ${JSON.stringify(nonEmpty)}`
  );

  await resetKeys(s);
  await page.locator('#text2').fill('');
  const empty = await keys(s);
  assert.ok(
    empty.includes('keydown:Delete'),
    'Playwright\'s fill("") no longer presses Delete. That is good news, but clearOrFillFormControl was built ' +
      `around it pressing one, so re-read that function before deleting this test. Log: ${JSON.stringify(empty)}`
  );

  await sessions.releaseSession(s);
});

test('fill on a contenteditable dispatches no key, for a non-empty value', async () => {
  const s = await open('/canvas-ce');
  await handlers.fill({ sessionId: s, selector: '#l2', value: 'REPLACED' });
  assertNoKeyDispatched(await keys(s), 'fill on a contenteditable with a non-empty value');
  const state = await canvasState(s);
  assert.deepEqual(state.nodes, ['n1', 'n2', 'n3'], 'the canvas lost a node to a write aimed at a label inside it');
  assert.deepEqual(state.caps, [], 'the canvas capture handler saw a Delete');
  assert.equal(await ev(s, 'document.getElementById("l2").textContent'), 'REPLACED');
  await sessions.releaseSession(s);
});

test('fill on a contenteditable dispatches no key, for an EMPTY value', async () => {
  const s = await open('/canvas-ce');
  await handlers.fill({ sessionId: s, selector: '#l2', value: '' });
  assertNoKeyDispatched(await keys(s), 'fill on a contenteditable with an empty value');
  const state = await canvasState(s);
  assert.deepEqual(state.nodes, ['n1', 'n2', 'n3'], 'clearing a label inside a canvas node removed the node');
  assert.deepEqual(state.caps, []);
  assert.equal(await ev(s, 'document.getElementById("l2").textContent'), '');
  await sessions.releaseSession(s);
});

test('fill on an input dispatches no key, empty or not (Finding 2 closed)', async () => {
  const s = await open('/canvas-input');
  await handlers.fill({ sessionId: s, selector: '#i2', value: 'X' });
  assertNoKeyDispatched(await keys(s), 'fill on an input with a non-empty value');

  await resetKeys(s);
  await handlers.fill({ sessionId: s, selector: '#i2', value: '' });
  assertNoKeyDispatched(await keys(s), 'fill on an input with an empty value');

  const state = await canvasState(s);
  assert.deepEqual(state.nodes, ['n1', 'n2', 'n3'], 'clearing a rename input inside a canvas node removed the node');
  assert.deepEqual(state.caps, []);
  assert.equal(await ev(s, 'document.getElementById("i2").value'), '');
  await sessions.releaseSession(s);
});

test('fill on a textarea dispatches no key, empty or not', async () => {
  const s = await open('/canvas-input');
  await handlers.fill({ sessionId: s, selector: '#t3', value: 'X' });
  assertNoKeyDispatched(await keys(s), 'fill on a textarea with a non-empty value');

  await resetKeys(s);
  await handlers.fill({ sessionId: s, selector: '#t3', value: '' });
  assertNoKeyDispatched(await keys(s), 'fill on a textarea with an empty value');

  const state = await canvasState(s);
  assert.deepEqual(state.nodes, ['n1', 'n2', 'n3']);
  assert.equal(await ev(s, 'document.getElementById("t3").value'), '');
  await sessions.releaseSession(s);
});

test('type with clear dispatches the typed characters and nothing else', async () => {
  const s = await open('/canvas-input');
  await handlers.click({ sessionId: s, selector: '#i2' });
  await resetKeys(s);
  const result = payload(await handlers.type({ sessionId: s, text: 'NEW', clear: true }));
  const log = await keys(s);
  const pressed = log.filter(entry => entry.startsWith('keydown:')).map(entry => entry.slice('keydown:'.length));
  assert.deepEqual(pressed, ['N', 'E', 'W'], `the clear pressed something other than the typed text: ${JSON.stringify(log)}`);

  const state = await canvasState(s);
  assert.deepEqual(state.nodes, ['n1', 'n2', 'n3'], 'the no-selector clear removed a canvas node');
  assert.deepEqual(state.caps, []);
  // The readback used to come back as the whole page's text, because the
  // element it was reading had been removed from the document by then.
  assert.equal(result.value, 'NEW');
  assert.equal(result.previousValue, 'two');
  await sessions.releaseSession(s);
});

test('type with clear and a selector dispatches only the typed characters', async () => {
  const s = await open('/canvas-input');
  await resetKeys(s);
  await handlers.type({ sessionId: s, selector: '#i2', text: 'ab', clear: true });
  const pressed = (await keys(s)).filter(e => e.startsWith('keydown:')).map(e => e.slice('keydown:'.length));
  assert.deepEqual(pressed, ['a', 'b']);
  assert.deepEqual((await canvasState(s)).nodes, ['n1', 'n2', 'n3']);
  await sessions.releaseSession(s);
});

test('type WITHOUT clear still presses a real key per character', async () => {
  // The complement of every assertion above, and the reason they are worded as
  // "no key" rather than "no events": typing is supposed to press keys, and a
  // change that made everything keyless would break the tool's whole purpose.
  const s = await open('/siblings');
  await resetKeys(s);
  await handlers.type({ sessionId: s, selector: '#text', text: 'xy' });
  const pressed = (await keys(s)).filter(e => e.startsWith('keydown:')).map(e => e.slice('keydown:'.length));
  assert.deepEqual(pressed, ['x', 'y']);
  await sessions.releaseSession(s);
});

test('a replacement stays inside the element named, not its editing host', async () => {
  const s = await open('/scope');
  await handlers.fill({ sessionId: s, selector: '#b', value: 'ZZZ' }).catch(() => undefined);
  const host = await ev<string>(s, 'document.getElementById("host").textContent');
  assert.ok(
    host.startsWith('AAA') && host.endsWith('CCC'),
    `a write aimed at one span took its siblings with it: ${JSON.stringify(host)}`
  );
  await sessions.releaseSession(s);
});

test('select_option and file_upload dispatch no key events', async () => {
  const s = await open('/siblings');
  await resetKeys(s);
  await handlers.select_option({ sessionId: s, selector: '#sel', values: ['b'] });
  assertNoKeyDispatched(await keys(s), 'select_option');

  await resetKeys(s);
  await handlers.file_upload({
    sessionId: s,
    selector: '#file',
    paths: [new URL('helpers.ts', import.meta.url).pathname]
  });
  assertNoKeyDispatched(await keys(s), 'file_upload');
  await sessions.releaseSession(s);
});

test('locator.selectText dispatches no events at all, on every control type it is used for', async () => {
  // The clear path leans on this: if selectText ever started dispatching a key
  // of its own, that key would go out on every clear.
  const s = await open('/siblings');
  const page = sessions.resolve(s).page as unknown as { locator(sel: string): { selectText(): Promise<void> } };
  for (const id of ['text', 'ta', 'ce']) {
    await resetKeys(s);
    await page.locator('#' + id).selectText();
    assert.deepEqual(await keys(s), [], `selectText on #${id} dispatched something`);
  }
  await sessions.releaseSession(s);
});

test('fill, type and press_key descriptions say what is and is not dispatched', () => {
  const fill = interactionTools.fill.description;
  assert.match(fill, /NO KEY EVENT/);
  // The asymmetry a caller cannot see and would otherwise be bitten by.
  assert.match(fill, /fill\(""\)/);
  assert.match(fill, /insertText/);

  const type = interactionTools.type.description;
  assert.match(type, /capture phase/i);
  assert.match(type, /no key at all|dispatching no key/i);

  const press = interactionTools.press_key.description;
  assert.match(press, /EVERY ancestor/);
  assert.match(press, /capture phase/i);

  for (const [name, def] of Object.entries(interactionTools)) {
    assert.ok(!def.description.includes('—'), `${name}'s description contains an em-dash`);
  }
});

test('a page that refuses the insert gets one Delete, and the write still lands', async () => {
  // The trade this round makes, pinned in both directions. A keyless write
  // cannot make a page accept an insert it has decided to cancel, so where the
  // readback can be believed and disagrees, a real Delete is pressed once and
  // the replacement is retried. Without this the round-2 append bug is
  // reachable again through a different door.
  const s = await open('/refuses');
  await resetKeys(s);
  const result = payload(await handlers.fill({ sessionId: s, selector: '#editor', value: '{{ $json.mode }}' }));
  const log = await keys(s);

  assert.equal(
    await ev(s, 'document.getElementById("editor").textContent'),
    '{{ $json.mode }}',
    `the write appended instead of replacing: ${JSON.stringify(log)}`
  );
  assert.equal(result.value, '{{ $json.mode }}');
  assert.equal(result.matched, true);
  assert.deepEqual(
    log.filter(e => e.startsWith('keydown:')),
    ['keydown:Delete'],
    `expected exactly one Delete on the fallback path, got ${JSON.stringify(log)}`
  );
  await sessions.releaseSession(s);
});

test('the fallback does NOT fire on the shape that loses data', async () => {
  // The gate that makes the test above acceptable. An inline contenteditable
  // label inside a Delete-handling canvas is the exact shape that took a real
  // Acres canvas from three nodes to two, and it accepts the insertText, so
  // there is no mismatch and no retry and no key. If a future change made the
  // fallback fire more eagerly, this is what goes red.
  const s = await open('/canvas-ce');
  await resetKeys(s);
  await handlers.fill({ sessionId: s, selector: '#l2', value: 'REPLACED' });
  assertNoKeyDispatched(await keys(s), 'fill on an ordinary contenteditable inside a canvas');
  assert.deepEqual((await canvasState(s)).nodes, ['n1', 'n2', 'n3']);
  await sessions.releaseSession(s);
});

test('a refusing editor whose readback cannot be believed gets NO fallback key', async () => {
  // A virtualizing editor renders only what is on screen, so its textContent
  // disagrees with the requested value most of the time even when the write was
  // perfect. Retrying on that disagreement would press a Delete on every write
  // to exactly the editors this round exists to keep keys away from.
  const s = await open('/refuses');
  await ev(s, 'document.getElementById("editor").classList.add("cm-content"); 1');
  await resetKeys(s);
  await handlers.fill({ sessionId: s, selector: '#editor', value: 'ZZZ' });
  assertNoKeyDispatched(await keys(s), 'fill on a refusing editor with an untrustworthy readback');
  await sessions.releaseSession(s);
});

test('a multi-line value into a plain contenteditable presses no key', async () => {
  // The case that made the fallback's trigger too loose. insertText puts a
  // line break into a contenteditable as a <br>, which textContent does not
  // render as a newline, so a correct write reads back "ab" against a
  // requested "a\nb" and compares unequal. Falling back on any disagreement
  // pressed a Delete there, on a plain contenteditable inside a canvas, which
  // is the exact element this round exists to protect.
  const s = await open('/canvas-ce');
  await resetKeys(s);
  await handlers.fill({ sessionId: s, selector: '#l2', value: 'first\nsecond' });
  assertNoKeyDispatched(await keys(s), 'fill with a multi-line value');
  assert.deepEqual((await canvasState(s)).nodes, ['n1', 'n2', 'n3']);
  const landed = await ev<string>(s, 'document.getElementById("l2").innerHTML');
  assert.match(landed, /first/);
  assert.match(landed, /second/);
  await sessions.releaseSession(s);
});
