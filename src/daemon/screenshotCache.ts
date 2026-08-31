import type { Dirent } from 'node:fs';
import { readdir, rmdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Anything outside this set is flattened to an underscore. The point is not
 * to preserve the id faithfully, it is that whatever comes back is exactly
 * one path segment: no separator, no parent reference, nothing a path join
 * can walk out of. Session ids are generated UUIDs today, so in practice
 * this never fires, but the cache directory is the one place in the daemon
 * where a caller-supplied string becomes a filesystem path.
 */
const unsafeInSegment = /[^A-Za-z0-9._-]/g;

/**
 * The directory one session's cached screenshots live in.
 *
 * Why per session rather than one flat directory: a whole evening of
 * parallel agents used to pile every PNG into a single namespace, so
 * agents that are otherwise fully isolated from each other could read each
 * other's evidence. Nothing ever leaked into the browser sessions
 * themselves, but the file layout should not quietly undo the isolation the
 * rest of the daemon works to provide.
 */
export function sessionCacheDir(cacheDir: string, sessionId: string): string {
  const flattened = sessionId.replace(unsafeInSegment, '_');
  // A name of nothing but dots is still a traversal ("." or ".."), even
  // though every character in it survived the filter above.
  const safe = flattened.length === 0 || /^\.+$/.test(flattened) ? '_' : flattened;
  return join(cacheDir, safe);
}

/** Deletes one file if it is past the TTL, recording it under `label`. Never throws. */
async function expireFile(path: string, label: string, ttlMs: number, now: number, removed: string[]): Promise<void> {
  try {
    const info = await stat(path);
    if (now - info.mtimeMs > ttlMs) {
      await unlink(path);
      removed.push(label);
    }
  } catch {
    // Already gone (a released session cleaning up, a file replaced
    // mid-pass), or a permissions hiccup. Nothing left to do for it either
    // way, and one bad entry must never abort the rest of the sweep.
  }
}

/**
 * Expires one session's subdirectory, and removes the subdirectory itself
 * once nothing is left in it.
 *
 * The directory's mtime is read BEFORE anything inside it is deleted. That
 * matters: our own unlinks bump the mtime, so reading it afterwards would
 * only ever tell us when this sweep ran. Read first, it means "the last
 * time the session itself wrote or removed a screenshot here".
 *
 * Requiring that mtime to be past the TTL, rather than just requiring the
 * directory to be empty, closes a real race: the screenshot tool creates
 * this directory and then writes into it as two separate steps, and a sweep
 * landing in between would delete the directory out from under the pending
 * write and fail a live tool call with ENOENT. A directory created seconds
 * ago is never old enough to be swept. The cost is that a directory
 * emptied by this very pass survives until its own mtime ages out, which
 * is an empty directory nobody sees.
 */
async function cleanSessionDir(
  cacheDir: string,
  name: string,
  ttlMs: number,
  now: number,
  removed: string[]
): Promise<void> {
  const dirPath = join(cacheDir, name);

  let lastTouchedMs: number;
  try {
    lastTouchedMs = (await stat(dirPath)).mtimeMs;
  } catch {
    return;
  }

  let children: string[];
  try {
    children = await readdir(dirPath);
  } catch {
    return;
  }

  for (const child of children) {
    await expireFile(join(dirPath, child), join(name, child), ttlMs, now, removed);
  }

  try {
    const left = await readdir(dirPath);
    if (left.length === 0 && now - lastTouchedMs > ttlMs) {
      await rmdir(dirPath);
    }
  } catch {
    // Something was written into it again, or it is already gone. Both are
    // fine: the next sweep looks again.
  }
}

/**
 * Deletes every cached screenshot whose mtime is older than `ttlMs`,
 * descending exactly one level into the per-session subdirectories
 * `sessionCacheDir` hands out, and returns what it removed. A nested name
 * carries its session ("<sessionId>/<file>.png") so whoever reads the sweep
 * log can tell whose evidence just expired. A missing cache directory is
 * not an error, it is the normal state before anything has ever been
 * cached.
 *
 * One level, not arbitrary recursion, because that is the entire layout:
 * the cache is `<cacheDir>/<sessionId>/<uuid>.png` and nothing writes
 * deeper. An unbounded recursive delete rooted at a configurable directory
 * is a much sharper tool than this job needs.
 *
 * Called from the daemon's single sweep timer (`sweep.ts`), not a second
 * scheduled job. See §4.2 of the design spec for why one in-process timer
 * handles idle-session reaping, client-registry pruning, and this.
 */
export async function cleanScreenshotCache(dir: string, ttlMs: number): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const now = Date.now();
  const removed: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      await cleanSessionDir(dir, entry.name, ttlMs, now, removed);
    } else {
      // Screenshots written before the per-session layout existed still sit
      // at the top level, and still deserve to expire.
      await expireFile(join(dir, entry.name), entry.name, ttlMs, now, removed);
    }
  }
  return removed;
}
