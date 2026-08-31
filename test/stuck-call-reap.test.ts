import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { BrowserManager } from '../src/daemon/browserManager.js';
import { SessionStore } from '../src/daemon/sessions.js';
import { createToolHandlers, type ToolHandlers } from '../src/daemon/tools/handlers.js';
import { createLogger } from '../src/shared/logger.js';
import { loadConfig } from '../src/shared/config.js';
import { getFreePort } from './helpers.js';

/** Short enough that a test can watch a wedged call stop protecting its session. */
const maxInFlightAgeMs = 400;

let browserManager: BrowserManager;
let sessions: SessionStore;
let handlers: ToolHandlers;
const lines: string[] = [];

before(async () => {
  browserManager = new BrowserManager(await getFreePort());
  sessions = new SessionStore(browserManager, {}, createLogger(line => lines.push(line)), { maxInFlightAgeMs });
  handlers = createToolHandlers(sessions, {
    debugPort: 0,
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

/**
 * `withEnv` rather than mutating process.env for the whole file: node:test
 * gives each file its own process, but a leaked variable would still cross
 * between tests inside it.
 */
function withEnv(name: string, value: string | undefined, run: () => void): void {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    run();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

test('a call wedged past the max in-flight age stops protecting its session from the reaper', async () => {
  const { sessionId } = await sessions.createSession();

  // Never settles. This is the exact shape that used to pin a session, and
  // through it the shared daemon, for as long as the daemon lived.
  const wedged = handlers
    .evaluate({ sessionId, expression: 'new Promise(() => {})' })
    .catch(() => {
      // Rejects with "target closed" once the reaper takes the context away,
      // which is the point of the test rather than a failure of it.
    });

  await sleep(120);
  assert.equal(sessions.inFlightCount(sessionId), 1);
  assert.deepEqual(
    await sessions.reapIdle(50),
    [],
    'inside the grace period a running call must still veto reaping'
  );

  await sleep(maxInFlightAgeMs);
  const reaped = await sessions.reapIdle(50);
  assert.deepEqual(reaped, [sessionId], 'past the max in-flight age the veto must be overridden');

  const log = lines.join('\n');
  assert.match(log, /session\.reap-stuck/, 'overriding the veto must be logged loudly, not silently');
  assert.match(log, /inFlight=1/);

  await wedged;
});

test('the two new timeouts have defensible defaults and are overridable by environment variable', () => {
  withEnv('HARBORAGE_ESCALATED_IDLE_TIMEOUT_MS', undefined, () => {
    assert.equal(loadConfig().escalatedIdleTimeoutMs, 60 * 60 * 1000);
  });
  withEnv('HARBORAGE_ESCALATED_IDLE_TIMEOUT_MS', '1234', () => {
    assert.equal(loadConfig().escalatedIdleTimeoutMs, 1234);
  });
  withEnv('HARBORAGE_MAX_IN_FLIGHT_AGE_MS', undefined, () => {
    assert.equal(loadConfig().maxInFlightAgeMs, 10 * 60 * 1000);
  });
  withEnv('HARBORAGE_MAX_IN_FLIGHT_AGE_MS', '4321', () => {
    assert.equal(loadConfig().maxInFlightAgeMs, 4321);
  });
});

test('a session whose wedged call is overridden does not take a healthy neighbour with it', async () => {
  const wedgedSession = await sessions.createSession();
  const healthy = await sessions.createSession();

  const wedged = handlers
    .evaluate({ sessionId: wedgedSession.sessionId, expression: 'new Promise(() => {})' })
    .catch(() => {});

  await sleep(maxInFlightAgeMs + 150);

  // The healthy session is busy with a call that is still well inside the
  // grace, so only the wedged one loses its veto.
  const busy = handlers.evaluate({
    sessionId: healthy.sessionId,
    expression: 'new Promise(resolve => setTimeout(() => resolve("healthy finished"), 400))'
  });
  const reaped = await sessions.reapIdle(50);
  assert.deepEqual(reaped, [wedgedSession.sessionId]);

  const result = await busy;
  assert.match(JSON.stringify(result.structuredContent), /healthy finished/);
  await sessions.releaseSession(healthy.sessionId);
  await wedged;
});
