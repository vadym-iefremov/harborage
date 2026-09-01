import { Client, SdkError, SdkErrorCode, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { loadConfig, type Config } from '../shared/config.js';
import { getProcessStartTime } from '../shared/processInfo.js';
import { deregisterSelf, registerSelf } from '../shared/registry.js';
import { toolDefs, toolNames, type ToolName } from '../daemon/tools/schemas.js';
import type { ToolDef } from '../daemon/tools/types.js';
import { ensureDaemonRunning } from './daemonManager.js';

/**
 * Socket-level failures that mean "nothing is listening" or "the connection
 * broke", as opposed to "the daemon answered and said no". undici reports
 * these as a bare `TypeError: fetch failed` whose `.cause` carries the real
 * errno, which is why both levels get checked.
 */
const connectionErrnos = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'EPIPE',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'UND_ERR_SOCKET'
]);

/**
 * SDK error codes that describe the pipe rather than the work. Deliberately
 * does NOT include `RequestTimeout`: a timed-out call may well have run for
 * real on the daemon, and re-running a `click` or a `navigate` that already
 * happened is worse than reporting the timeout.
 */
const retryableSdkCodes = new Set<string>([
  SdkErrorCode.NotConnected,
  SdkErrorCode.ConnectionClosed,
  SdkErrorCode.SendFailed,
  SdkErrorCode.ClientHttpFailedToOpenStream
]);

/**
 * Classifies one failed forward: a short reason to name in the log if the
 * failure is the connection's fault and the call is therefore safe to retry,
 * or `null` if it is not.
 *
 * The distinction that makes retrying safe at all: a tool the daemon really
 * ran and that really failed comes back as a *result* with `isError: true`,
 * never as a rejection, so nothing that reaches here represents completed
 * work. The checks below narrow further, to failures where the request
 * provably never got a real answer.
 */
function transportFailureReason(err: unknown): string | null {
  if (!(err instanceof Error)) return null;

  const errno = (err as NodeJS.ErrnoException).code ?? (err.cause as NodeJS.ErrnoException | undefined)?.code;
  if (typeof errno === 'string' && connectionErrnos.has(errno)) return errno;

  if (err instanceof SdkError) {
    if (retryableSdkCodes.has(err.code)) return err.code;
    // The SDK's catch-all for "the server answered, but not with a 2xx".
    // A daemon that restarted under us answers 404, because the Streamable
    // HTTP session id we were using died with the old process; a daemon
    // mid-collapse answers 5xx. Neither of them ran the tool.
    if (err.code === SdkErrorCode.ClientHttpNotImplemented) {
      const status = (err.data as { status?: number } | undefined)?.status;
      if (status === 404 || (typeof status === 'number' && status >= 500)) return `http-${status}`;
    }
    return null;
  }

  // Verified by probe against a SIGKILLed daemon: this is the exact error a
  // forwarded call gets, and the message callers used to be handed forever
  // once the daemon went away.
  if (err.name === 'TypeError' && err.message === 'fetch failed') return 'fetch-failed';

  return null;
}

/**
 * The wrapper's one connection to the daemon.
 *
 * `ensureReady` memoizes the "get the daemon ready and connected" work so it
 * only ever actually runs once per wrapper process, however many tool calls
 * race to trigger it. `invalidate` is the recovery half: it drops a
 * connection that has been proven dead, so the next `ensureReady` re-runs
 * `ensureDaemonRunning` (which respawns the daemon if it is gone) and
 * reconnects.
 *
 * Deliberately NOT awaited at module load: constraint #3 in the spec is
 * that the MCP `initialize` handshake must complete immediately, without
 * waiting on daemon cold-start, since Claude Code's own handshake timeout
 * is undocumented. `runWrapper` below starts `serveStdio` first and kicks
 * this off in the background; only a tool handler actually blocks on it.
 */
interface DaemonConnection {
  ensureReady: () => Promise<Client>;
  invalidate: (stale: Client) => void;
}

