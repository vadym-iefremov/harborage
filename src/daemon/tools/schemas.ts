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
    fullPage: z.boolean().optional().describe('Capture the full scrollable page instead of just the viewport.')
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
  screenshot: 'Take a screenshot of a session\'s tab. Returned inline as image data, never written to disk.',
  export_state: 'Export a session\'s current storage state (cookies + localStorage), for seeding future sessions via create_session.',
  escalate_session: 'Hand a session over for human hands-on control (e.g. stuck on a CAPTCHA). Returns a Chrome DevTools Protocol WebSocket URL a human can attach to.',
  release_session: 'Close a session and free its resources.'
};

export const toolNames = Object.keys(toolInputSchemas) as ToolName[];
