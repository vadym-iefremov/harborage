import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';

import { BrowserManager } from '../src/daemon/browserManager.js';
import { createToolHandlers, type ToolHandlers } from '../src/daemon/tools/handlers.js';
import { SessionStore } from '../src/daemon/sessions.js';
import { getFreePort } from './helpers.js';

/**
 * Round-3 fixtures. Every test in this file is graded against a ground-truth
 * oracle rather than against the tool's own summary of what it did, because
 * round 2's fixes each passed a test that only checked the tool said the
 * right words and still certified the exact failure they were built to
 * prevent on a real page.
 *
 * For find, the oracle is a real click: the selector find hands back is fed
 * straight to the click tool, and a click listener in every document records
 * which element actually received it. Each frame's document therefore holds a
 * DECOY at the same generated CSS path as the element find was asked for, so
 * a selector certified in the wrong document presses something unmistakable
 * ("Delete account", "Wipe database") rather than quietly working by luck.
 *
 * For navigate, the oracle is the live document plus the test server's own
 * log of what status it served for which path, neither of which comes from
 * the tool.
 *
 * For navigate_back, the oracle is Chromium's own navigation history read
 * through raw CDP (send_cdp_command), plus the live document's location.
 */

/**
 * Records every click, in every document, on window.top so one evaluate can
 * read the lot. Every page below is served from the same origin, so the
 * cross-document write is allowed.
 */
const CLICK_RECORDER = `
  document.addEventListener('click', function (e) {
    var t = e.target;
    var id = t.id || (t.textContent || '').trim();
    try {
      var top = window.top;
      if (!top.__clicks) top.__clicks = [];
      top.__clicks.push(id);
    } catch (err) {}
  });
`;

/**
 * Main document. Its ONLY <button> is the decoy, so the positional path find
 * builds for the single button inside /inner ("html > body > button") matches
 * "Delete account" here, and a selector certified in the frame but run in the
 * main document presses it.
 */
const OUTER_HTML = `<!doctype html>
<html><head><title>Outer</title></head><body>
  <button>Delete account</button>
  <iframe id="f0" src="/inner" style="width:300px;height:120px"></iframe>
  <iframe id="f1" src="/mid" style="width:300px;height:160px"></iframe>
<script>
  window.__clicks = [];
  ${CLICK_RECORDER}
</script>
</body></html>`;

/** One frame down. Its single button is the thing a caller actually wants. */
const INNER_HTML = `<!doctype html>
<html><head><title>Inner</title></head><body>
  <button>Confirm payment</button>
<script>${CLICK_RECORDER}</script>
</body></html>`;

/**
 * One frame down, and itself the parent of another frame. Its own single
 * button is the decoy for the depth-mismatch case: a prefix that reaches only
 * this far, pasted in front of a path certified one frame deeper, lands here.
 */
const MID_HTML = `<!doctype html>
<html><head><title>Mid</title></head><body>
  <button>Wipe database</button>
  <iframe id="f2" src="/deep" style="width:280px;height:100px"></iframe>
<script>${CLICK_RECORDER}</script>
</body></html>`;

/** Two frames down. */
const DEEP_HTML = `<!doctype html>
<html><head><title>Deep</title></head><body>
  <button>Approve refund</button>
<script>${CLICK_RECORDER}</script>
</body></html>`;

/** A 200 shell that throws the tab at a 500 the moment it runs. */
const SHELL_HTML = `<!doctype html>
<html><head><title>Loading dashboard</title></head><body>
<script>location.replace('/broken');</script>
</body></html>`;

/** A 200 shell that throws the tab somewhere with no HTTP response of its own. */
const BLANK_SHELL_HTML = `<!doctype html>
<html><head><title>Loading</title></head><body>
<script>location.replace('about:blank');</script>
</body></html>`;

/** Three documents, one navigate call, via meta refresh. */
const META1_HTML = `<!doctype html>
<html><head><title>Meta one</title><meta http-equiv="refresh" content="0; url=/meta2"></head>
<body>meta one</body></html>`;
const META2_HTML = `<!doctype html>
<html><head><title>Meta two</title><meta http-equiv="refresh" content="0; url=/meta3"></head>
<body>meta two</body></html>`;
const META3_HTML = `<!doctype html>
<html><head><title>Meta three</title></head><body>meta three</body></html>`;

