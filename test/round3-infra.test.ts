import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { after, before, test } from 'node:test';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { Browser, BrowserContext } from 'playwright';

import { BrowserManager } from '../src/daemon/browserManager.js';
import { SessionStore } from '../src/daemon/sessions.js';
import { createToolHandlers, type ToolHandlers } from '../src/daemon/tools/handlers.js';
import { toolDefs } from '../src/daemon/tools/schemas.js';
import {
  requestTimeoutMarginMs,
  resolveRequestTimeout,
  type RequestTimeoutBounds
} from '../src/client/wrapper.js';
import { cliEntry, cleanupTempDirs, daemonHealth, getFreePort, makeTestConfig, waitFor, wrapperEnv } from './helpers.js';
import type { Config } from '../src/shared/config.js';

/**
 * Round 3's infrastructure findings. Every test here is written against a
 * GROUND-TRUTH ORACLE rather than against what the tool says about itself,
 * because the previous round's fixes all passed tests that only asserted the
 * tool returned the string they expected, and then certified the exact
 * failure they were built to prevent on a real page. So:
 *
 * - the context-leak tests count real BrowserContexts on the real Playwright
 *   Browser object, not sessions in harborage's own table;
 * - the buffer-counter tests drive real traffic through real Chromium and
 *   compare against what the fixture server actually served;
 * - the WebSocket test compares against what a real WebSocket server
 *   actually received and sent;
 * - the timeout-clamp test reads the wrapper process's real stderr.
 */

// ---------------------------------------------------------------------------
// Fixture: one HTTP server that can be slow, silent, chatty or a WebSocket
// ---------------------------------------------------------------------------

/** Every request path the fixture server has actually been asked for, in order. Wire truth, not tool truth. */
let served: string[] = [];
/** Requests deliberately left unanswered, so the test can prove "never answered" is a real state. */
const hungResponses: { destroy: () => void }[] = [];
/** Client frames the WebSocket fixture really received, decoded. */
let wsFramesReceived: string[] = [];
let wsConnections = 0;
const openSockets = new Set<Duplex>();

let server: Server;
let base: string;
let browserManager: BrowserManager;

/** The RFC 6455 handshake response for one upgrade request. Enough of a WebSocket server to prove frames flow. */
function acceptKey(request: IncomingMessage): string {
  const key = request.headers['sec-websocket-key'] ?? '';
  return createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');
}

/** One unmasked server-to-client text frame. Payloads here are tiny, so the short-length form is all that is needed. */
function textFrame(payload: string): Buffer {
  const body = Buffer.from(payload, 'utf8');
  return Buffer.concat([Buffer.from([0x81, body.length]), body]);
}

/** Decodes one masked client-to-server text frame. Same size assumption as `textFrame`. */
function decodeClientFrame(chunk: Buffer): string | undefined {
  if (chunk.length < 6) return undefined;
  const length = chunk[1]! & 0x7f;
  const mask = chunk.subarray(2, 6);
  const body = chunk.subarray(6, 6 + length);
  return Buffer.from(body.map((byte, i) => byte ^ mask[i % 4]!)).toString('utf8');
}

