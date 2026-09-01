import * as z from 'zod/v4';

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
 * Edit distance, used only to decide whether an unrecognized key is close
 * enough to a real one to be worth guessing at. Iterative, not recursive:
 * these keys are a handful of characters each, so the classic O(n*m) table
 * is plenty, and it never risks a stack blowing up on adversarial input.
 */
function levenshtein(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const distances: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (let i = 0; i < rows; i++) distances[i][0] = i;
  for (let j = 0; j < cols; j++) distances[0][j] = j;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      distances[i][j] =
        a[i - 1] === b[j - 1]
          ? distances[i - 1][j - 1]
          : 1 + Math.min(distances[i - 1][j], distances[i][j - 1], distances[i - 1][j - 1]);
    }
  }
  return distances[a.length][b.length];
}

/** How close a misspelled key has to be to a real one before it is worth guessing at, rather than left unexplained. */
const maxSuggestionDistance = 3;

function closestValidKey(key: string, validKeys: string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = maxSuggestionDistance + 1;
  for (const candidate of validKeys) {
    const distance = levenshtein(key, candidate);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return bestDistance <= maxSuggestionDistance ? best : undefined;
}

/**
 * Rejects any key a caller passes that is not one of a schema's own fields,
 * with a message that names the offending key and, when a real parameter
 * looks close enough to be the one that was meant, guesses which.
 *
 * A plain `z.object(...)` silently drops a key it does not recognize rather
 * than rejecting it, which is fine for a hand-written caller but not for an
 * LLM one, which invents plausible parameter names constantly. Verified
 * against the real transport: `wait_for` called with `{ timeout: 2000 }`
 * (the schema's field is `timeoutMs`) had the typo discarded and ran with
 * the 10000ms default, returning after 10007ms, five times what the caller
 * actually asked for; a second call with an invented `wibble` key was
 * accepted without complaint. Applied once here, in the one place every
 * tool's schema passes through, rather than in 58 separate `z.object` calls.
 */
function rejectUnknownKeys<S extends z.ZodObject<any>>(schema: S): S {
  const validKeys = Object.keys(schema.shape);
  return z.strictObject(schema.shape, {
    error: issue => {
      if (issue.code !== 'unrecognized_keys') return undefined;
      const named = issue.keys.map(key => {
        const suggestion = closestValidKey(key, validKeys);
        return suggestion === undefined ? `"${key}"` : `"${key}" (did you mean "${suggestion}"?)`;
      });
      return (
        `Unrecognized parameter${issue.keys.length > 1 ? 's' : ''}: ${named.join(', ')}. ` +
        `Valid parameters for this tool: ${validKeys.join(', ')}.`
      );
    }
  }) as unknown as S;
}

/**
 * Identity helper for everything except the schema, which it also makes
 * strict (see `rejectUnknownKeys`). Otherwise pins one tool's schema type so
 * the handler's `args` is inferred from `inputSchema` instead of falling
 * back to the loose default.
 */
export function defineTool<S extends z.ZodObject<any>>(def: ToolDef<S>): ToolDef<S> {
  return { ...def, inputSchema: rejectUnknownKeys(def.inputSchema) };
}

/**
 * Identity helper for a whole table of tools. Checks every entry really is a
 * `ToolDef` while keeping the exact key literals, which is what makes
 * `ToolName` a precise union downstream.
 */
export function defineTools<T extends Record<string, ToolDef<any>>>(defs: T): T {
  return defs;
}
