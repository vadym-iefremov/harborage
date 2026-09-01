import type { Frame, Page, Response } from 'playwright';

/**
 * How a navigation is measured, for every tool that causes one.
 *
 * This lives in its own module because it is shared, and because the last
 * three rounds of this project each failed the same way: a defect was fixed
 * at one call site and left standing at its siblings. Keeping the measurement
 * in one place makes the consumer list something you can read rather than
 * something you have to remember.
 *
 * CONSUMERS, all of them:
 *   navigate         (defs/interaction.ts)
 *   reload           (defs/interaction.ts)
 *   navigate_back    (defs/interaction.ts, through historyStep)
 *   navigate_forward (defs/interaction.ts, through historyStep)
 *   new_tab          (defs/session.ts, when opened with a url)
 *
 * Tools that can cause a navigation as a SIDE EFFECT (click, fill, type,
 * press_key, hover, drag, wheel) are deliberately not consumers: none of them
 * reports a url, title or HTTP status, so none can describe a document that
 * has been replaced, and none should pay the settle cost. click's "ok" is
 * "the click was dispatched", not an HTTP status. If any of them ever grows a
 * field describing the page AFTER the action, it belongs on this list.
 */

/** A real pause. Local so this module has no dependency on the tool files that use it. */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * The two page globals the settle snapshot reads. Declared rather than pulled
 * in from lib.dom, because the daemon is a Node process and opening the whole
 * DOM up would let browser APIs leak into daemon code unnoticed.
 */
declare const performance: {
  timeOrigin: number;
  getEntriesByType(type: string): { name?: string; responseStatus?: number }[];
};

declare const document: {
  title: string;
  querySelector(selector: string): { getAttribute(name: string): string | null } | null;
};

/** One main-frame document response, kept so a navigation's final document can be given its own status. */
export interface DocumentResponse {
  /** The Playwright Response object, kept only to compare by identity against the one the navigation returned. */
  response: Response;
  url: string;
  status: number;
  ok: boolean;
}

/** What the tab is showing right now, read in one crossing so no two fields can come from different documents. */
export interface PageSnapshot {
  identity: number | null;
  url: string;
  title: string;
  /**
   * The URL the CURRENT document's own navigation fetched, from its
   * PerformanceNavigationTiming entry. This is not page.url(): a page that
   * calls history.replaceState rewrites page.url() while this stays the
   * address that was actually requested, which is the only way to tell a
   * client-side route rewrite (nothing was fetched) apart from a client-side
   * redirect (a different document was fetched).
   */
  documentUrl: string | null;
  /** The HTTP status of the current document, from the document's own timing entry. Null when it had no HTTP response. */
  documentStatus: number | null;
  /** A meta refresh sitting in the document, which will move the tab after this call returns. */
  pendingRefresh: { seconds: number; url: string } | null;
}

/** Why a payload may already be out of date by the time it is read. */
export interface PendingNavigation {
  reason: string;
  url?: string;
  afterMs?: number;
}

/**
 * How long a navigation is watched for a page that moves itself, unless the
 * caller says otherwise.
 *
 * Why half a second, and why it is not tuned down: the two costs here are
 * wildly asymmetric. The latency is paid on every call and buys back almost
 * nothing, because this tool is driven by agents whose turns cost seconds, so
 * an extra 485ms is invisible against that. The false pass is paid rarely and
 * costs enormously: an agent that reads ok: true beside a login page goes and
 * debugs an application that was never broken, and the whole value of this
 * surface is that its output is trusted without re-verification. A tool that
 * is fast and occasionally lies is worth less than one that is slow and never
 * does.
 *
 * The tempting middle, a shorter default, is not a compromise between the
 * two. It does not trade some honesty for some speed; it moves the silent
 * miss to a different delay. A redirect timed later than the window produces
 * no warning at all, because at the moment the window closes nothing has
 * happened yet, so there is nothing to disclose. That is the exact failure
 * this window was widened to fix, and it would come back at 300ms just as it
 * existed at 10ms.
 *
 * settleMs is where a caller who has measured their own situation opts out.
 * Honest by default, fast by explicit request.
 */
