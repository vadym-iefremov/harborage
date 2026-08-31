import { McpServer } from '@modelcontextprotocol/server';

import { toolDefs, toolNames, type ToolName } from './tools/schemas.js';
import type { ToolContext, ToolDef, ToolHandlerConfig } from './tools/types.js';
import type { SessionStore } from './sessions.js';

/**
 * Registers one tool from its definition. The handler takes its context as
 * its first argument, so binding it here is the whole adaptation needed
 * between a `ToolDef` and what `registerTool` expects.
 *
 * Taking a single `ToolDef` (rather than looping inline over `toolDefs`) is
 * what keeps `registerTool`'s overload resolution happy: `def.inputSchema`
 * and `def.handler` are one concrete pair here, not the union of all
 * fifteen. At this width the argument type is `Record<string, unknown>` on
 * both sides, so no cast is needed. Each tool's precise argument type is
 * still enforced where it matters, at its definition in `defs/`.
 */
function registerToolDef(server: McpServer, name: ToolName, def: ToolDef, ctx: ToolContext): void {
  server.registerTool(name, { description: def.description, inputSchema: def.inputSchema }, args =>
    def.handler(ctx, args)
  );
}

/**
 * Builds the `createServer` factory `createMcpHandler` needs. Each HTTP
 * request gets a fresh `McpServer` instance (that's the SDK's per-request
 * model, see docs/superpowers/specs), but every instance registers tools
 * that share the *same* `ToolContext`, and so the same `SessionStore`, which
 * is the actual shared, long-lived state: the browser sessions themselves
 * outlive any single request, only the protocol-level `McpServer` object is
 * per-request.
 */
export function createServerFactory(sessions: SessionStore, config: ToolHandlerConfig) {
  const ctx: ToolContext = { sessions, config };

  return function createServer(): McpServer {
    const server = new McpServer({ name: 'harborage', version: '0.2.0' });

    for (const name of toolNames) {
      registerToolDef(server, name, toolDefs[name], ctx);
    }

    return server;
  };
}
