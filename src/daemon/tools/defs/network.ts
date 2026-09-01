import { randomUUID } from 'node:crypto';

import type { CDPSession, Page, Route } from 'playwright';
import * as z from 'zod/v4';

import type { ResolvedTarget } from '../../sessions.js';
import { defineTool, defineTools, text, type ToolContext } from '../types.js';
import { sessionId } from './common.js';

/**
 * The one browser global this module reads back. The daemon's tsconfig has no
 * "dom" lib on purpose, so the snippet gets its own declaration rather than
 * opening the whole DOM to daemon code.
 */
declare const navigator: { onLine: boolean };

// ---------------------------------------------------------------------------
// Shared vocabulary
// ---------------------------------------------------------------------------

/**
 * The three ways to name traffic. Two of them are exactly
 * `list_network_requests`'s own fields, and mean exactly the same thing there,
 * so a filter that found the request you want can be pasted straight into a
 * rule that intercepts it.
 */
const urlGlob = z
  .string()
  .optional()
  .describe(
    'Playwright URL glob, matched against the WHOLE absolute URL including scheme and host, so start it with ** ' +
      '(e.g. "**/api/save"). "*" matches anything except a slash, "**" matches across slashes, "?" matches one ' +
      'character. The match is against the full URL INCLUDING ITS QUERY STRING, which is the usual way a glob ' +
      'silently intercepts nothing: "**/save" does not match "/save?id=7", so write "**/save*" when the URL may ' +
      'carry a query. urlIncludes is easier to get right when you only care about part of the path. Mutually ' +
      'exclusive with urlIncludes and urlMatches.'
  );

const urlIncludes = z
  .string()
  .optional()
  .describe(
    'Intercept URLs containing this substring, matched case-insensitively. Same meaning as list_network_requests\' ' +
      'urlIncludes. Mutually exclusive with urlGlob and urlMatches.'
  );

const urlMatches = z
  .string()
  .optional()
  .describe(
    'Intercept URLs matching this JavaScript regular expression source, e.g. "/api/.*/save$". Same meaning as ' +
      'list_network_requests\' urlMatches. Mutually exclusive with urlGlob and urlIncludes.'
  );

/** Playwright's own abort reasons. Anything outside this set is rejected by Chromium. */
const abortErrorCodes = [
  'aborted',
  'accessdenied',
  'addressunreachable',
  'blockedbyclient',
  'blockedbyresponse',
  'connectionaborted',
  'connectionclosed',
  'connectionfailed',
  'connectionrefused',
  'connectionreset',
  'internetdisconnected',
  'namenotresolved',
  'timedout',
  'failed'
] as const;

type MatcherKind = 'glob' | 'includes' | 'matches';

/** Escapes a literal substring so it can be matched by a case-insensitive RegExp. */
function escapeForRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Per-session state
// ---------------------------------------------------------------------------

interface RuleRecord {
  id: string;
  createdAt: number;
  matcher: { kind: MatcherKind; source: string };
  /** What was handed to context.route, kept verbatim so context.unroute can undo exactly it. */
  pattern: string | RegExp;
  handler: (route: Route) => Promise<void>;
  action: 'fulfill' | 'abort' | 'continue';
  /** The action's own settings, echoed back by list_route_rules so a rule is readable without re-deriving it. */
  detail: Record<string, unknown>;
  methods?: string[];
  resourceTypes?: string[];
  times?: number;
  matchCount: number;
  skippedByFilter: number;
  skippedAfterLimit: number;
  errors: number;
  lastError?: string;
}

interface Throttle {
  preset: string | null;
  downloadKbps: number | null;
  uploadKbps: number | null;
  latencyMs: number;
}

interface SessionNetState {
  /** Registration order, oldest first. Evaluation is the reverse of this. */
  rules: RuleRecord[];
  offline: boolean;
  throttle: Throttle | null;
  /** CDP sessions held open per page. Held, not detached, because detaching drops the emulation. */
  cdp: Map<Page, CDPSession>;
  /**
   * Pages whose close handler is already registered.
   *
   * Without it, every attach registered another `once('close')` and every
   * detach left it behind, so toggling a throttle profile on and off piled up
   * one dead listener per cycle on the same tab: at ten Node warns about a
   * leak, and a long QA run does far more than ten. One handler per page is
   * enough, since all it does is drop that page from the map, which is a
   * no-op when there is nothing to drop.
   */
  closeHooked: WeakSet<Page>;
}

/**
 * All network state, keyed by session id, living here rather than on the
 * session record itself. sessions.ts is not this module's to edit, and keeping
 * it local means nothing outside can hold a stale reference to a rule.
 *
 * The entry is deleted by the session's own BrowserContext "close" event,
 * which covers every way a session ends: release_session, the idle reaper, and
 * daemon shutdown. Nothing has to remember to clean up.
 */
