import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';

import { BrowserManager } from '../src/daemon/browserManager.js';
import { SessionStore, type DialogEntry } from '../src/daemon/sessions.js';
import { createToolHandlers, type ToolHandlers } from '../src/daemon/tools/handlers.js';
import { getFreePort } from './helpers.js';

let browserManager: BrowserManager;
let sessions: SessionStore;
let handlers: ToolHandlers;
let server: Server;
let base: string;

/**
 * Buttons rather than bare evaluate() calls, because a click is how an agent
 * actually trips over a dialog, and a click is what used to wedge.
 */
const PAGE =
  '<html><body>' +
  '<button id="alert" onclick="window.result = String(alert(\'an alert\'))">alert</button>' +
  '<button id="confirm" onclick="window.result = String(confirm(\'really?\'))">confirm</button>' +
  '<button id="prompt" onclick="window.result = String(prompt(\'your name?\', \'default name\'))">prompt</button>' +
  '</body></html>';

before(async () => {
  browserManager = new BrowserManager(await getFreePort());
  sessions = new SessionStore(browserManager);
  handlers = createToolHandlers(sessions, {
    debugPort: 0,
    screenshotCacheDir: '/dev/null/unused',
    screenshotCacheTtlMs: 1000
  });
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/`;
});

after(async () => {
  await sessions.closeAll();
  await browserManager.close();
  await new Promise<void>(resolve => server.close(() => resolve()));
});

async function openSession(): Promise<string> {
  const created = await handlers.create_session({});
  const { sessionId } = created.structuredContent as { sessionId: string };
  await handlers.navigate({ sessionId, url: base });
  return sessionId;
}

/** What the page itself saw the dialog return. */
async function pageResult(sessionId: string, pageId?: string): Promise<string> {
  const result = await handlers.evaluate({ sessionId, pageId, expression: 'String(window.result)' });
  return (result.structuredContent as { result: string }).result;
}

async function dialogsOf(sessionId: string, args: Record<string, unknown> = {}): Promise<DialogEntry[]> {
  const read = await handlers.handle_dialog({ sessionId, ...args });
  return (read.structuredContent as { dialogs: DialogEntry[] }).dialogs;
}

/** Fails loudly rather than hanging the whole suite if a dialog ever wedges a tab. */
function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${what} did not finish within ${ms}ms: a dialog wedged the tab`)), ms)
    )
  ]);
}

test('with no policy armed a dialog is auto-dismissed, never hangs the tab, and is recorded', async () => {
  const sessionId = await openSession();

  await within(handlers.click({ sessionId, selector: '#confirm' }), 8000, 'click that triggers confirm()');
  assert.equal(await pageResult(sessionId), 'false', 'an unhandled confirm should read as dismissed');

  await within(handlers.click({ sessionId, selector: '#prompt' }), 8000, 'click that triggers prompt()');
  assert.equal(await pageResult(sessionId), 'null', 'an unhandled prompt should read as dismissed');

  const dialogs = await dialogsOf(sessionId);
  assert.equal(dialogs.length, 2, `expected both dialogs recorded, got ${JSON.stringify(dialogs)}`);
  assert.equal(dialogs[0]?.type, 'confirm');
  assert.equal(dialogs[0]?.message, 'really?');
  assert.equal(dialogs[0]?.action, 'dismiss');
  assert.equal(dialogs[1]?.type, 'prompt');
  assert.equal(dialogs[1]?.defaultValue, 'default name');

  await handlers.release_session({ sessionId });
});

test('arming accept makes the next dialog accept, and only the next one', async () => {
  const sessionId = await openSession();

  await handlers.handle_dialog({ sessionId, action: 'accept' });
  await within(handlers.click({ sessionId, selector: '#confirm' }), 8000, 'accepted confirm');
  assert.equal(await pageResult(sessionId), 'true', 'the armed accept should reach the page');

  // The arming was for one dialog only, so this one falls back to dismiss.
  await within(handlers.click({ sessionId, selector: '#confirm' }), 8000, 'second confirm');
  assert.equal(await pageResult(sessionId), 'false', 'appliesTo "next" must not linger');

  const dialogs = await dialogsOf(sessionId);
  assert.deepEqual(dialogs.map(d => d.action), ['accept', 'dismiss']);

  await handlers.release_session({ sessionId });
});

test('accept with promptText answers a prompt, and appliesTo "all" keeps answering', async () => {
  const sessionId = await openSession();

  await handlers.handle_dialog({ sessionId, action: 'accept', promptText: 'Ada', appliesTo: 'all' });

  await within(handlers.click({ sessionId, selector: '#prompt' }), 8000, 'first prompt');
  assert.equal(await pageResult(sessionId), 'Ada');

  await within(handlers.click({ sessionId, selector: '#prompt' }), 8000, 'second prompt');
  assert.equal(await pageResult(sessionId), 'Ada', 'appliesTo "all" should survive the first dialog');

  // Restoring the default is arming dismiss for everything.
  await handlers.handle_dialog({ sessionId, action: 'dismiss', appliesTo: 'all' });
  await within(handlers.click({ sessionId, selector: '#prompt' }), 8000, 'third prompt');
  assert.equal(await pageResult(sessionId), 'null');

  await handlers.release_session({ sessionId });
});

test('dialogs in a tab opened by new_tab are handled and recorded too', async () => {
  const sessionId = await openSession();
  const opened = await handlers.new_tab({ sessionId, url: base });
  const { pageId } = opened.structuredContent as { pageId: string };

  await within(handlers.click({ sessionId, pageId, selector: '#alert' }), 8000, 'alert in a new tab');
  assert.equal(await pageResult(sessionId, pageId), 'undefined');

  const forTab = await dialogsOf(sessionId, { pageId });
  assert.equal(forTab.length, 1);
  assert.equal(forTab[0]?.type, 'alert');
  assert.equal(forTab[0]?.pageId, pageId);

  await handlers.release_session({ sessionId });
});

test('clear drains the dialog log, and reading without clear leaves it alone', async () => {
  const sessionId = await openSession();
  await within(handlers.click({ sessionId, selector: '#alert' }), 8000, 'alert');

  assert.equal((await dialogsOf(sessionId)).length, 1);
  assert.equal((await dialogsOf(sessionId)).length, 1, 'a plain read must not consume the log');
  assert.equal((await dialogsOf(sessionId, { clear: true })).length, 1);
  assert.equal((await dialogsOf(sessionId)).length, 0, 'clear should have drained it');

  await handlers.release_session({ sessionId });
});
