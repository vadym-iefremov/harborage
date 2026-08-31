import type * as z from 'zod/v4';

import type { SessionStore } from '../sessions.js';

/** A tool result content block, matching what `@modelcontextprotocol/server` expects back from a handler. */
export type ContentBlock = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

/** What every tool handler resolves to. */
export type ToolResult = { content: ContentBlock[]; structuredContent?: unknown; isError?: boolean };

/** Wraps a value as a tool result: strings go through as-is, anything else is JSON-serialized. */
export function text(value: unknown): ToolResult {
  const asText = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: 'text', text: asText }], structuredContent: typeof value === 'string' ? undefined : value };
}

/** What tool handlers need from the daemon's Config, kept narrow so tests can pass a minimal subset. */
export interface ToolHandlerConfig {
  debugPort: number;
  screenshotCacheDir: string;
  screenshotCacheTtlMs: number;
}

/**
 * Everything a tool handler is allowed to reach for: the daemon's live
 * `SessionStore` plus the handful of config values a few tools need directly
 * (the CDP debug port for escalate_session, the screenshot cache directory
 * and TTL for screenshot's `mode: 'cached'`).
 */
export interface ToolContext {
  sessions: SessionStore;
  config: ToolHandlerConfig;
}

/**
 * One tool, defined in exactly one place: its description, its Zod input
 * schema and its handler.
 *
 * The handler takes its context as the FIRST ARGUMENT rather than closing
 * over it. That is deliberate: it keeps every definition a plain module-level
 * value, so the client wrapper can import the same table purely for its
 * descriptions and schemas without ever needing a `SessionStore` (or a
 * browser) in the process.
 */
export interface ToolDef<S extends z.ZodObject<any> = z.ZodObject<any>> {
  description: string;
  inputSchema: S;
  handler: (ctx: ToolContext, args: z.infer<S>) => Promise<ToolResult>;
  /**
   * True for tools that drive the virtual mouse or keyboard. Those share one
   * input device per session, so two of them running at once interleave their
   * presses and moves: a drag holding its button and a concurrent click end up
   * corrupting each other while both report success. Marked tools are
   * serialized per session by `invokeTool`. Everything else, including reads
   * and `evaluate`, still runs fully in parallel.
   */
  serializesInput?: boolean;
}

/**
 * Identity helper that pins one tool's schema type so the handler's `args`
 * is inferred from `inputSchema` instead of falling back to the loose
 * default. Purely a type-level aid: it returns exactly what it is given.
 */
export function defineTool<S extends z.ZodObject<any>>(def: ToolDef<S>): ToolDef<S> {
  return def;
}

/**
 * Identity helper for a whole table of tools. Checks every entry really is a
 * `ToolDef` while keeping the exact key literals, which is what makes
 * `ToolName` a precise union downstream.
 */
export function defineTools<T extends Record<string, ToolDef<any>>>(defs: T): T {
  return defs;
}
