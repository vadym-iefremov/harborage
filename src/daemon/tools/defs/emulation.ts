import type { BrowserContext, CDPSession, Page } from 'playwright';
import * as z from 'zod/v4';

import type { ResolvedTarget } from '../../sessions.js';
import { defineTool, defineTools, text } from '../types.js';
import { pageId, sessionId } from './common.js';

/**
 * Emulation tools: the knobs that change WHO the browser claims to be and
 * WHAT environment it claims to sit in, so a QA agent can test the light
 * theme, a reduced-motion user, a German user in Tokyo, a real clipboard
 * paste, and a timer an hour in the future, without waiting an hour.
 *
 * Two mechanisms sit underneath, and the difference leaks into the tool
 * surface, so it is stated once here rather than guessed at per tool:
 *
 * 1. Playwright's own APIs (`page.emulateMedia`, `context.grantPermissions`,
 *    `context.setGeolocation`, `page.clock`) are stable, survive navigation
 *    and need no bookkeeping.
 *
 * 2. User agent, timezone and locale have NO post-creation Playwright API at
 *    all: Playwright fixes them per BrowserContext when the context is
 *    created. Only CDP's `Emulation.set*Override` can change them afterwards,
 *    and those overrides are scoped to the DevTools session that set them:
 *    Chromium reverts every one of them the instant that session detaches.
 *    Measured, not assumed. That is why `send_cdp_command` cannot be used for
 *    these (it detaches after every call, so the override is gone before the
 *    result comes back) and why these tools keep ONE long-lived CDP session
 *    per tab, created on first use and living as long as the tab does.
 */

/**
 * The long-lived CDP session backing the user agent, timezone and locale
 * overrides for one tab.
 *
 * A WeakMap so a closed tab's entry can be collected, plus an explicit delete
 * on close so nothing survives a tab that goes away. Keyed per Page, and a
 * Page belongs to exactly one session's BrowserContext, so nothing here can
 * cross a session boundary.
 */
const overrideSessions = new WeakMap<Page, Promise<CDPSession>>();

/**
 * Pages whose close handler is already registered, so a retried attach after
 * a failed one does not add a second copy. The map entry is evicted on
 * failure; the listener was not, and each retry used to leave one behind.
 */
const overrideCloseHooked = new WeakSet<Page>();

/** Which permission names this session has granted, so clear_permissions can report what it actually took away. */
const grantedPermissions = new WeakMap<BrowserContext, Set<string>>();

/** Whether a fake clock has been installed for this session, since Playwright's clock calls no-op silently without one. */
const clockInstalled = new WeakMap<BrowserContext, boolean>();

/**
 * The tab's persistent CDP session, created once and reused.
 *
 * The in-flight promise itself is cached rather than the resolved session, so
 * two concurrent tool calls on the same tab cannot each attach one and leave
 * the loser's overrides orphaned in Chromium. A failed attach is evicted so
 * the next call retries instead of inheriting a permanently rejected promise.
 */
function overrideSession(target: ResolvedTarget): Promise<CDPSession> {
  const page = target.page;
  const existing = overrideSessions.get(page);
  if (existing) return existing;

  const pending = target.session.context.newCDPSession(page).catch((err: unknown) => {
    overrideSessions.delete(page);
    throw err;
  });
  overrideSessions.set(page, pending);
  if (!overrideCloseHooked.has(page)) {
    overrideCloseHooked.add(page);
    page.on('close', () => {
      overrideSessions.delete(page);
    });
  }
  return pending;
}

/** The error message text out of anything thrown, without assuming it is an Error. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Sends one `Emulation.*` override on the tab's persistent CDP session.
 *
 * Chromium rejects an invalid timezone id or locale name outright, which is
 * the good case: the failure is loud. It is rewrapped so the caller reads
 * what the tool was trying to do rather than a bare protocol error.
 */
async function sendOverride(
  target: ResolvedTarget,
  method: string,
  params: Record<string, unknown>,
  what: string
): Promise<void> {
  const cdp = await overrideSession(target);
  try {
    await cdp.send(method as Parameters<typeof cdp.send>[0], params as never);
  } catch (err) {
    throw new Error(`${what} was rejected by the browser: ${messageOf(err)}`);
  }
}