/**
 * A route that behaves on its first load and starts bouncing on every load
 * after it. Reloading is the only way to reach the redirecting version, which
 * is what makes it a reload fixture rather than a navigate one, and it is the
 * ordinary shape of a session that expired between the first visit and the
 * refresh: the shell still answers 200, and it throws you at an error page.
 */
const FLAKY_FIRST_HTML = `<!doctype html>
<html><head><title>Flaky ok</title></head><body>first load is fine</body></html>`;
const FLAKY_SHELL_HTML = `<!doctype html>
<html><head><title>Loading dashboard</title></head><body>
<script>location.replace('/broken');</script>
</body></html>`;

/** The same shape, but bouncing somewhere with no HTTP response of its own. */
const FLAKY_BLANK_SHELL_HTML = `<!doctype html>
<html><head><title>Loading</title></head><body>
<script>location.replace('about:blank');</script>
</body></html>`;

/**
 * A forward-trapping SPA: the mirror of the back guard below. Its popstate
 * handler is armed by the test right before the forward step, and traverses
 * two entries BACK, so a forward step leaves the tab one entry LOWER than it
 * started and on a URL it was never on. The URL really changes, and that is
 * what used to make it read as a clean forward step.
 */
const FORWARD_GUARD_BACKWARD_HTML = `<!doctype html>
<html><head><title>Forward guarded</title></head><body>
<script>
  window.__guard = false;
  window.__bounced = 0;
  window.addEventListener('popstate', function () {
    if (!window.__guard) return;
    window.__guard = false;
    window.__bounced++;
    history.go(-2);
  });
</script>
</body></html>`;

/**
 * A back-trapping SPA that does not merely block the step: its popstate
 * handler pushes TWICE, so a back step leaves the tab one entry FURTHER
 * FORWARD than it started, on a URL it was never on before. This is what a
 * client-side auth bounce looks like from the outside, and it is the shape
 * that read as a clean back step.
 */
const FORWARD_GUARD_HTML = `<!doctype html>
<html><head><title>Guarded</title></head><body>
  <div id="marker">guarded</div>
<script>
  window.__popstates = 0;
  window.addEventListener('popstate', function () {
    window.__popstates++;
    if (window.__popstates > 1) return;
    history.pushState({ bounce: 1 }, '', location.pathname + '#bounced');
    history.pushState({ bounce: 2 }, '', location.pathname + '#login');
  });
</script>
</body></html>`;

/** The round-2 trap shape, kept here so this file proves it still fails correctly. */
const SAME_URL_TRAP_HTML = `<!doctype html>
<html><head><title>Trap</title></head><body>
  <div id="marker">list</div>
<script>
  window.__trapped = 0;
  window.addEventListener('popstate', function () {
    window.__trapped++;
    history.pushState({ trap: true }, '', location.pathname + '#detail');
  });
</script>
</body></html>`;

/** An ordinary history page, so a genuine back step has something to prove against. */
const PLAIN_HTML = `<!doctype html>
<html><head><title>Plain</title></head><body><div id="marker">plain</div></body></html>`;

const PAGES: Record<string, { html: string; status?: number }> = {
  '/outer': { html: OUTER_HTML },
  '/inner': { html: INNER_HTML },
  '/mid': { html: MID_HTML },
  '/deep': { html: DEEP_HTML },
  '/shell': { html: SHELL_HTML },
  '/blankshell': { html: BLANK_SHELL_HTML },
  '/broken': { html: '<!doctype html><html><head><title>Server error</title></head><body>500</body></html>', status: 500 },
  '/missing': { html: '<!doctype html><html><head><title>Not found</title></head><body>404</body></html>', status: 404 },
  '/meta1': { html: META1_HTML },
  '/meta2': { html: META2_HTML },
  '/meta3': { html: META3_HTML },
  '/guarded': { html: FORWARD_GUARD_HTML },
  '/trap': { html: SAME_URL_TRAP_HTML },
  '/plain': { html: PLAIN_HTML },
  '/fwdguard': { html: FORWARD_GUARD_BACKWARD_HTML }
};

/** How many times each stateful route has been asked for, so a reload can differ from the first visit. */
const loadCounts: Record<string, number> = {};

