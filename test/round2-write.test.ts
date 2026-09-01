import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';

import { BrowserManager } from '../src/daemon/browserManager.js';
import { createToolHandlers } from '../src/daemon/tools/handlers.js';
import { SessionStore } from '../src/daemon/sessions.js';
import { getFreePort } from './helpers.js';

/**
 * Round 2 QA findings: `type` with no selector dumping the whole page when
 * nothing has focus, and `fill`/`type` overclaiming a readback they cannot
 * actually deliver against a virtualized or EditContext-driven editor.
 *
 * The rich-editor fixtures here carry the class/attribute markers a real
 * Monaco 0.45.0 and CodeMirror 6.0.1 instance were probed and confirmed to
 * carry (`.monaco-editor`/`[data-mode-id]`, `.cm-editor`/`.cm-content`), not
 * a from-scratch guess. What was probed and NOT reproduced here is the
 * virtualization itself: those probes needed real Monaco/CodeMirror loaded
 * from a CDN, which is not something a committed test should depend on, so
 * this suite exercises the detection and reporting logic against fixtures
 * carrying the same markers instead. The EditContext case needs no such
 * fixture: EditContext is a native Chromium API, so the fixture attaches a
 * real one and observes the same DOM-goes-stale behaviour the probe found.
 */
const FIXTURE_HTML = `<!doctype html>
<html>
<head></head>
<body>
  <input id="plainInput" value="">
  <textarea id="plainArea"></textarea>
  <div id="plainEditable" contenteditable="true">seed</div>
  <div class="monaco-editor"><div id="monacoLike" data-mode-id="plaintext" contenteditable="true">seed</div></div>
  <div class="cm-editor"><div id="cmLike" class="cm-content" contenteditable="true" role="textbox" aria-multiline="true">seed</div></div>
  <div id="ecHolder" contenteditable="true"></div>
</body>
</html>`;

let server: Server;
let baseUrl: string;
let browserManager: BrowserManager;
let sessions: SessionStore;
let handlers: ReturnType<typeof createToolHandlers>;

