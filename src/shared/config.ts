import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * All tunables for the daemon and the client wrapper, in one place.
 *
 * Every value has a documented default and can be overridden with an
 * environment variable, but code should almost always go through
 * `loadConfig()` (which reads `process.env` once) rather than reading
 * `process.env` scattered across the codebase. That keeps tests able to
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
  /**
   * The idle timeout an *escalated* session gets instead, once
   * `escalate_session` has handed it to a human.
   *
   * A human driving a session over CDP calls no tools, so nothing refreshes
   * its `lastActivity` for as long as they work: the very scenario
   * escalation exists for is the one that used to get the session reaped
   * out from under them. An hour, against fifteen minutes ordinarily,
   * because a CAPTCHA or an ambiguous form plausibly takes far longer than
   * fifteen minutes of a person's attention. It is a longer rope and not an
   * exemption, so an escalation nobody comes back to still gives its
   * browser context back eventually.
   */
  escalatedIdleTimeoutMs: number;
  /**
   * How long one running tool call may keep vetoing the reaper before the
   * reaper stops believing it.
   *
   * A call in flight suspends idle reaping for its session, which is what
   * stops a slow navigate from having its own context closed halfway
   * through. Without a bound, though, a call that never returns
   * (`evaluate("new Promise(() => {})")` is enough) pins its session
   * forever, and because a live session also vetoes the daemon's
   * self-shutdown, it pins this machine-wide shared daemon along with it.
   *
   * Ten minutes. Every bounded Playwright operation is an order of
   * magnitude under that (30s is the longest built-in default), and the MCP
   * client gives up on a request long before it too, so a call still
   * running at ten minutes is one nobody is waiting for. It also sits below
   * the ordinary fifteen-minute idle timeout, so a wedged session can never
   * outlive a merely idle one.
   */
  maxInFlightAgeMs: number;
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
  /** Directory `screenshot`'s `mode: 'cached'` writes PNGs to. `~/.harborage/screenshots` by default. */
  screenshotCacheDir: string;
  /**
   * A cached screenshot older than this (by file mtime) gets deleted by the
   * same sweep that already reaps idle sessions and prunes the client
   * registry (see §4.2 of the design spec for why this rides the one
   * existing timer instead of a second scheduled job).
   *
   * Four hours, raised from the original thirty minutes. Thirty was set
   * with a single agent taking a screenshot and looking at it in mind. In a
   * real parallel QA run the evidence has to outlive the whole fan-out plus
   * however long it takes a person to read the reports, and half an hour
   * did not: agents had screenshots expire before anyone opened them, and
   * one had to copy its PNGs out by hand. The cost of the longer window is
   * a few more megabytes sitting in a temp directory.
   */
  screenshotCacheTtlMs: number;
  /** Max buffered `console` messages kept per session tab (oldest dropped first). */
  consoleBufferSize: number;
  /** Max buffered network request/response entries kept per session tab (oldest dropped first). */
  networkBufferSize: number;
  /** Max buffered JavaScript dialogs (alert/confirm/prompt) kept per session (oldest dropped first). */
  dialogBufferSize: number;
  /** Max buffered uncaught exceptions and unhandled rejections kept per session (oldest dropped first). */
  pageErrorBufferSize: number;
  /** Max time the client wrapper's first tool call will wait for the daemon to become healthy. */
  daemonReadyTimeoutMs: number;
  /** Poll interval while waiting for the daemon to become healthy. */
  daemonHealthPollMs: number;
  /**
   * Test-only: artificially delays the daemon's startup by this many ms
   * before it opens its HTTP listener, simulating a slow cold start (e.g. a
   * first-time dependency fetch). Used to prove the client wrapper's MCP
   * handshake never waits on daemon readiness. Zero in every real deployment.
   */
  testStartupDelayMs: number;
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
    escalatedIdleTimeoutMs: num('HARBORAGE_ESCALATED_IDLE_TIMEOUT_MS', 60 * 60 * 1000),
    maxInFlightAgeMs: num('HARBORAGE_MAX_IN_FLIGHT_AGE_MS', 10 * 60 * 1000),
    sweepIntervalMs: num('HARBORAGE_SWEEP_INTERVAL_MS', 60 * 1000),
    shutdownGraceMs: num('HARBORAGE_SHUTDOWN_GRACE_MS', 10 * 1000),
    stateDir,
    registryPath: str('HARBORAGE_REGISTRY_PATH', join(stateDir, 'registry.json')),
    daemonLogPath: str('HARBORAGE_DAEMON_LOG_PATH', join(stateDir, 'daemon.log')),
    screenshotCacheDir: str('HARBORAGE_SCREENSHOT_CACHE_DIR', join(stateDir, 'screenshots')),
    screenshotCacheTtlMs: num('HARBORAGE_SCREENSHOT_CACHE_TTL_MS', 4 * 60 * 60 * 1000),
    consoleBufferSize: num('HARBORAGE_CONSOLE_BUFFER_SIZE', 200),
    networkBufferSize: num('HARBORAGE_NETWORK_BUFFER_SIZE', 200),
    dialogBufferSize: num('HARBORAGE_DIALOG_BUFFER_SIZE', 200),
    pageErrorBufferSize: num('HARBORAGE_PAGE_ERROR_BUFFER_SIZE', 200),
    daemonReadyTimeoutMs: num('HARBORAGE_DAEMON_READY_TIMEOUT_MS', 60 * 1000),
    daemonHealthPollMs: num('HARBORAGE_DAEMON_HEALTH_POLL_MS', 200),
    testStartupDelayMs: num('HARBORAGE_TEST_STARTUP_DELAY_MS', 0)
  };
}
