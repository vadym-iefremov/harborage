import { errorFields, type Logger } from '../shared/logger.js';
import { getProcessStartTime } from '../shared/processInfo.js';
import { pruneRegistryFile, type RegistryEntry } from '../shared/registry.js';
import { cleanScreenshotCache } from './screenshotCache.js';
import type { SessionStore } from './sessions.js';

/**
 * A process whose death should take the daemon down with it, identified by
 * PID and by the `ps -o lstart=` value that PID had when the daemon started.
 *
 * Both halves are required, for the reason the client registry documents at
 * length: a PID is not an identity. Watching a bare PID would mean that once
 * the owner died and the OS handed its number out again, the daemon would see
 * a live process there and conclude its owner had come back, staying up
 * forever. That is exactly the failure the watch exists to prevent.
 */
export interface DaemonOwner {
  pid: number;
  startedAt: string;
}

export interface SweepDeps {
  sessions: SessionStore;
  registryPath: string;
  idleTimeoutMs: number;
  /** Minimum daemon uptime before an empty registry is allowed to trigger shutdown. */
  shutdownGraceMs: number;
  daemonStartedAt: number;
  /** Directory `screenshot`'s `mode: 'cached'` writes PNGs to. */
  screenshotCacheDir: string;
  /** A cached screenshot file older than this (by mtime) gets deleted. */
  screenshotCacheTtlMs: number;
  /**
   * Called (and awaited) once, the moment the registry is confirmed empty
   * past the grace period AND no browser sessions are left to lose.
   */
  onEmptyRegistryShutdown: () => Promise<void>;
  /**
   * The process this daemon belongs to, if any. Absent (the production
   * default) means the daemon's lifetime is nobody's but its own and this
   * whole check is skipped. See `ownerPid` in `src/shared/config.ts`.
   */
  owner?: DaemonOwner | null;
  /**
   * Called (and awaited) once, the moment `owner` is proven gone. Optional
   * only so that a caller passing no `owner` does not have to invent one.
   */
  onOwnerGoneShutdown?: () => Promise<void>;
  /** Where this pass records what it did. Required: an unobservable sweep is what made finding 1 invisible. */
  logger: Logger;
}

export interface SweepOutcome {
  reapedSessions: string[];
  prunedClients: RegistryEntry[];
  remainingClients: number;
  /**
   * How many of `remainingClients` are counted only because their liveness
   * could not be established. Zero on any healthy machine.
   */
  unresolvedClients: number;
  /**
   * Sessions still live at the moment the shutdown gate was evaluated, after
   * this pass's own reaping, plus any `create_session` still in progress.
   */
  liveSessions: number;
  removedScreenshots: string[];
  triggeredShutdown: boolean;
  /**
   * Which gate ended the daemon, when one did. `owner-gone` short-circuits
   * the pass, so its outcome carries no reaping or pruning results.
   */
  shutdownReason?: 'registry-empty' | 'owner-gone';
}

/**
 * One pass of the daemon's single periodic job: reap idle browser sessions,
 * prune the client registry (self-shutting-down if it's now empty), and
 * delete cached screenshots past their TTL.
 *
 * All three jobs share one timer (see docs/superpowers/specs for why a
 * second, externally-scheduled process was rejected in favor of this): the
 * daemon is already a long-lived process once started, so an in-process
 * `setInterval` is strictly simpler than coordinating a second scheduled
 * script against the same state, with no correctness gap versus that
 * alternative.
 *
 * The shutdown gate deliberately reads TWO counts, not one. An empty client
 * registry alone used to be enough to exit, which meant that during a
 * parallel fan-out, the moment every client wrapper had exited or been
 * pruned as dead, the daemon took the shared Chromium down with it and
 * killed every session that was still mid-work. Client wrappers and browser
 * sessions have genuinely independent lifetimes: a wrapper can be SIGKILLed
 * while the work it started is still running. So a live session vetoes the
 * shutdown, and the daemon still terminates on its own afterwards, because
 * those orphaned sessions go idle and get reaped by this same pass, which
 * then finds both counts at zero.
 *
 * Ordering inside one pass matters and is not incidental: `reapIdle` runs
 * first so a session this pass just closed cannot veto the shutdown it
 * should not be blocking, and the live count is read immediately before the
 * gate, with no `await` in between, so nothing can slip in between counting
 * and deciding.
 *
 * Failure containment matters for the same reason. The screenshot-cache
 * clean is the one job here whose input is a directory an operator can point
 * anywhere, and it used to be able to throw the whole pass away with it:
 * a bad HARBORAGE_SCREENSHOT_CACHE_DIR raises ENOTDIR, the pass aborts before
 * the registry prune and before the gate, and the result is a daemon that can
 * never decide to exit again and a registry that grows forever, all because a
 * PNG could not be deleted. It is caught and logged instead.
 */
