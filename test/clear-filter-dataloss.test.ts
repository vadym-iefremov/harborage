import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { BrowserManager } from '../src/daemon/browserManager.js';
import { SessionStore } from '../src/daemon/sessions.js';
import { createToolHandlers, type ToolHandlers } from '../src/daemon/tools/handlers.js';
import { getFreePort, startTestPage } from './helpers.js';

/**
 * `clear: true` used to drain the whole buffer while returning only the
 * entries a filter matched, silently destroying messages the caller never saw.
 * The filter now goes into the SessionStore rather than being applied to what
 * it hands back, so clearing removes exactly what was returned.
 *
 * This is the worst failure shape in the project's vocabulary: no error, and
 * the evidence an agent would have used to notice is the thing that got
 * deleted.
 */

let browserManager: BrowserManager;
let sessions: SessionStore;
let handlers: ToolHandlers;
let page: { url: string; close: () => Promise<void> };

before(async () => {
  browserManager = new BrowserManager(await getFreePort());
  sessions = new SessionStore(browserManager);
  handlers = createToolHandlers(sessions, {
    debugPort: 0,
    screenshotCacheDir: '/tmp/harborage-unused',
    screenshotCacheTtlMs: 60_000
  });
  page = await startTestPage();
});

after(async () => {
  await sessions.closeAll();
  await browserManager.close();
  await page.close();
});

test('a filtered read_console with clear leaves the non-matching messages in the buffer', async () => {
  const { sessionId } = await sessions.createSession();
  await handlers.navigate({ sessionId, url: page.url, settleMs: 0 });
  await handlers.evaluate({
    sessionId,
    expression: '(() => { console.log("keep me one"); console.error("drain me"); console.log("keep me two"); return 1; })()'
  });

  const errors = await handlers.read_console({ sessionId, types: ['error'], clear: true });
  const errorTexts = (errors.structuredContent as { messages: { text: string }[] }).messages.map(m => m.text);
  assert.deepEqual(errorTexts, ['drain me'], 'only the error should come back');

  // The two logs were never returned, so they must still be readable.
  const rest = await handlers.read_console({ sessionId });
  const restTexts = (rest.structuredContent as { messages: { text: string }[] }).messages.map(m => m.text);
  assert.deepEqual(restTexts, ['keep me one', 'keep me two'], 'a filtered clear must not discard unseen messages');

  await sessions.releaseSession(sessionId);
});

test('a filtered list_network_requests with clear leaves the non-matching entries in the buffer', async () => {
  const { sessionId } = await sessions.createSession();
  await handlers.navigate({ sessionId, url: page.url, settleMs: 0 });

  const before = await handlers.list_network_requests({ sessionId });
  assert.ok((before.structuredContent as { total: number }).total > 0, 'the navigation should have produced traffic');

  // Match nothing at all, while asking to clear.
  const none = await handlers.list_network_requests({
    sessionId,
    urlIncludes: 'this-substring-matches-nothing-at-all',
    clear: true
  });
  assert.equal((none.structuredContent as { returned: number }).returned, 0);

  const after = await handlers.list_network_requests({ sessionId });
  assert.equal(
    (after.structuredContent as { total: number }).total,
    (before.structuredContent as { total: number }).total,
    'a clear that matched nothing must delete nothing'
  );

  await sessions.releaseSession(sessionId);
});

test('an unfiltered read_console with clear still drains everything', async () => {
  const { sessionId } = await sessions.createSession();
  await handlers.navigate({ sessionId, url: page.url, settleMs: 0 });
  await handlers.evaluate({ sessionId, expression: '(() => { console.log("a"); console.log("b"); return 1; })()' });

  const drained = await handlers.read_console({ sessionId, clear: true });
  assert.equal((drained.structuredContent as { returned: number }).returned, 2);

  const after = await handlers.read_console({ sessionId });
  assert.equal((after.structuredContent as { messages: unknown[] }).messages.length, 0, 'an unfiltered clear empties the buffer');

  await sessions.releaseSession(sessionId);
});
