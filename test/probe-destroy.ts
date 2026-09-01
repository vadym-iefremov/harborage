import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';

import { BrowserManager } from '../src/daemon/browserManager.js';
import { createToolHandlers } from '../src/daemon/tools/handlers.js';
import { SessionStore } from '../src/daemon/sessions.js';
import { getFreePort } from './helpers.js';

/**
 * Adversarial round 4: can a write still destroy more than the caller named?
 *
 * Every oracle here is read from the page, never from the tool's report.
 */

const PAGES: Record<string, string> = {
  // A contenteditable region wrapping a focusable widget. This is the shape
  // the brief names: an element whose own contenteditable is absent but whose
  // ANCESTOR is an editing host, so isContentEditable reports true on it.
  '/ce-canvas': `<!doctype html><html><body>
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
</body></html>`,

  // Same idea without the canvas: a plain div inside an editing host.
  '/ce-inner': `<!doctype html><html><body>
<div id="ceRoot" contenteditable="true">
  <div id="ceInner">TARGET LINE</div>
  <p id="sibling">SIBLING CONTENT THAT MUST SURVIVE</p>
  <p id="sibling2">MORE SIBLING CONTENT</p>
</div>
<div id="outside">outside the editing host</div>
</body></html>`,

  // designMode: the whole document becomes an editing host.
  '/designmode': `<!doctype html><html><body>
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
  document.designMode = 'on';
</script>
</body></html>`,

  // A contenteditable BODY: the whole page is one editing host.
  '/ce-body': `<!doctype html><html><body contenteditable="true">
<h1 id="h">PAGE TITLE</h1>
<p id="doc">IMPORTANT USER CONTENT THAT MUST SURVIVE</p>
</body></html>`,

  // A global keyboard-shortcut handler that moves focus. The guard runs
  // several page round trips before the keystrokes are sent; this fires on
  // the first one of them.
  '/focus-steal': `<!doctype html><html><body>
<input id="field" value="seed">
<div id="canvas">
  <div class="node" tabindex="0" data-id="n1">Node one</div>
  <div class="node" tabindex="0" data-id="n2">Node two</div>
  <div class="node" tabindex="0" data-id="n3">Node three</div>
</div>
<script>
  document.getElementById('canvas').addEventListener('keydown', function (e) {
    if (e.key !== 'Delete' && e.key !== 'Backspace') return;
    var f = document.activeElement;
    if (f && f.classList && f.classList.contains('node')) f.remove();
  });
  // An ordinary global shortcut handler: on the accelerator chord it focuses
  // the canvas selection. Runs on keydown, i.e. after the tool's guard.
  window.addEventListener('keydown', function (e) {
    if (e.key === 'a' && (e.metaKey || e.ctrlKey)) {
      document.querySelector('[data-id="n2"]').focus();
    }
  }, true);
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
    const body = PAGES[(req.url ?? '/').split('?')[0]];
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(body ?? '<!doctype html><html><body>none</body></html>');
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
  const result = await handlers.evaluate({ sessionId, expression });
  return payload(result).result as T;
}

async function rejection(call: () => Promise<unknown>): Promise<string | null> {
  try {
    await call();
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

// ---------------------------------------------------------------------------

test('D1: focused canvas node inside a contenteditable region, type clear no selector', async () => {
  const sessionId = await freshSession('/ce-canvas');
  await handlers.click({ sessionId, selector: '[data-id="n2"]' });

  const active = await evaluate<Record<string, unknown>>(
    sessionId,
    '({tag: document.activeElement.tagName, id: document.activeElement.dataset ? document.activeElement.dataset.id : null, ce: document.activeElement.isContentEditable})'
  );
  console.log('D1 activeElement after click:', JSON.stringify(active));

  const before = await evaluate<Record<string, unknown>>(
    sessionId,
    "({nodes: document.querySelectorAll('#canvas .node').length, doc: (document.getElementById('doc')||{}).textContent || null, pageLen: document.getElementById('page').textContent.length})"
  );
  console.log('D1 before:', JSON.stringify(before));

  const msg = await rejection(() => handlers.type({ sessionId, text: 'PWNED', clear: true }));
  console.log('D1 refusal:', msg === null ? '(no refusal, the call went through)' : msg.slice(0, 400));

  const afterState = await evaluate<Record<string, unknown>>(
    sessionId,
    "({nodes: document.querySelectorAll('#canvas .node').length, doc: (document.getElementById('doc')||{}).textContent || null, pageLen: document.getElementById('page').textContent.length})"
  );
  console.log('D1 after:', JSON.stringify(afterState));

  await sessions.releaseSession(sessionId);
});

test('D2: fill aimed at a plain div inside an editing host', async () => {
  const sessionId = await freshSession('/ce-inner');

  const before = await evaluate<Record<string, unknown>>(
    sessionId,
    "({root: document.getElementById('ceRoot').textContent.replace(/\\s+/g,' ').trim(), sib: (document.getElementById('sibling')||{}).textContent || null})"
  );
  console.log('D2 before:', JSON.stringify(before));

  const msg = await rejection(() => handlers.fill({ sessionId, selector: '#ceInner', value: 'REPLACED' }));
  console.log('D2 fill result:', msg === null ? '(no refusal)' : msg.slice(0, 400));

  const afterState = await evaluate<Record<string, unknown>>(
    sessionId,
    "({root: document.getElementById('ceRoot').textContent.replace(/\\s+/g,' ').trim(), sib: (document.getElementById('sibling')||{}).textContent || null, inner: (document.getElementById('ceInner')||{}).textContent ?? null})"
  );
  console.log('D2 after:', JSON.stringify(afterState));

  await sessions.releaseSession(sessionId);
});

test('D2b: type with selector + clear aimed at a plain div inside an editing host', async () => {
  const sessionId = await freshSession('/ce-inner');
  const before = await evaluate<string>(
    sessionId,
    "document.getElementById('ceRoot').textContent.replace(/\\s+/g,' ').trim()"
  );
  const msg = await rejection(() => handlers.type({ sessionId, selector: '#ceInner', text: 'X', clear: true }));
  console.log('D2b result:', msg === null ? '(no refusal)' : msg.slice(0, 300));
  const afterState = await evaluate<string>(
    sessionId,
    "document.getElementById('ceRoot').textContent.replace(/\\s+/g,' ').trim()"
  );
  console.log('D2b root before:', JSON.stringify(before));
  console.log('D2b root after :', JSON.stringify(afterState));
  await sessions.releaseSession(sessionId);
});

test('D3: designMode on, focused canvas node, type clear no selector', async () => {
  const sessionId = await freshSession('/designmode');
  await handlers.click({ sessionId, selector: '[data-id="n2"]' });
  const active = await evaluate<Record<string, unknown>>(
    sessionId,
    '({tag: document.activeElement.tagName, ce: document.activeElement.isContentEditable})'
  );
  console.log('D3 activeElement:', JSON.stringify(active));
  const before = await evaluate<Record<string, unknown>>(
    sessionId,
    "({nodes: document.querySelectorAll('#canvas .node').length, bodyLen: document.body.textContent.replace(/\\s+/g,' ').trim().length})"
  );
  const msg = await rejection(() => handlers.type({ sessionId, text: 'PWNED', clear: true }));
  console.log('D3 refusal:', msg === null ? '(no refusal, the call went through)' : msg.slice(0, 300));
  const afterState = await evaluate<Record<string, unknown>>(
    sessionId,
    "({nodes: document.querySelectorAll('#canvas .node').length, bodyLen: document.body.textContent.replace(/\\s+/g,' ').trim().length})"
  );
  console.log('D3 before:', JSON.stringify(before), 'after:', JSON.stringify(afterState));
  await sessions.releaseSession(sessionId);
});

test('D3b: designMode on, fill aimed at a canvas node', async () => {
  const sessionId = await freshSession('/designmode');
  const before = await evaluate<Record<string, unknown>>(
    sessionId,
    "({nodes: document.querySelectorAll('#canvas .node').length, bodyLen: document.body.textContent.replace(/\\s+/g,' ').trim().length})"
  );
  const msg = await rejection(() => handlers.fill({ sessionId, selector: '[data-id=\"n2\"]', value: 'REPLACED' }));
  console.log('D3b fill:', msg === null ? '(no refusal)' : msg.slice(0, 300));
  const afterState = await evaluate<Record<string, unknown>>(
    sessionId,
    "({nodes: document.querySelectorAll('#canvas .node').length, bodyLen: document.body.textContent.replace(/\\s+/g,' ').trim().length, n2: (document.querySelector('[data-id=\"n2\"]')||{}).textContent ?? null})"
  );
  console.log('D3b before:', JSON.stringify(before), 'after:', JSON.stringify(afterState));
  await sessions.releaseSession(sessionId);
});

test('D4: contenteditable body, fill and type with selector body', async () => {
  const sessionId = await freshSession('/ce-body');
  const before = await evaluate<string>(sessionId, "document.body.textContent.replace(/\\s+/g,' ').trim()");
  const msg = await rejection(() => handlers.fill({ sessionId, selector: 'body', value: 'WIPED' }));
  console.log('D4 fill(body):', msg === null ? '(no refusal)' : msg.slice(0, 300));
  const afterState = await evaluate<string>(sessionId, "document.body.textContent.replace(/\\s+/g,' ').trim()");
  console.log('D4 before:', JSON.stringify(before), 'after:', JSON.stringify(afterState));

  const sessionId2 = await freshSession('/ce-body');
  const msg2 = await rejection(() => handlers.type({ sessionId: sessionId2, selector: 'body', text: 'X', clear: true }));
  console.log('D4b type(body, clear):', msg2 === null ? '(no refusal)' : msg2.slice(0, 300));
  const after2 = await evaluate<string>(sessionId2, "document.body.textContent.replace(/\\s+/g,' ').trim()");
  console.log('D4b body after:', JSON.stringify(after2));

  await sessions.releaseSession(sessionId);
  await sessions.releaseSession(sessionId2);
});

test('D5: focus moves on the select-all keydown, between the guard and the Delete', async () => {
  const sessionId = await freshSession('/focus-steal');
  await handlers.click({ sessionId, selector: '#field' });
  const before = await evaluate<number>(sessionId, "document.querySelectorAll('#canvas .node').length");

  let report: unknown = null;
  const msg = await rejection(async () => {
    report = payload(await handlers.type({ sessionId, text: 'hello', clear: true }));
  });
  console.log('D5 refusal:', msg === null ? '(no refusal)' : msg.slice(0, 300));
  console.log('D5 report:', JSON.stringify(report));

  const afterState = await evaluate<Record<string, unknown>>(
    sessionId,
    "({nodes: document.querySelectorAll('#canvas .node').length, field: document.getElementById('field').value, active: document.activeElement.tagName})"
  );
  console.log('D5 nodes before:', before, 'after:', JSON.stringify(afterState));
  await sessions.releaseSession(sessionId);
});
