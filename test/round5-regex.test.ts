import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, test } from 'node:test';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

import { compileNetworkMatch, matchesNetworkEntry } from '../src/daemon/networkMatch.js';
import type { NetworkEntry } from '../src/daemon/sessions.js';
import { cleanupTempDirs, cliEntry, makeTestConfig } from './helpers.js';

/**
 * The finding this file covers: `urlMatches` took an arbitrary caller-supplied
 * regular expression and ran it, uninterruptibly, on the daemon's event loop,
 * once per network request for the life of a capture filter. Measured on this
 * machine against the unguarded code, with `process.hrtime.bigint()` around the
 * real `matchesNetworkEntry` call and the pattern `^(a+)+$`:
 *
 *     18 a's    1.1 ms
 *     20 a's    4.4 ms
 *     22 a's   17.9 ms
 *     24 a's   71.7 ms
 *     26 a's  284.6 ms
 *
 * Roughly 4x per two added characters, so 34 a's is over two minutes. Node is
 * single threaded and this daemon is shared machine-wide, so that is not one
 * slow tool call: it is every other agent's session, the /health endpoint and
 * the session reaper all frozen for the duration. `RegExp.prototype.test`
 * cannot be interrupted once it has started, so the guard has to refuse the
 * pattern at compile time rather than time-box the match.
 *
 * Sizes here are deliberately kept at or below 26 characters. The point is to
 * be unambiguously above the noise floor (a benign match is microseconds)
 * while an UNGUARDED run of this suite still finishes in seconds rather than
 * putting a two-minute freeze in the test suite of a shared laptop.
 */

/** A pattern whose blowup is anchored, the textbook nested-quantifier shape. */
const RUNAWAY_ANCHORED = '^(a+)+$';
/** The same blowup written so it can actually bite a real `http://` URL. */
const RUNAWAY_URL_SHAPED = '(a+)+$';
/** Catastrophic through alternation overlap, NOT through a nested quantifier. */
const RUNAWAY_ALTERNATION = '(a|a)+$';

/** Wall-clock milliseconds around `fn`, taken with the monotonic clock. */
function measureMs(fn: () => void): number {
  const started = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - started) / 1e6;
}

function entry(url: string): NetworkEntry {
  return { direction: 'request', url, pageId: 'p1', timestamp: Date.now() };
}

// ---------------------------------------------------------------------------
// Oracle 1: measured wall-clock time of one real match
// ---------------------------------------------------------------------------

test('a runaway urlMatches pattern is refused rather than compiled', () => {
  for (const source of [RUNAWAY_ANCHORED, RUNAWAY_URL_SHAPED, RUNAWAY_ALTERNATION]) {
    assert.throws(
      () => compileNetworkMatch({ urlMatches: source }),
      /urlMatches/,
      `expected ${source} to be refused: unguarded, it takes exponential time in the URL length`
    );
  }
});

