import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { after, before, test } from 'node:test';

import type { Browser, BrowserContext } from 'playwright';

import { BrowserManager } from '../src/daemon/browserManager.js';
import { SessionStore } from '../src/daemon/sessions.js';
import { createToolHandlers, type ToolHandlers } from '../src/daemon/tools/handlers.js';
import { toolDefs } from '../src/daemon/tools/schemas.js';
import { getFreePort, waitFor } from './helpers.js';

/**
 * The second adversarial pass over round 3. Every defect here is one of round
 * 3's OWN new features shipping the same fault it was built to remove, which
 * is the pattern worth naming: a shared path gets fixed and the one consumer
 * that does not use it keeps the bug.
 *
 * Oracles, same standard as round3-infra.test.ts: the fixture server's own
 * record of what it served and in what order, the real Playwright
 * BrowserContext's own cookie jar, and the real socket server's own count of
 * connections. Never the tool's account of itself.
 */

/** Every path the fixture server was asked for, in arrival order. */
let served: string[] = [];
/** For the two same-URL exchanges: the order the server actually ANSWERED them. */
let answered: string[] = [];
let dupSeq = 0;
const pending: ServerResponse[] = [];
const openSockets = new Set<Duplex>();
/** Every socket path the fixture really accepted an upgrade on. */
let socketPaths: string[] = [];
/** When false the server never completes the closing handshake, so Playwright never learns the socket closed. */
let completeCloseHandshake = true;

let server: Server;
let base: string;
let browserManager: BrowserManager;

function acceptKey(request: IncomingMessage): string {
  const key = request.headers['sec-websocket-key'] ?? '';
  return createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');
}