export const NAVIGATION_SETTLE_MS = 500;

/** A navigation is treated as still in flight if the tab moved this recently when the window closed. */
export const NAVIGATION_QUIET_MS = 60;

/** How long the tail wait for a mid-flight navigation may add on top of the settle window. */
export const NAVIGATION_TAIL_MS = 400;

/** Default ceiling for one navigation call, matching Playwright's own default. */
export const NAVIGATION_TIMEOUT_MS = 30_000;

/** A URL with any fragment removed, since a fragment never reaches the server and so never has a status of its own. */
export function withoutHash(url: string): string {
  const hash = url.indexOf('#');
  return hash === -1 ? url : url.slice(0, hash);
}

/** Anything that would move the tab again, watched for the life of one navigation call. */
export interface NavigationActivity {
  documents: DocumentResponse[];
  lastAt: number;
}

/**
 * url, title, document identity, the current document's own fetched address
 * and status, and any meta refresh still pending, all read in ONE crossing
 * into the page.
 *
 * Reading them separately is how navigate came to describe two documents at
 * once: page.url() answered from one document and page.title() from the next.
 * It is also two round trips instead of one, which doubled the settle cost on
 * a page whose main thread was busy.
 */
export async function readPageSnapshot(page: Page): Promise<PageSnapshot> {
  const read = await page
    .evaluate(() => {
      const entry = performance.getEntriesByType('navigation')[0];
      const meta = document.querySelector('meta[http-equiv="refresh" i]');
      const content = meta ? meta.getAttribute('content') : null;
      let pendingRefresh: { seconds: number; url: string } | null = null;
      if (content) {
        const match = /^\s*([\d.]+)\s*(?:;\s*url\s*=\s*(.*?)\s*)?$/i.exec(content);
        if (match) {
          pendingRefresh = { seconds: Number(match[1]), url: (match[2] ?? '').replace(/^['"]|['"]$/g, '') };
        }
      }
      return {
        identity: performance.timeOrigin,
        title: document.title,
        documentUrl: typeof entry?.name === 'string' ? entry.name : null,
        // responseStatus is 0 for a document that never came over HTTP
        // (about:blank, a data: or blob: URL), which is a real answer and not
        // a missing one, so it is normalised to null rather than reported.
        documentStatus: typeof entry?.responseStatus === 'number' && entry.responseStatus > 0 ? entry.responseStatus : null,
        pendingRefresh
      };
    })
    .catch(() => null);
  return {
    identity: read?.identity ?? null,
    url: page.url(),
    title: read?.title ?? '',
    documentUrl: read?.documentUrl ?? null,
    documentStatus: read?.documentStatus ?? null,
    pendingRefresh: read?.pendingRefresh ?? null
  };
}

/**
 * Watches for the whole settle window, then reports what the tab finally
 * settled on.
 *
 * The previous version returned on the FIRST quiet 10ms poll, which made the
 * advertised 500ms a fiction: a redirect fired 20ms after load was already
 * past it, and an adversary sweeping delays found 20, 30, 50, 80, 150, 300
 * and 499ms all escaping. There is no signal a page can give that it will not
 * navigate again, so exiting early on the absence of one was never sound. The
 * window is watched in full instead, and it is a real number a caller can
 * reason about and raise.
 *
 * A short tail follows it, because measuring in the middle of a navigation is
 * its own kind of wrong answer: if the tab moved in the last moments of the
 * window, this waits for it to stop, up to a bounded extra. Whatever is still
 * moving when that runs out is reported as still moving rather than presented
 * as settled.
 */
export async function settleAfterNavigation(
  page: Page,
  activity: NavigationActivity,
  settleMs: number
): Promise<{ snapshot: PageSnapshot; stillMoving: boolean }> {
  if (settleMs > 0) await sleep(settleMs);
  const tailDeadline = Date.now() + NAVIGATION_TAIL_MS;
  while (Date.now() - activity.lastAt < NAVIGATION_QUIET_MS && Date.now() < tailDeadline) {
    await sleep(20);
  }
  const stillMoving = Date.now() - activity.lastAt < NAVIGATION_QUIET_MS;
  return { snapshot: await readPageSnapshot(page), stillMoving };
}

/**
 * Watches a tab's main frame for anything that would move it again, for the
 * life of one call.
 *
 * Both halves are needed. The response listener catches a document being
 * fetched, which is what a client-side redirect and a meta refresh do, and it
 * is what lets the final document be given its own status. framenavigated
 * also catches the same-document kind, so a page that is rewriting its own
 * URL in a loop is not mistaken for a page at rest.
 */
export function watchNavigationActivity(page: Page): { activity: NavigationActivity; stop: () => void } {
  const activity: NavigationActivity = { documents: [], lastAt: Date.now() };
  const onResponse = (response: Response): void => {
    try {
      const request = response.request();
      if (request.frame() !== page.mainFrame()) return;
      if (request.resourceType() !== 'document') return;
      activity.documents.push({ response, url: response.url(), status: response.status(), ok: response.ok() });
      activity.lastAt = Date.now();
    } catch {
      // A request whose frame has already gone throws when asked for it.
      // Nothing to record, and nothing worth failing the navigation over.
    }
  };
  const onNavigated = (frame: Frame): void => {
    if (frame === page.mainFrame()) activity.lastAt = Date.now();
  };
  page.on('response', onResponse);
  page.on('framenavigated', onNavigated);
  return {
    activity,
    stop: () => {
      page.off('response', onResponse);
      page.off('framenavigated', onNavigated);
    }
  };
}

/** A navigation measured end to end: what was fetched, what the tab finally settled on, and whether those are the same document. */
export interface NavigationOutcome {
  /** The response for the request the navigation itself made. Null when nothing was fetched over HTTP. */
  response: Response | null;
  /** The tab once it stopped replacing its own document. */
  settled: PageSnapshot;
  /** Every main-frame document response seen during the call, in order. */
  documents: DocumentResponse[];
  /** The response that produced the document `settled` describes, if one was recorded. */
  finalDocument: DocumentResponse | undefined;
  /** Status of the document `settled` describes, NOT of whatever the first request answered. */
  status: number | null;
  ok: boolean | null;
  /** True when the page fetched a DIFFERENT document after the response was measured. */
  documentChanged: boolean;
  /** Set when the answer may already be out of date: still navigating, a meta refresh pending, or the call timed out. */
  pending: PendingNavigation | undefined;
  /** True when the navigation itself did not finish inside the caller's timeout. */
  timedOut: boolean;
  /** True when the page refused to leave: the navigation was abandoned and the tab did not move. */
  blocked: boolean;
}

/**
 * Runs one navigation and measures the document the caller will actually be
 * looking at when the answer comes back.
 *
 * Shared by navigate and reload because the defect was shared: both used to
 * report the status of the response THEY caused beside a url and title read
 * fresh afterwards, and those are different documents the moment the page
 * redirects itself.
 *
 * The hard question this answers is "is the document on screen the one this
 * navigation fetched?", and the honest source for it is the document's own
 * PerformanceNavigationTiming entry, not a URL comparison. A page calling
 * history.replaceState changes its URL without fetching anything, and matching
 * on URL used to read that as a client-side redirect and blank out a perfectly
 * good 200: an over-correction that hit the single most common shape there
 * is, since almost every client-side router rewrites its URL on first paint.
 */
export async function performNavigation(
  page: Page,
  run: (timeout: number) => Promise<Response | null>,
  options: { settleMs?: number; timeoutMs?: number } = {}
): Promise<NavigationOutcome> {
  const settleMs = options.settleMs ?? NAVIGATION_SETTLE_MS;
  const timeoutMs = options.timeoutMs ?? NAVIGATION_TIMEOUT_MS;
  let response: Response | null = null;
  let timedOut = false;
  let aborted = false;
  let before: PageSnapshot;
  let settled: PageSnapshot;
  let stillMoving: boolean;

  // The listeners go on immediately before the try, and everything that can throw
  // afterwards is inside it. The snapshot read below used to sit between the two, which
  // left both listeners on the page for the rest of its life if it ever threw: they hold
  // a closure over an activity array that keeps growing with every document response,
  // and nothing about a failed navigation would ever have shown it. It happens not to
  // throw today, because readPageSnapshot swallows its own evaluate failure, but that is
  // a property of another function and not a guarantee this one should be leaning on.
  const watch = watchNavigationActivity(page);
  try {
    // Where the tab was before any of this, so an abandoned navigation can be
    // told apart from one that actually moved the tab and then failed.
    before = await readPageSnapshot(page);
    try {
      response = await run(timeoutMs);
    } catch (error) {
      // A page that replaces itself with itself never lets goto resolve, so
      // the call used to die on a raw Playwright timeout with nothing said
      // about why. A timeout here is reported rather than thrown, because
      // what the tab IS showing and the chain of documents behind it are the
      // whole diagnosis. Anything that is not a timeout is a real failure and
      // still propagates.
      if (isTimeoutError(error)) timedOut = true;
      else if (isAbortedError(error)) aborted = true;
      else throw error;
    }
    ({ snapshot: settled, stillMoving } = await settleAfterNavigation(page, watch.activity, timedOut || aborted ? 0 : settleMs));
  } finally {
    watch.stop();
  }

  const documents = watch.activity.documents;
  // Is the document on screen the one this navigation fetched? Asked of the
  // document itself. The URL fallback is for the rare case where the timing
  // entry is unreadable.
  const ownUrl = response === null ? null : withoutHash(response.url());
  const documentIsOwn =
    response !== null &&
    (settled.documentUrl !== null ? withoutHash(settled.documentUrl) === ownUrl : withoutHash(settled.url) === ownUrl);

  const finalKey = withoutHash(settled.documentUrl ?? settled.url);
  const finalDocument = documentIsOwn
    ? documents.find(entry => entry.response === response)
    : documents.filter(entry => withoutHash(entry.url) === finalKey).at(-1);

  // Playwright's own Response is preferred wherever it describes the document
  // being reported, since it is authoritative about the status and about ok().
  // The document's timing entry only fills in for a document goto never
  // returned, which is exactly the redirected-to case.
  const status =
    response === null ? null : documentIsOwn ? response.status() : (finalDocument?.status ?? settled.documentStatus ?? null);
  const ok =
    response === null
      ? null
      : documentIsOwn
        ? response.ok()
        : status === null
          ? null
          : status >= 200 && status < 300;

  const documentChanged = response !== null && !documentIsOwn;

  // An abandoned navigation that left the tab exactly where it was is the
  // page refusing to leave, which is a fact about the page and belongs in the
  // payload. One that abandoned AFTER moving the tab is something else, and
  // is reported as the ordinary navigation it turned out to be.
  const blocked =
    aborted &&
    settled.url === before.url &&
    (before.identity === null || settled.identity === null || before.identity === settled.identity);
  if (aborted && !blocked) {
    // It moved. Nothing to report beyond the normal measurement below.
  }

  let pending: PendingNavigation | undefined;
  if (blocked) {
    pending = {
      reason:
        'the navigation was abandoned before it committed and the tab did not move. The usual causes are a ' +
        'beforeunload handler asking the browser to stay, which this session answers by staying, and a URL that ' +
        'turns out to be a download rather than a document. Use download_file for a download'
    };
  } else if (timedOut) {
    pending = {
      reason:
        `the navigation did not finish within ${timeoutMs}ms and the tab was still moving when this call gave up. ` +
        `${documents.length} main-frame document(s) were fetched, which is what a redirect loop looks like`,
      afterMs: timeoutMs
    };
  } else if (stillMoving) {
    pending = {
      reason: `the tab was still navigating when the ${settleMs}ms settle window closed, so this describes a document that may already have been replaced`,
      afterMs: settleMs
    };
  } else if (settled.pendingRefresh !== null) {
    pending = {
      reason: `this document carries a meta refresh that fires in ${settled.pendingRefresh.seconds}s, which is after this call returns, so the tab will move on its own`,
      ...(settled.pendingRefresh.url ? { url: new URL(settled.pendingRefresh.url, settled.url).href } : {}),
      afterMs: Math.round(settled.pendingRefresh.seconds * 1000)
    };
  }

  return { response, settled, documents, finalDocument, status, ok, documentChanged, pending, timedOut, blocked };
}

/**
 * True when the browser abandoned the navigation before it committed.
 *
 * A beforeunload handler produces this: Chromium asks to stay, this session
 * dismisses the dialog, and the navigation is abandoned. So does a URL that
 * turns out to be a download rather than a document. Both are things the PAGE
 * did, not failures of the tool, and both used to reach the caller as a raw
 * "page.goto: net::ERR_ABORTED". They are reported instead, but only on
 * evidence: the tab has to still be where it was.
 */
export function isAbortedError(error: unknown): boolean {
  return /net::ERR_ABORTED/.test(String((error as { message?: string } | null)?.message ?? ''));
}

/** True for a Playwright timeout, which is reported rather than thrown, unlike a real navigation failure. */
export function isTimeoutError(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name;
  const message = String((error as { message?: string } | null)?.message ?? '');
  return name === 'TimeoutError' || /Timeout .*exceeded/i.test(message);
}

/**
 * The note a caller needs when the page moved itself, worded for whichever
 * tool is reporting it. Kept in one place so navigate and reload cannot drift
 * into explaining the same situation differently.
 */
export function documentChangedNote(outcome: NavigationOutcome, what: string): string {
  const response = outcome.response;
  if (response === null) return '';
  return (
    `The page moved itself after the response was measured: the ${what} of ${response.url()} answered ${response.status()}, and the document now on screen was fetched from ${outcome.settled.documentUrl ?? outcome.settled.url}. That is a client-side redirect (location.assign or replace, a meta refresh, or a router bouncing an unauthenticated visitor), and "documentChanged" lists every main-frame document this call saw, in order. ` +
    (outcome.status !== null
      ? `"status" and "ok" describe the document "url" and "title" describe, this last one, NOT the ${response.status()} that started the chain.`
      : 'The final document has no HTTP response of its own to report (about:blank, a data: URL or a blob:), so "status" and "ok" are null rather than carrying the earlier document\'s status.')
  );
}

/** The documentChanged block both navigate and reload attach, or nothing when the document held still. */
export function documentChangedPayload(outcome: NavigationOutcome): Record<string, unknown> {
  if (!outcome.documentChanged || outcome.response === null) return {};
  return {
    documentChanged: {
      from: { url: outcome.response.url(), status: outcome.response.status(), ok: outcome.response.ok() },
      to: { url: outcome.settled.documentUrl ?? outcome.settled.url, status: outcome.status, ok: outcome.ok },
      documents: outcome.documents.map(entry => ({ url: entry.url, status: entry.status, ok: entry.ok }))
    }
  };
}

/** The pendingNavigation block and its note, shared by navigate, reload and the history steps. */
export function pendingNavigationPayload(pending: PendingNavigation | undefined): Record<string, unknown> {
  return pending === undefined ? {} : { pendingNavigation: pending };
}

