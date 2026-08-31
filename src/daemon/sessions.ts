import { randomUUID } from 'node:crypto';
import type { BrowserContext, Page } from 'playwright';

import { noopLogger, type Logger } from '../shared/logger.js';
import type { BrowserManager } from './browserManager.js';

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

/** Max buffered entries kept per session (console + network, each independently bounded). */
export interface BufferLimits {
  console: number;
  network: number;
}

const defaultBufferLimits: BufferLimits = { console: 200, network: 200 };

/** Pushes onto a bounded array, dropping the oldest entries once over `max`. */
function pushBounded<T>(buffer: T[], entry: T, max: number): void {
  buffer.push(entry);
  if (buffer.length > max) {
    buffer.splice(0, buffer.length - max);
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
  consoleBuffer: ConsoleEntry[];
  networkBuffer: NetworkEntry[];
}

/** What a tool handler gets back after resolving a sessionId (+ optional pageId). */
export interface ResolvedTarget {
  session: SessionRecord;
  page: Page;
  pageId: string;
}

/** One row of `list_sessions` output — deliberately not scoped to any particular caller. */
export interface SessionSummary {
  sessionId: string;
  createdAt: number;
  lastActivity: number;
  pageId: string;
  url: string | undefined;
  tabCount: number;
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
  private readonly bufferLimits: BufferLimits;

  /**
   * The logger is injected rather than imported as a module-level singleton
   * so a test can capture exactly the lines one store emitted, and so a
   * caller that does not want session lifecycle output (most unit tests)
   * simply gets the no-op default.
   */
  constructor(
    private readonly browserManager: BrowserManager,
    bufferLimits: Partial<BufferLimits> = {},
    private readonly logger: Logger = noopLogger
  ) {
    this.bufferLimits = { ...defaultBufferLimits, ...bufferLimits };
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
      pushBounded(
        record.networkBuffer,
        {
          pageId,
          direction: 'request',
          url: req.url(),
          method: req.method(),
          resourceType: req.resourceType(),
          timestamp: Date.now()
        },
        this.bufferLimits.network
      );
    });
    page.on('response', res => {
      pushBounded(
        record.networkBuffer,
        {
          pageId,
          direction: 'response',
          url: res.url(),
          status: res.status(),
          statusText: res.statusText(),
          timestamp: Date.now()
        },
        this.bufferLimits.network
      );
    });
  }

  async createSession(storageState?: unknown): Promise<{ sessionId: string; pageId: string }> {
    const browser = await this.browserManager.getBrowser();
    const context = await browser.newContext(
      storageState !== undefined ? { storageState: storageState as never } : {}
    );
    const page = await context.newPage();

    const sessionId = randomUUID();
    const pageId = '0';
    const now = Date.now();
    const record: SessionRecord = {
      id: sessionId,
      context,
      pages: new Map([[pageId, page]]),
      nextPageSeq: 1,
      activePageId: pageId,
      createdAt: now,
      lastActivity: now,
      consoleBuffer: [],
      networkBuffer: []
    };

    // A tab opened by the page itself (window.open, a target="_blank" link,
    // etc.) becomes reachable through list_tabs / pageId too, and becomes
    // the new active tab, matching what a person driving the browser would
    // expect "the tab I just caused to open" to mean.
    context.on('page', newPage => {
      const id = String(record.nextPageSeq++);
      record.pages.set(id, newPage);
      record.activePageId = id;
      this.attachBuffers(record, newPage, id);
      newPage.on('close', () => {
        record.pages.delete(id);
      });
    });

    page.on('close', () => {
      record.pages.delete(pageId);
    });
    this.attachBuffers(record, page, pageId);

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

  async listTabs(sessionId: string): Promise<{ pageId: string; url: string; title: string }[]> {
    const session = this.getRecord(sessionId);
    return Promise.all(
      [...session.pages.entries()].map(async ([pageId, page]) => ({
        pageId,
        url: page.url(),
        title: await page.title().catch(() => '')
      }))
    );
  }

  /**
   * Every currently active session, machine-wide — not scoped to whichever
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
        tabCount: record.pages.size
      };
    });
  }

  /** Buffered console messages for a session, optionally filtered to one tab. */
  getConsoleMessages(sessionId: string, pageId?: string, clear = false): ConsoleEntry[] {
    const record = this.getRecord(sessionId);
    const matches = pageId ? record.consoleBuffer.filter(e => e.pageId === pageId) : [...record.consoleBuffer];
    if (clear) {
      record.consoleBuffer = pageId ? record.consoleBuffer.filter(e => e.pageId !== pageId) : [];
    }
    return matches;
  }

  /** Buffered network request/response entries for a session, optionally filtered to one tab. */
  getNetworkEntries(sessionId: string, pageId?: string, clear = false): NetworkEntry[] {
    const record = this.getRecord(sessionId);
    const matches = pageId ? record.networkBuffer.filter(e => e.pageId === pageId) : [...record.networkBuffer];
    if (clear) {
      record.networkBuffer = pageId ? record.networkBuffer.filter(e => e.pageId !== pageId) : [];
    }
    return matches;
  }

  async releaseSession(sessionId: string): Promise<void> {
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

  /** All session ids currently held, for the reaper and for tests/introspection. */
  listSessionIds(): string[] {
    return [...this.sessions.keys()];
  }

  getLastActivity(sessionId: string): number | undefined {
    return this.sessions.get(sessionId)?.lastActivity;
  }

  /**
   * Closes every session idle longer than `idleTimeoutMs` and returns the
   * ids it reaped. Does not touch `lastActivity` (unlike `resolve`) —
   * checking idleness must not itself count as activity.
   */
  async reapIdle(idleTimeoutMs: number): Promise<string[]> {
    const now = Date.now();
    const reaped: string[] = [];
    for (const [id, record] of this.sessions) {
      if (now - record.lastActivity > idleTimeoutMs) {
        this.sessions.delete(id);
        reaped.push(id);
        this.logger.log('session.reap', {
          sessionId: id,
          idleMs: now - record.lastActivity,
          sessions: this.sessions.size
        });
        await record.context.close().catch(() => {
          // Already gone (e.g. the underlying browser died) — nothing more to clean up.
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
