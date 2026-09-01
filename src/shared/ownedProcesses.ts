import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { getProcessStartTime } from './processInfo.js';

/**
 * What kind of OS process one ledger entry describes. Kept as a small closed
 * set rather than free text so a reader of `harborage gc` output, and the
 * reaping order inside it, can both depend on it.
 */
export type OwnedProcessKind = 'daemon' | 'browser';

/**
 * One OS process a harborage daemon started and is prepared to be held
 * accountable for.
 *
 * `startedAt` is the same `ps -o lstart=` string the client registry uses, and
 * it is here for the same reason: a PID on its own is not an identity, because
 * the OS hands the same number out again. Every consumer of this file must
 * check that the live start time still matches before it acts on the PID, and
 * `liveOwnedProcesses` below is the only supported way to do that.
 *
 * `ownerPid` / `ownerStartedAt` are the daemon that created the entry, which
 * is how a browser can still be attributed after its daemon has died and it
 * has reparented to PID 1. For a `daemon` entry they describe the daemon
 * itself.
 */
export interface OwnedProcess {
  kind: OwnedProcessKind;
  pid: number;
  startedAt: string;
  /** The daemon that started this process. Equal to `pid` for a `daemon` entry. */
  ownerPid: number;
  ownerStartedAt: string;
  /** Epoch millis the entry was written, purely so a report can say how old something is. */
  recordedAt: number;
  /** Free text for a human reading the ledger or a `harborage gc` report. */
  note?: string;
}

function isOwnedProcess(value: unknown): value is OwnedProcess {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as OwnedProcess;
  return (
    (entry.kind === 'daemon' || entry.kind === 'browser') &&
    typeof entry.pid === 'number' &&
    typeof entry.startedAt === 'string' &&
    typeof entry.ownerPid === 'number' &&
    typeof entry.ownerStartedAt === 'string' &&
    typeof entry.recordedAt === 'number'
  );
}

/**
 * Reads the ledger. A missing file is an empty ledger (the normal state before
 * any daemon has ever run), not an error, and a corrupt one is treated the
 * same way: this file exists to make cleanup possible, so it must never be
 * able to stop a daemon from starting.
 */
export async function readOwnedProcesses(path: string): Promise<OwnedProcess[]> {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isOwnedProcess);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    return [];
  }
}

/** Writes the ledger atomically (write to a temp file, then rename over it). */
export async function writeOwnedProcesses(path: string, entries: OwnedProcess[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmpPath, JSON.stringify(entries, null, 2), 'utf8');
  await rename(tmpPath, path);
}

/** Identity of one ledger entry. A PID alone is not one, since PIDs get reused. */
function keyOf(entry: OwnedProcess): string {
  return `${entry.kind} ${entry.pid} ${entry.startedAt}`;
}

/**
 * Adds one entry, replacing any earlier entry for the same pid-and-start-time.
 *
 * Re-reads the file immediately before writing, for the same reason
 * `pruneRegistryFile` does: two daemons on two ports share this file, and the
 * read-modify-write below is not a lock. Re-reading shrinks the window in
 * which one daemon's write can erase another's from "however long the `ps`
 * calls took" down to the microseconds before an atomic rename.
 */
export async function recordOwnedProcess(path: string, entry: OwnedProcess): Promise<void> {
  const existing = await readOwnedProcesses(path);
  const key = keyOf(entry);
  await writeOwnedProcesses(path, [...existing.filter(e => keyOf(e) !== key), entry]);
}

/**
 * Removes entries by PID, for a daemon tidying up after itself when it closes
 * a browser or shuts down cleanly.
 *
 * By PID and not by pid-plus-start-time on purpose: this is the "I am done
 * with this process" path, and if the PID has since been reused by something
 * else then the entry is stale either way and should go. Nothing is signalled
 * here, only a JSON file is edited, so there is no PID-reuse hazard to guard
 * against.
 */
export async function forgetOwnedProcesses(path: string, pids: number[]): Promise<void> {
  if (pids.length === 0) return;
  const drop = new Set(pids);
  const existing = await readOwnedProcesses(path);
  const survivors = existing.filter(e => !drop.has(e.pid));
  if (survivors.length !== existing.length) {
    await writeOwnedProcesses(path, survivors);
  }
}

/** A ledger entry paired with what the OS currently says about the PIDs in it. */
export interface OwnedProcessStatus {
  entry: OwnedProcess;
  /** The process named by the entry is alive AND is still the same process that was recorded. */
  alive: boolean;
  /** The daemon that recorded it is alive AND is still the same daemon. */
  ownerAlive: boolean;
}

/**
 * Resolves every ledger entry against the live process table, checking both
 * the process itself and the daemon that recorded it, each by
 * pid-plus-start-time rather than by PID alone.
 *
 * This is the only supported way to read the ledger before acting on it. A
 * caller that reaches for the raw entries and signals a PID from them is one
 * PID recycle away from killing something that has nothing to do with
 * harborage, on a machine where the developer's real work is running.
 */
export async function liveOwnedProcesses(path: string): Promise<OwnedProcessStatus[]> {
  const entries = await readOwnedProcesses(path);
  const startTimes = new Map<number, string | null>();
  const startTimeOf = async (pid: number): Promise<string | null> => {
    if (!startTimes.has(pid)) startTimes.set(pid, await getProcessStartTime(pid));
    return startTimes.get(pid) ?? null;
  };

  const out: OwnedProcessStatus[] = [];
  for (const entry of entries) {
    const live = await startTimeOf(entry.pid);
    const ownerLive = await startTimeOf(entry.ownerPid);
    out.push({
      entry,
      alive: live !== null && live === entry.startedAt,
      ownerAlive: ownerLive !== null && ownerLive === entry.ownerStartedAt
    });
  }
  return out;
}
