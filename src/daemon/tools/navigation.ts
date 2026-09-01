import type { Frame, Page, Request, Response } from 'playwright';

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
  /**
   * Whether the read into the page actually completed.
   *
   * This field is the whole point of the round-5 navigation work, so it is
   * worth stating why plainly. The read is a `page.evaluate`, and Playwright
   * will not run one while the main frame has a navigation pending, so the
   * read failing is not noise: it is POSITIVE EVIDENCE that the tab is in
   * the act of moving. The previous version folded a failed read into the
   * same shape as a successful one (`title: ''`, `documentUrl: null`), and
   * every consumer downstream then fell back to comparing page.url() and
   * concluded "same document, nothing happened" with full confidence. A
   * navigation in flight was read as a tab at rest. Nothing else in this
   * file was as wrong as that, because it inverted the meaning of the
   * evidence rather than merely losing it.
   *
   * When this is false, `title` is empty and `documentUrl`, `documentStatus`
   * and `identity` are all null because they are UNKNOWN, not because the
   * page has none. `url` is still real: page.url() is answered by the
   * browser process and needs no help from a wedged renderer.
   */
  readable: boolean;
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

/**
 * How long the tail may wait when a main-frame DOCUMENT REQUEST is still
 * unanswered as the settle window closes.
 *
 * Longer than NAVIGATION_TAIL_MS on purpose, because the two are answering
 * different questions. The tail above waits on a guess: the tab moved
 * recently, so it MIGHT move again. This one waits on a certainty: a request
 * for a new main-frame document has left and has not been answered, so the
 * tab is going to be replaced (or the request is going to fail). Reporting
 * the document currently on screen as the settled answer in that state is
 * guaranteed to be stale, not merely likely to be.
 *
 * Two seconds is the largest extra latency worth paying without being asked.
 * Past it the caller is told rather than made to wait: whatever is still
 * unanswered comes back as a "pendingNavigation" naming the URL being
 * fetched, which is an answer a caller can act on. Bounded either way, and
 * further clamped by the call's own timeoutMs, so this can never be the
 * reason a call outlives its budget.
 */
export const NAVIGATION_INFLIGHT_TAIL_MS = 2000;

/**
 * How long ONE read into the page may take before it is abandoned.
 *
 * Every read here is a `page.evaluate`, and `page.evaluate` has no timeout
 * of its own in Playwright: not a long one, none at all. Two ordinary
 * situations make it never return. A backend that accepts the connection and
 * never answers leaves the main frame with a navigation pending, and
 * Playwright will not run an evaluate against a frame in that state. A page
 * that blocks its own main thread does the same thing from the other side.
 * Measured before this bound existed: navigate at a hung backend with
 * timeoutMs 1500 was still running at 20001ms, and so was the NEXT call on
 * that session, which never even got as far as issuing its goto.
 *
 * That is an availability defect rather than a slow call, because harborage
 * is one daemon shared by every agent on the machine: a call that never
 * returns keeps its inFlightCalls entry, which vetoes the session reaper for
 * maxInFlightAgeMs (ten minutes), and a live session vetoes the daemon's own
 * self-shutdown. One navigate at a hung backend pinned the shared daemon for
 * ten minutes.
 */
export const SNAPSHOT_READ_TIMEOUT_MS = 2000;

/** Default ceiling for one navigation call, matching Playwright's own default. */
export const NAVIGATION_TIMEOUT_MS = 30_000;

/**
 * Runs one read into the page with a real ceiling on it.
 *
 * Promise.race rather than an option on evaluate, because Playwright does not
 * offer one. The abandoned evaluate keeps running inside Playwright until the
 * page unwedges; it is given a `.catch` so it cannot surface later as an
 * unhandled rejection, and its result is discarded because by then nobody is
 * waiting for it. Losing the answer is the point: an answer that arrives
 * after the caller's budget has expired is not an answer.
 */