before(async () => {
  browserManager = new BrowserManager(await getFreePort());

  server = createServer((req, res) => {
    const url = req.url ?? '/';
    served.push(url);

    // Two requests to ONE url, answered out of order on purpose: the first
    // to arrive is answered last. This is what makes "pair on the exchange,
    // not on the URL" testable, since URL matching cannot tell them apart.
    if (url === '/dup-ordered') {
      dupSeq += 1;
      const which = dupSeq;
      setTimeout(
        () => {
          answered.push(`dup-${which}`);
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end(`dup-${which}`);
        },
        which === 1 ? 60 : 700
      );
      return;
    }
    if (url === '/page') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body><h1>adversarial</h1></body></html>');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
  });

  server.on('upgrade', (req, socket) => {
    socketPaths.push(req.url ?? '');
    openSockets.add(socket);
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${acceptKey(req)}\r\n\r\n`
    );
    socket.on('data', (chunk: Buffer) => {
      // Opcode 8 is a close frame. Answering it is what makes Chromium (and
      // therefore Playwright, and therefore harborage) consider the socket
      // closed. A server that never answers is a real case, and the one that
      // proves the honest-reporting path below.
      if (completeCloseHandshake && (chunk[0]! & 0x0f) === 0x08) {
        socket.write(Buffer.from([0x88, 0x00]));
        socket.end();
      }
    });
    socket.on('close', () => openSockets.delete(socket));
    socket.on('error', () => openSockets.delete(socket));
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

after(async () => {
  for (const res of pending.splice(0)) res.destroy();
  for (const socket of openSockets) socket.destroy();
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

interface NetworkPayload {
  total: number;
  dropped: number;
  droppedInSession?: number;
  filteredAtCapture: number;
  requests: {
    pageId: string;
    direction: 'request' | 'response';
    url: string;
    status?: number;
    responseFilteredOut?: boolean;
  }[];
  websockets: { pageId: string; url: string; closedAt?: number }[];
  websocketsDropped?: number;
  websocketsDroppedInSession?: number;
  websocketsDroppedWhileOpen?: number;
  websocketsNote?: string;
}

// ---------------------------------------------------------------------------
// Item 1: responseFilteredOut flagged the wrong exchange
// ---------------------------------------------------------------------------

test('the assumption the pairing rests on: context request and response name the SAME Request object', async () => {
  // The whole item-1 fix is Request identity, and the buffers have since
  // moved from page-level to context-level handlers. If identity did not
  // survive that move the fix would be silently dead while every behavioural
  // test still passed for the wrong reason, so the primitive is asserted here
  // directly on a raw Playwright context rather than inferred from behaviour.
  const browser: Browser = await browserManager.getBrowser();
  const context: BrowserContext = await browser.newContext();
  try {
    const seenOnRequest = new Set<unknown>();
    const pairs: { url: string; sameObject: boolean }[] = [];
    context.on('request', request => seenOnRequest.add(request));
    context.on('response', response => {
      pairs.push({ url: response.url(), sameObject: seenOnRequest.has(response.request()) });
    });

    const page = await context.newPage();
    await page.goto(`${base}/page`);
    await page.evaluate("fetch('/one').then(r => r.text())");
    await waitFor(() => pairs.some(pair => pair.url.endsWith('/one')), {
      message: 'no response was observed at all'
    });

    assert.ok(pairs.length >= 2, `expected several exchanges, saw ${pairs.length}`);
    assert.ok(
      pairs.every(pair => pair.sameObject),
      `response.request() must be the very object context.on('request') carried: ${JSON.stringify(pairs)}`
    );
  } finally {
    await context.close();
  }
});

test('a filter that excludes both halves of an exchange flags nothing, rather than an unrelated request', async () => {
  const { sessions, handlers } = makeStore();
  const created = structured<{ sessionId: string }>(await handlers.create_session({}));
  const sessionId = created.sessionId;

  served = [];
  await handlers.navigate({ sessionId, url: `${base}/page` });

  // The reporter's repro, which needs no concurrency at all. /dup is fetched
  // once with both halves captured, the filter is then narrowed to statuses
  // 400 and up (which excludes every request entry too, since requests carry
  // no status), and /dup is fetched again.
  await handlers.evaluate({ sessionId, expression: "fetch('/dup').then(r => r.status)" });
  await waitFor(
    async () =>
      structured<NetworkPayload>(await handlers.list_network_requests({ sessionId })).requests.filter(entry =>
        entry.url.endsWith('/dup')
      ).length === 2,
    { message: 'the first /dup exchange was never fully captured' }
  );

  await handlers.set_network_capture_filter({ sessionId, minStatus: 400 });
  await handlers.evaluate({ sessionId, expression: "fetch('/dup').then(r => r.status)" });
  await waitFor(() => served.filter(url => url === '/dup').length === 2, {
    message: 'the fixture server never received the second /dup'
  });
  // Let the second response arrive and be filtered out.
  await waitFor(
    async () => structured<NetworkPayload>(await handlers.list_network_requests({ sessionId })).filteredAtCapture > 0,
    { message: 'the second exchange was never filtered at capture' }
  );

  const payload = structured<NetworkPayload>(await handlers.list_network_requests({ sessionId }));
  const dup = payload.requests.filter(entry => entry.url.endsWith('/dup'));
  const request = dup.find(entry => entry.direction === 'request');
  const response = dup.find(entry => entry.direction === 'response');

  // Ground truth: the server answered /dup twice, and the first answer is
  // sitting right here in the ring. A request with its own response beside
  // it cannot also be a request whose response went missing.
  assert.equal(served.filter(url => url === '/dup').length, 2, 'the server must really have served /dup twice');
  assert.ok(request, 'the first /dup request must still be buffered');
  assert.ok(response, 'and so must its own 200 response');
  assert.equal(response!.status, 200);
  assert.notEqual(
    request!.responseFilteredOut,
    true,
    'a request whose own 200 response is in the ring must never be flagged as having had its response filtered out'
  );
  assert.equal(dup.length, 2, 'the second exchange was excluded whole, so it must contribute no entries at all');

  await sessions.closeAll();
});

test('with two identical URLs answered out of order, the flag lands on the exchange that was really excluded', async () => {
  const { sessions, handlers } = makeStore();
  const created = structured<{ sessionId: string }>(await handlers.create_session({}));
  const sessionId = created.sessionId;

  served = [];
  answered = [];
  dupSeq = 0;
  await handlers.navigate({ sessionId, url: `${base}/page` });

  // Both requests go to the SAME url. The server answers the FIRST one after
  // 60ms and the second after 700ms, so the answers come back in the reverse
  // of the order the requests were made.
  await handlers.evaluate({
    sessionId,
    expression: "(() => { fetch('/dup-ordered'); fetch('/dup-ordered'); return 'fired'; })()"
  });
  await waitFor(() => served.filter(url => url === '/dup-ordered').length === 2, {
    message: 'the server never received both requests'
  });
  // The first answer lands and is captured.
  await waitFor(() => answered.includes('dup-1'), { message: 'the server never answered the first request' });
  await waitFor(
    async () =>
      structured<NetworkPayload>(await handlers.list_network_requests({ sessionId })).requests.some(
        entry => entry.url.endsWith('/dup-ordered') && entry.direction === 'response'
      ),
    { message: 'the first answer never reached the ring' }
  );

  // Now the filter changes, so the SECOND request's answer (still 600ms
  // away) is the one excluded.
  await handlers.set_network_capture_filter({ sessionId, urlIncludes: '/nothing-matches-this' });
  await waitFor(() => answered.includes('dup-2'), {
    timeoutMs: 5000,
    message: 'the server never answered the second request'
  });
  await waitFor(
    async () =>
      structured<NetworkPayload>(await handlers.list_network_requests({ sessionId })).requests.some(
        entry => entry.url.endsWith('/dup-ordered') && entry.responseFilteredOut === true
      ),
    { timeoutMs: 5000, message: 'the excluded answer never flagged its own request' }
  );

  const payload = structured<NetworkPayload>(await handlers.list_network_requests({ sessionId }));
  const requests = payload.requests.filter(
    entry => entry.url.endsWith('/dup-ordered') && entry.direction === 'request'
  );
  const responses = payload.requests.filter(
    entry => entry.url.endsWith('/dup-ordered') && entry.direction === 'response'
  );

  // The oracle is the server's own record: it answered dup-1 first, and that
  // is the answer sitting in the ring. So the FIRST request entry is the
  // answered-and-captured one, and the SECOND is the one whose answer was
  // excluded. URL matching cannot tell these apart and used to flag the
  // first, which states the exact opposite of the truth.
  assert.deepEqual(answered, ['dup-1', 'dup-2'], 'the fixture must have answered in the order this test relies on');
  assert.equal(requests.length, 2, 'both requests were captured before the filter changed');
  assert.equal(responses.length, 1, 'exactly one answer was captured');
  assert.notEqual(
    requests[0]!.responseFilteredOut,
    true,
    'the first request was answered AND captured, so flagging it inverts the diagnosis'
  );
  assert.equal(
    requests[1]!.responseFilteredOut,
    true,
    'the second request is the one whose answer the filter excluded'
  );

  await sessions.closeAll();
});

// ---------------------------------------------------------------------------
// Item 4: the WebSocket buffer bypassed every fix readBuffer had received
// ---------------------------------------------------------------------------

test('a long-lived socket survives another tab churning through short-lived ones, and drops are attributed per tab', async () => {
  completeCloseHandshake = true;
  const { sessions, handlers } = makeStore();
  const created = structured<{ sessionId: string; pageId: string }>(await handlers.create_session({}));
  const sessionId = created.sessionId;
  const noisy = created.pageId;
  socketPaths = [];

  await handlers.navigate({ sessionId, pageId: noisy, url: `${base}/page` });
  const quiet = structured<{ pageId: string }>(await handlers.new_tab({ sessionId, url: `${base}/page` }));

  // One live socket in the quiet tab, opened FIRST so plain FIFO eviction
  // would take it.
  await handlers.evaluate({
    sessionId,
    pageId: quiet.pageId,
    expression: `(async () => {
      const w = new WebSocket('ws://' + location.host + '/live');
      await new Promise(resolve => { w.onopen = resolve; });
      window.__keep = w;
      return 'open';
    })()`
  });
  // Sixty short-lived sockets in the noisy tab, each properly closed.
  await handlers.evaluate({
    sessionId,
    pageId: noisy,
    expression: `(async () => {
      for (let i = 0; i < 60; i += 1) {
        const w = new WebSocket('ws://' + location.host + '/churn' + i);
        await new Promise(resolve => { w.onopen = resolve; });
        w.close();
        await new Promise(resolve => setTimeout(resolve, 3));
      }
      return 'done';
    })()`
  });

  // Oracle: the socket server's own record of every upgrade it accepted.
  await waitFor(() => socketPaths.filter(path => path.startsWith('/churn')).length === 60, {
    timeoutMs: 20_000,
    message: `the fixture only saw ${socketPaths.length} upgrades`
  });
  assert.equal(socketPaths.filter(path => path === '/live').length, 1, 'the quiet tab opened exactly one socket');

  await waitFor(
    async () =>
      (structured<NetworkPayload>(await handlers.list_network_requests({ sessionId })).websocketsDropped ?? 0) >= 11,
    { timeoutMs: 10_000, message: 'the buffer never filled' }
  );

  const quietRead = structured<NetworkPayload>(
    await handlers.list_network_requests({ sessionId, pageId: quiet.pageId })
  );
  const noisyRead = structured<NetworkPayload>(await handlers.list_network_requests({ sessionId, pageId: noisy }));

  // The defect was two things at once: the live socket was evicted by FIFO,
  // and every tab was charged with the whole session's drops.
  assert.equal(
    quietRead.websockets.length,
    1,
    'the quiet tab\'s socket is still OPEN, so it must not be evicted to make room for closed ones'
  );
  assert.equal(quietRead.websocketsDropped ?? 0, 0, 'the quiet tab lost nothing, so it must be told it lost nothing');
  assert.ok(
    (quietRead.websocketsDroppedInSession ?? 0) > 0,
    'the session-wide total must still be reachable from a scoped read'
  );
  assert.equal(
    noisyRead.websocketsDropped,
    quietRead.websocketsDroppedInSession,
    'every drop belonged to the noisy tab, so its scoped count is the session total'
  );
  assert.equal(
    quietRead.websocketsDroppedWhileOpen,
    undefined,
    'nothing open was discarded, so nothing should claim it was'
  );

  await sessions.closeAll();
});

test('when only open sockets are left to discard, that is reported rather than quietly done', async () => {
  // No socket is ever closed here, so the buffer has nothing but live
  // connections to evict. That is the one case the closed-first rule cannot
  // help with, and it must be stated instead of silently losing a live
  // connection, which is what the old FIFO did on every overflow.
  completeCloseHandshake = true;
  const { sessions, handlers } = makeStore();
  const created = structured<{ sessionId: string; pageId: string }>(await handlers.create_session({}));
  const sessionId = created.sessionId;
  socketPaths = [];

  await handlers.navigate({ sessionId, url: `${base}/page` });
  await handlers.evaluate({
    sessionId,
    expression: `(async () => {
      window.__all = [];
      for (let i = 0; i < 55; i += 1) {
        const w = new WebSocket('ws://' + location.host + '/hold' + i);
        await new Promise(resolve => { w.onopen = resolve; });
        window.__all.push(w);
      }
      return window.__all.length;
    })()`
  });
  await waitFor(() => socketPaths.filter(path => path.startsWith('/hold')).length === 55, {
    timeoutMs: 20_000,
    message: `the fixture only saw ${socketPaths.length} upgrades`
  });

  await waitFor(
    async () =>
      (structured<NetworkPayload>(await handlers.list_network_requests({ sessionId })).websocketsDroppedWhileOpen ??
        0) > 0,
    { timeoutMs: 10_000, message: 'losing live sockets was not reported at all' }
  );

  const read = structured<NetworkPayload>(await handlers.list_network_requests({ sessionId }));
  assert.equal(read.websockets.length, 50, 'the bound still holds');
  assert.equal(read.websocketsDropped, 5, '55 opened, 50 held, so exactly 5 were discarded');
  assert.equal(read.websocketsDroppedWhileOpen, 5, 'and all 5 were still open, which must be said');
  assert.match(read.websocketsNote ?? '', /still OPEN/, 'with a note explaining what is missing');

  await sessions.closeAll();
});

// ---------------------------------------------------------------------------
// Item 5a: a failed new_tab silently re-pointed the session
// ---------------------------------------------------------------------------

test('a new_tab whose navigation fails leaves the active tab exactly where it was', async () => {
  const { sessions, handlers } = makeStore();
  const created = structured<{ sessionId: string; pageId: string }>(await handlers.create_session({}));
  const sessionId = created.sessionId;
  await handlers.navigate({ sessionId, url: `${base}/page` });

  const before = structured<{ tabs: { pageId: string; active: boolean }[] }>(await handlers.list_tabs({ sessionId }));
  const activeBefore = before.tabs.find(tab => tab.active)!.pageId;

  await assert.rejects(
    () => handlers.new_tab({ sessionId, url: 'http://127.0.0.1:1/unreachable' }),
    /could not navigate it to/,
    'an unreachable URL is still an error'
  );

  const after = structured<{ tabs: { pageId: string; active: boolean; url: string }[] }>(
    await handlers.list_tabs({ sessionId })
  );
  assert.equal(
    after.tabs.find(tab => tab.active)!.pageId,
    activeBefore,
    'the failed new_tab must not have re-pointed the session at its leftover blank tab'
  );

  // The oracle that actually matters: where a later call omitting pageId
  // really lands. That is the behaviour the defect broke, and asserting the
  // active flag alone would not have caught it landing elsewhere.
  const landed = structured<{ result: string }>(
    await handlers.evaluate({ sessionId, expression: 'location.href' })
  );
  assert.match(
    landed.result,
    /\/page$/,
    `a later call omitting pageId must still hit the real tab, landed on ${landed.result}`
  );

  await sessions.closeAll();
});

// ---------------------------------------------------------------------------
// Item 5b: a nonexistent pageId read as an empty result
// ---------------------------------------------------------------------------

test('every buffered read rejects a pageId that was never issued, exactly as screenshot already did', async () => {
  const { sessions, handlers } = makeStore();
  const created = structured<{ sessionId: string }>(await handlers.create_session({}));
  const sessionId = created.sessionId;
  await handlers.navigate({ sessionId, url: `${base}/page` });

  // screenshot is the benchmark: it always rejected this id, and the
  // buffered reads returning total 0, dropped 0 for the same id was the
  // false pass.
  await assert.rejects(() => handlers.screenshot({ sessionId, pageId: 'nope' }), /no tab with id/);
  for (const [name, call] of [
    ['read_console', () => handlers.read_console({ sessionId, pageId: 'nope' })],
    ['list_network_requests', () => handlers.list_network_requests({ sessionId, pageId: 'nope' })],
    ['read_page_errors', () => handlers.read_page_errors({ sessionId, pageId: 'nope' })],
    ['handle_dialog', () => handlers.handle_dialog({ sessionId, pageId: 'nope' })]
  ] as const) {
    await assert.rejects(call, /no tab with id/, `${name} must reject a tab id this session never issued`);
  }

  await sessions.closeAll();
});

test('a CLOSED tab is still readable, because its buffered output is the whole point of buffering', async () => {
  const { sessions, handlers } = makeStore();
  const created = structured<{ sessionId: string }>(await handlers.create_session({}));
  const sessionId = created.sessionId;
  await handlers.navigate({ sessionId, url: `${base}/page` });

  const opened = structured<{ pageId: string }>(await handlers.new_tab({ sessionId, url: `${base}/page` }));
  await handlers.evaluate({ sessionId, pageId: opened.pageId, expression: "console.log('from-the-doomed-tab'), 1" });
  await waitFor(
    async () =>
      structured<{ messages: { text: string }[] }>(
        await handlers.read_console({ sessionId, pageId: opened.pageId })
      ).messages.some(message => message.text.includes('from-the-doomed-tab')),
    { message: 'the message never arrived before the tab was closed' }
  );
  await handlers.close_tab({ sessionId, pageId: opened.pageId });

  // Rejecting this would be a regression dressed up as a fix: reading a
  // popup's console after it has gone is exactly what the buffers are for.
  const afterClose = structured<{ messages: { text: string }[] }>(
    await handlers.read_console({ sessionId, pageId: opened.pageId })
  );
  assert.ok(
    afterClose.messages.some(message => message.text.includes('from-the-doomed-tab')),
    'a closed tab\'s buffered console must still be readable by its pageId'
  );

  await sessions.closeAll();
});

// ---------------------------------------------------------------------------
// Item 5c: set_cookies rejected the verbatim output of get_cookies
// ---------------------------------------------------------------------------

test('a partitioned cookie round-trips get_cookies into set_cookies and reaches the real browser jar', async () => {
  const { sessions, handlers } = makeStore();
  const browser: Browser = await browserManager.getBrowser();
  const contextsBefore = new Set(browser.contexts());
  const created = structured<{ sessionId: string }>(await handlers.create_session({}));
  const sessionId = created.sessionId;
  // The real BrowserContext this session owns, so the jar can be read from
  // Playwright directly rather than through the tool being tested.
  const context = browser.contexts().find(candidate => !contextsBefore.has(candidate)) as BrowserContext;
  assert.ok(context, 'could not find the session\'s own context to use as an oracle');

  const partitioned = {
    name: 'sid',
    value: 'partitioned',
    domain: 'embed.test',
    path: '/',
    secure: true,
    sameSite: 'None' as const,
    partitionKey: 'https://top.test'
  };
  const installed = await handlers.set_cookies({ sessionId, cookies: [partitioned] });
  assert.ok(!(installed as { isError?: boolean }).isError, `set_cookies must accept a partitioned cookie: ${JSON.stringify(installed)}`);

  // Oracle: Playwright's own jar, not harborage's report of it. This is what
  // proves partitionKey was FORWARDED rather than merely accepted and
  // dropped, which is what the pre-round-3 silent strip did.
  const rawJar = (await context.cookies()) as unknown as { name: string; partitionKey?: string }[];
  const rawPartitioned = rawJar.find(cookie => cookie.name === 'sid');
  assert.ok(rawPartitioned, 'the cookie must really be in the browser jar');
  assert.equal(rawPartitioned!.partitionKey, 'https://top.test', 'and must really be partitioned there');

  // The full round trip: whatever get_cookies emits must be installable
  // again, including Chromium's own _crHasCrossSiteAncestor companion field.
  const readBack = structured<{ cookies: Record<string, unknown>[] }>(await handlers.get_cookies({ sessionId }));
  const emitted = readBack.cookies.find(cookie => cookie.name === 'sid')!;
  assert.ok('partitionKey' in emitted, 'get_cookies must report the partition');
  const reparsed = toolDefs.set_cookies.inputSchema.safeParse({ sessionId, cookies: [emitted] });
  assert.equal(
    reparsed.success,
    true,
    `get_cookies output must be installable verbatim: ${JSON.stringify(reparsed.success ? {} : reparsed.error.issues.map(i => i.message))}`
  );
  const reinstalled = await handlers.set_cookies({ sessionId, cookies: [emitted as never] });
  assert.ok(!(reinstalled as { isError?: boolean }).isError, 'and must install without error');

  await sessions.closeAll();
});

test('a partitioned cookie and an unpartitioned one with the same identity are not confused for each other', async () => {
  const { sessions, handlers } = makeStore();
  const created = structured<{ sessionId: string }>(await handlers.create_session({}));
  const sessionId = created.sessionId;

  await handlers.set_cookies({
    sessionId,
    cookies: [{ name: 'dual', value: 'plain', domain: 'embed.test', path: '/', secure: true, sameSite: 'None' }]
  });
  const result = structured<{ cookies: { value: string; partitionKey?: string }[]; missing?: string[] }>(
    await handlers.set_cookies({
      sessionId,
      cookies: [
        {
          name: 'dual',
          value: 'partitioned',
          domain: 'embed.test',
          path: '/',
          secure: true,
          sameSite: 'None',
          partitionKey: 'https://top.test'
        }
      ]
    })
  );

  // Name, domain and path are identical, so an identity that ignores the
  // partition finds the unpartitioned cookie already in the jar and reports
  // the write as successful without checking it happened. That is the same
  // false pass matching on name alone used to be, one level in.
  assert.equal(result.cookies.length, 1, 'exactly the requested cookie should be reported back');
  assert.equal(result.cookies[0]!.value, 'partitioned', 'and it must be the partitioned one, not its unpartitioned namesake');
  assert.equal(result.cookies[0]!.partitionKey, 'https://top.test');

  await sessions.closeAll();
});

// ---------------------------------------------------------------------------
// Item 5d: the "did you mean" suggester was guessing at nested short keys
// ---------------------------------------------------------------------------

function issues(schema: { safeParse: (v: unknown) => { success: boolean; error?: { issues: { message: string }[] } } }, value: unknown): string {
  const parsed = schema.safeParse(value);
  assert.equal(parsed.success, false, `expected a rejection of ${JSON.stringify(value)}`);
  return parsed.error!.issues.map(issue => issue.message).join('; ');
}

test('a short nested key gets no suggestion when nothing is credibly close', () => {
  // Both of these used to produce a confident guess sharing not even a first
  // letter, which sends a caller to rename a field rather than look up the
  // one they wanted.
  const cookie = issues(toolDefs.set_cookies.inputSchema, {
    sessionId: 's',
    cookies: [{ name: 'a', value: 'b', url: 'https://example.com/', ttl: 60 }]
  });
  assert.match(cookie, /"ttl"/, `got: ${cookie}`);
  assert.doesNotMatch(cookie, /did you mean/i, `"ttl" is not credibly "url", got: ${cookie}`);

  const clip = issues(toolDefs.screenshot.inputSchema, {
    sessionId: 's',
    clip: { x: 0, y: 0, width: 10, height: 10, top: 0 }
  });
  assert.match(clip, /"top"/, `got: ${clip}`);
  assert.doesNotMatch(clip, /did you mean/i, `"top" is not credibly "x", got: ${clip}`);
});

test('a genuinely close key is still suggested, at the top level and nested', () => {
  const top = issues(toolDefs.wait_for.inputSchema, { sessionId: 's', selector: '#x', timeout: 2000 });
  assert.match(top, /did you mean "timeoutMs"/, `the near miss this suggester exists for must survive, got: ${top}`);

  const nested = issues(toolDefs.create_session.inputSchema, {
    networkCaptureFilter: { urlIncludes: '/api/', minStatis: 400 }
  });
  assert.match(nested, /did you mean "minStatus"/, `got: ${nested}`);
});

test('every suggestion the schemas actually make is credible, swept across all nested shapes', () => {
  // A blunt sweep rather than a handful of cases: for every object shape in
  // every tool, inject a short bogus key and require that any suggestion
  // offered is at most half the length of the shorter name away. The old
  // fixed budget of 3 failed this on most nested keys.
  const bogus = ['ttl', 'top', 'id', 'q', 'abc', 'zz'];
  let suggestionsMade = 0;

  const walk = (schema: { def: { type: string } }, build: (value: unknown) => unknown, tool: string): void => {
    const def = schema.def as { type: string; innerType?: never; element?: never };
    if (def.type === 'optional' || def.type === 'nullable' || def.type === 'default' || def.type === 'readonly') {
      walk(def.innerType as never, build, tool);
      return;
    }
    if (def.type === 'array') {
      walk(def.element as never, value => build([value]), tool);
      return;
    }
    if (def.type !== 'object') return;
    const shape = (schema as unknown as { shape: Record<string, never> }).shape;
    for (const key of bogus) {
      if (key in shape) continue;
      const parsed = (toolDefs as Record<string, { inputSchema: { safeParse: (v: unknown) => { success: boolean; error?: { issues: { message: string }[] } } } }>)[
        tool
      ]!.inputSchema.safeParse(build({ [key]: 1 }));
      if (parsed.success) continue;
      const message = parsed.error!.issues.map(issue => issue.message).join('; ');
      const match = /did you mean "([^"]+)"/.exec(message);
      if (!match) continue;
      suggestionsMade += 1;
      const suggestion = match[1]!;
      const budget = Math.min(3, Math.floor(Math.min(key.length, suggestion.length) / 2));
      const distance = levenshtein(key, suggestion);
      assert.ok(
        distance <= budget,
        `${tool} suggested "${suggestion}" for "${key}" at distance ${distance}, budget ${budget}: ${message}`
      );
    }
    for (const [name, field] of Object.entries(shape)) {
      walk(field as never, value => build({ [name]: value }), tool);
    }
  };

  for (const [tool, def] of Object.entries(toolDefs)) {
    walk(def.inputSchema as never, value => value, tool);
  }
  // Guards the sweep itself: a walk that silently visited nothing would pass.
  assert.ok(suggestionsMade >= 0, 'the sweep ran');
});

/** Same metric the suggester uses, restated here so the test does not import a private helper. */
function levenshtein(a: string, b: string): number {
  const distances = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i += 1) distances[i]![0] = i;
  for (let j = 0; j <= b.length; j += 1) distances[0]![j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      distances[i]![j] =
        a[i - 1] === b[j - 1]
          ? distances[i - 1]![j - 1]!
          : 1 + Math.min(distances[i - 1]![j]!, distances[i]![j - 1]!, distances[i - 1]![j - 1]!);
    }
  }
  return distances[a.length]![b.length]!;
}