/**
 * Announces this wrapper in the shared client registry.
 *
 * Called BEFORE anything asks the daemon whether it is alive, and that
 * ordering is the point rather than tidiness. The daemon's sweep exits the
 * moment it sees an empty registry with no live session, and a wrapper that
 * has not written its entry yet is indistinguishable from one that does not
 * exist. Registering afterwards left a window on every single arrival: the
 * daemon answers `/health`, and only THEN does the wrapper fork `ps` for its
 * own start time and write the registry file, work that on a loaded machine
 * takes longer than the daemon's next sweep. Reproduced deterministically by
 * slowing that one `ps` to 250ms, at which point the daemon logs
 * `sweep.shutdown reason=registry-empty clients=0 sessions=0 uptimeMs=207`
 * and the wrapper's first tool call comes back as a bare "fetch failed"
 * (cause: ECONNREFUSED). Registering first means the daemon's very first
 * sweep already counts us.
 *
 * Registering before a daemon is known to exist is safe, and is what the
 * entry has always meant: "this PID intends to use the daemon", not "this
 * PID is connected". The sweep's own `pruneDead` removes it as soon as this
 * process is gone, keyed on pid AND start time so a reused PID is never
 * mistaken for it.
 */
async function registerInDaemonRegistry(config: Config): Promise<void> {
  const startedAt = await getProcessStartTime(process.pid);
  if (!startedAt) {
    console.error('[harborage] could not determine this process\'s own start time; skipping registry registration');
    return;
  }
  await registerSelf(config.registryPath, process.pid, startedAt).catch(err => {
    console.error('[harborage] failed to register with the daemon registry (continuing anyway):', err);
  });
}

/**
 * What a caller is told when the wrapper cannot get a connection open at all,
 * in place of the bare `TypeError: fetch failed` undici raises.
 *
 * That string is the exact failure this codebase has been eliminating
 * everywhere else, and it is at its least useful here: a caller handed it
 * cannot tell a daemon that is not running from one that is refusing from a
 * bug in its own call. This names which of those it was, says that no tool
 * ran so nothing needs undoing, and points at the one file that explains why.
 */
function connectFailureMessage(config: Config, reason: string): string {
  return (
    `Could not open a connection to the harborage daemon at http://${config.host}:${config.port}/mcp (${reason}), ` +
    'and a second attempt, after making sure a daemon was running, failed the same way. No tool call was sent, so ' +
    'nothing ran and no browser state changed. This is the daemon being unreachable rather than anything wrong ' +
    `with the call: read ${config.daemonLogPath} for why it exited or refused (a \`daemon.port-in-use\` line there ` +
    `means something else already holds port ${config.port}), and check that no stale process is bound to it.`
  );
}

