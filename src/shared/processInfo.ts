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
    // Non-zero exit (no such PID) or `ps` unavailable — either way, treat as "not alive".
    return null;
  }
}

/** Convenience wrapper for the common case of just checking liveness. */
export async function isProcessAlive(pid: number): Promise<boolean> {
  return (await getProcessStartTime(pid)) !== null;
}
