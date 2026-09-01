import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';

import { BrowserManager } from '../src/daemon/browserManager.js';
import { SessionStore } from '../src/daemon/sessions.js';
import { createToolHandlers } from '../src/daemon/tools/handlers.js';
import { getFreePort } from './helpers.js';

/**
 * The finding this file covers: a Vite-style dev server's own module-chunk
 * traffic fills the network ring inside the first second of a page load,
 * evicting the one request an agent actually cared about, and
 * `total: 200, returned: 0` used to read exactly like a clean "that never
 * happened" result. Two fixes, tested here: eviction is now counted and
 * reported (`dropped`), and a capture filter can keep noise out of the ring
 * before it ever gets a chance to evict anything (`networkCaptureFilter` /
 * `set_network_capture_filter`).
 *
 * Buffer sizes are kept tiny (6 entries) rather than generating 200+ real
 * requests: the ring's own arithmetic does not care how big `max` is, only
 * that entries arrive faster than it can hold them.
 */

interface NetworkPayload {
  total: number;
  returned: number;
  dropped: number;
  filteredAtCapture: number;
  requests: { direction: 'request' | 'response'; url: string; method?: string; status?: number }[];
}

function structured(result: unknown): NetworkPayload {
  return (result as { structuredContent: NetworkPayload }).structuredContent;
}

let browserManager: BrowserManager;
let server: Server;
let base: string;

