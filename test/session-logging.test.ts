import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { BrowserManager } from '../src/daemon/browserManager.js';
import { SessionStore } from '../src/daemon/sessions.js';
import { createLogger } from '../src/shared/logger.js';
import { getFreePort } from './helpers.js';

let browserManager: BrowserManager;
let sessions: SessionStore;
const lines: string[] = [];

const isoAtStart = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /;

before(async () => {
  browserManager = new BrowserManager(await getFreePort());
  sessions = new SessionStore(browserManager, {}, createLogger(line => lines.push(line)));
});

after(async () => {
  await sessions.closeAll();
  await browserManager.close();
});

function linesFor(event: string): string[] {
  return lines.filter(l => l.includes(`[harborage] ${event} `));
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

test('count() reports how many sessions are live, and inspecting it is not activity', async () => {
  assert.equal(sessions.count(), 0);

  const { sessionId } = await sessions.createSession();
  assert.equal(sessions.count(), 1);

  const { sessionId: second } = await sessions.createSession();
  assert.equal(sessions.count(), 2);

  // Reading the count must not refresh the idle clock, the same rule
  // reapIdle and listSessions already follow: looking is not working.
  await sleep(30);
  const before = sessions.getLastActivity(sessionId);
  sessions.count();
  assert.equal(sessions.getLastActivity(sessionId), before);

  await sessions.releaseSession(second);
  assert.equal(sessions.count(), 1);

  await sessions.releaseSession(sessionId);
  assert.equal(sessions.count(), 0);
});

test('creating and releasing a session each log one line, with the sessionId and the remaining count', async () => {
  lines.length = 0;

  const { sessionId } = await sessions.createSession();
  const created = linesFor('session.create');
  assert.equal(created.length, 1);
  assert.ok(isoAtStart.test(created[0]!), `expected an ISO timestamp: ${created[0]}`);
  assert.ok(created[0]!.includes(`sessionId=${sessionId}`), created[0]);
  assert.ok(created[0]!.includes('sessions=1'), `expected the new live count in: ${created[0]}`);

  await sessions.releaseSession(sessionId);
  const released = linesFor('session.release');
  assert.equal(released.length, 1);
  assert.ok(released[0]!.includes(`sessionId=${sessionId}`), released[0]);
  assert.ok(released[0]!.includes('sessions=0'), `expected the remaining live count in: ${released[0]}`);
});

test('a reaped session logs session.reap with its id and the remaining count', async () => {
  lines.length = 0;

  const { sessionId } = await sessions.createSession();
  const { sessionId: survivor } = await sessions.createSession();
  await sleep(60);
  // Keep the survivor fresh so exactly one session is past the threshold.
  sessions.resolve(survivor);

  const reaped = await sessions.reapIdle(40);
  assert.deepEqual(reaped, [sessionId]);

  const reapLines = linesFor('session.reap');
  assert.equal(reapLines.length, 1);
  assert.ok(reapLines[0]!.includes(`sessionId=${sessionId}`), reapLines[0]);
  assert.ok(reapLines[0]!.includes('sessions=1'), `expected the remaining live count in: ${reapLines[0]}`);

  await sessions.releaseSession(survivor);
});
