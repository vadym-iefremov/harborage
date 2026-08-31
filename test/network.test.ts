import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';

import { BrowserManager } from '../src/daemon/browserManager.js';
import { SessionStore } from '../src/daemon/sessions.js';
import { createToolHandlers } from '../src/daemon/tools/handlers.js';
import { routeStateSessionCount } from '../src/daemon/tools/defs/network.js';
import { getFreePort } from './helpers.js';

/**
 * A real local server, not a stub, because the whole point of a mock is that
 * the real response was replaced. Every endpoint counts its own hits, so a
 * test can assert the difference between "the mock returned 413" and "the
 * mock returned 413 AND the server was never asked", which is the only way to
 * tell interception from coincidence.
 */
const hits: Record<string, number> = {};
/** The last request body and headers the server actually received, for continue-override tests. */
let lastSeen: { url: string; method: string; body: string; headers: Record<string, string | string[] | undefined> } | null =
  null;

const PAGE_HTML = `<!doctype html>
<html><body><h1 id="title">network fixture</h1></body></html>`;

/** A real 1x1 PNG, so an <img> that is not blocked genuinely fires onload. */
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

/** 100 KB, enough that a 400 kbit/s cap turns a 3ms fetch into a multi-second one. */
const BIG_BODY = 'x'.repeat(100 * 1024);

let server: Server;
let baseUrl: string;
let browserManager: BrowserManager;
let sessions: SessionStore;
let handlers: ReturnType<typeof createToolHandlers>;

before(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    hits[path] = (hits[path] ?? 0) + 1;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      lastSeen = {
        url: req.url ?? '',
        method: req.method ?? '',
        body: Buffer.concat(chunks).toString('utf8'),
        headers: req.headers
      };
      res.setHeader('cache-control', 'no-store');
      if (path === '/big') {
        res.setHeader('content-type', 'text/plain');
        res.end(BIG_BODY);
        return;
      }
      if (path.startsWith('/api/')) {
        res.setHeader('content-type', 'text/plain');
        res.end(`REAL ${req.method} ${path}`);
        return;
      }
      if (path === '/pixel.png') {
        res.setHeader('content-type', 'image/png');
        res.end(ONE_PIXEL_PNG);
        return;
      }
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(PAGE_HTML);
    });
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

/** The `structuredContent` of a tool result, typed loosely: these tests assert on individual fields. */
function payload(result: unknown): Record<string, any> {
  return (result as { structuredContent: Record<string, any> }).structuredContent;
}

/** A fresh session already sitting on the fixture page. */
async function freshSession(): Promise<string> {
  const { sessionId } = await sessions.createSession();
  await handlers.navigate({ sessionId, url: baseUrl });
  return sessionId;
}

/** Fetches a path from inside the page and returns "<status>:<body>" or "FAILED:<message>". */
async function fetchInPage(sessionId: string, path: string, init?: string): Promise<string> {
  const expression = `(async () => {
    try {
      const r = await fetch(${JSON.stringify(path)}, ${init ?? '{ cache: "no-store" }'});
      return r.status + ':' + (await r.text());
    } catch (e) { return 'FAILED:' + e.message; }
  })()`;
  return payload(await handlers.evaluate({ sessionId, expression })).result as string;
}

function hitsOn(path: string): number {
  return hits[path] ?? 0;
}

// ---------------------------------------------------------------------------
// Route mocking: fulfil
// ---------------------------------------------------------------------------

test('a fulfil rule replaces the real response and the real server is never asked', async () => {
  const sessionId = await freshSession();
  const before413 = hitsOn('/api/upload');

  const added = payload(
    await handlers.add_route_rule({
      sessionId,
      urlGlob: '**/api/upload',
      action: 'fulfill',
      status: 413,
      body: 'payload too large',
      contentType: 'text/plain'
    })
  );
  assert.equal(typeof added.ruleId, 'string', 'add_route_rule must hand back a rule id to remove it by');

  const result = await fetchInPage(sessionId, '/api/upload');
  assert.equal(result, '413:payload too large', 'the mocked status and body must be what the page actually received');
  assert.equal(hitsOn('/api/upload'), before413, 'a fulfilled request must never reach the real server');

  await sessions.releaseSession(sessionId);
});

