import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { BrowserManager } from '../src/daemon/browserManager.js';
import { createToolHandlers } from '../src/daemon/tools/handlers.js';
import { SessionStore } from '../src/daemon/sessions.js';
import { getFreePort, startTestPage } from './helpers.js';

let browserManager: BrowserManager;
let debugPort: number;
let page: { url: string; close: () => Promise<void> };

before(async () => {
  debugPort = await getFreePort();
  browserManager = new BrowserManager(debugPort);
  page = await startTestPage();
});

after(async () => {
  await browserManager.close();
  await page.close();
});

function makeStore(bufferLimits: { console: number; network: number } = { console: 200, network: 200 }) {
  const sessions = new SessionStore(browserManager, bufferLimits);
  const handlers = createToolHandlers(sessions, {
    debugPort,
    screenshotCacheDir: '/dev/null/unused',
    screenshotCacheTtlMs: 1000
  });
  return { sessions, handlers };
}

test('read_console returns console.log activity that happened before the tool was ever called', async () => {
  const { sessions, handlers } = makeStore();
  const { sessionId } = await sessions.createSession();
  const target = sessions.resolve(sessionId);

  await target.page.goto('data:text/html,<h1>console test</h1>');
  await target.page.evaluate(() => console.log('harborage console test marker'));
  await target.page.evaluate(() => console.error('harborage console error marker'));

  const result = await handlers.read_console({ sessionId });
  const payload = (result as { structuredContent: { messages: { type: string; text: string; pageId: string }[] } }).structuredContent;

  const logEntry = payload.messages.find(m => m.text.includes('harborage console test marker'));
  const errorEntry = payload.messages.find(m => m.text.includes('harborage console error marker'));
  assert.ok(logEntry, 'expected the buffered console.log message to be readable after the fact');
  assert.equal(logEntry!.type, 'log');
  assert.ok(errorEntry, 'expected the buffered console.error message to be readable too');
  assert.equal(errorEntry!.type, 'error');
  assert.equal(logEntry!.pageId, target.pageId);

  await sessions.releaseSession(sessionId);
});

test('list_network_requests captures request and response activity for a real navigation', async () => {
  const { sessions, handlers } = makeStore();
  const { sessionId } = await sessions.createSession();
  await sessions.resolve(sessionId).page.goto(page.url);

  const result = await handlers.list_network_requests({ sessionId });
  const payload = (result as { structuredContent: { requests: { direction: string; url: string; method?: string; status?: number }[] } })
    .structuredContent;

  const request = payload.requests.find(r => r.direction === 'request' && r.url === page.url);
  const response = payload.requests.find(r => r.direction === 'response' && r.url === page.url);
  assert.ok(request, 'expected a buffered request entry for the navigation');
  assert.equal(request!.method, 'GET');
  assert.ok(response, 'expected a buffered response entry for the navigation');
  assert.equal(response!.status, 200);

  await sessions.releaseSession(sessionId);
});

test('clear: true drains the buffer after reading it', async () => {
  const { sessions, handlers } = makeStore();
  const { sessionId } = await sessions.createSession();
  const target = sessions.resolve(sessionId);
  await target.page.goto('data:text/html,<h1>clear test</h1>');
  await target.page.evaluate(() => console.log('one-time marker'));

  const first = await handlers.read_console({ sessionId, clear: true });
  const firstPayload = (first as { structuredContent: { messages: { text: string }[] } }).structuredContent;
  assert.ok(firstPayload.messages.some(m => m.text.includes('one-time marker')));

  const second = await handlers.read_console({ sessionId });
  const secondPayload = (second as { structuredContent: { messages: { text: string }[] } }).structuredContent;
  assert.ok(!secondPayload.messages.some(m => m.text.includes('one-time marker')), 'expected the buffer to have been drained by clear: true');

  await sessions.releaseSession(sessionId);
});

test('the console buffer is bounded: oldest entries are dropped once over the limit', async () => {
  const { sessions, handlers } = makeStore({ console: 5, network: 200 });
  const { sessionId } = await sessions.createSession();
  const target = sessions.resolve(sessionId);
  await target.page.goto('data:text/html,<h1>bounded buffer test</h1>');

  for (let i = 0; i < 20; i++) {
    await target.page.evaluate(index => console.log(`marker-${index}`), i);
  }

  const result = await handlers.read_console({ sessionId });
  const payload = (result as { structuredContent: { messages: { text: string }[] } }).structuredContent;

  assert.ok(payload.messages.length <= 5, `expected the buffer to stay bounded at 5, got ${payload.messages.length}`);
  // The most recent entries survive; the earliest ones were dropped.
  assert.ok(payload.messages.some(m => m.text.includes('marker-19')), 'expected the most recent log line to still be buffered');
  assert.ok(!payload.messages.some(m => m.text.includes('marker-0')), 'expected the earliest log line to have been dropped');

  await sessions.releaseSession(sessionId);
});
