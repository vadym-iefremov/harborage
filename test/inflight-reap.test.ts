import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { BrowserManager } from '../src/daemon/browserManager.js';
import { SessionStore } from '../src/daemon/sessions.js';
import { createToolHandlers, type ToolHandlers } from '../src/daemon/tools/handlers.js';
import { getFreePort, startTestPage } from './helpers.js';

let browserManager: BrowserManager;
let sessions: SessionStore;
let handlers: ToolHandlers;

before(async () => {
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
});

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** An expression that keeps the page busy for `ms`, so a real tool call outlives a sweep. */
function slowExpression(ms: number, value: string): string {
  return `new Promise(resolve => setTimeout(() => resolve(${JSON.stringify(value)}), ${ms}))`;
}

test('a tool call that outlives the idle timeout does not get its own session reaped mid-flight', async () => {
  const { sessionId } = await sessions.createSession();

  const call = handlers.evaluate({ sessionId, expression: slowExpression(600, 'slow call finished') });
  await sleep(200);

  // The session has done nothing since the call STARTED, so by lastActivity
  // alone it is already stale. It must survive anyway: the call is still running.
  const reapedMidCall = await sessions.reapIdle(50);
  assert.deepEqual(reapedMidCall, [], 'a session with a call in flight must not be reaped');
  assert.equal(sessions.inFlightCount(sessionId), 1);

  const result = await call;
  assert.match(JSON.stringify(result.structuredContent), /slow call finished/);
  assert.equal(sessions.inFlightCount(sessionId), 0);

  // Completing the call refreshes lastActivity, so the session does not come
  // back from a long call already stale enough to be reaped on the next sweep.
  const reapedAfterCall = await sessions.reapIdle(50);
  assert.deepEqual(reapedAfterCall, [], 'a just-finished call must reset the idle clock');

  // And it is still genuinely usable, not merely present in the table.
  const tabs = await handlers.list_tabs({ sessionId });
  assert.equal((tabs.structuredContent as { tabs: unknown[] }).tabs.length, 1);

  await sessions.releaseSession(sessionId);
});

test('a handler that throws still decrements the in-flight count, so its session stays reapable', async () => {
  const { sessionId } = await sessions.createSession();

  await assert.rejects(
    handlers.evaluate({ sessionId, expression: 'Promise.reject(new Error("deliberate handler failure"))' }),
    /deliberate handler failure/
  );

  assert.equal(sessions.inFlightCount(sessionId), 0, 'a thrown handler must not leak an in-flight count');

  await sleep(80);
  const reaped = await sessions.reapIdle(40);
  assert.deepEqual(reaped, [sessionId], 'a session left un-decremented could never be reaped again');
});

test('in-flight tracking is per session: a busy session survives the sweep that reaps an idle one, with no bleed-through', async () => {
  const page = await startTestPage();
  try {
    const busy = await sessions.createSession();
    const idle = await sessions.createSession();

    const call = handlers.evaluate({ sessionId: busy.sessionId, expression: slowExpression(600, 'busy finished') });
    await sleep(200);

    const reaped = await sessions.reapIdle(50);
    assert.deepEqual(reaped, [idle.sessionId], 'only the session with nothing in flight should be reaped');

    await call;

    // The surviving session is a genuinely intact, still-isolated context:
    // what it writes stays inside it, and a session created afterwards sees
    // none of it.
    await handlers.navigate({ sessionId: busy.sessionId, url: page.url });
    await handlers.evaluate({ sessionId: busy.sessionId, expression: 'localStorage.setItem("survivor", "busy"), "ok"' });

    const other = await sessions.createSession();
    await handlers.navigate({ sessionId: other.sessionId, url: page.url });
    const leaked = await handlers.evaluate({
      sessionId: other.sessionId,
      expression: 'localStorage.getItem("survivor")'
    });
    assert.equal((leaked.structuredContent as { result: string | null }).result, null, 'no state may cross sessions');

    const mine = await handlers.evaluate({
      sessionId: busy.sessionId,
      expression: 'localStorage.getItem("survivor")'
    });
    assert.equal((mine.structuredContent as { result: string | null }).result, 'busy');

    await sessions.releaseSession(busy.sessionId);
    await sessions.releaseSession(other.sessionId);
  } finally {
    await page.close();
  }
});
