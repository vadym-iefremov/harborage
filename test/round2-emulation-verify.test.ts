import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';

import type { BrowserContext } from 'playwright';

import { BrowserManager } from '../src/daemon/browserManager.js';
import { createToolHandlers } from '../src/daemon/tools/handlers.js';
import { SessionStore } from '../src/daemon/sessions.js';
import { getFreePort } from './helpers.js';

/**
 * Round 2 QA: three tools that could report a silent false pass through
 * their own genuine machinery rather than a mock of the fix.
 *
 * set_network_conditions and set_offline share one bug: a CDP send that
 * genuinely failed was still counted as applied. set_offline's readback of
 * navigator.onLine had a second bug: a failed readback silently vanished
 * rather than being reported as unverified. set_user_agent, set_timezone and
 * set_locale each had a reset path whose "matched" flag could never turn
 * false. All five are proven here against the real CDP call path, not
 * against a rewrite of the fix's own logic: the browser's own CDPSession is
 * wrapped so one specific protocol call fails or is silently accepted
 * without reaching the browser, and everything else in the tool runs for
 * real.
 */

const PAGE_HTML = `<!doctype html><html><body><h1>round2 fixture</h1></body></html>`;

let server: Server;
let baseUrl: string;
let browserManager: BrowserManager;
let sessions: SessionStore;
let handlers: ReturnType<typeof createToolHandlers>;

