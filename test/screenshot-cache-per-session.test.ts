import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { test } from 'node:test';

import { cleanScreenshotCache, sessionCacheDir } from '../src/daemon/screenshotCache.js';

function freshCacheDir(): string {
  return mkdtempSync(join(tmpdir(), 'harborage-test-cache-'));
}

function backdate(path: string, ms: number): void {
  const when = new Date(Date.now() - ms);
  utimesSync(path, when, when);
}

test('a session gets its own subdirectory of the cache, named after its id', () => {
  const cacheDir = '/tmp/harborage-cache';
  const sessionId = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
  assert.equal(sessionCacheDir(cacheDir, sessionId), join(cacheDir, sessionId));
});

test('a hostile session id can never escape the cache directory', () => {
  const cacheDir = freshCacheDir();
  const hostile = [
    '..',
    '../..',
    '../../../etc/passwd',
    '/etc/passwd',
    'nested/child',
    'windows\\child',
    '.',
    '',
    'a b',
    './../outside'
  ];

  for (const id of hostile) {
    const dir = resolve(sessionCacheDir(cacheDir, id));
    assert.equal(
      dirname(dir),
      resolve(cacheDir),
      `"${id}" must resolve to a direct child of the cache dir, got ${dir}`
    );
    assert.ok(dir.startsWith(resolve(cacheDir) + sep), `"${id}" escaped the cache dir: ${dir}`);
    assert.notEqual(dir, resolve(cacheDir), `"${id}" must not resolve to the cache dir itself`);
  }
});

test('expired screenshots inside a session subdirectory are deleted, and named with their session', async () => {
  const cacheDir = freshCacheDir();
  const sessionId = 'session-alpha';
  const dir = sessionCacheDir(cacheDir, sessionId);
  mkdirSync(dir, { recursive: true });

  const stale = join(dir, 'stale.png');
  const fresh = join(dir, 'fresh.png');
  writeFileSync(stale, Buffer.from([1, 2, 3]));
  writeFileSync(fresh, Buffer.from([4, 5, 6]));
  backdate(stale, 60_000);

  const removed = await cleanScreenshotCache(cacheDir, 5_000);

  assert.deepEqual(removed, [join(sessionId, 'stale.png')]);
  assert.ok(!existsSync(stale));
  assert.ok(existsSync(fresh), 'a fresh screenshot must survive');
  assert.ok(existsSync(dir), 'a subdirectory that still holds a fresh screenshot must survive');
});

test('a session subdirectory is removed once it is empty and has been quiet past the TTL', async () => {
  const cacheDir = freshCacheDir();
  const dir = sessionCacheDir(cacheDir, 'session-beta');
  mkdirSync(dir, { recursive: true });
  const stale = join(dir, 'only.png');
  writeFileSync(stale, Buffer.from([1]));
  backdate(stale, 60_000);
  // The directory's own mtime is the last time anything was written into
  // it, which for an expired screenshot is just as old as the file.
  backdate(dir, 60_000);

  const removed = await cleanScreenshotCache(cacheDir, 5_000);

  assert.deepEqual(removed, [join('session-beta', 'only.png')]);
  assert.ok(!existsSync(dir), 'the emptied session directory should not be left behind');
});

test('a session subdirectory created moments ago is left alone, even while empty', async () => {
  const cacheDir = freshCacheDir();
  const dir = sessionCacheDir(cacheDir, 'session-gamma');
  mkdirSync(dir, { recursive: true });

  // This is the mkdir-then-write window inside the screenshot tool. Deleting
  // the directory in between would fail a live tool call with ENOENT.
  const removed = await cleanScreenshotCache(cacheDir, 5_000);

  assert.deepEqual(removed, []);
  assert.ok(existsSync(dir), 'a directory that was just created must not be swept out from under a pending write');
});

test('flat files left at the top level of the cache are still expired, alongside per-session ones', async () => {
  const cacheDir = freshCacheDir();
  const legacy = join(cacheDir, 'legacy.png');
  writeFileSync(legacy, Buffer.from([1]));
  backdate(legacy, 60_000);

  const dir = sessionCacheDir(cacheDir, 'session-delta');
  mkdirSync(dir, { recursive: true });
  const nested = join(dir, 'nested.png');
  writeFileSync(nested, Buffer.from([2]));
  backdate(nested, 60_000);
  backdate(dir, 60_000);

  const removed = await cleanScreenshotCache(cacheDir, 5_000);

  assert.deepEqual([...removed].sort(), [join('session-delta', 'nested.png'), 'legacy.png'].sort());
  assert.ok(!existsSync(legacy));
  assert.ok(!existsSync(nested));
});

test('an entry that vanishes mid-pass does not throw or abort the rest of the sweep', async () => {
  const cacheDir = freshCacheDir();
  // A dangling symlink stats as ENOENT, the same failure a file deleted
  // between readdir and stat produces.
  symlinkSync(join(cacheDir, 'does-not-exist.png'), join(cacheDir, 'dangling.png'));

  const dir = sessionCacheDir(cacheDir, 'session-epsilon');
  mkdirSync(dir, { recursive: true });
  symlinkSync(join(dir, 'also-missing.png'), join(dir, 'dangling.png'));
  const stale = join(dir, 'real.png');
  writeFileSync(stale, Buffer.from([1]));
  backdate(stale, 60_000);
  backdate(dir, 60_000);

  const removed = await cleanScreenshotCache(cacheDir, 5_000);

  assert.deepEqual(removed, [join('session-epsilon', 'real.png')]);
});

test('a cache directory that does not exist yet is still a no-op', async () => {
  const removed = await cleanScreenshotCache(join(tmpdir(), `harborage-never-created-${Date.now()}`), 1000);
  assert.deepEqual(removed, []);
});