test('the refusal says what to do about it rather than just saying no', () => {
  let message = '';
  try {
    compileNetworkMatch({ urlMatches: RUNAWAY_ANCHORED });
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  assert.match(message, /urlMatches/, 'the message must name the field the caller wrote');
  assert.ok(message.length > 120, `expected an actionable message, got: ${message}`);
  // A caller has to be able to tell this apart from "your regex does not
  // parse", which is a completely different fix.
  assert.doesNotMatch(message, /not a valid regular expression/);
});

test('a filter that survives compilation matches a URL in bounded time', () => {
  // The property, not a literal millisecond value: an absolute threshold is
  // flaky on a loaded laptop. 20ms is roughly four orders of magnitude above a
  // real match (microseconds) and roughly one below the smallest UNGUARDED
  // blowup this file measured (72ms at 24 characters), so a regression that
  // reintroduces backtracking cannot hide under it.
  const criteria = compileNetworkMatch({ urlMatches: '/api/.*/save$' });
  const url = `http://127.0.0.1:8080/${'a'.repeat(26)}b`;
  const elapsed = measureMs(() => {
    for (let i = 0; i < 100; i++) matchesNetworkEntry(entry(url), criteria);
  });
  assert.ok(elapsed < 20, `100 matches should be sub-millisecond in total; took ${elapsed.toFixed(2)}ms`);
});

test('the guard does not refuse the URL patterns callers actually write', () => {
  const realistic = [
    '/api/.*/save$',
    '^https?://api\\.example\\.com/',
    '\\.(js|css|map)$',
    '/graphql',
    '^https://[^/]+/v[0-9]+/users/[0-9]+$',
    // Bounded repeats around an unambiguous delimiter: an IP-address matcher
    // is the canonical shape that a naive "no quantified group" rule would
    // refuse, and it is not a runaway pattern at all.
    '(\\d{1,3}\\.){3}\\d{1,3}',
    '(?:staging|prod)\\.example\\.com',
    'session_id=[a-f0-9]+'
  ];
  for (const source of realistic) {
    assert.doesNotThrow(() => compileNetworkMatch({ urlMatches: source }), `refused a realistic pattern: ${source}`);
  }
});

test('the guard also refuses the shapes with no nested quantifier at all', () => {
  // These get past the structural rule entirely and are caught only by the
  // compile-time probe. Measured unguarded: (a|a)+$ is 76ms at 20 characters,
  // and (ab|ba|a|b)+c$ is 380ms at 36 characters and 17.2 SECONDS at 44.
  for (const source of ['(a|a)+$', '(ab|ba|a|b)+c$', 'a*a*a*a*a*a*a*a*a*a*$']) {
    assert.throws(() => compileNetworkMatch({ urlMatches: source }), /runaway/, `accepted ${source}`);
  }
});

test('a documented hole in the guard, recorded rather than implied away', () => {
  // The probe feeds the pattern one and two character cycles only, so a
  // pattern whose ambiguity needs a longer cycle passes it. Measured on this
  // machine: (abc|cab|bca|a|b|c)+z$ takes 16ms against 37 characters of
  // repeating "abc" and 534ms against 46, and it is ACCEPTED. This test exists
  // so the limitation is a recorded fact rather than something a reader has to
  // infer from the absence of a test. If a future guard closes this hole, this
  // test is the thing that says so out loud, and flipping it is the point.
  assert.doesNotThrow(() => compileNetworkMatch({ urlMatches: '(abc|cab|bca|a|b|c)+z$' }));
});

test('a regex that does not parse is still reported as a parse error, not as a runaway', () => {
  assert.throws(() => compileNetworkMatch({ urlMatches: '(' }), /not a valid regular expression/);
});

test('every urlMatches entry point funnels through the one guarded compile', async () => {
  // Read as source rather than exercised as behaviour: create_session and
  // set_network_capture_filter reach the regex through paths that need a real
  // browser, and what is worth pinning is the structural property that no tool
  // file builds its own RegExp out of caller input. That is the thing a future
  // change would quietly break, by adding a fourth entry point next to the
  // three that already funnel here.
  const { readFileSync } = await import('node:fs');
  const files = [
    'src/daemon/sessions.ts',
    'src/daemon/tools/defs/session.ts',
    'src/daemon/tools/defs/inspect.ts',
    'src/daemon/tools/defs/network.ts'
  ];
  for (const file of files) {
    const lines = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (!line.includes('new RegExp(')) return;
      // A RegExp built out of an escaped literal cannot backtrack: escaping
      // strips every metacharacter, so urlIncludes stays a plain substring.
      if (line.includes('escapeForRegExp')) return;
      const fromCaller = ['args.', 'input.', 'source', 'raw'].some(token => line.includes(token));
      assert.ok(
        !fromCaller,
        `${file}:${index + 1} builds a RegExp from caller input outside compileUrlPattern: ${line.trim()}`
      );
    });
  }
});

// ---------------------------------------------------------------------------
// resourceType case sensitivity
// ---------------------------------------------------------------------------

test('resourceType is matched case-insensitively, like method already was', () => {
  const criteria = compileNetworkMatch({ resourceType: 'XHR' });
  const xhr: NetworkEntry = { ...entry('http://x/api'), resourceType: 'xhr' };
  assert.equal(matchesNetworkEntry(xhr, criteria), true, "resourceType 'XHR' silently matched nothing");
});

test('a resourceType outside Chromium vocabulary is refused, not left to match nothing', () => {
  assert.throws(() => compileNetworkMatch({ resourceType: 'ajax' }), /resourceType/);
  assert.throws(() => compileNetworkMatch({ resourceType: 'XMLHttpRequest' }), /resourceType/);
  for (const known of ['document', 'stylesheet', 'image', 'xhr', 'fetch', 'script', 'eventsource', 'other']) {
    assert.doesNotThrow(() => compileNetworkMatch({ resourceType: known }));
  }
});

// ---------------------------------------------------------------------------
// Oracle 2: a second concurrent request to the same daemon
// ---------------------------------------------------------------------------

/**
 * How long a /health round trip is allowed to take while the daemon is busy
 * navigating a page under a urlMatches capture filter. An idle /health answers
 * in low single-digit milliseconds; this leaves two orders of magnitude of
 * headroom for GC, browser startup and a loaded laptop, and still sits far
 * below the seconds-long freeze the unguarded code produced at 28 characters.
 */
const HEALTH_CEILING_MS = 500;

const clients: Client[] = [];
const servers: Server[] = [];

after(async () => {
  await Promise.all(clients.splice(0).map(c => c.close().catch(() => {})));
  await Promise.all(servers.splice(0).map(s => new Promise<void>(resolve => s.close(() => resolve()))));
  cleanupTempDirs();
});