test('a fulfilled response is visible in list_network_requests with the mocked status', async () => {
  const sessionId = await freshSession();
  await handlers.add_route_rule({ sessionId, urlGlob: '**/api/mocked', action: 'fulfill', status: 503, body: 'nope' });
  await fetchInPage(sessionId, '/api/mocked');

  const entries = payload(await handlers.list_network_requests({ sessionId, urlIncludes: '/api/mocked' }));
  const statuses = (entries.requests as { direction: string; status?: number }[])
    .filter(e => e.direction === 'response')
    .map(e => e.status);
  assert.deepEqual(statuses, [503], 'the mocked status must show up in the network buffer, not the real one');

  await sessions.releaseSession(sessionId);
});

test('fulfil sets response headers the page can read', async () => {
  const sessionId = await freshSession();
  await handlers.add_route_rule({
    sessionId,
    urlGlob: '**/api/headers',
    action: 'fulfill',
    status: 200,
    body: 'ok',
    headers: { 'x-retry-after': '42' }
  });
  const header = payload(
    await handlers.evaluate({
      sessionId,
      expression: `(async () => (await fetch('/api/headers')).headers.get('x-retry-after'))()`
    })
  ).result;
  assert.equal(header, '42');
  await sessions.releaseSession(sessionId);
});

// ---------------------------------------------------------------------------
// Route mocking: abort
// ---------------------------------------------------------------------------

test('an abort rule fails the request and leaves no response entry in the buffer', async () => {
  const sessionId = await freshSession();
  const before = hitsOn('/api/dead');
  await handlers.add_route_rule({
    sessionId,
    urlGlob: '**/api/dead',
    action: 'abort',
    errorCode: 'connectionrefused'
  });

  const result = await fetchInPage(sessionId, '/api/dead');
  assert.match(result, /^FAILED:/, 'an aborted request must reject in the page, not resolve');
  assert.equal(hitsOn('/api/dead'), before, 'an aborted request must never reach the real server');

  const entries = payload(await handlers.list_network_requests({ sessionId, urlIncludes: '/api/dead' }));
  const directions = (entries.requests as { direction: string }[]).map(e => e.direction);
  assert.ok(directions.includes('request'), 'the request itself is still buffered');
  assert.ok(!directions.includes('response'), 'an aborted request produces no response, so none must be buffered');

  await sessions.releaseSession(sessionId);
});

// ---------------------------------------------------------------------------
// Route mocking: continue with overrides
// ---------------------------------------------------------------------------

test('a continue rule rewrites method, headers, body and URL on the way to the real server', async () => {
  const sessionId = await freshSession();
  await handlers.add_route_rule({
    sessionId,
    urlGlob: '**/api/original',
    action: 'continue',
    overrideUrl: `${baseUrl}api/rewritten`,
    overrideMethod: 'PUT',
    overrideHeaders: { 'x-injected': 'yes' },
    overridePostData: 'rewritten-body'
  });

  const result = await fetchInPage(sessionId, '/api/original', `{ method: 'POST', body: 'original-body', cache: 'no-store' }`);
  assert.equal(result, '200:REAL PUT /api/rewritten', 'the override must reach the real server, not the original request');
  assert.equal(lastSeen?.body, 'rewritten-body');
  assert.equal(lastSeen?.headers['x-injected'], 'yes');

  await sessions.releaseSession(sessionId);
});

// ---------------------------------------------------------------------------
// Filters and the times budget
// ---------------------------------------------------------------------------

test('a rule restricted by method leaves other methods alone', async () => {
  const sessionId = await freshSession();
  await handlers.add_route_rule({
    sessionId,
    urlGlob: '**/api/methods',
    action: 'fulfill',
    status: 500,
    body: 'boom',
    methods: ['POST']
  });

  assert.equal(await fetchInPage(sessionId, '/api/methods', `{ method: 'POST', cache: 'no-store' }`), '500:boom');
  assert.equal(
    await fetchInPage(sessionId, '/api/methods'),
    '200:REAL GET /api/methods',
    'a GET must fall through to the real server when the rule only covers POST'
  );

  const rules = payload(await handlers.list_route_rules({ sessionId })).rules as Record<string, any>[];
  assert.equal(rules[0]?.matchCount, 1, 'only the POST counts as a match');
  assert.equal(rules[0]?.skippedByFilter, 1, 'the GET must be reported as filtered out, not silently invisible');

  await sessions.releaseSession(sessionId);
});

