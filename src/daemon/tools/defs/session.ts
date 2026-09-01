import * as z from 'zod/v4';

import { compileNetworkMatch } from '../../networkMatch.js';
import { defineTool, defineTools, text } from '../types.js';
import { clear, pageId, sessionId } from './common.js';

/**
 * The capture-filter vocabulary, shared between create_session and
 * set_network_capture_filter, and matched deliberately against
 * list_network_requests' own filter fields: a caller who found the noise
 * with a read-time filter should be able to paste the same field names into
 * a capture filter rather than learn a second vocabulary for the same idea.
 */
const networkCaptureFilterShape = {
  urlIncludes: z
    .string()
    .optional()
    .describe('Only capture entries whose URL contains this substring, matched case-insensitively.'),
  urlMatches: z
    .string()
    .optional()
    .describe('Only capture entries whose URL matches this JavaScript regular expression source.'),
  method: z
    .string()
    .optional()
    .describe(
      'Only capture request entries with this HTTP method, matched case-insensitively. This drops every response ' +
        'entry too, since responses carry no method.'
    ),
  resourceType: z
    .string()
    .optional()
    .describe(
      'Only capture entries of this Playwright resource type, e.g. "xhr", "fetch", "document". Same vocabulary as ' +
        'list_network_requests\' resourceType. Only request entries carry one.'
    ),
  direction: z.enum(['request', 'response']).optional().describe('Only capture one side of each exchange.')
};

const networkCaptureFilter = z
  .object(networkCaptureFilterShape)
  .optional()
  .describe(
    'What to keep in this session\'s network ring, evaluated BEFORE an entry is buffered rather than after, so ' +
      'excluded noise can never evict traffic you do care about. Fields combine with AND, same as ' +
      'list_network_requests\' own filters. Omit entirely to capture everything, which is the default and matches ' +
      'every session created before this option existed. This is most useful against a page that runs its own dev ' +
      'server, where module-chunk requests can otherwise fill the whole buffer before the page has even finished ' +
      'loading: e.g. urlIncludes "/api/" keeps the calls an app makes to its own backend while a Vite or webpack ' +
      'dev server\'s "/@vite/", "/@fs/" and *.tsx module-chunk traffic never enters the ring at all. ' +
      'set_network_capture_filter changes or clears this on a session that is already running.'
  );

