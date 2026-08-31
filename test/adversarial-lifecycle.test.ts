import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { BrowserManager } from '../src/daemon/browserManager.js';
import { SessionStore } from '../src/daemon/sessions.js';
import { createToolHandlers, type ToolHandlers } from '../src/daemon/tools/handlers.js';
import { routeStateSessionCount } from '../src/daemon/tools/defs/network.js';
import { runSweepOnce, type SweepDeps } from '../src/daemon/sweep.js';
import { createLogger } from '../src/shared/logger.js';
import { readRegistry, writeRegistry } from '../src/shared/registry.js';
import { cleanupTempDirs, getFreePort, makeTestConfig, startTestPage } from './helpers.js';

/**
 * An adversarial pass over the lifecycle and isolation work of this round.
 * Every test here was written to BREAK something, and each one failed
 * against the code as it stood before the fix that sits alongside it.
 */

let browserManager: BrowserManager;
let sessions: SessionStore;
let handlers: ToolHandlers;
let page: { url: string; close: () => Promise<void> };

/** Short enough that a test can watch the stuck-call cap fire without waiting minutes. */
const maxInFlightAgeMs = 500;

before(async () => {
  browserManager = new BrowserManager(await getFreePort());
  sessions = new SessionStore(browserManager, {}, undefined, { maxInFlightAgeMs });
  handlers = createToolHandlers(sessions, {
    debugPort: 0,
    screenshotCacheDir: '/dev/null/unused',
    screenshotCacheTtlMs: 1000
  });
  page = await startTestPage();
});

after(async () => {
  await sessions.closeAll();
  await browserManager.close();
  await page.close();
  cleanupTempDirs();
});

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Runs send_cdp_command and reports what came back, whether it threw or returned an error result. */
async function rawCdp(
  sessionId: string,
  method: string,
  params?: unknown
): Promise<{ refused: boolean; detail: string }> {
  try {
    const result = await handlers.send_cdp_command({ sessionId, method, params });
    if (result.isError) return { refused: true, detail: JSON.stringify(result.content) };
    return { refused: false, detail: JSON.stringify(result.structuredContent) };
  } catch (err) {
    return { refused: true, detail: (err as Error).message };
  }
}