test('a rule restricted by resource type ignores requests of other types', async () => {
  const sessionId = await freshSession();
  await handlers.add_route_rule({
    sessionId,
    // Trailing * on purpose: a glob ending at ".png" would not match
    // "/pixel.png?asimage", and the rule would silently intercept nothing.
    urlGlob: '**/pixel.png*',
    action: 'abort',
    resourceTypes: ['image']
  });

  // A fetch() for the same URL is resourceType "fetch", not "image".
  assert.match(
    await fetchInPage(sessionId, '/pixel.png'),
    /^200:/,
    'a fetch for the same URL is resourceType "fetch", so the image-only rule must leave it alone'
  );

  const loadImage = (query: string) => `(async () => new Promise(res => {
        const img = new Image();
        img.onload = () => res('loaded');
        img.onerror = () => res('blocked');
        img.src = '/pixel.png?' + ${JSON.stringify(query)};
      }))()`;

  const blocked = payload(await handlers.evaluate({ sessionId, expression: loadImage('asimage') })).result;
  assert.equal(blocked, 'blocked', 'a real <img> request must be aborted by the image-only rule');

  // Proof the abort is what blocked it rather than a broken fixture: the same
  // image loads fine in a session with no rule.
  const clean = await freshSession();
  const loaded = payload(await handlers.evaluate({ sessionId: clean, expression: loadImage('control') })).result;
  assert.equal(loaded, 'loaded', 'the fixture image must load when nothing is intercepting it');

  const rules = payload(await handlers.list_route_rules({ sessionId })).rules as Record<string, any>[];
  assert.equal(rules[0]?.matchCount, 1, 'exactly the image request fired the rule');
  assert.equal(rules[0]?.skippedByFilter, 1, 'the fetch must be reported as filtered out by resource type');

  await sessions.releaseSession(clean);
  await sessions.releaseSession(sessionId);
});

test('times limits how often a rule fires, then traffic falls through to the real server', async () => {
  const sessionId = await freshSession();
  await handlers.add_route_rule({
    sessionId,
    urlGlob: '**/api/twice',
    action: 'fulfill',
    status: 429,
    body: 'slow down',
    times: 2
  });

  assert.equal(await fetchInPage(sessionId, '/api/twice'), '429:slow down');
  assert.equal(await fetchInPage(sessionId, '/api/twice'), '429:slow down');
  assert.equal(await fetchInPage(sessionId, '/api/twice'), '200:REAL GET /api/twice', 'the third call is past the budget');

  const rules = payload(await handlers.list_route_rules({ sessionId })).rules as Record<string, any>[];
  assert.equal(rules[0]?.matchCount, 2);
  assert.equal(rules[0]?.remaining, 0, 'an exhausted rule must say so rather than looking active');
  assert.equal(rules[0]?.skippedAfterLimit, 1);

  await sessions.releaseSession(sessionId);
});

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

test('when two rules match, the most recently added one wins and the older one is not consulted', async () => {
  const sessionId = await freshSession();
  const broad = payload(
    await handlers.add_route_rule({ sessionId, urlGlob: '**/api/**', action: 'fulfill', status: 500, body: 'broad' })
  );
  const specific = payload(
    await handlers.add_route_rule({ sessionId, urlGlob: '**/api/special', action: 'fulfill', status: 200, body: 'specific' })
  );

  assert.equal(await fetchInPage(sessionId, '/api/special'), '200:specific', 'the later, narrower rule must win');
  assert.equal(await fetchInPage(sessionId, '/api/other'), '500:broad', 'the broad rule still covers everything else');

  const listed = payload(await handlers.list_route_rules({ sessionId }));
  const rules = listed.rules as Record<string, any>[];
  assert.equal(rules[0]?.ruleId, specific.ruleId, 'list_route_rules must list rules in evaluation order, newest first');
  assert.equal(rules[1]?.ruleId, broad.ruleId);
  assert.equal(rules[0]?.matchCount, 1);
  assert.equal(rules[1]?.matchCount, 1);

  await sessions.releaseSession(sessionId);
});

