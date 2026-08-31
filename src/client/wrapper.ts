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

function createDaemonConnection(config: Config): DaemonConnection {
  let inflight: Promise<Client> | null = null;
  let current: Client | null = null;

  async function connect(): Promise<Client> {
    await ensureDaemonRunning(config);

    const startedAt = await getProcessStartTime(process.pid);
    if (startedAt) {
      await registerSelf(config.registryPath, process.pid, startedAt).catch(err => {
        console.error('[harborage] failed to register with the daemon registry (continuing anyway):', err);
      });
    } else {
      console.error('[harborage] could not determine this process\'s own start time; skipping registry registration');
    }

    const client = new Client({ name: 'harborage-client-wrapper', version: '0.2.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://${config.host}:${config.port}/mcp`)));
    return client;
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
 * Forwards one tool call, arguments unchanged, to the daemon; returns the
 * daemon's result unchanged.
 *
 * On a connection-level failure it reconnects and retries the call exactly
 * once, so a daemon that went away (killed, self-shut-down after its last
 * client left, or restarted to pick up a code change) no longer bricks every
 * open Claude Code session until the CLI itself is restarted. Once, not in a
 * loop: a daemon that genuinely cannot come back should fail fast.
 */
function forwardTool<T extends ToolName>(
  name: T,
  ensureReady: () => Promise<Client>,
  invalidate?: (stale: Client) => void
) {
  return async (args: Record<string, unknown>) => {
    const client = await ensureReady();
    try {
      return (await client.callTool({ name, arguments: args })) as never;
    } catch (err) {
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
      return (await reconnected.callTool({ name, arguments: args })) as never;
    }
  };
}

/**
 * Registers one pass-through tool: same name, same description, same schema
 * as the daemon's, with a forwarder in place of the real handler.
 *
 * Taking a single `ToolDef` (rather than looping inline over `toolDefs`) is
 * what keeps `registerTool`'s overload resolution happy: the schema is one
 * concrete type here, not the union of all fifteen. Note this file never
 * touches `def.handler`, which is why the wrapper process needs neither a
 * `SessionStore` nor a browser.
 */
function registerForwardingTool(
  server: McpServer,
  name: ToolName,
  def: ToolDef,
  ensureReady: () => Promise<Client>,
  invalidate?: (stale: Client) => void
): void {
  server.registerTool(
    name,
    { description: def.description, inputSchema: def.inputSchema },
    forwardTool(name, ensureReady, invalidate)
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
export function buildStdioServer(ensureReady: () => Promise<Client>, invalidate?: (stale: Client) => void): McpServer {
  const server = new McpServer({ name: 'harborage', version: '0.2.0' });

  for (const name of toolNames) {
    registerForwardingTool(server, name, toolDefs[name], ensureReady, invalidate);
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

  serveStdio(() => buildStdioServer(ensureReady, invalidate));
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