const netStates = new Map<string, SessionNetState>();

/**
 * How many sessions currently hold network state. Exported for the tests that
 * prove a released session leaves nothing behind: a leak here would be an
 * unbounded map plus a live CDP session per page, which is exactly the failure
 * mode this table is most at risk of.
 */
export function routeStateSessionCount(): number {
  return netStates.size;
}

function stateFor(ctx: ToolContext, id: string): { state: SessionNetState; target: ResolvedTarget } {
  // resolve() first: an unknown session must fail with the store's own
  // SessionNotFoundError rather than silently getting fresh, empty state.
  const target = ctx.sessions.resolve(id);
  const existing = netStates.get(id);
  if (existing) return { state: existing, target };

  const state: SessionNetState = {
    rules: [],
    offline: false,
    throttle: null,
    cdp: new Map(),
    closeHooked: new WeakSet()
  };
  // Both listeners are registered BEFORE the entry is published, so there is
  // no window in which netStates holds an entry that nothing will ever remove.
  // Registered first, the worst case is a listener on a context with no state
  // behind it, which is inert; published first, a throwing addListener leaks
  // the entry for the life of the daemon.
  target.session.context.once('close', () => {
    netStates.delete(id);
  });
  // A tab opened after a throttle profile was set would otherwise run at full
  // speed while every other tab is capped.
  target.session.context.on('page', page => {
    void attachThrottleToPage(state, target, page).catch(() => {});
  });
  netStates.set(id, state);
  return { state, target };
}

/** Read-only view: never creates state, so merely listing rules cannot make the table grow. */
function peekState(ctx: ToolContext, id: string): SessionNetState | undefined {
  ctx.sessions.resolve(id);
  return netStates.get(id);
}

// ---------------------------------------------------------------------------
// Rule evaluation
// ---------------------------------------------------------------------------

/**
 * One rule's Playwright route handler.
 *
 * Every path that does not act calls `route.fallback()`, which is what hands
 * the request to the next matching rule and, if none takes it, to the real
 * network. A handler that returned without calling anything would leave the
 * request hanging forever.
 */
function makeHandler(rule: RuleRecord): (route: Route) => Promise<void> {
  return async (route: Route) => {
    const request = route.request();

    if (rule.methods && !rule.methods.includes(request.method().toUpperCase())) {
      rule.skippedByFilter += 1;
      await route.fallback();
      return;
    }
    if (rule.resourceTypes && !rule.resourceTypes.includes(request.resourceType())) {
      rule.skippedByFilter += 1;
      await route.fallback();
      return;
    }
    if (rule.times !== undefined && rule.matchCount >= rule.times) {
      rule.skippedAfterLimit += 1;
      await route.fallback();
      return;
    }

    rule.matchCount += 1;
    try {
      if (rule.action === 'fulfill') {
        await route.fulfill(rule.detail.fulfill as Parameters<Route['fulfill']>[0]);
        return;
      }
      if (rule.action === 'abort') {
        await route.abort(rule.detail.errorCode as (typeof abortErrorCodes)[number]);
        return;
      }
      // continue: overrides are merged onto the request's real headers rather
      // than replacing them, so injecting one header does not strip the rest.
      const overrides = rule.detail.continue as {
        url?: string;
        method?: string;
        postData?: string;
        headers?: Record<string, string>;
      };
      await route.continue({
        ...(overrides.url !== undefined ? { url: overrides.url } : {}),
        ...(overrides.method !== undefined ? { method: overrides.method } : {}),
        ...(overrides.postData !== undefined ? { postData: overrides.postData } : {}),
        ...(overrides.headers !== undefined ? { headers: { ...request.headers(), ...overrides.headers } } : {})
      });
    } catch (err) {
      // A page closing mid-flight, or a request already handled, lands here.
      // Counted rather than swallowed: an action that keeps failing is the
      // difference between a mock that works and one that only looks set up.
      rule.errors += 1;
      rule.lastError = messageOf(err);
    }
  };
}

/** One rule as reported back, in the same shape everywhere it is reported. */
function describeRule(rule: RuleRecord, evaluationOrder: number): Record<string, unknown> {
  return {
    ruleId: rule.id,
    evaluationOrder,
    match: { [rule.matcher.kind]: rule.matcher.source },
    action: rule.action,
    ...rule.detail,
    ...(rule.methods ? { methods: rule.methods } : {}),
    ...(rule.resourceTypes ? { resourceTypes: rule.resourceTypes } : {}),
    times: rule.times ?? null,
    remaining: rule.times === undefined ? null : Math.max(0, rule.times - rule.matchCount),
    matchCount: rule.matchCount,
    neverMatched: rule.matchCount === 0,
    skippedByFilter: rule.skippedByFilter,
    skippedAfterLimit: rule.skippedAfterLimit,
    errors: rule.errors,
    ...(rule.lastError !== undefined ? { lastError: rule.lastError } : {}),
    createdAt: rule.createdAt
  };
}

