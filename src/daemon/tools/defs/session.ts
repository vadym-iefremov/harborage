import * as z from 'zod/v4';

import { defineTool, defineTools, text } from '../types.js';
import { pageId, sessionId } from './common.js';

/** Tools that create, inspect, hand over and tear down sessions themselves. */
export const sessionTools = defineTools({
  create_session: defineTool({
    description:
      'Create a new isolated browser session, optionally seeded from previously exported storage state and optionally with a fixed viewport and device scale factor. Returns a sessionId.',
    inputSchema: z.object({
      storageState: z
        .unknown()
        .optional()
        .describe(
          'Storage state previously returned by export_state (cookies + localStorage), used to seed this session so it starts already logged in / already set up.'
        ),
      viewport: z
        .object({
          width: z.number().int().positive().describe('Viewport width in CSS pixels.'),
          height: z.number().int().positive().describe('Viewport height in CSS pixels.')
        })
        .optional()
        .describe(
          'Viewport in CSS pixels for this session\'s tabs. Defaults to Playwright\'s 1280x720. This one can also be changed later with the resize tool; set it here when you already know the size you want.'
        ),
      deviceScaleFactor: z
        .number()
        .positive()
        .optional()
        .describe(
          'Device pixel ratio for this session, e.g. 2 or 3 for retina-density screenshots (a 400x300 viewport at 2 produces an 800x600 PNG). Defaults to 1. ' +
            'This is FIXED for the life of the session: Playwright sets it when the browser context is created and nothing can change it afterwards, so resize cannot change it and CDP Emulation.setDeviceMetricsOverride silently does nothing. A different scale factor needs a new session.'
        )
    }),
    async handler(ctx, { storageState, viewport, deviceScaleFactor }) {
      const { sessionId: id, pageId: firstPageId } = await ctx.sessions.createSession({
        storageState,
        viewport,
        deviceScaleFactor
      });
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
      'Hand a session over for human hands-on control (e.g. stuck on a CAPTCHA). Returns a Chrome DevTools Protocol WebSocket URL a human can attach to. ' +
      'The session is marked escalated and switches to a much longer idle timeout (HARBORAGE_ESCALATED_IDLE_TIMEOUT_MS, one hour by default) for the rest of its life, ' +
      'because a human working over CDP calls no tools and would otherwise have the session reaped out from under them. It is a longer rope, not an exemption: ' +
      'an escalation nobody comes back to is still reaped eventually. Call release_session when the handover is done rather than leaving it to expire.',
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

      // Marked only once there is a URL to hand over. A human cannot be
      // driving the session before they have been given the address of it,
      // so a lookup that failed should not leave the session sitting on the
      // long escalated timeout for an hour.
      ctx.sessions.markEscalated(args.sessionId);

      return text({
        sessionId: args.sessionId,
        pageId: target.pageId,
        escalated: true,
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
      'List every currently active session machine-wide (sessionId, createdAt, lastActivity, current tab URL, how many tool calls are in flight, and whether it has been escalated to a human), not scoped to the caller. Use this to discover sessions without already knowing a sessionId, and to spot an escalated session nobody came back to.',
    inputSchema: z.object({}),
    async handler(ctx) {
      return text({ sessions: ctx.sessions.listSessions() });
    }
  })
});
