import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';

import { BrowserManager } from '../src/daemon/browserManager.js';
import { createToolHandlers } from '../src/daemon/tools/handlers.js';
import { SessionStore } from '../src/daemon/sessions.js';
import { getFreePort } from './helpers.js';

const PAGES: Record<string, string> = {
  '/keys': `<!doctype html><html><body>
<input id="f" value="hello world">
<div id="closedHost"></div>
<script>
  document.getElementById('closedHost').attachShadow({mode:'closed'}).innerHTML = '<input id="hidden" value="">';
</script>
</body></html>`,
  // readonly and disabled controls
  '/ro': `<!doctype html><html><body>
<input id="ro" readonly value="locked">
<input id="dis" disabled value="off">
<div id="tb" role="textbox" tabindex="0" aria-label="fake">not really editable</div>
<div id="ce-false" contenteditable="false">child of nothing</div>
<div contenteditable="true"><div id="ce-false-inner" contenteditable="false">false inside true</div></div>
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
    return 'RETURNED ' + JSON.stringify(payload(await call())).slice(0, 500);
  } catch (err) {
    return 'THREW ' + (err instanceof Error ? err.message : String(err)).slice(0, 300);
  }
}

const STATE = "({value: document.getElementById('f').value, start: document.getElementById('f').selectionStart, end: document.getElementById('f').selectionEnd})";

test('K1: the press_key note about macOS emacs bindings, measured', async () => {
  const s = await freshSession('/keys');
  await handlers.click({ sessionId: s, selector: '#f' });
  await evaluate(s, "document.getElementById('f').setSelectionRange(5,5)");
  console.log('K1 start:', await evaluate(s, STATE));
  await handlers.press_key({ sessionId: s, key: 'Control+a' });
  console.log('K1 after Control+a:', await evaluate(s, STATE));
  await evaluate(s, "document.getElementById('f').setSelectionRange(5,5)");
  await handlers.press_key({ sessionId: s, key: 'Control+e' });
  console.log('K1 after Control+e:', await evaluate(s, STATE));
  await evaluate(s, "document.getElementById('f').setSelectionRange(5,5)");
  await handlers.press_key({ sessionId: s, key: 'Control+k' });
  console.log('K1 after Control+k:', await evaluate(s, STATE));
  await sessions.releaseSession(s);
});

test('K2: press_key report when focus is inside a CLOSED shadow root', async () => {
  const s = await freshSession('/keys');
  await evaluate(s, "document.getElementById('closedHost').focus && document.getElementById('closedHost').setAttribute('tabindex','0')");
  console.log('K2 press:', await attempt(() => handlers.press_key({ sessionId: s, key: 'a' })));
  await sessions.releaseSession(s);
});

test('K3: readonly, disabled, role=textbox and contenteditable=false targets', async () => {
  const s = await freshSession('/ro');
  console.log('K3 fill(#ro):', (await attempt(() => handlers.fill({ sessionId: s, selector: '#ro', value: 'x' }))).slice(0, 300));
  console.log('K3 ORACLE ro =', JSON.stringify(await evaluate<string>(s, "document.getElementById('ro').value")));
  console.log('K3 fill(#tb):', (await attempt(() => handlers.fill({ sessionId: s, selector: '#tb', value: 'x' }))).slice(0, 300));
  console.log('K3 fill(#ce-false):', (await attempt(() => handlers.fill({ sessionId: s, selector: '#ce-false', value: 'x' }))).slice(0, 300));
  console.log('K3 fill(#ce-false-inner):', (await attempt(() => handlers.fill({ sessionId: s, selector: '#ce-false-inner', value: 'x' }))).slice(0, 300));
  console.log('K3 ORACLE inner =', JSON.stringify(await evaluate<string>(s, "document.getElementById('ce-false-inner').textContent")));
  await sessions.releaseSession(s);
});

test('K4: type with no selector on a focused readonly input and clear', async () => {
  const s = await freshSession('/ro');
  await handlers.click({ sessionId: s, selector: '#ro' });
  console.log('K4 type clear:', (await attempt(() => handlers.type({ sessionId: s, text: 'x', clear: true }))).slice(0, 400));
  console.log('K4 ORACLE ro =', JSON.stringify(await evaluate<string>(s, "document.getElementById('ro').value")));
  await sessions.releaseSession(s);
});
