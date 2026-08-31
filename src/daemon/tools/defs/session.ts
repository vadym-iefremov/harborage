import * as z from 'zod/v4';

import { defineTool, defineTools, text } from '../types.js';
import { clear, pageId, sessionId } from './common.js';

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
    description: 'List the open tabs in a session: pageId, url, title, and which one is active (the tab that calls omitting pageId will target).',
    inputSchema: z.object({
      sessionId
    }),
    async handler(ctx, args) {
      const tabs = await ctx.sessions.listTabs(args.sessionId);
      return text({ tabs });
    }
  }),

  new_tab: defineTool({
    description:
      'Open a new tab in an existing session, optionally navigating it to a URL. The new tab becomes the session\'s active tab, so later calls that omit pageId target it. Console, network and page-error buffering are wired up before the tab loads anything, exactly as for the session\'s first tab. Returns the new pageId.',
    inputSchema: z.object({
      sessionId,
      url: z
        .string()
        .optional()
        .describe('URL to open the new tab at. Omit to get a blank tab you can navigate separately.')
    }),
    async handler(ctx, args) {
      const opened = await ctx.sessions.newTab(args.sessionId, args.url);
      return text(opened);
    }
  }),

  close_tab: defineTool({
    description:
      'Close one tab of a session. If the closed tab was the active one, the most recently opened remaining tab becomes active, which for a popup is the tab it was opened from. Closing the session\'s last tab is refused, because no other tool can work with a session that has no tabs: use release_session to end the session instead. Returns the tab now active.',
    inputSchema: z.object({
      sessionId,
      pageId: z.string().describe('Tab id from list_tabs. Required here: there is no sensible default tab to close.')
    }),
    async handler(ctx, args) {
      const result = await ctx.sessions.closeTab(args.sessionId, args.pageId);
      return text(result);
    }
  }),

  select_tab: defineTool({
    description:
      'Make one tab the session\'s active tab, so later calls that omit pageId target it. Use after list_tabs to switch between tabs without passing pageId to every single call.',
    inputSchema: z.object({
      sessionId,
      pageId: z.string().describe('Tab id from list_tabs to make active.')
    }),
    async handler(ctx, args) {
      return text(ctx.sessions.selectTab(args.sessionId, args.pageId));
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

  handle_dialog: defineTool({
    description:
      'Decide what JavaScript dialogs (alert, confirm, prompt, beforeunload) do in a session, and read back every dialog that has appeared so far. ' +
      'IMPORTANT, because it changes how you use this: harborage never leaves a dialog open. A dialog blocks its tab until something answers it, so an unanswered one would wedge the tab and every later call on it. ' +
      'The default is therefore to dismiss every dialog the moment it appears and record it here, which is what the page sees as confirm() returning false and prompt() returning null. ' +
      'That means you arm this tool BEFORE the click or navigation that raises the dialog, rather than calling it in response to one: by the time you could react, the dialog is already answered and logged. ' +
      'Call it with no action to just read the log, which is how you find out that a click you thought did nothing actually hit a confirm().',
    inputSchema: z.object({
      sessionId,
      action: z
        .enum(['accept', 'dismiss'])
        .optional()
        .describe(
          'What upcoming dialogs get. Omit to leave the current behaviour alone and only read the log. "dismiss" is the default behaviour, so arming it with appliesTo "all" is how you undo a standing "accept".'
        ),
      promptText: z
        .string()
        .optional()
        .describe('Text to answer a prompt() with when accepting. Ignored by alert and confirm, which take no text.'),
      appliesTo: z
        .enum(['next', 'all'])
        .optional()
        .describe(
          '"next" (default): the armed action is used by the first dialog that appears and then forgotten, so one armed accept cannot silently accept a later, different dialog. "all": every dialog until you arm something else.'
        ),
      pageId: z
        .string()
        .optional()
        .describe('Filter the returned dialog log to one tab. The armed action always applies to the whole session, whichever tab raises the dialog.'),
      clear
    }),
    async handler(ctx, args) {
      if (args.action !== undefined) {
        ctx.sessions.setDialogPolicy(args.sessionId, {
          action: args.action,
          promptText: args.promptText,
          appliesTo: args.appliesTo ?? 'next'
        });
      }
      const dialogs = ctx.sessions.getDialogs(args.sessionId, args.pageId, args.clear ?? false);
      return text({ armed: ctx.sessions.getDialogPolicy(args.sessionId) ?? null, dialogs });
    }
  }),

  read_page_errors: defineTool({
    description:
      'Read buffered uncaught exceptions and unhandled promise rejections for a session (optionally filtered to one tab). ' +
      'This is a different channel from read_console: a script that throws produces no console message, so an error invisible to read_console shows up here. ' +
      'Buffering starts at create_session and at every tab opening, so this returns history rather than only what happens after you ask. ' +
      'Each entry carries the message and, where one exists, the stack. A rejection whose value is not an Error has no stack, so it carries valueType (the value\'s constructor, e.g. Event), eventType (an Event\'s own type) and detail (a JSON dump) instead, which is what makes an "[object Event]" rejection traceable.',
    inputSchema: z.object({
      sessionId,
      pageId,
      clear
    }),
    async handler(ctx, args) {
      const errors = ctx.sessions.getPageErrors(args.sessionId, args.pageId, args.clear ?? false);
      return text({ errors });
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