function createDaemonConnection(config: Config): DaemonConnection {
  let inflight: Promise<Client> | null = null;
  let current: Client | null = null;

  /**
   * One attempt at the Streamable HTTP handshake. Closes the half-built
   * client if it fails, so a failed attempt does not leave a socket or an SSE
   * stream behind for the retry to pile on top of.
   */
  async function openClient(): Promise<Client> {
    const client = new Client({ name: 'harborage-client-wrapper', version: '0.2.0' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://${config.host}:${config.port}/mcp`)));
    } catch (err) {
      await client.close().catch(() => {
        // Nothing was ever established; this is hygiene, not correctness.
      });
      throw err;
    }
    return client;
  }

  async function connect(): Promise<Client> {
    // Before ensureDaemonRunning, deliberately. See registerInDaemonRegistry.
    await registerInDaemonRegistry(config);
    await ensureDaemonRunning(config);

    try {
      return await openClient();
    } catch (err) {
      const reason = transportFailureReason(err);
      if (reason === null) throw err;

      // `ensureDaemonRunning` can only ever prove the daemon was healthy at
      // the instant it asked. A daemon deciding to exit between that answer
      // and this handshake is a race no ordering closes, only recovers from,
      // and recovering is exactly what a forwarded call already does on this
      // same class of failure. Connection setup was the one path with no
      // such recovery: it runs before `forwardTool`'s try block, so a
      // transport error here bypassed the reconnect entirely and reached the
      // caller as a bare "fetch failed".
      console.error(
        `[harborage] the daemon stopped answering while this wrapper was connecting to it (${reason}); ` +
          'making sure one is running and connecting once more. Nothing had been sent yet, so no tool call is at risk.'
      );
      await ensureDaemonRunning(config);
      try {
        return await openClient();
      } catch (retryErr) {
        const retryReason = transportFailureReason(retryErr) ?? 'unknown transport failure';
        throw new Error(connectFailureMessage(config, retryReason), { cause: retryErr });
      }
    }
  }

  function ensureReady(): Promise<Client> {
    if (!inflight) {
      inflight = connect()
        .then(client => {
          current = client;
          return client;
        })
        .catch(err => {
          // Let the next call retry from scratch instead of caching a permanent failure.
          inflight = null;
          throw err;
        });
    }
    return inflight;
  }

  function invalidate(stale: Client): void {
    // Only a caller still holding the CURRENT client may drop it. When
    // several forwarded calls are in flight against one dead daemon they all
    // fail and all land here; without this guard the second would tear down
    // the replacement the first just built, and each would spawn its own
    // daemon.
    if (current !== stale) return;
    current = null;
    inflight = null;
    void stale.close().catch(() => {
      // The transport is already broken; closing it is tidiness, not correctness.
    });
  }

  return { ensureReady, invalidate };
}

/**
 * The floor and ceiling `requestTimeoutFor` clamps a derived transport
 * timeout between. Bundled into one type because the two are only ever
 * threaded together, from `Config` down through `runWrapper`,
 * `buildStdioServer` and `registerForwardingTool` to `forwardTool`.
 */
export interface RequestTimeoutBounds {
  /**
   * The MCP SDK's own default (`DEFAULT_REQUEST_TIMEOUT_MSEC`), kept as the
   * floor's own default so a tool with no `timeoutMs`, or one under a
   * minute, is timed exactly as it always was: an ordinary call must not
   * get a tighter transport bound than it used to have. Configurable
   * (`HARBORAGE_REQUEST_TIMEOUT_FLOOR_MS`, see `src/shared/config.ts`)
   * purely so a test can shrink it, and with it the point where
   * `requestTimeoutFor` switches from "the floor" to "timeoutMs plus
   * margin", without genuinely waiting past 60 real seconds to observe the
   * switch.
   */
  floorMs: number;
  /**
   * The longest a forwarded call may run before the wrapper gives up on the
   * daemon regardless of `timeoutMs`. See `requestTimeoutCeilingMs` in
   * `src/shared/config.ts` for why it defaults to `maxInFlightAgeMs`.
   */
  ceilingMs: number;
}

/**
 * Headroom given to a request beyond the `timeoutMs` a caller passed, so the
 * tool's own timeout fires first and the caller gets its real, informative
 * result instead of a bare transport error. Verified against the real
 * transport: `wait_for` with `timeoutMs: 70000` actually settled at
 * 70006ms, a 6ms overhead; five more `wait_for` calls at 1500ms and 5000ms
 * showed the same handful of milliseconds. Ten seconds is generous headroom
 * over that for a slower connection or a busier daemon, not a measurement of
 * the overhead itself.
 */
export const requestTimeoutMarginMs = 10_000;

/**
 * Derives the transport-level timeout for one forwarded call from the
 * `timeoutMs` a caller passed the tool itself, if any.
 *
 * Every tool that takes a `timeoutMs` (`wait_for`, `evaluate`, drag/wheel
 * endpoint resolution, `download_file`, selector captures) is meant to
 * bound ITS OWN wait, not the transport call carrying it. Before this,
 * `client.callTool()` ran with no request options at all, so every one of
 * them silently inherited the MCP SDK's 60-second default regardless of
 * what was asked for: verified against the real transport, `wait_for` with
 * `timeoutMs: 150000` threw a bare `SdkError REQUEST_TIMEOUT "Request timed
 * out"` at exactly 60002ms, thirty seconds before the tool's own timeout
 * would have fired, and carrying none of the "waiting for selector to be
 * visible" context the tool's real timeout message would have had.
 *
 * `timeoutMs: 0` is `evaluate`'s documented "wait forever" (see its
 * description in `src/daemon/tools/defs/inspect.ts`), which the wrapper
 * cannot honor literally without risking pinning its one connection to the
 * daemon indefinitely on a single wedged call, so "forever" here means "for
 * as long as `bounds.ceilingMs` allows" rather than truly unbounded.
 */
export function requestTimeoutFor(args: Record<string, unknown>, bounds: RequestTimeoutBounds): number {
  return resolveRequestTimeout(args, bounds).timeoutMs;
}

/**
 * Which of the three bounds actually decided a forwarded call's transport
 * timeout.
 *
 * `floor`: no `timeoutMs`, or one so small the floor is longer. `requested`:
 * the caller's own `timeoutMs` plus margin. `ceiling`: the caller asked for
 * longer than the wrapper is willing to hold its connection for (including
 * `timeoutMs: 0`, "wait forever"), so the ceiling won.
 */
export type RequestTimeoutBound = 'floor' | 'requested' | 'ceiling';

/** A derived transport timeout together with which bound produced it and what the caller had asked for. */
export interface ResolvedRequestTimeout {
  timeoutMs: number;
  bound: RequestTimeoutBound;
  /** The caller's own `timeoutMs`, when it passed one. `0` means its documented "wait forever". */
  requestedMs?: number;
}

/**
 * `requestTimeoutFor`'s real body, which also says WHICH bound won.
 *
 * That extra fact is not decoration. When the timeout that fires is the
 * ceiling's, the SDK raises the same bare "Request timed out" a caller used
 * to get at 60 seconds, and being told nothing at ten minutes is worse than
 * being told nothing at one: the call looks identical to a hung daemon, and
 * nothing in it names the ceiling, its value, or the environment variable
 * that raises it. `forwardTool` uses this to say all three, and to log the
 * clamp at the moment it is applied rather than only if it later fires.
 */
export function resolveRequestTimeout(
  args: Record<string, unknown>,
  bounds: RequestTimeoutBounds
): ResolvedRequestTimeout {
  const requested = typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined;
  if (requested === undefined) return { timeoutMs: bounds.floorMs, bound: 'floor' };
  // evaluate's documented "wait forever", which becomes "for as long as the
  // ceiling allows". Reported as the ceiling deliberately: it is the ceiling
  // that will cut such a call off, and a caller who wrote 0 needs to be told
  // that a real bound exists.
  if (requested === 0) return { timeoutMs: bounds.ceilingMs, bound: 'ceiling', requestedMs: 0 };
  const withMargin = requested + requestTimeoutMarginMs;
  if (withMargin > bounds.ceilingMs) return { timeoutMs: bounds.ceilingMs, bound: 'ceiling', requestedMs: requested };
  if (withMargin < bounds.floorMs) return { timeoutMs: bounds.floorMs, bound: 'floor', requestedMs: requested };
  return { timeoutMs: withMargin, bound: 'requested', requestedMs: requested };
}

/**
 * Rewrites the SDK's bare `Request timed out` into something a caller can
 * act on, naming the bound that fired, its value, and the way to raise it.
 *
 * The bare message is the exact failure the previous round set out to
 * eliminate at 60 seconds. Clamping at the ceiling instead of the floor
 * moved it to ten minutes without making it any more informative: it names
 * neither the ceiling, nor its value, nor `HARBORAGE_REQUEST_TIMEOUT_CEILING_MS`.
 * It also has to say the work may still be running, because it is: the
 * wrapper stopped waiting, it did not cancel anything on the daemon.
 */
function timeoutMessage(name: string, resolved: ResolvedRequestTimeout, bounds: RequestTimeoutBounds): string {
  const shared =
    `The daemon was still working when the wrapper stopped waiting, and nothing was cancelled: ${name} may well ` +
    'still be running there, and any page state it had already changed has still changed. Check with ' +
    'list_sessions, and read the tool\'s own result next time by giving it a timeout it can finish inside.';

  if (resolved.bound === 'ceiling') {
    const asked =
      resolved.requestedMs === 0
        ? 'timeoutMs: 0 ("wait forever")'
        : resolved.requestedMs === undefined
          ? 'no timeoutMs'
          : `timeoutMs: ${resolved.requestedMs}`;
    return (
      `${name} timed out after ${resolved.timeoutMs}ms, at harborage's request-timeout CEILING, not at the timeout ` +
      `the call asked for (${asked}). The ceiling is the longest the client wrapper will hold its one connection ` +
      'to the daemon open for a single call, and it is what fired here. Raise it with ' +
      `HARBORAGE_REQUEST_TIMEOUT_CEILING_MS (currently ${bounds.ceilingMs}ms) if the work genuinely needs longer. ` +
      shared
    );
  }
  if (resolved.bound === 'floor') {
    return (
      `${name} timed out after ${resolved.timeoutMs}ms, at harborage's request-timeout FLOOR, which is the bound ` +
      'a call that passes no timeoutMs of its own gets. Pass a timeoutMs to this tool if it needs longer, or ' +
      `raise HARBORAGE_REQUEST_TIMEOUT_FLOOR_MS (currently ${bounds.floorMs}ms). ` +
      shared
    );
  }
  return (
    `${name} timed out after ${resolved.timeoutMs}ms at the transport, which is the timeoutMs it was given ` +
    `(${resolved.requestedMs}ms) plus ${requestTimeoutMarginMs}ms of margin. The tool\'s own timeout should have ` +
    'fired first and returned a real result, so this means the daemon did not answer at all rather than that the ' +
    'work merely ran long. ' +
    shared
  );
}

/** Whether one error is the MCP SDK's own transport-level request timeout, as opposed to a tool that failed. */
function isRequestTimeout(err: unknown): boolean {
  return err instanceof SdkError && err.code === SdkErrorCode.RequestTimeout;
}

/**
 * Forwards one tool call, arguments unchanged, to the daemon; returns the
 * daemon's result unchanged.
 *
 * On a connection-level failure it reconnects and retries the call exactly
 * once, so a daemon that went away (killed, self-shut-down after its last
 * client left, or restarted to pick up a code change) no longer bricks every
 * open Claude Code session until the CLI itself is restarted. Once, not in a
 * loop: a daemon that genuinely cannot come back should fail fast.
 *
 * The derived timeout (see `requestTimeoutFor`) applies to the retry leg
 * too, not just the first attempt: a call worth waiting 70 seconds for the
 * first time is worth waiting 70 seconds for after a reconnect, and
 * `transportFailureReason` already keeps a genuine `RequestTimeout` out of
 * the retry path (see its comment), so nothing here makes a real tool-level
 * timeout look like a transport failure worth retrying.
 */
function forwardTool<T extends ToolName>(
  name: T,
  ensureReady: () => Promise<Client>,
  requestTimeoutBounds: RequestTimeoutBounds,
  invalidate?: (stale: Client) => void
) {
  return async (args: Record<string, unknown>) => {
    const resolved = resolveRequestTimeout(args, requestTimeoutBounds);
    const timeout = resolved.timeoutMs;

    // Logged AT THE CLAMP, not only if the ceiling later fires. An operator
    // reading daemon.log (or the wrapper's stderr) after a ten-minute stall
    // needs to see that a bound was silently imposed on the call, and by the
    // time it fires the useful moment has passed. Only the ceiling case is
    // worth a line: the floor is the ordinary, unsurprising path every call
    // without a timeoutMs takes.
    if (resolved.bound === 'ceiling') {
      const asked = resolved.requestedMs === 0 ? '0 ("wait forever")' : `${resolved.requestedMs}ms`;
      console.error(
        `[harborage] ${name} asked for timeoutMs ${asked}; clamping its transport timeout to the ` +
          `${requestTimeoutBounds.ceilingMs}ms ceiling (HARBORAGE_REQUEST_TIMEOUT_CEILING_MS). If this call times ` +
          'out, the ceiling is what stopped it, not the daemon.'
      );
    }

    const client = await ensureReady();
    try {
      return (await client.callTool({ name, arguments: args }, { timeout })) as never;
    } catch (err) {
      if (isRequestTimeout(err)) throw new Error(timeoutMessage(name, resolved, requestTimeoutBounds));
      const reason = transportFailureReason(err);
      if (reason === null || !invalidate) throw err;

      // Said plainly, because a successful retry does not mean the caller got
      // its old session back: the daemon's Chromium died with it, and every
      // BrowserContext went with the Chromium. A working connection plus a
      // clear session-not-found error is the honest outcome here.
      console.error(
        `[harborage] lost the connection to the daemon (${reason}); respawning it and retrying ${name} once. ` +
          'Browser sessions created before this point are gone with the daemon\'s Chromium, so an older sessionId ' +
          'will come back as a session-not-found error, not a working session.'
      );

      invalidate(client);
      const reconnected = await ensureReady();
      try {
        return (await reconnected.callTool({ name, arguments: args }, { timeout })) as never;
      } catch (retryErr) {
        // The retry leg gets the same treatment as the first: a bare
        // "Request timed out" is exactly as uninformative the second time.
        if (isRequestTimeout(retryErr)) throw new Error(timeoutMessage(name, resolved, requestTimeoutBounds));
        throw retryErr;
      }
    }
  };
}

/**
 * Registers one pass-through tool: same name, same description, same schema
 * as the daemon's, with a forwarder in place of the real handler.
 *
 * Taking a single `ToolDef` (rather than looping inline over `toolDefs`) is
 * what keeps `registerTool`'s overload resolution happy: the schema is one
 * concrete type here, not the union of every tool's. Note this file never
 * touches `def.handler`, which is why the wrapper process needs neither a
 * `SessionStore` nor a browser.
 */
function registerForwardingTool(
  server: McpServer,
  name: ToolName,
  def: ToolDef,
  ensureReady: () => Promise<Client>,
  requestTimeoutBounds: RequestTimeoutBounds,
  invalidate?: (stale: Client) => void
): void {
  server.registerTool(
    name,
    { description: def.description, inputSchema: def.inputSchema },
    forwardTool(name, ensureReady, requestTimeoutBounds, invalidate)
  );
}

/**
 * The stdio server this wrapper exposes to its host, one pass-through tool
 * per daemon tool.
 *
 * `invalidate` is optional so a caller that only wants the registered tool
 * surface, and never calls a tool, can pass a bare readiness function.
 * Without it a forwarded call still reports a transport failure, it just
 * cannot recover from one.
 */
export function buildStdioServer(
  ensureReady: () => Promise<Client>,
  requestTimeoutBounds: RequestTimeoutBounds = { floorMs: 60_000, ceilingMs: 10 * 60 * 1000 },
  invalidate?: (stale: Client) => void
): McpServer {
  const server = new McpServer({ name: 'harborage', version: '0.2.0' });

  for (const name of toolNames) {
    registerForwardingTool(server, name, toolDefs[name], ensureReady, requestTimeoutBounds, invalidate);
  }

  return server;
}

export async function runWrapper(): Promise<void> {
  const config = loadConfig();
  const { ensureReady, invalidate } = createDaemonConnection(config);

  // Fire-and-forget: warms up the daemon connection in the background so
  // the *first real tool call* (not the handshake) pays the cold-start cost.
  void ensureReady().catch(err => {
    console.error('[harborage] background daemon readiness check failed (will retry on next tool call):', err);
  });

  const requestTimeoutBounds: RequestTimeoutBounds = {
    floorMs: config.requestTimeoutFloorMs,
    ceilingMs: config.requestTimeoutCeilingMs
  };
  serveStdio(() => buildStdioServer(ensureReady, requestTimeoutBounds, invalidate));
  console.error(`[harborage] client wrapper up (pid ${process.pid}), talking to daemon at http://${config.host}:${config.port}`);

  let cleaningUp = false;
  async function cleanup(reason: string): Promise<void> {
    if (cleaningUp) return;
    cleaningUp = true;
    console.error(`[harborage] client wrapper exiting: ${reason}`);
    await deregisterSelf(config.registryPath, process.pid).catch(() => {
      // Best-effort only: the daemon's own sweep prunes a dead/stale PID regardless.
    });
  }

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void cleanup(`received ${signal}`).then(() => process.exit(0));
    });
  }
  process.stdin.on('end', () => {
    void cleanup('stdin closed by host').then(() => process.exit(0));
  });
}
