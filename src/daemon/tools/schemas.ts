import * as z from 'zod/v4';

/**
 * The single source of truth for every tool's name, description, and input
 * schema. Both the daemon (which implements these tools for real) and the
 * client wrapper (which registers pass-through tools with the exact same
 * shape, then forwards each call to the daemon over HTTP) import from here,
 * so the two can never silently drift apart.
 */

const sessionId = z.string().min(1).describe('Session id returned by create_session.');

const pageId = z
  .string()
  .optional()
  .describe('Tab id from list_tabs. Defaults to the session\'s most recently active tab.');

const clear = z
  .boolean()
  .optional()
  .describe('If true, clears the returned entries from the buffer after reading them (default false: peek without clearing).');

export const toolInputSchemas = {
  create_session: z.object({
    storageState: z
      .unknown()
      .optional()
      .describe(
        'Storage state previously returned by export_state (cookies + localStorage), used to seed this session so it starts already logged in / already set up.'
      )
  }),
  navigate: z.object({
    sessionId,
    pageId,
    url: z.string().describe('URL to navigate the tab to.'),
    waitUntil: z
      .enum(['load', 'domcontentloaded', 'networkidle', 'commit'])
      .optional()
      .describe('Playwright navigation wait condition. Defaults to "load".')
  }),
  click: z.object({
    sessionId,
    pageId,
    selector: z.string().describe('Playwright selector (CSS, text=, role=, etc.) of the element to click.')
  }),
  fill: z.object({
    sessionId,
    pageId,
    selector: z.string().describe('Playwright selector of the input/textarea to fill.'),
    value: z.string().describe('Text to fill into the field.')
  }),
  evaluate: z.object({
    sessionId,
    pageId,
    expression: z
      .string()
      .describe('JavaScript expression evaluated in the page context. The resolved value is JSON-serialized back.')
  }),
  snapshot: z.object({
    sessionId,
    pageId
  }),
  list_tabs: z.object({
    sessionId
  }),
  screenshot: z.object({
    sessionId,
    pageId,
    fullPage: z.boolean().optional().describe('Capture the full scrollable page instead of just the viewport.'),
    mode: z
      .enum(['inline', 'cached'])
      .optional()
      .describe(
        '"inline" (default): return the PNG as base64 image data, written nowhere. ' +
          '"cached": write the PNG to a local cache directory instead (auto-expiring after HARBORAGE_SCREENSHOT_CACHE_TTL_MS) and return a file reference (path, cacheId, expiresAt) rather than the image bytes — use this for large or repeated screenshots you do not want bloating the conversation.'
      )
  }),
  export_state: z.object({
    sessionId
  }),
  escalate_session: z.object({
    sessionId,
    pageId,
    reason: z.string().describe('Why this session needs a human, e.g. "stuck on CAPTCHA" or "ambiguous form".')
  }),
  release_session: z.object({
    sessionId
  }),
  list_sessions: z.object({}),
  read_console: z.object({
    sessionId,
    pageId,
    clear
  }),
  list_network_requests: z.object({
    sessionId,
    pageId,
    clear
  }),
  send_cdp_command: z.object({
    sessionId,
    pageId,
    method: z
      .string()
      .describe('Chrome DevTools Protocol method name, e.g. "Page.getLayoutMetrics" or "Network.getResponseBody".'),
    params: z.unknown().optional().describe('Params object for the CDP method, if the method takes any.')
  })
} as const;

export type ToolName = keyof typeof toolInputSchemas;

export const toolDescriptions: Record<ToolName, string> = {
  create_session: 'Create a new isolated browser session (optionally seeded from previously exported storage state). Returns a sessionId.',
  navigate: 'Navigate a session\'s tab to a URL.',
  click: 'Click an element in a session\'s tab.',
  fill: 'Fill a form field in a session\'s tab.',
  evaluate: 'Evaluate a JavaScript expression in a session\'s tab and return the result.',
  snapshot: 'Get an AI-readable accessibility snapshot of a session\'s tab (structure + text, not pixels).',
  list_tabs: 'List the open tabs in a session.',
  screenshot: 'Take a screenshot of a session\'s tab. Default: inline base64, never written to disk. mode: "cached" instead writes it to a TTL-expiring local cache and returns a reference.',
  export_state: 'Export a session\'s current storage state (cookies + localStorage), for seeding future sessions via create_session.',
  escalate_session: 'Hand a session over for human hands-on control (e.g. stuck on a CAPTCHA). Returns a Chrome DevTools Protocol WebSocket URL a human can attach to.',
  release_session: 'Close a session and free its resources.',
  list_sessions: 'List every currently active session machine-wide (sessionId, createdAt, lastActivity, current tab URL) — not scoped to the caller. Use this to discover sessions without already knowing a sessionId.',
  read_console: 'Read buffered browser console messages for a session (optionally filtered to one tab). Buffering starts at create_session, so this returns history, not just future messages.',
  list_network_requests: 'List buffered network requests/responses for a session (optionally filtered to one tab). Buffering starts at create_session.',
  send_cdp_command: 'Send a raw Chrome DevTools Protocol command directly to a session\'s tab and get the structured result back — an agent-facing equivalent of escalate_session\'s human-facing CDP access.'
};

export const toolNames = Object.keys(toolInputSchemas) as ToolName[];