before(async () => {
  server = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(FIXTURE_HTML);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}/`;

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

/** A fresh session already sitting on the fixture page. */
async function freshSession(): Promise<string> {
  const { sessionId } = await sessions.createSession();
  await handlers.navigate({ sessionId, url: baseUrl, settleMs: 0 });
  return sessionId;
}

/** The `structuredContent` of a tool result, typed loosely: these tests assert on individual fields. */
function payload(result: unknown): Record<string, unknown> {
  return (result as { structuredContent: Record<string, unknown> }).structuredContent;
}

/** Evaluates an expression in the session's tab and returns its value, the same way interaction.test.ts does. */
async function evaluate<T>(sessionId: string, expression: string): Promise<T> {
  const result = await handlers.evaluate({ sessionId, expression });
  return payload(result).result as T;
}

// ---------------------------------------------------------------------------
// Finding A: type with no selector and nothing focused
// ---------------------------------------------------------------------------

test('type with no selector and nothing focused errors instead of dumping the page', async () => {
  const sessionId = await freshSession();

  // A fresh navigation leaves nothing focused: document.activeElement is <body>.
  const activeTag = await evaluate<string>(sessionId, 'document.activeElement.tagName');
  assert.equal(activeTag, 'BODY', 'the fixture must reproduce the unfocused starting state this bug needs');

  await assert.rejects(
    () => handlers.type({ sessionId, text: 'whatever' }),
    /no selector and nothing has focus/i,
    'the tool must refuse rather than read document.activeElement, which is <body> here'
  );

  // Nothing should have been typed anywhere on the page.
  const inputValue = await evaluate<string>(sessionId, "document.getElementById('plainInput').value");
  assert.equal(inputValue, '', 'the refusal must happen before any keystroke is sent');

  await sessions.releaseSession(sessionId);
});

test('type with no selector and clear: true and nothing focused still errors, naming the clear-specific risk too', async () => {
  const sessionId = await freshSession();

  await assert.rejects(
    () => handlers.type({ sessionId, text: 'whatever', clear: true }),
    /nothing was cleared/i
  );

  await sessions.releaseSession(sessionId);
});

test('type with no selector into a genuinely focused field still works', async () => {
  const sessionId = await freshSession();

  await evaluate(sessionId, "document.getElementById('plainArea').focus()");
  const body = payload(await handlers.type({ sessionId, text: 'focused' }));

  assert.equal(await evaluate(sessionId, "document.getElementById('plainArea').value"), 'focused');
  assert.equal(body.value, 'focused');
  assert.equal(body.matched, true);

  await sessions.releaseSession(sessionId);
});

// ---------------------------------------------------------------------------
// Finding B: rich editor readback honesty
// ---------------------------------------------------------------------------

test('fill into a plain input reports the readback as reliable', async () => {
  const sessionId = await freshSession();

  const body = payload(await handlers.fill({ sessionId, selector: '#plainInput', value: 'hello' }));

  assert.equal(body.readbackReliable, true);
  assert.equal(body.matched, true);
  assert.equal(body.value, 'hello');

  await sessions.releaseSession(sessionId);
});

test('fill into a plain contenteditable reports the readback as reliable', async () => {
  const sessionId = await freshSession();

  const body = payload(await handlers.fill({ sessionId, selector: '#plainEditable', value: 'hello' }));

  assert.equal(body.readbackReliable, true);
  assert.equal(body.matched, true);

  await sessions.releaseSession(sessionId);
});

test('fill into a Monaco-shaped target reports the readback as unreliable, and does not claim a match', async () => {
  const sessionId = await freshSession();

  const body = payload(await handlers.fill({ sessionId, selector: '#monacoLike', value: 'hello' }));

  assert.equal(body.readbackReliable, false);
  assert.equal(body.matched, undefined, 'a readback that cannot be trusted must not also claim matched: true or false');
  assert.equal(typeof body.note, 'string');
  assert.match(String(body.note), /monaco|codemirror/i);
  assert.match(String(body.note), /getModels|state\.doc\.toString|own API/i, 'the note must name the way out, not just the problem');

  await sessions.releaseSession(sessionId);
});

test('fill into a CodeMirror-shaped target reports the readback as unreliable', async () => {
  const sessionId = await freshSession();

  const body = payload(await handlers.fill({ sessionId, selector: '#cmLike', value: 'hello' }));

  assert.equal(body.readbackReliable, false);
  assert.equal(body.matched, undefined);
  assert.match(String(body.note), /monaco|codemirror/i);

  await sessions.releaseSession(sessionId);
});

test('type into a Monaco-shaped target reports the readback as unreliable too', async () => {
  const sessionId = await freshSession();

  const body = payload(await handlers.type({ sessionId, selector: '#monacoLike', text: '!' }));

  assert.equal(body.readbackReliable, false);
  assert.equal(body.matched, undefined);
  assert.equal(typeof body.note, 'string');

  await sessions.releaseSession(sessionId);
});

test('an element with a real EditContext attached reports the readback as unreliable', async () => {
  const sessionId = await freshSession();

  // A genuine EditContext, the same native Chromium API a real rich editor
  // would use, not a simulation of one. Attaching it is enough on its own to
  // make textContent stop being the source of truth: the probe behind this
  // fix found textContent stays whatever it was, empty here, while the
  // EditContext's own .text holds the real value throughout.
  await evaluate(
    sessionId,
    "(() => { const el = document.getElementById('ecHolder'); el.editContext = new EditContext({ text: 'seed' }); return true; })()"
  );

  const domTextBefore = await evaluate<string>(sessionId, "document.getElementById('ecHolder').textContent");
  assert.equal(domTextBefore, '', 'confirms the fixture reproduces the real trap: the DOM does not reflect the EditContext at all');

  const body = payload(await handlers.fill({ sessionId, selector: '#ecHolder', value: 'hello' }));

  assert.equal(body.readbackReliable, false);
  assert.equal(body.matched, undefined);
  assert.match(String(body.note), /editcontext/i);

  await sessions.releaseSession(sessionId);
});
