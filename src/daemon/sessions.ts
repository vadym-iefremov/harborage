import { randomUUID } from 'node:crypto';
import type { BrowserContext, BrowserContextOptions, Dialog, Page, Request } from 'playwright';

import { noopLogger, type Logger } from '../shared/logger.js';
import type { BrowserManager } from './browserManager.js';
import { compileNetworkMatch, matchesNetworkEntry, type NetworkMatchCriteria, type NetworkMatchInput } from './networkMatch.js';

export class SessionNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`No session with id "${sessionId}". It may have already been released or reaped for being idle.`);
    this.name = 'SessionNotFoundError';
  }
}

export class PageNotFoundError extends Error {
  constructor(sessionId: string, pageId: string) {
    super(`Session "${sessionId}" has no tab with id "${pageId}". Call list_tabs to see current tabs.`);
    this.name = 'PageNotFoundError';
  }
}

/** One buffered `console` message from a session's tab. */
export interface ConsoleEntry {
  pageId: string;
  type: string;
  text: string;
  timestamp: number;
}

/** One buffered network request or response from a session's tab. */
export interface NetworkEntry {
  pageId: string;
  direction: 'request' | 'response';
  url: string;
  method?: string;
  resourceType?: string;
  status?: number;
  statusText?: string;
  timestamp: number;
  /**
   * Set on a REQUEST entry whose response the capture filter turned away.
   *
   * Without it, two opposite outcomes are byte-identical: a request the
   * server never answered, and a request that was answered while the
   * capture filter no longer wanted the answer (the filter was replaced
   * mid-flight with set_network_capture_filter, or it excludes responses
   * wholesale, e.g. direction: 'request' or a method filter). The first is a
   * hung or dropped request and is usually the bug being hunted; the second
   * is the caller's own filter working as asked. A request entry sitting
   * with no matching response entry and no flag here really was never
   * answered.
   */
  responseFilteredOut?: boolean;
}

/**
 * One WebSocket connection a session's tab opened, with frame COUNTS only.
 *
 * Deliberately not entries in the network ring: a socket is a long-lived
 * connection, not a request/response pair, and forcing it into that shape
 * would either lie about `direction` or break every filter that assumes an
 * entry is one half of one exchange. Deliberately counts rather than frame
 * payloads, too: a realtime app can push thousands of frames a minute, and
 * buffering their contents would evict the very HTTP traffic the ring
 * exists to hold. Counts are what answers the question a caller actually
 * has, which is "is anything flowing over this socket at all".
 */
export interface WebSocketEntry {
  pageId: string;
  url: string;
  openedAt: number;
  /** When the socket closed. Absent means it was still open when this was read. */
  closedAt?: number;
  framesSent: number;
  framesReceived: number;
  /** Playwright's socket-level error text, when the socket failed rather than closing cleanly. */
  error?: string;
}

/** What a caller may do with a JavaScript dialog. */
export type DialogAction = 'accept' | 'dismiss';

/** One `alert`, `confirm`, `prompt` or `beforeunload` dialog the page raised, and what was done with it. */
export interface DialogEntry {
  pageId: string;
  type: string;
  message: string;
  defaultValue: string;
  action: DialogAction;
  /** Text supplied to a `prompt`, when the dialog was accepted with one. */
  promptText?: string;
  timestamp: number;
}

/** What to do with dialogs from now on, armed by `handle_dialog` before the action that triggers one. */
export interface DialogPolicy {
  action: DialogAction;
  promptText?: string;
  /** `next` is consumed by the first dialog it meets; `all` stays until replaced. */
  appliesTo: 'next' | 'all';
}

/**
 * One uncaught exception or unhandled promise rejection from a page.
 *
 * `stack` is not optional out of tidiness: a bare message is exactly what
 * made an "[object Event]" rejection impossible to trace in this project's
 * own history, so anything that has a stack carries it, and anything that
 * does not carries `valueType`, `eventType` and `detail` instead.
 */
export interface PageErrorEntry {
  pageId: string;
  type: 'uncaught-exception' | 'unhandled-rejection';
  /** Constructor name of the thrown or rejected value: `Error`, `TypeError`, `Event`, `String`. */
  valueType: string;
  message: string;
  stack?: string;
  /** For a rejected `Event`, its `type` (`error`, `unhandledrejection`), which is what names the culprit. */
  eventType?: string;
  /** JSON dump of a non-Error rejected value, for when there is no stack to read. */
  detail?: string;
  timestamp: number;
}

/** Max buffered entries kept per session, each channel independently bounded. */
export interface BufferLimits {
  console: number;
  network: number;
  dialog: number;
  pageError: number;
}

const defaultBufferLimits: BufferLimits = { console: 200, network: 200, dialog: 200, pageError: 200 };

/**
 * How many WebSocket connections one session remembers.
 *
 * Not configurable like the other four buffers, because it is not the same
 * kind of pressure: a page opens a handful of sockets over its whole life,
 * not hundreds a second, so this bound exists to stop a pathological
 * reconnect loop growing without limit rather than to ration a hot channel.
 */
const maxWebSocketsPerSession = 50;

/**
 * How many requests may be waiting for Playwright to name their frame at
 * once. In practice this is one per tab being opened, and only for the
 * moment between the browser starting a tab's top-level document request and
 * attaching the frame that owns it. The cap exists so a request that never
 * ends cannot hold an entry forever.
 */
const maxPendingNetworkAttribution = 50;

/**
 * Name of the page-side function the unhandled-rejection hook calls back
 * through. Deliberately unlikely to collide with anything a real page
 * defines, since it is a global this tool adds to every page it drives.
 */
const rejectionBindingName = '__harborageReportUnhandledRejection';

/**
 * The two lifecycle bounds a `SessionStore` needs that are not the ordinary
 * idle timeout. Both are passed in rather than read from the environment
 * here: `shared/config.ts` owns every tunable, and the daemon threads these
 * through from there.
 */
export interface SessionTimeouts {
  /** Idle timeout for a session `escalate_session` has handed to a human. */
  escalatedIdleTimeoutMs?: number;
  /** How long a single running call may keep vetoing the reaper. */
  maxInFlightAgeMs?: number;
}

/**
 * Defaults for a `SessionStore` built without a config, which in practice
 * means a test that does not care. The real daemon always passes
 * `config.escalatedIdleTimeoutMs` and `config.maxInFlightAgeMs`, and those
 * two are where the reasoning behind these numbers is written down.
 */
const defaultTimeouts: Required<SessionTimeouts> = {
  escalatedIdleTimeoutMs: 60 * 60 * 1000,
  maxInFlightAgeMs: 10 * 60 * 1000
};

/**
 * One bounded ring plus a running count of what it has silently thrown away.
 *
 * `dropped` is what makes an empty or short `list_network_requests` result
 * distinguishable from "that traffic never happened": on a Vite dev server
 * the 200-entry network ring used to fill with module-chunk requests inside
 * the first second of a page load, quietly evicting the one API call an
 * agent actually cared about, and `total: 200, returned: 0` read exactly like
 * a clean result. `dropped` reports the eviction directly instead of leaving
 * a caller to infer it from a suspiciously round `total`.
 */
