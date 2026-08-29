import { randomUUID } from 'node:crypto';
import type { BrowserContext, Page } from 'playwright';

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

interface SessionRecord {
  id: string;
  context: BrowserContext;
  pages: Map<string, Page>;
  nextPageSeq: number;
  activePageId: string;
  createdAt: number;
  lastActivity: number;
}

/** What a tool handler gets back after resolving a sessionId (+ optional pageId). */
export interface ResolvedTarget {
  session: SessionRecord;
  page: Page;
  pageId: string;
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

  constructor(private readonly browserManager: BrowserManager) {}

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
      lastActivity: now
    };

    // A tab opened by the page itself (window.open, a target="_blank" link,
    // etc.) becomes reachable through list_tabs / pageId too, and becomes
    // the new active tab, matching what a person driving the browser would
    // expect "the tab I just caused to open" to mean.
    context.on('page', newPage => {
      const id = String(record.nextPageSeq++);
      record.pages.set(id, newPage);
      record.activePageId = id;
      newPage.on('close', () => {
        record.pages.delete(id);
      });
    });

    page.on('close', () => {
      record.pages.delete(pageId);
    });

    this.sessions.set(sessionId, record);
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

  async releaseSession(sessionId: string): Promise<void> {
    const record = this.sessions.get(sessionId);
    if (!record) throw new SessionNotFoundError(sessionId);
    this.sessions.delete(sessionId);
    await record.context.close();
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