before(async () => {
  server = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(PAGE_HTML);
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

function payload(result: unknown): Record<string, any> {
  return (result as { structuredContent: Record<string, any> }).structuredContent;
}

async function freshSession(): Promise<string> {
  const { sessionId } = await sessions.createSession();
  await handlers.navigate({ sessionId, url: baseUrl });
  return sessionId;
}

/**
 * Wraps every CDP session this context hands out, so one specific protocol
 * call can be made to fail or to be silently accepted without ever reaching
 * the browser, while every other call (Network.enable, the tool's own
 * probes, everything) goes to the real browser untouched.
 *
 * This is deliberately at the boundary between the tool and Chromium, not
 * inside the tool's own code: the tool still runs its real branching, its
 * real bookkeeping and its real result-shaping. Only the one protocol reply
 * is substituted, the same way a crashed tab or a stale session would make
 * that one call fail in production.
 */
function interceptCdp(
  context: BrowserContext,
  decide: (method: string, params: unknown) => 'pass' | 'fail' | 'accept-but-do-nothing'
): () => void {
  const original = context.newCDPSession.bind(context);
  const patched = (async (...args: Parameters<typeof original>) => {
    const cdp = await original(...args);
    const originalSend = cdp.send.bind(cdp);
    (cdp as unknown as { send: unknown }).send = async (method: string, params?: unknown) => {
      const outcome = decide(method, params);
      if (outcome === 'fail') throw new Error(`stubbed CDP failure for ${method}, for a test`);
      if (outcome === 'accept-but-do-nothing') return {};
      return originalSend(method as never, params as never);
    };
    return cdp;
  }) as typeof original;
  (context as unknown as { newCDPSession: unknown }).newCDPSession = patched;
  return () => {
    (context as unknown as { newCDPSession: unknown }).newCDPSession = original;
  };
}

// ---------------------------------------------------------------------------
// Defect 1: a failed CDP send must not be reported as applied
// ---------------------------------------------------------------------------

test('set_network_conditions does not list a tab as applied when the CDP send genuinely fails', async () => {
  const sessionId = await freshSession();
  const target = sessions.resolve(sessionId);

  const restore = interceptCdp(target.session.context, method =>
    method === 'Network.emulateNetworkConditions' ? 'fail' : 'pass'
  );
  try {
    const result = payload(await handlers.set_network_conditions({ sessionId, preset: 'slow-3g' }));
    assert.ok(
      !(result.appliedToPageIds as string[]).includes(target.pageId),
      'a tab whose CDP send threw must not be listed as applied'
    );
    assert.ok(
      (result.failedPageIds as string[]).includes(target.pageId),
      'the same tab must be named in failedPageIds instead'
    );
    assert.match(result.note as string, /did not accept/i);
  } finally {
    restore();
    await handlers.set_network_conditions({ sessionId, preset: 'none' });
  }

  await sessions.releaseSession(sessionId);
});

test('set_offline does not list a tab as applied when the CDP send genuinely fails', async () => {
  const sessionId = await freshSession();
  const target = sessions.resolve(sessionId);

  // The CDP session network.ts attaches to a tab is created once and then
  // cached for as long as the tab lives, so the intercept has to be in place
  // BEFORE that first attach, or the cached session handed back on every
  // later call is the real, unwrapped one.
  const restore = interceptCdp(target.session.context, method =>
    method === 'Network.emulateNetworkConditions' ? 'fail' : 'pass'
  );
  try {
    // set_offline only pushes a CDP send at all once there is a throttle
    // profile to carry the offline flag on, so one is set first. This call
    // itself fails to apply too, under the same intercept, which is fine:
    // only the set_offline call below is asserted on.
    await handlers.set_network_conditions({ sessionId, preset: 'slow-3g' });

    const result = payload(await handlers.set_offline({ sessionId, offline: true }));
    assert.ok(
      !(result.appliedToPageIds as string[]).includes(target.pageId),
      'a tab whose CDP send threw must not be listed as applied'
    );
    assert.ok((result.failedPageIds as string[]).includes(target.pageId));
  } finally {
    restore();
    await handlers.set_offline({ sessionId, offline: false });
    await handlers.set_network_conditions({ sessionId, preset: 'none' });
  }

  await sessions.releaseSession(sessionId);
});

// ---------------------------------------------------------------------------
// Defect 2: a failed navigator.onLine readback must not vanish silently
// ---------------------------------------------------------------------------

test('set_offline reports an explicit unverifiable result when navigator.onLine cannot be read back', async () => {
  const sessionId = await freshSession();
  const target = sessions.resolve(sessionId);

  const originalEvaluate = target.page.evaluate.bind(target.page);
  let rejectNext = true;
  (target.page as unknown as { evaluate: unknown }).evaluate = ((...args: Parameters<typeof originalEvaluate>) => {
    if (rejectNext) {
      rejectNext = false;
      return Promise.reject(new Error('stubbed evaluate failure for a test'));
    }
    return originalEvaluate(...args);
  }) as typeof originalEvaluate;

  try {
    const result = payload(await handlers.set_offline({ sessionId, offline: true }));
    assert.equal(result.offline, true, 'the offline switch itself is a separate CDP/context call and must still take');
    assert.equal(result.navigatorOnLine, null, 'an unreadable navigator.onLine must come back as an explicit null, not vanish');
    assert.ok('navigatorOnLine' in result, 'the field must still be present in the payload');
    assert.match(
      result.note as string,
      /could not be read back|readback/i,
      'the note must say the readback itself failed, not imply the switch was verified'
    );
  } finally {
    (target.page as unknown as { evaluate: unknown }).evaluate = originalEvaluate;
    await handlers.set_offline({ sessionId, offline: false });
  }

  await sessions.releaseSession(sessionId);
});

// ---------------------------------------------------------------------------
// Defect 3: a reset's "matched" must be able to fail
// ---------------------------------------------------------------------------

test('set_user_agent reset reports matched: false when the override survives the reset', async () => {
  const sessionId = await freshSession();
  const target = sessions.resolve(sessionId);

  // The persistent CDP session these tools keep per tab is created once and
  // then reused, so the intercept has to be in place BEFORE the first
  // override call, or the cached session handed back to the later reset is
  // the real, unwrapped one.
  const restore = interceptCdp(target.session.context, (method, params) => {
    const p = params as { userAgent?: string } | undefined;
    if (method === 'Emulation.setUserAgentOverride' && p?.userAgent === '') return 'accept-but-do-nothing';
    return 'pass';
  });
  try {
    await handlers.set_user_agent({ sessionId, userAgent: 'HarborageQA/round2' });
    const result = payload(await handlers.set_user_agent({ sessionId, reset: true }));
    assert.equal(result.userAgent, 'HarborageQA/round2', 'the override genuinely never left, so the readback must still show it');
    assert.equal(result.matched, false, 'a reset that did not move the page must report matched: false, not true');
    assert.match(result.note as string, /did not take|likely did not/i);
  } finally {
    restore();
  }

  await sessions.releaseSession(sessionId);
});

test('set_user_agent reset on a tab with no override active is a legitimate no-op, not a false failure', async () => {
  const sessionId = await freshSession();
  const result = payload(await handlers.set_user_agent({ sessionId, reset: true }));
  assert.equal(result.matched, true, 'resetting a tab that was never overridden must not read as a failure');
  await sessions.releaseSession(sessionId);
});

test('set_timezone reset reports matched: false when the override survives the reset', async () => {
  const sessionId = await freshSession();
  const target = sessions.resolve(sessionId);

  const restore = interceptCdp(target.session.context, (method, params) => {
    const p = params as { timezoneId?: string } | undefined;
    if (method === 'Emulation.setTimezoneOverride' && p?.timezoneId === '') return 'accept-but-do-nothing';
    return 'pass';
  });
  try {
    await handlers.set_timezone({ sessionId, timezoneId: 'Asia/Tokyo' });
    const result = payload(await handlers.set_timezone({ sessionId, reset: true }));
    assert.equal(result.timezoneId, 'Asia/Tokyo', 'the override genuinely never left, so the readback must still show it');
    assert.equal(result.matched, false, 'a reset that did not move the page must report matched: false, not true');
  } finally {
    restore();
  }

  await sessions.releaseSession(sessionId);
});

test('set_timezone reset on a tab with no override active is a legitimate no-op, not a false failure', async () => {
  const sessionId = await freshSession();
  const result = payload(await handlers.set_timezone({ sessionId, reset: true }));
  assert.equal(result.matched, true, 'resetting a tab that was never overridden must not read as a failure');
  await sessions.releaseSession(sessionId);
});

test('set_locale reset reports matched: false when the override survives the reset', async () => {
  const sessionId = await freshSession();
  const target = sessions.resolve(sessionId);

  const restore = interceptCdp(target.session.context, (method, params) => {
    const p = params as Record<string, unknown> | undefined;
    if (method === 'Emulation.setLocaleOverride' && (p === undefined || Object.keys(p).length === 0)) {
      return 'accept-but-do-nothing';
    }
    return 'pass';
  });
  try {
    await handlers.set_locale({ sessionId, locale: 'de-DE' });
    const result = payload(await handlers.set_locale({ sessionId, reset: true }));
    assert.equal(result.locale, 'de-DE', 'the override genuinely never left, so the readback must still show it');
    assert.equal(result.matched, false, 'a reset that did not move the page must report matched: false, not true');
  } finally {
    restore();
  }

  await sessions.releaseSession(sessionId);
});

test('set_locale reset on a tab with no override active is a legitimate no-op, not a false failure', async () => {
  const sessionId = await freshSession();
  const result = payload(await handlers.set_locale({ sessionId, reset: true }));
  assert.equal(result.matched, true, 'resetting a tab that was never overridden must not read as a failure');
  await sessions.releaseSession(sessionId);
});
