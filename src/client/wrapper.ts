import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { loadConfig, type Config } from '../shared/config.js';
import { getProcessStartTime } from '../shared/processInfo.js';
import { deregisterSelf, registerSelf } from '../shared/registry.js';
import { toolDefs, toolNames, type ToolName } from '../daemon/tools/schemas.js';
import type { ToolDef } from '../daemon/tools/types.js';
import { ensureDaemonRunning } from './daemonManager.js';

/**
 * Memoizes the "get the daemon ready and connected" work so it only ever
 * actually runs once per wrapper process, however many tool calls race to
 * trigger it.
 *
 * Deliberately NOT awaited at module load: constraint #3 in the spec is
 * that the MCP `initialize` handshake must complete immediately, without
 * waiting on daemon cold-start, since Claude Code's own handshake timeout
 * is undocumented. `runWrapper` below starts `serveStdio` first and kicks
 * this off in the background; only a tool handler actually blocks on it.
 */
function createReadyClient(config: Config): () => Promise<Client> {
  let inflight: Promise<Client> | null = null;

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

  return function ensureReady(): Promise<Client> {
    if (!inflight) {
      inflight = connect().catch(err => {
        // Let the next call retry from scratch instead of caching a permanent failure.
        inflight = null;
        throw err;
      });
    }
    return inflight;
  };
}

/** Forwards one tool call, arguments unchanged, to the daemon; returns the daemon's result unchanged. */
function forwardTool<T extends ToolName>(name: T, ensureReady: () => Promise<Client>) {
  return async (args: Record<string, unknown>) => {
    const client = await ensureReady();
    const result = await client.callTool({ name, arguments: args });
    return result as never;
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
function registerForwardingTool(server: McpServer, name: ToolName, def: ToolDef, ensureReady: () => Promise<Client>): void {
  server.registerTool(name, { description: def.description, inputSchema: def.inputSchema }, forwardTool(name, ensureReady));
}

/** The stdio server this wrapper exposes to its host, one pass-through tool per daemon tool. */
export function buildStdioServer(ensureReady: () => Promise<Client>): McpServer {
  const server = new McpServer({ name: 'harborage', version: '0.2.0' });

  for (const name of toolNames) {
    registerForwardingTool(server, name, toolDefs[name], ensureReady);
  }

  return server;
}

export async function runWrapper(): Promise<void> {
  const config = loadConfig();
  const ensureReady = createReadyClient(config);

  // Fire-and-forget: warms up the daemon connection in the background so
  // the *first real tool call* (not the handshake) pays the cold-start cost.
  void ensureReady().catch(err => {
    console.error('[harborage] background daemon readiness check failed (will retry on next tool call):', err);
  });

  serveStdio(() => buildStdioServer(ensureReady));
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
