import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { BrowserManager } from '../src/daemon/browserManager.js';
import { SessionNotFoundError, SessionStore } from '../src/daemon/sessions.js';
import { getFreePort } from './helpers.js';

let browserManager: BrowserManager;
let sessions: SessionStore;

before(async () => {
  browserManager = new BrowserManager(await getFreePort());
  sessions = new SessionStore(browserManager);
});

after(async () => {
  await sessions.closeAll();
  await browserManager.close();
});

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

test('a session idle past the threshold gets reaped', async () => {
  const { sessionId } = await sessions.createSession();
  assert.ok(sessions.listSessionIds().includes(sessionId));

  // Idle threshold shorter than the wait below — this session has done
  // nothing since creation, so it must be past the threshold already.
  await sleep(60);
  const reaped = await sessions.reapIdle(30);

  assert.deepEqual(reaped, [sessionId]);
  assert.ok(!sessions.listSessionIds().includes(sessionId));
  assert.throws(() => sessions.resolve(sessionId), SessionNotFoundError);
});

test('activity resets the idle clock — an active session is not reaped', async () => {
  const { sessionId } = await sessions.createSession();

  await sleep(60);
  // Touch the session (resolve() updates lastActivity) right before checking idleness.
  sessions.resolve(sessionId);
  const reaped = await sessions.reapIdle(30);

  assert.deepEqual(reaped, []);
  assert.ok(sessions.listSessionIds().includes(sessionId));

  await sessions.releaseSession(sessionId);
});

test('reapIdle only reaps sessions past the threshold, leaving fresher ones alone', async () => {
  const { sessionId: staleId } = await sessions.createSession();
  await sleep(80);
  const { sessionId: freshId } = await sessions.createSession();

  const reaped = await sessions.reapIdle(40);

  assert.deepEqual(reaped, [staleId]);
  assert.ok(sessions.listSessionIds().includes(freshId));
  assert.ok(!sessions.listSessionIds().includes(staleId));

  await sessions.releaseSession(freshId);
});
