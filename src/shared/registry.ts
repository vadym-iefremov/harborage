import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { getProcessStartTime } from './processInfo.js';

/** One client wrapper process that has registered as a potential user of the daemon. */
export interface RegistryEntry {
  pid: number;
  /** The `ps -o lstart=` value for `pid` at the moment it registered. This is the PID-reuse guard. */
  startedAt: string;
}

/**
 * Reads the registry file. A missing file is an empty registry (the normal
 * state before any client has ever registered), not an error.
 */
export async function readRegistry(path: string): Promise<RegistryEntry[]> {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is RegistryEntry =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as RegistryEntry).pid === 'number' &&
        typeof (entry as RegistryEntry).startedAt === 'string'
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

/** Writes the registry file atomically (write to a temp file, then rename over it). */
export async function writeRegistry(path: string, entries: RegistryEntry[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmpPath, JSON.stringify(entries, null, 2), 'utf8');
  await rename(tmpPath, path);
}

/**
 * Adds (or refreshes) this process's own entry in the registry. Idempotent:
 * calling it twice for the same still-alive PID just rewrites the same entry.
 */
export async function registerSelf(path: string, pid: number, startedAt: string): Promise<void> {
  const entries = await readRegistry(path);
  const withoutSelf = entries.filter(e => e.pid !== pid);
  withoutSelf.push({ pid, startedAt });
  await writeRegistry(path, withoutSelf);
}

/** Best-effort removal of one PID from the registry (used on graceful client exit). */
export async function deregisterSelf(path: string, pid: number): Promise<void> {
  const entries = await readRegistry(path);
  const filtered = entries.filter(e => e.pid !== pid);
  if (filtered.length !== entries.length) {
    await writeRegistry(path, filtered);
  }
}

export interface PruneResult {
  kept: RegistryEntry[];
  dropped: RegistryEntry[];
}

/**
 * Drops any entry whose process is no longer alive, or whose live `lstart`
 * no longer matches what was recorded (a different process has since reused
 * that PID). Does not write anything itself: callers decide when to persist.
 */
export async function pruneDead(entries: RegistryEntry[]): Promise<PruneResult> {
  const kept: RegistryEntry[] = [];
  const dropped: RegistryEntry[] = [];
  for (const entry of entries) {
    const liveStartedAt = await getProcessStartTime(entry.pid);
    if (liveStartedAt !== null && liveStartedAt === entry.startedAt) {
      kept.push(entry);
    } else {
      dropped.push(entry);
    }
  }
  return { kept, dropped };
}

/** Identity of one registration: a PID alone is not one, since PIDs get reused. */
function keyOf(entry: RegistryEntry): string {
  return `${entry.pid} ${entry.startedAt}`;
}

/**
 * Prunes the registry FILE: reads it, works out which entries are dead, then
 * writes back the file as it stands at that moment minus exactly the entries
 * proven dead.
 *
 * The re-read is the point. `pruneDead` runs one `ps` per entry, so a busy
 * registry holds the read and the write tens of milliseconds apart, and a
 * client wrapper registering itself in that window used to be erased by the
 * sweep's write: the wrapper believed it was registered, the daemon saw an
 * empty registry, and with no live session to veto it the daemon exited under
 * a client that was about to use it. Re-reading immediately before the write
 * removes that window, and subtracting by pid+startedAt rather than by pid
 * alone means a fresh process that reused a dead PID is not dropped with it.
 *
 * What this is NOT: a lock. Two processes writing at the same instant can
 * still lose one update, but the window is now the microseconds between the
 * re-read and an atomic rename, rather than the whole `ps` sweep. A real file
 * lock would be the next step if that ever proves to matter.
 */
export async function pruneRegistryFile(path: string): Promise<PruneResult> {
  const entries = await readRegistry(path);
  const { kept, dropped } = await pruneDead(entries);
  if (dropped.length === 0) return { kept, dropped };

  const deadKeys = new Set(dropped.map(keyOf));
  const fresh = await readRegistry(path);
  const survivors = fresh.filter(entry => !deadKeys.has(keyOf(entry)));
  await writeRegistry(path, survivors);
  return { kept: survivors, dropped };
}
