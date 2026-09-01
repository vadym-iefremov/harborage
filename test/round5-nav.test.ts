import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { after, before, test } from 'node:test';

import { BrowserManager } from '../src/daemon/browserManager.js';
import { createToolHandlers, type ToolHandlers } from '../src/daemon/tools/handlers.js';
import { SessionStore } from '../src/daemon/sessions.js';
import { getFreePort } from './helpers.js';

/**
 * Round-5 fixtures: a second independent adversary attacked round 4's
 * navigation work. Every test here reproduces one of what it found, and every
 * one was run against the unfixed tree first and watched to fail, because
 * nine of the fourteen apparent failures in that round turned out to be bugs
 * in the probe rather than in the product.
 *
 * Graded the same way round 4's were, against something outside the tool:
 * wall-clock elapsed around the call, the fixture server's own log, the live
 * document read afterwards through a raw page.evaluate, and Chromium's own
 * navigation history over raw CDP.
 *
 * Timing assertions here are deliberately generous ceilings rather than tight
 * ranges. The defect they encode is unboundedness (20001ms against a 1500ms
 * budget), so a ceiling of a few times the budget separates "bounded" from
 * "not bounded" without turning into a flake on a loaded laptop.
 */

/** A shell that fires location.replace at ?at= ms, aimed at a target the server answers after ?wait= ms. */
function lateShell(at: number, to: string): string {
  return `<!doctype html>
<html><head><title>Shell ${at}</title></head><body>
<script>setTimeout(function () { location.replace(${JSON.stringify(to)}); }, ${at});</script>
</body></html>`;
}

/** A healthy 200 that rewrites its own URL on first paint. Must keep reporting its 200. */
const ROUTER_HTML = `<!doctype html>
<html><head><title>Router</title></head><body><div id="app">app</div>
<script>history.replaceState({}, '', '/virtual-route');</script>
</body></html>`;

/** An SPA whose popstate handler acts, in whichever way the test arms. */
const GUARD_HTML = `<!doctype html>
<html><head><title>Guard</title></head><body><div id="m">app</div>
<script>
  window.__mode = 'none';
  window.addEventListener('popstate', function () {
    var mode = window.__mode; window.__mode = 'none';
    if (mode === 'rewrite') history.replaceState({}, '', '/app/login');
    if (mode === 'overshoot') history.go(-1);
  });
</script>
</body></html>`;

/** An SPA that tidies its own URL on arrival, the healthy twin of the rewrite guard. */
const TIDY_HTML = `<!doctype html>
<html><head><title>Tidy</title></head><body>
<script>history.replaceState({}, '', location.pathname + '?tidied=1');</script>
</body></html>`;

/** Every request the fixture served, with the status, so a payload can be graded against the wire. */
const served: { path: string; status: number; at: number }[] = [];
let t0 = Date.now();
/** Sockets deliberately left unanswered, destroyed in `after` so nothing outlives the run. */
const hungSockets: Socket[] = [];
let sameHits = 0;

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
    const send = (status: number, html: string, headers: Record<string, string> = {}): void => {
      served.push({ path, status, at: Date.now() - t0 });
      res.statusCode = status;
      res.setHeader('cache-control', 'no-store');
      res.setHeader('content-type', 'text/html; charset=utf-8');
      for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
      res.end(html);
    };

    switch (path) {
      case '/hang':
        // Accepted and never answered. The wedged backend.
        served.push({ path, status: 0, at: Date.now() - t0 });
        hungSockets.push(req.socket);
        return;
      case '/same': {
        // First visit serves a document that replaces itself AT THE SAME
        // ADDRESS; the second serves a different document, with a different
        // status, at that same address.
        sameHits += 1;
        if (sameHits === 1) {
          return send(
            200,
            `<!doctype html><html><head><title>Same first</title></head><body>
             <script>location.replace(location.href);</script></body></html>`
          );
        }
        return send(503, '<!doctype html><html><head><title>Service Unavailable</title></head><body>503</body></html>');
      }
      case '/lateshell':
        return send(200, lateShell(Number(params.get('at') ?? '100'), `/slowtarget?wait=${params.get('wait') ?? '900'}`));
      case '/slowtarget': {
        const wait = Number(params.get('wait') ?? '900');
        setTimeout(
          () => send(500, '<!doctype html><html><head><title>Slow target</title></head><body>500</body></html>'),
          wait
        );
        return;
      }
      case '/blankshell':
        return send(200, lateShell(80, 'about:blank'));
      case '/busy':
        return send(
          200,
          `<!doctype html><html><head><title>Busy</title></head><body>
           <script>var end = Date.now() + ${Number(params.get('ms') ?? '3000')}; while (Date.now() < end) {}</script>
           </body></html>`
        );
      case '/nocontent':
        served.push({ path, status: 204, at: Date.now() - t0 });
        res.statusCode = 204;
        return res.end();
      case '/download':
        served.push({ path, status: 200, at: Date.now() - t0 });
        res.statusCode = 200;
        res.setHeader('content-type', 'application/octet-stream');
        res.setHeader('content-disposition', 'attachment; filename="thing.bin"');
        return res.end('binary-ish');
      case '/router':
        return send(200, ROUTER_HTML);
      case '/tidy':
        return send(200, TIDY_HTML);
      case '/healthy':
        return send(200, '<!doctype html><html><head><title>Healthy</title></head><body>healthy</body></html>');
      default:
        return send(200, GUARD_HTML);
    }
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
  for (const socket of hungSockets) socket.destroy();
  await sessions.closeAll();
  await browserManager.close();
  await new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve())));
});

