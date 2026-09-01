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
  /**
   * The longest the client wrapper will hold a forwarded call open on the
   * transport before giving up on the daemon ever answering, regardless of
   * the `timeoutMs` a caller passed the tool itself.
   *
   * Every tool that takes a `timeoutMs` runs on a bound the wrapper does not
   * otherwise see: `client.callTool()` is transport-level and defaults to the
   * MCP SDK's own 60-second `DEFAULT_REQUEST_TIMEOUT_MSEC`, unrelated to
   * whatever the tool itself was asked to wait for. Verified against the
   * real transport: `wait_for` with `timeoutMs: 150000` threw a bare `SdkError
   * REQUEST_TIMEOUT "Request timed out"` at exactly 60002ms, with no mention
   * of what was being waited for, because the transport gave up on the call
   * thirty seconds before wait_for's own timeout would have. The wrapper now
   * derives a per-call transport timeout from `timeoutMs` (see `forwardTool`
   * in `src/client/wrapper.ts`) so the tool's own timeout fires first and
   * produces its real, informative result; this is the outer bound on that,
   * so a call that asks to wait forever (`evaluate`'s `timeoutMs: 0`) or for
   * longer than this cannot pin the wrapper's connection indefinitely.
   *
   * Defaults to the same ten minutes as `maxInFlightAgeMs` rather than a
   * second, unrelated number: past `maxInFlightAgeMs` the daemon's own
   * reaper stops believing an in-flight call and reaps its session out from
   * under it (see that field's comment), so waiting past that point on the
   * transport side has nothing left to wait for anyway.
   */
  requestTimeoutCeilingMs: number;
  /**
   * The shortest transport timeout the client wrapper will ever give a
   * forwarded call, matching the MCP SDK's own `DEFAULT_REQUEST_TIMEOUT_MSEC`
   * by default so an ordinary call (no `timeoutMs`, or one under a minute)
   * gets exactly the bound it always had, not a tighter one.
   *
   * Configurable purely for testing: proving that a `timeoutMs` above the
   * floor gets `timeoutMs` plus a margin, rather than being clamped down to
   * the floor, otherwise means a test genuinely waiting past sixty real
   * seconds to observe the switch. Shrink this and the switch happens at a
   * shrunk point too, so the same assertion holds in under two seconds. Never
   * touched in production, where the default is the whole point.
   */
  requestTimeoutFloorMs: number;
  /** How often the daemon's single in-process timer sweeps sessions + registry. */
  sweepIntervalMs: number;
  /**
   * Minimum daemon uptime before an empty client registry is allowed to
   * trigger self-shutdown, measured from the moment the daemon finished
   * starting.
   *
   * The arithmetic that makes this real, and that the old default got wrong:
   * the gate is only ever evaluated by a sweep, and the first sweep runs at
   * an uptime of `sweepIntervalMs`. So any grace at or below
   * `sweepIntervalMs` can never decline anything, because by the time
   * anything asks, the grace has already elapsed. The previous default paired
   * a 10s grace with a 60s sweep, which meant it was unreachable in every
   * shipped configuration: a knob documenting a protection it did not
   * provide. It therefore defaults to `sweepIntervalMs` plus 30s, deriving
   * from the interval rather than restating a constant, so the two cannot
   * drift apart again if either is tuned. `daemon.start` logs both values
   * side by side, which is where to check the relationship for a given
   * deployment.
   *
   * What it guards is narrower than it used to be. It was written for a race
   * where the client that spawned the daemon had not registered by the first
   * sweep, and that race is now closed at its source: the client wrapper
   * writes its registry entry BEFORE it asks whether a daemon is running or
   * spawns one (see `registerInDaemonRegistry` in `src/client/wrapper.ts`),
   * so the wrapper is never invisible to a sweep. What remains is a plain
   * floor on the lifetime of a daemon nothing has claimed, which still
   * matters for a daemon started by anything other than the wrapper, by hand
   * for debugging most of all.
   */
  shutdownGraceMs: number;
  /**
   * A PID whose death should take this daemon down with it, or `null` (the
   * default, and the only value production ever uses) for the ordinary
   * machine-wide daemon whose lifetime nothing else owns.
   *
   * The shared daemon deliberately outlives the client wrapper that spawned
   * it: wrappers come and go with each Claude Code session, browser sessions
   * do not, and that independence is the whole point of the pool. So
   * `spawnDaemon` never sets this, and strips it from the environment it
   * passes on, because a wrapper's own PID ending up here would silently undo
   * that design.
   *
   * It exists for the case where a daemon genuinely does belong to one
   * process: a test. A test spawns a daemon on a free port and kills it in an
   * `after()` hook, and a hook that never runs (the test threw, the runner was
   * killed, the machine was too loaded for a health check to answer inside its
   * timeout) used to leave that daemon running. An empty client registry alone
   * cannot reap it either, because a live browser session vetoes the
   * registry-empty shutdown by design, so a stranded test daemon holding one
   * session sat on a Chromium for the full fifteen-minute idle timeout.
   * Naming the owner means the daemon notices for itself instead of depending
   * on somebody else's cleanup code getting to run.
   *
   * Checked with the same pid-plus-start-time guard the client registry uses,
   * so a recycled PID cannot make a daemon believe a dead owner is still
   * alive, and an owner that cannot be read at startup is treated as "no
   * owner" rather than as "owner already dead": refusing to start, or exiting
   * immediately, would be a far worse failure than not having the watch.
   */
  ownerPid: number | null;
  /** Directory holding the registry file and daemon log. `~/.harborage` by default. */
  stateDir: string;
  /** Path to the shared client registry file. */
  registryPath: string;
  /**
   * Path to the daemon's owned-process ledger: the record of which OS
   * processes this daemon has itself started, so they can be identified and
   * reaped later even after the daemon that owned them is gone.
   *
   * This is what makes `harborage gc` safe. Once a daemon dies its Chromium
   * reparents to PID 1 and every trace of who started it is gone from the
   * process table, and the only way left to identify it would be matching its
   * command line, which would also match every unrelated Playwright browser on
   * the machine. A ledger the daemon writes about itself is provenance we
   * actually own.
   */
  ownedProcessesPath: string;
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
  /**
   * Max buffered network request/response entries kept per session (oldest
   * dropped first).
   *
   * 400, raised from an original 200. Doubling it is a cheap mitigation, not
   * the fix: a page running its own dev server can still fill any fixed ring
   * with module-chunk requests inside the first second of a load, and no
   * single number is right for every app. The real fix is that eviction is
   * now visible (list_network_requests reports `dropped`) and avoidable (a
   * session's capture filter can keep chunk noise out of the ring before it
   * ever gets a chance to evict anything), which matters far more than this
   * number does. It is still raised because it costs nothing real (a network
   * entry is a handful of short fields) and buys real headroom for the
   * common case of one plain page load before a caller needs to reach for a
   * filter at all.
   */
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
 * An optional PID-valued variable. Unset, empty, or not a positive integer all
 * mean "absent" rather than being an error, because the one thing worse than a
 * daemon with no owner watch is a daemon that refuses to start over a typo in
 * a variable nothing in production sets.
 */
