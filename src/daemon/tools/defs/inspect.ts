import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Page } from 'playwright';
import * as z from 'zod/v4';

import { sessionCacheDir } from '../../screenshotCache.js';
import { defineTool, defineTools, text, type ToolResult } from '../types.js';
import { clear, pageId, sessionId } from './common.js';

/** How long a `selector` capture waits for its element before giving up. */
const defaultSelectorTimeoutMs = 5_000;

/** How long `evaluate` waits for an expression to settle before abandoning it. */
const defaultEvaluateTimeoutMs = 30_000;

const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * The capture's real size, read out of the PNG rather than out of what was
 * asked for.
 *
 * That distinction is the whole point. A CDP viewport override can change
 * what the page thinks its size is without changing what a capture actually
 * contains, and an agent comparing its request against its own request will
 * never see the difference. A PNG's IHDR is always the first chunk, so width
 * and height sit at fixed byte offsets 16 and 20 as big-endian uint32s.
 */
export function pngDimensions(buffer: Buffer): { width: number; height: number } {
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(pngSignature)) {
    throw new Error('not a PNG: the buffer does not begin with a PNG signature followed by an IHDR header');
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/**
 * Playwright dims its call log with ANSI escape codes, on the assumption that
 * a message ends up in a terminal. These end up in an agent's transcript
 * instead, where they are noise at best, so they come off here.
 */
const ansiEscape = new RegExp('\\u001b\\[[0-9;]*m', 'g');

/**
 * CDP domains Chromium routes to the BROWSER rather than to the tab a page
 * session is attached to, and which therefore reach straight past session
 * isolation.
 *
 * Measured against real Chromium rather than assumed. From an ordinary
 * page-scoped CDP session, one harborage session could:
 * - `Target.getTargets`: list every other session's tabs, with their URLs,
 *   titles and browserContextIds.
 * - `Target.closeTarget`: close another session's only tab, leaving that
 *   session alive but unusable by every tool that resolves a pageId.
 * - `Target.createTarget` with another session's browserContextId: open a
 *   tab INSIDE that session, which harborage then adopts and makes active,
 *   so the victim's next call that omits pageId runs in a tab an unrelated
 *   agent opened.
 * - `Browser.close`: terminate the single shared Chromium, destroying every
 *   session on the machine.
 *
 * Everything else stays inside the tab on its own: Chromium itself refuses
 * `SystemInfo.getInfo`, and a `browserContextId` on `Storage.getCookies`,
 * from a page session ("only supported on the browser target"), and
 * Playwright refuses `Target.createBrowserContext` and
 * `Target.disposeBrowserContext`. So the guard is exactly these two domains,
 * rather than an allow-list that would defeat the point of a raw escape hatch.
 */
const browserScopedCdpDomains = new Set(['Browser', 'Target']);

/**
 * The refusal message for a command that would leave this session, or null
 * if the command is genuinely confined to the caller's own tab.
 *
 * `Target.getTargetInfo` asked about the caller's own tab is page-scoped, and
 * is how escalate_session finds its own target id, so it stays allowed. Given
 * a `targetId` or a `browserContextId` it reads another session's tab
 * instead, so that form does not.
 */
export function cdpScopeRefusal(method: string, params: unknown): string | null {
  const domain = method.split('.')[0] ?? '';
  if (!browserScopedCdpDomains.has(domain)) return null;

  const named = typeof params === 'object' && params !== null ? (params as Record<string, unknown>) : {};
  const namesAnotherTarget = named.targetId !== undefined || named.browserContextId !== undefined;
  if (method === 'Target.getTargetInfo' && !namesAnotherTarget) return null;

  return (
    `send_cdp_command refuses "${method}": Chromium routes the ${domain} domain to the browser rather than to this ` +
    'session\'s tab, so it reaches every other session sharing this daemon\'s Chromium. Use list_tabs, new_tab, ' +
    'close_tab and select_tab for this session\'s own tabs, escalate_session for a human-drivable CDP URL, and ' +
    'release_session to end a session. Every domain outside Browser and Target is still available here.'
  );
}

function messageOf(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).replace(ansiEscape, '');
}

const clipRegion = z.object({
  x: z.number().min(0).describe('Left edge of the region, in CSS pixels from the left of the viewport.'),
  y: z.number().min(0).describe('Top edge of the region, in CSS pixels from the top of the viewport.'),
  width: z.number().positive().describe('Width of the region in CSS pixels.'),
  height: z.number().positive().describe('Height of the region in CSS pixels.')
});

