import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';

import { BrowserManager } from '../src/daemon/browserManager.js';
import { createToolHandlers } from '../src/daemon/tools/handlers.js';
import { SessionStore } from '../src/daemon/sessions.js';
import { getFreePort } from './helpers.js';

/**
 * Round 2 navigation fixtures: a back-trapping SPA (a popstate handler that
 * re-pushes its own URL, exactly what a route guard or an unsaved-changes
 * interceptor does), an ordinary history page for a genuine same-document
 * step, a page with a selector matching several elements for hover's
 * strict-mode trap, and a couple of routes that answer with a real HTTP
 * failure status.
 */
const TRAP_HTML = `<!doctype html>
<html>
<body>
  <div id="marker">list</div>
<script>
  window.__trapped = 0;
  // The trap a route guard or an unsaved-changes interceptor sets: catch the
  // popstate a back/forward step fires and push straight back to where the
  // user was, so the browser genuinely moved and the app genuinely undid it.
  window.addEventListener('popstate', function () {
    window.__trapped++;
    history.pushState({ trap: true }, '', location.pathname + '#detail');
    document.getElementById('marker').textContent = 'detail';
  });
</script>
</body>
</html>`;

const HISTORY_HTML = `<!doctype html>
<html>
<body>
  <div id="marker">history</div>
<script>
  window.__popstates = 0;
  window.addEventListener('popstate', function () { window.__popstates++; });
</script>
</body>
</html>`;

/**
 * "div > button" matches two elements once Playwright pierces the open
 * shadow root: the light-DOM button, and the one inside the shadow root.
 * page.hover is not strict, so it hovers the first one, but reading it back
 * through locator.evaluate against the bare selector IS strict and used to
 * throw, which is exactly the trap hover's fix targets.
 */
const SHADOW_HTML = `<!doctype html>
<html><body>
  <div><button id="light-button" style="width:100px;height:40px">Light</button></div>
  <div id="host"></div>
<script>
  var root = document.getElementById('host').attachShadow({ mode: 'open' });
  root.innerHTML = '<div><button id="shadow-button" style="width:100px;height:40px">Shadow</button></div>';
</script>
</body></html>`;

/**
 * A press that navigates the page away before the drag gesture finishes:
 * a mousedown handler that sets location.href synchronously, the same
 * outcome a real page gets from dragging a plain link and dropping it
 * somewhere that does not handle the drop, which falls back to the
 * browser's own default of navigating to the link's href. The probe this
 * arms lives on THIS document, and it is gone by the time the drag
 * finishes.
 */
const NAV_TRAP_HTML = `<!doctype html>
<html>
<body style="margin:0">
  <div id="navTrap" style="width:120px;height:60px;background:rgb(200,0,0)">drag me away</div>
</body>
<script>
  document.getElementById('navTrap').addEventListener('mousedown', function () {
    location.href = '/elsewhere';
  });
</script>
</html>`;

const ELSEWHERE_HTML = `<!doctype html>
<html><body><h1 id="marker">elsewhere</h1></body></html>`;

const PAGES: Record<string, string> = {
  '/trap': TRAP_HTML,
  '/history': HISTORY_HTML,
  '/shadow': SHADOW_HTML,
  '/navtrap': NAV_TRAP_HTML,
  '/elsewhere': ELSEWHERE_HTML
};

let server: Server;
let baseUrl: string;
let browserManager: BrowserManager;
let sessions: SessionStore;
let handlers: ReturnType<typeof createToolHandlers>;