interface BoundedBuffer<T> {
  entries: T[];
  dropped: number;
  /**
   * The same evictions, attributed to the tab whose entry was lost.
   *
   * The ring is session-wide, so a read scoped to one quiet tab used to
   * report every drop the session had ever suffered, most of them belonging
   * to other tabs: measured on a real page, a read of one idle tab reported
   * 58 drops, none of which were its own. A caller cannot act on a number
   * that is not about the thing it asked about, so the scoped count is kept
   * alongside the session-wide one rather than instead of it.
   */
  droppedByPage: Map<string, number>;
}

function newBoundedBuffer<T>(): BoundedBuffer<T> {
  return { entries: [], dropped: 0, droppedByPage: new Map() };
}

/** Pushes onto a bounded ring, dropping the oldest entries once over `max` and counting the drop, session-wide and per tab. */
function pushBounded<T extends { pageId: string }>(buffer: BoundedBuffer<T>, entry: T, max: number): void {
  buffer.entries.push(entry);
  if (buffer.entries.length > max) {
    const overflow = buffer.entries.length - max;
    const evicted = buffer.entries.splice(0, overflow);
    buffer.dropped += overflow;
    for (const lost of evicted) {
      buffer.droppedByPage.set(lost.pageId, (buffer.droppedByPage.get(lost.pageId) ?? 0) + 1);
    }
  }
}

/**
 * What one buffered read hands back.
 *
 * Two drop counts, not one, because the ring is session-wide while a read is
 * often not: `droppedInScope` is about the tab the caller asked about (or
 * the whole session, when it asked about the whole session), and
 * `droppedInSession` is the session-wide total it sits inside. Reporting
 * only the second is what made a read of one quiet tab claim 58 drops that
 * all belonged to other tabs.
 */
export interface BufferRead<T> {
  entries: T[];
  droppedInScope: number;
  droppedInSession: number;
}

/** Adds one to a per-tab tally, creating the entry on first use. */
function bumpByPage(counts: Map<string, number>, pageId: string): void {
  counts.set(pageId, (counts.get(pageId) ?? 0) + 1);
}

/**
 * The tab a context-wide network event belongs to.
 *
 * `request.frame()` THROWS rather than returning null when Playwright cannot
 * name a frame, so the guard has to be a try, not a null check, and the two
 * reasons it throws need opposite handling:
 *
 * - A request a service worker made on nobody's behalf has no tab and never
 *   will. There is nowhere to file it, since every read on the network ring
 *   is scoped by pageId, and the per-page listeners this replaced never saw
 *   them either. Reported as 'none'.
 * - A tab's OWN top-level document request is announced before the frame
 *   that will own it is attached, so the frame is merely not available YET.
 *   For a popup that is the first and most important thing the tab ever
 *   fetches, and dropping it leaves a caller unable to tell a popup that
 *   loaded the wrong URL from one that loaded nothing. Reported as
 *   'not-yet', and attributed later: see `parkUnattributed`.
 */
type RequestOwner = { kind: 'page'; page: Page } | { kind: 'none' } | { kind: 'not-yet' };

function ownerOfRequest(request: Request): RequestOwner {
  try {
    return { kind: 'page', page: request.frame().page() };
  } catch {
    return request.serviceWorker() !== null ? { kind: 'none' } : { kind: 'not-yet' };
  }
}

interface SessionRecord {
  id: string;
  context: BrowserContext;
  pages: Map<string, Page>;
  nextPageSeq: number;
  activePageId: string;
  createdAt: number;
  lastActivity: number;
  /**
   * Every tool call running against this session right now, call token to
   * the moment it started.
   *
   * The map exists rather than a plain counter because the reaper needs the
   * age of the OLDEST running call, not the time since the session last had
   * nothing running. A single counter plus a since-timestamp cannot tell
   * those apart, and gets both directions wrong: a busy session whose calls
   * overlap so the count never reaches zero looks wedged after
   * `maxInFlightAgeMs` and is reaped mid-work, while resetting the
   * timestamp on every new call would let a stream of short calls hide a
   * genuinely wedged one forever.
   *
   * Why any of this is tracked at all: `lastActivity` only moves when a call
   * STARTS, so a `navigate` or an `evaluate` running longer than
   * `idleTimeoutMs` had its own BrowserContext closed underneath it by the
   * sweep. A session is only idle if nothing is happening in it.
   */
  inFlightCalls: Map<number, number>;
  /**
   * When this session was handed to a human via `escalate_session`, if it
   * was. A human driving the session over CDP touches no tool, so nothing
   * refreshes `lastActivity` for as long as they work: the very scenario
   * escalation exists for is also the one that used to get the session
   * reaped out from under them.
   */
  escalatedAt: number | undefined;
  consoleBuffer: BoundedBuffer<ConsoleEntry>;
  networkBuffer: BoundedBuffer<NetworkEntry>;
  dialogBuffer: BoundedBuffer<DialogEntry>;
  pageErrorBuffer: BoundedBuffer<PageErrorEntry>;
  /** What the next dialog (or every dialog) gets. Undefined means the safe default, dismiss. */
  dialogPolicy: DialogPolicy | undefined;
  /**
   * What is worth putting in the network ring at all. Undefined (the default)
   * captures everything, matching every session before this filter existed.
   * Set at create_session or later with set_network_capture_filter, it runs
   * BEFORE an entry ever reaches `networkBuffer`, so noise excluded here can
   * never evict signal the way a read-time filter cannot prevent.
   */
  networkCaptureFilter: NetworkMatchCriteria | undefined;
  /**
   * How many request/response entries this capture filter has turned away
   * since it was set (or since the last unfiltered clear). Kept separate from
   * `networkBuffer.dropped`: a filtered-out entry was a deliberate exclusion
   * the caller asked for, an evicted one was an accident of the ring filling
   * up, and conflating the two would hide whichever one was actually the
   * caller's problem.
   */
  networkFilteredOut: number;
  /** The same exclusions attributed per tab, for the same reason `droppedByPage` exists. */
  networkFilteredOutByPage: Map<string, number>;
  /**
   * Network entries built but not yet filed, because Playwright could not
   * name the frame they belong to at the moment it announced them.
   *
   * Only a tab's own top-level document request lands here, and only for the
   * moment between the browser starting that request and the frame that owns
   * it being attached. `requestfinished` and `requestfailed` both resolve the
   * frame, so the entry is filed from there under the tab it really belongs
   * to, carrying the timestamp it was created with rather than the later one.
   * Held per Request, so a request that never completes cannot strand an
   * entry under a guessed tab.
   */
  pendingNetworkByRequest: Map<Request, NetworkEntry[]>;
  /** WebSocket connections this session's tabs have opened, oldest first. */
  websockets: BoundedBuffer<WebSocketEntry>;
}

/**
 * Everything a caller may fix at session-creation time.
 *
 * `deviceScaleFactor` is here and nowhere else on purpose: Playwright fixes
 * it per `BrowserContext` at creation, and no later call (including CDP's
 * `Emulation.setDeviceMetricsOverride`, which silently produces
 * byte-identical screenshots) can change it. A different scale factor needs
 * a new session.
 */
