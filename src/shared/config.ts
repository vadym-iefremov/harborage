import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * All tunables for the daemon and the client wrapper, in one place.
 *
 * Every value has a documented default and can be overridden with an
 * environment variable, but code should almost always go through
 * `loadConfig()` (which reads `process.env` once) rather than reading
 * `process.env` scattered across the codebase — that keeps tests able to
 * build a fully isolated `Config` object without mutating global env state.
 */
export interface Config {
  /** Loopback host the daemon's HTTP server binds to. Never expose beyond localhost. */
  host: string;
  /** Port the daemon's MCP-over-Streamable-HTTP endpoint listens on. */
  port: number;
  /**
   * Port Chromium's `--remote-debugging-port` opens on, for the
   * escalate_session human-takeover flow. Fixed at browser-launch time;
   * Chromium cannot enable this after the process has started, so it is
   * always passed at launch (see docs/superpowers/specs).
   */
  debugPort: number;
  /** A browser context (session) idle longer than this gets reaped. */
  idleTimeoutMs: number;
  /** How often the daemon's single in-process timer sweeps sessions + registry. */
  sweepIntervalMs: number;
  /**
   * Minimum daemon uptime before an empty client registry is allowed to
   * trigger self-shutdown. Guards against a race where the very first sweep
   * fires before the client that just spawned the daemon has registered.
   */
  shutdownGraceMs: number;
  /** Directory holding the registry file and daemon log. `~/.harborage` by default. */
  stateDir: string;
  /** Path to the shared client registry file. */
  registryPath: string;
  /** Path the detached daemon's stdout/stderr get redirected to. */
  daemonLogPath: string;
  /** Max time the client wrapper's first tool call will wait for the daemon to become healthy. */
  daemonReadyTimeoutMs: number;
  /** Poll interval while waiting for the daemon to become healthy. */
  daemonHealthPollMs: number;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid value for ${name}: ${raw} is not a number`);
  }
  return parsed;
}

function str(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? fallback : raw;
}

/**
 * Builds a `Config` from environment variables, applying documented
 * defaults for anything unset. Called once at process startup in both the
 * daemon and the client wrapper; tests construct their own `Config` objects
 * directly instead of mutating `process.env`.
 */
export function loadConfig(): Config {
  const stateDir = str('HARBORAGE_STATE_DIR', join(homedir(), '.harborage'));
  return {
    host: str('HARBORAGE_HOST', '127.0.0.1'),
    port: num('HARBORAGE_PORT', 4599),
    debugPort: num('HARBORAGE_DEBUG_PORT', 4600),
    idleTimeoutMs: num('HARBORAGE_IDLE_TIMEOUT_MS', 15 * 60 * 1000),
    sweepIntervalMs: num('HARBORAGE_SWEEP_INTERVAL_MS', 60 * 1000),
    shutdownGraceMs: num('HARBORAGE_SHUTDOWN_GRACE_MS', 10 * 1000),
    stateDir,
    registryPath: str('HARBORAGE_REGISTRY_PATH', join(stateDir, 'registry.json')),
    daemonLogPath: str('HARBORAGE_DAEMON_LOG_PATH', join(stateDir, 'daemon.log')),
    daemonReadyTimeoutMs: num('HARBORAGE_DAEMON_READY_TIMEOUT_MS', 60 * 1000),
    daemonHealthPollMs: num('HARBORAGE_DAEMON_HEALTH_POLL_MS', 200)
  };
}