// ---------------------------------------------------------------------------
// Visibility of a rule that never fired
// ---------------------------------------------------------------------------

test('a rule that never matched is flagged, not left looking like a working mock', async () => {
  const sessionId = await freshSession();
  await handlers.add_route_rule({ sessionId, urlGlob: '**/api/typo-in-my-url', action: 'fulfill', status: 500 });
  await fetchInPage(sessionId, '/api/real-endpoint');

  const listed = payload(await handlers.list_route_rules({ sessionId }));
  const rules = listed.rules as Record<string, any>[];
  assert.equal(rules[0]?.matchCount, 0);
  assert.equal(rules[0]?.neverMatched, true, 'a never-matched rule must carry an explicit flag');
  assert.equal(listed.neverMatchedCount, 1);
  assert.match(String(listed.note), /never matched/i, 'the result must say plainly that a mock never intercepted anything');

  await sessions.releaseSession(sessionId);
});

test('remove_route_rule reports the final counts of the rule it removed', async () => {
  const sessionId = await freshSession();
  const added = payload(
    await handlers.add_route_rule({ sessionId, urlGlob: '**/api/counted', action: 'fulfill', status: 204 })
  );
  await fetchInPage(sessionId, '/api/counted');

  const removed = payload(await handlers.remove_route_rule({ sessionId, ruleId: added.ruleId }));
  assert.equal(removed.removed.matchCount, 1, 'removing a rule must report how often it actually fired');
  assert.equal(removed.remaining, 0);

  assert.equal(
    await fetchInPage(sessionId, '/api/counted'),
    '200:REAL GET /api/counted',
    'a removed rule must stop intercepting'
  );

  await sessions.releaseSession(sessionId);
});

test('clear_route_rules removes every rule and reports what each one did', async () => {
  const sessionId = await freshSession();
  await handlers.add_route_rule({ sessionId, urlGlob: '**/api/one', action: 'fulfill', status: 201 });
  await handlers.add_route_rule({ sessionId, urlGlob: '**/api/two', action: 'fulfill', status: 202 });
  await fetchInPage(sessionId, '/api/one');

  const cleared = payload(await handlers.clear_route_rules({ sessionId }));
  assert.equal(cleared.removedCount, 2);
  assert.equal((cleared.removed as Record<string, any>[]).length, 2);
  assert.equal(cleared.neverMatchedCount, 1, 'clearing must still surface the mock that never fired');

  assert.equal(await fetchInPage(sessionId, '/api/one'), '200:REAL GET /api/one');
  assert.equal((payload(await handlers.list_route_rules({ sessionId })).rules as unknown[]).length, 0);

  await sessions.releaseSession(sessionId);
});

// ---------------------------------------------------------------------------
// Argument validation
// ---------------------------------------------------------------------------

test('add_route_rule refuses zero or several URL matchers rather than guessing', async () => {
  const sessionId = await freshSession();
  await assert.rejects(
    () => handlers.add_route_rule({ sessionId, action: 'abort' } as never),
    /exactly one/i,
    'a rule with no URL matcher would silently intercept everything'
  );
  await assert.rejects(
    () => handlers.add_route_rule({ sessionId, urlGlob: '**/a', urlIncludes: 'a', action: 'abort' } as never),
    /exactly one/i
  );
  await assert.rejects(
    () => handlers.add_route_rule({ sessionId, urlMatches: '(unclosed', action: 'abort' } as never),
    /regular expression/i
  );
  await sessions.releaseSession(sessionId);
});

test('remove_route_rule names the unknown id rather than failing quietly', async () => {
  const sessionId = await freshSession();
  await assert.rejects(() => handlers.remove_route_rule({ sessionId, ruleId: 'no-such-rule' }), /no-such-rule/);
  await sessions.releaseSession(sessionId);
});

