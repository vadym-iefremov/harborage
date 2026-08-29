import { readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Deletes every file in `dir` whose mtime is older than `ttlMs`. Returns the
 * filenames it removed. Missing directory is not an error (nothing has ever
 * been cached yet) — returns an empty list instead.
 *
 * Called from the daemon's single sweep timer (`sweep.ts`), not a second
 * scheduled job — see §4.2 of the design spec for why one in-process timer
 * handles idle-session reaping, client-registry pruning, and this.
 */
export async function cleanScreenshotCache(dir: string, ttlMs: number): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const now = Date.now();
  const removed: string[] = [];
  for (const name of entries) {
    const filePath = join(dir, name);
    try {
      const info = await stat(filePath);
      if (now - info.mtimeMs > ttlMs) {
        await unlink(filePath);
        removed.push(name);
      }
    } catch {
      // Already gone, or a permissions/race hiccup — nothing more to do this pass.
    }
  }
  return removed;
}
