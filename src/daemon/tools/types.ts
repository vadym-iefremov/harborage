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

/** The most a suggestion may ever differ from the key it is guessing at, however long both are. */
const maxSuggestionDistance = 3;

/**
 * Picks the real parameter a misspelled key probably meant, or nothing when
 * no candidate is close enough to be worth saying out loud.
 *
 * The budget scales with the shorter of the two names, and this matters far
 * more at depth than it did at the top level. A flat distance of 3 is a
 * reasonable guess against names like "timeoutMs", where three edits still
 * leaves most of the word intact, and nonsense against the short names
 * nested shapes are full of: with a flat budget, `{ ttl: 60 }` in a cookie
 * confidently suggested "url" and `{ top: 0 }` in a clip region suggested
 * "x", neither of which shares so much as a first letter. Measured across
 * nested keys, most suggestions were that bad. A confidently wrong
 * suggestion is worse than no suggestion: it sends a caller to rename a
 * field rather than to look up which field they actually wanted.
 *
 * Half the shorter name, capped at 3. "timeout" to "timeoutMs" is 2 edits
 * against a budget of 3 and still suggested; "ttl" to "url" is 2 against a
 * budget of 1 and is not.
 */
function closestValidKey(key: string, validKeys: string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of validKeys) {
    const distance = levenshtein(key, candidate);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  if (best === undefined) return undefined;
  const budget = Math.min(maxSuggestionDistance, Math.floor(Math.min(key.length, best.length) / 2));
  return bestDistance <= budget ? best : undefined;
}

/** How a nested path is written back to a caller: `cookies[0].maxAge` rather than `cookies,0,maxAge`. */
function formatPath(path: readonly (string | number | symbol)[]): string {
  return path
    .map(segment => (typeof segment === 'number' ? `[${segment}]` : `.${String(segment)}`))
    .join('')
    .replace(/^\./, '');
}

/**
 * Builds the "you passed a key that is not a parameter" message for one
 * object level in a tool's schema.
 *
 * `topLevelKeys` is the tool's OWN parameter list, threaded down into every
 * nested level for one specific reason: the most common nested mistake is a
 * real parameter put one level too deep. `viewport: { width, height,
 * deviceScaleFactor }` is the canonical case, since deviceScaleFactor is a
 * genuine create_session parameter that simply does not belong inside
 * viewport. Told only "unrecognized parameter deviceScaleFactor" a caller
 * has no reason to think the name was right and the place was wrong, so
 * that case says exactly that instead of guessing at a near-miss.
 */
function unknownKeysError(
  validKeys: string[],
  topLevelKeys: string[]
): (issue: { code: string; keys?: string[]; path?: readonly (string | number | symbol)[] }) => string | undefined {
  return issue => {
    if (issue.code !== 'unrecognized_keys') return undefined;
    const keys = issue.keys ?? [];
    // Empty at the top level, and the path to the offending object anywhere
    // below it. This is what makes a nested rejection say WHERE: without it,
    // "unrecognized parameter offsetX" leaves a caller to work out which of
    // drag's two endpoint objects it came from.
    const path = formatPath(issue.path ?? []);
    const scope = path === '' ? 'this tool' : `"${path}"`;
    // No "in this tool" at the top level: that is where a caller already
    // knows it is, and the original wording of this message is what every
    // existing caller (and test) reads.
    const where = path === '' ? '' : ` in ${scope}`;
    const named = keys.map(key => {
      if (path !== '' && topLevelKeys.includes(key)) {
        return `"${key}" (that is a parameter of the tool itself, not of ${scope}: move it to the top level)`;
      }
      const suggestion = closestValidKey(key, validKeys);
      return suggestion === undefined ? `"${key}"` : `"${key}" (did you mean "${suggestion}"?)`;
    });
    return (
      `Unrecognized parameter${keys.length > 1 ? 's' : ''}${where}: ${named.join(', ')}. ` +
      `Valid parameters for ${scope}: ${validKeys.join(', ')}.`
    );
  };
}

