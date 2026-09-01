import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';

import { BrowserManager } from '../src/daemon/browserManager.js';
import { createToolHandlers } from '../src/daemon/tools/handlers.js';
import { SessionStore } from '../src/daemon/sessions.js';
import { getFreePort } from './helpers.js';

// Raw-mechanism questions, asked of Playwright's own keyboard rather than of
// the handlers, because the answer decides what the handlers should do.
const LOG = `
  window.__ev = [];
  ['keydown','keyup','beforeinput','input','change','textInput'].forEach(function (t) {
    window.addEventListener(t, function (e) {
      window.__ev.push(t + (e.inputType ? ':' + e.inputType : '') + (e.key ? ':' + e.key : '') + '@' + (e.target.id || e.target.tagName));
    }, true);
  });
`;

const PAGE = `<!doctype html><html><body>
<div id="ce" contenteditable="true">ORIGINAL TEXT</div>
<input id="inp" value="ORIGINAL TEXT">
<textarea id="ta">ORIGINAL TEXT</textarea>
<div id="host" contenteditable="true"><span id="a">AAA</span><span id="b">BBB</span><span id="c">CCC</span></div>
<script>${LOG}</script>
</body></html>`;

let server: Server;
let baseUrl: string;
let browserManager: BrowserManager;
let sessions: SessionStore;
let handlers: ReturnType<typeof createToolHandlers>;

before(async () => {
  server = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(PAGE);
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

function payload(result: unknown): Record<string, unknown> {
  return (result as { structuredContent: Record<string, unknown> }).structuredContent;
}
async function ev<T>(sessionId: string, expression: string): Promise<T> {
  return payload(await handlers.evaluate({ sessionId, expression })).result as T;
}

// Reaches the real Playwright page behind a session, which is what the
// handlers use, so keyboard.insertText here is the same call site the fix
// would make.
async function pageOf(sessionId: string): Promise<{
  keyboard: { insertText(text: string): Promise<void>; press(key: string): Promise<void> };
}> {
  return sessions.resolve(sessionId).page as never;
}

test('R5b-1 insertText("") over a contenteditable selection', async () => {
  const { sessionId: s } = await sessions.createSession();
  await handlers.navigate({ sessionId: s, url: baseUrl });
  const page = await pageOf(s);
  await ev(s, 'const e=document.getElementById("ce"); e.focus(); const r=document.createRange(); r.selectNodeContents(e); const sl=getSelection(); sl.removeAllRanges(); sl.addRange(r); window.__ev=[]; 1');
  await page.keyboard.insertText('');
  console.log('R5b-1 ce text:', JSON.stringify(await ev(s, 'document.getElementById("ce").textContent')));
  console.log('R5b-1 events:', JSON.stringify(await ev(s, 'window.__ev')));
  await sessions.releaseSession(s);
});

test('R5b-2 insertText("NEW") over a contenteditable selection', async () => {
  const { sessionId: s } = await sessions.createSession();
  await handlers.navigate({ sessionId: s, url: baseUrl });
  const page = await pageOf(s);
  await ev(s, 'const e=document.getElementById("ce"); e.focus(); const r=document.createRange(); r.selectNodeContents(e); const sl=getSelection(); sl.removeAllRanges(); sl.addRange(r); window.__ev=[]; 1');
  await page.keyboard.insertText('NEW');
  console.log('R5b-2 ce text:', JSON.stringify(await ev(s, 'document.getElementById("ce").textContent')));
  console.log('R5b-2 events:', JSON.stringify(await ev(s, 'window.__ev')));
  await sessions.releaseSession(s);
});

test('R5b-3 insertText over a PARTIAL contenteditable selection stays inside it', async () => {
  const { sessionId: s } = await sessions.createSession();
  await handlers.navigate({ sessionId: s, url: baseUrl });
  const page = await pageOf(s);
  await ev(s, 'const e=document.getElementById("b"); document.getElementById("host").focus(); const r=document.createRange(); r.selectNodeContents(e); const sl=getSelection(); sl.removeAllRanges(); sl.addRange(r); window.__ev=[]; 1');
  await page.keyboard.insertText('ZZZ');
  console.log('R5b-3 host text:', JSON.stringify(await ev(s, 'document.getElementById("host").textContent')));
  await sessions.releaseSession(s);
});

test('R5b-4 insertText("") over an <input> selectAll', async () => {
  const { sessionId: s } = await sessions.createSession();
  await handlers.navigate({ sessionId: s, url: baseUrl });
  const page = await pageOf(s);
  await ev(s, 'const e=document.getElementById("inp"); e.focus(); e.setSelectionRange(0, e.value.length); window.__ev=[]; 1');
  await page.keyboard.insertText('');
  console.log('R5b-4 inp value:', JSON.stringify(await ev(s, 'document.getElementById("inp").value')));
  console.log('R5b-4 events:', JSON.stringify(await ev(s, 'window.__ev')));
  await sessions.releaseSession(s);
});

test('R5b-5 insertText("") over a <textarea> selectAll', async () => {
  const { sessionId: s } = await sessions.createSession();
  await handlers.navigate({ sessionId: s, url: baseUrl });
  const page = await pageOf(s);
  await ev(s, 'const e=document.getElementById("ta"); e.focus(); e.setSelectionRange(0, e.value.length); window.__ev=[]; 1');
  await page.keyboard.insertText('');
  console.log('R5b-5 ta value:', JSON.stringify(await ev(s, 'document.getElementById("ta").value')));
  console.log('R5b-5 events:', JSON.stringify(await ev(s, 'window.__ev')));
  await sessions.releaseSession(s);
});

test('R5b-6 what locator.fill dispatches, empty and non-empty, on an input', async () => {
  const { sessionId: s } = await sessions.createSession();
  await handlers.navigate({ sessionId: s, url: baseUrl });
  await ev(s, 'window.__ev=[]; 1');
  await handlers.fill({ sessionId: s, selector: '#inp', value: 'XYZ' });
  console.log('R5b-6a fill("XYZ") events:', JSON.stringify(await ev(s, 'window.__ev')));
  await ev(s, 'window.__ev=[]; 1');
  await handlers.fill({ sessionId: s, selector: '#ta', value: '' }).catch(() => undefined);
  console.log('R5b-6b fill("") events:', JSON.stringify(await ev(s, 'window.__ev')));
  console.log('R5b-6b ta value:', JSON.stringify(await ev(s, 'document.getElementById("ta").value')));
  await sessions.releaseSession(s);
});