before(async () => {
  const debugPort = await getFreePort();
  browserManager = new BrowserManager(debugPort);

  // Every path answers fast and identically: the point of this fixture is
  // request VOLUME, not response content.
  server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

after(async () => {
  await browserManager.close();
  await new Promise<void>(resolve => server.close(() => resolve()));
});

function makeStore(networkBufferSize: number) {
  const sessions = new SessionStore(browserManager, { network: networkBufferSize });
  const handlers = createToolHandlers(sessions, {
    debugPort: 0,
    screenshotCacheDir: '/dev/null/unused',
    screenshotCacheTtlMs: 1000
  });
  return { sessions, handlers };
}

/**
 * Fetches `/keep` and awaits it BEFORE firing `noiseCount` concurrent noise
 * fetches, so `/keep`'s request and response entries are always the two
 * oldest in the ring by the time this resolves. `evaluate` awaits the
 * returned promise, so the tool call itself does not resolve until every
 * fetch (keep and noise alike) has settled: no polling or sleep needed.
 */
function floodExpression(noiseCount: number): string {
  return `(async () => {
    await fetch('/keep').catch(() => {});
    const noise = [];
    for (let i = 0; i < ${noiseCount}; i++) noise.push(fetch('/noise/' + i).catch(() => {}));
    await Promise.all(noise);
    return 'flooded';
  })()`;
}

test('a flood with no capture filter evicts the earliest entries, and the ring reports how many it dropped', async () => {
  const { sessions, handlers } = makeStore(6);
  const { sessionId } = await sessions.createSession();
  await sessions.resolve(sessionId).page.goto(`${base}/`);
  await handlers.evaluate({ sessionId, expression: floodExpression(30) });

  const payload = structured(await handlers.list_network_requests({ sessionId }));

  assert.ok(payload.total <= 6, `ring should never hold more than its 6-entry limit, held ${payload.total}`);
  assert.ok(payload.dropped > 0, 'a 62-entry flood into a 6-entry ring must report a non-zero drop count');
  assert.ok(
    !payload.requests.some(r => r.url.includes('/keep')),
    '/keep was the earliest traffic, so a plain 6-entry ring must have evicted it: total: 6, returned: 0 for it ' +
      'is exactly the silent false pass this buffer now has to be caught by dropped instead'
  );
  // No capture filter was set, so every one of the 62 entries reached the
  // ring; every eviction here is pure overflow, not exclusion.
  assert.equal(payload.filteredAtCapture, 0);

  await sessions.releaseSession(sessionId);
});

test('a capture filter set at create_session keeps the interesting entry alive through the same flood', async () => {
  const { sessions, handlers } = makeStore(6);
  const { sessionId } = await sessions.createSession({ networkCaptureFilter: { urlIncludes: '/keep' } });
  await sessions.resolve(sessionId).page.goto(`${base}/`);
  await handlers.evaluate({ sessionId, expression: floodExpression(30) });

  const payload = structured(await handlers.list_network_requests({ sessionId }));

  assert.ok(
    payload.requests.some(r => r.url.includes('/keep') && r.direction === 'request'),
    '/keep\'s request entry must survive: noise never entered the ring, so it never had anything to evict'
  );
  assert.ok(
    payload.requests.some(r => r.url.includes('/keep') && r.direction === 'response'),
    '/keep\'s response entry must survive for the same reason'
  );
  assert.equal(payload.total, 2, 'only /keep\'s request and response should ever have reached the ring');
  assert.equal(payload.dropped, 0, 'a ring that never received more than 2 entries has nothing to evict');
  assert.ok(payload.filteredAtCapture > 0, 'the 60 noise entries must show up as excluded at capture, not silently gone');

  await sessions.releaseSession(sessionId);
});

test('the capture filter defaults to off, so a session with none set buffers everything it always did', async () => {
  const { sessions, handlers } = makeStore(200);
  const { sessionId } = await sessions.createSession();
  await sessions.resolve(sessionId).page.goto(`${base}/`);
  await handlers.evaluate({
    sessionId,
    expression: `Promise.all([fetch('/a'), fetch('/b'), fetch('/c')].map(p => p.catch(() => {}))).then(() => 'ok')`
  });

  const payload = structured(await handlers.list_network_requests({ sessionId }));

  assert.equal(payload.filteredAtCapture, 0, 'no capture filter means nothing is excluded before buffering');
  for (const path of ['/a', '/b', '/c']) {
    assert.ok(
      payload.requests.some(r => r.url.endsWith(path) && r.direction === 'request'),
      `expected ${path}'s request entry to be buffered with no filter in effect`
    );
  }

  await sessions.releaseSession(sessionId);
});

test('set_network_capture_filter changes what a live session captures from that point on', async () => {
  const { sessions, handlers } = makeStore(200);
  const { sessionId } = await sessions.createSession();
  await sessions.resolve(sessionId).page.goto(`${base}/`);

  await handlers.evaluate({ sessionId, expression: `fetch('/before-a').catch(() => {})` });

  const armed = await handlers.set_network_capture_filter({ sessionId, urlIncludes: '/keep-only' });
  assert.equal((armed as { structuredContent: { capturing: string } }).structuredContent.capturing, 'filtered');

  await handlers.evaluate({
    sessionId,
    expression: `Promise.all([fetch('/before-b'), fetch('/keep-only-x')].map(p => p.catch(() => {}))).then(() => 'ok')`
  });

  const afterFilter = structured(await handlers.list_network_requests({ sessionId }));
  assert.ok(
    afterFilter.requests.some(r => r.url.includes('/before-a')),
    'traffic captured before the filter was armed must not retroactively disappear'
  );
  assert.ok(
    !afterFilter.requests.some(r => r.url.includes('/before-b')),
    'traffic after the filter was armed that does not match it must never reach the ring'
  );
  assert.ok(
    afterFilter.requests.some(r => r.url.includes('/keep-only-x')),
    'traffic after the filter was armed that matches it must still be captured'
  );

  const cleared = await handlers.set_network_capture_filter({ sessionId });
  assert.equal((cleared as { structuredContent: { capturing: string } }).structuredContent.capturing, 'everything');

  await handlers.evaluate({ sessionId, expression: `fetch('/after-reset').catch(() => {})` });
  const afterReset = structured(await handlers.list_network_requests({ sessionId }));
  assert.ok(
    afterReset.requests.some(r => r.url.includes('/after-reset')),
    'removing the filter (calling with no fields) must go back to capturing everything'
  );

  await sessions.releaseSession(sessionId);
});

test('clear resets the drop counter only on a genuine whole-buffer clear, never on a narrowed one', async () => {
  const { sessions, handlers } = makeStore(6);
  const { sessionId } = await sessions.createSession();
  await sessions.resolve(sessionId).page.goto(`${base}/`);
  await handlers.evaluate({ sessionId, expression: floodExpression(30) });

  const baseline = structured(await handlers.list_network_requests({ sessionId }));
  assert.ok(baseline.dropped > 0, 'setup: the flood must have dropped something for this test to mean anything');

  // A clear narrowed by a filter that matches nothing removes nothing, and
  // must leave the drop counter alone: it did not close out the whole
  // buffer's observation window, so resetting it would erase the "you lost
  // N entries" signal for everything still sitting in the buffer unread.
  const narrowClear = structured(
    await handlers.list_network_requests({ sessionId, urlIncludes: 'nothing-matches-this', clear: true })
  );
  assert.equal(narrowClear.returned, 0);
  assert.equal(narrowClear.dropped, baseline.dropped, 'a narrowed clear must report, not reset, the drop count');

  const stillThere = structured(await handlers.list_network_requests({ sessionId }));
  assert.equal(stillThere.dropped, baseline.dropped, 'a narrowed clear must not have reset the counter for later reads either');

  // An unfiltered, unscoped clear IS the "wipe the slate, start a fresh
  // window" call. It still reports the count from the window it is closing
  // out (so this exact response is not itself a false "0 dropped" pass),
  // but every read after it starts from zero.
  const fullClear = structured(await handlers.list_network_requests({ sessionId, clear: true }));
  assert.equal(fullClear.dropped, baseline.dropped, 'the clearing call itself must still report what the window it closed out lost');

  const afterFullClear = structured(await handlers.list_network_requests({ sessionId }));
  assert.equal(afterFullClear.dropped, 0, 'a genuine whole-buffer clear must reset the drop counter for the next window');

  await sessions.releaseSession(sessionId);
});