type ClipRegion = z.infer<typeof clipRegion>;

/**
 * Captures one element. Playwright's own failure text already names the
 * selector, but it names it inside a wall of locator internals, so this
 * restates the two things a caller can act on: which selector failed, and
 * what would make it work.
 */
async function captureElement(page: Page, selector: string, timeoutMs: number): Promise<Buffer> {
  try {
    return await page.locator(selector).screenshot({ type: 'png', timeout: timeoutMs });
  } catch (err) {
    throw new Error(
      `screenshot of selector ${JSON.stringify(selector)} failed after up to ${timeoutMs}ms: ${messageOf(err)}. ` +
        'The selector has to match exactly one element that is attached and visible. Use snapshot to check what is ' +
        'actually on the page, raise timeoutMs if the element renders late, or narrow the selector if it matched several.'
    );
  }
}

/**
 * Captures an explicit region.
 *
 * Playwright's clip is measured against the image it is about to produce, not
 * against the document: without fullPage that image is the viewport, so a
 * region below the fold is "outside the resulting image" and throws. Since
 * fullPage and clip are rejected together anyway, clip has exactly one
 * meaning here, viewport coordinates, and the error says so rather than
 * leaving a caller to guess which of the two coordinate spaces it was in.
 */
async function captureClip(page: Page, clip: ClipRegion): Promise<Buffer> {
  try {
    return await page.screenshot({ type: 'png', clip });
  } catch (err) {
    const viewport = page.viewportSize();
    const size = viewport ? `${viewport.width}x${viewport.height}` : 'unknown';
    throw new Error(
      `screenshot with clip {x:${clip.x}, y:${clip.y}, width:${clip.width}, height:${clip.height}} failed: ` +
        `${messageOf(err)}. The clip is measured from the top left of the current viewport, which is ${size}, so a ` +
        'region below the fold is out of range. Scroll it into view first, or pass selector instead and let it ' +
        'scroll for you.'
    );
  }
}

/**
 * Playwright reports a fault inside an evaluated expression as a V8 stack
 * frame, and the position in that frame counts into the source *after*
 * Playwright has trimmed it. Verified empirically against Playwright 1.62 and
 * against its own `normalizeEvaluationExpression`, which does exactly one
 * line-affecting thing to a string expression: `expression.trim()`. So line
 * and column map 1-based onto the trimmed text, which is why the trimmed text
 * is what gets echoed back.
 *
 * The frames worth reading are the ones nested inside the evaluation
 * ("eval at evaluate (...), <anonymous>:LINE:COL"). Playwright's own harness
 * frames name the same <anonymous> file with unrelated line numbers, so
 * matching on the nesting rather than on <anonymous> is what stops a harness
 * frame being reported as the caller's fault. The first such frame is the
 * innermost one, which is where the throw actually happened.
 */
const evaluatedFrame = /eval at evaluate \([^)]*\),\s*<anonymous>:(\d+):(\d+)\)/;

function faultPosition(message: string, lineCount: number): { line: number; column: number } | undefined {
  const match = evaluatedFrame.exec(message);
  if (!match) return undefined;
  const line = Number(match[1]);
  const column = Number(match[2]);
  // A position outside the expression is not a position we can point at. It
  // would mean the frame did not come from this source after all, and a
  // marker on a line that does not exist is worse than no marker.
  if (!Number.isFinite(line) || line < 1 || line > lineCount) return undefined;
  return { line, column };
}

/** The submitted source, numbered, with the faulting line marked and a caret under the column. */
function numberedSource(source: string, fault?: { line: number; column: number }): string {
  const lines = source.split('\n');
  const gutter = String(lines.length).length;
  const out: string[] = [];
  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    const marked = fault?.line === lineNumber;
    out.push(`${marked ? '> ' : '  '}${String(lineNumber).padStart(gutter)} | ${line}`);
    if (marked) {
      const column = Math.max(1, Math.min(fault.column, line.length + 1));
      out.push(`  ${' '.repeat(gutter)} | ${' '.repeat(column - 1)}^`);
    }
  }
  return out.join('\n');
}

/** A tool result carrying the rendered report as text and the same facts as fields. */
function failure(rendered: string, payload: Record<string, unknown>): ToolResult {
  return { content: [{ type: 'text', text: rendered }], structuredContent: payload, isError: true };
}