before(async () => {
  browserManager = new BrowserManager(await getFreePort());

  server = createServer((req, res) => {
    const url = req.url ?? '/';
    served.push(url);
    if (url === '/hang') {
      // Answered by nobody, ever. This is the control case the mid-flight
      // filter change has to stay distinguishable from.
      hungResponses.push({ destroy: () => res.destroy() });
      return;
    }
    if (url.startsWith('/slow')) {
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('slow');
      }, 400);
      return;
    }
    if (url === '/sse') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write('data: one\n\n');
      hungResponses.push({ destroy: () => res.destroy() });
      return;
    }
    if (url === '/page') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body><h1>round3</h1></body></html>');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
  });

  server.on('upgrade', (req, socket) => {
    wsConnections += 1;
    openSockets.add(socket);
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${acceptKey(req)}\r\n\r\n`
    );
    socket.on('data', (chunk: Buffer) => {
      const decoded = decodeClientFrame(chunk);
      if (decoded !== undefined) wsFramesReceived.push(decoded);
    });
    socket.on('close', () => openSockets.delete(socket));
    socket.on('error', () => openSockets.delete(socket));
    // One unprompted server frame, so framesReceived on harborage's side has
    // something real to count.
    socket.write(textFrame('hello-from-server'));
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

after(async () => {
  for (const hung of hungResponses.splice(0)) hung.destroy();
  for (const socket of openSockets) socket.destroy();
  await browserManager.close();
  await new Promise<void>(resolve => server.close(() => resolve()));
});

function makeStore(limits: { network?: number; console?: number } = {}) {
  const sessions = new SessionStore(browserManager, limits);
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
  returned: number;
  dropped: number;
  droppedInSession?: number;
  filteredAtCapture: number;
  filteredAtCaptureInSession?: number;
  requests: {
    pageId: string;
    direction: 'request' | 'response';
    url: string;
    status?: number;
    responseFilteredOut?: boolean;
  }[];
  websockets: { pageId: string; url: string; framesSent: number; framesReceived: number; closedAt?: number }[];
}

interface ConsolePayload {
  total: number;
  returned: number;
  dropped: number;
  droppedInSession?: number;
  messages: { pageId: string; type: string; text: string }[];
}

// ---------------------------------------------------------------------------
// Finding 4: a rejected create_session used to leak a real BrowserContext
// ---------------------------------------------------------------------------

test('a create_session rejected for a bad urlMatches leaks no BrowserContext, measured on the real browser', async () => {
  const { sessions, handlers } = makeStore();
  const browser: Browser = await browserManager.getBrowser();

  const good = structured<{ sessionId: string }>(await handlers.create_session({}));
  const baseline = browser.contexts().length;

  // The measured shape of the defect, verbatim: five rejected calls left
  // five extra contexts behind, unreachable through the session table and
  // therefore unreapable, and releasing the real session did not take them.
  for (let i = 0; i < 5; i += 1) {
    await assert.rejects(
      () => handlers.create_session({ networkCaptureFilter: { urlMatches: '([' } }),
      /not a valid regular expression/,
      'an unparseable regex must still be rejected, and say why'
    );
  }

  // The oracle: contexts on the real Playwright Browser, not sessions in
  // harborage's own table. The old code kept the table honest and the
  // browser leaking, which is exactly why the table cannot be the oracle.
  assert.equal(
    browser.contexts().length,
    baseline,
    `five rejected create_session calls must leave no context behind (baseline ${baseline})`
  );

  await handlers.release_session({ sessionId: good.sessionId });
  assert.equal(
    browser.contexts().length,
    baseline - 1,
    'releasing the one real session must bring the browser back below the baseline, with nothing orphaned'
  );
  await sessions.closeAll();
});

test('a failure AFTER the context is created still closes it, so the next throw in that window cannot leak either', async () => {
  const browser: Browser = await browserManager.getBrowser();
  const baseline = browser.contexts().length;

  // Validation moving above newContext removes the known throw. This proves
  // the guard around the rest of the window: a real context is created, and
  // then the very next step (installing the unhandled-rejection hook) fails.
  // The context is real, so if the guard is missing this leaks for real.
  const failing = {
    getBrowser: async () =>
      new Proxy(browser, {
        get(target, prop, receiver) {
          if (prop !== 'newContext') return Reflect.get(target, prop, receiver);
          return async (...args: unknown[]) => {
            const context: BrowserContext = await (target.newContext as (...a: unknown[]) => Promise<BrowserContext>)(
              ...args
            );
            return new Proxy(context, {
              get(ctxTarget, ctxProp, ctxReceiver) {
                if (ctxProp === 'exposeBinding') {
                  return async () => {
                    throw new Error('simulated exposeBinding failure');
                  };
                }
                const value = Reflect.get(ctxTarget, ctxProp, ctxReceiver);
                return typeof value === 'function' ? value.bind(ctxTarget) : value;
              }
            });
          };
        }
      })
  } as unknown as BrowserManager;

  const sessions = new SessionStore(failing);
  await assert.rejects(() => sessions.createSession({}), /simulated exposeBinding failure/);

  assert.equal(
    browser.contexts().length,
    baseline,
    'a throw between newContext and the session being stored must close the context it created'
  );
  assert.equal(sessions.count(), 0, 'and must leave no half-built session in the table');
});

// ---------------------------------------------------------------------------
// Finding 2: a narrowed clear used to reset dropped and filteredAtCapture
// ---------------------------------------------------------------------------

/**
 * Loads a page and fires real traffic at the fixture server: one `/keep`
 * request, then `noise` requests the capture filter will exclude, then more
 * `/keep` requests than the tiny ring can hold so it genuinely evicts. The
 * evaluate awaits every fetch, so nothing here needs a sleep.
 */
async function driveTraffic(handlers: ToolHandlers, sessionId: string, noise: number, keeps: number): Promise<void> {
  await handlers.navigate({ sessionId, url: `${base}/page` });
  await handlers.evaluate({
    sessionId,
    expression: `(async () => {
      await Promise.all(Array.from({ length: ${noise} }, (_, i) => fetch('/noise/' + i).catch(() => {})));
      await Promise.all(Array.from({ length: ${keeps} }, (_, i) => fetch('/keep/' + i).catch(() => {})));
    })()`
  });
}

test('a narrowed clear leaves dropped and filteredAtCapture exactly as they were, against real traffic', async () => {
  const { sessions, handlers } = makeStore({ network: 6 });
  const created = structured<{ sessionId: string }>(
    await handlers.create_session({ networkCaptureFilter: { urlIncludes: '/keep' } })
  );
  const sessionId = created.sessionId;

  served = [];
  await driveTraffic(handlers, sessionId, 20, 8);

  const noiseServed = served.filter(url => url.startsWith('/noise/')).length;
  const keepServed = served.filter(url => url.startsWith('/keep/')).length;
  assert.equal(noiseServed, 20, `the fixture server must really have served the noise, saw ${served.length} requests`);
  assert.equal(keepServed, 8, 'and really have served the traffic that was meant to be kept');

  const before = structured<NetworkPayload>(await handlers.list_network_requests({ sessionId }));

  // Wire truth: every noise request produced a request entry AND a response
  // entry, and the capture filter excluded both halves of all of them. The
  // page navigation itself is excluded too, so this is a lower bound rather
  // than an equality.
  assert.ok(
    before.filteredAtCapture >= noiseServed * 2,
    `expected at least ${noiseServed * 2} entries excluded at capture (both halves of every noise request), got ${before.filteredAtCapture}`
  );
  assert.ok(before.dropped > 0, `expected the 6-entry ring to have genuinely evicted something, got ${before.dropped}`);

  // The defect: a clear NARROWED by a filter that happens to match
  // everything left in the ring took the same branch as a genuine
  // whole-buffer clear, and both counters read 0 one call later.
  const narrowed = structured<NetworkPayload>(
    await handlers.list_network_requests({ sessionId, urlIncludes: '/keep', clear: true })
  );
  assert.ok(narrowed.returned > 0, 'the narrowed clear must actually have returned (and cleared) something');

  const after = structured<NetworkPayload>(await handlers.list_network_requests({ sessionId }));
  assert.equal(after.dropped, before.dropped, 'a narrowed clear must not reset dropped');
  assert.equal(
    after.filteredAtCapture,
    before.filteredAtCapture,
    'a narrowed clear must not reset filteredAtCapture either: 732 genuinely excluded entries reading 0 one call later is the false pass the capture filter exists to prevent'
  );

  // And the promised reset still happens for the call that narrows nothing.
  await handlers.list_network_requests({ sessionId, clear: true });
  const reset = structured<NetworkPayload>(await handlers.list_network_requests({ sessionId }));
  assert.equal(reset.dropped, 0, 'an unnarrowed clear still starts a fresh observation window');
  assert.equal(reset.filteredAtCapture, 0, 'and still resets filteredAtCapture with it');

  await sessions.closeAll();
});

test('read_console has the same bug and the same fix: a narrowed clear leaves dropped alone', async () => {
  const { sessions, handlers } = makeStore({ console: 6 });
  const created = structured<{ sessionId: string }>(await handlers.create_session({}));
  const sessionId = created.sessionId;

  await handlers.navigate({ sessionId, url: `${base}/page` });
  await handlers.evaluate({
    sessionId,
    expression: '(() => { for (let i = 0; i < 12; i += 1) console.log("m" + i); console.error("boom"); return 1; })()'
  });
  await waitFor(async () => structured<ConsolePayload>(await handlers.read_console({ sessionId })).total >= 6, {
    message: 'console messages never arrived'
  });

  const before = structured<ConsolePayload>(await handlers.read_console({ sessionId }));
  assert.ok(before.dropped > 0, `expected the 6-message ring to have evicted something, got ${before.dropped}`);

  const narrowed = structured<ConsolePayload>(
    await handlers.read_console({ sessionId, types: ['log', 'error'], clear: true })
  );
  assert.ok(narrowed.returned > 0, 'the narrowed clear must have returned something');

  const after = structured<ConsolePayload>(await handlers.read_console({ sessionId }));
  assert.equal(after.dropped, before.dropped, 'read_console shares readBuffer, so it shared the bug: a narrowed clear must not reset dropped');

  await handlers.read_console({ sessionId, clear: true });
  assert.equal(structured<ConsolePayload>(await handlers.read_console({ sessionId })).dropped, 0);

  await sessions.closeAll();
});

test('SessionStore itself still resets on a genuinely unnarrowed clear and never on a scoped one', async () => {
  const { sessions, handlers } = makeStore({ network: 4 });
  const created = structured<{ sessionId: string; pageId: string }>(await handlers.create_session({}));
  await driveTraffic(handlers, created.sessionId, 0, 10);

  const dropped = sessions.getNetworkEntries(created.sessionId).droppedInSession;
  assert.ok(dropped > 0, 'the ring must have evicted for this to test anything');

  // Scoped to the one tab that exists: everything is removed, but the clear
  // was still narrowed, so the counter must survive.
  sessions.getNetworkEntries(created.sessionId, created.pageId, true);
  assert.equal(
    sessions.getNetworkEntries(created.sessionId).droppedInSession,
    dropped,
    'a pageId-scoped clear must never reset the session-wide counter'
  );

  sessions.getNetworkEntries(created.sessionId, undefined, true);
  assert.equal(sessions.getNetworkEntries(created.sessionId).droppedInSession, 0);

  await sessions.closeAll();
});

// ---------------------------------------------------------------------------
// Finding 10a: WebSockets were invisible with nothing to say so
// ---------------------------------------------------------------------------

test('a real WebSocket shows up in list_network_requests, with frame counts the server agrees with', async () => {
  const { sessions, handlers } = makeStore();
  const created = structured<{ sessionId: string }>(await handlers.create_session({}));
  const sessionId = created.sessionId;

  wsFramesReceived = [];
  const connectionsBefore = wsConnections;

  await handlers.navigate({ sessionId, url: `${base}/page` });
  await handlers.evaluate({
    sessionId,
    expression: `(async () => {
      const ws = new WebSocket('ws://' + location.host + '/ws');
      await new Promise(resolve => { ws.onopen = resolve; });
      await new Promise(resolve => { ws.onmessage = resolve; });
      ws.send('hello-from-page');
      return 'sent';
    })()`
  });

  // Oracle: the real socket server saw a connection and the page's frame.
  await waitFor(() => wsFramesReceived.includes('hello-from-page'), {
    message: 'the fixture WebSocket server never received the page\'s frame'
  });
  assert.equal(wsConnections, connectionsBefore + 1, 'exactly one real socket must have been opened');

  const payload = structured<NetworkPayload>(await handlers.list_network_requests({ sessionId }));
  assert.equal(payload.websockets.length, 1, `expected the socket to be reported, got ${JSON.stringify(payload.websockets)}`);
  const socket = payload.websockets[0]!;
  assert.match(socket.url, /\/ws$/, 'the reported url must be the socket the page really opened');
  assert.equal(socket.framesSent, 1, 'framesSent must match the one frame the server really received');
  assert.equal(socket.framesReceived, 1, 'framesReceived must match the one frame the server really sent');

  // The other half of the finding: a socket is not a request, so it must not
  // have been smuggled into the HTTP entries where the filters would lie
  // about it.
  assert.equal(
    payload.requests.filter(entry => entry.url.startsWith('ws://')).length,
    0,
    'a WebSocket must not be reported as a request/response pair'
  );

  await sessions.closeAll();
});

test('list_network_requests states the WebSocket situation even when there are none, rather than staying silent', async () => {
  const { sessions, handlers } = makeStore();
  const created = structured<{ sessionId: string }>(await handlers.create_session({}));
  const payload = structured<NetworkPayload>(await handlers.list_network_requests({ sessionId: created.sessionId }));
  assert.deepEqual(payload.websockets, [], 'the field must be present and empty, not absent');
  assert.match(
    toolDefs.list_network_requests.description,
    /websockets/i,
    'the description has to name the channel a caller would otherwise assume is covered'
  );
  await sessions.closeAll();
});

test('the description\'s claim about Server-Sent Events is measured, not assumed: the connection IS captured', async () => {
  const { sessions, handlers } = makeStore();
  const created = structured<{ sessionId: string }>(await handlers.create_session({}));
  const sessionId = created.sessionId;

  served = [];
  await handlers.navigate({ sessionId, url: `${base}/page` });
  await handlers.evaluate({
    sessionId,
    expression: '(() => { new EventSource(\'/sse\'); return \'opened\'; })()'
  });
  await waitFor(() => served.includes('/sse'), { message: 'the fixture server never received the SSE request' });

  await waitFor(
    async () =>
      structured<NetworkPayload>(await handlers.list_network_requests({ sessionId })).requests.some(entry =>
        entry.url.endsWith('/sse')
      ),
    { timeoutMs: 5000, message: 'the SSE connection never reached the ring' }
  );
  const read = structured<NetworkPayload>(await handlers.list_network_requests({ sessionId }));
  const request = read.requests.find(entry => entry.url.endsWith('/sse') && entry.direction === 'request');
  const response = read.requests.find(entry => entry.url.endsWith('/sse') && entry.direction === 'response');
  assert.ok(request, 'an EventSource connection is one HTTP request and must be visible as one');
  assert.ok(response, 'and its response headers arrive, so the response half is captured too');
  assert.match(
    toolDefs.list_network_requests.description,
    /Server-Sent Events are a different case and DO appear/,
    'the description must say so, since the earlier draft of it claimed the opposite'
  );

  await sessions.closeAll();
});

// ---------------------------------------------------------------------------
// Finding 10b: a filter change mid-flight made "answered" look like "never answered"
// ---------------------------------------------------------------------------

test('a request whose response the filter excluded mid-flight is distinguishable from one nobody answered', async () => {
  const { sessions, handlers } = makeStore();
  const created = structured<{ sessionId: string }>(
    await handlers.create_session({ networkCaptureFilter: { urlIncludes: '/' } })
  );
  const sessionId = created.sessionId;

  served = [];
  await handlers.navigate({ sessionId, url: `${base}/page` });

  // /slow is answered 400ms later; /hang is never answered at all. Both are
  // captured under the filter in force right now.
  await handlers.evaluate({
    sessionId,
    expression: `(() => { fetch('/slow').catch(() => {}); fetch('/hang').catch(() => {}); return 'fired'; })()`
  });
  await waitFor(() => served.includes('/slow') && served.includes('/hang'), {
    message: 'the fixture server never received both requests'
  });

  // The filter changes while /slow is still in flight, which is exactly the
  // race a caller hits when it narrows capture after seeing a flood.
  await handlers.set_network_capture_filter({ sessionId, urlIncludes: '/nothing-matches-this' });

  await waitFor(
    async () => {
      const read = structured<NetworkPayload>(await handlers.list_network_requests({ sessionId }));
      return read.requests.some(entry => entry.url.endsWith('/slow') && entry.responseFilteredOut === true);
    },
    { timeoutMs: 5000, message: 'the excluded response never marked its request' }
  );
  const payload = structured<NetworkPayload>(await handlers.list_network_requests({ sessionId }));

  const slow = payload.requests.find(entry => entry.url.endsWith('/slow') && entry.direction === 'request');
  const hang = payload.requests.find(entry => entry.url.endsWith('/hang') && entry.direction === 'request');
  assert.ok(slow, 'the /slow request entry must still be in the ring');
  assert.ok(hang, 'and so must the /hang one');

  // Neither has a response entry beside it, which is precisely why they used
  // to be indistinguishable. The oracle for which is which is the fixture
  // server: it answered /slow and never answered /hang.
  assert.equal(
    payload.requests.filter(entry => entry.url.endsWith('/slow') && entry.direction === 'response').length,
    0,
    'the response really was excluded from the ring'
  );
  assert.equal(slow!.responseFilteredOut, true, 'a request the server ANSWERED must say its response was filtered out');
  assert.notEqual(hang!.responseFilteredOut, true, 'a request the server never answered must NOT claim a filtered response');

  await sessions.closeAll();
});

// ---------------------------------------------------------------------------
// Finding 10c: dropped was session-wide even on a per-tab read
// ---------------------------------------------------------------------------

test('a read scoped to one quiet tab reports that tab\'s drops, with the session-wide total named separately', async () => {
  const { sessions, handlers } = makeStore({ network: 6 });
  const created = structured<{ sessionId: string; pageId: string }>(await handlers.create_session({}));
  const sessionId = created.sessionId;
  const noisyTab = created.pageId;

  const quiet = structured<{ pageId: string }>(await handlers.new_tab({ sessionId, url: `${base}/page` }));

  // All the flooding happens in the first tab.
  await handlers.navigate({ sessionId, pageId: noisyTab, url: `${base}/page` });
  await handlers.evaluate({
    sessionId,
    pageId: noisyTab,
    expression: `(async () => {
      await Promise.all(Array.from({ length: 30 }, (_, i) => fetch('/noise/' + i).catch(() => {})));
    })()`
  });

  const wholeSession = structured<NetworkPayload>(await handlers.list_network_requests({ sessionId }));
  assert.ok(wholeSession.dropped > 0, 'the flood must really have evicted entries');
  assert.equal(wholeSession.droppedInSession, undefined, 'an unscoped read needs no second number: they are the same');

  const scoped = structured<NetworkPayload>(await handlers.list_network_requests({ sessionId, pageId: quiet.pageId }));
  assert.equal(scoped.droppedInSession, wholeSession.dropped, 'the session-wide total must still be reachable');
  assert.ok(
    scoped.dropped < scoped.droppedInSession!,
    `a quiet tab must not be charged with another tab's evictions: reported ${scoped.dropped} of ${scoped.droppedInSession}`
  );

  // The oracle for whose drops those were: every entry left in the ring
  // belongs to the noisy tab, and the quiet tab's own traffic is what it
  // loaded, nothing more.
  assert.ok(
    wholeSession.requests.every(entry => entry.pageId === noisyTab),
    'the ring should be full of the noisy tab\'s traffic, which is what makes the session-wide count misleading for the other tab'
  );

  await sessions.closeAll();
});