function optionalPid(name: string): number | null {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

/**
 * Builds a `Config` from environment variables, applying documented
 * defaults for anything unset. Called once at process startup in both the
 * daemon and the client wrapper; tests construct their own `Config` objects
 * directly instead of mutating `process.env`.
 */
export function loadConfig(): Config {
  const stateDir = str('HARBORAGE_STATE_DIR', join(homedir(), '.harborage'));
  // Read first because the shutdown grace's default is derived from it: a
  // grace at or below one sweep interval can never decline a sweep. See
  // `shutdownGraceMs` above.
  const sweepIntervalMs = num('HARBORAGE_SWEEP_INTERVAL_MS', 60 * 1000);
  return {
    host: str('HARBORAGE_HOST', '127.0.0.1'),
    port: num('HARBORAGE_PORT', 4599),
    debugPort: num('HARBORAGE_DEBUG_PORT', 4600),
    idleTimeoutMs: num('HARBORAGE_IDLE_TIMEOUT_MS', 15 * 60 * 1000),
    escalatedIdleTimeoutMs: num('HARBORAGE_ESCALATED_IDLE_TIMEOUT_MS', 60 * 60 * 1000),
    maxInFlightAgeMs: num('HARBORAGE_MAX_IN_FLIGHT_AGE_MS', 10 * 60 * 1000),
    requestTimeoutCeilingMs: num('HARBORAGE_REQUEST_TIMEOUT_CEILING_MS', 10 * 60 * 1000),
    requestTimeoutFloorMs: num('HARBORAGE_REQUEST_TIMEOUT_FLOOR_MS', 60 * 1000),
    sweepIntervalMs,
    shutdownGraceMs: num('HARBORAGE_SHUTDOWN_GRACE_MS', sweepIntervalMs + 30 * 1000),
    ownerPid: optionalPid('HARBORAGE_OWNER_PID'),
    stateDir,
    registryPath: str('HARBORAGE_REGISTRY_PATH', join(stateDir, 'registry.json')),
    ownedProcessesPath: str('HARBORAGE_OWNED_PROCESSES_PATH', join(stateDir, 'owned-processes.json')),
    daemonLogPath: str('HARBORAGE_DAEMON_LOG_PATH', join(stateDir, 'daemon.log')),
    screenshotCacheDir: str('HARBORAGE_SCREENSHOT_CACHE_DIR', join(stateDir, 'screenshots')),
    screenshotCacheTtlMs: num('HARBORAGE_SCREENSHOT_CACHE_TTL_MS', 4 * 60 * 60 * 1000),
    consoleBufferSize: num('HARBORAGE_CONSOLE_BUFFER_SIZE', 200),
    networkBufferSize: num('HARBORAGE_NETWORK_BUFFER_SIZE', 400),
    dialogBufferSize: num('HARBORAGE_DIALOG_BUFFER_SIZE', 200),
    pageErrorBufferSize: num('HARBORAGE_PAGE_ERROR_BUFFER_SIZE', 200),
    daemonReadyTimeoutMs: num('HARBORAGE_DAEMON_READY_TIMEOUT_MS', 60 * 1000),
    daemonHealthPollMs: num('HARBORAGE_DAEMON_HEALTH_POLL_MS', 200),
    testStartupDelayMs: num('HARBORAGE_TEST_STARTUP_DELAY_MS', 0)
  };
}
