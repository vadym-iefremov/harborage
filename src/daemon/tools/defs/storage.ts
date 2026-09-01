import { randomUUID } from 'node:crypto';
import { mkdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { Cookie, Page } from 'playwright';
import * as z from 'zod/v4';

import { sessionCacheDir } from '../../screenshotCache.js';
import { defineTool, defineTools, text } from '../types.js';
import { pageId, sessionId } from './common.js';

/**
 * The browser globals the in-page snippets in this file touch.
 *
 * The daemon's own tsconfig has no "dom" lib on purpose (it is a Node
 * process), so each snippet declares exactly what it uses, the same way
 * interaction.ts does. Declaring the two storage areas explicitly is also
 * part of what these tools are for: a typo like `localStorge.getItem` is a
 * compile error here and a silent runtime ReferenceError inside `evaluate`.
 */
interface WebStorage {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  clear(): void;
}
declare const localStorage: WebStorage;
declare const sessionStorage: WebStorage;
declare const location: { origin: string; href: string };

/** Which of the two web storage areas a call is about. */
const storageArea = z
  .enum(['localStorage', 'sessionStorage'])
  .describe(
    'Which storage area to act on. "localStorage" survives tab close and reload; "sessionStorage" is per tab and dies with it. ' +
      'Both are scoped to the tab\'s current ORIGIN (scheme + host + port), not to the session as a whole.'
  );

type StorageAreaName = z.infer<typeof storageArea>;

/** One line, repeated in every storage tool's description, because every one of them depends on it. */
const originScopedNote =
  'Origin-scoped: this reads or writes the storage of whatever origin the tab is on RIGHT NOW, and every result ' +
  'names that origin, so a call that landed on the wrong page is visible rather than silently plausible. A tab still ' +
  'on about:blank has no origin at all, and is refused with an explanation instead of a SecurityError or a hollow success.';

/** One line, repeated in every cookie tool's description. */
const contextScopedNote =
  'Cookies are CONTEXT-scoped: one jar shared by every tab in this session, and completely isolated from every other ' +
  'session on this machine. Changing them here can never affect another agent\'s session, and never touches the ' +
  'real browser profile of whoever is running the daemon.';

// ---------------------------------------------------------------------------
// Web storage
// ---------------------------------------------------------------------------

type StorageRequest = {
  area: StorageAreaName;
  op: 'get' | 'set' | 'remove' | 'clear';
  key: string | null;
  value: string | null;
};

type StorageOutcome =
  | { ok: false; blocked: 'opaque-origin' | 'threw'; origin: string; url: string; detail: string }
  | {
      ok: true;
      origin: string;
      url: string;
      /** The named key's value read back AFTER the operation, or null. */
      value: string | null;
      /** Whether the named key existed BEFORE the operation. */
      existedBefore: boolean;
      /** How many entries the area held before the operation. */
      countBefore: number;
      /** How many entries the area holds now. */
      count: number;
      keys: string[];
      /** Every entry, filled in only for a whole-area read: a write reports keys instead. */
      items: Record<string, string> | null;
    };

/**
 * Every storage read and write goes through this one snippet, evaluated in
 * the page.
 *
 * It is one function rather than four because the origin guard, the
 * exception guard and the read-back have to happen for all four operations,
 * and a guard present in three cases out of four is the one an agent
 * eventually trips over.
 */
function storageOperation(request: StorageRequest): StorageOutcome {
  const origin = location.origin;
  const url = location.href;

  // about:blank, a data: URL, a sandboxed frame: all opaque origins with no
  // storage behind them. Chromium's behaviour differs by case (some throw,
  // some hand back a bucket that evaporates), and BOTH of those look like
  // success to a caller who only checks for an exception.
  if (!origin || origin === 'null') {
    return { ok: false, blocked: 'opaque-origin', origin, url, detail: '' };
  }

  let store: WebStorage;
  try {
    store = request.area === 'localStorage' ? localStorage : sessionStorage;
    // Touch it: the property getter itself is what throws when storage is
    // blocked, by third-party cookie blocking or a browser data setting.
    void store.length;
  } catch (err) {
    return { ok: false, blocked: 'threw', origin, url, detail: err instanceof Error ? err.message : String(err) };
  }

  // Both passes over the area are written out longhand rather than factored
  // into a local helper. This whole function is serialized and re-evaluated
  // inside the browser, where nothing else from this module exists, and the
  // TypeScript loader the test suite uses rewrites a nested function
  // expression into a call to a `__name` helper that is not there either.
  // A nested function here fails at runtime, in the page, with a
  // ReferenceError that names none of this.
  const beforeKeys: string[] = [];
  const beforeItems: Record<string, string> = {};
  for (let i = 0; i < store.length; i += 1) {
    const k = store.key(i);
    if (k === null) continue;
    beforeKeys.push(k);
    beforeItems[k] = store.getItem(k) ?? '';
  }

  const key = request.key;
  const existedBefore = key !== null && Object.prototype.hasOwnProperty.call(beforeItems, key);

  try {
    if (request.op === 'set' && key !== null) store.setItem(key, request.value ?? '');
    if (request.op === 'remove' && key !== null) store.removeItem(key);
    if (request.op === 'clear') store.clear();
  } catch (err) {
    // A quota rejection is the realistic one: setItem throws and the area is
    // left exactly as it was.
    return { ok: false, blocked: 'threw', origin, url, detail: err instanceof Error ? err.message : String(err) };
  }

  const afterKeys: string[] = [];
  const afterItems: Record<string, string> = {};
  for (let i = 0; i < store.length; i += 1) {
    const k = store.key(i);
    if (k === null) continue;
    afterKeys.push(k);
    afterItems[k] = store.getItem(k) ?? '';
  }

  return {
    ok: true,
    origin,
    url,
    value: key === null ? null : store.getItem(key),
    existedBefore,
    countBefore: beforeKeys.length,
    count: afterKeys.length,
    keys: afterKeys,
    items: request.op === 'get' && key === null ? afterItems : null
  };
}

/**
 * Runs one storage operation against a tab, turning a storage area that is
 * not actually reachable into an error a person can act on.
 *
 * That refusal is the point of the helper. An agent that clears storage on a
 * tab which never navigated, and reads back a bare success, has a false pass:
 * it believes it reset the app's state when it reset nothing. Naming the URL
 * the tab is really on is what turns that into an obvious mistake.
 */
async function runStorage(
  page: Page,
  tool: string,
  request: StorageRequest
): Promise<Extract<StorageOutcome, { ok: true }>> {
  const outcome = await page.evaluate(storageOperation, request);
  if (outcome.ok) return outcome;

  if (outcome.blocked === 'opaque-origin') {
    throw new Error(
      `${tool} cannot touch ${request.area} on this tab: it is at ${outcome.url || 'about:blank'}, which has no origin. ` +
        'Web storage is scoped to an origin (scheme + host + port), and a page with no origin has no storage area ' +
        'behind it: reading it returns nothing and writing to it either throws or lands in a bucket that is thrown ' +
        'away. Navigate the tab to the origin you actually mean, then call this again. Nothing was read or changed.'
    );
  }
  throw new Error(
    `${tool} could not reach ${request.area} on ${outcome.url}: the browser refused access (${outcome.detail}). ` +
      'That is usually storage being blocked for this origin, a sandboxed frame, or a quota rejection on a write. ' +
      'Nothing was changed.'
  );
}

/** The fields every storage reply leads with, so a wrong-origin call is visible at a glance. */
function storageBase(
  pageIdValue: string,
  area: StorageAreaName,
  outcome: Extract<StorageOutcome, { ok: true }>
): Record<string, unknown> {
  return { pageId: pageIdValue, area, origin: outcome.origin, url: outcome.url };
}

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------

/** Identity of one cookie in the jar, which is the triple the browser keys on. */
/**
 * The full identity of a cookie in the jar.
 *
 * The partition is part of it, not decoration: a partitioned cookie and an
 * unpartitioned one sharing a name, domain and path are two different
 * cookies that the browser sends in different situations. Leaving it out of
 * the key is the same false pass matching on name alone used to be, one
 * level further in: installing a partitioned cookie would find the
 * unpartitioned one already in the jar and report the write as successful.
 */
function cookieKeyOf(name: string, domain: string, path: string, partitionKey?: string): string {
  return `${name} ${domain} ${path} ${partitionKey ?? ''}`;
}

function cookieKey(cookie: Cookie): string {
  return cookieKeyOf(cookie.name, cookie.domain, cookie.path, (cookie as { partitionKey?: string }).partitionKey);
}

/**
 * The identity a REQUESTED cookie will land in the jar under, computed the
 * same way the browser derives it, so a read-back can match on it rather
 * than on name alone.
 *
 * A cookie given with domain and path already has an explicit identity. One
 * given only with a url does not, until addCookies resolves it: verified
 * directly against Playwright (1.62) that it takes domain from the url's
 * hostname (port dropped) and path from the url's directory, i.e. everything
 * up to and including the last "/", defaulting to "/" when there is none.
 * Matching on name alone here is exactly the bug this replaces: "session",
 * "token" and "sid" collide across domains constantly, so a cookie one
 * domain rejected could be reported present because a same-named cookie for
 * an unrelated domain already sat in the jar.
 */
function requestedCookieKey(cookie: {
  name: string;
  domain?: string;
  path?: string;
  url?: string;
  partitionKey?: string;
}): string {
  if (cookie.domain !== undefined && cookie.path !== undefined) {
    return cookieKeyOf(cookie.name, cookie.domain, cookie.path, cookie.partitionKey);
  }
  const parsed = new URL(cookie.url as string);
  const lastSlash = parsed.pathname.lastIndexOf('/');
  const path = lastSlash === -1 ? '/' : parsed.pathname.slice(0, lastSlash + 1) || '/';
  return cookieKeyOf(cookie.name, parsed.hostname, path, cookie.partitionKey);
}

/**
 * A filter field for clear_cookies. Empty strings are rejected on purpose:
 * Playwright treats `{ name: '' }` as no filter at all and clears the whole
 * jar, which is the opposite of what someone passing a filter wants.
 */
function cookieFilter(what: string, example: string) {
  return z
    .string()
    .min(1)
    .optional()
    .describe(
      `Only remove cookies whose ${what} is exactly this, e.g. ${example}. Exact string match, not a pattern or a ` +
        'prefix. Filters combine with AND. Omit every filter to clear the whole jar.'
    );
}

// ---------------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------------

/** Anything outside this set is flattened, so a server-suggested name stays exactly one path segment. */
const unsafeInFilename = /[^A-Za-z0-9._ -]/g;

/**
 * Where one session's downloads are saved.
 *
 * Derived from the screenshot cache directory rather than configured in its
 * own right, because `src/shared/config.ts` is not this stream's file to
 * edit. The layout follows `screenshot`'s exactly, one directory per
 * session, for the same reason: a whole evening of parallel agents piling
 * files into one shared namespace lets sessions that are otherwise fully
 * isolated read each other's artefacts.
 *
 * The one deliberate difference from screenshots: nothing sweeps this
 * directory, so a saved download lives until someone deletes it. A
 * downloaded file is usually the evidence itself rather than a snapshot of
 * it, and a download quietly vanishing on a TTL is worse than a directory
 * that grows.
 */
export function downloadDir(screenshotCacheDir: string, sessionIdValue: string): string {
  return sessionCacheDir(join(dirname(screenshotCacheDir), 'downloads'), sessionIdValue);
}

/** Playwright dims its call log with ANSI escapes, which are noise in an agent's transcript. */
const ansiEscape = new RegExp('\\u001b\\[[0-9;]*m', 'g');

function messageOf(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).replace(ansiEscape, '');
}

