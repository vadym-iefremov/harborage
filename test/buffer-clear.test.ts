import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';

import { BrowserManager } from '../src/daemon/browserManager.js';
import { SessionStore, type ConsoleEntry } from '../src/daemon/sessions.js';
import { createToolHandlers, type ToolHandlers } from '../src/daemon/tools/handlers.js';
import { getFreePort } from './helpers.js';

let browserManager: BrowserManager;
let sessions: SessionStore;
let handlers: ToolHandlers;
let server: Server;
let base: string;

before(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

  browserManager = new BrowserManager(await getFreePort());
  sessions = new SessionStore(browserManager);
  handlers = createToolHandlers(sessions, {
    debugPort: 0,
    screenshotCacheDir: '/dev/null/unused',
    screenshotCacheTtlMs: 1000
  });
});

after(async () => {
  await sessions.closeAll();
  await browserManager.close();
  await new Promise<void>(resolve => server.close(() => resolve()));
});

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function logInto(sessionId: string, pageId: string | undefined, ...texts: string[]): Promise<void> {
  for (const t of texts) {
    await handlers.evaluate({ sessionId, pageId, expression: `console.log(${JSON.stringify(t)}), "ok"` });
  }
  await sleep(150);
}

test('a filtered read with clear removes only the entries it returned', async () => {
  const created = await handlers.create_session({});
  const { sessionId } = created.structuredContent as { sessionId: string };
  await logInto(sessionId, undefined, 'keep me', 'drain me', 'keep me too');

  // The filter a tool would apply. Before this, `clear` dropped everything
  // for the tab regardless of the filter, so "keep me" and "keep me too"
  // vanished without the caller ever seeing them.
  const drained = sessions.getConsoleMessages(sessionId, undefined, true, (e: ConsoleEntry) =>
    e.text.includes('drain me')
  );
  assert.deepEqual(drained.map(e => e.text), ['drain me']);

  const left = sessions.getConsoleMessages(sessionId);
  assert.deepEqual(
    left.map(e => e.text),
    ['keep me', 'keep me too'],
    'entries the filter did not match must survive a filtered clear'
  );

  await handlers.release_session({ sessionId });
});

test('clearing one tab leaves another tab\'s buffer intact', async () => {
  const created = await handlers.create_session({});
  const { sessionId, pageId: first } = created.structuredContent as { sessionId: string; pageId: string };
  const second = ((await handlers.new_tab({ sessionId })).structuredContent as { pageId: string }).pageId;

  await logInto(sessionId, first, 'first tab message');
  await logInto(sessionId, second, 'second tab message');

  await handlers.read_console({ sessionId, pageId: first, clear: true });

  const firstLeft = sessions.getConsoleMessages(sessionId, first);
  const secondLeft = sessions.getConsoleMessages(sessionId, second);
  assert.deepEqual(firstLeft, []);
  assert.deepEqual(secondLeft.map(e => e.text), ['second tab message']);

  await handlers.release_session({ sessionId });
});

test('the same guarantee holds for network, dialog and page-error buffers', async () => {
  const created = await handlers.create_session({});
  const { sessionId } = created.structuredContent as { sessionId: string };

  // A real origin: `data:` URLs raise no network events at all.
  await handlers.navigate({ sessionId, url: `${base}/start` });
  await handlers.evaluate({
    sessionId,
    expression: `fetch("${base}/one").catch(() => {}), fetch("${base}/two").catch(() => {}), "ok"`
  });
  await handlers.evaluate({ sessionId, expression: 'alert("dialog one"), "ok"' });
  await handlers.evaluate({ sessionId, expression: 'alert("dialog two"), "ok"' });
  await handlers.evaluate({ sessionId, expression: 'Promise.reject(new Error("error one")), "ok"' });
  await handlers.evaluate({ sessionId, expression: 'Promise.reject(new Error("error two")), "ok"' });
  await sleep(400);

  const drainedDialogs = sessions.getDialogs(sessionId, undefined, true, e => e.message === 'dialog one');
  assert.deepEqual(drainedDialogs.map(d => d.message), ['dialog one']);
  assert.deepEqual(sessions.getDialogs(sessionId).map(d => d.message), ['dialog two']);

  const drainedErrors = sessions.getPageErrors(sessionId, undefined, true, e => e.message === 'error one');
  assert.deepEqual(drainedErrors.map(e => e.message), ['error one']);
  assert.deepEqual(sessions.getPageErrors(sessionId).map(e => e.message), ['error two']);

  const before = sessions.getNetworkEntries(sessionId).length;
  assert.ok(before > 0, 'expected some buffered network activity to filter');
  const drainedNetwork = sessions.getNetworkEntries(sessionId, undefined, true, e => e.url.includes('one'));
  assert.ok(drainedNetwork.length > 0);
  const remaining = sessions.getNetworkEntries(sessionId);
  assert.equal(
    remaining.length,
    before - drainedNetwork.length,
    'a filtered network clear must remove exactly what it returned, no more'
  );
  assert.ok(!remaining.some(e => e.url.includes('one')));

  await handlers.release_session({ sessionId });
});
