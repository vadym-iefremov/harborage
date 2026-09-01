import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';

import { BrowserManager } from '../src/daemon/browserManager.js';
import { createToolHandlers } from '../src/daemon/tools/handlers.js';
import { SessionStore } from '../src/daemon/sessions.js';
import { getFreePort } from './helpers.js';

const PAGES: Record<string, string> = {
  // A canvas whose nodes carry an INLINE EDITABLE LABEL, which is what an
  // editable-node-title canvas looks like. The label is its own editing host,
  // so every guard is satisfied. The canvas still listens for Delete.
  '/label-canvas': `<!doctype html><html><body>
<div id="canvas">
  <div class="node" tabindex="0" data-id="n1">Node one <span class="label" contenteditable="true">L1</span></div>
  <div class="node" tabindex="0" data-id="n2">Node two <span class="label" contenteditable="true">L2</span></div>
  <div class="node" tabindex="0" data-id="n3">Node three <span class="label" contenteditable="true">L3</span></div>
</div>
<p id="doc">IMPORTANT USER CONTENT</p>
<script>
  document.getElementById('canvas').addEventListener('keydown', function (e) {
    if (e.key !== 'Delete' && e.key !== 'Backspace') return;
    var n = document.activeElement && document.activeElement.closest ? document.activeElement.closest('.node') : null;
    if (n) n.remove();
  });
</script>
</body></html>`,

  // Same, but the inline editor is an <input>, which the no-selector clear
  // guard exempts because a form control's region is its own value.
  '/input-canvas': `<!doctype html><html><body>
<div id="canvas">
  <div class="node" data-id="n1">n1 <input class="rename" value="one"></div>
  <div class="node" data-id="n2">n2 <input class="rename" value="two"></div>
  <div class="node" data-id="n3">n3 <input class="rename" value="three"></div>
</div>
<script>
  document.getElementById('canvas').addEventListener('keydown', function (e) {
    if (e.key !== 'Delete' && e.key !== 'Backspace') return;
    var n = document.activeElement && document.activeElement.closest ? document.activeElement.closest('.node') : null;
    if (n) n.remove();
  });
</script>
</body></html>`,

  // A page that moves the SELECTION on selectionchange, which fires after the
  // evaluate that placed and verified the Range has already returned.
  '/selection-thief': `<!doctype html><html><body>
<div id="field" contenteditable="true">ORIGINAL</div>
<div id="rest">
  <p id="p1">PARAGRAPH ONE THAT MUST SURVIVE</p>
  <p id="p2">PARAGRAPH TWO THAT MUST SURVIVE</p>
</div>
<div id="wide" contenteditable="true"><p id="w1">WIDE ONE</p><p id="w2">WIDE TWO</p><p id="w3">WIDE THREE</p></div>
<script>
  var armed = false;
  document.addEventListener('selectionchange', function () {
    if (!armed) return;
    armed = false;
    var sel = window.getSelection();
    sel.removeAllRanges();
    var r = document.createRange();
    r.selectNodeContents(document.getElementById('wide'));
    sel.addRange(r);
  });
  window.arm = function () { armed = true; };
</script>
</body></html>`,

  // A page that COLLAPSES the selection on selectionchange, the way an editor
  // that reasserts its own cursor would.
  '/selection-collapser': `<!doctype html><html><body>
<div id="field" contenteditable="true">ORIGINALCONTENT</div>
<script>
  var armed = false;
  document.addEventListener('selectionchange', function () {
    if (!armed) return;
    armed = false;
    var sel = window.getSelection();
    sel.collapse(document.getElementById('field').firstChild, 0);
  });
  window.arm = function () { armed = true; };
</script>
</body></html>`,

  // A contenteditable whose page swallows Delete.
  '/delete-eater': `<!doctype html><html><body>
<div id="field" contenteditable="true">KEEPME</div>
<script>
  document.addEventListener('keydown', function (e) { if (e.key === 'Delete') e.preventDefault(); }, true);
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
  const a = server.address();
  baseUrl = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
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

async function fresh(path: string): Promise<string> {
  const { sessionId } = await sessions.createSession();
  await handlers.navigate({ sessionId, url: baseUrl + path });
  return sessionId;
}
function payload(r: unknown): Record<string, unknown> {
  return (r as { structuredContent: Record<string, unknown> }).structuredContent;
}
async function ev<T>(s: string, e: string): Promise<T> {
  return payload(await handlers.evaluate({ sessionId: s, expression: e })).result as T;
}
async function attempt(call: () => Promise<unknown>): Promise<string> {
  try {
    return 'RETURNED ' + JSON.stringify(payload(await call())).slice(0, 700);
  } catch (err) {
    return 'THREW ' + (err instanceof Error ? err.message : String(err)).slice(0, 450);
  }
}
const CANVAS = "JSON.stringify(Array.from(document.querySelectorAll('#canvas .node')).map(n=>n.dataset.id))";

test('R1: fill an inline editable label inside a canvas that deletes on Delete', async () => {
  const s = await fresh('/label-canvas');
  console.log('R1 nodes before:', await ev(s, CANVAS));
  console.log('R1 result:', await attempt(() => handlers.fill({ sessionId: s, selector: '[data-id="n2"] .label', value: 'RENAMED' })));
  console.log('R1 nodes after :', await ev(s, CANVAS));
  console.log('R1 doc:', await ev(s, "(document.getElementById('doc')||{}).textContent ?? null"));
  await sessions.releaseSession(s);
});

test('R2: type{clear} with a selector on that same inline label', async () => {
  const s = await fresh('/label-canvas');
  console.log('R2 nodes before:', await ev(s, CANVAS));
  console.log('R2 result:', await attempt(() => handlers.type({ sessionId: s, selector: '[data-id="n2"] .label', text: 'X', clear: true })));
  console.log('R2 nodes after :', await ev(s, CANVAS));
  await sessions.releaseSession(s);
});

test('R3: type{clear} with NO selector, caret on an inline label (editing host)', async () => {
  const s = await fresh('/label-canvas');
  await handlers.click({ sessionId: s, selector: '[data-id="n2"] .label' });
  console.log('R3 active:', await ev(s, '({tag:document.activeElement.tagName, cls:document.activeElement.className})'));
  console.log('R3 nodes before:', await ev(s, CANVAS));
  console.log('R3 result:', await attempt(() => handlers.type({ sessionId: s, text: 'X', clear: true })));
  console.log('R3 nodes after :', await ev(s, CANVAS));
  await sessions.releaseSession(s);
});

test('R4: type{clear} with NO selector, caret on an inline INPUT (exempt from the host refusal)', async () => {
  const s = await fresh('/input-canvas');
  await handlers.click({ sessionId: s, selector: '[data-id="n2"] .rename' });
  console.log('R4 active:', await ev(s, '({tag:document.activeElement.tagName, v:document.activeElement.value})'));
  console.log('R4 nodes before:', await ev(s, CANVAS));
  console.log('R4 result:', await attempt(() => handlers.type({ sessionId: s, text: 'X', clear: true })));
  console.log('R4 nodes after :', await ev(s, CANVAS));
  await sessions.releaseSession(s);
});

test('R4b: fill with a selector on that same inline INPUT', async () => {
  const s = await fresh('/input-canvas');
  console.log('R4b nodes before:', await ev(s, CANVAS));
  console.log('R4b result:', await attempt(() => handlers.fill({ sessionId: s, selector: '[data-id="n2"] .rename', value: 'RENAMED' })));
  console.log('R4b nodes after :', await ev(s, CANVAS));
  await sessions.releaseSession(s);
});

test('R5: the selection is moved to a WIDER element after the Range is verified', async () => {
  const s = await fresh('/selection-thief');
  const snap = "({field: document.getElementById('field').textContent, wide: document.getElementById('wide').textContent, p1: (document.getElementById('p1')||{}).textContent ?? null})";
  console.log('R5 before:', JSON.stringify(await ev(s, snap)));
  await ev(s, 'window.arm()');
  console.log('R5 result:', await attempt(() => handlers.fill({ sessionId: s, selector: '#field', value: 'NEW' })));
  console.log('R5 after :', JSON.stringify(await ev(s, snap)));
  await sessions.releaseSession(s);
});

test('R6: the selection is collapsed after the Range is verified', async () => {
  const s = await fresh('/selection-collapser');
  await ev(s, 'window.arm()');
  console.log('R6 result:', await attempt(() => handlers.fill({ sessionId: s, selector: '#field', value: 'NEW' })));
  console.log('R6 ORACLE field =', JSON.stringify(await ev(s, "document.getElementById('field').textContent")));
  await sessions.releaseSession(s);
});

test('R7: the page swallows the Delete key', async () => {
  const s = await fresh('/delete-eater');
  console.log('R7 result:', await attempt(() => handlers.fill({ sessionId: s, selector: '#field', value: 'NEW' })));
  console.log('R7 ORACLE field =', JSON.stringify(await ev(s, "document.getElementById('field').textContent")));
  const s2 = await fresh('/delete-eater');
  console.log('R7b type{clear} result:', await attempt(() => handlers.type({ sessionId: s2, selector: '#field', text: 'NEW', clear: true })));
  console.log('R7b ORACLE field =', JSON.stringify(await ev(s2, "document.getElementById('field').textContent")));
  await sessions.releaseSession(s);
  await sessions.releaseSession(s2);
});
