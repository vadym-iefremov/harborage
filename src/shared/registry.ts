import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { probeProcess } from './processInfo.js';

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

/** One registry entry whose liveness could not be established, and why. */
export interface UnresolvedEntry {
  entry: RegistryEntry;
  /** The errno the probe failed with (`EAGAIN`, `ENOENT`, ...) or the signal that killed it. */
  reason: string;
}

export interface PruneResult {
  /**
   * Entries that stay in the registry: those proven still alive, plus any
   * whose liveness could not be established (see `unresolved`). Both count as
   * clients, because the shutdown gate reads this and an unproven client must
   * not be treated as an absent one.
   */
  kept: RegistryEntry[];
  /** Entries proven gone, or proven to be a different process reusing the PID. */
  dropped: RegistryEntry[];
  /**
   * The entries in `kept` that are there because nothing could be
   * established about them, not because they were proven alive, each with
   * the reason the probe failed. Surfaced separately, and with the reason,
   * so the sweep can say out loud that it is guessing in the client's
   * favour and why: `EAGAIN` repeatedly means a machine too loaded to fork,
   * which is worth knowing before it turns into something else, while
   * `ENOENT` means `ps` is not where this daemon can reach it at all.
   */
  unresolved: UnresolvedEntry[];
}

/**
 * Drops any entry PROVEN dead: one whose process the OS says is gone, or
 * whose live `lstart` no longer matches what was recorded (a different
 * process has since reused that PID). Does not write anything itself:
 * callers decide when to persist.
 *
 * An entry the probe could not resolve is kept, and reported in
 * `unresolved`. That asymmetry is deliberate and is the whole point of the
 * three-state probe. `ps` failing to run is not evidence about the process,
 * and the two mistakes available here are not symmetric: keeping a dead
 * entry costs one more sweep before the daemon exits, while dropping a live
 * one empties the registry, and an empty registry with no live session is
 * the daemon shutting itself down on top of a client that is still using it.
 * Under fork starvation, exactly the condition a heavy parallel fan-out
 * creates, EVERY entry fails to probe at once, so the cheap mistake would
 * have been made for every client simultaneously.
 *
 * The PID-reuse guard is untouched by this: an entry is only ever kept as
 * proven-alive when `ps` answered AND the `lstart` it reported matches the
 * one recorded. A reused PID still answers with a different `lstart` and is
 * still dropped.
 */
export async function pruneDead(entries: RegistryEntry[]): Promise<PruneResult> {
  const kept: RegistryEntry[] = [];
  const dropped: RegistryEntry[] = [];
  const unresolved: UnresolvedEntry[] = [];
  for (const entry of entries) {
    const probe = await probeProcess(entry.pid);
    if (probe.state === 'unknown') {
      kept.push(entry);
      unresolved.push({ entry, reason: probe.reason });
    } else if (probe.state === 'alive' && probe.startedAt === entry.startedAt) {
      kept.push(entry);
    } else {
      // Either the OS says the PID is gone, or it is alive but started at a
      // different time, which makes it a different process wearing the same
      // number.
      dropped.push(entry);
    }
  }
  return { kept, dropped, unresolved };
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
  const { kept, dropped, unresolved } = await pruneDead(entries);
  if (dropped.length === 0) return { kept, dropped, unresolved };

  const deadKeys = new Set(dropped.map(keyOf));
  const fresh = await readRegistry(path);
  const survivors = fresh.filter(entry => !deadKeys.has(keyOf(entry)));
  await writeRegistry(path, survivors);
  return { kept: survivors, dropped, unresolved };
}
