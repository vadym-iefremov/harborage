import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { BrowserManager } from '../src/daemon/browserManager.js';
import {
  DEFAULT_ESCALATED_IDLE_TIMEOUT_MS,
  resolveEscalatedIdleTimeoutMs,
  SessionStore,
  type SessionSummary
} from '../src/daemon/sessions.js';
import { createToolHandlers, type ToolHandlers } from '../src/daemon/tools/handlers.js';
import { getFreePort } from './helpers.js';

/** Short enough for a test to watch a forgotten escalation actually expire. */
const escalatedIdleTimeoutMs = 500;

let browserManager: BrowserManager;
let sessions: SessionStore;
let handlers: ToolHandlers;

before(async () => {
  const debugPort = await getFreePort();
  browserManager = new BrowserManager(debugPort);
  sessions = new SessionStore(browserManager, {}, undefined, escalatedIdleTimeoutMs);
  handlers = createToolHandlers(sessions, {
    debugPort,
    screenshotCacheDir: '/dev/null/unused',
    screenshotCacheTtlMs: 1000
  });
});

after(async () => {
  await sessions.closeAll();
  await browserManager.close();
});

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function rowFor(listed: { sessions: SessionSummary[] }, sessionId: string): SessionSummary {
  const row = listed.sessions.find(s => s.sessionId === sessionId);
  assert.ok(row, `expected ${sessionId} in list_sessions output`);
  return row;
}

test('escalate_session marks the session, and list_sessions shows the escalation', async () => {
  const { sessionId } = await sessions.createSession();

  const escalated = await handlers.escalate_session({ sessionId, reason: 'stuck on CAPTCHA' });
  assert.match(
    JSON.stringify(escalated.structuredContent),
    /ws:\/\//,
    'escalate_session should still return a CDP WebSocket URL a human can attach to'
  );

  const listed = (await handlers.list_sessions()).structuredContent as { sessions: SessionSummary[] };
  const row = rowFor(listed, sessionId);
  assert.equal(row.escalated, true, 'an escalation a human might have forgotten must be visible in list_sessions');
  assert.equal(typeof row.escalatedAt, 'number');

  await sessions.releaseSession(sessionId);
});

test('an escalated session outlives the ordinary idle timeout while a human works in it', async () => {
  const handedOver = await sessions.createSession();
  const ordinary = await sessions.createSession();

  await handlers.escalate_session({ sessionId: handedOver.sessionId, reason: 'ambiguous form' });

  // Well past the ordinary timeout, nowhere near the escalated one. A human
  // driving over CDP touches no tool, so nothing here refreshes lastActivity.
  await sleep(150);
  const reaped = await sessions.reapIdle(50);

  assert.deepEqual(reaped, [ordinary.sessionId], 'only the un-escalated session should be reaped');
  assert.ok(sessions.listSessionIds().includes(handedOver.sessionId));

  // Past the escalated timeout too: an escalation that is never released
  // still has to give the browser context back eventually.
  await sleep(escalatedIdleTimeoutMs + 150);
  const reapedLater = await sessions.reapIdle(50);
  assert.deepEqual(
    reapedLater,
    [handedOver.sessionId],
    'a forgotten escalation must not hold a browser context open forever'
  );
});

test('the escalated idle timeout defaults to an hour and is overridable by environment variable', () => {
  assert.equal(DEFAULT_ESCALATED_IDLE_TIMEOUT_MS, 60 * 60 * 1000);
  assert.equal(resolveEscalatedIdleTimeoutMs({}), 60 * 60 * 1000);
  assert.equal(resolveEscalatedIdleTimeoutMs({ HARBORAGE_ESCALATED_IDLE_TIMEOUT_MS: '1234' }), 1234);
  assert.equal(
    resolveEscalatedIdleTimeoutMs({ HARBORAGE_ESCALATED_IDLE_TIMEOUT_MS: 'not-a-number' }),
    60 * 60 * 1000,
    'an unparseable override must fall back to the default rather than reaping instantly'
  );
});
