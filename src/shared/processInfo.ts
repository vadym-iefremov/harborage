import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * What one `ps` probe actually established about a PID.
 *
 * Three states rather than two, because "this process is gone" and "I could
 * not find out" are different facts with opposite safe defaults, and
 * collapsing them into one `null` is what let a busy machine look like a dead
 * client. See `probeProcess` for what separates them.
 */
export type ProcessProbe =
  /** `ps` answered and the process exists. `startedAt` is its `lstart`, the PID-reuse guard's evidence. */
  | { state: 'alive'; startedAt: string }
  /** `ps` ran, and reported no such process. This is a real answer: the PID is gone. */
  | { state: 'gone' }
  /** `ps` could not be run or did not answer. Nothing was established either way. */
  | { state: 'unknown'; reason: string };

/**
 * Asks the OS what it knows about one PID, and says which of the three
 * possible answers it got.
 *
 * The distinction that matters is between `ps` exiting non-zero, which is
 * `ps` telling us the process does not exist, and `ps` never running at all,
 * which tells us nothing. Node reports these differently and the difference
 * is verifiable: a non-zero exit rejects with a NUMERIC `code` (the exit
 * status), while a failure to spawn rejects with a STRING errno code
 * (`ENOENT`, `EACCES`, `EAGAIN`, `EMFILE`) and a `syscall` of `spawn ps`.
 * Confirmed against Node 22 rather than assumed.
 *
 * `EAGAIN` is the one that motivated this. Under fork starvation, which is
 * exactly the condition a machine reaches during a heavy parallel fan-out,
 * the fork for `ps` fails and every live client looks dead to whoever asked.
 * Treating that as proof of death is how a fully-occupied daemon talks itself
 * into shutting down. See `pruneDead`.
 */
export async function probeProcess(pid: number): Promise<ProcessProbe> {
  try {
    const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'lstart=']);
    const trimmed = stdout.trim();
    // `ps` succeeded but printed nothing. Not a shape it produces in
    // practice, and not one to guess about either way.
    if (trimmed.length === 0) return { state: 'unknown', reason: 'ps produced no output' };
    return { state: 'alive', startedAt: trimmed };
  } catch (err) {
    const failure = err as NodeJS.ErrnoException & { signal?: string | null };
    // A numeric code is an exit status, which means `ps` ran and answered.
    // The only way it exits non-zero for a well-formed query is that the
    // process is not there.
    if (typeof failure.code === 'number') return { state: 'gone' };
    // Anything else means the question never reached the OS: `ps` could not
    // be spawned (a string errno) or was killed before it answered.
    const reason = typeof failure.code === 'string' ? failure.code : (failure.signal ?? 'unknown failure');
    return { state: 'unknown', reason: String(reason) };
  }
}

/**
 * Returns the OS-reported start time of a live process, as an opaque string
 * (`ps -o lstart=`'s output, verbatim). Returns `null` if the process does
 * not exist, or if `ps` could not be run at all.
 *
 * This is the PID-reuse guard's primitive: two different processes can
 * share a PID over time, but their `lstart` values differ, so "same PID,
 * same lstart" is what actually proves "still the same process I recorded",
 * not just "some process with this number exists right now".
 *
 * Callers that must not mistake "could not ask" for "not there" want
 * `probeProcess` instead; this collapses both to `null` and is kept for the
 * callers that only ever ask about a process they can see is running.
 */
export async function getProcessStartTime(pid: number): Promise<string | null> {
  const probe = await probeProcess(pid);
  return probe.state === 'alive' ? probe.startedAt : null;
}

/** Convenience wrapper for the common case of just checking liveness. */
export async function isProcessAlive(pid: number): Promise<boolean> {
  return (await getProcessStartTime(pid)) !== null;
}
