import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';

import { BrowserManager } from '../src/daemon/browserManager.js';
import { createToolHandlers } from '../src/daemon/tools/handlers.js';
import { SessionStore } from '../src/daemon/sessions.js';
import { getFreePort } from './helpers.js';

const CE_CANVAS = `<!doctype html><html><body>
<div id="page" contenteditable="true">
  <div id="canvas">
    <div class="node" tabindex="0" data-id="n1">Node one</div>
    <div class="node" tabindex="0" data-id="n2">Node two</div>
    <div class="node" tabindex="0" data-id="n3">Node three</div>
  </div>
  <p id="doc">IMPORTANT USER CONTENT THAT MUST SURVIVE</p>
</div>
<script>
  document.getElementById('canvas').addEventListener('keydown', function (e) {
    if (e.key !== 'Delete' && e.key !== 'Backspace') return;
    var f = document.activeElement;
    if (f && f.classList && f.classList.contains('node')) f.remove();
  });
</script>
</body></html>`;

const DESIGNMODE = `<!doctype html><html><body>
<div id="canvas">
  <div class="node" tabindex="0" data-id="n1">Node one</div>
  <div class="node" tabindex="0" data-id="n2">Node two</div>
  <div class="node" tabindex="0" data-id="n3">Node three</div>
</div>
<p id="doc">IMPORTANT USER CONTENT THAT MUST SURVIVE</p>
<script>
  document.getElementById('canvas').addEventListener('keydown', function (e) {
    if (e.key !== 'Delete' && e.key !== 'Backspace') return;
    var f = document.activeElement;
    if (f && f.classList && f.classList.contains('node')) f.remove();
  });
</script>
</body></html>`;

const PAGES: Record<string, string> = { '/ce-canvas': CE_CANVAS, '/designmode': DESIGNMODE };

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

async function freshSession(path: string): Promise<string> {
  const { sessionId } = await sessions.createSession();
  await handlers.navigate({ sessionId, url: baseUrl + path });
  return sessionId;
}
function payload(result: unknown): Record<string, unknown> {
  return (result as { structuredContent: Record<string, unknown> }).structuredContent;
}
async function evaluate<T>(sessionId: string, expression: string): Promise<T> {
  return payload(await handlers.evaluate({ sessionId, expression })).result as T;
}
async function attempt(call: () => Promise<unknown>): Promise<string> {
  try {
    const r = await call();
    return 'RETURNED ' + JSON.stringify(payload(r)).slice(0, 900);
  } catch (err) {
    return 'THREW ' + (err instanceof Error ? err.message : String(err)).slice(0, 400);
  }
}
const SNAP =
  "({nodes: Array.from(document.querySelectorAll('#canvas .node')).map(n=>n.dataset.id), doc: (document.getElementById('doc')||{}).textContent ?? null, bodyText: document.body.innerText.replace(/\\s+/g,' ').trim().slice(0,80)})";

test('E1: what the caller is TOLD when type/clear wipes a contenteditable page', async () => {
  const s = await freshSession('/ce-canvas');
  await handlers.click({ s: 0, sessionId: s, selector: '[data-id="n2"]' } as never);
  console.log('E1 before:', JSON.stringify(await evaluate(s, SNAP)));
  console.log('E1 result:', await attempt(() => handlers.type({ sessionId: s, text: 'PWNED', clear: true })));
  console.log('E1 after :', JSON.stringify(await evaluate(s, SNAP)));
  await sessions.releaseSession(s);
});

test('E2: fill aimed at one canvas node inside a contenteditable region', async () => {
  const s = await freshSession('/ce-canvas');
  console.log('E2 before:', JSON.stringify(await evaluate(s, SNAP)));
  console.log('E2 result:', await attempt(() => handlers.fill({ sessionId: s, selector: '[data-id="n2"]', value: 'RENAMED' })));
  console.log('E2 after :', JSON.stringify(await evaluate(s, SNAP)));
  await sessions.releaseSession(s);
});

test('E3: type WITH selector + clear aimed at one canvas node in a contenteditable region', async () => {
  const s = await freshSession('/ce-canvas');
  console.log('E3 before:', JSON.stringify(await evaluate(s, SNAP)));
  console.log('E3 result:', await attempt(() => handlers.type({ sessionId: s, selector: '[data-id="n2"]', text: 'X', clear: true })));
  console.log('E3 after :', JSON.stringify(await evaluate(s, SNAP)));
  await sessions.releaseSession(s);
});

test('E4: designMode turned on AFTER load, then fill at a canvas node', async () => {
  const s = await freshSession('/designmode');
  console.log('E4 t0:', JSON.stringify(await evaluate(s, SNAP)));
  await evaluate(s, "document.designMode = 'on'");
  console.log('E4 t1 (designMode on):', JSON.stringify(await evaluate(s, SNAP)));
  console.log('E4 count:', await evaluate(s, "document.querySelectorAll('[data-id=\\\"n2\\\"]').length"));
  console.log('E4 result:', await attempt(() => handlers.fill({ sessionId: s, selector: '[data-id="n2"]', value: 'RENAMED' })));
  console.log('E4 t2:', JSON.stringify(await evaluate(s, SNAP)));
  await sessions.releaseSession(s);
});

test('E5: designMode on, click a node then type/clear with no selector', async () => {
  const s = await freshSession('/designmode');
  await evaluate(s, "document.designMode = 'on'");
  await handlers.click({ sessionId: s, selector: '[data-id="n2"]' });
  console.log('E5 active:', await evaluate(s, '({tag: document.activeElement.tagName, id: document.activeElement.getAttribute ? document.activeElement.getAttribute("data-id") : null, ce: document.activeElement.isContentEditable})'));
  console.log('E5 before:', JSON.stringify(await evaluate(s, SNAP)));
  console.log('E5 result:', await attempt(() => handlers.type({ sessionId: s, text: 'PWNED', clear: true })));
  console.log('E5 after :', JSON.stringify(await evaluate(s, SNAP)));
  await sessions.releaseSession(s);
});