/**
 * Rejects any key a caller passes that is not one of a schema's own fields,
 * at EVERY depth, with a message that names the offending key, says which
 * object it appeared in, and, when a real parameter looks close enough to be
 * the one that was meant, guesses which.
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
 *
 * Depth matters as much as the top level, and for the same reason. Wrapping
 * only the outermost object left every nested shape silently lossy, and the
 * cases were not exotic: `create_session({ networkCaptureFilter: {
 * urlIncludes, minStatus } })` dropped minStatus while the docs told callers
 * to paste read filters straight in; `viewport: { ..., deviceScaleFactor }`
 * dropped a real parameter put one level too deep; `cookies[].maxAge` and
 * `drag.source.offsetX` both vanished. Each of those runs the tool with
 * different arguments than the caller asked for and reports success.
 *
 * What is deliberately NOT touched: anything that is genuinely open-ended.
 * `z.unknown()` (create_session's storageState, send_cdp_command's params)
 * and `z.record()` (add_route_rule's headers and overrideHeaders) pass
 * through untouched, because arbitrary keys ARE the payload there. The walk
 * only rewrites object shapes, so an open-ended value stays open-ended
 * however deeply it is nested.
 */
function deepStrict<T extends z.ZodType>(schema: T, topLevelKeys: string[]): T {
  const def = schema.def as unknown as Record<string, unknown> & { type: string };
  // Rebuilding a schema loses its description (it lives in Zod's metadata
  // registry, keyed by the instance), so it is reattached rather than
  // silently dropped: these descriptions are the tool documentation a caller
  // actually reads.
  const withDescription = (next: z.ZodType): T => {
    const description = schema.description;
    return (description === undefined ? next : next.describe(description)) as T;
  };
  // clone() is used rather than rebuilding with z.array()/z.object(), because
  // it carries every other part of the definition across: `.min(1)` on
  // set_cookies' array, for one, which a naive rebuild would quietly discard.
  const clone = (patch: Record<string, unknown>): T =>
    withDescription((schema as unknown as { clone: (d: unknown) => z.ZodType }).clone({ ...def, ...patch }));

  switch (def.type) {
    case 'object': {
      const shape = (schema as unknown as z.ZodObject<any>).shape;
      const nextShape: Record<string, z.ZodType> = {};
      for (const [key, value] of Object.entries(shape)) {
        nextShape[key] = deepStrict(value as z.ZodType, topLevelKeys);
      }
      return clone({ shape: nextShape, catchall: z.never(), error: unknownKeysError(Object.keys(nextShape), topLevelKeys) });
    }
    case 'array':
      return clone({ element: deepStrict(def.element as z.ZodType, topLevelKeys) });
    // Every single-wrapper type Zod expresses as an `innerType`. Listed
    // explicitly rather than sniffed for an innerType property, so a wrapper
    // added by a future Zod version falls through to the default and is left
    // alone instead of being rebuilt on a guess.
    case 'optional':
    case 'nullable':
    case 'default':
    case 'prefault':
    case 'nonoptional':
    case 'readonly':
    case 'catch':
      return clone({ innerType: deepStrict(def.innerType as z.ZodType, topLevelKeys) });
    case 'union':
      return clone({ options: (def.options as z.ZodType[]).map(option => deepStrict(option, topLevelKeys)) });
    case 'tuple':
      return clone({
        items: (def.items as z.ZodType[]).map(item => deepStrict(item, topLevelKeys)),
        ...(def.rest ? { rest: deepStrict(def.rest as z.ZodType, topLevelKeys) } : {})
      });
    case 'record':
      // The KEYS stay open (that is the point of a record); only an object
      // sitting in the value position gets the same treatment as anywhere else.
      return clone({ valueType: deepStrict(def.valueType as z.ZodType, topLevelKeys) });
    default:
      // Strings, numbers, enums, literals, unknown, any, and anything else
      // with no object shape underneath it. Nothing to tighten.
      return schema;
  }
}

/**
 * Identity helper for everything except the schema, which it also makes
 * strict at every depth (see `deepStrict`). Otherwise pins one tool's schema
 * type so
 * the handler's `args` is inferred from `inputSchema` instead of falling
 * back to the loose default.
 */
export function defineTool<S extends z.ZodObject<any>>(def: ToolDef<S>): ToolDef<S> {
  return { ...def, inputSchema: deepStrict(def.inputSchema, Object.keys(def.inputSchema.shape)) };
}

/**
 * Identity helper for a whole table of tools. Checks every entry really is a
 * `ToolDef` while keeping the exact key literals, which is what makes
 * `ToolName` a precise union downstream.
 */
export function defineTools<T extends Record<string, ToolDef<any>>>(defs: T): T {
  return defs;
}
