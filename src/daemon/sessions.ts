import { randomUUID } from 'node:crypto';
import type { BrowserContext, BrowserContextOptions, Dialog, Page } from 'playwright';

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
}

function newBoundedBuffer<T>(): BoundedBuffer<T> {
  return { entries: [], dropped: 0 };
}

/** Pushes onto a bounded ring, dropping the oldest entries once over `max` and counting the drop. */
function pushBounded<T>(buffer: BoundedBuffer<T>, entry: T, max: number): void {
  buffer.entries.push(entry);
  if (buffer.entries.length > max) {
    const overflow = buffer.entries.length - max;
    buffer.entries.splice(0, overflow);
    buffer.dropped += overflow;
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
   * urlMatches, method, resourceType, direction), because a caller who found
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
   * Wires up console/network buffering for one page. Called for the initial
   * page at session creation and again for every tab the page itself opens
   * (`window.open`, `target="_blank"`), so a subagent that never calls
   * `list_tabs` first still gets buffered activity for tabs it didn't
   * explicitly create.
   */
  private attachBuffers(record: SessionRecord, page: Page, pageId: string): void {
    page.on('console', msg => {
      pushBounded(
        record.consoleBuffer,
        { pageId, type: msg.type(), text: msg.text(), timestamp: Date.now() },
        this.bufferLimits.console
      );
    });
    page.on('request', req => {
      const entry: NetworkEntry = {
        pageId,
        direction: 'request',
        url: req.url(),
        method: req.method(),
        resourceType: req.resourceType(),
        timestamp: Date.now()
      };
      if (record.networkCaptureFilter !== undefined && !matchesNetworkEntry(entry, record.networkCaptureFilter)) {
        record.networkFilteredOut += 1;
        return;
      }
      pushBounded(record.networkBuffer, entry, this.bufferLimits.network);
    });
    // Registering ANY dialog listener switches Playwright's own auto-dismiss
    // off, which makes this handler the only thing that can ever unblock a
    // page showing a modal. Verified directly against real Chromium: with a
    // listener that does not resolve the dialog, the triggering click and
    // every later call on that tab hang forever. So this handler resolves
    // the dialog on every path it can take, and decides afterwards.
    page.on('dialog', dialog => {
      let action: DialogAction = 'dismiss';
      let promptText: string | undefined;
      try {
        const policy = record.dialogPolicy;
        if (policy) {
          action = policy.action;
          promptText = policy.promptText;
          if (policy.appliesTo === 'next') record.dialogPolicy = undefined;
        }
        pushBounded(
          record.dialogBuffer,
          {
            pageId,
            type: dialog.type(),
            message: dialog.message(),
            defaultValue: dialog.defaultValue(),
            action,
            promptText,
            timestamp: Date.now()
          },
          this.bufferLimits.dialog
        );
      } catch {
        // Swallowed on purpose. Bookkeeping failing is a lost log line;
        // leaving the modal open is a wedged tab, so the resolve below runs
        // either way.
      }
      void this.resolveDialog(dialog, action, promptText);
    });

    // Uncaught exceptions. Unhandled rejections come in through the init
    // script instead, which marks them handled so they do not also surface
    // here as a duplicate.
    page.on('pageerror', err => {
      const stack = typeof err.stack === 'string' && err.stack.trim() !== '' ? err.stack : undefined;
      pushBounded(
        record.pageErrorBuffer,
        {
          pageId,
          type: 'uncaught-exception',
          valueType: err.name && err.name !== '' ? err.name : 'Error',
          message: err.message,
          stack,
          timestamp: Date.now()
        },
        this.bufferLimits.pageError
      );
    });

    page.on('response', res => {
      const entry: NetworkEntry = {
        pageId,
        direction: 'response',
        url: res.url(),
        status: res.status(),
        statusText: res.statusText(),
        timestamp: Date.now()
      };
      if (record.networkCaptureFilter !== undefined && !matchesNetworkEntry(entry, record.networkCaptureFilter)) {
        record.networkFilteredOut += 1;
        return;
      }
      pushBounded(record.networkBuffer, entry, this.bufferLimits.network);
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
    this.attachBuffers(record, page, id);
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

    const context = await browser.newContext(contextOptions);

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
      networkCaptureFilter:
        options.networkCaptureFilter !== undefined ? compileNetworkMatch(options.networkCaptureFilter) : undefined,
      networkFilteredOut: 0
    };

    // A tab opened by the page itself (window.open, a target="_blank" link,
    // etc.) becomes reachable through list_tabs / pageId too, and becomes
    // the new active tab, matching what a person driving the browser would
    // expect "the tab I just caused to open" to mean.
    context.on('page', newPage => {
      record.activePageId = this.adoptPage(record, newPage);
    });

    // Both of these happen before the first page exists, which is the whole
    // point: buffering that starts at create_session is what lets a caller
    // read back what a page did while loading, rather than only what it did
    // after somebody thought to look.
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

  /** Resolves a sessionId (+ optional pageId) to a concrete session + page, touching lastActivity. */
  resolve(sessionId: string, pageId?: string): ResolvedTarget {
    const session = this.getRecord(sessionId);
    const targetPageId = pageId ?? session.activePageId;
    const page = session.pages.get(targetPageId);
    if (!page) throw new PageNotFoundError(sessionId, targetPageId);
    session.activePageId = targetPageId;
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

  /** One buffered read: what matched, how many are sitting in the ring, and how many the ring has ever dropped. */
  private readBuffer<T extends { pageId: string }>(
    buffer: BoundedBuffer<T>,
    pageId: string | undefined,
    clear: boolean,
    match: ((entry: T) => boolean) | undefined
  ): { entries: T[]; dropped: number } {
    const matches = buffer.entries.filter(
      entry => (pageId === undefined || entry.pageId === pageId) && (match === undefined || match(entry))
    );
    // dropped is read before any reset below applies, so a caller doing
    // `clear: true` still sees what was lost during the window that call is
    // about to close out, rather than the freshly-reset value.
    const dropped = buffer.dropped;
    if (clear) {
      // By identity, and not by re-deriving the filter, because `clear` used
      // to drop everything belonging to the page it was given. Any read that
      // narrowed further, by level or by substring, therefore discarded
      // entries the caller never saw and had no way to notice were gone.
      // Whatever a caller filters by, it can now only ever clear what it
      // actually read.
      const removed = new Set<T>(matches);
      buffer.entries = buffer.entries.filter(entry => !removed.has(entry));
      // Reset the drop counter exactly when a session-wide clear (no pageId
      // scope) leaves NOTHING behind. That is the outcome that actually means
      // "wipe the slate, tell me only what's new from here", whether it got
      // there because no filter was given or because the filter happened to
      // match everything that was there.
      //
      // This has to be judged by the outcome, not by whether the caller
      // technically passed a match function: every tool handler above this
      // store builds a predicate closure even for "no filters set" (it is
      // always some function, never a literal `undefined`), so checking
      // `match === undefined` never fired through the tool surface at all,
      // only for a direct SessionStore call with no predicate. A clear
      // scoped to one tab, or one that leaves other entries sitting unread,
      // must never reset it: that would erase the "you lost N entries"
      // warning for evidence still in the buffer nobody has seen yet.
      if (pageId === undefined && buffer.entries.length === 0) buffer.dropped = 0;
    }
    return { entries: matches, dropped };
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
  ): { entries: ConsoleEntry[]; dropped: number } {
    const record = this.getRecord(sessionId);
    return this.readBuffer(record.consoleBuffer, pageId, clear, match);
  }

  /** Buffered network request/response entries, same filtering, same `clear` guarantee, plus how many were evicted. */
  getNetworkEntries(
    sessionId: string,
    pageId?: string,
    clear = false,
    match?: (entry: NetworkEntry) => boolean
  ): { entries: NetworkEntry[]; dropped: number; filteredOut: number } {
    const record = this.getRecord(sessionId);
    const { entries, dropped } = this.readBuffer(record.networkBuffer, pageId, clear, match);
    const filteredOut = record.networkFilteredOut;
    // Same reasoning and same outcome-based test as the drop counter above,
    // reset together with it: readBuffer has already applied the clear to
    // record.networkBuffer.entries by the time this runs, so an empty result
    // here means the same "genuine whole-buffer clear" that reset dropped.
    if (clear && pageId === undefined && record.networkBuffer.entries.length === 0) record.networkFilteredOut = 0;
    return { entries, dropped, filteredOut };
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
  ): { entries: DialogEntry[]; dropped: number } {
    const record = this.getRecord(sessionId);
    return this.readBuffer(record.dialogBuffer, pageId, clear, match);
  }

  /** Buffered uncaught exceptions and unhandled rejections. */
  getPageErrors(
    sessionId: string,
    pageId?: string,
    clear = false,
    match?: (entry: PageErrorEntry) => boolean
  ): { entries: PageErrorEntry[]; dropped: number } {
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
