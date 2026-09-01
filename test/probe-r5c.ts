import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';

import { BrowserManager } from '../src/daemon/browserManager.js';
import { createToolHandlers } from '../src/daemon/tools/handlers.js';
import { SessionStore } from '../src/daemon/sessions.js';
import { getFreePort } from './helpers.js';

const LOG = `
  window.__ev = [];
  ['keydown','keyup','beforeinput','input','change'].forEach(function (t) {
    window.addEventListener(t, function (e) {
      window.__ev.push(t + (e.inputType ? ':' + e.inputType : '') + (e.key ? ':' + e.key : '') + '@' + (e.target.id || e.target.tagName));
    }, true);
  });
`;

const PAGE = `<!doctype html><html><body>
<input id="text" value="ORIGINAL">
<input id="num" type="number" value="12345">
<input id="email" type="email" value="a@b.co">
<input id="date" type="date" value="2020-01-02">
<textarea id="ta">ORIGINAL</textarea>
<div id="ce" contenteditable="true">ORIGINAL</div>
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
interface ProbePage {
  keyboard: { insertText(text: string): Promise<void> };
  locator(selector: string): { selectText(): Promise<void>; fill(value: string): Promise<void>; focus(): Promise<void> };
}
function pageOf(sessionId: string): ProbePage {
  return sessions.resolve(sessionId).page as unknown as ProbePage;
}
async function open(): Promise<string> {
  const { sessionId } = await sessions.createSession();
  await handlers.navigate({ sessionId, url: baseUrl });
  return sessionId;
}

const IDS = ['text', 'num', 'email', 'date', 'ta', 'ce'];

test('R5c-1 select() then insertText("") on every control type', async () => {
  const s = await open();
  const page = pageOf(s);
  for (const id of IDS) {
    await ev(
      s,
      `const e=document.getElementById(${JSON.stringify(id)});
       e.focus();
       if (typeof e.select === 'function') { e.select(); }
       else { const r=document.createRange(); r.selectNodeContents(e); const sl=getSelection(); sl.removeAllRanges(); sl.addRange(r); }
       window.__ev=[]; 1`
    );
    await page.keyboard.insertText('');
    const after = await ev<string>(
      s,
      `const e=document.getElementById(${JSON.stringify(id)}); e.value !== undefined ? e.value : e.textContent`
    );
    console.log(`R5c-1 ${id}: value=${JSON.stringify(after)} events=${JSON.stringify(await ev(s, 'window.__ev'))}`);
  }
  await sessions.releaseSession(s);
});

test('R5c-2 locator.selectText: what it dispatches and whether it selects', async () => {
  const s = await open();
  const page = pageOf(s);
  for (const id of IDS) {
    await ev(s, 'window.__ev=[]; 1');
    let outcome = 'ok';
    try {
      await page.locator('#' + id).selectText();
    } catch (err) {
      outcome = 'THREW ' + (err instanceof Error ? err.message.split('\n')[0] : String(err));
    }
    const state = await ev<unknown>(
      s,
      `const e=document.getElementById(${JSON.stringify(id)});
       let sel = null;
       try { sel = e.selectionStart + '..' + e.selectionEnd; } catch (x) { sel = 'unreadable'; }
       ({ sel, domSel: String(getSelection()), active: document.activeElement.id })`
    );
    console.log(`R5c-2 ${id}: ${outcome} state=${JSON.stringify(state)} events=${JSON.stringify(await ev(s, 'window.__ev'))}`);
  }
  await sessions.releaseSession(s);
});

test('R5c-3 selectText then insertText("") clears without a key', async () => {
  const s = await open();
  const page = pageOf(s);
  for (const id of IDS) {
    let outcome = 'ok';
    try {
      await page.locator('#' + id).selectText();
    } catch (err) {
      outcome = 'selectText THREW ' + (err instanceof Error ? err.message.split('\n')[0] : String(err));
    }
    await ev(s, 'window.__ev=[]; 1');
    await page.keyboard.insertText('');
    const after = await ev<string>(
      s,
      `const e=document.getElementById(${JSON.stringify(id)}); e.value !== undefined ? e.value : e.textContent`
    );
    console.log(`R5c-3 ${id}: ${outcome} value=${JSON.stringify(after)} events=${JSON.stringify(await ev(s, 'window.__ev'))}`);
  }
  await sessions.releaseSession(s);
});

test('R5c-4 what harborage fill does today on each control type, empty value', async () => {
  const s = await open();
  for (const id of ['num', 'email', 'date']) {
    await ev(s, 'window.__ev=[]; 1');
    let outcome = 'ok';
    try {
      await handlers.fill({ sessionId: s, selector: '#' + id, value: '' });
    } catch (err) {
      outcome = 'THREW ' + (err instanceof Error ? err.message.split('\n')[0].slice(0, 160) : String(err));
    }
    console.log(`R5c-4 ${id}: ${outcome} events=${JSON.stringify(await ev(s, 'window.__ev'))}`);
  }
  await sessions.releaseSession(s);
});
