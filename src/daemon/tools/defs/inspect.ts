import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import * as z from 'zod/v4';

import { defineTool, defineTools, text } from '../types.js';
import { clear, pageId, sessionId } from './common.js';

/** Tools that read something back out of a tab: page state, pixels, buffers, raw CDP. */
export const inspectTools = defineTools({
  evaluate: defineTool({
    description: 'Evaluate a JavaScript expression in a session\'s tab and return the result.',
    inputSchema: z.object({
      sessionId,
      pageId,
      expression: z
        .string()
        .describe('JavaScript expression evaluated in the page context. The resolved value is JSON-serialized back.')
    }),
    async handler(ctx, args) {
      const target = ctx.sessions.resolve(args.sessionId, args.pageId);
      const result = await target.page.evaluate(args.expression);
      return text({ pageId: target.pageId, result });
    }
  }),

  snapshot: defineTool({
    description: 'Get an AI-readable accessibility snapshot of a session\'s tab (structure + text, not pixels).',
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
      'Take a screenshot of a session\'s tab. Default: inline base64, never written to disk. mode: "cached" instead writes it to a TTL-expiring local cache and returns a reference.',
    inputSchema: z.object({
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
    async handler(ctx, args) {
      const target = ctx.sessions.resolve(args.sessionId, args.pageId);
      const buffer = await target.page.screenshot({ fullPage: args.fullPage ?? false, type: 'png' });

      if (args.mode === 'cached') {
        const { screenshotCacheDir, screenshotCacheTtlMs } = ctx.config;
        await mkdir(screenshotCacheDir, { recursive: true });
        const cacheId = randomUUID();
        const filePath = join(screenshotCacheDir, `${cacheId}.png`);
        await writeFile(filePath, buffer);
        return text({
          pageId: target.pageId,
          mode: 'cached',
          cacheId,
          path: filePath,
          sizeBytes: buffer.length,
          expiresAt: new Date(Date.now() + screenshotCacheTtlMs).toISOString()
        });
      }

      // Default: inline base64 only, never written to disk.
      return { content: [{ type: 'image', data: buffer.toString('base64'), mimeType: 'image/png' }] };
    }
  }),

  read_console: defineTool({
    description:
      'Read buffered browser console messages for a session (optionally filtered to one tab). Buffering starts at create_session, so this returns history, not just future messages.',
    inputSchema: z.object({
      sessionId,
      pageId,
      clear
    }),
    async handler(ctx, args) {
      const messages = ctx.sessions.getConsoleMessages(args.sessionId, args.pageId, args.clear ?? false);
      return text({ messages });
    }
  }),

  list_network_requests: defineTool({
    description:
      'List buffered network requests/responses for a session (optionally filtered to one tab). Buffering starts at create_session.',
    inputSchema: z.object({
      sessionId,
      pageId,
      clear
    }),
    async handler(ctx, args) {
      const requests = ctx.sessions.getNetworkEntries(args.sessionId, args.pageId, args.clear ?? false);
      return text({ requests });
    }
  }),

  send_cdp_command: defineTool({
    description:
      'Send a raw Chrome DevTools Protocol command directly to a session\'s tab and get the structured result back — an agent-facing equivalent of escalate_session\'s human-facing CDP access.',
    inputSchema: z.object({
      sessionId,
      pageId,
      method: z
        .string()
        .describe('Chrome DevTools Protocol method name, e.g. "Page.getLayoutMetrics" or "Network.getResponseBody".'),
      params: z.unknown().optional().describe('Params object for the CDP method, if the method takes any.')
    }),
    async handler(ctx, args) {
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