before(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]!.split('#')[0]!;
    // Keeps every back/forward step a real navigation rather than a
    // back/forward-cache restore, the same reason interaction-parity's own
    // history fixture sets it.
    res.setHeader('cache-control', 'no-store');
    if (path === '/missing') {
      res.statusCode = 404;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end('<!doctype html><html><body>not found</body></html>');
      return;
    }
    if (path === '/broken') {
      res.statusCode = 500;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      // What an SPA shell rendering its own error state under a failing
      // response looks like: the body gives no hint anything went wrong.
      res.end('<!doctype html><html><body><h1>Dashboard</h1></body></html>');
      return;
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(PAGES[path] ?? '<!doctype html><html><body>blank</body></html>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;

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
function payload(result: unknown): Record<string, unknown> {
  return (result as { structuredContent: Record<string, unknown> }).structuredContent;
}

async function sessionOn(path: string): Promise<string> {
  const { sessionId } = await sessions.createSession();
  await handlers.navigate({ sessionId, url: `${baseUrl}${path}`, settleMs: 0 });
  return sessionId;
}

async function evaluate<T>(sessionId: string, expression: string): Promise<T> {
  return payload(await handlers.evaluate({ sessionId, expression })).result as T;
}

// ---------------------------------------------------------------------------
// Defect 1: navigate_back / navigate_forward report movement honestly
// ---------------------------------------------------------------------------

test('navigate_back trapped by a popstate guard reports navigated: false, not a clean pass', async () => {
  const sessionId = await sessionOn('/trap');
  // A real second entry to step back FROM: push to #detail, the way a route
  // that opens a detail view would.
  await evaluate(sessionId, "history.pushState({}, '', location.pathname + '#detail')");
  const previousUrl = `${baseUrl}/trap#detail`;
  assert.equal(await evaluate(sessionId, 'location.href'), previousUrl);

  const body = payload(await handlers.navigate_back({ sessionId }));

  // The fixture really did trap the step: the browser moved back, the page
  // caught the popstate and pushed straight back to #detail.
  assert.equal(await evaluate(sessionId, 'window.__trapped'), 1, 'the trap must actually have fired for this test to mean anything');
  assert.equal(await evaluate(sessionId, 'location.href'), previousUrl, 'the trap really did leave the tab where it started');

  assert.equal(body.navigated, false, 'a step a route guard blocked must not read as a step that happened');
  assert.equal(body.url, previousUrl);
  assert.equal(body.previousUrl, previousUrl);
  assert.equal(body.sameDocument, false, 'nothing moved, so there is nothing to call same-document either');
  assert.equal(typeof body.note, 'string', 'a blocked step must be explained, not left for the caller to notice on their own');
  assert.match(String(body.note), /guard|trap|blocked/i, 'the note must say plainly that the step was blocked');

  await sessions.releaseSession(sessionId);
});

test('an ordinary navigate_back reports navigated: true with a freshly re-read history index', async () => {
  const sessionId = await sessionOn('/history');
  await handlers.navigate({ sessionId, url: `${baseUrl}/history#one`, settleMs: 0 });
  await handlers.navigate({ sessionId, url: `${baseUrl}/history#two`, settleMs: 0 });

  const popstatesBefore = await evaluate<number>(sessionId, 'window.__popstates');
  const body = payload(await handlers.navigate_back({ sessionId }));

  assert.equal(body.navigated, true);
  assert.equal(body.url, `${baseUrl}/history#one`);
  assert.equal(body.sameDocument, true, 'a hash step back does not reload');
  assert.equal(
    await evaluate<number>(sessionId, 'window.__popstates'),
    popstatesBefore + 1,
    'the page really did see the popstate this step fired'
  );

  assert.equal(typeof body.historyIndex, 'number');
  assert.equal(typeof body.historyLength, 'number');

  // historyIndex must be read fresh after the step, not derived by arithmetic
  // on the reading taken before it. Proven by walking forward again: a
  // genuinely fresh read tracks the browser's real position on both calls, so
  // stepping forward one entry must land exactly one index ahead of where the
  // back step reported, and back on the same URL and entry count.
  const forward = payload(await handlers.navigate_forward({ sessionId }));
  assert.equal(forward.url, `${baseUrl}/history#two`);
  assert.equal(forward.historyIndex, (body.historyIndex as number) + 1);
  assert.equal(forward.historyLength, body.historyLength);

  await sessions.releaseSession(sessionId);
});

test('navigate_back re-reads history rather than trusting the pre-step reading, when a trap changes the entry count', async () => {
  const sessionId = await sessionOn('/trap');
  await evaluate(sessionId, "history.pushState({}, '', location.pathname + '#detail')");

  const before = payload(await handlers.navigate_back({ sessionId }));
  assert.equal(before.navigated, false);

  // The trap's own pushState call added a real entry on top of the ones
  // already there. A caller trusting arithmetic on the pre-step reading would
  // never see that; a fresh read does.
  assert.equal(typeof before.historyLength, 'number');
  assert.ok((before.historyLength as number) >= 3, 'the trap\'s re-push is a real history entry, on top of / and the first #detail push');

  await sessions.releaseSession(sessionId);
});

// ---------------------------------------------------------------------------
// Defect 2: navigate reports the real HTTP outcome
// ---------------------------------------------------------------------------

test('navigate to a 404 reports the status instead of an ordinary success', async () => {
  const sessionId = await sessionOn('/history');

  const body = payload(await handlers.navigate({ sessionId, url: `${baseUrl}/missing`, settleMs: 0 }));

  assert.equal(body.status, 404);
  assert.equal(body.ok, false);
  assert.equal(body.sameDocument, false);

  await sessions.releaseSession(sessionId);
});

test('navigate to a 500 whose SPA shell renders its own error page still reports the status', async () => {
  const sessionId = await sessionOn('/history');

  const body = payload(await handlers.navigate({ sessionId, url: `${baseUrl}/broken`, settleMs: 0 }));

  assert.equal(body.status, 500);
  assert.equal(body.ok, false, 'the response is a real failure even though the body rendered a clean-looking page');
  assert.equal(body.title, '', 'the page gives nothing away either, which is why status has to');

  await sessions.releaseSession(sessionId);
});

test('navigate to a real 200 reports it as ok', async () => {
  const sessionId = await sessionOn('/history');
  const body = payload(await handlers.navigate({ sessionId, url: `${baseUrl}/history`, settleMs: 0 }));
  assert.equal(body.status, 200);
  assert.equal(body.ok, true);
  await sessions.releaseSession(sessionId);
});

test('navigate to about:blank says there is no HTTP response, rather than reporting a wrong status', async () => {
  const sessionId = await sessionOn('/history');

  const body = payload(await handlers.navigate({ sessionId, url: 'about:blank', settleMs: 0 }));

  assert.equal(body.status, null);
  assert.equal(body.ok, null);
  assert.equal(body.sameDocument, false, 'about:blank is a real document change, not a same-document navigation');
  assert.equal(typeof body.note, 'string', 'a null status must be explained, not left to be read as a silent failure');
  assert.match(String(body.note), /no HTTP response/i);

  await sessions.releaseSession(sessionId);
});

test('navigate to a hash-only URL says status is null because it is a same-document navigation, not a failure', async () => {
  const sessionId = await sessionOn('/history');

  const body = payload(await handlers.navigate({ sessionId, url: `${baseUrl}/history#settings`, settleMs: 0 }));

  assert.equal(body.sameDocument, true);
  assert.equal(body.status, null);
  assert.equal(body.ok, null);
  assert.equal(typeof body.note, 'string');
  assert.match(String(body.note), /same-document/i);

  await sessions.releaseSession(sessionId);
});

// ---------------------------------------------------------------------------
// Defect 3: hover on an ambiguous selector reports honestly
// ---------------------------------------------------------------------------

test('hover on a selector matching several elements reports hovering: true plus the match count, not a false negative', async () => {
  const sessionId = await sessionOn('/shadow');

  const body = payload(await handlers.hover({ sessionId, selector: 'div > button' }));

  assert.equal(body.matchedElements, 2, 'hover must report the match count, since it acts on the first of several without complaint');
  assert.equal(body.hovering, true, 'the hover genuinely landed on the first match; this must not collapse into false');
  assert.equal(typeof body.note, 'string');
  assert.match(String(body.note), /matched 2 elements/i);
  assert.match(String(body.note), /FIRST/, 'the note must say which element was actually acted on');

  await sessions.releaseSession(sessionId);
});

test('hover on a unique selector reports hovering: true with no match-count note', async () => {
  const sessionId = await sessionOn('/shadow');

  const body = payload(await handlers.hover({ sessionId, selector: '#light-button' }));

  assert.equal(body.matchedElements, 1);
  assert.equal(body.hovering, true);
  assert.ok(!('note' in body), 'a unique match needs no note at all');

  await sessions.releaseSession(sessionId);
});

// ---------------------------------------------------------------------------
// Defect 4: drag's nativeDrag probe when the gesture navigates the page away
// ---------------------------------------------------------------------------

test('drag whose gesture navigates the page away reports nativeDrag: null, not a false negative', async () => {
  const sessionId = await sessionOn('/navtrap');

  const body = payload(await handlers.drag({ sessionId, source: { selector: '#navTrap' }, target: { x: 400, y: 300 } }));

  // The trap really did fire: the tab genuinely left the document the probe
  // was armed on.
  assert.equal(
    await evaluate<string | null>(sessionId, "document.getElementById('marker') ? document.getElementById('marker').textContent : null"),
    'elsewhere'
  );

  assert.equal(body.nativeDrag, null, 'a probe read on a document that is not the one it was armed on must not collapse into false');
  assert.equal(typeof body.note, 'string', 'null must be explained, not left for the caller to misread as a confirmed negative');
  assert.match(String(body.note), /could not be determined/i);
  assert.match(String(body.note), /navigated the page away/i);

  await sessions.releaseSession(sessionId);
});

test('an ordinary drag on a page that never navigates still reports nativeDrag: false, not null', async () => {
  const sessionId = await sessionOn('/history');
  await handlers.evaluate({
    sessionId,
    expression: "document.body.innerHTML = '<div id=\"a\" style=\"width:80px;height:80px;background:blue\"></div><div id=\"b\" style=\"width:80px;height:80px;background:red;margin-top:200px\"></div>'"
  });

  const body = payload(await handlers.drag({ sessionId, source: { selector: '#a' }, target: { selector: '#b' } }));

  assert.equal(body.nativeDrag, false, 'the document never changed, so the probe must give a real answer, not null');
  assert.ok(!('note' in body) || !String(body.note ?? '').match(/could not be determined/i), 'a page that never navigated must not carry the "could not be determined" note');

  await sessions.releaseSession(sessionId);
});