/** The server's own log: the independent oracle for what status each document really carried. */
const served: { path: string; status: number }[] = [];

let server: Server;
let baseUrl: string;
let browserManager: BrowserManager;
let sessions: SessionStore;
let handlers: ToolHandlers;

before(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]!.split('#')[0]!;
    // The stateful reload routes: fine on the first load, bouncing on every
    // load after it.
    if (path === '/flaky' || path === '/flakyblank') {
      const count = (loadCounts[path] = (loadCounts[path] ?? 0) + 1);
      served.push({ path, status: 200 });
      res.statusCode = 200;
      res.setHeader('cache-control', 'no-store');
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(count === 1 ? FLAKY_FIRST_HTML : path === '/flaky' ? FLAKY_SHELL_HTML : FLAKY_BLANK_SHELL_HTML);
      return;
    }
    // A genuine server-side redirect, which navigate must keep reporting as
    // one ordinary document rather than as a page that moved itself.
    if (path === '/moved') {
      served.push({ path, status: 302 });
      res.statusCode = 302;
      res.setHeader('location', '/outer');
      res.end();
      return;
    }
    const page = PAGES[path];
    const status = page?.status ?? 200;
    served.push({ path, status });
    res.statusCode = status;
    // Keeps every back/forward step a real navigation rather than a
    // back/forward-cache restore.
    res.setHeader('cache-control', 'no-store');
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(page?.html ?? '<!doctype html><html><head><title>Blank</title></head><body>blank</body></html>');
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

function payload(result: unknown): Record<string, any> {
  return (result as { structuredContent: Record<string, any> }).structuredContent;
}

async function sessionOn(path: string): Promise<string> {
  const { sessionId } = await sessions.createSession();
  await handlers.navigate({ sessionId, url: `${baseUrl}${path}` });
  return sessionId;
}

async function evaluate<T>(sessionId: string, expression: string): Promise<T> {
  return payload(await handlers.evaluate({ sessionId, expression })).result as T;
}

/** Chromium's own back/forward list, read through raw CDP rather than through the tool under test. */
async function realHistory(sessionId: string): Promise<{ index: number; length: number; urls: string[] }> {
  const body = payload(await handlers.send_cdp_command({ sessionId, method: 'Page.getNavigationHistory' }));
  const result = body.result as { currentIndex: number; entries: { url: string }[] };
  return {
    index: result.currentIndex,
    length: result.entries.length,
    urls: result.entries.map(entry => entry.url)
  };
}

/**
 * The find oracle: click whatever selector find handed back and report which
 * element really received the click, straight from the page's own listeners.
 */
async function clickAndRecord(sessionId: string, selector: string): Promise<string[]> {
  await evaluate(sessionId, 'window.__clicks = []');
  await handlers.click({ sessionId, selector });
  return evaluate<string[]>(sessionId, 'window.__clicks');
}

// ---------------------------------------------------------------------------
// Finding 1: find must never certify a selector it verified in one document
// and the caller will run in another.
// ---------------------------------------------------------------------------

test('find given a frame prefix inside the selector returns a selector that clicks the element in the frame, not the decoy in the main document', async () => {
  const sessionId = await sessionOn('/outer');

  // The prefix arrives inside the selector, which is exactly what
  // list_frames tells agents to do with its selectorPrefix. The frame
  // ARGUMENT is deliberately not set.
  const found = payload(
    await handlers.find({ sessionId, selector: '#f0 >> internal:control=enter-frame >> button' })
  );
  assert.equal(found.matched, 1, `expected the one button inside /inner, got ${JSON.stringify(found)}`);
  const element = found.elements[0];
  assert.equal(element.text, 'Confirm payment', 'the fixture must really be describing the in-frame button');

  // The fixture must be a genuine trap: the bare path find used to hand back
  // matches the decoy in the main document.
  const decoyHits = await evaluate<number>(sessionId, "document.querySelectorAll('html > body > button').length");
  assert.equal(decoyHits, 1, 'the main document must hold exactly one decoy at the bare path, or this test proves nothing');
  const decoyText = await evaluate<string>(sessionId, "document.querySelector('html > body > button').textContent");
  assert.equal(decoyText, 'Delete account');

  assert.notEqual(element.selector, null, 'a same-origin iframe reachable by selector must still get a usable selector');
  assert.equal(element.resolvesToTarget, true);

  // The oracle: run the selector through the real click tool and ask the page
  // which element got pressed.
  const clicks = await clickAndRecord(sessionId, element.selector);
  assert.deepEqual(
    clicks,
    ['Confirm payment'],
    `find's selector must click the element it described. It clicked ${JSON.stringify(clicks)} instead`
  );

  await sessions.releaseSession(sessionId);
});