// ---------------------------------------------------------------------------
// Finding 7: nested objects silently dropped misnamed keys
// ---------------------------------------------------------------------------

function rejection(schema: { safeParse: (v: unknown) => { success: boolean; error?: { issues: { message: string }[] } } }, value: unknown): string {
  const parsed = schema.safeParse(value);
  assert.equal(parsed.success, false, `expected a rejection, got acceptance of ${JSON.stringify(value)}`);
  return parsed.error!.issues.map(issue => issue.message).join('; ');
}

test('create_session rejects a capture filter key it would otherwise discard, and says which object it was in', () => {
  // The docs tell callers to paste read filters straight into a capture
  // filter. minStatus is now genuinely accepted there, so the case that has
  // to be caught is a name that is wrong everywhere.
  const message = rejection(toolDefs.create_session.inputSchema, {
    networkCaptureFilter: { urlIncludes: '/api/', minStatis: 400 }
  });
  assert.match(message, /"minStatis"/, `the offending key must be named, got: ${message}`);
  assert.match(message, /networkCaptureFilter/, `the nested object must be named, got: ${message}`);
  assert.match(message, /did you mean "minStatus"/, `the near miss must be suggested, got: ${message}`);
});

test('the capture filter really does accept the status fields the docs tell callers to paste in', () => {
  const parsed = toolDefs.create_session.inputSchema.safeParse({
    networkCaptureFilter: { urlIncludes: '/api/', minStatus: 400, maxStatus: 599 }
  });
  assert.equal(parsed.success, true, `expected minStatus/maxStatus to be real capture-filter fields: ${JSON.stringify(parsed)}`);
  const filterParsed = toolDefs.set_network_capture_filter.inputSchema.safeParse({
    sessionId: 's',
    urlIncludes: '/api/',
    minStatus: 400
  });
  assert.equal(filterParsed.success, true, 'and to be the same vocabulary on set_network_capture_filter');
});