async function targetInfoOf(sessionId: string): Promise<{ targetId: string; browserContextId: string }> {
  const target = sessions.resolve(sessionId);
  const cdp = await target.session.context.newCDPSession(target.page);
  try {
    const info = (await cdp.send('Target.getTargetInfo')) as {
      targetInfo: { targetId: string; browserContextId: string };
    };
    return info.targetInfo;
  } finally {
    await cdp.detach().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// 1. Session isolation: the raw CDP escape hatch reaches the whole browser
// ---------------------------------------------------------------------------

test('send_cdp_command cannot enumerate the tabs of other sessions', async () => {
  const victim = await sessions.createSession();
  await handlers.navigate({ sessionId: victim.sessionId, url: page.url });
  const attacker = await sessions.createSession();

  const seen = await rawCdp(attacker.sessionId, 'Target.getTargets');
  assert.equal(
    seen.refused,
    true,
    `one session listed every other session's tabs through raw CDP: ${seen.detail}`
  );

  await sessions.releaseSession(victim.sessionId);
  await sessions.releaseSession(attacker.sessionId);
});

test('send_cdp_command cannot close a tab belonging to another session', async () => {
  const victim = await sessions.createSession();
  await handlers.navigate({ sessionId: victim.sessionId, url: page.url });
  const attacker = await sessions.createSession();

  const { targetId } = await targetInfoOf(victim.sessionId);
  await rawCdp(attacker.sessionId, 'Target.closeTarget', { targetId });
  await sleep(300);

  const tabs = (await handlers.list_tabs({ sessionId: victim.sessionId })).structuredContent as {
    tabs: unknown[];
  };
  assert.equal(tabs.tabs.length, 1, 'another session closed this session\'s only tab through raw CDP');

  await sessions.releaseSession(victim.sessionId);
  await sessions.releaseSession(attacker.sessionId);
});

test('send_cdp_command cannot inject a tab into another session', async () => {
  const victim = await sessions.createSession();
  await handlers.navigate({ sessionId: victim.sessionId, url: page.url });
  const attacker = await sessions.createSession();

  const { browserContextId } = await targetInfoOf(victim.sessionId);
  await rawCdp(attacker.sessionId, 'Target.createTarget', { url: 'about:blank', browserContextId });
  await sleep(300);

  const tabs = (await handlers.list_tabs({ sessionId: victim.sessionId })).structuredContent as {
    tabs: { active: boolean }[];
  };
  assert.equal(
    tabs.tabs.length,
    1,
    'another session opened a tab inside this session, and it became the tab this session\'s next call targets'
  );

  await sessions.releaseSession(victim.sessionId);
  await sessions.releaseSession(attacker.sessionId);
});

test('send_cdp_command cannot shut down the shared browser out from under every other session', async () => {
  // Its own browser, because proving this the hard way would take every other
  // test in this file down with it if it ran against the shared one.
  const ownManager = new BrowserManager(await getFreePort());
  const ownStore = new SessionStore(ownManager);
  const ownHandlers = createToolHandlers(ownStore, {
    debugPort: 0,
    screenshotCacheDir: '/dev/null/unused',
    screenshotCacheTtlMs: 1000
  });
  try {
    const victim = await ownStore.createSession();
    const attacker = await ownStore.createSession();
    await ownHandlers.navigate({ sessionId: victim.sessionId, url: page.url });

    await ownHandlers.send_cdp_command({ sessionId: attacker.sessionId, method: 'Browser.close' }).catch(() => {});
    await sleep(500);

    assert.equal(ownManager.isLaunched(), true, 'one session killed the shared Chromium through raw CDP');
    const alive = await ownHandlers.evaluate({ sessionId: victim.sessionId, expression: '1 + 1' });
    assert.equal(alive.isError, undefined, 'an unrelated session died with the browser');
  } finally {
    await ownStore.closeAll().catch(() => {});
    await ownManager.close().catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// 2. The reaper: what "in flight" actually measures
// ---------------------------------------------------------------------------

test('a session under continuously overlapping calls is not mistaken for a wedged one', async () => {
  const { sessionId } = await sessions.createSession();

  // Every call is fast. What never happens is the in-flight count reaching
  // zero, because the next call starts before the previous one finishes.
  // That is an ordinarily busy session, not a stuck one.
  const started: Promise<unknown>[] = [];
  const deadline = Date.now() + maxInFlightAgeMs * 2;
  while (Date.now() < deadline) {
    started.push(
      handlers
        .evaluate({ sessionId, expression: 'new Promise(r => setTimeout(() => r("tick"), 220))' })
        .catch(() => undefined)
    );
    await sleep(80);
    assert.ok(sessions.inFlightCount(sessionId) > 0, 'the overlap this test depends on did not happen');
  }

  const reaped = await sessions.reapIdle(60_000);
  assert.deepEqual(reaped, [], 'a busy session whose calls all return promptly must never be reaped as stuck');

  await Promise.all(started);
  await sessions.releaseSession(sessionId);
});

test('a genuinely wedged call is still caught even while short calls come and go around it', async () => {
  const { sessionId } = await sessions.createSession();

  const wedged = handlers.evaluate({ sessionId, expression: 'new Promise(() => {})' }).catch(() => undefined);
  await sleep(100);
  // Traffic around the wedged call must not reset its age, or the cap can be
  // defeated by simply keeping the session busy.
  for (let i = 0; i < 6; i += 1) {
    await handlers.evaluate({ sessionId, expression: '1 + 1' });
    await sleep(100);
  }

  const reaped = await sessions.reapIdle(60_000);
  assert.deepEqual(reaped, [sessionId], 'the stuck-call cap must not be resettable by unrelated short calls');
  await wedged;
});

// ---------------------------------------------------------------------------
// 3. The sweep: ordering and failure containment
// ---------------------------------------------------------------------------

/** One sweep pass with an isolated registry and a capturing logger. */
async function sweepOnce(overrides: Partial<SweepDeps> & { registryPath: string }): Promise<{
  outcome: Awaited<ReturnType<typeof runSweepOnce>>;
  shutdownCalls: number;
  lines: string[];
  error?: Error;
}> {
  let shutdownCalls = 0;
  const lines: string[] = [];
  const deps: SweepDeps = {
    sessions,
    idleTimeoutMs: 60_000,
    shutdownGraceMs: 0,
    daemonStartedAt: Date.now() - 60_000,
    screenshotCacheDir: `${overrides.registryPath}-screenshots`,
    screenshotCacheTtlMs: 60_000,
    logger: createLogger(line => lines.push(line)),
    onEmptyRegistryShutdown: async () => {
      shutdownCalls += 1;
    },
    ...overrides
  };
  try {
    return { outcome: await runSweepOnce(deps), shutdownCalls, lines };
  } catch (err) {
    return {
      outcome: {
        reapedSessions: [],
        prunedClients: [],
        remainingClients: -1,
        liveSessions: -1,
        removedScreenshots: [],
        triggeredShutdown: false
      },
      shutdownCalls,
      lines,
      error: err as Error
    };
  }
}

test('a screenshot cache that cannot be read does not stop the sweep pruning the registry or deciding to shut down', async () => {
  const config = await makeTestConfig();
  await sessions.closeAll();

  // A cache directory that is a regular file, which is what an operator gets
  // from one bad HARBORAGE_SCREENSHOT_CACHE_DIR. readdir raises ENOTDIR,
  // which is neither ENOENT nor recoverable by retrying.
  const brokenCacheDir = join(config.stateDir, 'not-a-directory');
  writeFileSync(brokenCacheDir, 'this is a file, not a cache directory');

  // A dead client in the registry, so the prune has real work to do.
  await writeRegistry(config.registryPath, [{ pid: 999_999, startedAt: 'a start time no live process has' }]);

  const { outcome, shutdownCalls, error } = await sweepOnce({
    registryPath: config.registryPath,
    screenshotCacheDir: brokenCacheDir
  });

  assert.equal(error, undefined, `the whole sweep pass aborted: ${error?.message ?? ''}`);
  assert.deepEqual(await readRegistry(config.registryPath), [], 'the dead client was never pruned');
  assert.equal(outcome.triggeredShutdown, true, 'the shutdown gate was never reached');
  assert.equal(shutdownCalls, 1);
});

test('a session still being created vetoes the empty-registry shutdown', async () => {
  const config = await makeTestConfig();
  await sessions.closeAll();

  // Not yet awaited: the context is being built, the first tab is being
  // opened, and on a cold daemon Chromium itself is still launching. There
  // is no sessionId yet, so nothing about this work is visible to the gate.
  const creating = sessions.createSession();

  const { outcome, shutdownCalls } = await sweepOnce({ registryPath: config.registryPath });

  assert.equal(
    outcome.triggeredShutdown,
    false,
    'the daemon decided to exit while a create_session was still building its browser context'
  );
  assert.equal(shutdownCalls, 0);

  const { sessionId } = await creating;
  await sessions.releaseSession(sessionId);
});

// ---------------------------------------------------------------------------
// 4. The client registry: a registration that races the sweep
// ---------------------------------------------------------------------------

test('a client that registers while a sweep is pruning is not silently dropped', async () => {
  const config = await makeTestConfig();
  await sessions.closeAll();

  // Enough dead entries that pruneDead's per-entry `ps` calls hold the read
  // and the write apart for a while, which is the window a real client
  // registration lands in.
  const dead = Array.from({ length: 12 }, (_, i) => ({
    pid: 900_000 + i,
    startedAt: 'a start time no live process has'
  }));
  await writeRegistry(config.registryPath, dead);

  const sweeping = sweepOnce({ registryPath: config.registryPath });
  await sleep(15);
  const live = await readRegistry(config.registryPath);
  await writeRegistry(config.registryPath, [
    ...live.filter(e => e.pid !== process.pid),
    { pid: process.pid, startedAt: 'whatever this process reports' }
  ]);
  await sweeping;

  const afterSweep = await readRegistry(config.registryPath);
  assert.ok(
    afterSweep.some(e => e.pid === process.pid),
    'the sweep wrote a registry it had read before this client registered, erasing the registration'
  );
});

// ---------------------------------------------------------------------------
// 5. Bounded growth: what a session leaves behind when it ends badly
// ---------------------------------------------------------------------------

/** Waits for the module-scope network table to drop back to `target`, which happens on the context's own close event. */
async function waitForNetStates(target: number): Promise<number> {
  const deadline = Date.now() + 5000;
  while (routeStateSessionCount() !== target && Date.now() < deadline) {
    await sleep(25);
  }
  return routeStateSessionCount();
}

test('a session released while a call is running leaves no network state, no in-flight count and no wedged call', async () => {
  const before = routeStateSessionCount();
  const { sessionId } = await sessions.createSession();
  await handlers.add_route_rule({ sessionId, urlGlob: '**/api/mid-call', action: 'fulfill', status: 200 });
  await handlers.set_offline({ sessionId, offline: true });
  assert.equal(routeStateSessionCount(), before + 1);

  const running = handlers
    .evaluate({ sessionId, expression: 'new Promise(r => setTimeout(() => r("late"), 1500))' })
    .catch((err: Error) => err);
  await sleep(150);
  assert.equal(sessions.inFlightCount(sessionId), 1);

  await sessions.releaseSession(sessionId);

  assert.equal(await waitForNetStates(before), before, 'release_session left route/offline state behind');
  assert.equal(sessions.inFlightCount(sessionId), 0);

  // The call that was running has to end one way or another, not hang forever.
  const outcome = await Promise.race([running, sleep(8000).then(() => 'NEVER SETTLED')]);
  assert.notEqual(outcome, 'NEVER SETTLED', 'a call whose session was released under it never settled');
});

test('a session reaped for a wedged call leaves no network state behind either', async () => {
  const before = routeStateSessionCount();
  const { sessionId } = await sessions.createSession();
  await handlers.add_route_rule({ sessionId, urlGlob: '**/api/wedged', action: 'abort' });
  await handlers.set_network_conditions({ sessionId, preset: 'slow-3g' });
  assert.equal(routeStateSessionCount(), before + 1);

  const wedged = handlers.evaluate({ sessionId, expression: 'new Promise(() => {})' }).catch(() => undefined);
  await sleep(maxInFlightAgeMs + 200);

  assert.deepEqual(await sessions.reapIdle(60_000), [sessionId], 'the stuck-call cap should have fired');
  assert.equal(
    await waitForNetStates(before),
    before,
    'the stuck-call reaper closed the context but left its route rules and held CDP sessions in the module table'
  );
  await wedged;
});

test('driving one tab hard does not accumulate listeners on it', async () => {
  const { sessionId } = await sessions.createSession();
  // Playwright's Page is an EventEmitter underneath; its public type does not
  // expose listenerCount, and counting listeners is the whole point here.
  const tab = sessions.resolve(sessionId).page as unknown as { listenerCount(event: string): number };

  // The tools most likely to attach something per call: the emulation ones
  // hold a long-lived CDP session per tab, and the network ones hold one per
  // tab per profile change.
  for (let i = 0; i < 25; i += 1) {
    await handlers.set_user_agent({ sessionId, userAgent: `harborage-probe/${i}` });
    await handlers.set_timezone({ sessionId, timezoneId: i % 2 === 0 ? 'Asia/Tokyo' : 'Europe/Berlin' });
    await handlers.set_network_conditions({ sessionId, preset: i % 2 === 0 ? 'slow-3g' : 'none' });
  }

  // One 'close' listener from adoptPage, one from the emulation override
  // session, and at most one live at a time from the throttle attach. A
  // per-call registration would be at 25 by now.
  assert.ok(
    tab.listenerCount('close') <= 6,
    `a tab accumulated ${tab.listenerCount('close')} close listeners over 75 tool calls`
  );

  await sessions.releaseSession(sessionId);
});

// ---------------------------------------------------------------------------
// 6. Write verification, applied consistently
// ---------------------------------------------------------------------------

test('resize reports whether the page agrees with the viewport it was given', async () => {
  const { sessionId } = await sessions.createSession();

  // Every other write tool in the registry (fill, type, select_option,
  // file_upload, set_cookies, set_storage) reads its write back and carries a
  // "matched" flag. resize read back and reported the numbers without ever
  // saying whether they agreed, leaving a caller to spot a disagreement it
  // had no reason to look for.
  for (const url of [
    'data:text/html,<h1>plain</h1>',
    'data:text/html,<body style="height:5000px">tall enough to scroll</body>',
    'data:text/html,<html style="zoom:2"><body><h1>zoomed</h1></body></html>'
  ]) {
    await handlers.navigate({ sessionId, url });
    const payload = (await handlers.resize({ sessionId, width: 900, height: 700 })).structuredContent as {
      matched?: boolean;
      innerWidth: number;
      innerHeight: number;
    };
    assert.equal(typeof payload.matched, 'boolean', 'resize must state whether the page agrees, not leave it implied');
    assert.equal(
      payload.matched,
      payload.innerWidth === 900 && payload.innerHeight === 700,
      'the flag must follow the measurement rather than the request'
    );
    // Nothing ordinary must trip the flag, or the note becomes noise nobody
    // reads: an overlay scrollbar, a CSS zoom and a plain page all agree.
    assert.equal(payload.matched, true, `an ordinary page disagreed with its own viewport on ${url}`);
  }

  await sessions.releaseSession(sessionId);
});

// ---------------------------------------------------------------------------
// 7. Escalation wins the stuck-call cap, with a bound
// ---------------------------------------------------------------------------

/**
 * `reapIdle` used to check the in-flight branch before the escalated branch,
 * so the ten-minute stuck-call cap overrode the hour-long escalated timeout. A
 * person working through a CAPTCHA lost their session ten minutes in if any
 * unrelated call happened to be wedged against it, which is the exact failure
 * escalate_session exists to prevent. That answer was never chosen: it fell
 * out of the order of two `if`s.
 *
 * An escalated session now gets the escalated budget for a wedged call too.
 * The cost is bounded and deliberate: a wedged call in an escalated session
 * can pin the shared daemon for an hour rather than ten minutes, which is
 * still a bound, and a person's live work is worth more than the difference.
 */
test('an escalated session keeps its longer rope even with a call wedged against it', async () => {
  const { sessionId } = await sessions.createSession();
  sessions.markEscalated(sessionId);

  const wedged = handlers.evaluate({ sessionId, expression: 'new Promise(() => {})' }).catch(() => undefined);
  await sleep(maxInFlightAgeMs + 200);

  const reaped = await sessions.reapIdle(60_000);
  assert.deepEqual(reaped, [], 'a human is driving this session, the ordinary stuck-call cap must not take it away');

  await sessions.releaseSession(sessionId);
  await wedged;
});

test('a wedged call in a NON-escalated session is still reaped at the ordinary cap', async () => {
  const { sessionId } = await sessions.createSession();

  const wedged = handlers.evaluate({ sessionId, expression: 'new Promise(() => {})' }).catch(() => undefined);
  await sleep(maxInFlightAgeMs + 200);

  const reaped = await sessions.reapIdle(60_000);
  assert.deepEqual(reaped, [sessionId], 'the bound still exists for everything that is not escalated');
  await wedged;
});