/** Serves a page that fetches one adversarial, nearly-all-`a` URL on load. */
async function startAdversarialPage(runLength: number): Promise<string> {
  const path = `/${'a'.repeat(runLength)}b`;
  const server = createServer((req, res) => {
    if ((req.url ?? '/') === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html><html><body><img src="${path}" alt=""></body></html>`);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/`;
}

test('a caller-supplied capture-filter regex cannot stall the daemon for other callers', { timeout: 180_000 }, async () => {
  // 28 characters, not 34. At 28 the unguarded stall is seconds, which is
  // already two orders of magnitude past the ceiling below; 34 would be two
  // minutes and has no place in a suite that shares a laptop.
  const pageUrl = await startAdversarialPage(28);
  const config = await makeTestConfig({ sweepIntervalMs: 500, shutdownGraceMs: 100 });
  const healthUrl = `http://${config.host}:${config.port}/health`;

  const client = new Client({ name: 'round5-regex-test', version: '1.0.0' });
  clients.push(client);
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [cliEntry],
      env: {
        ...process.env,
        HARBORAGE_HOST: config.host,
        HARBORAGE_PORT: String(config.port),
        HARBORAGE_DEBUG_PORT: String(config.debugPort),
        HARBORAGE_STATE_DIR: config.stateDir,
        HARBORAGE_REGISTRY_PATH: config.registryPath,
        HARBORAGE_DAEMON_LOG_PATH: config.daemonLogPath,
        HARBORAGE_SWEEP_INTERVAL_MS: String(config.sweepIntervalMs),
        HARBORAGE_SHUTDOWN_GRACE_MS: String(config.shutdownGraceMs)
      }
    })
  );

  /** Round-trip time of one real HTTP request to the daemon, in milliseconds. */
  async function healthMs(): Promise<number> {
    const started = process.hrtime.bigint();
    await fetch(healthUrl, { signal: AbortSignal.timeout(60_000) }).then(r => r.text());
    return Number(process.hrtime.bigint() - started) / 1e6;
  }

  /** Polls /health continuously until `stop` flips, returning the worst round trip seen. */
  async function pollHealth(stop: { done: boolean }): Promise<number> {
    let worst = 0;
    while (!stop.done) {
      worst = Math.max(worst, await healthMs());
    }
    return worst;
  }

  // Warm the browser first, so browser startup cost is not measured as a stall.
  const warm = await client.callTool({ name: 'create_session', arguments: {} });
  assert.ok(!warm.isError, `create_session should work at all: ${JSON.stringify(warm)}`);
  const warmSession = (warm.structuredContent as { sessionId: string }).sessionId;
  await client.callTool({ name: 'release_session', arguments: { sessionId: warmSession } });

  const idle = await healthMs();
  assert.ok(idle < HEALTH_CEILING_MS, `an idle /health should be fast; took ${idle.toFixed(1)}ms`);

  const created = await client.callTool({
    name: 'create_session',
    arguments: { networkCaptureFilter: { urlMatches: RUNAWAY_URL_SHAPED } }
  });

  if (!created.isError) {
    // UNGUARDED: the pattern was accepted, so drive the traffic and measure
    // what it does to everyone else's daemon.
    const sessionId = (created.structuredContent as { sessionId: string }).sessionId;
    const stop = { done: false };
    const poller = pollHealth(stop);
    await client.callTool({ name: 'navigate', arguments: { sessionId, url: pageUrl, settleMs: 0 } });
    await new Promise(resolve => setTimeout(resolve, 3000));
    stop.done = true;
    const worst = await poller;
    await client.callTool({ name: 'release_session', arguments: { sessionId } });
    assert.fail(
      `create_session accepted the runaway pattern ${RUNAWAY_URL_SHAPED}, and a concurrent /health request then ` +
        `took ${worst.toFixed(0)}ms against an idle baseline of ${idle.toFixed(1)}ms`
    );
  }

  // GUARDED: the pattern is refused up front, and the refusal names the field.
  assert.match(JSON.stringify(created.content), /urlMatches/);

  // The rest of the path still has to work, so run the same traffic under a
  // regex filter that IS accepted and confirm the daemon stays responsive.
  const benign = await client.callTool({
    name: 'create_session',
    arguments: { networkCaptureFilter: { urlMatches: 'a+b$' } }
  });
  assert.ok(!benign.isError, `a benign urlMatches filter must still be accepted: ${JSON.stringify(benign)}`);
  const sessionId = (benign.structuredContent as { sessionId: string }).sessionId;

  const stop = { done: false };
  const poller = pollHealth(stop);
  await client.callTool({ name: 'navigate', arguments: { sessionId, url: pageUrl, settleMs: 0 } });
  await new Promise(resolve => setTimeout(resolve, 2000));
  stop.done = true;
  const worst = await poller;

  const listed = await client.callTool({ name: 'list_network_requests', arguments: { sessionId } });
  assert.ok(!listed.isError, `list_network_requests should work under the filter: ${JSON.stringify(listed)}`);

  await client.callTool({ name: 'release_session', arguments: { sessionId } });

  assert.ok(
    worst < HEALTH_CEILING_MS,
    `a concurrent /health request took ${worst.toFixed(0)}ms while the daemon filtered traffic (idle baseline ` +
      `${idle.toFixed(1)}ms, ceiling ${HEALTH_CEILING_MS}ms)`
  );
});
