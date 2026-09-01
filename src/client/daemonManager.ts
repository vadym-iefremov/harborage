import { spawn } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Config } from '../shared/config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
/** `dist/client/daemonManager.js` -> `dist/daemon/index.js` (mirrors `src/client` -> `src/daemon`). */
const DAEMON_ENTRY = join(__dirname, '..', 'daemon', 'index.js');

/** A single health-check attempt against the daemon's `/health` endpoint. Never throws. */
export async function checkHealth(config: Config, timeoutMs = 1500): Promise<boolean> {
  try {
    const response = await fetch(`http://${config.host}:${config.port}/health`, {
      signal: AbortSignal.timeout(timeoutMs)
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Spawns the daemon as a detached background process, its own stdio
 * redirected to the daemon log file.
 *
 * `HARBORAGE_OWNER_PID` is deliberately stripped from the environment handed
 * on. A daemon started this way is the shared, machine-wide one and it must
 * outlive the wrapper that happened to start it: wrappers come and go with
 * each Claude Code session while browser sessions do not, and that
 * independence is the point of the pool. Passing the variable through would
 * tie this daemon's life to whichever wrapper won the race to spawn it, and
 * take every other agent's live session down with that wrapper. See
 * `ownerPid` in `src/shared/config.ts`.
 */
export function spawnDaemon(config: Config): void {
  mkdirSync(config.stateDir, { recursive: true });
  const logFd = openSync(config.daemonLogPath, 'a');
  const { HARBORAGE_OWNER_PID: _ownerPid, ...daemonEnv } = process.env;
  const child = spawn(process.execPath, [DAEMON_ENTRY], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: daemonEnv
  });
  child.unref();
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Polls `/health` until it succeeds or `config.daemonReadyTimeoutMs` elapses. */
export async function waitForHealthy(config: Config): Promise<void> {
  const deadline = Date.now() + config.daemonReadyTimeoutMs;
  while (Date.now() < deadline) {
    if (await checkHealth(config)) return;
    await sleep(config.daemonHealthPollMs);
  }
  throw new Error(
    `Daemon did not become healthy within ${config.daemonReadyTimeoutMs}ms. Check ${config.daemonLogPath} for details.`
  );
}

/**
 * The client wrapper's "ensure-running" step: if the daemon is already
 * healthy, do nothing; otherwise spawn it and wait for it to come up.
 *
 * Callers are responsible for making sure this only ever runs off the MCP
 * `initialize` handshake's critical path. See wrapper.ts.
 */
export async function ensureDaemonRunning(config: Config): Promise<void> {
  if (await checkHealth(config)) return;
  spawnDaemon(config);
  await waitForHealthy(config);
}
