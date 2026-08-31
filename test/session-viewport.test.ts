import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { BrowserManager } from '../src/daemon/browserManager.js';
import { SessionStore } from '../src/daemon/sessions.js';
import { createToolHandlers, type ToolHandlers } from '../src/daemon/tools/handlers.js';
import { getFreePort, pngSize, startTestPage } from './helpers.js';

let browserManager: BrowserManager;
let sessions: SessionStore;
let handlers: ToolHandlers;

before(async () => {
  browserManager = new BrowserManager(await getFreePort());
  sessions = new SessionStore(browserManager);
  handlers = createToolHandlers(sessions, {
    debugPort: 0,
    screenshotCacheDir: '/dev/null/unused',
    screenshotCacheTtlMs: 1000
  });
});

after(async () => {
  await sessions.closeAll();
  await browserManager.close();
});

/** The real pixel dimensions of an inline screenshot, straight off the PNG header. */
async function screenshotSize(sessionId: string): Promise<{ width: number; height: number }> {
  const shot = await handlers.screenshot({ sessionId });
  const block = shot.content[0];
  assert.equal(block?.type, 'image', `expected an inline image block, got ${JSON.stringify(shot.content)}`);
  return pngSize(Buffer.from((block as { data: string }).data, 'base64'));
}

async function cssViewport(sessionId: string): Promise<{ width: number; height: number }> {
  const result = await handlers.evaluate({
    sessionId,
    expression: '({ width: window.innerWidth, height: window.innerHeight })'
  });
  return (result.structuredContent as { result: { width: number; height: number } }).result;
}

test('create_session takes a viewport, and a 2x deviceScaleFactor doubles the screenshot pixel dimensions', async () => {
  const created = await handlers.create_session({
    viewport: { width: 400, height: 300 },
    deviceScaleFactor: 2
  });
  const { sessionId } = created.structuredContent as { sessionId: string };

  // The CSS viewport is what the page sees; the PNG is what the device
  // renders. deviceScaleFactor is the ratio between them, and it can only be
  // set here because Playwright fixes it when the context is created.
  assert.deepEqual(await cssViewport(sessionId), { width: 400, height: 300 });
  assert.deepEqual(await screenshotSize(sessionId), { width: 800, height: 600 });

  await handlers.release_session({ sessionId });
});

test('a session created with no options keeps the default 1:1 viewport', async () => {
  const created = await handlers.create_session({});
  const { sessionId } = created.structuredContent as { sessionId: string };

  const css = await cssViewport(sessionId);
  assert.deepEqual(await screenshotSize(sessionId), css, 'the default deviceScaleFactor is 1');

  await handlers.release_session({ sessionId });
});

test('concurrent sessions keep their own viewport and scale factor, with no state bleeding between them', async () => {
  const page = await startTestPage();
  try {
    const [smallResult, largeResult] = await Promise.all([
      handlers.create_session({ viewport: { width: 320, height: 480 }, deviceScaleFactor: 1 }),
      handlers.create_session({ viewport: { width: 900, height: 500 }, deviceScaleFactor: 3 })
    ]);
    const small = (smallResult.structuredContent as { sessionId: string }).sessionId;
    const large = (largeResult.structuredContent as { sessionId: string }).sessionId;

    await Promise.all([
      handlers.navigate({ sessionId: small, url: page.url }),
      handlers.navigate({ sessionId: large, url: page.url })
    ]);

    assert.deepEqual(await screenshotSize(small), { width: 320, height: 480 });
    assert.deepEqual(await screenshotSize(large), { width: 2700, height: 1500 });
    assert.deepEqual(await cssViewport(small), { width: 320, height: 480 });
    assert.deepEqual(await cssViewport(large), { width: 900, height: 500 });

    // Differently-configured contexts are still fully isolated contexts.
    await handlers.evaluate({ sessionId: small, expression: 'localStorage.setItem("who", "small"), "ok"' });
    await handlers.evaluate({ sessionId: large, expression: 'localStorage.setItem("who", "large"), "ok"' });

    const fromSmall = await handlers.evaluate({ sessionId: small, expression: 'localStorage.getItem("who")' });
    const fromLarge = await handlers.evaluate({ sessionId: large, expression: 'localStorage.getItem("who")' });
    assert.equal((fromSmall.structuredContent as { result: string }).result, 'small');
    assert.equal((fromLarge.structuredContent as { result: string }).result, 'large');

    await handlers.release_session({ sessionId: small });
    await handlers.release_session({ sessionId: large });
  } finally {
    await page.close();
  }
});

test('storageState seeding still works alongside the new options', async () => {
  const page = await startTestPage();
  try {
    const source = await handlers.create_session({});
    const sourceId = (source.structuredContent as { sessionId: string }).sessionId;
    await handlers.navigate({ sessionId: sourceId, url: page.url });
    await handlers.evaluate({ sessionId: sourceId, expression: 'localStorage.setItem("seeded", "yes"), "ok"' });

    const exported = await handlers.export_state({ sessionId: sourceId });
    const { storageState } = exported.structuredContent as { storageState: unknown };

    const seeded = await handlers.create_session({
      storageState,
      viewport: { width: 500, height: 400 },
      deviceScaleFactor: 2
    });
    const seededId = (seeded.structuredContent as { sessionId: string }).sessionId;
    await handlers.navigate({ sessionId: seededId, url: page.url });

    const value = await handlers.evaluate({ sessionId: seededId, expression: 'localStorage.getItem("seeded")' });
    assert.equal((value.structuredContent as { result: string }).result, 'yes');
    assert.deepEqual(await screenshotSize(seededId), { width: 1000, height: 800 });

    await handlers.release_session({ sessionId: sourceId });
    await handlers.release_session({ sessionId: seededId });
  } finally {
    await page.close();
  }
});