test('find given a frame argument plus a selector that goes one frame deeper returns a selector that clicks the deep element, not the decoy in the shallower frame', async () => {
  const sessionId = await sessionOn('/outer');

  const frames = payload(await handlers.list_frames({ sessionId }));
  const mid = frames.frames.find((f: any) => f.url.endsWith('/mid'));
  assert.ok(mid, `expected the /mid frame, got ${JSON.stringify(frames.frames)}`);

  // frame reaches /mid; the selector then steps into /deep. The prefix the
  // old guard trusted stops one frame short of where the element lives.
  const found = payload(
    await handlers.find({
      sessionId,
      frame: mid.frameId,
      selector: '#f2 >> internal:control=enter-frame >> button'
    })
  );
  assert.equal(found.matched, 1, `expected the one button inside /deep, got ${JSON.stringify(found)}`);
  const element = found.elements[0];
  assert.equal(element.text, 'Approve refund');
  assert.notEqual(element.selector, null);
  assert.equal(element.resolvesToTarget, true);

  const clicks = await clickAndRecord(sessionId, element.selector);
  assert.deepEqual(
    clicks,
    ['Approve refund'],
    `find's selector must click the element it described. It clicked ${JSON.stringify(clicks)} instead`
  );

  await sessions.releaseSession(sessionId);
});

test('find with the frame argument alone still returns a working, prefixed selector', async () => {
  const sessionId = await sessionOn('/outer');
  const frames = payload(await handlers.list_frames({ sessionId }));
  const inner = frames.frames.find((f: any) => f.url.endsWith('/inner'));
  assert.ok(inner);

  const found = payload(await handlers.find({ sessionId, frame: inner.frameId, text: 'Confirm payment' }));
  assert.equal(found.matched, 1);
  const element = found.elements[0];
  assert.notEqual(element.selector, null);
  assert.equal(element.resolvesToTarget, true);

  const clicks = await clickAndRecord(sessionId, element.selector);
  assert.deepEqual(clicks, ['Confirm payment'], `expected the in-frame button, got ${JSON.stringify(clicks)}`);

  await sessions.releaseSession(sessionId);
});

test('find in the main document still returns a working selector, and it clicks the main-document element', async () => {
  const sessionId = await sessionOn('/outer');
  const found = payload(await handlers.find({ sessionId, text: 'Delete account' }));
  assert.equal(found.matched, 1);
  const element = found.elements[0];
  assert.notEqual(element.selector, null);
  assert.equal(element.resolvesToTarget, true);
  assert.equal(found.frameSelectorUnavailable, undefined);

  const clicks = await clickAndRecord(sessionId, element.selector);
  assert.deepEqual(clicks, ['Delete account'], `expected the main-document button, got ${JSON.stringify(clicks)}`);

  await sessions.releaseSession(sessionId);
});

test('find reports which frame a selector actually resolved in, so a caller can tell it crossed a boundary', async () => {
  const sessionId = await sessionOn('/outer');
  const found = payload(
    await handlers.find({ sessionId, selector: '#f0 >> internal:control=enter-frame >> button' })
  );
  assert.equal(found.resolvedFrame, 'main/0', `expected the frame id find really resolved in, got ${JSON.stringify(found)}`);

  const main = payload(await handlers.find({ sessionId, text: 'Delete account' }));
  assert.equal(main.resolvedFrame, 'main');

  await sessions.releaseSession(sessionId);
});

// ---------------------------------------------------------------------------
// Finding 8: navigate's status must describe the document navigate describes.
// ---------------------------------------------------------------------------