export interface CreateSessionOptions {
  /** Cookies + localStorage from a previous `export_state`, to start already set up. */
  storageState?: unknown;
  /** CSS-pixel viewport for this session's tabs. Unset means Playwright's own default. */
  viewport?: { width: number; height: number };
  /** Device pixel ratio, e.g. 2 for a retina-density screenshot. Unset means 1. */
  deviceScaleFactor?: number;
  /**
   * What to keep in this session's network ring from the moment it opens.
   * Same vocabulary as list_network_requests' own filters (urlIncludes,
   * urlMatches, method, resourceType, direction, minStatus, maxStatus),
   * every one of them, because a caller who found
   * the noise with a read-time filter should be able to paste the same
   * fields in here rather than learn a second vocabulary. Unset captures
   * everything, matching every session before this option existed. Also
   * settable, or replaceable, after the session is already running with
   * set_network_capture_filter, for the common case of only discovering the
   * flood once it has already happened.
   */
  networkCaptureFilter?: NetworkMatchInput;
}

/** What a tool handler gets back after resolving a sessionId (+ optional pageId). */
export interface ResolvedTarget {
  session: SessionRecord;
  page: Page;
  pageId: string;
}

/** One row of `list_sessions` output. Deliberately not scoped to any particular caller. */
export interface SessionSummary {
  sessionId: string;
  createdAt: number;
  lastActivity: number;
  pageId: string;
  url: string | undefined;
  tabCount: number;
  /** Tool calls currently running against this session. Non-zero vetoes reaping. */
  inFlight: number;
  /** True once `escalate_session` handed this session to a human. */
  escalated: boolean;
  /** When the handover happened, if it has. Present so a forgotten escalation is visible, not just implied. */
  escalatedAt: number | undefined;
}

/**
 * Holds every live session (one Playwright `BrowserContext` per session,
 * possibly multiple tabs/pages each) in memory, keyed by sessionId.
 *
 * This is the in-memory table the spec calls for:
 * `sessionId -> { context, page(s), createdAt, lastActivity }`.
 */
export class SessionStore {
  private readonly sessions = new Map<string, SessionRecord>();
  /** Per-session queue for the tools that drive the shared virtual mouse and keyboard. */
  private readonly inputLocks = new Map<string, Promise<void>>();
  private readonly bufferLimits: BufferLimits;
  private readonly timeouts: Required<SessionTimeouts>;
  /** Hands out the token that pairs one `beginCall` with its own `endCall`. */
  private nextCallId = 1;
  /**
   * Sessions being built right now: past `createSession` starting, before it
   * has returned a sessionId.
   *
   * A create is invisible to `count()`, because there is no record to count
   * yet, and it is invisible to the in-flight machinery, because the caller
   * has no sessionId to name. That left the one hole in the daemon's
   * live-session veto: with the client registry empty, a sweep landing during
   * a create_session found zero sessions, shut the daemon down and took the
   * half-built context (and, on a cold daemon, the Chromium still launching)
   * with it.
   */
  private pendingCreations = 0;

  /**
   * The logger is injected rather than imported as a module-level singleton
   * so a test can capture exactly the lines one store emitted, and so a
   * caller that does not want session lifecycle output (most unit tests)
   * simply gets the no-op default.
   */
  constructor(
    private readonly browserManager: BrowserManager,
    bufferLimits: Partial<BufferLimits> = {},
    private readonly logger: Logger = noopLogger,
    timeouts: SessionTimeouts = {}
  ) {
    this.bufferLimits = { ...defaultBufferLimits, ...bufferLimits };
    this.timeouts = { ...defaultTimeouts, ...timeouts };
  }

  /**
   * Wires up console / network / dialog / page-error buffering for a whole
   * BrowserContext, once, before its first page exists.
   *
   * These listeners used to live on each Page, attached from
   * `context.on('page')`. That lost a popup's opening console.log outright,
   * roughly one full-suite run in eight, and the mechanism is worth writing
   * down because it is not the obvious one. Playwright only sends a page's
   * console / dialog / request / response events over the wire if the client
   * has SUBSCRIBED to them, and `page.on('console')` requests that
   * subscription with a fire-and-forget `Page.updateSubscription` call. Until
   * that round trip completes, Playwright's own dispatcher drops the event on
   * its side. So the message is not delivered late, it is never sent, and no
   * deadline on the reading end can recover it. Measured directly: on a
   * popup whose inline script runs `console.log(...)` and then `fetch(...)`,
   * the fetch was captured and attributed correctly while the console.log
   * one statement earlier was absent from the session-wide buffer entirely.
   *
   * A BrowserContext subscription has no such window here, because this runs
   * at create_session, before any page exists. Playwright checks the
   * context's subscription first and dispatches on that alone, and it
   * replays a page's buffered console messages and page errors to the
   * context the moment that page is initialised. Every tab a session ever
   * gets, including one the page opened itself, is therefore covered from
   * its first line of script.
   *
   * Each event is attributed by asking `adoptPage` for the id of the page it
   * came from, which mints one if this is the first the session has heard of
   * that tab. Adoption stays idempotent, so an event that beats
   * `context.on('page')` is filed under the same id that event will report.
   */
  private attachContextBuffers(record: SessionRecord, context: BrowserContext): void {
    context.on('console', msg => {
      const page = msg.page();
      // A console message from a service worker belongs to no tab. Every
      // read on this buffer is scoped by pageId, so there is nowhere to file
      // it, and the page-level listener this replaced never saw them either.
      if (!page) return;
      pushBounded(
        record.consoleBuffer,
        { pageId: this.adoptPage(record, page), type: msg.type(), text: msg.text(), timestamp: Date.now() },
        this.bufferLimits.console
      );
    });

    context.on('request', req => {
      this.fileNetworkEntry(record, req, {
        direction: 'request',
        url: req.url(),
        method: req.method(),
        resourceType: req.resourceType(),
        timestamp: Date.now()
      });
    });

    context.on('response', res => {
      this.fileNetworkEntry(record, res.request(), {
        direction: 'response',
        url: res.url(),
        status: res.status(),
        statusText: res.statusText(),
        timestamp: Date.now()
      });
    });

    // The two ways a request ends, and the first moment Playwright can name
    // the frame behind a tab's own top-level document request. Anything
    // parked for that request is filed here, under the tab it turned out to
    // belong to.
    context.on('requestfinished', req => this.flushParked(record, req));
    context.on('requestfailed', req => this.flushParked(record, req));

    // Registering ANY dialog listener switches Playwright's own auto-dismiss
    // off, which makes this handler the only thing that can ever unblock a
    // page showing a modal. Verified directly against real Chromium: with a
    // listener that does not resolve the dialog, the triggering click and
    // every later call on that tab hang forever. So this handler resolves
    // the dialog on every path it can take, and decides afterwards.
    //
    // On the context rather than the page for the subscription reason above,
    // which mattered more here than anywhere else: a dialog raised inside
    // that window was auto-dismissed by Playwright AND never buffered, so a
    // handle_dialog policy the caller had already set silently did not run.
    context.on('dialog', dialog => {
      let action: DialogAction = 'dismiss';
      let promptText: string | undefined;
      try {
        const policy = record.dialogPolicy;
        if (policy) {
          action = policy.action;
          promptText = policy.promptText;
          if (policy.appliesTo === 'next') record.dialogPolicy = undefined;
        }
        const page = dialog.page();
        // A dialog with no page cannot be filed under a tab, but it still
        // has to be resolved or whatever raised it stays wedged, which is
        // what the unconditional resolve below is for.
        if (page) {
          pushBounded(
            record.dialogBuffer,
            {
              pageId: this.adoptPage(record, page),
              type: dialog.type(),
              message: dialog.message(),
              defaultValue: dialog.defaultValue(),
              action,
              promptText,
              timestamp: Date.now()
            },
            this.bufferLimits.dialog
          );
        }
      } catch {
        // Swallowed on purpose. Bookkeeping failing is a lost log line;
        // leaving the modal open is a wedged tab, so the resolve below runs
        // either way.
      }
      void this.resolveDialog(dialog, action, promptText);
    });

    // Uncaught exceptions. `weberror` is the context-wide form of a page's
    // `pageerror`, carrying the page it came from. Unhandled rejections come
    // in through the init script instead, which marks them handled so they
    // do not also surface here as a duplicate.
    context.on('weberror', webError => {
      const page = webError.page();
      if (!page) return;
      const err = webError.error();
      const stack = typeof err.stack === 'string' && err.stack.trim() !== '' ? err.stack : undefined;
      pushBounded(
        record.pageErrorBuffer,
        {
          pageId: this.adoptPage(record, page),
          type: 'uncaught-exception',
          valueType: err.name && err.name !== '' ? err.name : 'Error',
          message: err.message,
          stack,
          timestamp: Date.now()
        },
        this.bufferLimits.pageError
      );
    });
  }