function payload(result: unknown): Record<string, any> {
  return (result as { structuredContent: Record<string, any> }).structuredContent;
}

async function sessionOn(path: string): Promise<string> {
  const { sessionId } = await sessions.createSession();
  await handlers.navigate({ sessionId, url: `${baseUrl}${path}`, settleMs: 0 });
  return sessionId;
}

/** The live document, read raw, so no assertion below is graded against what the tool chose to report. */
function liveDocument(sessionId: string): Promise<{ url: string; title: string; status: number | null }> {
  return sessions.resolve(sessionId).page.evaluate(() => ({
    url: location.href,
    title: document.title,
    status: (performance.getEntriesByType('navigation')[0] as { responseStatus?: number } | undefined)?.responseStatus ?? null
  }));
}

// ---------------------------------------------------------------------------
// Finding 1: timeoutMs is a ceiling on the whole call
// ---------------------------------------------------------------------------

test('navigate at a backend that never answers returns inside timeoutMs instead of running for twenty seconds', async () => {
  const { sessionId } = await sessions.createSession();
  const started = Date.now();
  const result = payload(await handlers.navigate({ sessionId, url: `${baseUrl}/hang`, timeoutMs: 1500 }));
  const elapsed = Date.now() - started;

  // Measured at 20001ms before this was bounded, against the same 1500ms
  // budget. Five seconds separates "bounded" from "not bounded" with room to
  // spare for a busy machine.
  assert.ok(elapsed < 5000, `navigate given 1500ms took ${elapsed}ms`);
  assert.equal(result.timedOut, true);
  assert.ok(result.pendingNavigation, 'a call that gave up must say so');
  // The reported reason must not diagnose a redirect loop when nothing was
  // ever fetched.
  assert.ok(
    !/redirect loop/.test(String(result.pendingNavigation.reason)),
    `nothing was fetched, so a redirect loop is the wrong diagnosis: ${result.pendingNavigation.reason}`
  );
  assert.equal(sessions.inFlightCount(sessionId), 0, 'a call that returned must not leave an in-flight entry vetoing the reaper');
  await sessions.releaseSession(sessionId);
});

test('a second call on a session left wedged by a hung backend is bounded too', async () => {
  const { sessionId } = await sessions.createSession();
  await handlers.navigate({ sessionId, url: `${baseUrl}/hang`, timeoutMs: 1000 });
  // This is the leg that used to hang BEFORE issuing its own goto: the
  // pre-navigation read of the page. The fixture server never saw the healthy
  // URL at all while it was unbounded.
  const started = Date.now();
  await handlers.navigate({ sessionId, url: `${baseUrl}/healthy`, timeoutMs: 1500 });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 5000, `the follow-up call took ${elapsed}ms`);
  await sessions.releaseSession(sessionId);
});

test('new_tab at a backend that never answers is bounded on the same terms', async () => {
  const { sessionId } = await sessions.createSession();
  const started = Date.now();
  const result = payload(await handlers.new_tab({ sessionId, url: `${baseUrl}/hang`, timeoutMs: 1500 }));
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 5000, `new_tab given 1500ms took ${elapsed}ms`);
  assert.equal(result.timedOut, true);
  await sessions.releaseSession(sessionId);
});

