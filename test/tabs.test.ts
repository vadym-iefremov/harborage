import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';

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
    const name = new URL(req.url ?? '/', 'http://x').searchParams.get('name') ?? 'page';
    if ((req.url ?? '').startsWith('/marker')) {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('marker');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(
      `<html><head><title>${name}</title></head><body>` +
        `<a id="pop" href="/?name=popup" target="_blank">open popup</a>` +
        `<script>console.log("hello from ${name}"); fetch("/marker?from=${name}");</script>` +
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
  // The popup arrives asynchronously; give the context's own page event a moment.
  const deadline = Date.now() + 5000;
  let tabs = await tabsOf(sessionId);
  while (tabs.length < 2 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 50));
    tabs = await tabsOf(sessionId);
  }

  assert.equal(tabs.length, 2, 'a target=_blank tab must be adopted exactly once, not twice and not zero times');
  const popup = tabs.find(t => t.url.includes('name=popup'));
  assert.ok(popup, `expected the popup among ${JSON.stringify(tabs.map(t => t.url))}`);

  const console = await handlers.read_console({ sessionId, pageId: popup.pageId });
  const messages = (console.structuredContent as { messages: { text: string }[] }).messages;
  assert.ok(messages.some(m => m.text.includes('hello from popup')));

  await handlers.release_session({ sessionId });
});
