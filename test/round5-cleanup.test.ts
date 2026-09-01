import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';

import type { Browser, BrowserContext, CDPSession, Page } from 'playwright';

import { BrowserManager } from '../src/daemon/browserManager.js';
import { SessionStore } from '../src/daemon/sessions.js';
import { createToolHandlers, type ToolHandlers } from '../src/daemon/tools/handlers.js';
import { routeStateSessionCount } from '../src/daemon/tools/defs/network.js';
import { getFreePort } from './helpers.js';

/**
 * One defect shape, found five times: something is ACQUIRED above the `try`
 * whose `finally` is supposed to release it, so a partial failure walks
 * straight past cleanup that looks correct.
 *
 * Every test here is graded on what the browser is actually left holding, not
 * on whether a call threw. A test that asserts a function threw proves
 * nothing about what it left behind, which is the entire failure mode.
 */

let server: Server;
let base: string;
let browserManager: BrowserManager;
let browser: Browser;

before(async () => {
  browserManager = new BrowserManager(await getFreePort());
  browser = await browserManager.getBrowser();
  server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    // /nested exists for the probe-attribute test: the walk only tags an
    // ancestor that COULD be hosting a closed shadow root, which means a
    // shadow-capable element above the one being measured. Measuring <body>
    // tags nothing, because its only ancestor is <html>.
    if ((req.url ?? '') === '/nested') {
      res.end('<html><body><div id="wrap"><span id="probe-me">nested</span></div></body></html>');
      return;
    }
    res.end('<html><body>real server</body></html>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

after(async () => {
  await browserManager.close();
  await new Promise<void>(resolve => server.close(() => resolve()));
});

function makeStore() {
  const sessions = new SessionStore(browserManager);
  const handlers = createToolHandlers(sessions, {
    debugPort: 0,
    screenshotCacheDir: '/dev/null/unused',
    screenshotCacheTtlMs: 1000
  });
  return { sessions, handlers };
}

function structured<T>(result: unknown): T {
  return (result as { structuredContent: T }).structuredContent;
}

/** Creates a session and hands back the real BrowserContext behind it, for use as an oracle. */
async function sessionWithContext(handlers: ToolHandlers): Promise<{ sessionId: string; context: BrowserContext }> {
  const known = new Set(browser.contexts());
  const created = structured<{ sessionId: string }>(await handlers.create_session({}));
  const context = browser.contexts().find(candidate => !known.has(candidate));
  assert.ok(context, 'could not identify the context this session opened');
  return { sessionId: created.sessionId, context: context! };
}

/** Whether a CDP session is still attached to Chromium, asked of Chromium rather than of our own bookkeeping. */
async function stillAttached(cdp: CDPSession): Promise<boolean> {
  try {
    await cdp.send('Runtime.evaluate', { expression: '1+1' });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// A CDP session attached before it was recorded
// ---------------------------------------------------------------------------

test('a CDP attach that fails half way leaves no session attached to the browser', async () => {
  const { sessions, handlers } = makeStore();
  const { sessionId, context } = await sessionWithContext(handlers);
  await handlers.navigate({ sessionId, url: `${base}/page` });

  // Every session handed out here is a REAL, genuinely attached CDP session;
  // only the one call that is supposed to fail is faked, so what is measured
  // afterwards is real attachment state rather than a mock's memory.
  const created: CDPSession[] = [];
  let failNextEnable = true;
  const realNewCDPSession = context.newCDPSession.bind(context);
  (context as unknown as { newCDPSession: (page: Page) => Promise<CDPSession> }).newCDPSession = async page => {
    const real = await realNewCDPSession(page);
    created.push(real);
    const realSend = real.send.bind(real);
    (real as unknown as { send: (m: string, p?: unknown) => Promise<unknown> }).send = async (method, params) => {
      if (method === 'Network.enable' && failNextEnable) {
        failNextEnable = false;
        throw new Error('simulated Network.enable failure');
      }
      return (realSend as unknown as (m: string, p?: unknown) => Promise<unknown>)(method, params);
    };
    return real;
  };

  await assert.rejects(
    () => handlers.set_network_conditions({ sessionId, preset: 'slow-3g' }),
    /simulated Network.enable failure/
  );
  assert.equal(created.length, 1, 'the attach really did happen before the failure');

  // The oracle: ask the orphan to do work. Only a session still attached to
  // Chromium can answer. Before this fix it answered, and went on answering
  // until the whole session was released, on a daemon shared machine-wide.
  assert.equal(
    await stillAttached(created[0]!),
    false,
    'a CDP session whose Network.enable failed must be detached, not left live and unreachable'
  );

  // And the retry must produce a working attach rather than piling a second
  // live session onto the same page.
  await handlers.set_network_conditions({ sessionId, preset: 'slow-3g' });
  assert.equal(await stillAttached(created[1]!), true, 'the successful retry keeps its session');

  await handlers.release_session({ sessionId });
  await sessions.closeAll();
});

test('the failed attach leaves nothing behind in the throttle bookkeeping either', async () => {
  const { sessions, handlers } = makeStore();
  const { sessionId, context } = await sessionWithContext(handlers);
  await handlers.navigate({ sessionId, url: `${base}/page` });

  let failNextEnable = true;
  const realNewCDPSession = context.newCDPSession.bind(context);
  (context as unknown as { newCDPSession: (page: Page) => Promise<CDPSession> }).newCDPSession = async page => {
    const real = await realNewCDPSession(page);
    const realSend = real.send.bind(real);
    (real as unknown as { send: (m: string, p?: unknown) => Promise<unknown> }).send = async (method, params) => {
      if (method === 'Network.enable' && failNextEnable) {
        failNextEnable = false;
        throw new Error('simulated Network.enable failure');
      }
      return (realSend as unknown as (m: string, p?: unknown) => Promise<unknown>)(method, params);
    };
    return real;
  };

  await assert.rejects(() => handlers.set_network_conditions({ sessionId, preset: 'slow-3g' }));

  // A session recorded but never enabled would be handed to
  // emulateNetworkConditions by the next sync as though it were ready. The
  // observable form of that: the retry must actually throttle rather than
  // silently succeeding against a half-built session.
  const applied = structured<{ appliedToPageIds: string[]; failedPageIds?: string[] }>(
    await handlers.set_network_conditions({ sessionId, preset: 'slow-3g' })
  );
  assert.ok(applied.appliedToPageIds.length > 0, 'the retry must genuinely reach the tab');
  assert.equal(applied.failedPageIds, undefined, 'and must not report a tab it could not reach');

  await handlers.release_session({ sessionId });
  await sessions.closeAll();
});

// ---------------------------------------------------------------------------
// A route rule spliced out before it was unrouted
// ---------------------------------------------------------------------------

async function bodyText(handlers: ToolHandlers, sessionId: string): Promise<string> {
  const read = structured<{ result: string }>(
    await handlers.evaluate({ sessionId, expression: 'document.body.textContent' })
  );
  return read.result;
}

test('a failed unroute leaves the rule removable instead of stranding the interceptor forever', async () => {
  const { sessions, handlers } = makeStore();
  const { sessionId, context } = await sessionWithContext(handlers);

  const rule = structured<{ ruleId: string }>(
    await handlers.add_route_rule({
      sessionId,
      urlGlob: '**/page',
      action: 'fulfill',
      status: 200,
      contentType: 'text/html',
      body: '<html><body>MOCKED</body></html>'
    })
  );

  await handlers.navigate({ sessionId, url: `${base}/page` });
  assert.equal(await bodyText(handlers, sessionId), 'MOCKED', 'the mock must be in force to begin with');

  const realUnroute = context.unroute.bind(context);
  (context as unknown as { unroute: () => Promise<void> }).unroute = async () => {
    throw new Error('simulated unroute failure');
  };
  await assert.rejects(
    () => handlers.remove_route_rule({ sessionId, ruleId: rule.ruleId }),
    /simulated unroute failure/
  );

  // The rule record holds the ONLY reference to the handler Playwright needs
  // in order to unregister the interceptor. Discarding it on a failed unroute
  // left the route mocked for the life of the context with nothing able to
  // take it off.
  const still = structured<{ rules: { ruleId: string }[] }>(await handlers.list_route_rules({ sessionId }));
  assert.equal(still.rules.length, 1, 'the rule must still be tracked, so the removal can be retried');
  assert.equal(still.rules[0]!.ruleId, rule.ruleId);

  (context as unknown as { unroute: typeof realUnroute }).unroute = realUnroute;
  await handlers.remove_route_rule({ sessionId, ruleId: rule.ruleId });

  // The oracle that matters: what actually answers the request now. Asserting
  // that the tool reported a removal would prove nothing about the browser.
  await handlers.navigate({ sessionId, url: `${base}/page` });
  assert.equal(
    await bodyText(handlers, sessionId),
    'real server',
    'once the unroute succeeds the real server must answer, not the mock'
  );

  await handlers.release_session({ sessionId });
  await sessions.closeAll();
});

// ---------------------------------------------------------------------------
// Session network state published before its close hook existed
// ---------------------------------------------------------------------------

test('network state is not published until the listener that removes it exists', async () => {
  const { sessions, handlers } = makeStore();
  const { sessionId, context } = await sessionWithContext(handlers);
  const before = routeStateSessionCount();

  // If the entry were published first, a throwing addListener would strand it
  // in a module-level map for the life of the daemon, with no session left to
  // key a cleanup on.
  const realOnce = context.once.bind(context);
  (context as unknown as { once: () => void }).once = () => {
    throw new Error('simulated listener registration failure');
  };
  await assert.rejects(
    () => handlers.set_offline({ sessionId, offline: true }),
    /simulated listener registration failure/
  );
  (context as unknown as { once: typeof realOnce }).once = realOnce;

  assert.equal(
    routeStateSessionCount(),
    before,
    'a session whose state could not be wired up must leave no entry behind'
  );

  await handlers.release_session({ sessionId });
  await sessions.closeAll();
});

test('a released session leaves no network state behind, the ordinary path', async () => {
  const { sessions, handlers } = makeStore();
  const { sessionId } = await sessionWithContext(handlers);
  const before = routeStateSessionCount();
  await handlers.set_offline({ sessionId, offline: true });
  assert.equal(routeStateSessionCount(), before + 1, 'the session should hold state while it is alive');
  await handlers.release_session({ sessionId });
  // The close hook is what removes it, and it fires asynchronously.
  const deadline = Date.now() + 5000;
  while (routeStateSessionCount() !== before && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(routeStateSessionCount(), before, 'releasing the session must drop its network state');
  await sessions.closeAll();
});

// ---------------------------------------------------------------------------
// The input lock, whose failure mode is a permanent deadlock
// ---------------------------------------------------------------------------

test('the input lock always drains, so a session can never be left permanently unable to take input', async () => {
  const { sessions, handlers } = makeStore();
  const created = structured<{ sessionId: string }>(await handlers.create_session({}));
  const sessionId = created.sessionId;
  await handlers.navigate({ sessionId, url: `${base}/page` });

  // Input-serialised tools queue behind each other per session. A lock
  // published but never released would wedge every later one forever, so the
  // property under test is that the queue keeps draining, including after a
  // call that failed.
  await assert.rejects(
    () => handlers.click({ sessionId, selector: '#does-not-exist' }),
    'the failing input call must actually fail'
  );

  const settled = await Promise.all([
    handlers.press_key({ sessionId, key: 'a' }).then(() => 'ok', () => 'failed'),
    handlers.press_key({ sessionId, key: 'b' }).then(() => 'ok', () => 'failed'),
    handlers.press_key({ sessionId, key: 'c' }).then(() => 'ok', () => 'failed')
  ]);
  assert.deepEqual(settled, ['ok', 'ok', 'ok'], 'every queued input call must still complete after a failed one');

  // And one more afterwards, to catch a lock that drained the batch but left
  // the chain behind.
  await handlers.press_key({ sessionId, key: 'd' });

  await handlers.release_session({ sessionId });
  await sessions.closeAll();
});

// ---------------------------------------------------------------------------
// computed_style's probe attribute, left on a user's DOM
// ---------------------------------------------------------------------------

test('computed_style takes its probe attribute back off the page even when the read throws', async () => {
  const { sessions, handlers } = makeStore();
  const created = structured<{ sessionId: string }>(await handlers.create_session({}));
  const sessionId = created.sessionId;
  await handlers.navigate({ sessionId, url: `${base}/nested` });

  const target = sessions.resolve(sessionId);
  const page = target.page;

  // The probe attribute is stamped onto the page's own elements by the read
  // itself, which runs through Locator.evaluateAll rather than page.evaluate,
  // so that is what has to fail. The REAL read runs first and really tags the
  // DOM; only the return is replaced by a throw, which is exactly the shape
  // of a frame detaching or a navigation landing mid-read.
  const locatorPrototype = Object.getPrototypeOf(page.locator('body')) as {
    evaluateAll: (...a: unknown[]) => Promise<unknown>;
  };
  const realEvaluateAll = locatorPrototype.evaluateAll;
  let tripped = false;
  let ambiguousSeen = 0;
  locatorPrototype.evaluateAll = async function patched(this: unknown, ...args: unknown[]) {
    const result = await realEvaluateAll.apply(this, args);
    const probes = Array.isArray(result)
      ? (result as { ambiguousShadowHosts?: number }[]).filter(
          entry => entry !== null && typeof entry === 'object' && 'ambiguousShadowHosts' in entry
        )
      : [];
    if (!tripped && probes.length > 0) {
      // Recorded so the test can assert it really did tag something. Without
      // this the whole test passes vacuously on a page with nothing to tag,
      // which is exactly how its first version proved nothing.
      ambiguousSeen = probes.reduce((total, probe) => total + (probe.ambiguousShadowHosts ?? 0), 0);
      tripped = true;
      throw new Error('simulated failure after the page was tagged');
    }
    return result;
  };

  try {
    await assert.rejects(
      () => handlers.computed_style({ sessionId, selector: '#probe-me' }),
      /simulated failure after the page was tagged/
    );
  } finally {
    // Restored immediately: this patches a shared prototype, so leaving it in
    // place would corrupt every later test in this process.
    locatorPrototype.evaluateAll = realEvaluateAll;
  }
  assert.ok(tripped, 'the read must genuinely have run and tagged before failing');
  assert.ok(
    ambiguousSeen > 0,
    'the fixture must be one the walk actually tags, or this test would pass without ever exercising the cleanup'
  );

  // The oracle is the page's own DOM, read back through a channel the failed
  // call never touched. harborage promises to put the page back as it found
  // it, and that promise cannot hold only when nothing goes wrong.
  const leftBehind = await page.evaluate(
    () => document.querySelectorAll('[data-harborage-closed-host-probe]').length
  );
  assert.equal(leftBehind, 0, 'harborage must not leave its own probe attribute on a page it does not own');

  await handlers.release_session({ sessionId });
  await sessions.closeAll();
});
