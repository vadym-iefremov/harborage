import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';

import type { BrowserContext, Page } from 'playwright';

import { BrowserManager } from '../src/daemon/browserManager.js';
import { SessionStore } from '../src/daemon/sessions.js';
import { createToolHandlers, type ToolHandlers } from '../src/daemon/tools/handlers.js';
import { getFreePort } from './helpers.js';

interface TabRow {
  pageId: string;
  url: string;
  title: string;
  active: boolean;
}

let browserManager: BrowserManager;
let sessions: SessionStore;
let handlers: ToolHandlers;
let server: Server;
let base: string;

/**
 * Serves pages that announce themselves on the console and fetch a marker
 * URL, so a test can prove a tab's buffers were wired up from the moment it
 * opened rather than from the first time anyone asked.
 */
before(async () => {
  browserManager = new BrowserManager(await getFreePort());
  sessions = new SessionStore(browserManager);
  handlers = createToolHandlers(sessions, {
    debugPort: 0,
    screenshotCacheDir: '/dev/null/unused',
    screenshotCacheTtlMs: 1000
  });

  server = createServer((req, res) => {
    const query = new URL(req.url ?? '/', 'http://x').searchParams;
    const name = query.get('name') ?? 'page';
    // The script body the synchronous popup writes into itself. Supplied by
    // the test rather than fixed here, so one page can exercise the console,
    // network and page-error buffers independently.
    const syncBody = query.get('syncBody') ?? 'console.log("hello from instant popup")';
    if ((req.url ?? '').startsWith('/marker')) {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('marker');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(
      `<html><head><title>${name}</title></head><body>` +
        `<a id="pop" href="/?name=popup" target="_blank">open popup</a>` +
        // data-body is whatever the caller asked for, so one fixture can prove
        // the console, network and page-error paths separately without three
        // near-identical pages.
        `<button id="pop-sync" data-body='${syncBody}'>open popup synchronously</button>` +
        // This second popup opens about:blank and writes its script into it
        // in the SAME synchronous task, so the popup's first console line is
        // emitted before any round trip between the daemon and Playwright
        // could have completed. That is what makes tab adoption assertable
        // rather than raceable: see the regression test that uses it.
        `<script>` +
        `document.getElementById("pop-sync").onclick = function () {` +
        `  var w = window.open("about:blank");` +
        `  w.document.write('<scr' + 'ipt>' + document.getElementById("pop-sync").dataset.body + '</scr' + 'ipt>');` +
        `  w.document.close();` +
        `};` +
        `console.log("hello from ${name}"); fetch("/marker?from=${name}");</script>` +
        '</body></html>'
    );
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/`;
});

after(async () => {
  await sessions.closeAll();
  await browserManager.close();
  await new Promise<void>(resolve => server.close(() => resolve()));
});

async function tabsOf(sessionId: string): Promise<TabRow[]> {
  const listed = await handlers.list_tabs({ sessionId });
  return (listed.structuredContent as { tabs: TabRow[] }).tabs;
}

/** The pageId a call that omits pageId would target, read back from the tool surface. */
async function activePageId(sessionId: string): Promise<string> {
  const result = await handlers.evaluate({ sessionId, expression: '"which tab am I"' });
  return (result.structuredContent as { pageId: string }).pageId;
}

test('new_tab opens a tab, returns its pageId, navigates it, and makes it the active target', async () => {
  const created = await handlers.create_session({});
  const { sessionId, pageId: firstPageId } = created.structuredContent as { sessionId: string; pageId: string };

  const opened = await handlers.new_tab({ sessionId, url: `${base}?name=second` });
  const { pageId: secondPageId } = opened.structuredContent as { pageId: string };

  assert.notEqual(secondPageId, firstPageId, 'a new tab must get its own pageId');

  const tabs = await tabsOf(sessionId);
  assert.equal(tabs.length, 2);
  const second = tabs.find(t => t.pageId === secondPageId);
  assert.ok(second);
  assert.match(second.url, /name=second/, 'new_tab with a url should land there');
  assert.equal(second.active, true, 'the tab just opened is the one later calls target');
  assert.equal(await activePageId(sessionId), secondPageId);

  await handlers.release_session({ sessionId });
});

test('a tab opened through new_tab has console and network buffering from the moment it opened', async () => {
  const created = await handlers.create_session({});
  const { sessionId } = created.structuredContent as { sessionId: string };

  const opened = await handlers.new_tab({ sessionId, url: `${base}?name=buffered` });
  const { pageId } = opened.structuredContent as { pageId: string };

  // Nothing subscribed to this tab after the fact: the page logged and
  // fetched during its own load, before any tool asked about it.
  const console = await handlers.read_console({ sessionId, pageId });
  const messages = (console.structuredContent as { messages: { text: string }[] }).messages;
  assert.ok(
    messages.some(m => m.text.includes('hello from buffered')),
    `expected the new tab's own load-time console output, got ${JSON.stringify(messages)}`
  );

  const network = await handlers.list_network_requests({ sessionId, pageId });
  const requests = (network.structuredContent as { requests: { url: string }[] }).requests;
  assert.ok(
    requests.some(e => e.url.includes('/marker?from=buffered')),
    `expected the new tab's own load-time requests, got ${JSON.stringify(requests.map(e => e.url))}`
  );

  await handlers.release_session({ sessionId });
});

test('select_tab changes which tab a call that omits pageId targets', async () => {
  const created = await handlers.create_session({});
  const { sessionId, pageId: first } = created.structuredContent as { sessionId: string; pageId: string };
  const opened = await handlers.new_tab({ sessionId });
  const { pageId: second } = opened.structuredContent as { pageId: string };

  assert.equal(await activePageId(sessionId), second);

  await handlers.select_tab({ sessionId, pageId: first });
  assert.equal(await activePageId(sessionId), first);

  const tabs = await tabsOf(sessionId);
  assert.equal(tabs.find(t => t.pageId === first)?.active, true);
  assert.equal(tabs.find(t => t.pageId === second)?.active, false);

  await handlers.release_session({ sessionId });
});

test('close_tab closes one tab and leaves the session on a well-defined remaining tab', async () => {
  const created = await handlers.create_session({});
  const { sessionId, pageId: first } = created.structuredContent as { sessionId: string; pageId: string };
  const second = (
    (await handlers.new_tab({ sessionId })).structuredContent as { pageId: string }
  ).pageId;
  const third = ((await handlers.new_tab({ sessionId })).structuredContent as { pageId: string }).pageId;

  await handlers.close_tab({ sessionId, pageId: third });

  const tabs = await tabsOf(sessionId);
  assert.deepEqual(
    tabs.map(t => t.pageId).sort(),
    [first, second].sort(),
    'the closed tab should be gone and the others untouched'
  );
  // Closing the active tab falls back to the most recently opened survivor,
  // which is the tab the popup-style flow came from.
  assert.equal(await activePageId(sessionId), second);

  await handlers.release_session({ sessionId });
});

test('close_tab refuses to close the last tab, naming what to do instead', async () => {
  const created = await handlers.create_session({});
  const { sessionId, pageId } = created.structuredContent as { sessionId: string; pageId: string };

  await assert.rejects(
    handlers.close_tab({ sessionId, pageId }),
    /last tab|release_session/i,
    'closing the only tab would leave a session no later call could use'
  );

  // The session is untouched and still usable.
  assert.equal((await tabsOf(sessionId)).length, 1);
  assert.equal(await activePageId(sessionId), pageId);

  await handlers.release_session({ sessionId });
});

test('a tab the page opens itself still gets exactly one pageId, with its own buffers', async () => {
  const created = await handlers.create_session({});
  const { sessionId } = created.structuredContent as { sessionId: string };
  await handlers.navigate({ sessionId, url: `${base}?name=opener` });

  await handlers.click({ sessionId, selector: '#pop' });
  // Both waits below are deliberately generous. Measured on an idle machine,
  // the popup is adopted and its console message buffered within about 45ms,
  // consistently, over 25 consecutive runs with none ever lost. So a wait of
  // several seconds is already orders of magnitude of headroom, and the only
  // thing a tight deadline buys is a test that fails when the machine is busy
  // running other suites, which is indistinguishable from a real regression
  // when you read the output later. Fifteen seconds asserts the same property
  // and only trips on something genuinely broken.
  const deadline = Date.now() + 15000;
  let tabs = await tabsOf(sessionId);
  while (tabs.length < 2 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 50));
    tabs = await tabsOf(sessionId);
  }

  assert.equal(
    tabs.length,
    2,
    `a target=_blank tab must be adopted exactly once, not twice and not zero times; saw ${JSON.stringify(tabs.map(t => t.url))}`
  );
  const popup = tabs.find(t => t.url.includes('name=popup'));
  assert.ok(popup, `expected the popup among ${JSON.stringify(tabs.map(t => t.url))}`);

  // Polled rather than read once. The tab being adopted and the popup's own
  // script having run are two different events, and nothing orders them: the
  // page listener fires as soon as the target exists, which can be before the
  // document has executed a line. Reading the buffer at that moment found it
  // empty and failed roughly one run in three, which is the flakiest possible
  // way to assert a real property. The property under test is that the popup
  // gets its OWN buffer, so waiting for the message is the honest wait.
  const messageDeadline = Date.now() + 15000;
  let messages: { text: string }[] = [];
  let sawPopupMessage = false;
  while (Date.now() < messageDeadline) {
    const console = await handlers.read_console({ sessionId, pageId: popup.pageId });
    messages = (console.structuredContent as { messages: { text: string }[] }).messages;
    sawPopupMessage = messages.some(m => m.text.includes('hello from popup'));
    if (sawPopupMessage) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  // On failure, read the buffer UNSCOPED as well. A scoped read coming back
  // empty has two completely different causes with completely different
  // fixes: the message was never captured at all, or it was captured and
  // filed under the wrong tab. They are indistinguishable from the scoped
  // read alone, and guessing between them is how the previous two attempts
  // at this went wrong.
  if (!sawPopupMessage) {
    const wide = await handlers.read_console({ sessionId });
    const all = (wide.structuredContent as { messages: { pageId: string; text: string }[] }).messages;
    const net = await handlers.list_network_requests({ sessionId });
    const requests = (net.structuredContent as { requests: { pageId: string; url: string }[] }).requests;
    assert.fail(
      `expected the popup's own console buffer to carry its message.\n` +
        `  popup pageId : ${popup.pageId}\n` +
        `  scoped read  : ${JSON.stringify(messages.map(m => m.text))}\n` +
        `  session-wide : ${JSON.stringify(all.map(m => `${m.pageId}:${m.text}`))}\n` +
        `  tabs         : ${JSON.stringify(tabs)}\n` +
        `  network      : ${JSON.stringify(requests.map(r => `${r.pageId}:${r.url}`))}`
    );
  }

  await handlers.release_session({ sessionId });
});


/**
 * Opens the synchronous popup with `body` as its very first script, waits for
 * the session to have two tabs, and returns the popup's row.
 *
 * The popup writes its own script in the same synchronous task as
 * `window.open`, which is the point: its first statement runs before any
 * round trip between the daemon and Playwright's server could have finished.
 * Anything that only captures a tab's output once the daemon has been told
 * about the tab cannot see it, no matter how long the caller then waits.
 */
async function openInstantPopup(body: string): Promise<{ sessionId: string; popup: TabRow }> {
  const created = await handlers.create_session({});
  const { sessionId } = created.structuredContent as { sessionId: string };
  await handlers.navigate({ sessionId, url: `${base}?name=opener&syncBody=${encodeURIComponent(body)}` });
  await handlers.click({ sessionId, selector: '#pop-sync' });

  const deadline = Date.now() + 15000;
  let tabs = await tabsOf(sessionId);
  while (tabs.length < 2 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 25));
    tabs = await tabsOf(sessionId);
  }
  assert.equal(tabs.length, 2, `the synchronous popup was never adopted; saw ${JSON.stringify(tabs)}`);
  const popup = tabs.find(t => !t.url.includes('name=opener'));
  assert.ok(popup, `expected a popup among ${JSON.stringify(tabs.map(t => t.url))}`);
  return { sessionId, popup };
}