export async function runSweepOnce(deps: SweepDeps): Promise<SweepOutcome> {
  // First, and short-circuiting, because it is the one condition under which
  // none of the rest of the pass has a point. If the process this daemon
  // belongs to is gone, there is nobody left to reap sessions on behalf of,
  // and a live session must NOT veto this shutdown the way it rightly vetoes
  // the registry-empty one. That distinction is the whole reason the check is
  // here rather than folded into the gate below: a live session means work
  // somebody is still waiting for, and when the owner is dead nobody is.
  // Skipping it left a stranded test daemon sitting on a Chromium for the full
  // fifteen-minute idle timeout.
  if (deps.owner) {
    const liveStartedAt = await getProcessStartTime(deps.owner.pid);
    if (liveStartedAt === null || liveStartedAt !== deps.owner.startedAt) {
      deps.logger.log('sweep.shutdown', {
        reason: 'owner-gone',
        ownerPid: deps.owner.pid,
        // Says which of the two ways the owner can be gone actually happened,
        // because they mean different things to whoever reads this line: the
        // process exited, or its PID now belongs to something else entirely.
        detail: liveStartedAt === null ? 'process-exited' : 'pid-reused',
        sessions: deps.sessions.liveOrPendingCount()
      });
      await deps.onOwnerGoneShutdown?.();
      return {
        reapedSessions: [],
        prunedClients: [],
        remainingClients: 0,
        // Zero because this path short-circuits BEFORE the registry is read,
        // so no client's liveness was checked, let alone left unresolved. It
        // is the honest value here rather than a placeholder: an unresolved
        // count above zero would claim a check that never ran.
        unresolvedClients: 0,
        liveSessions: 0,
        removedScreenshots: [],
        triggeredShutdown: true,
        shutdownReason: 'owner-gone'
      };
    }
  }

  const reapedSessions = await deps.sessions.reapIdle(deps.idleTimeoutMs);

  // Contained on purpose. This is the least important of the three jobs and
  // the only one whose input is a directory an operator can point anywhere:
  // one bad HARBORAGE_SCREENSHOT_CACHE_DIR raises ENOTDIR here, and letting
  // that abort the pass would mean the registry is never pruned and the
  // shutdown gate never evaluated, i.e. a daemon that can no longer ever exit
  // and a registry that grows forever, for a failure to delete a PNG.
  let removedScreenshots: string[] = [];
  try {
    removedScreenshots = await cleanScreenshotCache(deps.screenshotCacheDir, deps.screenshotCacheTtlMs);
  } catch (err) {
    deps.logger.log('sweep.screenshot-cache-error', {
      dir: deps.screenshotCacheDir,
      ...errorFields(err)
    });
  }

  const { kept, dropped, unresolved } = await pruneRegistryFile(deps.registryPath);

  // Said out loud, because it is the daemon deciding in a client's favour on
  // no evidence, and because the condition that causes it is worth catching
  // early. `ps` failing to run is almost always fork starvation (`EAGAIN`) on
  // a machine already at its process limit, which is the same overload that
  // makes everything else here flaky. Keeping these clients is the safe
  // choice, not a confident one.
  if (unresolved.length > 0) {
    deps.logger.log('sweep.client-unresolved', {
      clients: unresolved.length,
      pids: unresolved.map(u => u.entry.pid).join(','),
      reasons: [...new Set(unresolved.map(u => u.reason))].join(','),
      action: 'kept'
    });
  }

  // Only a pass that actually changed something gets a line. A sweep that
  // found nothing to do runs every minute forever, and logging those is how
  // the old log became unreadable. Individual reaped sessions are logged by
  // the SessionStore itself; this is the per-pass summary.
  if (reapedSessions.length > 0 || dropped.length > 0 || removedScreenshots.length > 0) {
    deps.logger.log('sweep.cleaned', {
      reapedSessions: reapedSessions.length,
      prunedClients: dropped.length,
      prunedPids: dropped.length > 0 ? dropped.map(e => e.pid).join(',') : undefined,
      removedScreenshots: removedScreenshots.length,
      clients: kept.length
    });
  }

  // Read last, and read synchronously: between this line and the decision
  // below nothing else can run, so the count the gate acts on is the count
  // that was true at the moment it acted. `liveOrPendingCount` rather than
  // `count`, because a create_session that has not returned a sessionId yet
  // has no record to count, and exiting on top of one destroys a half-built
  // context and, on a cold daemon, a Chromium still launching.
  const liveSessions = deps.sessions.liveOrPendingCount();
  const uptime = Date.now() - deps.daemonStartedAt;

  // Only an empty registry can shut the daemon down, so that is also the
  // only case whose decision is worth a line. A sweep that found live
  // clients is the ordinary once-a-minute outcome forever, and logging it
  // would bury everything else.
  let triggeredShutdown = false;
  if (kept.length === 0) {
    if (liveSessions > 0) {
      deps.logger.log('sweep.shutdown-declined', { reason: 'live-sessions', clients: 0, sessions: liveSessions });
    } else if (uptime < deps.shutdownGraceMs) {
      deps.logger.log('sweep.shutdown-declined', { reason: 'grace-period', clients: 0, sessions: 0, uptimeMs: uptime });
    } else {
      deps.logger.log('sweep.shutdown', { reason: 'registry-empty', clients: 0, sessions: 0, uptimeMs: uptime });
      triggeredShutdown = true;
      await deps.onEmptyRegistryShutdown();
    }
  }

  return {
    reapedSessions,
    prunedClients: dropped,
    remainingClients: kept.length,
    unresolvedClients: unresolved.length,
    liveSessions,
    removedScreenshots,
    triggeredShutdown,
    ...(triggeredShutdown ? { shutdownReason: 'registry-empty' as const } : {})
  };
}

export interface SweepHandle {
  stop: () => void;
}

/** Runs `runSweepOnce` on a fixed interval until `stop()` is called. */
export function startSweepLoop(deps: SweepDeps, intervalMs: number): SweepHandle {
  const timer = setInterval(() => {
    void runSweepOnce(deps).catch(err => {
      // A thrown sweep is exactly the kind of silent breakage that leaves
      // sessions un-reaped and the daemon immortal, so it gets a line of
      // its own rather than a bare console.error with no timestamp.
      deps.logger.log('sweep.error', errorFields(err));
    });
  }, intervalMs);
  return { stop: () => clearInterval(timer) };
}
