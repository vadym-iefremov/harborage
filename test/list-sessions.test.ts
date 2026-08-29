import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { BrowserManager } from '../src/daemon/browserManager.js';
import { createToolHandlers } from '../src/daemon/tools/handlers.js';
import { SessionStore } from '../src/daemon/sessions.js';
import { getFreePort } from './helpers.js';

let browserManager: BrowserManager;
let sessions: SessionStore;
let handlers: ReturnType<typeof createToolHandlers>;

before(async () => {
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
});

test('list_sessions surfaces every active session, not scoped to a caller-known id', async () => {
  const { sessionId: idA } = await sessions.createSession();
  const { sessionId: idB } = await sessions.createSession();

  await sessions.resolve(idA).page.goto('data:text/html,<h1>session A</h1>');

  const result = await handlers.list_sessions();
  const payload = (result as { structuredContent: { sessions: { sessionId: string; createdAt: number; lastActivity: number; url: string | undefined; tabCount: number }[] } })
    .structuredContent;

  const listed = payload.sessions;
  const entryA = listed.find(s => s.sessionId === idA);
  const entryB = listed.find(s => s.sessionId === idB);

  assert.ok(entryA, 'expected session A to be discoverable via list_sessions without being told its id first');
  assert.ok(entryB, 'expected session B to be discoverable via list_sessions too');
  assert.ok(entryA!.url?.startsWith('data:text/html'), 'expected session A\'s current URL to reflect its navigation');
  assert.equal(entryB!.url, 'about:blank', 'expected session B (never navigated) to report about:blank');
  assert.ok(typeof entryA!.createdAt === 'number' && entryA!.createdAt > 0);
  assert.ok(typeof entryA!.lastActivity === 'number' && entryA!.lastActivity > 0);
  assert.equal(entryA!.tabCount, 1);

  await sessions.releaseSession(idA);
  await sessions.releaseSession(idB);
});

test('list_sessions does not itself count as activity on the sessions it lists', async () => {
  const { sessionId } = await sessions.createSession();
  const lastActivityBefore = sessions.getLastActivity(sessionId);

  await new Promise(resolve => setTimeout(resolve, 20));
  await handlers.list_sessions();

  const lastActivityAfter = sessions.getLastActivity(sessionId);
  assert.equal(lastActivityAfter, lastActivityBefore, 'expected list_sessions to leave lastActivity untouched, matching reapIdle\'s own precedent');

  await sessions.releaseSession(sessionId);
});

test('a released session no longer appears in list_sessions', async () => {
  const { sessionId } = await sessions.createSession();
  await sessions.releaseSession(sessionId);

  const result = await handlers.list_sessions();
  const payload = (result as { structuredContent: { sessions: { sessionId: string }[] } }).structuredContent;
  assert.ok(!payload.sessions.some(s => s.sessionId === sessionId));
});