/** Polls `read` until `found` is true or the deadline passes, then returns the last value seen. */
async function pollFor<T>(read: () => Promise<T>, found: (value: T) => boolean, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = await read();
  while (!found(last) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 25));
    last = await read();
  }
  return last;
}

/**
 * The three tests below assert the property a caller actually depends on: a
 * popup's first statement reaches the popup's own buffer. They are worth
 * having, but they are NOT the deterministic gate, and the previous two
 * rounds went wrong by believing a test like this was one. Measured against
 * the pre-fix code, they fail only some of the time when the machine is
 * quiet, because the daemon usually still wins the race they are about. The
 * deterministic guards are the two that follow them, plus
 * 'the buffers a session reads back are wired to its context, not its tabs'.
 *
 * The honest measurement, run separately and not from the suite: 60 popups
 * at concurrency 6, comparing pre-fix and post-fix. Pre-fix, the popup's
 * first console line arrived 45 times out of 60 and its first dialog 31 out
 * of 60. Post-fix, every one of the six event types was 60 out of 60.
 */
test("a popup's first console line survives, even when it runs before the daemon hears about the tab", async () => {
  const { sessionId, popup } = await openInstantPopup('console.log("hello from instant popup")');

  const messages = await pollFor(
    async () =>
      (
        (await handlers.read_console({ sessionId, pageId: popup.pageId })).structuredContent as {
          messages: { pageId: string; text: string }[];
        }
      ).messages,
    found => found.some(m => m.text.includes('hello from instant popup'))
  );

  // Not a timing assertion. Buffering console output per page used to mean
  // asking Playwright for that page's console events only once the page
  // existed, and Playwright will not send events nobody has subscribed to
  // yet, so everything the popup said in the meantime was dropped on its
  // side and could never arrive. Losing it is silent: a caller debugging a
  // popup reads an empty buffer and concludes the script never ran.
  assert.ok(
    messages.some(m => m.text.includes('hello from instant popup')),
    `expected the popup's own console buffer to carry the line it logged at open time, saw ${JSON.stringify(
      messages.map(m => `${m.pageId}:${m.text}`)
    )}`
  );

  await handlers.release_session({ sessionId });
});