test('navigate against a page blocking its own main thread returns inside timeoutMs', async () => {
  const { sessionId } = await sessions.createSession();
  const started = Date.now();
  const result = payload(await handlers.navigate({ sessionId, url: `${baseUrl}/busy?ms=3000`, timeoutMs: 300 }));
  const elapsed = Date.now() - started;
  // The page blocks for 3000ms. Before the read was bounded the call waited
  // it out in full despite a 300ms budget.
  assert.ok(elapsed < 2000, `navigate given 300ms against a 3000ms block took ${elapsed}ms`);
  assert.equal(result.timedOut, true);
  await sessions.releaseSession(sessionId);
});

test('a call queued behind a wedged navigate is no longer stuck forever behind it', async () => {
  // The escalation the ceiling exists to stop. navigate and click are both
  // serialized per session, so anything issued while a navigate is wedged
  // waits on the same input lock: one hung call used to brick the whole
  // session, not merely itself. Measured directly before the fix, a click
  // issued 300ms into the wedge was still queued at 15002ms.
  //
  // A second navigate is used as the queued call rather than a click, because
  // it is the one whose own bound is this project's to guarantee. A click
  // against a renderer that cannot answer is bounded by Playwright's own
  // action timeout, which is a different budget.
  const sessionId = await sessionOn('/healthy');
  const started = Date.now();
  const wedged = handlers.navigate({ sessionId, url: `${baseUrl}/hang`, timeoutMs: 1000 });
  await new Promise<void>(resolve => setTimeout(resolve, 200));
  const queued = handlers.navigate({ sessionId, url: `${baseUrl}/healthy`, timeoutMs: 1500 });
  await Promise.all([wedged, queued]);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 8000, `the queued call took ${elapsed}ms to get through`);
  assert.equal(sessions.inFlightCount(sessionId), 0);
  await sessions.releaseSession(sessionId);
});

// ---------------------------------------------------------------------------
// Finding 2: two documents at one address
// ---------------------------------------------------------------------------

test('a page that replaces itself at the same URL reports the LIVE document status, not the dead one', async () => {
  sameHits = 0;
  served.length = 0;
  const { sessionId } = await sessions.createSession();
  const result = payload(await handlers.navigate({ sessionId, url: `${baseUrl}/same` }));

  const wire = served.filter(entry => entry.path === '/same').map(entry => entry.status);
  assert.deepEqual(wire, [200, 503], 'the fixture must actually serve two different statuses at one address');

  const live = await liveDocument(sessionId);
  assert.equal(live.status, 503, 'the live document must be the 503');
  assert.equal(result.status, 503, 'the payload must describe the document on screen, not the one it replaced');
  assert.equal(result.ok, false);
  assert.equal(result.title, live.title);
  assert.ok(result.documentChanged, 'two documents at one address is still a document change');
  assert.deepEqual(
    result.documentChanged.documents.map((entry: { status: number }) => entry.status),
    [200, 503]
  );
  await sessions.releaseSession(sessionId);
});

test('reload of a page that replaces itself at the same URL reports the live document status too', async () => {
  const { sessionId } = await sessions.createSession();
  sameHits = 0;
  await handlers.navigate({ sessionId, url: `${baseUrl}/same`, settleMs: 0 });
  sameHits = 0;
  served.length = 0;
  const result = payload(await handlers.reload({ sessionId }));

  const wire = served.filter(entry => entry.path === '/same').map(entry => entry.status);
  assert.deepEqual(wire, [200, 503]);
  const live = await liveDocument(sessionId);
  assert.equal(live.status, 503);
  assert.equal(result.status, 503, 'reload took the identical fix through the identical helper');
  assert.equal(result.ok, false);
  await sessions.releaseSession(sessionId);
});

test('new_tab onto a page that replaces itself at the same URL reports the live document status', async () => {
  const { sessionId } = await sessions.createSession();
  sameHits = 0;
  const result = payload(await handlers.new_tab({ sessionId, url: `${baseUrl}/same` }));
  const live = await sessions
    .resolve(sessionId, result.pageId)
    .page.evaluate(() => (performance.getEntriesByType('navigation')[0] as { responseStatus?: number } | undefined)?.responseStatus ?? null);
  assert.equal(live, 503);
  assert.equal(result.status, 503);
  await sessions.releaseSession(sessionId);
});

