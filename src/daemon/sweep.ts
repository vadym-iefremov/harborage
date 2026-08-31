import { errorFields, type Logger } from '../shared/logger.js';
import { pruneDead, readRegistry, writeRegistry, type RegistryEntry } from '../shared/registry.js';
import { cleanScreenshotCache } from './screenshotCache.js';
import type { SessionStore } from './sessions.js';

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
  /** Where this pass records what it did. Required: an unobservable sweep is what made finding 1 invisible. */
  logger: Logger;
}

export interface SweepOutcome {
  reapedSessions: string[];
  prunedClients: RegistryEntry[];
  remainingClients: number;
  /** Sessions still live at the moment the shutdown gate was evaluated, after this pass's own reaping. */
  liveSessions: number;
  removedScreenshots: string[];
  triggeredShutdown: boolean;
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
 */
export async function runSweepOnce(deps: SweepDeps): Promise<SweepOutcome> {
  const reapedSessions = await deps.sessions.reapIdle(deps.idleTimeoutMs);

  const removedScreenshots = await cleanScreenshotCache(deps.screenshotCacheDir, deps.screenshotCacheTtlMs);

  const entries = await readRegistry(deps.registryPath);
  const { kept, dropped } = await pruneDead(entries);
  if (dropped.length > 0) {
    await writeRegistry(deps.registryPath, kept);
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
  // that was true at the moment it acted.
  const liveSessions = deps.sessions.count();
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
    liveSessions,
    removedScreenshots,
    triggeredShutdown
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