test("a popup's first uncaught exception survives the same window its console output does", async () => {
  const { sessionId, popup } = await openInstantPopup('throw new Error("instant popup blew up")');

  const errors = await pollFor(
    async () =>
      (
        (await handlers.read_page_errors({ sessionId, pageId: popup.pageId })).structuredContent as {
          errors: { pageId: string; message: string }[];
        }
      ).errors,
    found => found.some(e => e.message.includes('instant popup blew up'))
  );

  assert.ok(
    errors.some(e => e.message.includes('instant popup blew up')),
    `expected the popup's own page-error buffer to carry the throw, saw ${JSON.stringify(errors)}`
  );

  await handlers.release_session({ sessionId });
});

test("a popup's load-time request survives, and so does the request for the popup's own document", async () => {
  const { sessionId, popup } = await openInstantPopup('fetch("/marker?from=instant")');

  const requests = await pollFor(
    async () =>
      (
        (await handlers.list_network_requests({ sessionId, pageId: popup.pageId })).structuredContent as {
          requests: { pageId: string; url: string; direction: string }[];
        }
      ).requests,
    found => found.some(r => r.url.includes('from=instant'))
  );

  assert.ok(
    requests.some(r => r.url.includes('from=instant')),
    `expected the popup's own network buffer to carry the fetch it made at open time, saw ${JSON.stringify(
      requests.map(r => `${r.pageId}:${r.direction}:${r.url}`)
    )}`
  );

  await handlers.release_session({ sessionId });
});

