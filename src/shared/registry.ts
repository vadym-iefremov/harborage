import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { getProcessStartTime } from './processInfo.js';

/** One client wrapper process that has registered as a potential user of the daemon. */
export interface RegistryEntry {
  pid: number;
  /** The `ps -o lstart=` value for `pid` at the moment it registered — the PID-reuse guard. */
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
 * that PID). Does not write anything itself — callers decide when to persist.
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