// ---------------------------------------------------------------------------
// Finding 3: a redirect requested inside the window, answered outside it
// ---------------------------------------------------------------------------

test('a redirect fired inside the settle window is never silently reported as the shell, however slow its target', async () => {
  for (const at of [100, 300]) {
    const { sessionId } = await sessions.createSession();
    const result = payload(await handlers.navigate({ sessionId, url: `${baseUrl}/lateshell?at=${at}&wait=900` }));

    // Graded as a property rather than a literal, because whether the target
    // lands inside the in-flight tail is a latency question. Either the
    // redirect is caught and described, or it is disclosed. What must never
    // happen is the third thing, which is what used to happen: a confident
    // 200, ok true, describing the shell, with nothing said at all.
    const caught = result.status === 500 && result.ok === false && result.documentChanged !== undefined;
    const disclosed = result.pendingNavigation !== undefined;
    assert.ok(caught || disclosed, `redirect at ${at}ms was reported silently: ${JSON.stringify(result)}`);
    assert.ok(!(result.ok === true && !disclosed), `ok: true with no disclosure, for a redirect fired at ${at}ms`);

    // And the live document, read well after the call returned, is the target.
    await new Promise<void>(resolve => setTimeout(resolve, 1500));
    const live = await liveDocument(sessionId);
    assert.equal(live.status, 500, 'the fixture really did redirect');
    await sessions.releaseSession(sessionId);
  }
});

test('a redirect whose target never answers inside the tail is disclosed rather than presented as settled', async () => {
  const { sessionId } = await sessions.createSession();
  const result = payload(await handlers.navigate({ sessionId, url: `${baseUrl}/lateshell?at=100&wait=6000`, timeoutMs: 4000 }));
  assert.ok(result.pendingNavigation, `a navigation still in flight must be disclosed: ${JSON.stringify(result)}`);
  assert.ok(
    String(result.pendingNavigation.reason).includes('slowtarget') || result.pendingNavigation.url?.includes('slowtarget'),
    'the disclosure must name what the tab is fetching'
  );
  await sessions.releaseSession(sessionId);
});

test('a healthy router rewriting its own URL still reports its own 200, with no documentChanged noise', async () => {
  // The non-regression that matters most: the round before this one broke
  // exactly this case while trying to catch a client-side redirect.
  const { sessionId } = await sessions.createSession();
  const result = payload(await handlers.navigate({ sessionId, url: `${baseUrl}/router` }));
  assert.equal(result.status, 200);
  assert.equal(result.ok, true);
  assert.equal(result.documentChanged, undefined);
  assert.equal(result.pendingNavigation, undefined);
  assert.equal(result.title, 'Router');
  await sessions.releaseSession(sessionId);
});

test('a shell that redirects to about:blank still reports a null status rather than inheriting the 200', async () => {
  // Ordering evidence alone cannot see this hop: about:blank produces no
  // response event, so the shell's own 200 stays the last document recorded.
  const { sessionId } = await sessions.createSession();
  const result = payload(await handlers.navigate({ sessionId, url: `${baseUrl}/blankshell` }));
  assert.equal(result.status, null, 'about:blank has no HTTP response to inherit one');
  assert.equal(result.ok, null);
  await sessions.releaseSession(sessionId);
});

// ---------------------------------------------------------------------------
// Findings 9 and 11: the two things an abandoned navigation can be
// ---------------------------------------------------------------------------

test('navigating to a download is reported as a blocked navigation rather than thrown raw', async () => {
  const sessionId = await sessionOn('/healthy');
  const before = sessions.resolve(sessionId).page.url();
  const result = payload(await handlers.navigate({ sessionId, url: `${baseUrl}/download` }));
  assert.equal(result.blocked, true, 'the blocked path advertises downloads, so it has to recognise one');
  assert.equal((await liveDocument(sessionId)).url, before, 'the tab must not have moved');
  assert.ok(/download/i.test(String(result.pendingNavigation?.reason ?? '')));
  await sessions.releaseSession(sessionId);
});