/** Rules in the order they are actually tried: most recently added first. */
function inEvaluationOrder(state: SessionNetState): Record<string, unknown>[] {
  return [...state.rules].reverse().map((rule, index) => describeRule(rule, index));
}

function neverMatchedNote(rules: Record<string, unknown>[]): { neverMatchedCount: number; note?: string } {
  const never = rules.filter(r => r.neverMatched === true);
  if (never.length === 0) return { neverMatchedCount: 0 };
  return {
    neverMatchedCount: never.length,
    note:
      `${never.length} rule(s) never matched a single request. A mock that never fired proves nothing: the traffic ` +
      'you meant to intercept either did not happen, or its URL is not what the rule matches. Check ' +
      'list_network_requests for the URL the page really requested before trusting a result that depended on this mock.'
  };
}

// ---------------------------------------------------------------------------
// Offline and throttling
// ---------------------------------------------------------------------------

const throttlePresets = {
  'slow-3g': { downloadKbps: 400, uploadKbps: 400, latencyMs: 2000 },
  'fast-3g': { downloadKbps: 1440, uploadKbps: 675, latencyMs: 563 },
  '4g': { downloadKbps: 4000, uploadKbps: 3000, latencyMs: 100 },
  wifi: { downloadKbps: 30000, uploadKbps: 15000, latencyMs: 2 }
} as const;

type PresetName = keyof typeof throttlePresets;

/** Chromium wants bytes per second; network speeds are quoted in kilobits. -1 means no cap. */
function toBytesPerSecond(kbps: number | null): number {
  return kbps === null ? -1 : Math.round((kbps * 1000) / 8);
}

function conditionsFor(state: SessionNetState): {
  offline: boolean;
  latency: number;
  downloadThroughput: number;
  uploadThroughput: number;
} {
  return {
    // The offline flag rides on the SAME CDP call as the throughput caps on
    // purpose. Chromium's throttling layer owns an offline flag of its own,
    // and leaving it false while Playwright's context-level offline is true
    // produces the worst possible state: navigator.onLine reads false while
    // every request still succeeds.
    offline: state.offline,
    latency: state.throttle?.latencyMs ?? 0,
    downloadThroughput: toBytesPerSecond(state.throttle?.downloadKbps ?? null),
    uploadThroughput: toBytesPerSecond(state.throttle?.uploadKbps ?? null)
  };
}

/**
 * Registers this state's page-close handler exactly once per page.
 *
 * Once, because the handler is only ever needed to drop the page from
 * `state.cdp`, and re-registering it on every attach (while every detach left
 * the old one behind) grew the tab's listener list by one per throttle
 * on/off cycle.
 */
function hookClose(state: SessionNetState, page: Page): void {
  if (state.closeHooked.has(page)) return;
  state.closeHooked.add(page);
  page.once('close', () => {
    state.cdp.delete(page);
  });
}

/**
 * Attaches a CDP session to one page and enables the Network domain, leaving
 * NOTHING behind if either step fails.
 *
 * The session is recorded in `state.cdp` before the first await that can
 * throw, because that map is the only handle any teardown path has. Attaching
 * and enabling first and recording afterwards is what orphaned a session:
 * `newCDPSession` had already attached it to Chromium, a throwing
 * `Network.enable` skipped the line that recorded it, and the result was a
 * live CDP session that release_session, the close hook and syncConditions'
 * own detach loop could all no longer see. Verified against real Chromium:
 * after a failed enable the orphan still answered Runtime.evaluate, and the
 * next attempt attached a SECOND session to the same page. Same defect class
 * as the BrowserContext a rejected create_session used to leak, one layer
 * down, and it matters for the same reason: this daemon is shared
 * machine-wide, so it accumulates one per attempt across every agent.
 *
 * Both callers go through here rather than repeating the sequence, since two
 * copies of it is how one of them came to be fixed and the other not.
 */
async function attachCdp(state: SessionNetState, target: ResolvedTarget, page: Page): Promise<CDPSession> {
  const cdp = await target.session.context.newCDPSession(page);
  state.cdp.set(page, cdp);
  hookClose(state, page);
  try {
    await cdp.send('Network.enable');
  } catch (err) {
    // Undo the registration as well as the attachment: a session that never
    // enabled the Network domain must not be handed to emulateNetworkConditions
    // by the next sync as though it were ready.
    state.cdp.delete(page);
    await cdp.detach().catch(() => {
      // Already gone, or its page died with it. The caller's original failure
      // is what needs to surface, not this one.
    });
    throw err;
  }
  return cdp;
}

/** Attaches to one page and applies the current conditions, if there is anything to apply. */
async function attachThrottleToPage(state: SessionNetState, target: ResolvedTarget, page: Page): Promise<void> {
  if (state.throttle === null || page.isClosed() || state.cdp.has(page)) return;
  const cdp = await attachCdp(state, target, page);
  await cdp.send('Network.emulateNetworkConditions', conditionsFor(state));
}

