import * as z from 'zod/v4';

import { defineTool, defineTools, text } from '../types.js';
import { pageId, sessionId } from './common.js';

/** Tools that drive a tab: moving it somewhere and acting on the page. */
export const interactionTools = defineTools({
  navigate: defineTool({
    description: 'Navigate a session\'s tab to a URL.',
    inputSchema: z.object({
      sessionId,
      pageId,
      url: z.string().describe('URL to navigate the tab to.'),
      waitUntil: z
        .enum(['load', 'domcontentloaded', 'networkidle', 'commit'])
        .optional()
        .describe('Playwright navigation wait condition. Defaults to "load".')
    }),
    async handler(ctx, args) {
      const target = ctx.sessions.resolve(args.sessionId, args.pageId);
      await target.page.goto(args.url, args.waitUntil ? { waitUntil: args.waitUntil } : undefined);
      return text({ pageId: target.pageId, url: target.page.url(), title: await target.page.title().catch(() => '') });
    }
  }),

  click: defineTool({
    description: 'Click an element in a session\'s tab.',
    inputSchema: z.object({
      sessionId,
      pageId,
      selector: z.string().describe('Playwright selector (CSS, text=, role=, etc.) of the element to click.')
    }),
    async handler(ctx, args) {
      const target = ctx.sessions.resolve(args.sessionId, args.pageId);
      await target.page.click(args.selector);
      return text({ ok: true, pageId: target.pageId });
    }
  }),

  fill: defineTool({
    description: 'Fill a form field in a session\'s tab.',
    inputSchema: z.object({
      sessionId,
      pageId,
      selector: z.string().describe('Playwright selector of the input/textarea to fill.'),
      value: z.string().describe('Text to fill into the field.')
    }),
    async handler(ctx, args) {
      const target = ctx.sessions.resolve(args.sessionId, args.pageId);
      await target.page.fill(args.selector, args.value);
      return text({ ok: true, pageId: target.pageId });
    }
  })
});