test('navigating to a 204 is blocked, and is not described as a same-document navigation', async () => {
  const sessionId = await sessionOn('/healthy');
  const before = sessions.resolve(sessionId).page.url();
  const result = payload(await handlers.navigate({ sessionId, url: `${baseUrl}/nocontent` }));
  assert.equal(result.blocked, true);
  assert.equal((await liveDocument(sessionId)).url, before, 'a 204 leaves the tab exactly where it was');
  assert.equal(result.sameDocument, false, 'nothing navigated, so this is not a same-document navigation');
  assert.ok(
    !/Same-document navigation: the URL changed/.test(String(result.note ?? '')),
    `the URL did not change: ${result.note}`
  );
  await sessions.releaseSession(sessionId);
});

// ---------------------------------------------------------------------------
// Findings 7 and 12: the history steps
// ---------------------------------------------------------------------------

test('a popstate guard rewriting the entry with replaceState is disclosed loudly, and CDP confirms the rewrite', async () => {
  const sessionId = await sessionOn('/app/a');
  const target = sessions.resolve(sessionId);
  await target.page.evaluate(() => history.pushState({}, '', '/app/b'));
  await target.page.evaluate(() => {
    (window as unknown as { __mode: string }).__mode = 'rewrite';
  });

  const result = payload(await handlers.navigate_back({ sessionId }));

  const cdp = await target.session.context.newCDPSession(target.page);
  const chromiumHistory = (await cdp.send('Page.getNavigationHistory')) as { currentIndex: number; entries: { url: string }[] };
  await cdp.detach().catch(() => {});
  assert.ok(
    chromiumHistory.entries[chromiumHistory.currentIndex].url.endsWith('/app/login'),
    'the oracle for this test is Chromium\'s own history, which must show the entry rewritten'
  );

  assert.equal(result.navigated, true, 'the browser really did move, and the previous round broke the healthy twin by denying that');
  assert.ok(result.expectedUrl.endsWith('/app/a'), 'the address the step aimed at has to be in the payload');
  assert.ok(result.url.endsWith('/app/login'));
  assert.ok(
    /THE URL IS NOT THE ONE THIS STEP AIMED AT/.test(String(result.note ?? '')),
    `nothing told the caller to look: ${result.note}`
  );
  await sessions.releaseSession(sessionId);
});

test('an SPA tidying its own URL on arrival gets no such warning, which is the case a heuristic would break', async () => {
  const sessionId = await sessionOn('/tidy');
  const target = sessions.resolve(sessionId);
  await target.page.evaluate(() => history.pushState({}, '', '/second'));
  const result = payload(await handlers.navigate_back({ sessionId }));
  assert.equal(result.navigated, true);
  assert.ok(
    !/THE URL IS NOT THE ONE THIS STEP AIMED AT/.test(String(result.note ?? '')),
    `a healthy router must not be warned about: ${result.note}`
  );
  await sessions.releaseSession(sessionId);
});

test('a step that did not land does not claim a document load that never happened', async () => {
  const sessionId = await sessionOn('/app/a');
  const target = sessions.resolve(sessionId);
  await target.page.evaluate(() => history.pushState({}, '', '/app/b'));
  await target.page.evaluate(() => history.pushState({}, '', '/app/c'));
  await target.page.evaluate(() => {
    (window as unknown as { __mode: string }).__mode = 'overshoot';
  });

  const servedBefore = served.length;
  const result = payload(await handlers.navigate_back({ sessionId }));
  assert.equal(served.length, servedBefore, 'the fixture must confirm no document was fetched at all');

  assert.equal(result.navigated, false, 'two entries back is not one entry back');
  assert.ok(
    !/having loaded a whole new document/.test(String(result.note ?? '')),
    `nothing was loaded: ${result.note}`
  );
  await sessions.releaseSession(sessionId);
});

// ---------------------------------------------------------------------------
// A tab id this session never issued
// ---------------------------------------------------------------------------

test('a zero-padded pageId is rejected, the way every other malformed spelling already was', async () => {
  const sessionId = await sessionOn('/healthy');
  for (const pageId of ['00', '000000000', '007']) {
    await assert.rejects(
      () => handlers.read_console({ sessionId, pageId }),
      /has no tab with id/,
      `pageId ${JSON.stringify(pageId)} was accepted as an existing tab`
    );
  }
  // The canonical spelling still works, including for a tab that has closed.
  const ok = payload(await handlers.read_console({ sessionId, pageId: '0' }));
  assert.equal(typeof ok.total, 'number');
  await sessions.releaseSession(sessionId);
});
