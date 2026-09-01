import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';

import { BrowserManager } from '../src/daemon/browserManager.js';
import { createToolHandlers } from '../src/daemon/tools/handlers.js';
import { SessionStore } from '../src/daemon/sessions.js';
import { getFreePort } from './helpers.js';

// A window-level capture logger sees every key event before anything else in
// the page, including the write fence's own document-capture listener, so it
// answers "was a key dispatched at all" rather than "did something survive the
// fence". That is the question step 1 is actually about.
const LOGGER = `
  window.__keys = [];
  window.__caps = [];
  window.__bubbles = [];
  window.addEventListener('keydown', function (e) { window.__keys.push('keydown:' + e.key); }, true);
  window.addEventListener('keyup', function (e) { window.__keys.push('keyup:' + e.key); }, true);
  window.addEventListener('beforeinput', function (e) { window.__keys.push('beforeinput:' + e.inputType); }, true);
`;

// The canvas deletes whichever node holds focus when Delete is seen. Two
// handlers, one per phase, each recording that it ran before acting, so a
// surviving node and an empty log are two independent pieces of evidence
// rather than one restated twice.
const CANVAS = `<!doctype html><html><body>
<div id="canvas">
  <div class="node" data-id="n1"><span class="label" id="l1" contenteditable="true">one</span></div>
  <div class="node" data-id="n2"><span class="label" id="l2" contenteditable="true">two</span></div>
  <div class="node" data-id="n3"><span class="label" id="l3" contenteditable="true">three</span></div>
</div>
<script>
  ${LOGGER}
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
</script>
</body></html>`;

// The same canvas, but the editable region is a form control, which is the
// path Playwright's own fill takes. Finding 2 lives here.
const CANVAS_INPUT = `<!doctype html><html><body>
<div id="canvas">
  <div class="node" data-id="n1"><input class="rename" id="i1" value="one"></div>
  <div class="node" data-id="n2"><input class="rename" id="i2" value="two"></div>
  <div class="node" data-id="n3"><textarea class="rename" id="t3">three</textarea></div>
</div>
<script>
  ${LOGGER}
  function nodeOf(el) { while (el && !(el.classList && el.classList.contains('node'))) el = el.parentElement; return el; }
  document.getElementById('canvas').addEventListener('keydown', function (e) {
    if (e.key !== 'Delete' && e.key !== 'Backspace') return;
    window.__caps.push(e.key);
    var n = nodeOf(document.activeElement);
    if (n) n.remove();
  }, true);
  document.getElementById('canvas').addEventListener('keydown', function (e) {
    if (e.key !== 'Delete' && e.key !== 'Backspace') return;
    window.__bubbles.push(e.key);
    var n = nodeOf(document.activeElement);
    if (n) n.remove();
  }, false);
</script>
</body></html>`;

// Sibling call sites: select_option, upload, type/pressSequentially. Each one
// gets the same key log, so "dispatches nothing" is measured rather than
// assumed.
const SIBLINGS = `<!doctype html><html><body>
<select id="sel"><option value="a">A</option><option value="b">B</option><option value="c">C</option></select>
<input id="file" type="file">
<input id="text" value="seed">
<div id="ce" contenteditable="true">seed</div>
<script>${LOGGER}</script>
</body></html>`;

// A contenteditable holding more than the region being replaced, so a
// replacement that quietly took the whole host instead of the selection is
// visible rather than indistinguishable from a correct one.
const NESTED = `<!doctype html><html><body>
<div id="host" contenteditable="true"><p id="keep1">KEEP ONE</p><p id="field">REPLACE ME</p><p id="keep2">KEEP TWO</p></div>
<script>${LOGGER}</script>
</body></html>`;