test('a real top-level parameter misplaced into a nested object is told where it belongs', () => {
  const message = rejection(toolDefs.create_session.inputSchema, {
    viewport: { width: 800, height: 600, deviceScaleFactor: 2 }
  });
  assert.match(message, /"deviceScaleFactor"/, `got: ${message}`);
  assert.match(message, /viewport/, `got: ${message}`);
  assert.match(message, /parameter of the tool itself/, `a misplaced real parameter must be named as such, got: ${message}`);
});

test('an unknown key inside an object inside an array is rejected, with its index in the path', () => {
  const message = rejection(toolDefs.set_cookies.inputSchema, {
    sessionId: 's',
    cookies: [{ name: 'sid', value: 'v', url: 'https://example.com/', maxAge: 60 }]
  });
  assert.match(message, /"maxAge"/, `got: ${message}`);
  assert.match(message, /cookies\[0\]/, `the array index makes the location actionable, got: ${message}`);
  assert.match(message, /expires/, `the valid keys for that nested shape must be listed, got: ${message}`);
});

test('an unknown key inside drag\'s endpoint objects names which endpoint it was', () => {
  const message = rejection(toolDefs.drag.inputSchema, {
    sessionId: 's',
    source: { selector: '#a', offsetX: 3 },
    target: { selector: '#b' }
  });
  assert.match(message, /"offsetX"/, `got: ${message}`);
  assert.match(message, /"source"/, `"source" and "target" have identical shapes, so naming which one is the whole point, got: ${message}`);
});

