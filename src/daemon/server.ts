import { McpServer } from '@modelcontextprotocol/server';

import { toolDescriptions, toolInputSchemas } from './tools/schemas.js';
import { createToolHandlers } from './tools/handlers.js';
import type { SessionStore } from './sessions.js';

/**
 * Builds the `createServer` factory `createMcpHandler` needs. Each HTTP
 * request gets a fresh `McpServer` instance (that's the SDK's per-request
 * model — see docs/superpowers/specs), but every instance registers tools
 * that close over the *same* `SessionStore`, which is the actual shared,
 * long-lived state: the browser sessions themselves outlive any single
 * request, only the protocol-level `McpServer` object is per-request.
 *
 * Each tool is registered by an explicit call (rather than looped over
 * `toolNames`) so each one's Zod schema and handler stay paired as a single
 * concrete type — looping over the union of all eleven schemas defeats
 * `registerTool`'s own overload resolution.
 */
export function createServerFactory(sessions: SessionStore, debugPort: number) {
  const handlers = createToolHandlers(sessions, debugPort);

  return function createServer(): McpServer {
    const server = new McpServer({ name: 'harborage', version: '0.1.0' });

    server.registerTool(
      'create_session',
      { description: toolDescriptions.create_session, inputSchema: toolInputSchemas.create_session },
      handlers.create_session
    );
    server.registerTool(
      'navigate',
      { description: toolDescriptions.navigate, inputSchema: toolInputSchemas.navigate },
      handlers.navigate
    );
    server.registerTool('click', { description: toolDescriptions.click, inputSchema: toolInputSchemas.click }, handlers.click);
    server.registerTool('fill', { description: toolDescriptions.fill, inputSchema: toolInputSchemas.fill }, handlers.fill);
    server.registerTool(
      'evaluate',
      { description: toolDescriptions.evaluate, inputSchema: toolInputSchemas.evaluate },
      handlers.evaluate
    );
    server.registerTool(
      'snapshot',
      { description: toolDescriptions.snapshot, inputSchema: toolInputSchemas.snapshot },
      handlers.snapshot
    );
    server.registerTool(
      'list_tabs',
      { description: toolDescriptions.list_tabs, inputSchema: toolInputSchemas.list_tabs },
      handlers.list_tabs
    );
    server.registerTool(
      'screenshot',
      { description: toolDescriptions.screenshot, inputSchema: toolInputSchemas.screenshot },
      handlers.screenshot
    );
    server.registerTool(
      'export_state',
      { description: toolDescriptions.export_state, inputSchema: toolInputSchemas.export_state },
      handlers.export_state
    );
    server.registerTool(
      'escalate_session',
      { description: toolDescriptions.escalate_session, inputSchema: toolInputSchemas.escalate_session },
      handlers.escalate_session
    );
    server.registerTool(
      'release_session',
      { description: toolDescriptions.release_session, inputSchema: toolInputSchemas.release_session },
      handlers.release_session
    );

    return server;
  };
}