  /**
   * Files one network entry under the tab it belongs to, or parks it until
   * that tab can be named.
   *
   * Everything the capture filter does happens here rather than at the two
   * call sites, so a parked entry is filtered on exactly the same terms as a
   * filed one, and both halves of an exchange count against the same per-tab
   * tally.
   */
  private fileNetworkEntry(
    record: SessionRecord,
    request: Request,
    partial: Omit<NetworkEntry, 'pageId'>
  ): void {
    const owner = ownerOfRequest(request);
    if (owner.kind === 'none') return;
    if (owner.kind === 'not-yet') {
      this.parkUnattributed(record, request, partial);
      return;
    }
    this.pushNetworkEntry(record, { ...partial, pageId: this.adoptPage(record, owner.page) });
  }

  /**
   * Holds an entry whose owning frame Playwright has not attached yet.
   *
   * Bounded, because a request that never finishes never comes back to claim
   * its entry. Overflow is counted as a session-wide drop rather than thrown
   * away quietly: a caller reading a short list needs to be able to tell it
   * is short. It has no per-tab count for the same reason it is here at all,
   * which is that nothing yet knows which tab it belongs to.
   */
  private parkUnattributed(record: SessionRecord, request: Request, partial: Omit<NetworkEntry, 'pageId'>): void {
    const held = record.pendingNetworkByRequest.get(request);
    if (held) {
      held.push({ ...partial, pageId: '' });
      return;
    }
    if (record.pendingNetworkByRequest.size >= maxPendingNetworkAttribution) {
      const oldest = record.pendingNetworkByRequest.keys().next();
      if (!oldest.done) {
        record.networkBuffer.dropped += record.pendingNetworkByRequest.get(oldest.value)?.length ?? 0;
        record.pendingNetworkByRequest.delete(oldest.value);
      }
    }
    record.pendingNetworkByRequest.set(request, [{ ...partial, pageId: '' }]);
  }

  /**
   * Files everything parked for one request, now that the request has ended
   * and Playwright can finally name its frame.
   *
   * If it still cannot, the entries are dropped and counted, because a row
   * filed under a guessed tab is worse than a row that is visibly missing.
   */
  private flushParked(record: SessionRecord, request: Request): void {
    const held = record.pendingNetworkByRequest.get(request);
    if (!held) return;
    record.pendingNetworkByRequest.delete(request);

    const owner = ownerOfRequest(request);
    if (owner.kind !== 'page') {
      record.networkBuffer.dropped += held.length;
      return;
    }
    const pageId = this.adoptPage(record, owner.page);
    for (const entry of held) {
      this.pushNetworkEntry(record, { ...entry, pageId });
    }
  }

  /** Applies the capture filter, then rings the entry or counts the exclusion. */
  private pushNetworkEntry(record: SessionRecord, entry: NetworkEntry): void {
    if (record.networkCaptureFilter === undefined || matchesNetworkEntry(entry, record.networkCaptureFilter)) {
      pushBounded(record.networkBuffer, entry, this.bufferLimits.network);
      return;
    }
    record.networkFilteredOut += 1;
    // Counted per tab for BOTH directions. Bumping this only for responses
    // made a scoped list_network_requests report a filteredAtCapture that
    // counted the tab's filtered-out responses and none of its filtered-out
    // requests, so a caller reading one tab saw about half the exclusions its
    // own filter had actually made, with nothing to say the number was short.
    bumpByPage(record.networkFilteredOutByPage, entry.pageId);
    if (entry.direction !== 'response') return;

    // The request half may still be sitting in the ring, and if it is, it now
    // looks exactly like a request nobody ever answered. Those mean opposite
    // things to a caller (a hung endpoint versus their own filter doing its
    // job), so the surviving request entry is marked rather than left
    // ambiguous. Oldest unmarked match wins, which is the right pairing for
    // repeated calls to the same URL as long as the server answers them in
    // order, and is at worst off by one exchange between two identical URLs
    // when it does not.
    for (const buffered of record.networkBuffer.entries) {
      if (
        buffered.direction === 'request' &&
        buffered.pageId === entry.pageId &&
        buffered.url === entry.url &&
        buffered.responseFilteredOut !== true
      ) {
        buffered.responseFilteredOut = true;
        break;
      }
    }
  }

  /**
   * The one buffer with no context-wide channel to move to.
   *
   * Playwright exposes `websocket` on Page only, so this stays per-page and
   * is attached from `adoptPage`. It was never exposed to the loss window
   * the others were: Playwright dispatches a page's websocket events
   * unconditionally rather than gating them on a client subscription, so
   * there is no round trip for the page's own script to beat.
   */
  private attachPageBuffers(record: SessionRecord, page: Page, pageId: string): void {
    // WebSockets do not pass through the request/response channels at all, so
    // before this a caller debugging a realtime app read an empty request
    // list and concluded nothing was happening. Lifecycle and frame counts
    // only: see WebSocketEntry for why not the frames themselves.
    page.on('websocket', ws => {
      const entry: WebSocketEntry = {
        pageId,
        url: ws.url(),
        openedAt: Date.now(),
        framesSent: 0,
        framesReceived: 0
      };
      pushBounded(record.websockets, entry, maxWebSocketsPerSession);
      ws.on('framesent', () => {
        entry.framesSent += 1;
      });
      ws.on('framereceived', () => {
        entry.framesReceived += 1;
      });
      ws.on('socketerror', err => {
        entry.error = String(err);
      });
      ws.on('close', () => {
        entry.closedAt = Date.now();
      });
    });
  }

  /**
   * Applies a decision to one dialog. Never rethrows: by the time this runs
   * the page may have navigated or closed, and a failure to resolve an
   * already-gone dialog is not something a caller can act on.
   */
  private async resolveDialog(dialog: Dialog, action: DialogAction, promptText?: string): Promise<void> {
    try {
      if (action === 'accept') await dialog.accept(promptText);
      else await dialog.dismiss();
    } catch {
      // Already resolved, or its page is gone. Attempting the other action
      // here would only raise a second error against the same dead dialog.
    }
  }