test('navigate through a 200 shell that redirects to a 500 reports the 500, not a 200 next to the error page title', async () => {
  const sessionId = await sessionOn('/plain');
  const body = payload(await handlers.navigate({ sessionId, url: `${baseUrl}/shell` }));

  // Oracle 1: the live document. Read from the page, not from the payload.
  const liveUrl = await evaluate<string>(sessionId, 'location.href');
  const liveTitle = await evaluate<string>(sessionId, 'document.title');
  assert.equal(liveUrl, `${baseUrl}/broken`, 'the fixture must really have redirected');
  assert.equal(liveTitle, 'Server error');

  // Oracle 2: what the server actually served for that path.
  const brokenStatus = served.filter(entry => entry.path === '/broken').at(-1)?.status;
  assert.equal(brokenStatus, 500, 'the server must really have answered 500 for the document now on screen');

  assert.equal(body.url, liveUrl, 'the payload must describe the document that is actually there');
  assert.equal(body.title, liveTitle);
  assert.equal(
    body.status,
    500,
    `status must describe the document url and title describe. Got ${JSON.stringify({ status: body.status, url: body.url, title: body.title })}`
  );
  assert.equal(body.ok, false, 'ok: true beside a 500 error page is the exact wrong conclusion this fix exists to prevent');
  assert.ok(body.documentChanged, 'the payload must say plainly that the page moved itself after the response was measured');
  assert.equal(body.documentChanged.from.url, `${baseUrl}/shell`);
  assert.equal(body.documentChanged.from.status, 200);
  assert.equal(typeof body.note, 'string');
  assert.match(String(body.note), /redirect|moved|changed/i);

  await sessions.releaseSession(sessionId);
});

test('navigate through a meta-refresh chain of three documents says so rather than mixing them silently', async () => {
  const sessionId = await sessionOn('/plain');
  const body = payload(await handlers.navigate({ sessionId, url: `${baseUrl}/meta1` }));

  const liveUrl = await evaluate<string>(sessionId, 'location.href');
  const liveTitle = await evaluate<string>(sessionId, 'document.title');
  assert.equal(liveUrl, `${baseUrl}/meta3`, 'the fixture must really have walked all three documents');
  assert.equal(liveTitle, 'Meta three');

  assert.equal(body.url, liveUrl);
  assert.equal(body.title, liveTitle);
  assert.equal(body.status, 200);
  assert.equal(body.ok, true);
  assert.ok(body.documentChanged, 'three documents in one call must not come back with no note at all');
  assert.equal(body.documentChanged.from.url, `${baseUrl}/meta1`);
  assert.ok(
    Array.isArray(body.documentChanged.documents) && body.documentChanged.documents.length >= 3,
    `the chain itself must be reported, got ${JSON.stringify(body.documentChanged)}`
  );
  assert.equal(typeof body.note, 'string');

  await sessions.releaseSession(sessionId);
});

test('navigate to a plain 200 still reports a clean success with no documentChanged noise', async () => {
  const sessionId = await sessionOn('/plain');
  const body = payload(await handlers.navigate({ sessionId, url: `${baseUrl}/outer` }));
  assert.equal(body.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.url, `${baseUrl}/outer`);
  assert.equal(body.documentChanged, undefined, 'a navigation that stayed put must not claim the document changed');
  assert.equal(body.sameDocument, false);

  await sessions.releaseSession(sessionId);
});

test('navigate to a real 404 still reports the 404 (no regression on the round-2 fix)', async () => {
  const sessionId = await sessionOn('/plain');
  const body = payload(await handlers.navigate({ sessionId, url: `${baseUrl}/missing` }));
  assert.equal(body.status, 404);
  assert.equal(body.ok, false);
  assert.equal(body.documentChanged, undefined);

  await sessions.releaseSession(sessionId);
});

test('navigate to a hash-only URL is still a same-document navigation with a null status', async () => {
  const sessionId = await sessionOn('/plain');
  const body = payload(await handlers.navigate({ sessionId, url: `${baseUrl}/plain#section` }));
  assert.equal(body.sameDocument, true);
  assert.equal(body.status, null);
  assert.equal(body.ok, null);
  assert.equal(body.documentChanged, undefined);

  await sessions.releaseSession(sessionId);
});