test('array element constraints survive the strictness rewrite', () => {
  // clone() rather than a naive rebuild, because set_cookies' array carries
  // a .min(1) that a rebuild would silently drop, turning "you must pass a
  // cookie" into "an empty call quietly does nothing".
  const parsed = toolDefs.set_cookies.inputSchema.safeParse({ sessionId: 's', cookies: [] });
  assert.equal(parsed.success, false, 'cookies: [] must still be rejected');
});

test('field descriptions survive the strictness rewrite, at every depth', () => {
  const shape = toolDefs.create_session.inputSchema.shape as Record<string, { description?: string }>;
  assert.ok(shape.networkCaptureFilter?.description, 'a nested object\'s own description must not be lost when it is rebuilt');
  const dragShape = toolDefs.drag.inputSchema.shape as Record<string, { description?: string }>;
  assert.match(dragShape.source!.description!, /drag starts/, 'drag.source keeps the description that distinguishes it from target');
});

/**
 * Every open-ended payload in the tool surface: places where arbitrary keys
 * ARE the data, and where making the shape strict would break real calls.
 * The top-level strictness of the previous round caused no over-correction,
 * and extending it downwards must not either, so each one is round-tripped
 * through the real schema rather than reasoned about.
 */
test('every open-ended payload still round-trips unchanged through the deepened strictness', () => {
  const storageState = {
    cookies: [
      { name: 'sid', value: 'v', domain: 'example.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' }
    ],
    origins: [{ origin: 'https://example.com', localStorage: [{ name: 'k', value: 'v' }] }],
    somethingPlaywrightAddsLater: { nested: [1, 2, { deep: true }] }
  };
  const seeded = toolDefs.create_session.inputSchema.safeParse({ storageState });
  assert.equal(seeded.success, true, `export_state output must survive verbatim: ${JSON.stringify(seeded)}`);
  assert.deepEqual((seeded as { data: { storageState: unknown } }).data.storageState, storageState);

  const params = { url: 'https://example.com', transitionType: 'typed', anything: { deep: [1, { more: true }] } };
  const cdp = toolDefs.send_cdp_command.inputSchema.safeParse({ sessionId: 's', method: 'Page.navigate', params });
  assert.equal(cdp.success, true, `arbitrary CDP params must survive verbatim: ${JSON.stringify(cdp)}`);
  assert.deepEqual((cdp as { data: { params: unknown } }).data.params, params);

  const headers = { 'retry-after': '30', 'x-anything-at-all': 'yes' };
  const route = toolDefs.add_route_rule.inputSchema.safeParse({
    sessionId: 's',
    urlGlob: '**/api/**',
    action: 'fulfill',
    headers,
    overrideHeaders: { 'x-trace': '1' }
  });
  assert.equal(route.success, true, `header bags must stay open: ${JSON.stringify(route)}`);
  assert.deepEqual((route as { data: { headers: unknown } }).data.headers, headers);

  // Storage item bags: the value is opaque text, including JSON text, and
  // the whole point is that harborage does not interpret it.
  const stored = toolDefs.set_storage.inputSchema.safeParse({
    sessionId: 's',
    area: 'localStorage',
    key: 'app-state',
    value: '{"nested":{"anything":[1,2,3]}}'
  });
  assert.equal(stored.success, true, `an opaque storage value must not be parsed or constrained: ${JSON.stringify(stored)}`);

  // An evaluate expression is arbitrary source, including source that looks
  // like an object literal.
  const evaluated = toolDefs.evaluate.inputSchema.safeParse({
    sessionId: 's',
    expression: '({ a: 1, b: { c: [2, 3] } })',
    timeoutMs: 0
  });
  assert.equal(evaluated.success, true, `arbitrary expression source must pass through: ${JSON.stringify(evaluated)}`);
});