  /**
   * Installs the unhandled-rejection channel on a whole context, before any
   * page exists in it, so every tab is covered including ones opened later.
   *
   * Why this exists at all, established by probing real Chromium rather than
   * assumed: `page.on('pageerror')` DOES receive unhandled rejections, but
   * for a non-Error reason it reports `name: ""`, an empty stack and a
   * message of just "Event". That is the exact shape that made an
   * "[object Event]" rejection untraceable. Catching the rejection in the
   * page instead yields the constructor name, the event's own `type` and a
   * JSON dump, which is what actually identifies the culprit.
   *
   * The hook calls `preventDefault()`, which is what stops the same
   * rejection also arriving through `pageerror` as a second, poorer copy. It
   * suppresses the browser's default reporting of unhandled rejections,
   * which Playwright does not surface on any channel anyway.
   */
  private async installRejectionHook(record: SessionRecord, context: BrowserContext): Promise<void> {
    await context.exposeBinding(rejectionBindingName, (source, payload) => {
      const entry = payload as Omit<PageErrorEntry, 'pageId' | 'type' | 'timestamp'>;
      pushBounded(
        record.pageErrorBuffer,
        {
          pageId: this.adoptPage(record, source.page),
          type: 'unhandled-rejection',
          valueType: entry.valueType,
          message: entry.message,
          stack: entry.stack,
          eventType: entry.eventType,
          detail: entry.detail,
          timestamp: Date.now()
        },
        this.bufferLimits.pageError
      );
    });

    // Typed through `globalThis` rather than `window`: this function is
    // serialized and run inside the page, so the DOM lib is deliberately not
    // in scope on the daemon's side of the compile.
    await context.addInitScript((bindingName: string) => {
      const scope = globalThis as unknown as {
        [key: string]: unknown;
        addEventListener(
          type: string,
          listener: (event: { reason: unknown; preventDefault: () => void }) => void
        ): void;
      };
      const notify = scope[bindingName] as ((payload: unknown) => void) | undefined;
      if (typeof notify !== 'function') return;

      scope.addEventListener('unhandledrejection', event => {
        // Marking it handled is what stops Chromium reporting the same
        // rejection a second time through Playwright's `pageerror` channel,
        // where it would arrive stripped of everything useful.
        event.preventDefault();
        const reason: unknown = event.reason;
        let payload: Record<string, unknown>;
        if (reason instanceof Error) {
          payload = { valueType: reason.name || 'Error', message: reason.message, stack: reason.stack };
        } else {
          const asRecord = reason as { constructor?: { name?: string }; type?: unknown } | null;
          let detail: string | undefined;
          try {
            detail = JSON.stringify(reason);
          } catch {
            detail = undefined;
          }
          payload = {
            valueType: reason === null ? 'null' : asRecord?.constructor?.name ?? typeof reason,
            message: String(reason),
            eventType: typeof asRecord?.type === 'string' ? asRecord.type : undefined,
            detail
          };
        }
        try {
          notify(payload);
        } catch {
          // The binding is gone because the page is being torn down. There
          // is nowhere left to report to, and throwing inside an event
          // listener would only surface as another page error.
        }
      });
    }, rejectionBindingName);
  }

  /**
   * Gives one page an id in this session, wires up its buffers, and arranges
   * for it to drop out of the table when it closes.
   *
   * Idempotent on purpose. Playwright fires `context.on('page')` for tabs the
   * page opened itself AND for tabs we opened ourselves with `newPage()`, so
   * both paths land here for the same page. Returning the existing id rather
   * than minting a second one is what stops `new_tab` from reporting a tab id
   * that no longer matches the one `list_tabs` shows.
   */
  private adoptPage(record: SessionRecord, page: Page, preferredId?: string): string {
    for (const [existingId, existing] of record.pages) {
      if (existing === page) return existingId;
    }

    const id = preferredId ?? String(record.nextPageSeq++);
    record.pages.set(id, page);
    this.attachPageBuffers(record, page, id);
    page.on('close', () => {
      record.pages.delete(id);
    });
    return id;
  }

  /**
   * Creates one session, building the Playwright context options up field by
   * field rather than passing the whole object through.
   *
   * Why field by field: Playwright reads a present-but-undefined `viewport`
   * differently from an absent one, so an option the caller did not set must
   * not appear in the object at all.
   */
  async createSession(options: CreateSessionOptions = {}): Promise<{ sessionId: string; pageId: string }> {
    // Counted from here, and only given back in the `finally` below, so the
    // daemon's shutdown gate can see work that has not produced a sessionId
    // yet. On a cold daemon this stretch includes launching Chromium.
    this.pendingCreations += 1;
    try {
      return await this.buildSession(options);
    } finally {
      this.pendingCreations -= 1;
    }
  }

  private async buildSession(options: CreateSessionOptions): Promise<{ sessionId: string; pageId: string }> {
    const browser = await this.browserManager.getBrowser();

    const contextOptions: BrowserContextOptions = {};
    if (options.storageState !== undefined) contextOptions.storageState = options.storageState as never;
    if (options.viewport !== undefined) contextOptions.viewport = options.viewport;
    if (options.deviceScaleFactor !== undefined) contextOptions.deviceScaleFactor = options.deviceScaleFactor;

    // Compiled BEFORE the context exists, not while building the record after
    // it. compileNetworkMatch throws on a regex that does not parse, and when
    // it threw down there the BrowserContext had already been created and had
    // not yet been stored anywhere, so it was orphaned: not in `sessions`, so
    // nothing could release or reap it, and alive for the life of the daemon.
    // Measured on the real Playwright browser: five rejected create_session
    // calls left five extra contexts behind, and releasing the caller's real
    // session did not take them with it. On a machine-wide shared daemon that
    // is one leaked context per attempt for an agent iterating on a regex.
    const networkCaptureFilter =
      options.networkCaptureFilter !== undefined ? compileNetworkMatch(options.networkCaptureFilter) : undefined;

    const context = await browser.newContext(contextOptions);

    // Everything from here to `this.sessions.set` runs with a context that
    // exists but that nothing else can reach yet, so every failure in that
    // window has to close it by hand. Validation moving above the context is
    // what removes the KNOWN throw; this is what stops the next one (an
    // exposeBinding or addInitScript that fails, a newPage on a browser
    // that just died) becoming the same leak again.
    try {
      return await this.finishSession(context, networkCaptureFilter);
    } catch (err) {
      await context.close().catch(() => {
        // Already gone, or the browser died under us. Either way there is
        // nothing left to leak, and the original failure is what the caller
        // needs to see, not this one.
      });
      throw err;
    }
  }