test('navigate to about:blank still explains its null status rather than claiming a document change', async () => {
  const sessionId = await sessionOn('/plain');
  const body = payload(await handlers.navigate({ sessionId, url: 'about:blank' }));
  assert.equal(body.status, null);
  assert.equal(body.ok, null);
  assert.equal(body.sameDocument, false);
  assert.equal(body.documentChanged, undefined);
  assert.match(String(body.note), /no HTTP response/i);

  await sessions.releaseSession(sessionId);
});

test('navigate through a server-side 302 still reports one document, not a client-side change', async () => {
  const sessionId = await sessionOn('/plain');
  const body = payload(await handlers.navigate({ sessionId, url: `${baseUrl}/moved` }));

  const liveUrl = await evaluate<string>(sessionId, 'location.href');
  assert.equal(liveUrl, `${baseUrl}/outer`, 'the fixture must really have redirected server-side');
  assert.equal(
    served.filter(entry => entry.path === '/moved').at(-1)?.status,
    302,
    'the server must really have answered 302'
  );

  assert.equal(body.url, liveUrl);
  assert.equal(body.status, 200, 'a 302 chain reports the status of the document it lands on, as it always did');
  assert.equal(body.ok, true);
  assert.equal(
    body.documentChanged,
    undefined,
    'the browser followed the redirect as part of the same navigation, so nothing moved itself afterwards'
  );

  await sessions.releaseSession(sessionId);
});

test('navigate through a shell that redirects to about:blank reports a null status rather than the shell\'s 200', async () => {
  const sessionId = await sessionOn('/plain');
  const body = payload(await handlers.navigate({ sessionId, url: `${baseUrl}/blankshell` }));

  const liveUrl = await evaluate<string>(sessionId, 'location.href');
  assert.equal(liveUrl, 'about:blank', 'the fixture must really have landed on about:blank');

  assert.equal(body.url, 'about:blank');
  assert.equal(body.status, null, 'about:blank has no HTTP response, so it must not inherit the shell\'s 200');
  assert.equal(body.ok, null);
  assert.ok(body.documentChanged, 'the page moved itself, and that must be stated');
  assert.equal(body.documentChanged.from.status, 200);
  assert.equal(body.documentChanged.to.status, null);

  await sessions.releaseSession(sessionId);
});

// ---------------------------------------------------------------------------
// Finding 8, ported: reload had the identical defect and the identical fix.
// ---------------------------------------------------------------------------

test('reload of a shell that has started redirecting to a 500 reports the 500, not the shell\'s 200', async () => {
  const sessionId = await sessionOn('/flaky');
  // First load is the well-behaved version, so the tab is genuinely sitting
  // on the shell when the reload happens. That is what makes this a reload
  // case: navigate could never land here.
  assert.equal(await evaluate<string>(sessionId, 'document.title'), 'Flaky ok');

  const body = payload(await handlers.reload({ sessionId }));

  // Oracle 1: the live document, read from the page.
  const liveUrl = await evaluate<string>(sessionId, 'location.href');
  const liveTitle = await evaluate<string>(sessionId, 'document.title');
  assert.equal(liveUrl, `${baseUrl}/broken`, 'the reload must really have bounced');
  assert.equal(liveTitle, 'Server error');

  // Oracle 2: what the server actually served for that path.
  assert.equal(
    served.filter(entry => entry.path === '/broken').at(-1)?.status,
    500,
    'the server must really have answered 500 for the document now on screen'
  );

  assert.equal(body.url, liveUrl, 'the payload must describe the document that is actually there');
  assert.equal(body.title, liveTitle);
  assert.equal(
    body.status,
    500,
    `status must describe the document url and title describe. Got ${JSON.stringify({ status: body.status, url: body.url, title: body.title })}`
  );
  assert.equal(body.ok, false, 'ok: true beside a 500 error page is the exact wrong conclusion this fix exists to prevent');
  assert.ok(body.documentChanged, 'the payload must say plainly that the page moved itself after the response was measured');
  assert.equal(body.documentChanged.from.url, `${baseUrl}/flaky`);
  assert.equal(body.documentChanged.from.status, 200);
  assert.equal(body.documentChanged.to.url, `${baseUrl}/broken`);
  assert.equal(typeof body.note, 'string');
  assert.match(String(body.note), /reload/i, 'the note must be worded for the tool the caller actually called');

  await sessions.releaseSession(sessionId);
});