test('every tool schema still accepts a correctly named call, so strictness caught no real parameter', () => {
  // A blunt over-correction check across the whole surface: for each tool,
  // build the argument object from its own declared shape (one plausible
  // value per field) and require it to parse. A field the rewrite broke
  // would fail here whatever its type.
  const sample = (schema: { def: { type: string; innerType?: unknown; element?: unknown; entries?: unknown } }): unknown => {
    const def = schema.def as { type: string; innerType?: never; element?: never; entries?: Record<string, unknown>; values?: unknown[] };
    switch (def.type) {
      case 'optional':
      case 'nullable':
      case 'default':
      case 'readonly':
      case 'nonoptional':
        return sample(def.innerType as never);
      case 'string':
        return 'x';
      case 'number': {
        // Numeric fields carry real ranges (status is 100 to 599, latitude
        // is -90 to 90), and this test is about strictness rather than about
        // bounds, so the first candidate the field itself accepts wins.
        const candidates = [200, 1, 0, 90, 0.5, -1];
        const leaf = schema as unknown as { safeParse: (v: unknown) => { success: boolean } };
        return candidates.find(candidate => leaf.safeParse(candidate).success) ?? 1;
      }
      case 'boolean':
        return true;
      case 'enum':
        return Object.values((def as { entries: Record<string, unknown> }).entries)[0];
      case 'array':
        return [sample(def.element as never)];
      case 'record':
        return { anything: 'x' };
      case 'object': {
        const shape = (schema as unknown as { shape: Record<string, never> }).shape;
        return Object.fromEntries(Object.entries(shape).map(([key, value]) => [key, sample(value)]));
      }
      default:
        return 'x';
    }
  };

  for (const [name, def] of Object.entries(toolDefs)) {
    const args = sample(def.inputSchema as never) as Record<string, unknown>;
    const parsed = def.inputSchema.safeParse(args);
    assert.equal(
      parsed.success,
      true,
      `${name} rejected a call built entirely from its own declared fields: ${JSON.stringify(
        parsed.success ? {} : parsed.error.issues.map(i => i.message)
      )}`
    );
  }
});