  /**
   * The half of session construction that runs with a live BrowserContext in
   * hand. Split out purely so `buildSession` can wrap ALL of it in one
   * close-on-failure guard rather than repeating cleanup at each throw site.
   */
  private async finishSession(
    context: BrowserContext,
    networkCaptureFilter: NetworkMatchCriteria | undefined
  ): Promise<{ sessionId: string; pageId: string }> {
    const sessionId = randomUUID();
    const now = Date.now();
    const record: SessionRecord = {
      id: sessionId,
      context,
      pages: new Map(),
      nextPageSeq: 0,
      activePageId: '0',
      createdAt: now,
      lastActivity: now,
      inFlightCalls: new Map(),
      escalatedAt: undefined,
      consoleBuffer: newBoundedBuffer(),
      networkBuffer: newBoundedBuffer(),
      dialogBuffer: newBoundedBuffer(),
      pageErrorBuffer: newBoundedBuffer(),
      dialogPolicy: undefined,
      networkCaptureFilter,
      networkFilteredOut: 0,
      networkFilteredOutByPage: new Map(),
      pendingNetworkByRequest: new Map(),
      websockets: newBoundedBuffer()
    };

    // A tab opened by the page itself (window.open, a target="_blank" link,
    // etc.) becomes reachable through list_tabs / pageId too, and becomes
    // the new active tab, matching what a person driving the browser would
    // expect "the tab I just caused to open" to mean.
    context.on('page', newPage => {
      record.activePageId = this.adoptPage(record, newPage);
    });

    // All three of these happen before the first page exists, which is the
    // whole point: buffering that starts at create_session is what lets a
    // caller read back what a page did while loading, rather than only what
    // it did after somebody thought to look. For the context-wide buffers it
    // is also what closes the subscription race described on
    // attachContextBuffers, which silently lost a popup's first console line.
    this.attachContextBuffers(record, context);
    await this.installRejectionHook(record, context);
    const page = await context.newPage();

    // The context's own `page` event has already adopted this one; asking
    // again just reads back the id it was given.
    const pageId = this.adoptPage(record, page);
    record.activePageId = pageId;

    // Re-stamped now that the session is actually usable, rather than left
    // at the time construction started. Building a context, installing the
    // rejection hook and opening the first page all take real time, and on
    // the very first session of a daemon's life that includes launching
    // Chromium. None of that should come out of the session's idle budget:
    // a caller's clock starts when it gets the sessionId back.
    record.createdAt = Date.now();
    record.lastActivity = record.createdAt;

    this.sessions.set(sessionId, record);
    this.logger.log('session.create', { sessionId, sessions: this.sessions.size });
    return { sessionId, pageId };
  }

  private getRecord(sessionId: string): SessionRecord {
    const record = this.sessions.get(sessionId);
    if (!record) throw new SessionNotFoundError(sessionId);
    record.lastActivity = Date.now();
    return record;
  }

  /**
   * Resolves a sessionId (+ optional pageId) to a concrete session + page,
   * touching lastActivity.
   *
   * Deliberately does NOT change which tab omitting pageId targets next.
   * That used to be a side effect of this call: passing an explicit pageId
   * once, for a single screenshot or a single read of another tab's
   * console, silently re-pointed the session's default target at that tab
   * for every later call that left pageId out, with no error and nothing in
   * the response to say so. select_tab is the documented way to switch the
   * active tab; a call that names its own tab explicitly should not have
   * that same effect as a side channel. Only select_tab, new_tab, a page the
   * session opens itself (window.open, a target="_blank" link) and closeTab
   * reassigning away from a tab it just closed change activePageId.
   */
  resolve(sessionId: string, pageId?: string): ResolvedTarget {
    const session = this.getRecord(sessionId);
    const targetPageId = pageId ?? session.activePageId;
    const page = session.pages.get(targetPageId);
    if (!page) throw new PageNotFoundError(sessionId, targetPageId);
    return { session, page, pageId: targetPageId };
  }

  async listTabs(sessionId: string): Promise<{ pageId: string; url: string; title: string; active: boolean }[]> {
    const session = this.getRecord(sessionId);
    return Promise.all(
      [...session.pages.entries()].map(async ([pageId, page]) => ({
        pageId,
        url: page.url(),
        title: await page.title().catch(() => ''),
        // Which tab a call that omits pageId will hit. Without this the
        // caller has to infer the default target from call ordering.
        active: pageId === session.activePageId
      }))
    );
  }

  /**
   * Opens a new tab in an existing session and makes it the active one.
   *
   * Active, because that matches what happens when the page opens a tab
   * itself: the thing you just caused to open is the thing you meant to work
   * in. `select_tab` is there for when it is not.
   */
  async newTab(sessionId: string, url?: string): Promise<{ pageId: string; url: string }> {
    const record = this.getRecord(sessionId);
    const page = await record.context.newPage();
    const pageId = this.adoptPage(record, page);
    record.activePageId = pageId;
    if (url !== undefined) await page.goto(url);
    this.logger.log('tab.open', { sessionId, pageId, tabs: record.pages.size });
    return { pageId, url: page.url() };
  }

  /**
   * Closes one tab, and returns the tab later calls will target instead.
   *
   * Refuses the last tab. A session with no tabs is not a usable session:
   * every tool that resolves a pageId would fail on it from then on, and
   * nothing short of `new_tab` could bring it back. Refusing keeps the
   * invariant `resolve()` already assumes, and the error names both ways out.
   * Note this governs the tool only: a page that closes itself through
   * `window.close()` can still empty a session, which is pre-existing
   * behaviour and not something the store can veto.
   */
  async closeTab(sessionId: string, pageId: string): Promise<{ closed: string; activePageId: string }> {
    const record = this.getRecord(sessionId);
    const page = record.pages.get(pageId);
    if (!page) throw new PageNotFoundError(sessionId, pageId);
    if (record.pages.size === 1) {
      throw new Error(
        `Refusing to close the last tab of session "${sessionId}". A session with no tabs cannot be used by any ` +
          'other tool. Call release_session to end the session, or new_tab first if you meant to replace this tab.'
      );
    }

    record.pages.delete(pageId);
    await page.close().catch(() => {
      // Already gone (the page closed itself, or its context died); the tab
      // is out of the table either way, which is what the caller asked for.
    });

    if (record.activePageId === pageId) {
      // The most recently opened survivor. In the flow this actually comes up
      // in, closing a popup, that is the tab the popup was opened from.
      record.activePageId = [...record.pages.keys()].sort((a, b) => Number(b) - Number(a))[0]!;
    }
    this.logger.log('tab.close', { sessionId, pageId, tabs: record.pages.size });
    return { closed: pageId, activePageId: record.activePageId };
  }

  /** Makes one tab the default target for later calls that omit `pageId`. */
  selectTab(sessionId: string, pageId: string): { activePageId: string } {
    const record = this.getRecord(sessionId);
    if (!record.pages.has(pageId)) throw new PageNotFoundError(sessionId, pageId);
    record.activePageId = pageId;
    return { activePageId: pageId };
  }

  /**
   * Every currently active session, machine-wide, not scoped to whichever
   * caller happens to ask. This is what lets a lead agent discover what
   * subagents already have running without being told a sessionId first.
   * Deliberately does not touch `lastActivity` for any listed session
   * (matching `reapIdle`'s own precedent: inspecting state is not activity).
   */
  listSessions(): SessionSummary[] {
    return [...this.sessions.values()].map(record => {
      const activePage = record.pages.get(record.activePageId);
      return {
        sessionId: record.id,
        createdAt: record.createdAt,
        lastActivity: record.lastActivity,
        pageId: record.activePageId,
        url: activePage?.url(),
        tabCount: record.pages.size,
        inFlight: record.inFlightCalls.size,
        escalated: record.escalatedAt !== undefined,
        escalatedAt: record.escalatedAt
      };
    });
  }

