import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { BrowserManager } from '../src/daemon/browserManager.js';
import { cleanScreenshotCache } from '../src/daemon/screenshotCache.js';
import { createToolHandlers } from '../src/daemon/tools/handlers.js';
import { SessionStore } from '../src/daemon/sessions.js';
import { getFreePort, snapshotRepoFiles } from './helpers.js';

let browserManager: BrowserManager;
let sessions: SessionStore;
let debugPort: number;
let screenshotCacheDir: string;
let handlers: ReturnType<typeof createToolHandlers>;

before(async () => {
  debugPort = await getFreePort();
  browserManager = new BrowserManager(debugPort);
  sessions = new SessionStore(browserManager);
  screenshotCacheDir = join(mkdtempSync(join(tmpdir(), 'harborage-test-')), 'screenshots');
  handlers = createToolHandlers(sessions, { debugPort, screenshotCacheDir, screenshotCacheTtlMs: 30 * 60 * 1000 });
});

after(async () => {
  await sessions.closeAll();
  await browserManager.close();
});

test('mode: "cached" writes a real PNG to the cache dir and returns a reference, not inline bytes', async () => {
  const filesBeforeInRepo = snapshotRepoFiles();

  const { sessionId } = await sessions.createSession();
  await sessions.resolve(sessionId).page.goto('data:text/html,<h1 style="color:red">cached screenshot check</h1>');

  const result = await handlers.screenshot({ sessionId, fullPage: false, mode: 'cached' });
  const payload = (result as { structuredContent: { path: string; cacheId: string; sizeBytes: number; expiresAt: string; mode: string } })
    .structuredContent;

  assert.equal(payload.mode, 'cached');
  assert.ok(payload.path.startsWith(screenshotCacheDir));
  assert.ok(existsSync(payload.path), 'expected the cached screenshot file to actually exist on disk');
  assert.ok(payload.sizeBytes > 0);
  assert.ok(new Date(payload.expiresAt).getTime() > Date.now());

  const fileBytes = statSync(payload.path);
  assert.ok(fileBytes.size > 0);
  assert.ok(fileBytes.size === payload.sizeBytes);

  // No image content block when caching — the point is avoiding the inline payload.
  const hasImageBlock = (result.content as { type: string }[]).some(b => b.type === 'image');
  assert.equal(hasImageBlock, false);

  // The repo itself is untouched — the cache lives entirely under the state dir.
  assert.deepEqual(snapshotRepoFiles(), filesBeforeInRepo);

  await sessions.releaseSession(sessionId);
});

test('default (no mode) still returns inline bytes and writes nothing to the cache dir', async () => {
  const { sessionId } = await sessions.createSession();
  await sessions.resolve(sessionId).page.goto('data:text/html,<h1>inline default check</h1>');

  const filesInCacheBefore = existsSync(screenshotCacheDir) ? readdirSync(screenshotCacheDir).length : 0;
  const result = await handlers.screenshot({ sessionId, fullPage: false });
  const filesInCacheAfter = existsSync(screenshotCacheDir) ? readdirSync(screenshotCacheDir).length : 0;

  assert.equal(filesInCacheAfter, filesInCacheBefore);
  const [block] = result.content as { type: string }[];
  assert.equal(block!.type, 'image');

  await sessions.releaseSession(sessionId);
});

test('cleanScreenshotCache deletes files past the TTL and leaves fresh ones alone', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'harborage-test-cache-'));
  const stalePath = join(dir, 'stale.png');
  const freshPath = join(dir, 'fresh.png');
  writeFileSync(stalePath, Buffer.from([1, 2, 3]));
  writeFileSync(freshPath, Buffer.from([4, 5, 6]));

  // Backdate the "stale" file's mtime well past a short TTL; leave "fresh" alone.
  const longAgo = new Date(Date.now() - 60_000);
  utimesSync(stalePath, longAgo, longAgo);

  const removed = await cleanScreenshotCache(dir, 5_000);

  assert.deepEqual(removed, ['stale.png']);
  assert.ok(!existsSync(stalePath));
  assert.ok(existsSync(freshPath));
});

test('cleanScreenshotCache on a directory that does not exist yet is a no-op, not an error', async () => {
  const removed = await cleanScreenshotCache(join(tmpdir(), `harborage-never-created-${Date.now()}`), 1000);
  assert.deepEqual(removed, []);
});