/** Tools that create, inspect, hand over and tear down sessions themselves. */
export const sessionTools = defineTools({
  create_session: defineTool({
    description:
      'Create a new isolated browser session, optionally seeded from previously exported storage state, optionally with a fixed viewport and device scale factor, and optionally with a network capture filter already in place. Returns a sessionId.',
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
        ),
      networkCaptureFilter
    }),
    async handler(ctx, { storageState, viewport, deviceScaleFactor, networkCaptureFilter: filter }) {
      const { sessionId: id, pageId: firstPageId } = await ctx.sessions.createSession({
        storageState,
        viewport,
        deviceScaleFactor,
        networkCaptureFilter: filter
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
      'Make one tab the session\'s active tab, so later calls that omit pageId target it. Use after list_tabs to ' +
      'switch between tabs without passing pageId to every single call. This is the ONLY way to change what an ' +
      'omitted pageId targets: passing an explicit pageId to some other tool (a screenshot, a read of another ' +
      'tab\'s console) affects that one call and nothing after it, so a one-off look at a background tab never ' +
      'quietly becomes the new default.',
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
      'Call it with no action to just read the log, which is how you find out that a click you thought did nothing actually hit a confirm(). ' +
      'The dialog log is a bounded buffer (HARBORAGE_DIALOG_BUFFER_SIZE, 200 by default), same as read_console and list_network_requests, so the result reports total (dialogs currently buffered), returned (dialogs this call is handing back) and dropped (dialogs evicted since the buffer was last fully cleared). clear: true without pageId drains the whole session-wide log and also resets dropped to 0, since that is a fresh observation window starting; clear: true scoped to one pageId only removes that tab\'s dialogs and leaves dropped as it was, since the rest of the log is still unread.',
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
      const before = ctx.sessions.getDialogs(args.sessionId, args.pageId, false);
      const result = ctx.sessions.getDialogs(args.sessionId, args.pageId, args.clear ?? false);
      return text({
        armed: ctx.sessions.getDialogPolicy(args.sessionId) ?? null,
        total: before.entries.length,
        returned: result.entries.length,
        dropped: before.dropped,
        dialogs: result.entries
      });
    }
  }),

  read_page_errors: defineTool({
    description:
      'Read buffered uncaught exceptions and unhandled promise rejections for a session (optionally filtered to one tab). ' +
      'This is a different channel from read_console: a script that throws produces no console message, so an error invisible to read_console shows up here. ' +
      'Buffering starts at create_session and at every tab opening, so this returns history rather than only what happens after you ask. ' +
      'Each entry carries the message and, where one exists, the stack. A rejection whose value is not an Error has no stack, so it carries valueType (the value\'s constructor, e.g. Event), eventType (an Event\'s own type) and detail (a JSON dump) instead, which is what makes an "[object Event]" rejection traceable. ' +
      'This is a bounded buffer (HARBORAGE_PAGE_ERROR_BUFFER_SIZE, 200 by default), same as read_console and list_network_requests, so the result reports total (errors currently buffered), returned (errors this call is handing back) and dropped (errors evicted since the buffer was last fully cleared). clear: true without pageId drains the whole session-wide log and also resets dropped to 0, since that is a fresh observation window starting; clear: true scoped to one pageId only removes that tab\'s errors and leaves dropped as it was, since the rest of the log is still unread.',
    inputSchema: z.object({
      sessionId,
      pageId,
      clear
    }),
    async handler(ctx, args) {
      const before = ctx.sessions.getPageErrors(args.sessionId, args.pageId, false);
      const result = ctx.sessions.getPageErrors(args.sessionId, args.pageId, args.clear ?? false);
      return text({
        total: before.entries.length,
        returned: result.entries.length,
        dropped: before.dropped,
        errors: result.entries
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
  }),

  set_network_capture_filter: defineTool({
    description:
      'Change, or remove, a session\'s network capture filter: what gets INTO the network ring in the first place, ' +
      'as opposed to list_network_requests\' filters, which only narrow what a single read shows you out of ' +
      'whatever survived. Most agents only discover the flood after it has already happened (list_network_requests ' +
      'came back with a big dropped count and none of the traffic they wanted), so this exists to fix it on the ' +
      'session that is already running rather than requiring a fresh create_session with networkCaptureFilter set ' +
      'up front. ' +
      'Same vocabulary as list_network_requests\' own filters: urlIncludes, urlMatches, method, resourceType, ' +
      'direction, ANDed together. Call with none of them set to remove the filter and go back to capturing ' +
      'everything, which is also the default for a session that never called this at all. ' +
      'Takes effect immediately for every tab in the session and for tabs opened later, but does not retroactively ' +
      'touch what is already buffered: entries already in the ring stay there until read, cleared, or aged out by ' +
      'the ring filling up, whichever comes first. It also does not affect what has already been filtered out or ' +
      'dropped; those counters keep accumulating and only reset on an unfiltered list_network_requests clear.',
    inputSchema: z.object({
      sessionId,
      ...networkCaptureFilterShape
    }),
    async handler(ctx, args) {
      const hasFilter =
        args.urlIncludes !== undefined ||
        args.urlMatches !== undefined ||
        args.method !== undefined ||
        args.resourceType !== undefined ||
        args.direction !== undefined;

      const raw = hasFilter
        ? {
            ...(args.urlIncludes !== undefined ? { urlIncludes: args.urlIncludes } : {}),
            ...(args.urlMatches !== undefined ? { urlMatches: args.urlMatches } : {}),
            ...(args.method !== undefined ? { method: args.method } : {}),
            ...(args.resourceType !== undefined ? { resourceType: args.resourceType } : {}),
            ...(args.direction !== undefined ? { direction: args.direction } : {})
          }
        : undefined;

      ctx.sessions.setNetworkCaptureFilter(args.sessionId, raw !== undefined ? compileNetworkMatch(raw) : undefined);

      return text({
        sessionId: args.sessionId,
        capturing: hasFilter ? 'filtered' : 'everything',
        filter: raw ?? null
      });
    }
  })
});