  /**
   * One buffered read: what matched, how many the ring has dropped for the
   * tab that was asked about, and how many it has dropped across the whole
   * session.
   *
   * `match === undefined` is the load-bearing signal for whether the read
   * NARROWED anything, and every caller above this store is responsible for
   * passing `undefined` rather than a predicate that happens to accept
   * everything. See the reset below for why.
   */
  private readBuffer<T extends { pageId: string }>(
    buffer: BoundedBuffer<T>,
    pageId: string | undefined,
    clear: boolean,
    match: ((entry: T) => boolean) | undefined
  ): { entries: T[]; droppedInScope: number; droppedInSession: number } {
    const matches = buffer.entries.filter(
      entry => (pageId === undefined || entry.pageId === pageId) && (match === undefined || match(entry))
    );
    // Both counts are read before any reset below applies, so a caller doing
    // `clear: true` still sees what was lost during the window that call is
    // about to close out, rather than the freshly-reset value.
    const droppedInSession = buffer.dropped;
    const droppedInScope = pageId === undefined ? droppedInSession : buffer.droppedByPage.get(pageId) ?? 0;
    if (clear) {
      // By identity, and not by re-deriving the filter, because `clear` used
      // to drop everything belonging to the page it was given. Any read that
      // narrowed further, by level or by substring, therefore discarded
      // entries the caller never saw and had no way to notice were gone.
      // Whatever a caller filters by, it can now only ever clear what it
      // actually read.
      const removed = new Set<T>(matches);
      buffer.entries = buffer.entries.filter(entry => !removed.has(entry));
      // Reset the drop counters ONLY for a clear that narrowed nothing at
      // all: no pageId scope and no predicate. That, and only that, is the
      // "wipe the slate, tell me only what's new from here" a fresh
      // observation window means, and it is what every tool description
      // promises.
      //
      // Judging it by the OUTCOME instead (buffer ended up empty) is the
      // defect this replaced, and it was not a near miss. A narrowed clear
      // whose filter happened to match everything currently in the ring hit
      // the same branch: against a real Vite app, a capture filter had
      // genuinely excluded 732 module-chunk requests, a read narrowed to
      // "/api/" cleared the 26 entries it returned, and the very next call
      // reported dropped 0 and filteredAtCapture 0. That is the silent false
      // pass the capture filter exists to prevent, resurrected one call
      // later.
      //
      // The other half of the fix lives in the tool handlers: they used to
      // build a predicate closure even when the caller set no filters at
      // all, so `match` was never `undefined` through the tool surface and
      // this test could not have worked there whatever it checked. They now
      // pass `undefined` when nothing was narrowed.
      if (pageId === undefined && match === undefined) {
        buffer.dropped = 0;
        buffer.droppedByPage.clear();
      }
    }
    return { entries: matches, droppedInScope, droppedInSession };
  }

  /**
   * Buffered console messages, optionally narrowed to one tab and to
   * whatever else the caller cares about. `match` exists so a tool that
   * filters by level or by text filters here rather than on the way out,
   * which is what keeps `clear` honest. `dropped` is how many console
   * messages this session's ring has evicted; see BoundedBuffer.
   */
  getConsoleMessages(
    sessionId: string,
    pageId?: string,
    clear = false,
    match?: (entry: ConsoleEntry) => boolean
  ): BufferRead<ConsoleEntry> {
    const record = this.getRecord(sessionId);
    return this.readBuffer(record.consoleBuffer, pageId, clear, match);
  }

  /** Buffered network request/response entries, same filtering, same `clear` guarantee, plus how many were evicted. */
  getNetworkEntries(
    sessionId: string,
    pageId?: string,
    clear = false,
    match?: (entry: NetworkEntry) => boolean
  ): BufferRead<NetworkEntry> & { filteredOutInScope: number; filteredOutInSession: number } {
    const record = this.getRecord(sessionId);
    const read = this.readBuffer(record.networkBuffer, pageId, clear, match);
    const filteredOutInSession = record.networkFilteredOut;
    const filteredOutInScope =
      pageId === undefined ? filteredOutInSession : record.networkFilteredOutByPage.get(pageId) ?? 0;
    // Reset on exactly the same condition as the drop counters readBuffer
    // just applied, and for exactly the same reason: only a clear that
    // narrowed nothing starts a fresh observation window. Checking whether
    // the ring ended up empty instead is what let a narrowed clear wipe a
    // real "732 requests never entered this ring" warning one call later.
    if (clear && pageId === undefined && match === undefined) {
      record.networkFilteredOut = 0;
      record.networkFilteredOutByPage.clear();
    }
    return { ...read, filteredOutInScope, filteredOutInSession };
  }

  /**
   * WebSocket connections opened in this session, optionally narrowed to one
   * tab. Never cleared by a `clear: true` read of the network ring: a socket
   * is a live thing, not a past event, and dropping an open one from the
   * report because somebody drained the HTTP buffer would be its own silent
   * false pass.
   */
  getWebSockets(sessionId: string, pageId?: string): { sockets: WebSocketEntry[]; dropped: number } {
    const record = this.getRecord(sessionId);
    const sockets = record.websockets.entries.filter(entry => pageId === undefined || entry.pageId === pageId);
    return { sockets, dropped: record.websockets.dropped };
  }

  /** Sets, replaces or (passing undefined) removes a session's network capture filter. */
  setNetworkCaptureFilter(sessionId: string, criteria: NetworkMatchCriteria | undefined): void {
    const record = this.getRecord(sessionId);
    record.networkCaptureFilter = criteria;
  }

  /** The capture filter currently in effect for a session's network ring, or undefined if it captures everything. */
  getNetworkCaptureFilter(sessionId: string): NetworkMatchCriteria | undefined {
    return this.getRecord(sessionId).networkCaptureFilter;
  }

  /** Buffered dialogs the page raised, and what each one was answered with. */
  getDialogs(
    sessionId: string,
    pageId?: string,
    clear = false,
    match?: (entry: DialogEntry) => boolean
  ): BufferRead<DialogEntry> {
    const record = this.getRecord(sessionId);
    return this.readBuffer(record.dialogBuffer, pageId, clear, match);
  }

  /** Buffered uncaught exceptions and unhandled rejections. */
  getPageErrors(
    sessionId: string,
    pageId?: string,
    clear = false,
    match?: (entry: PageErrorEntry) => boolean
  ): BufferRead<PageErrorEntry> {
    const record = this.getRecord(sessionId);
    return this.readBuffer(record.pageErrorBuffer, pageId, clear, match);
  }

  /**
   * Arms what dialogs get from now on. Session-wide rather than per tab: a
   * dialog blocks whichever tab raised it, and an agent arming "accept the
   * confirm I am about to trigger" is thinking about the action, not the tab.
   */
  setDialogPolicy(sessionId: string, policy: DialogPolicy | undefined): void {
    const record = this.getRecord(sessionId);
    record.dialogPolicy = policy;
  }

  /** The policy currently armed, so `handle_dialog` can report back what it set. */
  getDialogPolicy(sessionId: string): DialogPolicy | undefined {
    return this.sessions.get(sessionId)?.dialogPolicy;
  }

  /**
   * Serializes the tools that drive the virtual mouse and keyboard.
   *
   * Playwright gives a page one mouse and one keyboard, so two input-dispatching
   * calls on the same session interleave at the device: a `drag` holding its
   * button and a `click` arriving mid-drag makes the click's own mouseup end
   * the drag early, at the wrong coordinates, with both calls reporting the
   * success they were asked for. That is a silent corruption, so input calls
   * queue instead.
   *
   * Deliberately keyed per session rather than per tab. It over-serializes
   * slightly across a session's tabs, which costs nothing real, and it avoids
   * having to resolve a possibly-absent pageId to a tab before taking the lock,
   * which would leave a call naming a tab explicitly and one relying on the
   * active tab holding two different locks on the same mouse.
   */
  async acquireInputLock(sessionId: string): Promise<() => void> {
    const previous = this.inputLocks.get(sessionId);
    let release!: () => void;
    const held = new Promise<void>(resolve => {
      release = resolve;
    });
    const chained = (previous ?? Promise.resolve()).then(() => held);
    this.inputLocks.set(sessionId, chained);

    if (previous) await previous.catch(() => {});

    let released = false;
    return () => {
      if (released) return;
      released = true;
      release();
      // Drop the chain once nothing is queued behind this holder, so a
      // long-lived session does not accumulate one entry per session forever.
      if (this.inputLocks.get(sessionId) === chained) this.inputLocks.delete(sessionId);
    };
  }