// ---------------------------------------------------------------------------
// Finding 6: the ceiling fired with a bare "Request timed out"
// ---------------------------------------------------------------------------

const productionBounds: RequestTimeoutBounds = { floorMs: 60_000, ceilingMs: 10 * 60 * 1000 };

test('resolveRequestTimeout says WHICH bound decided the timeout, which is what makes the message possible', () => {
  assert.deepEqual(resolveRequestTimeout({}, productionBounds), { timeoutMs: 60_000, bound: 'floor' });
  assert.deepEqual(resolveRequestTimeout({ timeoutMs: 1500 }, productionBounds), {
    timeoutMs: 60_000,
    bound: 'floor',
    requestedMs: 1500
  });
  assert.deepEqual(resolveRequestTimeout({ timeoutMs: 150_000 }, productionBounds), {
    timeoutMs: 150_000 + requestTimeoutMarginMs,
    bound: 'requested',
    requestedMs: 150_000
  });
  assert.deepEqual(resolveRequestTimeout({ timeoutMs: 0 }, productionBounds), {
    timeoutMs: productionBounds.ceilingMs,
    bound: 'ceiling',
    requestedMs: 0
  });
  assert.deepEqual(resolveRequestTimeout({ timeoutMs: 999_999_999 }, productionBounds), {
    timeoutMs: productionBounds.ceilingMs,
    bound: 'ceiling',
    requestedMs: 999_999_999
  });
});

const clients: Client[] = [];
const configs: Config[] = [];

after(async () => {
  await Promise.all(clients.splice(0).map(client => client.close().catch(() => {})));
  for (const config of configs.splice(0)) {
    const health = await daemonHealth(config);
    if (!health) continue;
    try {
      process.kill(health.pid, 'SIGTERM');
    } catch {
      // Already gone, which is the outcome that was wanted anyway.
    }
    await waitFor(async () => (await daemonHealth(config)) === null, { timeoutMs: 10_000 }).catch(() => {});
  }
  cleanupTempDirs();
});

/**
 * Connects to a real wrapper process with its stderr piped, so a test can
 * read the operator-facing log the wrapper really wrote. The daemon writes
 * the same stream into `~/.harborage/daemon.log` in a real deployment, so
 * asserting on it is asserting on what an operator would actually read.
 */
async function connectWrapper(config: Config, name: string): Promise<{ client: Client; stderr: () => string }> {
  const client = new Client({ name, version: '1.0.0' });
  clients.push(client);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliEntry],
    env: wrapperEnv(config),
    stderr: 'pipe'
  });
  let captured = '';
  transport.stderr?.on('data', (chunk: Buffer) => {
    captured += chunk.toString();
  });
  await client.connect(transport);
  return { client, stderr: () => captured };
}

function resultText(result: { content: unknown }): string {
  return (result.content as { text?: string }[]).map(block => block.text ?? '').join('\n');
}