test("a popup navigated by the browser has its own document request in its own buffer", async () => {
  const created = await handlers.create_session({});
  const { sessionId } = created.structuredContent as { sessionId: string };
  await handlers.navigate({ sessionId, url: `${base}?name=opener` });
  await handlers.click({ sessionId, selector: '#pop' });

  const deadline = Date.now() + 15000;
  let tabs = await tabsOf(sessionId);
  while (tabs.length < 2 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 25));
    tabs = await tabsOf(sessionId);
  }
  const popup = tabs.find(t => t.url.includes('name=popup'));
  assert.ok(popup, `expected the popup among ${JSON.stringify(tabs.map(t => t.url))}`);

  const requests = await pollFor(
    async () =>
      (
        (await handlers.list_network_requests({ sessionId, pageId: popup.pageId })).structuredContent as {
          requests: { pageId: string; url: string; direction: string }[];
        }
      ).requests,
    found => found.some(r => r.direction === 'request' && r.url.includes('name=popup'))
  );

  // The popup's own document is the FIRST thing that tab ever fetches, so it
  // is the request most exposed to this window. A caller who cannot see it
  // cannot tell a popup that loaded the wrong URL from one that loaded
  // nothing, which is most of the reason to look at a popup's network at all.
  assert.ok(
    requests.some(r => r.direction === 'request' && r.url.includes('name=popup')),
    `expected the popup's network buffer to carry the request for its own document, saw ${JSON.stringify(
      requests.map(r => `${r.pageId}:${r.direction}:${r.url}`)
    )}`
  );

  await handlers.release_session({ sessionId });
});