test('reload that lands on about:blank reports a null status rather than the shell\'s 200', async () => {
  const sessionId = await sessionOn('/flakyblank');
  assert.equal(await evaluate<string>(sessionId, 'document.title'), 'Flaky ok');

  const body = payload(await handlers.reload({ sessionId }));

  const liveUrl = await evaluate<string>(sessionId, 'location.href');
  assert.equal(liveUrl, 'about:blank', 'the reload must really have landed on about:blank');

  assert.equal(body.url, 'about:blank');
  assert.equal(body.status, null, 'about:blank has no HTTP response, so it must not inherit the shell\'s 200');
  assert.equal(body.ok, null);
  assert.ok(body.documentChanged, 'the page moved itself, and that must be stated');
  assert.equal(body.documentChanged.from.status, 200);
  assert.equal(body.documentChanged.to.status, null);

  await sessions.releaseSession(sessionId);
});

test('an ordinary reload still reports a clean 200 with no documentChanged noise', async () => {
  const sessionId = await sessionOn('/plain');
  const body = payload(await handlers.reload({ sessionId }));
  assert.equal(body.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.url, `${baseUrl}/plain`);
  assert.equal(body.title, 'Plain');
  assert.equal(body.documentChanged, undefined, 'a reload that stayed put must not claim the document changed');
  assert.equal(body.note, undefined);

  await sessions.releaseSession(sessionId);
});

test('reload of a real 500 still reports the 500 (no regression on the status reporting reload already had)', async () => {
  const sessionId = await sessionOn('/broken');
  const body = payload(await handlers.reload({ sessionId }));
  assert.equal(
    served.filter(entry => entry.path === '/broken').at(-1)?.status,
    500,
    'the server must really have answered 500'
  );
  assert.equal(body.status, 500);
  assert.equal(body.ok, false);
  assert.equal(body.documentChanged, undefined, 'the server answered 500 directly, so nothing moved itself');

  await sessions.releaseSession(sessionId);
});

// ---------------------------------------------------------------------------
// Finding 9: a back step that moves the tab forward is not a back step.
// ---------------------------------------------------------------------------

test('navigate_back bounced forward by a popstate guard reports navigated: false', async () => {
  const sessionId = await sessionOn('/guarded');
  await evaluate(sessionId, "history.pushState({}, '', location.pathname + '#a')");
  await evaluate(sessionId, "history.pushState({}, '', location.pathname + '#b')");

  const before = await realHistory(sessionId);
  const previousUrl = await evaluate<string>(sessionId, 'location.href');
  assert.equal(previousUrl, `${baseUrl}/guarded#b`);

  const body = payload(await handlers.navigate_back({ sessionId }));

  // Oracle: Chromium's own history index, read through raw CDP, and the live
  // document's location. Neither comes from the tool under test.
  const afterHistory = await realHistory(sessionId);
  const liveUrl = await evaluate<string>(sessionId, 'location.href');
  assert.ok(
    afterHistory.index > before.index,
    `the fixture must really bounce the tab forward: index went ${before.index} to ${afterHistory.index}`
  );
  assert.equal(liveUrl, `${baseUrl}/guarded#login`, 'the guard really did land the tab somewhere new');

  assert.equal(
    body.navigated,
    false,
    'a back step that moved the tab FORWARD in Chromium\'s own history is not a successful back step'
  );
  assert.equal(body.url, liveUrl, 'the payload must still say where the tab really ended up');
  assert.equal(body.historyIndex, afterHistory.index, 'historyIndex must match the browser\'s own reading');
  assert.equal(typeof body.note, 'string');
  assert.match(String(body.note), /forward|guard|intercept|blocked/i);

  await sessions.releaseSession(sessionId);
});

test('navigate_back trapped into re-pushing the same URL still reports navigated: false', async () => {
  const sessionId = await sessionOn('/trap');
  await evaluate(sessionId, "history.pushState({}, '', location.pathname + '#detail')");
  const previousUrl = `${baseUrl}/trap#detail`;

  const body = payload(await handlers.navigate_back({ sessionId }));
  assert.equal(await evaluate<number>(sessionId, 'window.__trapped'), 1, 'the trap must actually have fired');
  assert.equal(await evaluate<string>(sessionId, 'location.href'), previousUrl);
  assert.equal(body.navigated, false, 'the round-2 same-URL trap must keep being caught');

  await sessions.releaseSession(sessionId);
});