/** Tools that read something back out of a tab: page state, pixels, buffers, raw CDP. */
export const inspectTools = defineTools({
  evaluate: defineTool({
    description:
      'Evaluate JavaScript in a session\'s tab and return the resolved value, JSON-serialized. ' +
      'The expression is a whole script, not one line: multi-line source, several statements and const/let ' +
      'declarations all work, and the value of the last expression is what comes back. A promise is awaited, so ' +
      '"(async () => { const r = await fetch(\'/api\'); return r.status; })()" returns the status, not a promise. ' +
      'Traps worth knowing: a bare function such as "() => 42" is evaluated but never called, so it silently ' +
      'returns undefined (write "(() => 42)()" instead); an expression starting with the function keyword gets ' +
      'wrapped in parentheses before evaluation, so "function f() {} f()" is a syntax error; and a bare object ' +
      'literal parses as a block, so return "({ a: 1 })". Anything not JSON-serializable (a DOM node, a function, ' +
      'window) comes back as undefined or an empty object, so return a plain summary of it instead. When the ' +
      'expression throws, the error echoes the source with line numbers and marks the line that faulted.',
    inputSchema: z.object({
      sessionId,
      pageId,
      expression: z
        .string()
        .describe('JavaScript evaluated in the page context. The resolved value is JSON-serialized back.'),
      timeoutMs: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe(
          'How long to wait for the expression to settle, in milliseconds (default 30000, 0 waits forever). ' +
            'On timeout the expression keeps running in the page: this bounds the tool call, it does not cancel ' +
            'the work.'
        )
    }),
    async handler(ctx, args) {
      const target = ctx.sessions.resolve(args.sessionId, args.pageId);
      const timeoutMs = args.timeoutMs ?? defaultEvaluateTimeoutMs;
      // Playwright trims before evaluating, so this is the text its line and
      // column numbers actually refer to.
      const source = args.expression.trim();

      // Playwright's page.evaluate takes no timeout of its own (its third
      // argument is exposeFunctions, nothing more), and an expression that
      // never settles only fails when V8 happens to garbage-collect the
      // pending promise: observed at roughly 30s with "Resulting promise was
      // garbage collected", which is luck, not a bound. Hence racing it here.
      // Promise.race has already attached handlers to the evaluation, so its
      // later rejection stays handled and never surfaces as an unhandled
      // rejection in the daemon.
      const pending = target.page.evaluate(args.expression);
      const timedOut = Symbol('timeout');
      let timer: NodeJS.Timeout | undefined;

      try {
        const raced: unknown =
          timeoutMs === 0
            ? await pending
            : await Promise.race([
                pending,
                new Promise<typeof timedOut>(resolve => {
                  timer = setTimeout(() => resolve(timedOut), timeoutMs);
                })
              ]);

        if (raced === timedOut) {
          return failure(
            `evaluate timed out after ${timeoutMs}ms waiting for this expression to settle. It is still running in ` +
              'the page: the timeout only stops harborage waiting for it. Raise timeoutMs, or make the expression ' +
              'settle on its own. The expression, as evaluated:\n' +
              numberedSource(source),
            {
              pageId: target.pageId,
              error: `evaluate timed out after ${timeoutMs}ms`,
              timedOut: true,
              timeoutMs,
              positionKnown: false,
              expression: source
            }
          );
        }

        return text({ pageId: target.pageId, result: raced });
      } catch (err) {
        const message = messageOf(err);
        const headline = message.split('\n')[0]?.replace(/^page\.evaluate:\s*/, '') ?? message;
        const fault = faultPosition(message, source.split('\n').length);

        return failure(
          `evaluate failed: ${headline}\n` +
            (fault
              ? `Fault at line ${fault.line}, column ${fault.column} of the expression as evaluated. Leading ` +
                'whitespace is trimmed off before evaluation, so the numbers count from the first line shown here:\n'
              : 'No source position was reported for this error, which is normal for a syntax error, so no line is ' +
                'marked. The expression, as evaluated:\n') +
            numberedSource(source, fault),
          {
            pageId: target.pageId,
            error: headline,
            positionKnown: fault !== undefined,
            ...(fault ? { line: fault.line, column: fault.column } : {}),
            expression: source,
            stack: message
          }
        );
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
  }),

  snapshot: defineTool({
    description: 'Get an AI-readable accessibility snapshot of a session\'s tab (structure and text, not pixels).',
    inputSchema: z.object({
      sessionId,
      pageId
    }),
    async handler(ctx, args) {
      const target = ctx.sessions.resolve(args.sessionId, args.pageId);
      const snapshot = await target.page.locator('body').ariaSnapshot({ mode: 'ai' });
      return text({ pageId: target.pageId, url: target.page.url(), snapshot });
    }
  }),

  screenshot: defineTool({
    description:
      'Capture pixels from a session\'s tab as a PNG. Every result reports the capture\'s real width and height, ' +
      'read back out of the PNG itself rather than from what was requested, so a viewport that is not what you ' +
      'assumed is visible without opening the file. ' +
      'Scope: the default is the whole viewport. Pass selector to capture one element, or clip for an explicit ' +
      'region, when what you care about is a small part of a large page. selector, clip and fullPage are mutually ' +
      'exclusive, and a contradictory combination is rejected rather than quietly half-applied. ' +
      'What comes back depends on mode: "inline" (the default) returns the PNG as base64 image data, which you can ' +
      'look at directly. "cached" returns a file path and nothing viewable, so seeing it costs a separate file read. ' +
      'Choose "inline" when you intend to look at the image now, and "cached" for bulk or repeated captures you do ' +
      'not want filling up the conversation.',
    inputSchema: z.object({
      sessionId,
      pageId,
      fullPage: z
        .boolean()
        .optional()
        .describe(
          'Capture the full scrollable page instead of just the viewport. Cannot be combined with selector or clip.'
        ),
      selector: z
        .string()
        .optional()
        .describe(
          'CSS or Playwright selector for a single element to capture, scrolled into view first. Must match exactly ' +
            'one attached, visible element. Cannot be combined with clip or fullPage.'
        ),
      clip: clipRegion
        .optional()
        .describe(
          'Explicit region to capture, in CSS pixels measured from the top left of the current viewport, the same ' +
            'coordinates getBoundingClientRect returns. A region reaching past the edge of the viewport is ' +
            'truncated to what is on screen, and the reported width and height are what you actually got. For ' +
            'something below the fold, scroll it into view first, or use selector, which scrolls for you. Cannot be ' +
            'combined with selector or fullPage.'
        ),
      timeoutMs: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('How long to wait for selector to match, in milliseconds (default 5000). Ignored without selector.'),
      mode: z
        .enum(['inline', 'cached'])
        .optional()
        .describe(
          '"inline" (default): return the PNG as base64 image data, written nowhere. ' +
            '"cached": write the PNG into this session\'s own directory of the local cache, which auto-expires ' +
            'after HARBORAGE_SCREENSHOT_CACHE_TTL_MS, and return only a reference to it (path, cacheId, width, ' +
            'height, expiresAt). Nothing viewable comes back in this mode: read the path to see the image.'
        )
    }),
    async handler(ctx, args) {
      const target = ctx.sessions.resolve(args.sessionId, args.pageId);

      // Rejecting a contradiction beats honouring one argument and dropping
      // the other: a silently ignored argument is exactly how an agent ends
      // up trusting evidence that answers a different question.
      if (args.selector !== undefined && args.clip !== undefined) {
        throw new Error(
          'screenshot takes selector or clip, not both: they are two ways of asking for the same thing. Pass ' +
            'selector to capture an element, or clip to capture a fixed region.'
        );
      }
      if (args.fullPage && (args.selector !== undefined || args.clip !== undefined)) {
        throw new Error(
          'screenshot cannot combine fullPage with selector or clip: fullPage captures the whole scrollable page, ' +
            'while selector and clip capture one part of it. Pick one.'
        );
      }

      const buffer =
        args.selector !== undefined
          ? await captureElement(target.page, args.selector, args.timeoutMs ?? defaultSelectorTimeoutMs)
          : args.clip !== undefined
            ? await captureClip(target.page, args.clip)
            : await target.page.screenshot({ type: 'png', fullPage: args.fullPage ?? false });

      const { width, height } = pngDimensions(buffer);
      const scope =
        args.selector !== undefined
          ? 'element'
          : args.clip !== undefined
            ? 'clip'
            : args.fullPage
              ? 'fullPage'
              : 'viewport';
      const common = {
        pageId: target.pageId,
        scope,
        ...(args.selector !== undefined ? { selector: args.selector } : {}),
        ...(args.clip !== undefined ? { clip: args.clip } : {}),
        width,
        height,
        sizeBytes: buffer.length
      };

      if (args.mode === 'cached') {
        const { screenshotCacheDir, screenshotCacheTtlMs } = ctx.config;
        // One directory per session, so parallel agents cannot read each
        // other's evidence out of a shared namespace.
        const dir = sessionCacheDir(screenshotCacheDir, target.session.id);
        await mkdir(dir, { recursive: true });
        const cacheId = randomUUID();
        const filePath = join(dir, `${cacheId}.png`);
        await writeFile(filePath, buffer);
        return text({
          ...common,
          mode: 'cached',
          cacheId,
          path: filePath,
          expiresAt: new Date(Date.now() + screenshotCacheTtlMs).toISOString()
        });
      }

      // Default: inline base64, never written to disk. The image block stays
      // first so a caller reading content[0] still finds the picture, and the
      // dimensions ride alongside it rather than replacing it.
      const meta = { ...common, mode: 'inline' };
      return {
        content: [
          { type: 'image', data: buffer.toString('base64'), mimeType: 'image/png' },
          { type: 'text', text: JSON.stringify(meta, null, 2) }
        ],
        structuredContent: meta
      };
    }
  }),

  read_console: defineTool({
    description:
      'Read buffered browser console messages for a session (optionally filtered to one tab). Buffering starts at ' +
      'create_session, so this returns history, not just future messages. The buffer is bounded ' +
      '(HARBORAGE_CONSOLE_BUFFER_SIZE, 200 by default) and drops the oldest messages once full, so a message that ' +
      'is missing may have been evicted rather than never logged. Every result reports total (messages in the ' +
      'buffer) next to returned (messages that matched), so you can see how much a filter hid. ' +
      'clear: true drains the entire buffer for the session, not only the messages a filter returned.',
    inputSchema: z.object({
      sessionId,
      pageId,
      clear,
      types: z
        .array(z.string())
        .optional()
        .describe(
          'Keep only messages of these console types, e.g. ["error", "warning"] for just the problems. Types come ' +
            'from the browser: "log", "info", "warning", "error", "debug", "trace" and friends.'
        ),
      textIncludes: z
        .string()
        .optional()
        .describe('Keep only messages whose text contains this substring, matched case-insensitively.')
    }),
    async handler(ctx, args) {
      const entries = ctx.sessions.getConsoleMessages(args.sessionId, args.pageId, args.clear ?? false);
      const wanted = args.types !== undefined ? new Set(args.types.map(t => t.toLowerCase())) : undefined;
      const needle = args.textIncludes?.toLowerCase();

      const messages = entries.filter(entry => {
        if (wanted !== undefined && !wanted.has(entry.type.toLowerCase())) return false;
        if (needle !== undefined && !entry.text.toLowerCase().includes(needle)) return false;
        return true;
      });

      return text({ total: entries.length, returned: messages.length, messages });
    }
  }),

  list_network_requests: defineTool({
    description:
      'List buffered network requests and responses for a session (optionally filtered to one tab). Buffering starts ' +
      'at create_session, and the buffer is bounded (HARBORAGE_NETWORK_BUFFER_SIZE, 200 by default): once it is ' +
      'full the oldest entries are dropped, so an empty result can mean "evicted", not "never happened". Every ' +
      'result reports total (entries in the buffer) next to returned (entries that matched), so you can see how ' +
      'much a filter hid. ' +
      'One HTTP exchange shows up as two entries: a request entry carrying method and resourceType, and a response ' +
      'entry carrying status. No single filter spans both, so "the POST that failed" is two calls, one with ' +
      'method: "POST" and one with minStatus: 400. Filters combine with AND. ' +
      'clear: true drains the entire buffer for the session, not only the entries a filter returned.',
    inputSchema: z.object({
      sessionId,
      pageId,
      clear,
      urlIncludes: z
        .string()
        .optional()
        .describe('Keep only entries whose URL contains this substring, matched case-insensitively.'),
      urlMatches: z
        .string()
        .optional()
        .describe(
          'Keep only entries whose URL matches this JavaScript regular expression source, e.g. "/api/.*/save$".'
        ),
      method: z
        .string()
        .optional()
        .describe(
          'Keep only request entries with this HTTP method, matched case-insensitively. This drops every response ' +
            'entry, since responses carry no method.'
        ),
      minStatus: z
        .number()
        .int()
        .optional()
        .describe(
          'Keep only response entries with a status at or above this, so minStatus: 400 is "just the failures". ' +
            'This drops every request entry, since requests carry no status.'
        ),
      maxStatus: z
        .number()
        .int()
        .optional()
        .describe('Keep only response entries with a status at or below this. Combine with minStatus for a range.'),
      resourceType: z
        .string()
        .optional()
        .describe(
          'Keep only entries of this Playwright resource type, e.g. "document", "xhr", "fetch", "image", "script". ' +
            'Only request entries carry one.'
        ),
      direction: z.enum(['request', 'response']).optional().describe('Keep only one side of each exchange.')
    }),
    async handler(ctx, args) {
      let pattern: RegExp | undefined;
      if (args.urlMatches !== undefined) {
        try {
          pattern = new RegExp(args.urlMatches);
        } catch (err) {
          throw new Error(`urlMatches is not a valid regular expression: ${messageOf(err)}`);
        }
      }

      const entries = ctx.sessions.getNetworkEntries(args.sessionId, args.pageId, args.clear ?? false);
      const needle = args.urlIncludes?.toLowerCase();
      const method = args.method?.toUpperCase();

      const requests = entries.filter(entry => {
        if (args.direction !== undefined && entry.direction !== args.direction) return false;
        if (needle !== undefined && !entry.url.toLowerCase().includes(needle)) return false;
        if (pattern !== undefined && !pattern.test(entry.url)) return false;
        if (method !== undefined && entry.method?.toUpperCase() !== method) return false;
        if (args.resourceType !== undefined && entry.resourceType !== args.resourceType) return false;
        if (args.minStatus !== undefined && !(entry.status !== undefined && entry.status >= args.minStatus)) return false;
        if (args.maxStatus !== undefined && !(entry.status !== undefined && entry.status <= args.maxStatus)) return false;
        return true;
      });

      // total counts the buffer, returned counts the matches: an agent seeing
      // "0 of 200" knows its filter was wrong, while "0 of 0" says the traffic
      // genuinely was not there, or has already aged out.
      return text({ total: entries.length, returned: requests.length, requests });
    }
  }),

  send_cdp_command: defineTool({
    description:
      'Send a raw Chrome DevTools Protocol command directly to a session\'s tab and get the structured result back. ' +
      'This is the agent-facing counterpart to escalate_session\'s human-facing CDP access. ' +
      'Not for captures: Page.captureScreenshot hands back bare base64 with no dimensions and no route into the ' +
      'screenshot cache, so use the screenshot tool, with selector or clip, for anything you want to look at. ' +
      'The Browser and Target domains are REFUSED, because Chromium routes them to the browser rather than to your ' +
      'tab: through them one session could list, close and even open tabs inside other sessions, and close the ' +
      'shared Chromium every session on this machine is using. Use list_tabs, new_tab, close_tab and select_tab for ' +
      'your own tabs instead. Target.getTargetInfo about your own tab (no targetId) is still allowed. ' +
      'Also note this tool DETACHES after every call, so any Emulation.set*Override sent through it is reverted ' +
      'before the result comes back: use set_user_agent, set_timezone, set_locale and set_network_conditions, which ' +
      'hold their CDP session open.',
    inputSchema: z.object({
      sessionId,
      pageId,
      method: z
        .string()
        .describe('Chrome DevTools Protocol method name, e.g. "Page.getLayoutMetrics" or "Network.getResponseBody".'),
      params: z.unknown().optional().describe('Params object for the CDP method, if the method takes any.')
    }),
    async handler(ctx, args) {
      // Before resolving anything: a command that would leave this session is
      // refused outright rather than sent and then regretted.
      const refusal = cdpScopeRefusal(args.method, args.params);
      if (refusal !== null) throw new Error(refusal);

      const target = ctx.sessions.resolve(args.sessionId, args.pageId);
      const cdpSession = await target.session.context.newCDPSession(target.page);
      try {
        // `method` is a runtime string, not one of Playwright's literal CDP
        // method types. This is deliberately the agent-facing "raw" escape
        // hatch, so the cast is the point, not a workaround. Called directly
        // on `cdpSession` (not detached into a standalone function) so its
        // internal `this` binding stays intact.
        const result = await cdpSession.send(args.method as Parameters<typeof cdpSession.send>[0], args.params as never);
        return text({ sessionId: args.sessionId, pageId: target.pageId, method: args.method, result });
      } finally {
        await cdpSession.detach().catch(() => {});
      }
    }
  })
});