const PAGES: Record<string, string> = {
  '/canvas': CANVAS,
  '/canvas-input': CANVAS_INPUT,
  '/siblings': SIBLINGS,
  '/nested': NESTED
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
async function attempt(call: () => Promise<unknown>): Promise<string> {
  try {
    return 'RETURNED ' + JSON.stringify(payload(await call())).slice(0, 400);
  } catch (err) {
    return 'THREW ' + (err instanceof Error ? err.message : String(err)).slice(0, 300);
  }
}
const ORACLE =
  '({ nodes: Array.from(document.querySelectorAll(".node")).map(n=>n.dataset.id), ' +
  'keys: window.__keys, caps: window.__caps, bubbles: window.__bubbles })';

test('R5-1 contenteditable, NON-EMPTY fill: does a key reach the page at all', async () => {
  const s = await open('/canvas');
  console.log('R5-1 fill:', (await attempt(() => handlers.fill({ sessionId: s, selector: '#l2', value: 'REPLACED' }))).slice(0, 260));
  console.log('R5-1 oracle:', JSON.stringify(await ev(s, ORACLE)));
  console.log('R5-1 l2 text:', JSON.stringify(await ev(s, 'document.getElementById("l2") && document.getElementById("l2").textContent')));
  await sessions.releaseSession(s);
});

test('R5-2 contenteditable, EMPTY fill: does a key reach the page at all', async () => {
  const s = await open('/canvas');
  console.log('R5-2 fill:', (await attempt(() => handlers.fill({ sessionId: s, selector: '#l2', value: '' }))).slice(0, 260));
  console.log('R5-2 oracle:', JSON.stringify(await ev(s, ORACLE)));
  console.log('R5-2 l2 text:', JSON.stringify(await ev(s, 'document.getElementById("l2") && document.getElementById("l2").textContent')));
  await sessions.releaseSession(s);
});

test('R5-3 form control fill, empty vs non-empty (Finding 2)', async () => {
  const s = await open('/canvas-input');
  console.log('R5-3a fill(i2,"X"):', (await attempt(() => handlers.fill({ sessionId: s, selector: '#i2', value: 'X' }))).slice(0, 200));
  console.log('R5-3a oracle:', JSON.stringify(await ev(s, ORACLE)));
  await ev(s, 'window.__keys = []; window.__caps = []; window.__bubbles = []; 1');
  console.log('R5-3b fill(i2,""):', (await attempt(() => handlers.fill({ sessionId: s, selector: '#i2', value: '' }))).slice(0, 200));
  console.log('R5-3b oracle:', JSON.stringify(await ev(s, ORACLE)));
  await sessions.releaseSession(s);
});

test('R5-4 textarea fill, empty vs non-empty (Finding 2, second control type)', async () => {
  const s = await open('/canvas-input');
  console.log('R5-4a fill(t3,"X"):', (await attempt(() => handlers.fill({ sessionId: s, selector: '#t3', value: 'X' }))).slice(0, 200));
  console.log('R5-4a oracle:', JSON.stringify(await ev(s, ORACLE)));
  await ev(s, 'window.__keys = []; window.__caps = []; window.__bubbles = []; 1');
  console.log('R5-4b fill(t3,""):', (await attempt(() => handlers.fill({ sessionId: s, selector: '#t3', value: '' }))).slice(0, 200));
  console.log('R5-4b oracle:', JSON.stringify(await ev(s, ORACLE)));
  await sessions.releaseSession(s);
});

test('R5-5 no-selector clear on a focused rename input', async () => {
  const s = await open('/canvas-input');
  await handlers.click({ sessionId: s, selector: '#i2' });
  await ev(s, 'window.__keys = []; window.__caps = []; window.__bubbles = []; 1');
  console.log('R5-5 type clear:', (await attempt(() => handlers.type({ sessionId: s, text: 'NEW', clear: true }))).slice(0, 260));
  console.log('R5-5 oracle:', JSON.stringify(await ev(s, ORACLE)));
  await sessions.releaseSession(s);
});

test('R5-6 replacement is scoped to the named element, not its editing host', async () => {
  const s = await open('/nested');
  console.log('R5-6 fill:', (await attempt(() => handlers.fill({ sessionId: s, selector: '#field', value: 'NEW TEXT' }))).slice(0, 260));
  console.log(
    'R5-6 oracle:',
    JSON.stringify(
      await ev(
        s,
        '({ host: document.getElementById("host").innerText, keys: window.__keys, ' +
          'ids: Array.from(document.querySelectorAll("#host p")).map(p=>p.id) })'
      )
    )
  );
  await sessions.releaseSession(s);
});

test('R5-7 sibling call sites: select_option, upload, type', async () => {
  const s = await open('/siblings');
  console.log('R5-7a select_option:', (await attempt(() => handlers.select_option({ sessionId: s, selector: '#sel', values: ['b'] }))).slice(0, 200));
  console.log('R5-7a keys:', JSON.stringify(await ev(s, 'window.__keys')));
  await ev(s, 'window.__keys = []; 1');
  console.log(
    'R5-7b upload:',
    (await attempt(() => handlers.file_upload({ sessionId: s, selector: '#file', paths: [new URL('.', import.meta.url).pathname + 'helpers.ts'] }))).slice(0, 200)
  );
  console.log('R5-7b keys:', JSON.stringify(await ev(s, 'window.__keys')));
  await ev(s, 'window.__keys = []; 1');
  console.log('R5-7c type(selector) no clear:', (await attempt(() => handlers.type({ sessionId: s, selector: '#text', text: 'ab' }))).slice(0, 200));
  console.log('R5-7c keys:', JSON.stringify(await ev(s, 'window.__keys')));
  await ev(s, 'window.__keys = []; 1');
  console.log('R5-7d type(selector) clear:', (await attempt(() => handlers.type({ sessionId: s, selector: '#text', text: 'cd', clear: true }))).slice(0, 200));
  console.log('R5-7d keys:', JSON.stringify(await ev(s, 'window.__keys')));
  await ev(s, 'window.__keys = []; 1');
  console.log('R5-7e type(ce selector) clear:', (await attempt(() => handlers.type({ sessionId: s, selector: '#ce', text: 'ef', clear: true }))).slice(0, 200));
  console.log('R5-7e keys:', JSON.stringify(await ev(s, 'window.__keys')));
  console.log('R5-7e ce text:', JSON.stringify(await ev(s, 'document.getElementById("ce").textContent')));
  await sessions.releaseSession(s);
});
