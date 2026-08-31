import * as z from 'zod/v4';

import { defineTool, defineTools, text } from '../types.js';
import { pageId, sessionId } from './common.js';

/** Tools that create, inspect, hand over and tear down sessions themselves. */
export const sessionTools = defineTools({
  create_session: defineTool({
    description:
      'Create a new isolated browser session (optionally seeded from previously exported storage state). Returns a sessionId.',
    inputSchema: z.object({
      storageState: z
        .unknown()
        .optional()
        .describe(
          'Storage state previously returned by export_state (cookies + localStorage), used to seed this session so it starts already logged in / already set up.'
        )
    }),
    async handler(ctx, { storageState }) {
      const { sessionId: id, pageId: firstPageId } = await ctx.sessions.createSession(storageState);
      return text({ sessionId: id, pageId: firstPageId });
    }
  }),

  list_tabs: defineTool({
    description: 'List the open tabs in a session.',
    inputSchema: z.object({
      sessionId
    }),
    async handler(ctx, args) {
      const tabs = await ctx.sessions.listTabs(args.sessionId);
      return text({ tabs });
    }
  }),

  export_state: defineTool({
    description:
      'Export a session\'s current storage state (cookies + localStorage), for seeding future sessions via create_session.',
    inputSchema: z.object({
      sessionId
    }),
    async handler(ctx, args) {
      const target = ctx.sessions.resolve(args.sessionId);
      const storageState = await target.session.context.storageState();
      return text({ storageState });
    }
  }),

  escalate_session: defineTool({
    description:
      'Hand a session over for human hands-on control (e.g. stuck on a CAPTCHA). Returns a Chrome DevTools Protocol WebSocket URL a human can attach to.',
    inputSchema: z.object({
      sessionId,
      pageId,
      reason: z.string().describe('Why this session needs a human, e.g. "stuck on CAPTCHA" or "ambiguous form".')
    }),
    async handler(ctx, args) {
      const target = ctx.sessions.resolve(args.sessionId, args.pageId);
      console.error(`[harborage] escalate_session ${args.sessionId}/${target.pageId}: ${args.reason}`);

      const cdpSession = await target.session.context.newCDPSession(target.page);
      let targetId: string;
      try {
        const info = await cdpSession.send('Target.getTargetInfo');
        targetId = (info as { targetInfo: { targetId: string } }).targetInfo.targetId;
      } finally {
        await cdpSession.detach().catch(() => {});
      }

      const listUrl = `http://localhost:${ctx.config.debugPort}/json/list`;
      const response = await fetch(listUrl);
      if (!response.ok) {
        throw new Error(`Could not reach the remote debugging endpoint at ${listUrl} (HTTP ${response.status}).`);
      }
      const targets = (await response.json()) as {
        id: string;
        webSocketDebuggerUrl: string;
        devtoolsFrontendUrl?: string;
        url: string;
      }[];
      const match = targets.find(t => t.id === targetId);
      if (!match) {
        throw new Error(`Target ${targetId} for session ${args.sessionId} was not found at ${listUrl}.`);
      }

      return text({
        sessionId: args.sessionId,
        pageId: target.pageId,
        webSocketDebuggerUrl: match.webSocketDebuggerUrl,
        devtoolsFrontendUrl: match.devtoolsFrontendUrl,
        url: match.url
      });
    }
  }),

  release_session: defineTool({
    description: 'Close a session and free its resources.',
    inputSchema: z.object({
      sessionId
    }),
    async handler(ctx, args) {
      await ctx.sessions.releaseSession(args.sessionId);
      return text({ ok: true, sessionId: args.sessionId });
    }
  }),

  list_sessions: defineTool({
    description:
      'List every currently active session machine-wide (sessionId, createdAt, lastActivity, current tab URL) — not scoped to the caller. Use this to discover sessions without already knowing a sessionId.',
    inputSchema: z.object({}),
    async handler(ctx) {
      return text({ sessions: ctx.sessions.listSessions() });
    }
  })
});