/** Reads a JSON-serializable probe out of the page. Kept as source text because the daemon has no DOM types. */
function probe<T>(target: ResolvedTarget, expression: string): Promise<T> {
  return target.page.evaluate<T>(expression);
}

/** How the page itself answers the four media features, read back rather than echoed from the request. */
const MEDIA_PROBE = `(() => {
  const q = s => matchMedia(s).matches;
  return {
    colorScheme: q('(prefers-color-scheme: dark)') ? 'dark' : (q('(prefers-color-scheme: light)') ? 'light' : 'no-preference'),
    reducedMotion: q('(prefers-reduced-motion: reduce)') ? 'reduce' : 'no-preference',
    forcedColors: q('(forced-colors: active)') ? 'active' : 'none',
    media: q('print') ? 'print' : 'screen'
  };
})()`;

interface MediaState {
  colorScheme: string;
  reducedMotion: string;
  forcedColors: string;
  media: string;
}

/** The identity fields a user-agent override moves, read out of the page. */
const IDENTITY_PROBE = `({ userAgent: navigator.userAgent, language: navigator.language, platform: navigator.platform })`;

interface IdentityState {
  userAgent: string;
  language: string;
  platform: string;
}

/** Timezone as the page resolves it, plus offsets so a caller can see real date arithmetic moved. */
const TIMEZONE_PROBE = `({
  timezoneId: Intl.DateTimeFormat().resolvedOptions().timeZone,
  januaryOffsetMinutes: new Date('2024-01-15T12:00:00Z').getTimezoneOffset(),
  julyOffsetMinutes: new Date('2024-07-15T12:00:00Z').getTimezoneOffset()
})`;

/** Locale as the page resolves it, with a formatted sample and navigator.language for contrast. */
const LOCALE_PROBE = `({
  locale: Intl.DateTimeFormat().resolvedOptions().locale,
  navigatorLanguage: navigator.language,
  sampleNumber: new Intl.NumberFormat().format(1234.5),
  sampleDate: new Date('2024-01-15T12:00:00Z').toLocaleDateString()
})`;

/** Queries the page's own Permissions API for each name, so the answer comes from the browser, not from the grant call. */
function permissionProbe(names: string[]): string {
  return `(async names => {
    const out = {};
    for (const name of names) {
      try {
        out[name] = (await navigator.permissions.query({ name })).state;
      } catch (err) {
        out[name] = 'not-queryable';
      }
    }
    return out;
  })(${JSON.stringify(names)})`;
}

const GEOLOCATION_PROBE = `(async () => {
  let state = 'unknown';
  try {
    state = (await navigator.permissions.query({ name: 'geolocation' })).state;
  } catch (err) {
    state = 'not-queryable';
  }
  if (state !== 'granted') return { state };
  return await new Promise(resolve => {
    navigator.geolocation.getCurrentPosition(
      p => resolve({ state, latitude: p.coords.latitude, longitude: p.coords.longitude, accuracy: p.coords.accuracy }),
      e => resolve({ state, error: e.message }),
      { timeout: 5000, maximumAge: 0 }
    );
  });
})()`;

/** Parses a caller-supplied instant, refusing anything Date cannot read instead of silently becoming Invalid Date. */
function parseTime(raw: string, field: string): Date {
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(
      `"${field}" is not a time this tool can read: ${JSON.stringify(raw)}. Give an ISO 8601 instant such as "2024-03-01T10:00:00.000Z".`
    );
  }
  return parsed;
}

/**
 * A media feature's value, with an explicit "reset" rather than Playwright's
 * null.
 *
 * Playwright distinguishes three things: an absent key (leave the current
 * emulation alone), a value (emulate it), and null (drop the emulation and
 * fall back to the host system). Absent-versus-null is not a distinction a
 * tool call can express legibly, and getting it backwards fails silently, so
 * the third case is spelled "reset" here and mapped to null on the way
 * through.
 */
