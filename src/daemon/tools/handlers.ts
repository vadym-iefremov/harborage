import type * as z from 'zod/v4';

import type { SessionStore } from '../sessions.js';
import { toolDefs, toolNames, type ToolName } from './schemas.js';
import type { ToolContext, ToolDef, ToolHandlerConfig, ToolResult } from './types.js';

export type { ContentBlock, ToolContext, ToolHandlerConfig, ToolResult } from './types.js';

/** The parsed argument object one tool takes. */
type Args<K extends ToolName> = z.infer<(typeof toolDefs)[K]['inputSchema']>;

/**
 * A tool whose fields are all optional (or which takes none at all) can be
 * called with no argument, which is how `handlers.list_sessions()` reads at
 * the call site.
 */
type BoundHandler<K extends ToolName> = Record<string, never> extends Args<K>
  ? (args?: Args<K>) => Promise<ToolResult>
  : (args: Args<K>) => Promise<ToolResult>;

export type ToolHandlers = { [K in ToolName]: BoundHandler<K> };

/**
 * Runs one tool, with its session marked in flight for the duration of the
 * call.
 *
 * This is the single choke point every tool call passes through on its way
 * to a handler, which is why the bookkeeping lives here rather than in
 * fifteen tool definitions: a tool added tomorrow gets it for free, and no
 * tool can forget it. The `finally` is load-bearing: an in-flight count
 * that leaks on the error path leaves a session that can never be reaped,
 * which is a worse failure than the one this fixes.
 */
export async function invokeTool(
  def: ToolDef,
  ctx: ToolContext,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const sessionId = typeof args.sessionId === 'string' ? args.sessionId : undefined;
  // Tools that name no session (create_session, list_sessions) have nothing
  // to keep alive; an unknown sessionId is the handler's to complain about,
  // so that callers keep getting the real SessionNotFoundError.
  if (sessionId === undefined || !ctx.sessions.beginCall(sessionId)) return def.handler(ctx, args);

  try {
    return await def.handler(ctx, args);
  } finally {
    ctx.sessions.endCall(sessionId);
  }
}

/**
 * Binds one `ToolContext` into every tool's handler, producing the flat
 * `handlers.navigate(args)` shape the daemon and the tests both use. The
 * definitions themselves live in `defs/`; this is only the binding step,
 * kept here so it has no dependency on the MCP SDK's types.
 */
export function createToolHandlers(sessions: SessionStore, config: ToolHandlerConfig): ToolHandlers {
  const ctx: ToolContext = { sessions, config };

  const bound: Record<string, (args?: Record<string, unknown>) => Promise<ToolResult>> = {};
  for (const name of toolNames) {
    const def: ToolDef = toolDefs[name];
    // `args` is optional so a zero-field tool can be called bare; the schema
    // has already been validated by the MCP layer by the time we get here.
    bound[name] = (args?: Record<string, unknown>) => invokeTool(def, ctx, args ?? {});
  }
  // One cast, at the one place the loop's per-name types are erased: inside
  // the loop `name` is a union, so TypeScript cannot see that every key of
  // ToolHandlers gets filled in. The loop over `toolNames` guarantees it.
  return bound as unknown as ToolHandlers;
}