test('a capture filter counts the requests it excludes per tab, not only the responses', async () => {
  const created = await handlers.create_session({
    networkCaptureFilter: { urlIncludes: 'nothing-matches-this' }
  });
  const { sessionId, pageId } = created.structuredContent as { sessionId: string; pageId: string };
  await handlers.navigate({ sessionId, url: `${base}?name=opener` });

  const scoped = (await handlers.list_network_requests({ sessionId, pageId })).structuredContent as {
    filteredAtCapture: number;
    filteredAtCaptureInSession: number;
  };

  // Every exchange is excluded, so the per-tab count and the session-wide
  // count describe the same traffic and must agree. They did not: the
  // per-tab tally was bumped when a RESPONSE was filtered out and not when a
  // REQUEST was, so a caller reading one tab was told roughly half the
  // exclusions its own filter had made, and had no way to tell that number
  // was short.
  assert.ok(scoped.filteredAtCaptureInSession > 0, 'the filter should have excluded this page load');
  assert.equal(
    scoped.filteredAtCapture,
    scoped.filteredAtCaptureInSession,
    'a single-tab session must report the same exclusions scoped as it does session-wide'
  );

  await handlers.release_session({ sessionId });
});


test('the buffers a session reads back are wired to its context, not its tabs', async () => {
  const created = await handlers.create_session({});
  const { sessionId } = created.structuredContent as { sessionId: string };

  // Deliberately white-box, and the only test here that is. The behavioural
  // tests above assert the right property but cannot fail reliably, because
  // the fault they describe is a race the daemon usually wins. This one
  // cannot be raced: it checks WHERE the listeners are, which is the thing
  // that decides whether the race exists at all.
  //
  // Why it has to be the context: Playwright only puts a page's console,
  // dialog, request and response events on the wire once the client has
  // subscribed to them, and subscribing from a page is an asynchronous round
  // trip. A tab that runs script before that round trip lands has its output
  // dropped by Playwright, permanently. A subscription taken out on the
  // context at create_session is in place before any tab exists, so there is
  // no window to lose. Moving any of these back onto Page reintroduces the
  // fault, and this is what says so.
  // Playwright's public types do not surface listenerCount, though both
  // objects are EventEmitters underneath, which is all this needs.
  type Counted = { listenerCount(event: string): number };
  const record = (
    sessions as unknown as { sessions: Map<string, { context: BrowserContext & Counted; pages: Map<string, Page & Counted> }> }
  ).sessions.get(sessionId);
  assert.ok(record, 'the session should be in the store');

  for (const event of ['console', 'request', 'response', 'dialog', 'weberror']) {
    assert.ok(
      record.context.listenerCount(event) > 0,
      `${event} must be buffered from the BrowserContext, or a tab's opening output is lost before anything can read it`
    );
  }
  for (const page of record.pages.values()) {
    for (const event of ['console', 'request', 'response', 'dialog', 'pageerror']) {
      assert.equal(
        page.listenerCount(event),
        0,
        `${event} must not ALSO be buffered per page, or every event lands in the ring twice`
      );
    }
  }

  await handlers.release_session({ sessionId });
});