test('when the ceiling is what fires, the caller is told so, with its value and the variable that raises it', async () => {
  // A tiny configured ceiling, so this proves the real behaviour without the
  // suite waiting out the production ten minutes. requestTimeoutFor does not
  // care what the number is, only which bound wins, and the unit test above
  // pins the production defaults.
  const config = await makeTestConfig({
    sweepIntervalMs: 60_000,
    shutdownGraceMs: 60_000,
    requestTimeoutCeilingMs: 1500
  });
  configs.push(config);
  const { client, stderr } = await connectWrapper(config, 'round3-ceiling');

  const created = await client.callTool({ name: 'create_session', arguments: {} });
  const { sessionId } = created.structuredContent as { sessionId: string };

  const startedAt = Date.now();
  const result = await client.callTool(
    { name: 'wait_for', arguments: { sessionId, selector: '#never-appears', timeoutMs: 5000 } },
    { timeout: 30_000 }
  );
  const elapsedMs = Date.now() - startedAt;

  assert.ok(result.isError, `expected the ceiling to cut the call off, got: ${JSON.stringify(result)}`);
  const text = resultText(result);
  // The defect: the caller used to get exactly "MCP error -32001: Request
  // timed out", naming neither the ceiling, nor its value, nor the variable.
  assert.match(text, /ceiling/i, `the message must name the ceiling as what fired, got: ${text}`);
  assert.match(text, /1500ms/, `and its actual value, got: ${text}`);
  assert.match(text, /HARBORAGE_REQUEST_TIMEOUT_CEILING_MS/, `and the way to raise it, got: ${text}`);
  assert.match(text, /still be running/i, `and that the daemon was not cancelled, got: ${text}`);
  assert.match(text, /timeoutMs: 5000/, `and what the call had actually asked for, got: ${text}`);
  assert.ok(elapsedMs < 4000, `the ceiling must still be what bounds the call, took ${elapsedMs}ms`);

  // The other half of the finding: nothing was logged at the clamp. The
  // oracle is the wrapper process's real stderr, which is the stream a real
  // deployment redirects into daemon.log.
  await waitFor(() => /clamping its transport timeout/.test(stderr()), {
    timeoutMs: 5000,
    message: `nothing was logged at the clamp; wrapper stderr was:\n${stderr()}`
  });
  const log = stderr();
  assert.match(log, /wait_for asked for timeoutMs 5000ms/, `the log must name the tool and what it asked for, got: ${log}`);
  assert.match(log, /HARBORAGE_REQUEST_TIMEOUT_CEILING_MS/, `and the variable an operator would change, got: ${log}`);
});

test('evaluate\'s "wait forever" is logged as a clamp too, and says so when it fires', async () => {
  const config = await makeTestConfig({
    sweepIntervalMs: 60_000,
    shutdownGraceMs: 60_000,
    requestTimeoutCeilingMs: 1500
  });
  configs.push(config);
  const { client, stderr } = await connectWrapper(config, 'round3-forever');

  const created = await client.callTool({ name: 'create_session', arguments: {} });
  const { sessionId } = created.structuredContent as { sessionId: string };

  const result = await client.callTool(
    { name: 'evaluate', arguments: { sessionId, expression: 'new Promise(() => {})', timeoutMs: 0 } },
    { timeout: 30_000 }
  );
  assert.ok(result.isError, `expected the ceiling to bound "forever", got: ${JSON.stringify(result)}`);
  const text = resultText(result);
  assert.match(text, /ceiling/i, `got: ${text}`);
  assert.match(text, /wait forever/, `the message must connect the ceiling to what timeoutMs: 0 meant, got: ${text}`);

  await waitFor(() => /wait forever/.test(stderr()), {
    timeoutMs: 5000,
    message: `the clamp of a "wait forever" call was not logged; stderr was:\n${stderr()}`
  });
});

test('a call that times out under its own timeoutMs still gets the tool\'s real message, not the transport\'s', async () => {
  // The confirmed-working behaviour this must not regress: the timeout chain
  // itself works, verified at 70,015ms at production scale. Same branch,
  // proved in a second and a half with a shrunken floor.
  const config = await makeTestConfig({
    sweepIntervalMs: 60_000,
    shutdownGraceMs: 60_000,
    requestTimeoutFloorMs: 1000
  });
  configs.push(config);
  const { client, stderr } = await connectWrapper(config, 'round3-no-regress');

  const created = await client.callTool({ name: 'create_session', arguments: {} });
  const { sessionId } = created.structuredContent as { sessionId: string };

  const result = await client.callTool(
    { name: 'wait_for', arguments: { sessionId, selector: '#never-appears', timeoutMs: 1500 } },
    { timeout: 30_000 }
  );
  const text = resultText(result);
  assert.ok(result.isError, `expected wait_for's own timeout, got: ${JSON.stringify(result)}`);
  assert.match(text, /wait_for gave up after/, `the tool's own message must still win, got: ${text}`);
  assert.doesNotMatch(text, /ceiling/i, `nothing was clamped here, so the ceiling must not be mentioned, got: ${text}`);
  assert.doesNotMatch(stderr(), /clamping its transport timeout/, 'and nothing should have been logged as a clamp');
});