test('urlIncludes and urlMatches select the same traffic list_network_requests would', async () => {
  const sessionId = await freshSession();
  await handlers.add_route_rule({ sessionId, urlIncludes: '/api/SUBSTRING', action: 'fulfill', status: 200, body: 'sub' });
  assert.equal(await fetchInPage(sessionId, '/api/substring'), '200:sub', 'urlIncludes is case-insensitive, as in list_network_requests');

  await handlers.add_route_rule({ sessionId, urlMatches: '/api/re[0-9]+$', action: 'fulfill', status: 200, body: 're' });
  assert.equal(await fetchInPage(sessionId, '/api/re42'), '200:re');
  assert.equal(await fetchInPage(sessionId, '/api/rex'), '200:REAL GET /api/rex');

  await sessions.releaseSession(sessionId);
});

// ---------------------------------------------------------------------------
// Isolation and lifecycle
// ---------------------------------------------------------------------------

test('one session\'s mocks do not touch another session\'s requests, concurrently', async () => {
  const idA = await freshSession();
  const idB = await freshSession();
  const idC = await freshSession();

  await handlers.add_route_rule({ sessionId: idA, urlGlob: '**/api/shared', action: 'fulfill', status: 418, body: 'A-mock' });
  await handlers.add_route_rule({ sessionId: idB, urlGlob: '**/api/shared', action: 'fulfill', status: 200, body: 'B-mock' });

  const [a, b, c] = await Promise.all([
    fetchInPage(idA, '/api/shared'),
    fetchInPage(idB, '/api/shared'),
    fetchInPage(idC, '/api/shared')
  ]);

  assert.equal(a, '418:A-mock');
  assert.equal(b, '200:B-mock', 'B must get its own mock, not A\'s');
  assert.equal(c, '200:REAL GET /api/shared', 'a session with no rules must reach the real server');

  const rulesA = payload(await handlers.list_route_rules({ sessionId: idA })).rules as Record<string, any>[];
  const rulesB = payload(await handlers.list_route_rules({ sessionId: idB })).rules as Record<string, any>[];
  assert.equal(rulesA.length, 1, 'each session sees only its own rules');
  assert.equal(rulesB.length, 1);
  assert.equal(rulesA[0]?.matchCount, 1);
  assert.equal(rulesB[0]?.matchCount, 1);
  assert.equal((payload(await handlers.list_route_rules({ sessionId: idC })).rules as unknown[]).length, 0);

  await Promise.all([
    sessions.releaseSession(idA),
    sessions.releaseSession(idB),
    sessions.releaseSession(idC)
  ]);
});

test('releasing a session drops its rule state instead of leaking a handler', async () => {
  const before = routeStateSessionCount();
  const sessionId = await freshSession();
  await handlers.add_route_rule({ sessionId, urlGlob: '**/api/leak', action: 'fulfill', status: 200 });
  assert.equal(routeStateSessionCount(), before + 1, 'a session with rules is tracked');

  await sessions.releaseSession(sessionId);
  // The context close event is what clears the entry, and it arrives on the
  // Playwright event loop rather than synchronously with the close call.
  const deadline = Date.now() + 5000;
  while (routeStateSessionCount() !== before && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 25));
  }
  assert.equal(routeStateSessionCount(), before, 'release_session must leave nothing behind in the rule table');

  await assert.rejects(() => handlers.list_route_rules({ sessionId }), /No session with id/);
});

// ---------------------------------------------------------------------------
// Offline
// ---------------------------------------------------------------------------

test('set_offline blocks real requests and reports the state read back from the page', async () => {
  const sessionId = await freshSession();

  const on = payload(await handlers.set_offline({ sessionId, offline: true }));
  assert.equal(on.offline, true);
  assert.equal(on.navigatorOnLine, false, 'the result must carry the state read back from the browser, not the request');
  assert.match(await fetchInPage(sessionId, '/api/offline'), /^FAILED:/);

  const off = payload(await handlers.set_offline({ sessionId, offline: false }));
  assert.equal(off.navigatorOnLine, true);
  assert.equal(await fetchInPage(sessionId, '/api/offline'), '200:REAL GET /api/offline');

  await sessions.releaseSession(sessionId);
});

