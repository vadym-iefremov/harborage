import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { BrowserManager } from '../src/daemon/browserManager.js';
import { createToolHandlers } from '../src/daemon/tools/handlers.js';
import { SessionStore } from '../src/daemon/sessions.js';
import { getFreePort } from './helpers.js';

let browserManager: BrowserManager;
let sessions: SessionStore;
let handlers: ReturnType<typeof createToolHandlers>;

before(async () => {
  const debugPort = await getFreePort();
  browserManager = new BrowserManager(debugPort);
  sessions = new SessionStore(browserManager);
  handlers = createToolHandlers(sessions, { debugPort, screenshotCacheDir: '/dev/null/unused', screenshotCacheTtlMs: 1000 });
});

after(async () => {
  await sessions.closeAll();
  await browserManager.close();
});

test('send_cdp_command issues a real CDP call and returns its structured result', async () => {
  const { sessionId } = await sessions.createSession();
  await sessions.resolve(sessionId).page.goto('data:text/html,<body style="margin:0"><div style="width:400px;height:300px"></div></body>');

  const result = await handlers.send_cdp_command({ sessionId, method: 'Page.getLayoutMetrics' });
  const payload = (result as { structuredContent: { method: string; result: { cssLayoutViewport?: { clientWidth: number }; layoutViewport?: { clientWidth: number } } } })
    .structuredContent;

  assert.equal(payload.method, 'Page.getLayoutMetrics');
  const viewport = payload.result.cssLayoutViewport ?? payload.result.layoutViewport;
  assert.ok(viewport, 'expected Page.getLayoutMetrics to return a layout viewport');
  assert.ok(viewport!.clientWidth > 0, 'expected a real positive viewport width from a live CDP call');

  await sessions.releaseSession(sessionId);
});

test('send_cdp_command accepts params and reflects them through to the real command', async () => {
  const { sessionId } = await sessions.createSession();
  await sessions.resolve(sessionId).page.goto('data:text/html,<h1>cdp params test</h1>');

  const result = await handlers.send_cdp_command({
    sessionId,
    method: 'Runtime.evaluate',
    params: { expression: '1 + 41', returnByValue: true }
  });
  const payload = (result as { structuredContent: { result: { result: { value: number } } } }).structuredContent;

  assert.equal(payload.result.result.value, 42);

  await sessions.releaseSession(sessionId);
});

test('send_cdp_command rejects an unknown CDP method with a real protocol error', async () => {
  const { sessionId } = await sessions.createSession();
  await assert.rejects(() => handlers.send_cdp_command({ sessionId, method: 'Definitely.NotARealMethod' }));
  await sessions.releaseSession(sessionId);
});
