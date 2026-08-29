import { createServer as createNodeServer, type Server } from 'node:http';

import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, type McpServer } from '@modelcontextprotocol/server';

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
  startedAt: number
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
      resolve({
        server,
        close: async () => {
          await mcpHandler.close();
          await new Promise<void>((res, rej) => {
            server.close(err => (err ? rej(err) : res()));
          });
        }
      });
    });
  });
}
