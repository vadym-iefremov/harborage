import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { loadConfig, type Config } from '../shared/config.js';
import { getProcessStartTime } from '../shared/processInfo.js';
import { deregisterSelf, registerSelf } from '../shared/registry.js';
import { toolDescriptions, toolInputSchemas, type ToolName } from '../daemon/tools/schemas.js';
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

    const client = new Client({ name: 'harborage-client-wrapper', version: '0.1.0' });
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

function buildStdioServer(ensureReady: () => Promise<Client>): McpServer {
  const server = new McpServer({ name: 'harborage', version: '0.1.0' });

  server.registerTool(
    'create_session',
    { description: toolDescriptions.create_session, inputSchema: toolInputSchemas.create_session },
    forwardTool('create_session', ensureReady)
  );
  server.registerTool(
    'navigate',
    { description: toolDescriptions.navigate, inputSchema: toolInputSchemas.navigate },
    forwardTool('navigate', ensureReady)
  );
  server.registerTool(
    'click',
    { description: toolDescriptions.click, inputSchema: toolInputSchemas.click },
    forwardTool('click', ensureReady)
  );
  server.registerTool(
    'fill',
    { description: toolDescriptions.fill, inputSchema: toolInputSchemas.fill },
    forwardTool('fill', ensureReady)
  );
  server.registerTool(
    'evaluate',
    { description: toolDescriptions.evaluate, inputSchema: toolInputSchemas.evaluate },
    forwardTool('evaluate', ensureReady)
  );
  server.registerTool(
    'snapshot',
    { description: toolDescriptions.snapshot, inputSchema: toolInputSchemas.snapshot },
    forwardTool('snapshot', ensureReady)
  );
  server.registerTool(
    'list_tabs',
    { description: toolDescriptions.list_tabs, inputSchema: toolInputSchemas.list_tabs },
    forwardTool('list_tabs', ensureReady)
  );
  server.registerTool(
    'screenshot',
    { description: toolDescriptions.screenshot, inputSchema: toolInputSchemas.screenshot },
    forwardTool('screenshot', ensureReady)
  );
  server.registerTool(
    'export_state',
    { description: toolDescriptions.export_state, inputSchema: toolInputSchemas.export_state },
    forwardTool('export_state', ensureReady)
  );
  server.registerTool(
    'escalate_session',
    { description: toolDescriptions.escalate_session, inputSchema: toolInputSchemas.escalate_session },
    forwardTool('escalate_session', ensureReady)
  );
  server.registerTool(
    'release_session',
    { description: toolDescriptions.release_session, inputSchema: toolInputSchemas.release_session },
    forwardTool('release_session', ensureReady)
  );

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
      // Best-effort only — the daemon's own sweep prunes a dead/stale PID regardless.
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