function mediaFeature(values: [string, ...string[]], meaning: string) {
  return z
    .enum([...values, 'reset'] as [string, ...string[]])
    .optional()
    .describe(
      `${meaning} OMIT this key to leave whatever is currently emulated untouched. Pass "reset" to drop the override entirely and fall back to the host system's real setting. Those two are NOT the same thing.`
    );
}

/** Maps this tool's "reset" sentinel onto the null Playwright wants, and an absent key onto an absent key. */
function mediaValue(raw: string | undefined): string | null | undefined {
  if (raw === undefined) return undefined;
  return raw === 'reset' ? null : raw;
}

export const emulationTools = defineTools({
  emulate_media: defineTool({
    description:
      'Emulate the CSS media features a page renders against: colour scheme (the light/dark theme), reduced motion, forced colours (Windows high-contrast mode), and the media type (screen or print). ' +
      'This is how you test a light theme without changing anything on the machine, and how you prove a page honours prefers-reduced-motion. ' +
      'Each of the four is independent: a key you omit is left exactly as it was, and a key set to "reset" drops that one override back to the host system default while the others stay in force. Omitting is NOT resetting. ' +
      'Scoped to one tab, and it outlives navigations and reloads in that tab, so set it once and drive the whole flow. It does not touch other tabs, other sessions, or the machine. ' +
      'It also does not change how the page BEHAVES beyond the media queries: a page that reads its theme out of localStorage, a cookie or a server preference will not follow this, and neither will one that only checks prefers-color-scheme at first paint. ' +
      'Always reads the state back out of the page afterwards, so "effective" is what the browser reports rather than what was asked for. Note that Chromium reports "light" rather than "no-preference" when nothing is emulated. ' +
      'That readback proves the browser changed its mind, not that the page did anything about it, so confirm with a computed style (through evaluate) or a screenshot before concluding the theme actually works.',
    inputSchema: z.object({
      sessionId,
      pageId,
      colorScheme: mediaFeature(
        ['light', 'dark', 'no-preference'],
        'The theme the page should see through prefers-color-scheme. "no-preference" emulates a user who has expressed none, which is a different thing from having no emulation at all.'
      ),
      reducedMotion: mediaFeature(
        ['reduce', 'no-preference'],
        'What the page should see through prefers-reduced-motion. "reduce" is the accessibility setting that should collapse animations and transitions.'
      ),
      forcedColors: mediaFeature(
        ['active', 'none'],
        'What the page should see through forced-colors, i.e. Windows high-contrast mode, where the browser overrides the page\'s own palette.'
      ),
      media: mediaFeature(
        ['screen', 'print'],
        'The CSS media type. "print" is how you check a print stylesheet without opening a print dialog.'
      )
    }),
    async handler(ctx, args) {
      const target = ctx.sessions.resolve(args.sessionId, args.pageId);

      // Built key by key: Playwright reads a present-but-undefined key
      // differently from an absent one, so a feature the caller did not
      // mention must not appear in the object at all.
      const options: Record<string, unknown> = {};
      for (const key of ['colorScheme', 'reducedMotion', 'forcedColors', 'media'] as const) {
        const value = mediaValue(args[key]);
        if (value !== undefined) options[key] = value;
      }

      if (Object.keys(options).length > 0) {
        await target.page.emulateMedia(options as never);
      }

      const effective = await probe<MediaState>(target, MEDIA_PROBE);
      return text({
        pageId: target.pageId,
        requested: {
          ...(args.colorScheme !== undefined ? { colorScheme: args.colorScheme } : {}),
          ...(args.reducedMotion !== undefined ? { reducedMotion: args.reducedMotion } : {}),
          ...(args.forcedColors !== undefined ? { forcedColors: args.forcedColors } : {}),
          ...(args.media !== undefined ? { media: args.media } : {})
        },
        effective,
        note:
          'The "effective" values were read back out of the page with matchMedia. A page whose CSS does not react to these queries will report the change here and still look identical: check a computed style or a screenshot before concluding the theme works.'
      });
    }
  }),

  set_user_agent: defineTool({
    description:
      'Override the user agent for one tab, AFTER the session already exists. ' +
      'Playwright itself cannot do this: it fixes userAgent per browser context at creation time and offers no later setter, so this goes through CDP (Emulation.setUserAgentOverride) on a CDP session this tool keeps attached for the life of the tab. Doing the same thing through send_cdp_command does NOT work: that tool detaches after every call, and Chromium reverts the override the moment the session that set it detaches, so the change silently disappears before you can observe it. ' +
      'Verified behaviour: it changes BOTH navigator.userAgent and the outgoing User-Agent request header, and it survives navigations and reloads in that tab. acceptLanguage likewise changes both navigator.language and the outgoing Accept-Language header. ' +
      'One caveat worth knowing: overriding the user agent stops Chromium sending the Sec-CH-UA client hint headers, so a server that sniffs client hints rather than the UA string sees nothing at all rather than seeing your override. ' +
      'Scoped to one tab: other tabs in the same session, and every other session, keep the real identity. Reads the result back out of the page rather than echoing the request.',
    inputSchema: z.object({
      sessionId,
      pageId,
      userAgent: z
        .string()
        .min(1)
        .optional()
        .describe('Full user agent string to send. Required unless "reset" is true, and mutually exclusive with it.'),
      acceptLanguage: z
        .string()
        .optional()
        .describe(
          'Language tag(s) for navigator.language and the Accept-Language header, e.g. "de-DE" or "de-DE,de;q=0.9". Only valid together with userAgent.'
        ),
      platform: z
        .string()
        .optional()
        .describe('Value for navigator.platform, e.g. "Win32" or "Linux x86_64". Only valid together with userAgent.'),
      reset: z
        .boolean()
        .optional()
        .describe(
          'If true, drops the override and restores the browser\'s real user agent, language and platform together. Cannot be combined with the other fields.'
        )
    }),
    async handler(ctx, args) {
      const wantsReset = args.reset === true;
      if (wantsReset === (args.userAgent !== undefined)) {
        throw new Error(
          wantsReset
            ? 'set_user_agent takes either "userAgent" or "reset": true, not both.'
            : 'set_user_agent needs "userAgent" to set one, or "reset": true to restore the real one. Neither was given.'
        );
      }
      if (wantsReset && (args.acceptLanguage !== undefined || args.platform !== undefined)) {
        throw new Error(
          'set_user_agent\'s "reset" restores the user agent, language and platform together, so it cannot be combined with "acceptLanguage" or "platform".'
        );
      }

      const target = ctx.sessions.resolve(args.sessionId, args.pageId);
      // An empty userAgent is CDP's own way of clearing the override, which
      // restores the genuine UA string and the client hints along with it.
      const params: Record<string, unknown> = { userAgent: wantsReset ? '' : (args.userAgent as string) };
      if (args.acceptLanguage !== undefined) params.acceptLanguage = args.acceptLanguage;
      if (args.platform !== undefined) params.platform = args.platform;
      await sendOverride(target, 'Emulation.setUserAgentOverride', params, 'The user agent override');

      const identity = await probe<IdentityState>(target, IDENTITY_PROBE);
      const matched = wantsReset ? identity.userAgent.length > 0 : identity.userAgent === args.userAgent;
      return text({
        pageId: target.pageId,
        requested: wantsReset ? 'the browser\'s real user agent' : args.userAgent,
        userAgent: identity.userAgent,
        language: identity.language,
        platform: identity.platform,
        matched,
        ...(matched
          ? {}
          : {
              note:
                'The page does not report the requested user agent. Trust "userAgent", not the request: something in the page may be shadowing navigator.userAgent.'
            })
      });
    }
  }),

  set_timezone: defineTool({
    description:
      'Override the timezone for one tab, AFTER the session already exists, so Date arithmetic, Intl formatting and anything rendering a local time behave as they would for a user in that zone. ' +
      'Playwright takes timezoneId only as a context-creation option and has no later setter, so this goes through CDP (Emulation.setTimezoneOverride) on a CDP session kept attached for the life of the tab. send_cdp_command cannot do this: it detaches after each call, and Chromium drops the override with the session that set it. ' +
      'Verified: the override survives navigations and reloads in that tab, and stays inside that tab. An unknown zone id is rejected loudly by the browser rather than quietly ignored. ' +
      'It does NOT change the locale, so dates stay formatted in the machine\'s language at the new offset: use set_locale for that. Reads Intl.DateTimeFormat().resolvedOptions().timeZone back out of the page rather than echoing the request.',
    inputSchema: z.object({
      sessionId,
      pageId,
      timezoneId: z
        .string()
        .min(1)
        .optional()
        .describe('IANA timezone id, e.g. "Asia/Tokyo", "Europe/Berlin", "America/New_York". Required unless "reset" is true.'),
      reset: z.boolean().optional().describe('If true, drops the override and falls back to the machine\'s own timezone.')
    }),
    async handler(ctx, args) {
      const wantsReset = args.reset === true;
      if (wantsReset === (args.timezoneId !== undefined)) {
        throw new Error(
          wantsReset
            ? 'set_timezone takes either "timezoneId" or "reset": true, not both.'
            : 'set_timezone needs "timezoneId" to set one, or "reset": true to fall back to the machine timezone. Neither was given.'
        );
      }

      const target = ctx.sessions.resolve(args.sessionId, args.pageId);
      // CDP treats an empty timezoneId as "disable the override".
      await sendOverride(
        target,
        'Emulation.setTimezoneOverride',
        { timezoneId: wantsReset ? '' : (args.timezoneId as string) },
        `The timezone override ${JSON.stringify(args.timezoneId ?? '')}`
      );

      const state = await probe<{ timezoneId: string; januaryOffsetMinutes: number; julyOffsetMinutes: number }>(
        target,
        TIMEZONE_PROBE
      );
      const matched = wantsReset ? true : state.timezoneId === args.timezoneId;
      return text({
        pageId: target.pageId,
        requested: wantsReset ? 'the machine timezone' : args.timezoneId,
        ...state,
        matched,
        ...(matched
          ? {}
          : { note: 'The page resolves a different zone than the one requested. Trust "timezoneId", not the request.' })
      });
    }
  }),

  set_locale: defineTool({
    description:
      'Override the locale for one tab, AFTER the session already exists, so Intl number, date, currency and collation formatting behave as they would for a user in that locale. ' +
      'Playwright takes locale only as a context-creation option and has no later setter, so this goes through CDP (Emulation.setLocaleOverride) on a CDP session kept attached for the life of the tab. send_cdp_command cannot do this: it detaches after each call, and Chromium drops the override with the session that set it. ' +
      'IMPORTANT and measured: this moves Intl only. It does NOT move navigator.language or navigator.languages, so a page that picks its translations off navigator.language carries on in the original language while its numbers and dates change underneath. The result reports navigator.language back so you can see that for yourself. To move navigator.language too, pass acceptLanguage to set_user_agent. ' +
      'Verified: the override survives navigations and reloads in that tab, and stays inside that tab. An invalid locale name is rejected loudly by the browser.',
    inputSchema: z.object({
      sessionId,
      pageId,
      locale: z.string().min(1).optional().describe('BCP 47 locale, e.g. "de-DE", "fr-FR", "ja-JP". Required unless "reset" is true.'),
      reset: z.boolean().optional().describe('If true, drops the override and falls back to the browser\'s own locale.')
    }),
    async handler(ctx, args) {
      const wantsReset = args.reset === true;
      if (wantsReset === (args.locale !== undefined)) {
        throw new Error(
          wantsReset
            ? 'set_locale takes either "locale" or "reset": true, not both.'
            : 'set_locale needs "locale" to set one, or "reset": true to fall back to the browser locale. Neither was given.'
        );
      }

      const target = ctx.sessions.resolve(args.sessionId, args.pageId);
      // CDP restores the default when the params carry no locale at all.
      await sendOverride(
        target,
        'Emulation.setLocaleOverride',
        wantsReset ? {} : { locale: args.locale as string },
        `The locale override ${JSON.stringify(args.locale ?? '')}`
      );

      const state = await probe<{ locale: string; navigatorLanguage: string; sampleNumber: string; sampleDate: string }>(
        target,
        LOCALE_PROBE
      );
      const matched = wantsReset ? true : state.locale === args.locale;
      return text({
        pageId: target.pageId,
        requested: wantsReset ? 'the browser locale' : args.locale,
        ...state,
        matched,
        note:
          'navigatorLanguage is reported because a locale override deliberately does not move it. If the page chooses its language from navigator.language, this call changed its formatting but not its translations.'
      });
    }
  }),

  grant_permissions: defineTool({
    description:
      'Grant browser permissions to a whole session, so the page can use APIs that would otherwise sit behind a permission prompt no agent can click. ' +
      'Clipboard is the one that matters most: without "clipboard-read" and "clipboard-write" every navigator.clipboard call throws NotAllowedError, which is what forces an agent to fake a paste with raw CDP text insertion instead of testing the real thing. Grant both to exercise a genuine copy and paste. ' +
      'Useful names: "clipboard-read", "clipboard-write", "notifications", "geolocation" (pair it with set_geolocation, which supplies the coordinates), "camera", "microphone", "midi", "background-sync", "accelerometer", "payment-handler". ' +
      'Grants are ADDITIVE: a second call does not revoke what an earlier one granted. Use clear_permissions to take them all away. ' +
      'Scoped to the whole session rather than one tab, since permissions live on the browser context: every tab in this session gets them, and no other session is affected. ' +
      'Reads each permission\'s state back through the page\'s own Permissions API afterwards, so "states" is what the browser reports. A name the Permissions API cannot query comes back as "not-queryable", which means unverified rather than failed.',
    inputSchema: z.object({
      sessionId,
      pageId,
      permissions: z
        .array(z.string().min(1))
        .min(1)
        .describe('Permission names to grant, e.g. ["clipboard-read", "clipboard-write"].'),
      origin: z
        .string()
        .optional()
        .describe(
          'Restrict the grant to one origin, e.g. "https://example.com". Omit to grant it for every origin this session visits.'
        )
    }),
    async handler(ctx, args) {
      const target = ctx.sessions.resolve(args.sessionId, args.pageId);
      try {
        await target.session.context.grantPermissions(args.permissions, args.origin ? { origin: args.origin } : undefined);
      } catch (err) {
        throw new Error(`grant_permissions was rejected by the browser: ${messageOf(err)}`);
      }

      const tracked = grantedPermissions.get(target.session.context) ?? new Set<string>();
      for (const name of args.permissions) tracked.add(name);
      grantedPermissions.set(target.session.context, tracked);

      const states = await probe<Record<string, string>>(target, permissionProbe(args.permissions));
      return text({
        sessionId: args.sessionId,
        pageId: target.pageId,
        granted: args.permissions,
        ...(args.origin ? { origin: args.origin } : {}),
        states,
        note:
          'States were queried from the page, so they reflect the origin the tab is currently on. An origin-scoped grant reads as "prompt" on any other origin, which is correct rather than a failure.'
      });
    }
  }),

  clear_permissions: defineTool({
    description:
      'Revoke every permission this session has been granted, for every origin, putting them all back to "prompt". This is Playwright\'s clearPermissions: there is no way to revoke one permission and keep the rest, so the only finer-grained approach is to clear and then grant the ones you still want. ' +
      'Scoped to the whole session, since permissions live on the browser context. Reports the post-clear state of everything grant_permissions granted in this session, read back through the page\'s own Permissions API.',
    inputSchema: z.object({ sessionId, pageId }),
    async handler(ctx, args) {
      const target = ctx.sessions.resolve(args.sessionId, args.pageId);
      await target.session.context.clearPermissions();

      const previously = [...(grantedPermissions.get(target.session.context) ?? new Set<string>())];
      grantedPermissions.delete(target.session.context);

      const states = previously.length > 0 ? await probe<Record<string, string>>(target, permissionProbe(previously)) : {};
      return text({
        sessionId: args.sessionId,
        pageId: target.pageId,
        cleared: previously,
        states,
        ...(previously.length === 0
          ? {
              note:
                'This session had granted nothing through grant_permissions, so there is nothing to report a state for. The clear still ran.'
            }
          : {})
      });
    }
  }),

  set_geolocation: defineTool({
    description:
      'Set the coordinates navigator.geolocation hands back to every tab in a session, so a location-dependent flow can be driven somewhere specific instead of wherever the machine is. ' +
      'On its own this does nothing observable: geolocation sits behind a permission, so the page still gets a PERMISSION_DENIED until you also call grant_permissions with "geolocation". This tool checks that for you and says plainly whether it could verify the position. ' +
      'Scoped to the whole session, since geolocation lives on the browser context. When the permission is in place the result carries the coordinates read back out of the page through a real getCurrentPosition call, not the ones that were sent in.',
    inputSchema: z.object({
      sessionId,
      pageId,
      latitude: z.number().min(-90).max(90).describe('Latitude in degrees, between -90 and 90.'),
      longitude: z.number().min(-180).max(180).describe('Longitude in degrees, between -180 and 180.'),
      accuracy: z.number().min(0).optional().describe('Reported accuracy in metres. Defaults to Playwright\'s own default of 0.')
    }),
    async handler(ctx, args) {
      const target = ctx.sessions.resolve(args.sessionId, args.pageId);
      await target.session.context.setGeolocation({
        latitude: args.latitude,
        longitude: args.longitude,
        ...(args.accuracy !== undefined ? { accuracy: args.accuracy } : {})
      });

      const observed = await probe<{ state: string; latitude?: number; longitude?: number; accuracy?: number; error?: string }>(
        target,
        GEOLOCATION_PROBE
      );
      const verified = observed.latitude !== undefined && observed.longitude !== undefined;

      return text({
        sessionId: args.sessionId,
        pageId: target.pageId,
        requested: {
          latitude: args.latitude,
          longitude: args.longitude,
          ...(args.accuracy !== undefined ? { accuracy: args.accuracy } : {})
        },
        permissionState: observed.state,
        verified,
        ...(verified
          ? { position: { latitude: observed.latitude, longitude: observed.longitude, accuracy: observed.accuracy } }
          : {
              note:
                observed.error !== undefined
                  ? `The coordinates were set, but the page could not read them: ${observed.error}`
                  : `The coordinates were set, but the page cannot read them yet: the geolocation permission is "${observed.state}". Call grant_permissions with ["geolocation"] on this session, then call this tool again to confirm.`
            })
      });
    }
  }),

  emulate_clock: defineTool({
    description:
      'Drive a fake clock in a session, so a test that would take an hour of real waiting takes a millisecond. This is what turns "sit through sixty debounce cycles to prove the retry storm" into one deterministic call. ' +
      'ORDER MATTERS, and getting it wrong fails SILENTLY. The clock replaces setTimeout, setInterval, Date and requestAnimationFrame in the page, and it can only replace them for timers created AFTER it is installed. Timers the page created before the install stay real: fast_forward will not fire them, nothing reports an error, and the flow simply looks like it does not work. The correct order is always: create the session, action "install", THEN navigate (or reload, if the page is already loaded). This tool tells you when you have installed it too late, but it cannot fix it for you. ' +
      'Scoped to the whole session rather than one tab: Playwright installs the clock on the browser context, so every tab in this session, including tabs opened afterwards, gets the same fake clock. No other session is affected. ' +
      'There is no uninstall. Once installed it stays for the life of the session, through reloads and navigations. Release the session and make a new one to get the real clock back. ' +
      'Actions: "install" starts the fake clock, optionally at a given time. "fast_forward" jumps the clock forward and fires every timer that comes due, without running a repeating timer more than once, which is the fast way through a long wait. "run_for" advances the same amount but ticks through it, firing intervals repeatedly, which is what you want in order to count debounce cycles. "pause_at" jumps to an instant and stops the clock there, so nothing fires until you "resume". "resume" restarts a paused clock. "set_fixed_time" pins Date and Date.now to one instant that never moves, which is how you make a date-dependent screenshot reproducible, and it works with or without an install. "set_system_time" moves the clock to an instant and lets it keep running from there. ' +
      'Every action reads the page\'s own Date back afterwards and reports it as "pageTime", so you can see where the clock really ended up.',
    inputSchema: z.object({
      sessionId,
      pageId,
      action: z
        .enum(['install', 'fast_forward', 'run_for', 'pause_at', 'resume', 'set_fixed_time', 'set_system_time'])
        .describe(
          'What to do to the clock. "install" must come first, and must come before the page creates its timers. "fast_forward" and "run_for" need "ticks"; "pause_at", "set_fixed_time" and "set_system_time" need "time"; "install" takes an optional "time"; "resume" takes neither.'
        ),
      time: z
        .string()
        .optional()
        .describe(
          'An instant, as an ISO 8601 string such as "2024-03-01T10:00:00.000Z". Required by pause_at, set_fixed_time and set_system_time; optional for install.'
        ),
      ticks: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe(
          'How far to move the clock, in MILLISECONDS. Required by fast_forward and run_for. 60000 is one minute, 3600000 is one hour.'
        )
    }),
    async handler(ctx, args) {
      const target = ctx.sessions.resolve(args.sessionId, args.pageId);
      const context = target.session.context;
      const clock = target.page.clock;

      const needsTime = args.action === 'pause_at' || args.action === 'set_fixed_time' || args.action === 'set_system_time';
      if (needsTime && args.time === undefined) {
        throw new Error(`emulate_clock's "${args.action}" needs a "time", e.g. "2024-03-01T10:00:00.000Z".`);
      }
      const needsTicks = args.action === 'fast_forward' || args.action === 'run_for';
      if (needsTicks && args.ticks === undefined) {
        throw new Error(`emulate_clock's "${args.action}" needs "ticks", a number of milliseconds to move the clock by.`);
      }

      // Playwright does not complain when these are called without an
      // install: it does nothing at all, which reads exactly like a page
      // whose timers never fire. Refusing loudly is the whole point.
      const needsInstall = needsTicks || args.action === 'pause_at' || args.action === 'resume';
      if (needsInstall && clockInstalled.get(context) !== true) {
        throw new Error(
          `emulate_clock's "${args.action}" needs a fake clock, and this session has none: call emulate_clock with action "install" first, BEFORE navigating the page. Playwright would have silently done nothing here.`
        );
      }

      let note: string | undefined;
      switch (args.action) {
        case 'install': {
          const url = target.page.url();
          // A tab already sitting on a document has already created that
          // document's timers, and those stay real however the clock is
          // driven afterwards.
          const alreadyLoaded = url !== '' && url !== 'about:blank';
          await clock.install(args.time !== undefined ? { time: parseTime(args.time, 'time') } : undefined);
          clockInstalled.set(context, true);
          if (alreadyLoaded) {
            note = `The clock is installed, but this tab was already on ${url} when you installed it, so every timer the page had already scheduled is still a REAL timer and will not respond to fast_forward or run_for. Call reload on this tab now, then drive the clock. Installing before navigating avoids this entirely.`;
          }
          break;
        }
        case 'fast_forward':
          await clock.fastForward(args.ticks as number);
          break;
        case 'run_for':
          await clock.runFor(args.ticks as number);
          break;
        case 'pause_at':
          await clock.pauseAt(parseTime(args.time as string, 'time'));
          break;
        case 'resume':
          await clock.resume();
          break;
        case 'set_fixed_time':
          await clock.setFixedTime(parseTime(args.time as string, 'time'));
          note =
            'Date and Date.now are now pinned to this instant and will not move at all, including across fast_forward and run_for. Timers still fire; only the reported time is frozen.';
          break;
        case 'set_system_time':
          await clock.setSystemTime(parseTime(args.time as string, 'time'));
          break;
      }

      // Read the clock back out of the page. A tab still on about:blank has a
      // live document that predates the install, so its Date is the real one:
      // that is reported honestly rather than hidden.
      const pageTime = await probe<string>(target, 'new Date().toISOString()').catch(() => undefined);

      return text({
        sessionId: args.sessionId,
        pageId: target.pageId,
        action: args.action,
        installed: clockInstalled.get(context) === true,
        ...(args.time !== undefined ? { requestedTime: args.time } : {}),
        ...(args.ticks !== undefined ? { ticks: args.ticks } : {}),
        pageTime,
        ...(note !== undefined ? { note } : {})
      });
    }
  })
});
