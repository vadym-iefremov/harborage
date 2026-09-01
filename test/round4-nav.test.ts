import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';

import { BrowserManager } from '../src/daemon/browserManager.js';
import { createToolHandlers, type ToolHandlers } from '../src/daemon/tools/handlers.js';
import { SessionStore } from '../src/daemon/sessions.js';
import { getFreePort } from './helpers.js';

/**
 * Round-4 fixtures: an independent adversary attacked round 3's navigation
 * work and got through it nine ways. Every test here reproduces one of those,
 * and every one is graded the same way round 3's were, against something
 * outside the tool: the live document read WELL AFTER the call returned, the
 * test server's own log of what status it served for which path, and
 * Chromium's Page.getNavigationHistory (entry URLs included) over raw CDP.
 *
 * The "well after" is the point of several of them. A payload that is right
 * at the microsecond it is built and wrong by the time an agent reads it is
 * the defect, so these tests deliberately wait and then look again.
 */

/** Redirects after a delay the caller picks, so the settle window can be swept rather than guessed at. */
function lateShell(delayMs: number, to: string): string {
  return `<!doctype html>
<html><head><title>Shell ${delayMs}</title></head><body>
<script>setTimeout(function () { location.replace(${JSON.stringify(to)}); }, ${delayMs});</script>
</body></html>`;
}

/** A healthy 200 that rewrites its own URL on first paint, which is what nearly every client-side router does. */
const ROUTER_HTML = `<!doctype html>
<html><head><title>Router</title></head><body>
<div id="app">app</div>
<script>history.replaceState({}, '', '/virtual-route');</script>
</body></html>`;

const PUSH_ROUTER_HTML = `<!doctype html>
<html><head><title>Push router</title></head><body>
<script>history.pushState({}, '', '/pushed-route');</script>
</body></html>`;

/**
 * An SPA whose popstate handler does a FULL document load somewhere else.
 * The history index still moves the right way, because location.replace
 * replaces the entry in place, so a direction check alone cannot see it.
 * The mode is chosen by the test through window.__mode before the step.
 */
const SPA_HTML = `<!doctype html>
<html><head><title>SPA</title></head><body>
<div id="marker">spa</div>
<script>
  window.__mode = 'none';
  window.__pops = 0;
  window.addEventListener('popstate', function () {
    window.__pops++;
    var mode = window.__mode;
    window.__mode = 'none';
    if (mode === 'replace') location.replace('/login');
    else if (mode === 'assign') location.assign('/login');
    else if (mode === 'overshoot') history.go(-2);
  });
</script>
</body></html>`;

const LOGIN_HTML = `<!doctype html>
<html><head><title>LOGIN PAGE</title></head><body>
<div id="marker">login</div>
</body></html>`;

/** Replaces itself with itself, forever: the page that never stops navigating. */
const LOOP_HTML = `<!doctype html>
<html><head><title>Loop</title></head><body>
<script>location.replace('/loop');</script>
</body></html>`;

/**
 * Refuses to leave, but only once armed. Armed on demand because a page that
 * always refuses cannot be navigated PAST, so the forward-direction case
 * could not be set up at all against an unconditional one.
 */
const BEFOREUNLOAD_HTML = `<!doctype html>
<html><head><title>Sticky</title></head><body>
<div id="marker">sticky</div>
<script>
  window.__armed = false;
  window.addEventListener('beforeunload', function (e) {
    if (!window.__armed) return;
    e.preventDefault();
    e.returnValue = 'stay';
    return 'stay';
  });
</script>
</body></html>`;

/** A meta refresh that fires long after any sane settle window. */
const SLOW_META_HTML = `<!doctype html>
<html><head><title>Slow meta</title><meta http-equiv="refresh" content="1; url=/broken"></head>
<body>slow meta</body></html>`;

const PLAIN_HTML = `<!doctype html><html><head><title>Plain</title></head><body><div id="marker">plain</div></body></html>`;
const A_HTML = `<!doctype html><html><head><title>Page A</title></head><body>a</body></html>`;

