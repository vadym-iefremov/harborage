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
  /** Called (and awaited) once, the moment the registry is confirmed empty past the grace period. */
  onEmptyRegistryShutdown: () => Promise<void>;
}

export interface SweepOutcome {
  reapedSessions: string[];
  prunedClients: RegistryEntry[];
  remainingClients: number;
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
 */
export async function runSweepOnce(deps: SweepDeps): Promise<SweepOutcome> {
  const reapedSessions = await deps.sessions.reapIdle(deps.idleTimeoutMs);

  const removedScreenshots = await cleanScreenshotCache(deps.screenshotCacheDir, deps.screenshotCacheTtlMs);

  const entries = await readRegistry(deps.registryPath);
  const { kept, dropped } = await pruneDead(entries);
  if (dropped.length > 0) {
    await writeRegistry(deps.registryPath, kept);
  }

  let triggeredShutdown = false;
  const uptime = Date.now() - deps.daemonStartedAt;
  if (kept.length === 0 && uptime >= deps.shutdownGraceMs) {
    triggeredShutdown = true;
    await deps.onEmptyRegistryShutdown();
  }

  return { reapedSessions, prunedClients: dropped, remainingClients: kept.length, removedScreenshots, triggeredShutdown };
}

export interface SweepHandle {
  stop: () => void;
}

/** Runs `runSweepOnce` on a fixed interval until `stop()` is called. */
export function startSweepLoop(deps: SweepDeps, intervalMs: number): SweepHandle {
  const timer = setInterval(() => {
    void runSweepOnce(deps).catch(err => {
      console.error('[harborage] sweep pass failed:', err);
    });
  }, intervalMs);
  return { stop: () => clearInterval(timer) };
}