/**
 * Pushes the session's current offline and throttle state to every tab, and
 * reports which tabs it actually reached.
 *
 * The CDP sessions are held open rather than detached after each call, which
 * is not an optimisation: the override is dropped the moment its CDP session
 * detaches, verified directly (a 1MB fetch capped to 50KB/s took 19.7s with
 * the session held and 5ms after detaching). That is also why send_cdp_command
 * cannot be used for throttling: it detaches after every call.
 */
async function syncConditions(
  state: SessionNetState,
  target: ResolvedTarget
): Promise<{ applied: string[]; failed: string[] }> {
  const applied: string[] = [];
  const failed: string[] = [];

  for (const [pageId, page] of target.session.pages) {
    if (page.isClosed()) continue;
    let cdp = state.cdp.get(page);
    if (!cdp) {
      // Nothing to throttle and nothing already attached: leave the tab alone
      // rather than attaching a CDP session just to say "no limits".
      if (state.throttle === null) continue;
      cdp = await attachCdp(state, target, page);
    }
    try {
      await cdp.send('Network.emulateNetworkConditions', conditionsFor(state));
      applied.push(pageId);
    } catch {
      // A tab whose CDP session has gone stale between being stored and being
      // used again (the tab crashed, or is mid-navigation into a fresh
      // process) must not be reported as reached. Swallowing this used to
      // push the pageId onto "applied" regardless, so a tab the emulation
      // never touched came back looking exactly like one that was really
      // throttled or taken offline.
      failed.push(pageId);
    }
  }

  // With no throttle left and the session online, the held sessions have no
  // job: let them go. While OFFLINE they are kept, because detaching restores
  // Chromium's own onLine flag to true while Playwright's context-level
  // offline keeps failing every request, which is the same lie in reverse.
  if (state.throttle === null && !state.offline) {
    for (const [page, cdp] of state.cdp) {
      await cdp.detach().catch(() => {});
      state.cdp.delete(page);
    }
  }

  return { applied, failed };
}