test('set_offline is context-scoped: a second tab in the same session goes offline too', async () => {
  const sessionId = await freshSession();
  const target = sessions.resolve(sessionId);
  const second = await target.session.context.newPage();
  await second.goto(baseUrl);
  const tabs = await handlers.list_tabs({ sessionId });
  const secondPageId = (payload(tabs).tabs as { pageId: string }[]).map(t => t.pageId).find(id => id !== target.pageId);
  assert.ok(secondPageId, 'the fixture needs a second tab');

  await handlers.set_offline({ sessionId, offline: true });
  const inSecondTab = payload(
    await handlers.evaluate({ sessionId, pageId: secondPageId, expression: 'navigator.onLine' })
  ).result;
  assert.equal(inSecondTab, false, 'offline is a property of the whole browser context, not one tab');

  await handlers.set_offline({ sessionId, offline: false });
  await sessions.releaseSession(sessionId);
});

// ---------------------------------------------------------------------------
// Throttling
// ---------------------------------------------------------------------------

/** Milliseconds a 100 KB fetch takes inside the page. */
async function timeBigFetch(sessionId: string): Promise<number> {
  const ms = payload(
    await handlers.evaluate({
      sessionId,
      timeoutMs: 60_000,
      expression: `(async () => {
        const s = performance.now();
        const r = await fetch('/big?' + Math.random(), { cache: 'no-store' });
        await r.text();
        return performance.now() - s;
      })()`
    })
  ).result as number;
  return ms;
}

test('set_network_conditions really throttles, and clearing it really restores full speed', async () => {
  const sessionId = await freshSession();
  const baseline = await timeBigFetch(sessionId);
  assert.ok(baseline < 500, `the local server should be fast, measured ${Math.round(baseline)}ms`);

  const applied = payload(
    await handlers.set_network_conditions({ sessionId, downloadKbps: 400, uploadKbps: 400, latencyMs: 50 })
  );
  assert.equal(applied.throttling, true);
  assert.equal(applied.downloadKbps, 400, 'the result must report the numbers actually in effect');
  assert.ok((applied.appliedToPageIds as string[]).length >= 1);

  const throttled = await timeBigFetch(sessionId);
  assert.ok(
    throttled > baseline * 5 && throttled > 1000,
    `throttling must be measurable: baseline ${Math.round(baseline)}ms, throttled ${Math.round(throttled)}ms`
  );

  const cleared = payload(await handlers.set_network_conditions({ sessionId, preset: 'none' }));
  assert.equal(cleared.throttling, false);
  const restored = await timeBigFetch(sessionId);
  assert.ok(restored < 500, `clearing must restore full speed, measured ${Math.round(restored)}ms`);

  await sessions.releaseSession(sessionId);
});

test('a named preset resolves to concrete numbers and reports them', async () => {
  const sessionId = await freshSession();
  const applied = payload(await handlers.set_network_conditions({ sessionId, preset: 'slow-3g' }));
  assert.equal(applied.preset, 'slow-3g');
  assert.equal(typeof applied.downloadKbps, 'number');
  assert.ok(applied.latencyMs > 0, 'a slow-3g preset has real latency, and the caller must be told the number');

  await handlers.set_network_conditions({ sessionId, preset: 'none' });
  await sessions.releaseSession(sessionId);
});

test('set_network_conditions refuses an empty or contradictory request', async () => {
  const sessionId = await freshSession();
  await assert.rejects(() => handlers.set_network_conditions({ sessionId }), /preset/i);
  await assert.rejects(
    () => handlers.set_network_conditions({ sessionId, preset: 'slow-3g', downloadKbps: 100 }),
    /preset/i
  );
  await sessions.releaseSession(sessionId);
});