  async releaseSession(sessionId: string): Promise<void> {
    this.inputLocks.delete(sessionId);
    const record = this.sessions.get(sessionId);
    if (!record) throw new SessionNotFoundError(sessionId);
    this.sessions.delete(sessionId);
    this.logger.log('session.release', { sessionId, sessions: this.sessions.size });
    await record.context.close();
  }

  /**
   * How many sessions are live right now. The daemon's self-shutdown gate
   * reads this every sweep: an empty client registry alone must never be
   * enough to kill a browser that agents are still working in.
   *
   * Deliberately does not touch `lastActivity` for anything it counts, for
   * the same reason `listSessions` and `reapIdle` do not: a bookkeeping
   * read is not session activity, and letting it count as activity would
   * mean the sweep itself kept every session alive forever.
   */
  count(): number {
    return this.sessions.size;
  }

  /**
   * Sessions plus creations still in progress: what the daemon's self-
   * shutdown gate must read, since a `create_session` that has not returned
   * yet is work the daemon would destroy by exiting, exactly like a live
   * session, and it is not in `count()` because it has no record yet.
   */
  liveOrPendingCount(): number {
    return this.sessions.size + this.pendingCreations;
  }

  /** All session ids currently held, for the reaper and for tests/introspection. */
  listSessionIds(): string[] {
    return [...this.sessions.keys()];
  }

  getLastActivity(sessionId: string): number | undefined {
    return this.sessions.get(sessionId)?.lastActivity;
  }

  /**
   * Marks one tool call as running against `sessionId`. Returns false if
   * there is no such session, in which case the caller should just let the
   * handler raise the real `SessionNotFoundError` rather than inventing a
   * different one here.
   *
   * Deliberately paired with `endCall` in a `finally`: an un-decremented
   * counter is worse than the bug this fixes, because it makes a session
   * permanently unreapable rather than reapable too early.
   */
  beginCall(sessionId: string): number | null {
    const record = this.sessions.get(sessionId);
    if (!record) return null;
    const now = Date.now();
    const callId = this.nextCallId++;
    record.inFlightCalls.set(callId, now);
    record.lastActivity = now;
    return callId;
  }

  /**
   * Marks one tool call as finished, refreshing `lastActivity` as it goes.
   * Refreshing on COMPLETION, not just on start, is what stops a long call
   * from returning a session that is already stale enough for the next
   * sweep to reap.
   *
   * Takes the token `beginCall` handed out rather than just the session id,
   * so the call that ends is the call that started. Ending "the oldest one"
   * instead would let a short call retire a long call's start time and reset
   * a wedged call's age.
   */
  endCall(sessionId: string, callId: number): void {
    const record = this.sessions.get(sessionId);
    if (!record) return;
    record.inFlightCalls.delete(callId);
    record.lastActivity = Date.now();
  }

  /** Tool calls currently running against a session. Zero for an unknown session. */
  inFlightCount(sessionId: string): number {
    return this.sessions.get(sessionId)?.inFlightCalls.size ?? 0;
  }

  /**
   * Records that a session has been handed to a human, which buys it the
   * much longer escalated idle timeout. Idempotent: re-escalating an already
   * escalated session keeps the original handover time, since that is the
   * number that tells an operator how long the escalation has been open.
   */
  markEscalated(sessionId: string): void {
    const record = this.sessions.get(sessionId);
    if (!record) throw new SessionNotFoundError(sessionId);
    record.escalatedAt ??= Date.now();
    record.lastActivity = Date.now();
    this.logger.log('session.escalate', { sessionId, sessions: this.sessions.size });
  }

  /**
   * Closes every session idle longer than `idleTimeoutMs` and returns the
   * ids it reaped. Does not touch `lastActivity` (unlike `resolve`):
   * checking idleness must not itself count as activity.
   */
  async reapIdle(idleTimeoutMs: number): Promise<string[]> {
    const now = Date.now();
    const reaped: string[] = [];
    for (const [id, record] of this.sessions) {
      // A call in flight is activity, even though nothing has touched
      // `lastActivity` since it started. Closing the context here is what
      // made a slow navigate or evaluate die halfway through.
      //
      // The veto is bounded, though. A call that never returns would
      // otherwise pin its session forever, and a live session also vetoes
      // the daemon's self-shutdown, so one wedged `evaluate` could hold this
      // machine-wide daemon open indefinitely. Past `maxInFlightAgeMs` the
      // reaper stops believing the call and says so in the log, because a
      // session disappearing out from under a caller needs to be explicable
      // afterwards.
      if (record.inFlightCalls.size > 0) {
        // The OLDEST running call, not the most recent one and not the time
        // since the session was last quiet: only the oldest can tell a call
        // that is never coming back from a session that is merely busy.
        const oldestStartedAt = Math.min(...record.inFlightCalls.values());
        const inFlightAgeMs = now - oldestStartedAt;

        // An escalated session gets the escalated budget here too, not the
        // ordinary stuck-call one. A person is working in that browser, and
        // taking it away from them because some unrelated call wedged is the
        // exact failure escalate_session exists to prevent. It is still a
        // bound, just a longer one, so a wedged call in an escalated session
        // cannot pin the shared daemon indefinitely either.
        const stuckBudgetMs =
          record.escalatedAt === undefined ? this.timeouts.maxInFlightAgeMs : this.timeouts.escalatedIdleTimeoutMs;
        if (inFlightAgeMs <= stuckBudgetMs) continue;
        this.logger.log('session.reap-stuck', {
          sessionId: id,
          inFlight: record.inFlightCalls.size,
          inFlightAgeMs,
          budgetMs: stuckBudgetMs,
          escalated: record.escalatedAt === undefined ? undefined : true,
          reason: 'call-never-returned'
        });
        this.sessions.delete(id);
        reaped.push(id);
        await record.context.close().catch(() => {});
        continue;
      }
      // A human driving an escalated session over CDP touches no tool, so
      // its lastActivity stops moving the moment it is handed over. It gets
      // a far longer rope, not an unlimited one.
      const timeout = record.escalatedAt === undefined ? idleTimeoutMs : this.timeouts.escalatedIdleTimeoutMs;
      if (now - record.lastActivity > timeout) {
        this.sessions.delete(id);
        reaped.push(id);
        this.logger.log('session.reap', {
          sessionId: id,
          idleMs: now - record.lastActivity,
          escalated: record.escalatedAt === undefined ? undefined : true,
          sessions: this.sessions.size
        });
        await record.context.close().catch(() => {
          // Already gone (e.g. the underlying browser died), nothing more to clean up.
        });
      }
    }
    return reaped;
  }

  async closeAll(): Promise<void> {
    const ids = [...this.sessions.keys()];
    for (const id of ids) {
      const record = this.sessions.get(id);
      this.sessions.delete(id);
      await record?.context.close().catch(() => {});
    }
  }
}