test('an ordinary navigate_back and navigate_forward still report navigated: true, and match the browser\'s own index', async () => {
  const sessionId = await sessionOn('/plain');
  await handlers.navigate({ sessionId, url: `${baseUrl}/plain#one` });
  await handlers.navigate({ sessionId, url: `${baseUrl}/plain#two` });

  const before = await realHistory(sessionId);
  const back = payload(await handlers.navigate_back({ sessionId }));
  const afterBack = await realHistory(sessionId);

  assert.equal(afterBack.index, before.index - 1, 'the fixture must really step the browser back one entry');
  assert.equal(back.navigated, true);
  assert.equal(back.url, `${baseUrl}/plain#one`);
  assert.equal(back.sameDocument, true);
  assert.equal(back.historyIndex, afterBack.index);

  const forward = payload(await handlers.navigate_forward({ sessionId }));
  const afterForward = await realHistory(sessionId);
  assert.equal(afterForward.index, afterBack.index + 1, 'the fixture must really step the browser forward one entry');
  assert.equal(forward.navigated, true);
  assert.equal(forward.url, `${baseUrl}/plain#two`);
  assert.equal(forward.historyIndex, afterForward.index);

  await sessions.releaseSession(sessionId);
});

test('navigate_back with nothing behind it still reports navigated: false with a note', async () => {
  const sessionId = await sessionOn('/plain');
  // Two entries exist at this point (the session's blank start page and
  // /plain), so walk back until Chromium says there is nothing behind.
  await handlers.navigate_back({ sessionId });
  const body = payload(await handlers.navigate_back({ sessionId }));
  const history = await realHistory(sessionId);
  assert.equal(history.index, 0, 'the fixture must really have run out of back entries');
  assert.equal(body.navigated, false);
  assert.equal(typeof body.note, 'string');

  await sessions.releaseSession(sessionId);
});

test('navigate_forward bounced backward by a popstate guard reports navigated: false', async () => {
  const sessionId = await sessionOn('/fwdguard');
  for (const hash of ['#a', '#b', '#c']) {
    await evaluate(sessionId, `history.pushState({}, '', '${hash}')`);
  }
  // A clean back step first, so there is a real forward entry to step to.
  const back = payload(await handlers.navigate_back({ sessionId }));
  assert.equal(back.navigated, true, 'the setup back step must itself be clean, or this test proves nothing');
  assert.equal(back.url, `${baseUrl}/fwdguard#b`);

  // Arm the guard for the forward step only.
  await evaluate(sessionId, 'window.__guard = true');
  const before = await realHistory(sessionId);
  const previousUrl = await evaluate<string>(sessionId, 'location.href');

  const body = payload(await handlers.navigate_forward({ sessionId }));

  // Oracle: Chromium's own history index through raw CDP, plus the live
  // document. Neither comes from the tool under test.
  const afterHistory = await realHistory(sessionId);
  const liveUrl = await evaluate<string>(sessionId, 'location.href');
  assert.equal(await evaluate<number>(sessionId, 'window.__bounced'), 1, 'the guard must actually have fired');
  assert.ok(
    afterHistory.index < before.index,
    `the fixture must really bounce the tab backward: index went ${before.index} to ${afterHistory.index}`
  );
  assert.notEqual(liveUrl, previousUrl, 'the URL really did change, which is what used to make this read as a clean step');
  assert.equal(liveUrl, `${baseUrl}/fwdguard#a`);

  assert.equal(
    body.navigated,
    false,
    'a forward step that moved the tab BACKWARD in Chromium\'s own history is not a successful forward step'
  );
  assert.equal(body.url, liveUrl, 'the payload must still say where the tab really ended up');
  assert.equal(body.previousHistoryIndex, before.index);
  assert.equal(body.historyIndex, afterHistory.index);
  assert.equal(typeof body.note, 'string');
  assert.match(String(body.note), /back|guard|intercept|blocked|wrong way/i);

  await sessions.releaseSession(sessionId);
});