/**
 * Tools that read and change a session's stored state: its cookie jar, its
 * two web storage areas, and the files it downloads.
 */
export const storageTools = defineTools({
  get_cookies: defineTool({
    description:
      'Read a session\'s cookies, optionally filtered, without changing anything. ' +
      contextScopedNote +
      ' Filtering matters in practice: a real app\'s jar is noisy, so pass urls to get only the cookies the browser ' +
      'would actually send to those addresses, and names to pick out the few you care about. The two combine, urls ' +
      'first (applied by the browser), then names. Values come back in full, httpOnly cookies included, which ' +
      'document.cookie cannot see. This does NOT decode or verify anything: a session token comes back as the opaque ' +
      'string it is. Use export_state instead when you want the whole state, cookies and localStorage together, for ' +
      'seeding a future session.',
    inputSchema: z.object({
      sessionId,
      urls: z
        .array(z.string().min(1))
        .optional()
        .describe(
          'Only return cookies that would be sent to these URLs, e.g. ["https://app.example.com/"]. This is the ' +
            'browser\'s own matching: domain, path, secure and expiry are all taken into account. Omit for the whole jar.'
        ),
      names: z
        .array(z.string().min(1))
        .optional()
        .describe('Only return cookies with one of these exact names. Exact matches, not prefixes or patterns.')
    }),
    async handler(ctx, args) {
      const target = ctx.sessions.resolve(args.sessionId);
      const all = await target.session.context.cookies(args.urls);
      const wanted = args.names === undefined ? null : new Set(args.names);
      const cookies = wanted === null ? all : all.filter(c => wanted.has(c.name));
      return text({
        sessionId: args.sessionId,
        count: cookies.length,
        totalInJar: all.length,
        ...(args.urls !== undefined ? { urls: args.urls } : {}),
        ...(args.names !== undefined ? { names: args.names } : {}),
        cookies
      });
    }
  }),

  set_cookies: defineTool({
    description:
      'Add or overwrite cookies in a session\'s jar, the way a server\'s Set-Cookie header would. ' +
      contextScopedNote +
      ' The usual use is starting a session already logged in without driving the login form. Each cookie needs ' +
      'either a url, or both a domain and a path: with neither, the browser has no idea what the cookie belongs to ' +
      'and the call is rejected. A cookie with the same name, domain and path as an existing one replaces it. ' +
      'Two things a url does silently that catch people out: the path comes from the url\'s DIRECTORY (a url ending ' +
      '/some/page gives path "/some/"), and an https url marks the cookie secure, so it will not be sent over http. ' +
      'Pass domain and path explicitly when either matters. This tool does NOT reload the page: a page already open ' +
      'will not re-read cookies by itself, so call reload or navigate afterwards for the app to see them. The result ' +
      'reports the cookies as they now exist in the jar, read back, not the request echoed. The read-back matches ' +
      'each requested cookie by its FULL identity, name, domain and path together, not by name alone: cookie names ' +
      'like "session" or "sid" collide across domains constantly, and matching by name alone would report a cookie ' +
      'as installed just because a same-named cookie for a different domain already sat in the jar. The partition ' +
      '(partitionKey) is part of that identity too, since a partitioned cookie is a different cookie from an ' +
      'unpartitioned one with the same name, domain and path. ' +
      'Whatever get_cookies gives you can be handed straight back here: partitionKey and Chromium\'s companion ' +
      '_crHasCrossSiteAncestor are both accepted and passed through to the browser unchanged. They used to be ' +
      'silently stripped, which installed a partitioned cookie as an unpartitioned one and reported success.',
    inputSchema: z.object({
      sessionId,
      cookies: z
        .array(
          z.object({
            name: z.string().min(1).describe('Cookie name.'),
            value: z.string().describe('Cookie value, sent verbatim. An empty string is allowed.'),
            url: z
              .string()
              .optional()
              .describe(
                'URL the cookie belongs to, e.g. "https://app.example.com/". Sets domain, path (from the url\'s ' +
                  'directory) and secure (for https) all at once. Give this OR both domain and path.'
              ),
            domain: z
              .string()
              .optional()
              .describe(
                'Cookie domain, e.g. "app.example.com". Prefix it with a dot (".example.com") to cover subdomains ' +
                  'too. Must be given together with path.'
              ),
            path: z.string().optional().describe('Cookie path, e.g. "/". Must be given together with domain.'),
            expires: z
              .number()
              .optional()
              .describe(
                'Expiry as a Unix time in SECONDS, not milliseconds. Omit for a session cookie, which dies when the ' +
                  'session is released. A time in the past deletes the cookie.'
              ),
            httpOnly: z
              .boolean()
              .optional()
              .describe('If true, the page\'s own JavaScript cannot read it via document.cookie. get_cookies still can.'),
            secure: z.boolean().optional().describe('If true, the cookie is only ever sent over https.'),
            sameSite: z
              .enum(['Strict', 'Lax', 'None'])
              .optional()
              .describe('SameSite policy. "None" requires secure: true, or the browser drops the cookie outright.'),
            partitionKey: z
              .string()
              .optional()
              .describe(
                'Partition (CHIPS) this cookie belongs to, as the top-level site that was in the address bar when ' +
                  'it was set, e.g. "https://top.example.com" for a cookie an embedded third party stored while ' +
                  'that site was open. A partitioned cookie is a DIFFERENT cookie from an unpartitioned one with ' +
                  'the same name, domain and path, and is only ever sent back under the same top-level site. ' +
                  'get_cookies reports this, so it is here to make that output installable again.'
              ),
            _crHasCrossSiteAncestor: z
              .boolean()
              .optional()
              .describe(
                'Chromium\'s own companion flag to partitionKey, reported by get_cookies and passed straight back ' +
                  'to the browser. Named with a leading underscore because it is Chromium\'s field, not a stable ' +
                  'part of any cookie standard: accepted so a get_cookies result round-trips verbatim, rather than ' +
                  'because it is worth setting by hand.'
              )
          })
        )
        .min(1)
        .describe('The cookies to install. All of them are applied together.')
    }),
    async handler(ctx, args) {
      const target = ctx.sessions.resolve(args.sessionId);
      for (const cookie of args.cookies) {
        const hasUrl = cookie.url !== undefined;
        const hasPair = cookie.domain !== undefined && cookie.path !== undefined;
        if (!hasUrl && !hasPair) {
          throw new Error(
            `set_cookies cannot install the cookie ${JSON.stringify(cookie.name)}: a cookie needs either "url", or ` +
              'both "domain" and "path", so the browser knows where it belongs. Neither was given.'
          );
        }
      }

      await target.session.context.addCookies(args.cookies);

      // Read the jar back and report the entries matching what was asked
      // for, keyed on the full name+domain+path identity rather than name
      // alone. Matching by name alone let a cookie the browser genuinely
      // rejected (sameSite "None" without secure, say) read as installed
      // whenever an unrelated, same-named cookie for a different domain
      // already sat in the jar: the jar filter found THAT cookie and this
      // tool reported it as if it were the one just requested.
      const jar = await target.session.context.cookies();
      const jarByKey = new Map(jar.map(c => [cookieKey(c), c] as const));
      const cookies = [...new Set(args.cookies.map(requestedCookieKey))]
        .map(key => jarByKey.get(key))
        .filter((c): c is Cookie => c !== undefined);
      const missing = args.cookies.filter(c => !jarByKey.has(requestedCookieKey(c))).map(c => c.name);

      return text({
        sessionId: args.sessionId,
        requested: args.cookies.length,
        cookies,
        totalInJar: jar.length,
        ...(missing.length > 0
          ? {
              missing,
              note:
                `The browser did not keep ${missing.join(', ')}. A cookie is dropped silently when its attributes ` +
                'contradict each other, most often sameSite "None" without secure: true, or a domain that does not ' +
                'match the url. This is also what a genuinely rejected cookie looks like when a same-named cookie ' +
                'for a different domain or path already exists: "missing" is computed on the full name, domain and ' +
                'path triple, so that case is not hidden by the coincidence. Trust "cookies", not the request.'
            }
          : {})
      });
    }
  }),

  clear_cookies: defineTool({
    description:
      'Remove cookies from a session\'s jar: the fast way to log a session out, or to check how a flow behaves for a ' +
      'first-time visitor. ' +
      contextScopedNote +
      ' With no filter it empties the jar completely. Pass name, domain or path to narrow it: they are exact string ' +
      'matches and combine with AND. An unrecognised filter key is REJECTED rather than ignored, because Playwright ' +
      'itself ignores one and would quietly clear everything instead of the single cookie a typo meant to name. This ' +
      'tool does NOT reload the page: a page already open keeps whatever it read into memory, so reload afterwards ' +
      'to see the app behave as logged out. The result lists exactly which cookies went, worked out by comparing the ' +
      'jar before and after, so a filter that matched nothing is obvious rather than looking like a success.',
    // Strict on purpose (every tool's schema now is at every depth, via
    // defineTool's deepStrict, but this one was strict first and for a
    // sharper reason). Playwright 1.62's clearCookies ignores a key it does not
    // recognise, so clearCookies({ nmae: 'sid' }) empties the entire jar and
    // reports success. Nothing downstream can tell that apart from a
    // deliberate full clear, so the typo has to die here, not just get a
    // generic "unrecognized parameter" message.
    inputSchema: z.strictObject({
      sessionId,
      name: cookieFilter('name', '"session-id"'),
      domain: cookieFilter('domain', '"app.example.com"'),
      path: cookieFilter('path', '"/api/v1"')
    }),
    async handler(ctx, args) {
      const target = ctx.sessions.resolve(args.sessionId);
      const filters = {
        ...(args.name !== undefined ? { name: args.name } : {}),
        ...(args.domain !== undefined ? { domain: args.domain } : {}),
        ...(args.path !== undefined ? { path: args.path } : {})
      };

      const before = await target.session.context.cookies();
      await target.session.context.clearCookies(filters);
      const after = await target.session.context.cookies();

      const survived = new Set(after.map(cookieKey));
      const removed = before.filter(c => !survived.has(cookieKey(c)));

      return text({
        sessionId: args.sessionId,
        filters,
        removedCount: removed.length,
        removed: removed.map(c => ({ name: c.name, domain: c.domain, path: c.path })),
        remainingCount: after.length,
        ...(removed.length === 0 && before.length > 0
          ? {
              note:
                `Nothing matched. The jar still holds ${after.length} cookie(s), so the filter named something that ` +
                'is not in it. Call get_cookies to see the real names, domains and paths: a cookie set for ' +
                '".example.com" is not matched by "example.com".'
            }
          : {})
      });
    }
  }),

  get_storage: defineTool({
    description:
      'Read a tab\'s localStorage or sessionStorage. Give a key to read one entry, or omit it to get every entry in ' +
      'the area. ' +
      originScopedNote +
      ' A one-key read reports "present" alongside "value", so a key that is absent stays distinguishable from a key ' +
      'holding an empty string, which reading through evaluate cannot tell you without extra care. Values are always ' +
      'strings: an app storing JSON gets its JSON text back, unparsed. Reads nothing outside the named area, and ' +
      'changes nothing.',
    inputSchema: z.object({
      sessionId,
      pageId,
      area: storageArea,
      key: z.string().optional().describe('The entry to read. Omit to read every entry in the area.')
    }),
    async handler(ctx, args) {
      const target = ctx.sessions.resolve(args.sessionId, args.pageId);
      const outcome = await runStorage(target.page, 'get_storage', {
        area: args.area,
        op: 'get',
        key: args.key ?? null,
        value: null
      });
      const base = storageBase(target.pageId, args.area, outcome);
      if (args.key === undefined) {
        return text({ ...base, count: outcome.count, items: outcome.items ?? {} });
      }
      return text({
        ...base,
        key: args.key,
        present: outcome.existedBefore,
        value: outcome.value,
        count: outcome.count
      });
    }
  }),

  set_storage: defineTool({
    description:
      'Write one entry into a tab\'s localStorage or sessionStorage, replacing any existing value for that key. ' +
      originScopedNote +
      ' Values are strings and nothing else: to store an object, pass its JSON text, and remember the app is the one ' +
      'that will parse it. Writing does NOT notify the page: a "storage" event only fires in OTHER tabs of the same ' +
      'origin, and a framework that read the value at startup will not re-read it, so reload afterwards when the app ' +
      'needs to pick the change up. The result reports the value read back OUT of storage, plus how many entries the ' +
      'area now holds, so a write the page immediately overwrote or rejected shows up as a mismatch rather than a success.',
    inputSchema: z.object({
      sessionId,
      pageId,
      area: storageArea,
      key: z.string().min(1).describe('The entry to write.'),
      value: z
        .string()
        .describe(
          'The value to store, verbatim. An empty string is a valid value, not a delete: use remove_storage to delete.'
        )
    }),
    async handler(ctx, args) {
      const target = ctx.sessions.resolve(args.sessionId, args.pageId);
      const outcome = await runStorage(target.page, 'set_storage', {
        area: args.area,
        op: 'set',
        key: args.key,
        value: args.value
      });
      const matched = outcome.value === args.value;
      return text({
        ...storageBase(target.pageId, args.area, outcome),
        key: args.key,
        requested: args.value,
        value: outcome.value,
        matched,
        replaced: outcome.existedBefore,
        count: outcome.count,
        keys: outcome.keys,
        ...(matched
          ? {}
          : {
              note:
                `The entry does not hold what was written. Expected ${JSON.stringify(args.value)}, it now holds ` +
                `${JSON.stringify(outcome.value)}. The page may have overwritten it between the write and the read. ` +
                'Trust "value", not "requested".'
            })
      });
    }
  }),

  remove_storage: defineTool({
    description:
      'Delete one entry from a tab\'s localStorage or sessionStorage. ' +
      originScopedNote +
      ' Removing a key that was never there is not an error, but it is not silent either: the result says ' +
      '"removed": false, which is what tells you a key name was wrong rather than the state already being clean. ' +
      'Removes exactly one key: use clear_storage to empty the whole area. Does NOT notify the page, so reload if the ' +
      'app needs to notice.',
    inputSchema: z.object({
      sessionId,
      pageId,
      area: storageArea,
      key: z.string().min(1).describe('The entry to delete.')
    }),
    async handler(ctx, args) {
      const target = ctx.sessions.resolve(args.sessionId, args.pageId);
      const outcome = await runStorage(target.page, 'remove_storage', {
        area: args.area,
        op: 'remove',
        key: args.key,
        value: null
      });
      return text({
        ...storageBase(target.pageId, args.area, outcome),
        key: args.key,
        removed: outcome.existedBefore,
        value: outcome.value,
        count: outcome.count,
        keys: outcome.keys,
        ...(outcome.existedBefore
          ? {}
          : {
              note:
                `There was no entry named ${JSON.stringify(args.key)} in ${args.area} on ${outcome.origin}, so ` +
                'nothing was deleted. Check the key name and the origin against "keys" before reading this as a ' +
                'state reset.'
            })
      });
    }
  }),

  clear_storage: defineTool({
    description:
      'Empty a tab\'s localStorage or sessionStorage completely: the usual way to reset state between checks without ' +
      'throwing the whole session away. ' +
      originScopedNote +
      ' Clears ONE area for ONE origin. It does not touch the other area, it does not touch other origins the ' +
      'session has visited, and it does not touch cookies: use clear_cookies for those, and call this again after ' +
      'navigating if a second origin also needs clearing. Does NOT reload the page, so an app that already read its ' +
      'state into memory keeps running on it until you reload. The result reports how many entries were removed and ' +
      'that the area is now empty, both read back, so clearing the wrong origin cannot look like a clean reset.',
    inputSchema: z.object({
      sessionId,
      pageId,
      area: storageArea
    }),
    async handler(ctx, args) {
      const target = ctx.sessions.resolve(args.sessionId, args.pageId);
      const outcome = await runStorage(target.page, 'clear_storage', {
        area: args.area,
        op: 'clear',
        key: null,
        value: null
      });
      return text({
        ...storageBase(target.pageId, args.area, outcome),
        removedCount: outcome.countBefore,
        count: outcome.count,
        ...(outcome.countBefore === 0
          ? {
              note:
                `${args.area} was already empty on ${outcome.origin}, so this changed nothing. If you expected state ` +
                'here, the tab is probably on a different origin than the one you meant.'
            }
          : {})
      });
    }
  }),

  download_file: defineTool({
    description:
      'Trigger a download and save the file, in one call. Give the action that STARTS the download, usually a ' +
      'selector to click, and this waits for the browser\'s download event, saves the file, and returns where it ' +
      'went, the filename the server suggested, and its size in bytes. ' +
      'It has to do the triggering itself: a download is an event, not a page state, so there is no way to click ' +
      'with another tool first and come back for the file afterwards. The wait is armed BEFORE the trigger fires, so ' +
      'an instant download cannot be missed. ' +
      'Files are saved into this session\'s own directory, isolated from every other session, under a unique name, ' +
      'so downloading the same file twice keeps both copies instead of overwriting. Nothing sweeps that directory: ' +
      'the file stays until someone deletes it. Nothing viewable comes back, only the path, so seeing the contents ' +
      'costs a separate file read. ' +
      'If no download starts within the timeout, that is reported as exactly that, and it is a genuinely different ' +
      'outcome from a download that started and then failed to save. The most common cause is a link the server ' +
      'sends without a Content-Disposition attachment header, which the browser simply navigates to instead.',
    inputSchema: z.object({
      sessionId,
      pageId,
      selector: z
        .string()
        .optional()
        .describe(
          'Playwright selector of the element to click to start the download, e.g. "#export" or "text=Download CSV". ' +
            'Mutually exclusive with "expression".'
        ),
      expression: z
        .string()
        .optional()
        .describe(
          'JavaScript evaluated in the page to start the download, for a trigger no click can reach, e.g. ' +
            '"document.querySelector(\'#hidden-link\').click()". Mutually exclusive with "selector".'
        ),
      timeoutMs: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(
          'How long to allow in TOTAL for the trigger to run and a download to start, in milliseconds. Defaults to ' +
            '30000. The clock starts before the trigger, not after it, so a slow-to-appear button eats into the same ' +
            'budget. Raise it when the server generates the file on demand.'
        )
    }),
    async handler(ctx, args) {
      const hasSelector = args.selector !== undefined;
      const hasExpression = args.expression !== undefined;
      if (hasSelector === hasExpression) {
        throw new Error(
          'download_file needs exactly one of "selector" (an element to click) or "expression" (JavaScript to run): ' +
            `${hasSelector ? 'both were given' : 'neither was given'}.`
        );
      }

      const target = ctx.sessions.resolve(args.sessionId, args.pageId);
      const timeout = args.timeoutMs ?? 30_000;

      // Armed before the trigger, never after: a small file can finish
      // downloading before a listener attached afterwards would exist, and
      // that race surfaces as a flaky "no download started".
      const waiter = target.page.waitForEvent('download', { timeout });
      // Attaching a handler now keeps a timeout from surfacing as an
      // unhandled rejection if the trigger itself throws first.
      waiter.catch(() => {});

      // A trigger that navigates can tear down its own execution context, so
      // its failure is recorded rather than thrown: if a download arrived
      // anyway, the download is the answer.
      let triggerError: unknown;
      const startedAt = Date.now();
      try {
        if (args.selector !== undefined) {
          await target.page.click(args.selector, { timeout });
        } else {
          await target.page.evaluate(args.expression as string);
        }
      } catch (err) {
        triggerError = err;
      }

      let download;
      try {
        download = await waiter;
      } catch (err) {
        const waited = Date.now() - startedAt;
        if (triggerError !== undefined) {
          throw new Error(
            `download_file could not run its trigger, and no download started: ${messageOf(triggerError)}`
          );
        }
        if (err instanceof Error && err.name === 'TimeoutError') {
          throw new Error(
            `download_file triggered ${hasSelector ? `a click on ${JSON.stringify(args.selector)}` : 'its expression'} ` +
              `and waited ${timeout}ms, but no download started. Nothing was saved, and nothing failed to save: the ` +
              'browser was never offered a file. Usually the response carries no Content-Disposition attachment ' +
              'header, so the browser navigated to it instead, or the trigger opened something that is not a ' +
              'download at all. Check the tab with snapshot, or raise timeoutMs if the server takes longer than this ' +
              'to generate the file.'
          );
        }
        throw new Error(`download_file failed after ${waited}ms waiting for a download: ${messageOf(err)}`);
      }

      const failure = await download.failure();
      if (failure !== null) {
        throw new Error(
          `download_file started a download of ${JSON.stringify(download.suggestedFilename())} from ` +
            `${download.url()}, but the browser did not finish it: ${failure}. Nothing was saved.`
        );
      }

      const suggestedFilename = download.suggestedFilename();
      const dir = downloadDir(ctx.config.screenshotCacheDir, target.session.id);
      await mkdir(dir, { recursive: true });
      // The uuid prefix is what keeps the same suggested name, downloaded
      // twice, from becoming one file. The name itself is flattened to a
      // single path segment: it comes from a remote server, and it is the
      // only remote string in this daemon that becomes a filesystem path.
      const downloadId = randomUUID();
      const safeName = suggestedFilename.replace(unsafeInFilename, '_').trim();
      const filePath = join(dir, `${downloadId}-${safeName.length > 0 ? safeName : 'download'}`);

      try {
        await download.saveAs(filePath);
      } catch (err) {
        throw new Error(
          `download_file downloaded ${JSON.stringify(suggestedFilename)} but could not save it to ${filePath}: ` +
            `${messageOf(err)}. The download itself succeeded, so this is a filesystem problem, not a page problem.`
        );
      }

      const sizeBytes = (await stat(filePath)).size;
      return text({
        pageId: target.pageId,
        downloadId,
        path: filePath,
        suggestedFilename,
        sizeBytes,
        url: download.url(),
        ...(sizeBytes === 0
          ? { note: 'The file saved with zero bytes. The download completed, but the server sent an empty body.' }
          : {})
      });
    }
  })
});
