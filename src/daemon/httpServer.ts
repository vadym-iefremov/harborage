import { createServer as createNodeServer, type Server } from 'node:http';

import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, type McpServer } from '@modelcontextprotocol/server';

import { errorFields, type Logger } from '../shared/logger.js';

export interface DaemonHttpServer {
  server: Server;
  close: () => Promise<void>;
}

/**
 * Mounts the daemon's MCP endpoint (`/mcp`) plus a plain `/health` endpoint
 * the client wrapper polls, on plain `node:http` bound to loopback only.
 * `localhostHostValidation` / `localhostOriginValidation` are the DNS-
 * rebinding guards the SDK docs call out as required in front of a bare
 * `node:http` mount (frameworks like Express arm these by default; plain
 * `node:http` does not, so we compose them ourselves).
 */
export function startHttpServer(
  host: string,
  port: number,
  createServerFactory: () => McpServer,
  startedAt: number,
  logger: Logger
): Promise<DaemonHttpServer> {
  const mcpHandler = createMcpHandler(createServerFactory);
  const nodeHandler = toNodeHandler(mcpHandler);
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();

  const server = createNodeServer((req, res) => {
    if (!validateHost(req, res) || !validateOrigin(req, res)) return;

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', pid: process.pid, uptimeMs: Date.now() - startedAt }));
      return;
    }

    void nodeHandler(req, res);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);

      // The listener above only ever guarded `listen`, and removing it leaves
      // the server with none at all. A `node:http` server with no `error`
      // listener turns any LATER server-level error into an unhandled 'error'
      // event, which is to say a throw, which the daemon answers by exiting
      // (see the uncaughtException handler in index.ts). That is the worst
      // available response on a machine-wide shared daemon: an accept-time
      // EMFILE during a busy parallel fan-out, exactly when file descriptors
      // are scarcest, would take every live browser session down with it and
      // hand every connected agent a bare "fetch failed". One refused
      // connection costs one connection, and the client wrapper already
      // reconnects; the daemon stays up and says what happened.
      server.on('error', err => {
        logger.log('daemon.error', { phase: 'http-server', fatal: false, ...errorFields(err) });
      });

      resolve({
        server,
        close: async () => {
          await mcpHandler.close();
          await new Promise<void>((res, rej) => {
            server.close(err => (err ? rej(err) : res()));
            // `server.close` stops new connections but waits on established
            // ones, and a keep-alive socket that nobody is using still counts
            // as established. Without this, a shutdown can sit behind an idle
            // client for the full keep-alive timeout (five seconds by
            // default) before `daemon.stopped` is ever written. Idle-only:
            // a connection with a request in flight is left to finish it.
            server.closeIdleConnections();
          });
        }
      });
    });
  });
}