const served: { path: string; status: number }[] = [];
/** How many times a stateful route has been asked for, so a reload can differ from the first visit. */
const loadCounts: Record<string, number> = {};

let server: Server;
let baseUrl: string;
let browserManager: BrowserManager;
let sessions: SessionStore;
let handlers: ToolHandlers;

before(async () => {
  server = createServer((req, res) => {
    const raw = req.url ?? '/';
    const [path, query = ''] = raw.split('#')[0]!.split('?') as [string, string?];
    const params = new URLSearchParams(query);
    let status = 200;
    let html: string;
    switch (path) {
      case '/broken':
        status = 500;
        html = '<!doctype html><html><head><title>Server error</title></head><body>500</body></html>';
        break;
      case '/late':
        html = lateShell(Number(params.get('ms') ?? '20'), params.get('to') ?? '/broken');
        break;
      case '/flakylate': {
        // Behaves on the first load and starts bouncing, late, on every load
        // after it. Only a RELOAD can reach the bouncing version, which is
        // what makes this a reload fixture and not a navigate one.
        const count = (loadCounts[path] = (loadCounts[path] ?? 0) + 1);
        html = count === 1 ? PLAIN_HTML : lateShell(120, '/broken');
        break;
      }
      case '/router':
        html = ROUTER_HTML;
        break;
      case '/pushrouter':
        html = PUSH_ROUTER_HTML;
        break;
      case '/spa':
        html = SPA_HTML;
        break;
      case '/login':
        html = LOGIN_HTML;
        break;
      case '/loop':
        html = LOOP_HTML;
        break;
      case '/sticky':
        html = BEFOREUNLOAD_HTML;
        break;
      case '/slowmeta':
        html = SLOW_META_HTML;
        break;
      case '/a':
        html = A_HTML;
        break;
      default:
        html = PLAIN_HTML;
    }
    served.push({ path, status });
    res.statusCode = status;
    res.setHeader('cache-control', 'no-store');
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(html);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

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

async function sessionOn(path: string): Promise<string> {
  const { sessionId } = await sessions.createSession();
  // Setup, not the thing under test: no settle window needed to put a
  // session on a page. Tests that exercise the settle pass the real one.
  await handlers.navigate({ sessionId, url: `${baseUrl}${path}`, settleMs: 0 });
  return sessionId;
}

async function evaluate<T>(sessionId: string, expression: string): Promise<T> {
  return payload(await handlers.evaluate({ sessionId, expression })).result as T;
}

/** Chromium's own back/forward list, entry URLs included, over raw CDP. */
async function realHistory(sessionId: string): Promise<{ index: number; length: number; urls: string[] }> {
  const body = payload(await handlers.send_cdp_command({ sessionId, method: 'Page.getNavigationHistory' }));
  const result = body.result as { currentIndex: number; entries: { url: string }[] };
  return { index: result.currentIndex, length: result.entries.length, urls: result.entries.map(e => e.url) };
}

/** Waits in real time, then reports what the tab is ACTUALLY showing. That gap is where round 3's answers went stale. */
async function settledTruth(sessionId: string, waitMs: number): Promise<{ url: string; title: string }> {
  await new Promise(resolve => setTimeout(resolve, waitMs));
  return {
    url: await evaluate<string>(sessionId, 'location.href'),
    title: await evaluate<string>(sessionId, 'document.title')
  };
}

// ---------------------------------------------------------------------------
// 1. The settle window has to be the window that is advertised.
// ---------------------------------------------------------------------------

for (const delay of [20, 50, 150, 300, 450]) {
  test(`navigate catches a client-side redirect fired ${delay}ms after load`, async () => {
    const sessionId = await sessionOn('/plain');
    const body = payload(await handlers.navigate({ sessionId, url: `${baseUrl}/late?ms=${delay}&to=/broken` }));

    // Long enough past the fixture's own delay to prove the redirect really
    // happened, without padding every case out to the slowest one.
    const truth = await settledTruth(sessionId, delay + 350);
    assert.equal(truth.url, `${baseUrl}/broken`, 'the fixture must really have redirected');
    assert.equal(truth.title, 'Server error');
    assert.equal(served.filter(e => e.path === '/broken').at(-1)?.status, 500);

    assert.equal(body.url, truth.url, `the payload must describe the document that is really there, ${delay}ms redirect`);
    assert.equal(body.title, truth.title);
    assert.equal(body.status, 500, `ok/status must describe the 500, not the shell that fetched at 200 (${delay}ms)`);
    assert.equal(body.ok, false);
    assert.ok(body.documentChanged, 'the page moved itself and that must be stated');

    await sessions.releaseSession(sessionId);
  });
}

test('navigate discloses a pending meta refresh it could not wait out, rather than going quiet about it', async () => {
  const sessionId = await sessionOn('/plain');
  const body = payload(await handlers.navigate({ sessionId, url: `${baseUrl}/slowmeta` }));

  // The refresh fires a full second later, past any settle window worth
  // paying for on every call. The tool cannot wait that long, but it CAN see
  // the meta tag sitting in the document it is describing, and saying so is
  // the difference between a disclosed limit and a silent wrong answer.
  assert.equal(body.url, `${baseUrl}/slowmeta`);
  assert.ok(body.pendingNavigation, `a document holding a meta refresh must be flagged, got ${JSON.stringify(body)}`);
  assert.match(String(body.pendingNavigation.reason ?? ''), /meta refresh/i);
  assert.equal(body.pendingNavigation.url, `${baseUrl}/broken`);
  assert.match(String(body.note), /meta refresh/i);

  const truth = await settledTruth(sessionId, 1300);
  assert.equal(truth.url, `${baseUrl}/broken`, 'the fixture really does move on, which is why the warning matters');

  await sessions.releaseSession(sessionId);
});

test('reload catches a client-side redirect fired 120ms after the reloaded document loads', async () => {
  const sessionId = await sessionOn('/flakylate');
  // The first load is the well-behaved version, so the tab is genuinely
  // sitting on a page that only starts bouncing when it is reloaded.
  assert.equal(await evaluate<string>(sessionId, 'document.title'), 'Plain');

  const body = payload(await handlers.reload({ sessionId }));

  const truth = await settledTruth(sessionId, 900);
  assert.equal(truth.url, `${baseUrl}/broken`, 'the reload must really have bounced');
  assert.equal(truth.title, 'Server error');
  assert.equal(served.filter(e => e.path === '/broken').at(-1)?.status, 500);

  assert.equal(body.url, truth.url, 'reload must run the same settle navigate does');
  assert.equal(body.title, truth.title);
  assert.equal(body.status, 500);
  assert.equal(body.ok, false);
  assert.ok(body.documentChanged, 'the page moved itself and reload must say so');

  await sessions.releaseSession(sessionId);
});

test('an ordinary reload of a static page is still a clean 200 with nothing pending', async () => {
  const sessionId = await sessionOn('/a');
  const body = payload(await handlers.reload({ sessionId }));
  assert.equal(body.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.documentChanged, undefined);
  assert.equal(body.pendingNavigation, undefined);
  assert.equal(body.timedOut, undefined);

  await sessions.releaseSession(sessionId);
});

// ---------------------------------------------------------------------------
// 2 and 7. historyStep needs the settle too: it is the missed sibling.
// ---------------------------------------------------------------------------

for (const mode of ['replace', 'assign'] as const) {
  test(`navigate_back whose popstate handler calls location.${mode} reports the document that really loaded`, async () => {
    const sessionId = await sessionOn('/spa');
    await evaluate(sessionId, "history.pushState({}, '', '/spa#list')");
    await evaluate(sessionId, "history.pushState({}, '', '/spa#detail')");
    await evaluate(sessionId, `window.__mode = '${mode}'`);

    const body = payload(await handlers.navigate_back({ sessionId }));

    // Oracle, read well after the call: the live document and CDP history.
    const truth = await settledTruth(sessionId, 500);
    const history = await realHistory(sessionId);
    assert.equal(truth.title, 'LOGIN PAGE', 'the guard must really have loaded a whole new document');
    assert.equal(new URL(truth.url).pathname, '/login');

    assert.equal(body.url, truth.url, `"url" must say where the tab really ended up (location.${mode})`);
    assert.equal(body.title, truth.title, 'the title must belong to the document the url names');
    assert.equal(
      body.sameDocument,
      false,
      'a full document load is not a same-document step, and must not promise the JS context survived'
    );
    assert.equal(body.navigated, false, 'the caller did not get the entry they asked for');
    assert.equal(body.historyIndex, history.index);
    assert.match(String(body.note), /guard|intercept|blocked|elsewhere|instead/i);
    assert.doesNotMatch(
      String(body.note),
      /JS context, in-page state and the console buffer all survive/,
      'the same-document reassurance must not appear for a step that reloaded the document'
    );

    await sessions.releaseSession(sessionId);
  });
}

test('navigate_back into a page that tidies its own URL with replaceState is NOT reported as a blocked step', async () => {
  // The mirror risk of the fix above: an app relabelling its own URL after
  // arriving is healthy and extremely common, and crying "blocked" at it
  // would repeat the over-correction that blanked a true "ok" last round.
  const sessionId = await sessionOn('/spa');
  await evaluate(sessionId, "history.pushState({}, '', '/spa#list')");
  await evaluate(sessionId, "history.pushState({}, '', '/spa#detail')");
  await evaluate(
    sessionId,
    "window.addEventListener('popstate', function () { history.replaceState({}, '', '/spa#list-tidied'); })"
  );

  const body = payload(await handlers.navigate_back({ sessionId }));
  const truth = await settledTruth(sessionId, 300);

  assert.equal(truth.url, `${baseUrl}/spa#list-tidied`, 'the fixture must really rewrite the URL');
  assert.equal(truth.title, 'SPA', 'and it must do so WITHOUT loading a new document');
  assert.equal(body.navigated, true, 'the tab did go back one entry; the app merely relabelled the URL afterwards');
  assert.equal(body.url, truth.url, '"url" still reports the relabelled address');
  assert.equal(body.sameDocument, true);

  await sessions.releaseSession(sessionId);
});

test('navigate_forward whose popstate handler calls location.replace is caught the same way the back case is', async () => {
  // The third instance of the pattern that has bitten this project twice: a
  // mechanism tested in one direction and assumed symmetric in the other.
  // The entry-swap attack (location.replace, which moves the index exactly
  // one the RIGHT way while swapping the destination underneath it) was only
  // ever tested going back. This is the forward half, and it is written
  // because assuming symmetry is precisely what let a go(-2) back step slip
  // through the forward test written for it a round ago.
  const sessionId = await sessionOn('/spa');
  await evaluate(sessionId, "history.pushState({}, '', '/spa#list')");
  await evaluate(sessionId, "history.pushState({}, '', '/spa#detail')");

  const back = payload(await handlers.navigate_back({ sessionId }));
  assert.equal(back.navigated, true, 'the setup back step must itself be clean');
  assert.equal(back.url, `${baseUrl}/spa#list`);

  await evaluate(sessionId, "window.__mode = 'replace'");
  const before = await realHistory(sessionId);
  const body = payload(await handlers.navigate_forward({ sessionId }));

  const truth = await settledTruth(sessionId, 400);
  const history = await realHistory(sessionId);
  assert.equal(truth.title, 'LOGIN PAGE', 'the guard must really have loaded a whole new document');
  assert.equal(
    history.index,
    before.index + 1,
    'the index still moves exactly one FORWARD, which is why a direction check alone cannot see this'
  );

  assert.equal(body.navigated, false, 'the caller did not get the entry they asked for');
  assert.equal(body.url, truth.url);
  assert.equal(body.title, truth.title);
  assert.equal(body.sameDocument, false);
  assert.match(String(body.note), /aimed|guard|intercept|blocked|instead/i);

  await sessions.releaseSession(sessionId);
});

test('navigate_forward blocked by a beforeunload handler reports a blocked step too', async () => {
  const sessionId = await sessionOn('/a');
  await handlers.navigate({ sessionId, url: `${baseUrl}/sticky`, settleMs: 0 });
  await handlers.navigate({ sessionId, url: `${baseUrl}/plain`, settleMs: 0 });
  // Back to /sticky first, while it is still unarmed, so there is a real
  // forward entry to be refused.
  await handlers.navigate_back({ sessionId, settleMs: 0 });
  await evaluate(sessionId, 'window.__armed = true');

  const started = Date.now();
  const body = payload(await handlers.navigate_forward({ sessionId, timeoutMs: 1500 }));
  assert.ok(Date.now() - started < 15000, 'the call must not hang for the full Playwright default');
  assert.equal(body.navigated, false);
  assert.match(String(body.note), /beforeunload|refus|block|did not finish/i);

  await sessions.releaseSession(sessionId);
});

// ---------------------------------------------------------------------------
// 3. Direction is not enough: magnitude and destination matter.
// ---------------------------------------------------------------------------

test('navigate_back whose guard overshoots two extra entries is not a clean single back step', async () => {
  const sessionId = await sessionOn('/a');
  await handlers.navigate({ sessionId, url: `${baseUrl}/spa`, settleMs: 0 });
  await evaluate(sessionId, "history.pushState({}, '', '/spa#one')");
  await evaluate(sessionId, "history.pushState({}, '', '/spa#two')");
  await evaluate(sessionId, "window.__mode = 'overshoot'");

  const before = await realHistory(sessionId);
  const aimedAt = before.urls[before.index - 1];
  const body = payload(await handlers.navigate_back({ sessionId }));

  const truth = await settledTruth(sessionId, 500);
  const history = await realHistory(sessionId);
  assert.ok(
    history.index <= before.index - 2,
    `the fixture must really overshoot: index went ${before.index} to ${history.index}`
  );
  assert.notEqual(truth.url, aimedAt, 'the tab must really have landed somewhere other than the entry the step aimed at');

  assert.equal(
    body.navigated,
    false,
    'a back step that travelled three entries is not the single step back the caller asked for'
  );
  assert.equal(body.url, truth.url, '"url" must say where the tab really ended up');
  assert.equal(body.historyIndex, history.index);
  assert.match(String(body.note), /entr|overshoot|aimed|instead|elsewhere/i);

  await sessions.releaseSession(sessionId);
});

// ---------------------------------------------------------------------------
// 4. The over-correction: a healthy page that rewrites its own URL.
// ---------------------------------------------------------------------------

for (const [route, label] of [['/router', 'replaceState'], ['/pushrouter', 'pushState']] as const) {
  test(`navigate to a healthy 200 that calls ${label} on load still reports ok: true`, async () => {
    const sessionId = await sessionOn('/plain');
    const body = payload(await handlers.navigate({ sessionId, url: `${baseUrl}${route}` }));

    assert.equal(served.filter(e => e.path === route).at(-1)?.status, 200, 'the server really did answer 200');
    const truth = await settledTruth(sessionId, 200);
    assert.equal(new URL(truth.url).pathname, route === '/router' ? '/virtual-route' : '/pushed-route');

    assert.equal(body.status, 200, `a healthy document must keep its real status through a ${label} rewrite`);
    assert.equal(body.ok, true, 'turning a true "ok" into null is the opposite of what this round is for');
    assert.equal(
      body.documentChanged,
      undefined,
      `nothing was re-fetched, so claiming the document changed contradicts the single entry in the payload (${label})`
    );

    await sessions.releaseSession(sessionId);
  });
}

// ---------------------------------------------------------------------------
// 5. A page that never stops navigating must not hang the call.
// ---------------------------------------------------------------------------

test('navigate to a page that redirects to itself forever reports what it found instead of throwing a raw timeout', async () => {
  const sessionId = await sessionOn('/plain');
  const started = Date.now();
  const body = payload(await handlers.navigate({ sessionId, url: `${baseUrl}/loop`, timeoutMs: 1200 }));
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 15000, `the call must not hang: took ${elapsed}ms`);
  assert.ok(body.pendingNavigation, 'a page still navigating when the call gave up must say so');
  assert.match(String(body.note), /still navigating|redirect loop|did not settle/i);
  assert.equal(new URL(String(body.url)).pathname, '/loop');

  await sessions.releaseSession(sessionId);
});

// ---------------------------------------------------------------------------
// 6. A beforeunload handler is a blocked step, which this tool documents.
// ---------------------------------------------------------------------------

test('navigate_back blocked by a beforeunload handler reports a blocked step, not a raw Playwright timeout', async () => {
  const sessionId = await sessionOn('/a');
  await handlers.navigate({ sessionId, url: `${baseUrl}/sticky`, settleMs: 0 });
  await evaluate(sessionId, 'window.__armed = true');

  const started = Date.now();
  const body = payload(await handlers.navigate_back({ sessionId, timeoutMs: 1500 }));
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 15000, `the call must not hang for the full Playwright default: took ${elapsed}ms`);
  assert.equal(body.navigated, false, 'a step the page refused is a blocked step');
  assert.match(String(body.note), /beforeunload|refus|block|did not finish/i);

  await sessions.releaseSession(sessionId);
});

test('navigate away from a page that refuses to leave reports a blocked navigation, not a raw ERR_ABORTED', async () => {
  // Found while writing the forward-direction beforeunload test above: the
  // setup for it could not even be built, because navigating AWAY from an
  // armed beforeunload page rejected with "page.goto: net::ERR_ABORTED".
  // Same situation as the history-step case, a different tool, and a raw
  // Playwright error either way.
  const sessionId = await sessionOn('/a');
  await handlers.navigate({ sessionId, url: `${baseUrl}/sticky`, settleMs: 0 });
  await evaluate(sessionId, 'window.__armed = true');

  const body = payload(await handlers.navigate({ sessionId, url: `${baseUrl}/plain`, settleMs: 0 }));

  const live = await evaluate<string>(sessionId, 'location.href');
  assert.equal(live, `${baseUrl}/sticky`, 'the page really did refuse to leave');
  assert.equal(body.blocked, true, 'a refusal is a fact about the page and belongs in the payload');
  assert.equal(body.url, live, 'the payload must describe where the tab really is');
  assert.match(String(body.note), /beforeunload|abandoned|did not move/i);
  assert.equal(body.status, null, 'nothing was fetched, so there is no status to report');

  await sessions.releaseSession(sessionId);
});

// ---------------------------------------------------------------------------
// 9. Two history steps at once must not reject with a detached-frame error.
// ---------------------------------------------------------------------------

test('two navigate_back calls issued at once queue instead of tearing each other down', async () => {
  const sessionId = await sessionOn('/a');
  await handlers.navigate({ sessionId, url: `${baseUrl}/plain`, settleMs: 0 });
  await handlers.navigate({ sessionId, url: `${baseUrl}/spa`, settleMs: 0 });

  const before = await realHistory(sessionId);
  const results = await Promise.allSettled([
    handlers.navigate_back({ sessionId }),
    handlers.navigate_back({ sessionId })
  ]);

  const rejected = results.filter(r => r.status === 'rejected');
  assert.equal(
    rejected.length,
    0,
    `neither call may reject: ${rejected.map(r => String((r as PromiseRejectedResult).reason)).join(' | ')}`
  );

  const history = await realHistory(sessionId);
  assert.equal(history.index, before.index - 2, 'two back steps really should move two entries');

  await sessions.releaseSession(sessionId);
});

test('two navigate calls and two reloads issued at once queue instead of aborting each other', async () => {
  // The sibling of the history-step concurrency defect, found by probing for
  // it rather than waiting to be told: before serializing, concurrent
  // navigate rejected with net::ERR_ABORTED and concurrent reload rejected
  // with "maybe frame was detached?", on both calls.
  const sessionId = await sessionOn('/a');
  const navResults = await Promise.allSettled([
    handlers.navigate({ sessionId, url: `${baseUrl}/plain` }),
    handlers.navigate({ sessionId, url: `${baseUrl}/spa` })
  ]);
  assert.deepEqual(
    navResults.map(r => r.status),
    ['fulfilled', 'fulfilled'],
    `neither navigate may reject: ${navResults.map(r => (r.status === 'rejected' ? String(r.reason) : 'ok')).join(' | ')}`
  );
  assert.equal(await evaluate<string>(sessionId, 'location.pathname'), '/spa', 'the second navigation is the one that wins');

  const reloadResults = await Promise.allSettled([handlers.reload({ sessionId }), handlers.reload({ sessionId })]);
  assert.deepEqual(
    reloadResults.map(r => r.status),
    ['fulfilled', 'fulfilled'],
    `neither reload may reject: ${reloadResults.map(r => (r.status === 'rejected' ? String(r.reason) : 'ok')).join(' | ')}`
  );

  await sessions.releaseSession(sessionId);
});

// ---------------------------------------------------------------------------
// The third instance of the missed-sibling pattern, found by hunting for it
// rather than being told: new_tab navigates too, and reported page.url() read
// immediately after its goto.
// ---------------------------------------------------------------------------

test('new_tab opened on a shell that redirects late reports the document it really landed on', async () => {
  const { sessionId } = await sessions.createSession();
  const opened = payload(await handlers.new_tab({ sessionId, url: `${baseUrl}/late?ms=150&to=/broken` }));

  const truth = {
    url: await evaluate<string>(sessionId, 'location.href'),
    title: await evaluate<string>(sessionId, 'document.title')
  };
  assert.equal(truth.url, `${baseUrl}/broken`, 'the fixture must really have redirected');
  assert.equal(served.filter(e => e.path === '/broken').at(-1)?.status, 500);

  assert.equal(opened.url, truth.url, 'new_tab must report where the tab really ended up, not where it was pointed');
  assert.equal(opened.title, truth.title);
  assert.equal(opened.status, 500, 'opening a tab on a bouncing shell must not look like an ordinary success');
  assert.equal(opened.ok, false);
  assert.ok(opened.documentChanged);
  assert.equal(typeof opened.pageId, 'string');

  await sessions.releaseSession(sessionId);
});

test('new_tab opened on a 404 reports the 404, and a blank new_tab reports no status at all', async () => {
  const { sessionId } = await sessions.createSession();
  const missing = payload(await handlers.new_tab({ sessionId, url: `${baseUrl}/broken` }));
  assert.equal(missing.status, 500);
  assert.equal(missing.ok, false);
  assert.equal(missing.documentChanged, undefined);

  const blank = payload(await handlers.new_tab({ sessionId }));
  assert.equal(typeof blank.pageId, 'string');
  assert.equal(blank.status, undefined, 'nothing was fetched, so there is no status to report');
  assert.equal(blank.documentChanged, undefined);

  await sessions.releaseSession(sessionId);
});

// ---------------------------------------------------------------------------
// 8. Disclosure: the nth= in a rebuilt prefix is positional and can go stale.
// ---------------------------------------------------------------------------

test('find and list_frames both disclose that a frame prefix index is positional and can go stale', async () => {
  const { toolDefs } = await import('../src/daemon/tools/schemas.js');
  const find = toolDefs.find.description;
  const listFrames = toolDefs.list_frames.description;

  assert.match(find, /nth=/, 'find must name the index it pins');
  assert.match(
    find,
    /stale|shift|insert|re-?read|changes? position/i,
    'find must say the frame index can stop being right when the page changes'
  );
  assert.match(listFrames, /nth=/, 'list_frames hands out the prefixes, so it must name the index too');
  assert.match(
    listFrames,
    /stale|shift|insert|re-?read/i,
    'list_frames must say the index inside a selectorPrefix can go stale, not only that frame ids do'
  );

  await Promise.resolve();
});

test('list_frames explains an unavailable prefix as well as find does, and does not imply shadow DOM is a non-issue for frames', async () => {
  const { toolDefs } = await import('../src/daemon/tools/schemas.js');
  const listFrames = toolDefs.list_frames.description;
  assert.match(listFrames, /shadow root/i, 'the usual cause of an unbuildable prefix is a frame inside a shadow root');
  assert.match(listFrames, /frameId|frame id/i, 'it must name the way forward when no prefix can be built');
  assert.doesNotMatch(
    listFrames,
    /so no prefix is needed there/,
    'that sentence is true for elements and false for frames, which is exactly where a prefix cannot be built'
  );
  await Promise.resolve();
});
