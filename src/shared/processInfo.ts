import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Returns the OS-reported start time of a live process, as an opaque string
 * (`ps -o lstart=`'s output, verbatim). Returns `null` if the process does
 * not exist (or `ps` can't be run at all).
 *
 * This is the PID-reuse guard's primitive: two different processes can
 * share a PID over time, but their `lstart` values differ, so "same PID,
 * same lstart" is what actually proves "still the same process I recorded",
 * not just "some process with this number exists right now".
 */
export async function getProcessStartTime(pid: number): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'lstart=']);
    const trimmed = stdout.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    // Non-zero exit (no such PID) or `ps` unavailable. Either way, treat as "not alive".
    return null;
  }
}

/** Convenience wrapper for the common case of just checking liveness. */
export async function isProcessAlive(pid: number): Promise<boolean> {
  return (await getProcessStartTime(pid)) !== null;
}

/** The whole process table as pid/parent pairs, or an empty list if `ps` cannot be run. */
async function processTable(): Promise<{ pid: number; ppid: number }[]> {
  try {
    const { stdout } = await execFileAsync('ps', ['-eo', 'pid=,ppid=']);
    const rows: { pid: number; ppid: number }[] = [];
    for (const line of stdout.split('\n')) {
      const [pid, ppid] = line.trim().split(/\s+/);
      const parsedPid = Number(pid);
      const parsedPpid = Number(ppid);
      if (Number.isInteger(parsedPid) && Number.isInteger(parsedPpid)) rows.push({ pid: parsedPid, ppid: parsedPpid });
    }
    return rows;
  } catch {
    return [];
  }
}

/** The PIDs whose parent is `ppid` at this moment. */
export async function listChildPids(ppid: number): Promise<number[]> {
  return (await processTable()).filter(row => row.ppid === ppid).map(row => row.pid);
}

/**
 * Every live descendant of `pid`, breadth-first, not including `pid` itself.
 *
 * Descent from a PID harborage already knows to be its own is one of only two
 * things this codebase accepts as proof that a process belongs to it. The
 * other is a PID it wrote into its own ledger. It is emphatically not a name
 * or a command-line match: a Chromium whose command line looks like ours is
 * far more likely to be the developer's own Playwright run than anything of
 * harborage's, and killing it because it matched a pattern would be a worse
 * outcome than any leak this code exists to clean up.
 *
 * Reads the table once and walks it in memory, so the answer is one consistent
 * snapshot rather than a tree assembled from several `ps` calls taken at
 * different moments with processes appearing and disappearing in between.
 */
export async function listDescendantPids(pid: number): Promise<number[]> {
  const table = await processTable();
  const childrenOf = new Map<number, number[]>();
  for (const row of table) {
    const siblings = childrenOf.get(row.ppid);
    if (siblings) siblings.push(row.pid);
    else childrenOf.set(row.ppid, [row.pid]);
  }

  const found: number[] = [];
  const seen = new Set<number>([pid]);
  let frontier = [pid];
  while (frontier.length > 0) {
    const next: number[] = [];
    for (const parent of frontier) {
      for (const child of childrenOf.get(parent) ?? []) {
        // Guards against a cycle in a malformed table, which would otherwise
        // spin here forever inside a cleanup path.
        if (seen.has(child)) continue;
        seen.add(child);
        found.push(child);
        next.push(child);
      }
    }
    frontier = next;
  }
  return found;
}