/** What the browser itself says, rather than what was asked for. */
function readOnLine(target: ResolvedTarget): Promise<boolean | undefined> {
  return target.page.evaluate(() => navigator.onLine).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/** Tools that intercept, mock, block or degrade a session's network traffic. */
export const networkTools = defineTools({
  add_route_rule: defineTool({
    description:
      'Intercept matching network requests in a session and fulfil, abort or rewrite them, so a failure you cannot ' +
      'reliably provoke becomes a one-line deterministic test: a forced 413 to reproduce a retry storm, a forced 500 ' +
      'against a forced 400 to tell a transient failure path from a permanent one, a forced abort to stand in for a ' +
      'dead endpoint. The rule is declarative: there is no way to run your own JavaScript per request, so what a ' +
      'rule returns cannot depend on the request body or on how many requests came before it, beyond the "times" ' +
      'budget. ' +
      'Give EXACTLY ONE url matcher (urlGlob, urlIncludes or urlMatches). A rule that matches everything has to be ' +
      'written deliberately, as urlGlob "**". ' +
      'ORDERING: when several rules match one request, the MOST RECENTLY ADDED matching rule wins and the others are ' +
      'not consulted, the same way Playwright\'s own route handlers resolve. So a broad rule added first can be ' +
      'narrowed later by a specific rule without removing it, and list_route_rules lists rules in that evaluation ' +
      'order. ' +
      'Rules live on the session\'s whole browser context, so they cover every tab in the session, including tabs ' +
      'opened later, they never touch another session, and they are dropped when the session ends. ' +
      'NOT covered: WebSocket and EventSource traffic, requests made by a service worker, anything the browser ' +
      'serves from its own cache without asking the network, and any request made outside this browser. Response ' +
      'bodies are text only: there is no binary or base64 body. ' +
      'Verify rather than assume: a fulfilled response shows up in list_network_requests with the MOCKED status, and ' +
      'list_route_rules reports how many times each rule actually fired. A rule sitting at matchCount 0 intercepted ' +
      'nothing at all, whatever the page appeared to do.',
    inputSchema: z.object({
      sessionId,
      urlGlob,
      urlIncludes,
      urlMatches,
      action: z
        .enum(['fulfill', 'abort', 'continue'])
        .describe(
          '"fulfill": answer the request from here and never touch the real server. "abort": fail the request at ' +
            'the network layer, the way a dead or refused endpoint would. "continue": let it reach the real server, ' +
            'optionally rewritten first.'
        ),
      status: z
        .number()
        .int()
        .min(100)
        .max(599)
        .optional()
        .describe('fulfill only: HTTP status to answer with. Defaults to 200.'),
      body: z
        .string()
        .optional()
        .describe('fulfill only: response body, as text. Defaults to empty. Binary bodies are not supported.'),
      contentType: z
        .string()
        .optional()
        .describe('fulfill only: Content-Type of the mocked response, e.g. "application/json".'),
      headers: z
        .record(z.string(), z.string())
        .optional()
        .describe('fulfill only: extra response headers, e.g. {"retry-after": "30"}.'),
      errorCode: z
        .enum(abortErrorCodes)
        .optional()
        .describe(
          'abort only: how the request fails. Defaults to "failed". "connectionrefused", "timedout", ' +
            '"internetdisconnected" and "namenotresolved" are the ones an app is most likely to branch on.'
        ),
      overrideUrl: z
        .string()
        .optional()
        .describe('continue only: send the request to this absolute URL instead of the one the page asked for.'),
      overrideMethod: z.string().optional().describe('continue only: replace the HTTP method, e.g. "PUT".'),
      overrideHeaders: z
        .record(z.string(), z.string())
        .optional()
        .describe(
          'continue only: request headers to set. MERGED onto the request\'s real headers, so a header you do not ' +
            'name is left alone rather than stripped.'
        ),
      overridePostData: z.string().optional().describe('continue only: replace the request body, as text.'),
      methods: z
        .array(z.string())
        .optional()
        .describe(
          'Only intercept these HTTP methods, matched case-insensitively, e.g. ["POST", "PUT"]. Requests of other ' +
            'methods fall through to the next rule or to the real server, and are counted as skippedByFilter.'
        ),
      resourceTypes: z
        .array(z.string())
        .optional()
        .describe(
          'Only intercept these Playwright resource types, e.g. ["xhr", "fetch"] or ["image"]. Same vocabulary as ' +
            'list_network_requests\' resourceType. Note that a fetch() for an image URL is type "fetch", not "image".'
        ),
      times: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(
          'Fire at most this many times, then fall through as if the rule were gone. Use it to fail the first N ' +
            'attempts and let a retry succeed. Unset means unlimited. An exhausted rule stays listed, with ' +
            'remaining 0.'
        )
    }),
    async handler(ctx, args) {
      const given = [
        args.urlGlob !== undefined ? 'urlGlob' : null,
        args.urlIncludes !== undefined ? 'urlIncludes' : null,
        args.urlMatches !== undefined ? 'urlMatches' : null
      ].filter((v): v is string => v !== null);
      if (given.length !== 1) {
        throw new Error(
          `add_route_rule needs exactly one of urlGlob, urlIncludes or urlMatches: ${
            given.length === 0 ? 'none was given' : `${given.join(' and ')} were given`
          }. A rule with no url matcher would intercept every request in the session, so if that is what you want, ` +
            'say so explicitly with urlGlob "**".'
        );
      }

      let matcher: { kind: MatcherKind; source: string };
      let pattern: string | RegExp;
      if (args.urlGlob !== undefined) {
        matcher = { kind: 'glob', source: args.urlGlob };
        pattern = args.urlGlob;
      } else if (args.urlIncludes !== undefined) {
        matcher = { kind: 'includes', source: args.urlIncludes };
        pattern = new RegExp(escapeForRegExp(args.urlIncludes), 'i');
      } else {
        const source = args.urlMatches as string;
        matcher = { kind: 'matches', source };
        try {
          pattern = new RegExp(source);
        } catch (err) {
          throw new Error(`urlMatches is not a valid regular expression: ${messageOf(err)}`);
        }
      }

      const detail: Record<string, unknown> =
        args.action === 'fulfill'
          ? {
              fulfill: {
                status: args.status ?? 200,
                body: args.body ?? '',
                ...(args.contentType !== undefined ? { contentType: args.contentType } : {}),
                ...(args.headers !== undefined ? { headers: args.headers } : {})
              }
            }
          : args.action === 'abort'
            ? { errorCode: args.errorCode ?? 'failed' }
            : {
                continue: {
                  ...(args.overrideUrl !== undefined ? { url: args.overrideUrl } : {}),
                  ...(args.overrideMethod !== undefined ? { method: args.overrideMethod } : {}),
                  ...(args.overrideHeaders !== undefined ? { headers: args.overrideHeaders } : {}),
                  ...(args.overridePostData !== undefined ? { postData: args.overridePostData } : {})
                }
              };

      const { state, target } = stateFor(ctx, args.sessionId);
      const rule: RuleRecord = {
        id: randomUUID(),
        createdAt: Date.now(),
        matcher,
        pattern,
        handler: async () => {},
        action: args.action,
        detail,
        ...(args.methods ? { methods: args.methods.map(m => m.toUpperCase()) } : {}),
        ...(args.resourceTypes ? { resourceTypes: args.resourceTypes } : {}),
        ...(args.times !== undefined ? { times: args.times } : {}),
        matchCount: 0,
        skippedByFilter: 0,
        skippedAfterLimit: 0,
        errors: 0
      };
      rule.handler = makeHandler(rule);

      await target.session.context.route(pattern, rule.handler);
      state.rules.push(rule);

      return text({
        sessionId: args.sessionId,
        ...describeRule(rule, 0),
        ruleCount: state.rules.length,
        ordering:
          'This rule is now tried FIRST: the most recently added matching rule wins. Rules added before it are only ' +
          'consulted when this one does not match.',
        note:
          'The rule is registered but has intercepted nothing yet. Call list_route_rules after exercising the page ' +
          'and check matchCount before trusting any result that depended on this mock.'
      });
    }
  }),

  list_route_rules: defineTool({
    description:
      'List a session\'s active route rules, in the order they are actually tried: most recently added first, and ' +
      'the first one that matches a request handles it. ' +
      'Read matchCount before anything else. It is how many requests each rule really intercepted, and a rule ' +
      'sitting at 0 mocked nothing at all, which makes any test that leaned on it meaningless rather than passing. ' +
      'skippedByFilter counts requests whose URL matched but whose method or resource type did not. ' +
      'skippedAfterLimit counts requests that arrived after the "times" budget ran out. errors counts times the ' +
      'action itself failed, with lastError naming the most recent one. ' +
      'This lists rules only. It says nothing about offline mode or throttling: those come back from set_offline ' +
      'and set_network_conditions.',
    inputSchema: z.object({ sessionId }),
    async handler(ctx, args) {
      const state = peekState(ctx, args.sessionId);
      const rules = state ? inEvaluationOrder(state) : [];
      return text({
        sessionId: args.sessionId,
        ruleCount: rules.length,
        ...neverMatchedNote(rules),
        ordering: 'Listed in evaluation order: the first entry is tried first, and the first match wins.',
        rules
      });
    }
  }),

  remove_route_rule: defineTool({
    description:
      'Remove one route rule by its id, restoring the real network behaviour it was replacing, or exposing the next ' +
      'matching rule if there is one. Reports the removed rule\'s final counts, so a mock that never fired is still ' +
      'visible on the way out. Removing an unknown id is an error rather than a quiet no-op.',
    inputSchema: z.object({
      sessionId,
      ruleId: z.string().min(1).describe('Rule id returned by add_route_rule or list_route_rules.')
    }),
    async handler(ctx, args) {
      const { state, target } = stateFor(ctx, args.sessionId);
      const index = state.rules.findIndex(r => r.id === args.ruleId);
      if (index === -1) {
        throw new Error(
          `Session "${args.sessionId}" has no route rule with id "${args.ruleId}". It may have already been ` +
            'removed. Call list_route_rules to see the active rules.'
        );
      }
      // Unrouted BEFORE the rule leaves the bookkeeping, because that record
      // holds the ONLY reference to the handler function Playwright needs in
      // order to remove the interceptor. Splicing first and unrouting after
      // meant a failed unroute discarded that reference while the interceptor
      // stayed registered, so the route went on being mocked for the life of
      // the context with nothing able to take it off. Proved against a real
      // page: after a failed unroute, list_route_rules reported no rules and
      // the request was still answered by the mock rather than the server.
      // clear_route_rules already did these two steps in this order.
      const rule = state.rules[index] as RuleRecord;
      await target.session.context.unroute(rule.pattern, rule.handler);
      // Re-found rather than reusing `index`: the await above is a suspension
      // point, and another call on this session may have changed the array
      // while it ran.
      const current = state.rules.indexOf(rule);
      if (current !== -1) state.rules.splice(current, 1);
      return text({
        sessionId: args.sessionId,
        removed: describeRule(rule, -1),
        remaining: state.rules.length
      });
    }
  }),

  clear_route_rules: defineTool({
    description:
      'Remove every route rule in a session at once, restoring real network behaviour for all of it. Reports each ' +
      'removed rule with its final counts, including how many never intercepted anything, which is the last chance ' +
      'to notice a mock that was silently doing nothing. Does NOT touch offline mode or network throttling: clear ' +
      'those with set_offline and set_network_conditions.',
    inputSchema: z.object({ sessionId }),
    async handler(ctx, args) {
      const { state, target } = stateFor(ctx, args.sessionId);
      const removed = inEvaluationOrder(state);
      for (const rule of state.rules) {
        await target.session.context.unroute(rule.pattern, rule.handler);
      }
      state.rules = [];
      return text({
        sessionId: args.sessionId,
        removedCount: removed.length,
        ...neverMatchedNote(removed),
        removed
      });
    }
  }),

  set_offline: defineTool({
    description:
      'Put a session\'s browser online or offline. CONTEXT-SCOPED: it applies to the whole session, every tab it has ' +
      'open and every tab it opens later, not to a single page. ' +
      'Offline means requests fail at the network layer and navigator.onLine reads false, so both an app\'s fetch ' +
      'error path and its online/offline event handling get exercised. It does not close already-open WebSockets, ' +
      'and it affects nothing outside this browser session. ' +
      'The result reports navigatorOnLine read back out of the page rather than echoed from the request, because ' +
      'the two can genuinely disagree. Chromium\'s throttling layer carries an offline flag of its own, and going ' +
      'offline while that layer is active would otherwise flip navigator.onLine to false while every request kept ' +
      'succeeding. harborage re-applies the throttle profile with a matching offline flag to prevent that, so the ' +
      'flag and the real behaviour agree. Between the two switches, offline always wins: an offline session blocks ' +
      'everything, whatever the bandwidth numbers say. ' +
      'appliedToPageIds lists only the tabs the CDP call genuinely reached: a tab it could not reach (crashed, or ' +
      'mid-navigation into a fresh process) is listed in failedPageIds instead, and offline is NOT in effect there ' +
      'whatever the session-level "offline" flag says. And if navigator.onLine itself could not be read back, that ' +
      'is a separate failure from the switch: navigatorOnLine comes back null rather than a guess, and the note ' +
      'says so, rather than the field silently vanishing and this looking like a verified pass.',
    inputSchema: z.object({
      sessionId,
      offline: z.boolean().describe('true to go offline, false to come back online.')
    }),
    async handler(ctx, args) {
      const { state, target } = stateFor(ctx, args.sessionId);
      state.offline = args.offline;
      await target.session.context.setOffline(args.offline);
      const { applied: appliedToPageIds, failed: failedPageIds } = await syncConditions(state, target);
      const navigatorOnLineRaw = await readOnLine(target);
      const navigatorOnLine = navigatorOnLineRaw ?? null;

      // Collected rather than a single ternary: the CDP push and the
      // readback can each fail on their own, and a caller needs to know
      // which one, not just that something about this call is not fully
      // trustworthy.
      const notes: string[] = [];
      if (failedPageIds.length > 0) {
        notes.push(
          `${failedPageIds.length} tab(s) did not accept this change (${failedPageIds.join(', ')}): treat offline ` +
            'as NOT in effect on those tabs, whatever "offline" says about the session as a whole. Call set_offline ' +
            'again, and if the same tab keeps failing, it is likely crashed or mid-navigation.'
        );
      }
      if (navigatorOnLineRaw === undefined) {
        notes.push(
          'navigator.onLine could not be read back out of the page, most likely because the tab has no document ' +
            'loaded yet or is mid-navigation. This is separate from whether the offline switch itself took: ' +
            '"navigatorOnLine" is null rather than a real answer, so do not read this result as a verified switch. ' +
            'Check the tab again once it has settled.'
        );
      } else if (navigatorOnLineRaw === args.offline) {
        notes.push(
          'navigator.onLine does not agree with the state that was requested. Treat the offline switch as NOT ' +
            'in effect and check the page directly rather than trusting this call.'
        );
      }

      return text({
        sessionId: args.sessionId,
        offline: state.offline,
        navigatorOnLine,
        throttling: state.throttle !== null,
        appliedToPageIds,
        ...(failedPageIds.length > 0 ? { failedPageIds } : {}),
        scope: 'context: every tab in this session, including tabs opened later',
        ...(notes.length > 0 ? { note: notes.join(' ') } : {})
      });
    }
  }),

  set_network_conditions: defineTool({
    description:
      'Throttle a session\'s bandwidth and latency, to see what an app does on a slow link: a spinner that never ' +
      'resolves, a timeout that fires too early, a race that only loses when the response is late. Implemented over ' +
      'Chrome DevTools Protocol network emulation, which Playwright has no first-class API for. Verified to really ' +
      'work here rather than merely to be accepted: a 1MB download capped to 50KB/s took 19.7 seconds, against 2ms ' +
      'unthrottled. ' +
      'Pass a preset, OR downloadKbps / uploadKbps / latencyMs (any subset, in kilobits per second and ' +
      'milliseconds), never both. Presets are "slow-3g", "fast-3g", "4g", "wifi", and "none" to remove throttling. ' +
      'The result always reports the numbers actually in effect. ' +
      'Do NOT try this with send_cdp_command: the emulation is dropped the moment its CDP session detaches, and ' +
      'send_cdp_command detaches after every call, so it silently does nothing at all. This tool holds the CDP ' +
      'session open for as long as the profile is active. ' +
      'Scope and limits: Chromium applies this per tab, so this tool applies it to every tab the session has open ' +
      'and attaches to new tabs as they appear. Attaching to a brand-new tab is not instantaneous, so that tab\'s ' +
      'very first requests can escape the cap. It shapes the browser\'s network stack only: it does not slow ' +
      'rendering or JavaScript, and it does not touch anything served from cache. ' +
      'Interaction with set_offline: offline is a separate switch and it wins. Both mechanisms carry an offline ' +
      'flag, and harborage keeps the two in agreement, so turning throttling on or off never quietly changes ' +
      'whether the session is offline. Both states come back in every result. ' +
      'appliedToPageIds lists only the tabs the CDP call genuinely reached: a tab it could not reach (crashed, or ' +
      'mid-navigation into a fresh process) is listed in failedPageIds instead, and is NOT throttled to these ' +
      'numbers whatever the rest of the result says. navigatorOnLine can also fail to read back on its own, ' +
      'separately from the throttle push: when it does, it comes back null rather than a guess, with the note ' +
      'saying so.',
    inputSchema: z.object({
      sessionId,
      preset: z
        .enum(['slow-3g', 'fast-3g', '4g', 'wifi', 'none'])
        .optional()
        .describe(
          'A named profile: "slow-3g" (400 kbps, 2000ms latency), "fast-3g" (1440/675 kbps, 563ms), "4g" ' +
            '(4000/3000 kbps, 100ms), "wifi" (30000/15000 kbps, 2ms), or "none" to remove throttling entirely. ' +
            'These are approximations of the Chrome DevTools profiles, and the exact numbers come back in the ' +
            'result. Cannot be combined with the explicit numbers.'
        ),
      downloadKbps: z
        .number()
        .positive()
        .optional()
        .describe('Download cap in kilobits per second. Unset means uncapped. Cannot be combined with preset.'),
      uploadKbps: z
        .number()
        .positive()
        .optional()
        .describe('Upload cap in kilobits per second. Unset means uncapped. Cannot be combined with preset.'),
      latencyMs: z
        .number()
        .min(0)
        .optional()
        .describe(
          'Extra latency added to every request, in milliseconds. Defaults to 0. Cannot be combined with preset.'
        )
    }),
    async handler(ctx, args) {
      const explicit = [args.downloadKbps, args.uploadKbps, args.latencyMs].some(v => v !== undefined);
      if (args.preset !== undefined && explicit) {
        throw new Error(
          'set_network_conditions takes either a preset or explicit downloadKbps/uploadKbps/latencyMs, not both. ' +
            'Pick one, so the numbers in effect are never ambiguous.'
        );
      }
      if (args.preset === undefined && !explicit) {
        throw new Error(
          'set_network_conditions needs either a preset ("slow-3g", "fast-3g", "4g", "wifi", or "none" to remove ' +
            'throttling) or at least one of downloadKbps, uploadKbps and latencyMs.'
        );
      }

      const { state, target } = stateFor(ctx, args.sessionId);
      if (args.preset === 'none') {
        state.throttle = null;
      } else if (args.preset !== undefined) {
        state.throttle = { preset: args.preset, ...throttlePresets[args.preset as PresetName] };
      } else {
        state.throttle = {
          preset: null,
          downloadKbps: args.downloadKbps ?? null,
          uploadKbps: args.uploadKbps ?? null,
          latencyMs: args.latencyMs ?? 0
        };
      }

      const { applied: appliedToPageIds, failed: failedPageIds } = await syncConditions(state, target);
      const navigatorOnLineRaw = await readOnLine(target);
      const navigatorOnLine = navigatorOnLineRaw ?? null;

      const notes: string[] = [
        state.throttle === null
          ? 'Throttling removed. Bandwidth and latency are back to whatever the machine really has.'
          : 'Throttling is in effect for the tabs listed in appliedToPageIds, and for tabs opened from now on. A ' +
            'tab\'s very first requests can start before harborage has attached to it.'
      ];
      if (state.offline) {
        notes.push(
          state.throttle === null
            ? 'This session is still OFFLINE: call set_offline to bring it back online.'
            : 'This session is also OFFLINE, which wins: every request fails regardless of these numbers.'
        );
      }
      if (failedPageIds.length > 0) {
        notes.push(
          `${failedPageIds.length} tab(s) did not accept this change (${failedPageIds.join(', ')}): they are still ` +
            'running whatever conditions they had before this call, not the ones reported here.'
        );
      }
      if (navigatorOnLineRaw === undefined) {
        notes.push(
          'navigator.onLine could not be read back out of the page, so "navigatorOnLine" is null rather than a ' +
            'real answer. This is separate from the throttle numbers above, which were still verified.'
        );
      }

      return text({
        sessionId: args.sessionId,
        throttling: state.throttle !== null,
        preset: state.throttle?.preset ?? null,
        downloadKbps: state.throttle?.downloadKbps ?? null,
        uploadKbps: state.throttle?.uploadKbps ?? null,
        latencyMs: state.throttle?.latencyMs ?? null,
        offline: state.offline,
        navigatorOnLine,
        appliedToPageIds,
        ...(failedPageIds.length > 0 ? { failedPageIds } : {}),
        note: notes.join(' ')
      });
    }
  })
});