async function evaluateWithin<T>(page: Page, body: () => T, timeoutMs: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<undefined>(resolve => {
    timer = setTimeout(() => resolve(undefined), Math.max(1, timeoutMs));
  });
  const read = page.evaluate(body).catch(() => undefined);
  try {
    return await Promise.race([read, expired]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * A document's identity: a number fixed for the life of one document, read
 * with the same ceiling every other read in this file has.
 *
 * Lives here rather than beside its callers because it is the same evaluate
 * `readPageSnapshot` makes, against the same wedged-page hazard, and the two
 * drifting apart is exactly how the last three rounds of this project each
 * produced a defect: a fix applied at one call site and left standing at its
 * sibling.
 *
 * CONSUMERS, all of them:
 *   navigate       (defs/interaction.ts, the "before" identity)
 *   navigate_back  (defs/interaction.ts, through historyStep)
 *   navigate_forward (defs/interaction.ts, through historyStep)
 *   readDragProbe  (defs/interaction.ts, telling a real negative from an
 *                   unreadable one after a gesture that navigated)
 */
export async function documentIdentity(page: Page, timeoutMs: number = SNAPSHOT_READ_TIMEOUT_MS): Promise<number | null> {
  const read = await evaluateWithin(page, () => performance.timeOrigin, timeoutMs);
  return read ?? null;
}

/** A URL with any fragment removed, since a fragment never reaches the server and so never has a status of its own. */
export function withoutHash(url: string): string {
  const hash = url.indexOf('#');
  return hash === -1 ? url : url.slice(0, hash);
}

/** Anything that would move the tab again, watched for the life of one navigation call. */
export interface NavigationActivity {
  documents: DocumentResponse[];
  lastAt: number;
  /**
   * Main-frame document requests that have LEFT and have not been answered,
   * keyed by the Playwright Request so an entry cannot be removed by the
   * wrong event.
   *
   * Watching responses alone is what let a redirect fired inside the settle
   * window go by in silence. A frame commits on the RESPONSE, so a request
   * still in flight when the window closes moves neither the response
   * listener nor framenavigated, and the call reported the shell it was
   * about to discard as ok: true with nothing said. Measured: a redirect
   * issued at 100ms whose target answered at 1019ms was missed, while the
   * same redirect answered at 364ms was caught. The discriminator was the
   * target's latency, which is the one thing a caller cannot reason about
   * or raise settleMs to fix.
   */
  inFlight: Map<Request, { url: string; startedAt: number }>;
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
export async function readPageSnapshot(
  page: Page,
  timeoutMs: number = SNAPSHOT_READ_TIMEOUT_MS
): Promise<PageSnapshot> {
  const read = await evaluateWithin(
    page,
    () => {
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
    },
    timeoutMs
  );
  return {
    identity: read?.identity ?? null,
    // page.url() is answered from the browser process's own record of where
    // the tab is, so it survives a renderer that cannot be talked to. It is
    // the one field worth reporting when nothing else could be read.
    url: page.url(),
    title: read?.title ?? '',
    documentUrl: read?.documentUrl ?? null,
    documentStatus: read?.documentStatus ?? null,
    pendingRefresh: read?.pendingRefresh ?? null,
    readable: read !== undefined
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
  settleMs: number,
  deadline: number = Number.POSITIVE_INFINITY
): Promise<{ snapshot: PageSnapshot; stillMoving: boolean; inFlight: { url: string; startedAt: number } | undefined }> {
  const remaining = (): number => deadline - Date.now();
  if (settleMs > 0) await sleep(Math.max(0, Math.min(settleMs, remaining())));

  // Two different waits, deliberately not merged, because they rest on
  // different evidence. The first is a guess (the tab moved recently, so it
  // may move again); the second is a fact (a document request has left and
  // has not been answered, so the tab WILL be replaced). Both are clamped by
  // the call's own deadline, so neither can be the reason a call outlives
  // the budget its caller set.
  const tailDeadline = Date.now() + NAVIGATION_TAIL_MS;
  const inFlightDeadline = Date.now() + NAVIGATION_INFLIGHT_TAIL_MS;
  while (remaining() > 0) {
    const movingRecently = Date.now() - activity.lastAt < NAVIGATION_QUIET_MS;
    const fetching = activity.inFlight.size > 0;
    if (!movingRecently && !fetching) break;
    if (movingRecently && Date.now() >= tailDeadline && !fetching) break;
    if (fetching && Date.now() >= inFlightDeadline && !movingRecently) break;
    if (Date.now() >= tailDeadline && Date.now() >= inFlightDeadline) break;
    await sleep(Math.max(1, Math.min(20, remaining())));
  }

  const inFlight = oldestInFlightDocument(activity);
  const stillMoving = Date.now() - activity.lastAt < NAVIGATION_QUIET_MS || inFlight !== undefined;
  // The read gets whatever is left of the call's budget, never more. A wedged
  // renderer cannot answer it, and waiting past the deadline for an answer
  // nobody can use is the exact failure this whole change removes.
  const snapshot = await readPageSnapshot(page, Math.min(SNAPSHOT_READ_TIMEOUT_MS, Math.max(1, remaining())));
  return { snapshot, stillMoving, inFlight };
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
  const activity: NavigationActivity = { documents: [], lastAt: Date.now(), inFlight: new Map() };

  /** True only for a request that would replace the tab's own document. */
  const isMainFrameDocument = (request: Request): boolean => {
    try {
      return request.frame() === page.mainFrame() && request.resourceType() === 'document';
    } catch {
      // A request whose frame has already gone throws when asked for it.
      // Nothing to record, and nothing worth failing the navigation over.
      return false;
    }
  };

  const onRequest = (request: Request): void => {
    if (!isMainFrameDocument(request)) return;
    activity.inFlight.set(request, { url: request.url(), startedAt: Date.now() });
    activity.lastAt = Date.now();
  };
  const settleRequest = (request: Request): void => {
    activity.inFlight.delete(request);
  };
  const onResponse = (response: Response): void => {
    let request: Request;
    try {
      request = response.request();
    } catch {
      return;
    }
    // Removed whether or not it is one we were tracking: deleting a key that
    // is not there is free, and a request removed on the wrong event is the
    // failure worth avoiding, which keying on the Request object prevents.
    settleRequest(request);
    if (!isMainFrameDocument(request)) return;
    activity.documents.push({ response, url: response.url(), status: response.status(), ok: response.ok() });
    activity.lastAt = Date.now();
  };
  const onNavigated = (frame: Frame): void => {
    if (frame === page.mainFrame()) activity.lastAt = Date.now();
  };
  page.on('request', onRequest);
  page.on('response', onResponse);
  // A request that never gets a response still has to leave the in-flight
  // set, or a single failed navigation would make every later call in this
  // one wait out the whole in-flight tail for a request nobody is waiting
  // for. requestfailed covers an abort, a refused connection and a DNS
  // failure; requestfinished covers the ordinary completion after a
  // response, and is harmless to receive twice.
  page.on('requestfailed', settleRequest);
  page.on('requestfinished', settleRequest);
  page.on('framenavigated', onNavigated);
  return {
    activity,
    stop: () => {
      page.off('request', onRequest);
      page.off('response', onResponse);
      page.off('requestfailed', settleRequest);
      page.off('requestfinished', settleRequest);
      page.off('framenavigated', onNavigated);
    }
  };
}

/** The main-frame document request that has been unanswered longest, or nothing when the tab is not fetching one. */
export function oldestInFlightDocument(activity: NavigationActivity): { url: string; startedAt: number } | undefined {
  let oldest: { url: string; startedAt: number } | undefined;
  for (const entry of activity.inFlight.values()) {
    if (oldest === undefined || entry.startedAt < oldest.startedAt) oldest = entry;
  }
  return oldest;
}

/** A navigation measured end to end: what was fetched, what the tab finally settled on, and whether those are the same document. */
export interface NavigationOutcome {
  /** The response for the request the navigation itself made. Null when nothing was fetched over HTTP. */
  response: Response | null;
  /**
   * The tab as it was BEFORE the navigation, read once here.
   *
   * Exposed so callers stop taking their own second reading. navigate used to
   * call documentIdentity itself immediately before this, which was a
   * duplicate crossing into the page and, worse, one outside this call's
   * timeout: the ceiling covered everything except the very first thing the
   * tool did.
   */
  before: PageSnapshot;
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
  /** A main-frame document request still unanswered when this call stopped waiting, if there was one. */
  inFlight: { url: string; startedAt: number } | undefined;
  /** True when the page refused to leave: the navigation was abandoned and the tab did not move. */
  blocked: boolean;
}

/** How "is the document on screen the one this navigation fetched?" was decided, for the branches below to key off. */
type DocumentOwnershipBasis = 'no-response' | 'document-order' | 'unreadable' | 'url-fallback';

/**
 * Is the document on screen the one THIS navigation fetched?
 *
 * The old answer compared URLs, and a URL is not an identity. Two different
 * documents at one address collapse into one, which is an ordinary shape, not
 * an exotic one: `location.replace(location.href)`, `location.reload()` from
 * a script, and an A to B to A bounce all produce it. Measured against a
 * fixture that served 200 then 503 at the same path, through navigate, reload
 * and new_tab: the tool reported `status: 200, ok: true` beside the title
 * "Service Unavailable", while the live document's own timing entry said 503
 * and the fixture server's log said it had served both. The tool had the
 * right answer in hand, in `settled.documentStatus` and in its own list of
 * main-frame documents, and threw it away in favour of the URL comparison.
 *
 * The honest question is about ORDER, not address: of the main-frame
 * documents this call saw, is the one we fetched the LAST one? That is
 * decided on Playwright Response identity, so it cannot be fooled by two
 * documents sharing an address, and it needs no URL comparison at all. It
 * also gets the healthy case right for free, which matters because the round
 * before this one broke exactly that: a client-side router calling
 * history.replaceState fetches nothing, so our response is still the last
 * document, and a perfectly good 200 stays a 200.
 *
 * The two fallbacks are for when that evidence is missing, and their
 * DIRECTION is the point. If the page could not be read, that is evidence the
 * tab is moving, not evidence that it is still: an unreadable snapshot used
 * to fall through to comparing page.url() with itself and conclude "same
 * document" with confidence, which is the sharpest single defect this round
 * found.
 */
function decideDocumentIsOwn(
  response: Response | null,
  documents: DocumentResponse[],
  settled: PageSnapshot
): { isOwn: boolean; basis: DocumentOwnershipBasis } {
  if (response === null) return { isOwn: false, basis: 'no-response' };

  const ownIndex = documents.findIndex(entry => entry.response === response);
  if (ownIndex !== -1) return { isOwn: ownIndex === documents.length - 1, basis: 'document-order' };

  // Our own response was never seen by the watcher, which should not happen
  // (the watcher is installed before the navigation is issued) but is not
  // worth crashing over.
  if (!settled.readable) return { isOwn: false, basis: 'unreadable' };

  // Last resort, and deliberately stricter than the URL comparison it
  // replaces: the address has to match AND the live document's own status has
  // to agree with the response's, so the same-address-different-document case
  // cannot pass here either.
  const ownUrl = withoutHash(response.url());
  const addressMatches = withoutHash(settled.documentUrl ?? settled.url) === ownUrl;
  const statusAgrees = settled.documentStatus === null || settled.documentStatus === response.status();
  return { isOwn: addressMatches && statusAgrees, basis: 'url-fallback' };
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
  // timeoutMs is a ceiling on the WHOLE call, not on one leg of it. It used
  // to bound only the goto, and every other leg (the before read, the settle
  // window, the tail, the final read) ran with no bound at all, which is how
  // a call given 1500ms was still running at 20001ms. Every wait below draws
  // from this one deadline.
  const deadline = Date.now() + timeoutMs;
  const remaining = (): number => Math.max(1, deadline - Date.now());
  const watch = watchNavigationActivity(page);

  // Where the tab was before any of this, so an abandoned navigation can be
  // told apart from one that actually moved the tab and then failed. Bounded
  // like every other read: this is the leg that hung, and it hung BEFORE the
  // goto was ever issued, so a second call against a session whose page was
  // already wedged never reached the network at all. Proved against the
  // fixture server's own log: the healthy URL was never requested.
  const before = await readPageSnapshot(page, Math.min(SNAPSHOT_READ_TIMEOUT_MS, remaining()));

  let response: Response | null = null;
  let timedOut = false;
  let aborted = false;
  let settled: PageSnapshot;
  let stillMoving: boolean;
  let inFlight: { url: string; startedAt: number } | undefined;
  try {
    try {
      response = await run(remaining());
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
    ({
      snapshot: settled,
      stillMoving,
      inFlight
    } = await settleAfterNavigation(page, watch.activity, timedOut || aborted ? 0 : settleMs, deadline));
  } finally {
    watch.stop();
  }

  const documents = watch.activity.documents;
  const { isOwn: documentIsOwn, basis } = decideDocumentIsOwn(response, documents, settled);

  const finalKey = withoutHash(settled.documentUrl ?? settled.url);
  const finalDocument = documentIsOwn
    ? documents.find(entry => entry.response === response)
    : basis === 'document-order' || basis === 'unreadable'
      ? documents.at(-1)
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
      // The old wording said "N main-frame document(s) were fetched, which is
      // what a redirect loop looks like" unconditionally, and read as a
      // confident misdiagnosis when N was zero: a backend that accepts the
      // connection and never answers is not a redirect loop, and telling
      // someone to look for one sends them somewhere there is nothing to find.
      reason:
        `the navigation did not finish within ${timeoutMs}ms, which is the ceiling for this whole call and not just ` +
        `for its first request. ` +
        (documents.length === 0
          ? 'No main-frame document was ever fetched, so nothing answered: that is a server that accepted the ' +
            'connection and never replied, a host that never resolved, or a request still queued behind something else'
          : `${documents.length} main-frame document(s) were fetched, which is what a redirect loop looks like`),
      ...(inFlight ? { url: inFlight.url } : {}),
      afterMs: timeoutMs
    };
  } else if (inFlight !== undefined) {
    // A request for a new main-frame document has left and has not been
    // answered. This is not a guess about what the page might do next: the
    // tab is going to be replaced by whatever answers, so the document
    // described below is one the caller is about to lose.
    pending = {
      reason:
        `the tab is fetching a new document and the response had not arrived when this call stopped waiting, so ` +
        `"url", "title", "status" and "ok" describe the document being REPLACED. The fetch of ${inFlight.url} had ` +
        `been outstanding ${Date.now() - inFlight.startedAt}ms. Call navigate or reload again, or raise "timeoutMs", ` +
        `to see what it lands on`,
      url: inFlight.url,
      afterMs: settleMs
    };
  } else if (stillMoving) {
    pending = {
      reason: `the tab was still navigating when the ${settleMs}ms settle window closed, so this describes a document that may already have been replaced`,
      afterMs: settleMs
    };
  } else if (!settled.readable) {
    // Reached only when nothing above explained it. A read that could not
    // complete is itself evidence: Playwright will not run one while the main
    // frame has a navigation pending, and a page blocking its own main thread
    // has the same effect. Saying so is the whole difference between an
    // honest "I could not look" and the empty title the old code presented as
    // a finished measurement.
    pending = {
      reason:
        'the page could not be read before this call ran out of time, so "title" is empty and "status" may be ' +
        'stale: that is what a tab with a navigation still pending looks like, or one whose own JavaScript is ' +
        'blocking the main thread. "url" is still accurate, since it comes from the browser rather than the page'
    };
  } else if (settled.pendingRefresh !== null) {
    pending = {
      reason: `this document carries a meta refresh that fires in ${settled.pendingRefresh.seconds}s, which is after this call returns, so the tab will move on its own`,
      ...(settled.pendingRefresh.url ? { url: new URL(settled.pendingRefresh.url, settled.url).href } : {}),
      afterMs: Math.round(settled.pendingRefresh.seconds * 1000)
    };
  }

  return { response, before, settled, documents, finalDocument, status, ok, documentChanged, pending, timedOut, inFlight, blocked };
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
 *
 * "Download is starting" is here because the download case does NOT always
 * arrive as ERR_ABORTED. When Chromium decides the response is an attachment
 * it tells Playwright so directly, and page.goto rejects with
 * "page.goto: Download is starting" instead. Matching only ERR_ABORTED
 * therefore threw a raw Playwright error out of a path whose own blocked-note
 * text advertises downloads as one of the two things it handles: the tool
 * described the case correctly and then failed to recognise it. Measured
 * against a server answering with Content-Disposition: attachment.
 */
export function isAbortedError(error: unknown): boolean {
  const message = String((error as { message?: string } | null)?.message ?? '');
  return /net::ERR_ABORTED/.test(message) || /Download is starting/i.test(message);
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