test('going offline while throttled actually blocks traffic, it does not just flip navigator.onLine', async () => {
  // The trap this exists for: Chromium's CDP throttling layer carries its own
  // offline flag, and a plain context.setOffline while that layer is active
  // sets navigator.onLine to false while every request still succeeds. An
  // agent reading the flag would record a passing offline test that proved
  // nothing.
  const sessionId = await freshSession();
  await handlers.set_network_conditions({ sessionId, downloadKbps: 4000, uploadKbps: 4000, latencyMs: 0 });

  const on = payload(await handlers.set_offline({ sessionId, offline: true }));
  assert.equal(on.navigatorOnLine, false);
  assert.match(
    await fetchInPage(sessionId, '/api/throttled-offline'),
    /^FAILED:/,
    'offline must hold even while a throttle profile is active'
  );

  await handlers.set_offline({ sessionId, offline: false });
  assert.equal(await fetchInPage(sessionId, '/api/throttled-offline'), '200:REAL GET /api/throttled-offline');

  await handlers.set_network_conditions({ sessionId, preset: 'none' });
  await sessions.releaseSession(sessionId);
});

test('clearing throttling while offline leaves offline consistently in effect', async () => {
  const sessionId = await freshSession();
  await handlers.set_offline({ sessionId, offline: true });
  await handlers.set_network_conditions({ sessionId, preset: 'slow-3g' });
  const cleared = payload(await handlers.set_network_conditions({ sessionId, preset: 'none' }));
  assert.equal(cleared.offline, true, 'clearing a throttle must not silently drop the offline state');
  assert.equal(cleared.navigatorOnLine, false, 'and must not leave navigator.onLine stale');
  assert.match(await fetchInPage(sessionId, '/api/still-offline'), /^FAILED:/);

  await handlers.set_offline({ sessionId, offline: false });
  await sessions.releaseSession(sessionId);
});

test('throttling reaches a tab opened after it was applied', async () => {
  const sessionId = await freshSession();
  await handlers.set_network_conditions({ sessionId, downloadKbps: 400, uploadKbps: 400, latencyMs: 0 });

  const target = sessions.resolve(sessionId);
  const second = await target.session.context.newPage();
  await second.goto(baseUrl);
  // Give the new-page hook a moment to attach and apply.
  await new Promise(r => setTimeout(r, 500));

  const ms = await second.evaluate(async () => {
    const s = performance.now();
    const r = await fetch('/big?' + Math.random(), { cache: 'no-store' });
    await r.text();
    return performance.now() - s;
  });
  assert.ok(ms > 1000, `a tab opened under an active throttle must be throttled too, measured ${Math.round(ms)}ms`);

  await handlers.set_network_conditions({ sessionId, preset: 'none' });
  await sessions.releaseSession(sessionId);
});

test('network conditions do not leak between sessions', async () => {
  const idA = await freshSession();
  const idB = await freshSession();
  await handlers.set_network_conditions({ sessionId: idA, downloadKbps: 200, uploadKbps: 200, latencyMs: 0 });
  await handlers.set_offline({ sessionId: idA, offline: true });

  assert.match(await fetchInPage(idA, '/api/a-only'), /^FAILED:/);
  assert.equal(await fetchInPage(idB, '/api/b-only'), '200:REAL GET /api/b-only', 'B must be untouched by A\'s offline');
  const msB = await timeBigFetch(idB);
  assert.ok(msB < 500, `B must be untouched by A's throttle, measured ${Math.round(msB)}ms`);

  await handlers.set_offline({ sessionId: idA, offline: false });
  await handlers.set_network_conditions({ sessionId: idA, preset: 'none' });
  await sessions.releaseSession(idA);
  await sessions.releaseSession(idB);
});

test('releasing a session drops its network-conditions state too', async () => {
  const before = routeStateSessionCount();
  const sessionId = await freshSession();
  await handlers.set_network_conditions({ sessionId, preset: 'slow-3g' });
  assert.equal(routeStateSessionCount(), before + 1);

  await sessions.releaseSession(sessionId);
  const deadline = Date.now() + 5000;
  while (routeStateSessionCount() !== before && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 25));
  }
  assert.equal(routeStateSessionCount(), before, 'a released session must leave no held CDP session behind');
});
