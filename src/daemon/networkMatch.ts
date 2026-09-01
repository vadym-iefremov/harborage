import type { NetworkEntry } from './sessions.js';

/**
 * A network filter exactly as a caller writes it: an unparsed regex source
 * for urlMatches, mixed-case strings for urlIncludes, method and resourceType.
 *
 * This is the one shape `list_network_requests` (read time), `create_session`
 * and `set_network_capture_filter` (capture time) all take a filter in. A
 * caller who learned the vocabulary reading a request that came back empty
 * can paste the same fields into a capture filter to stop it happening again,
 * rather than learning a second, slightly different set of field names.
 */
export interface NetworkMatchInput {
  urlIncludes?: string;
  urlMatches?: string;
  method?: string;
  resourceType?: string;
  minStatus?: number;
  maxStatus?: number;
  direction?: 'request' | 'response';
}

/**
 * A `NetworkMatchInput` with its regular expression compiled and its
 * case-insensitive fields normalized once, so `matchesNetworkEntry` can run
 * per entry without re-parsing anything.
 */
export interface NetworkMatchCriteria {
  urlIncludes?: string;
  urlMatches?: RegExp;
  method?: string;
  resourceType?: string;
  minStatus?: number;
  maxStatus?: number;
  direction?: 'request' | 'response';
}

// ---------------------------------------------------------------------------
// Runaway-pattern guard
// ---------------------------------------------------------------------------

/*
 * WHY THIS EXISTS, and why it refuses patterns instead of timing them out.
 *
 * `urlMatches` compiles a caller-supplied regular expression and runs it once
 * per network request, synchronously, on the daemon's event loop. Measured on
 * a real machine with `process.hrtime.bigint()` around one `RegExp.test` call
 * for `^(a+)+$` against a run of `a` characters:
 *
 *     18 chars    1.1 ms
 *     20 chars    4.4 ms
 *     22 chars   17.9 ms
 *     24 chars   71.7 ms
 *     26 chars  284.6 ms
 *
 * Roughly 4x per two added characters, so 34 characters is over two minutes.
 * The URL is caller-controlled too: an agent navigates its own session
 * wherever it likes, so both halves of the blowup are in one caller's hands.
 * End to end through a real daemon, a `create_session` capture filter of
 * `(a+)+$` against a 28-character adversarial URL made a concurrent /health
 * request take 2327 ms against an idle baseline of 4.9 ms.
 *
 * This daemon is shared by every agent on the machine and Node is single
 * threaded, so that is not one slow tool call. It is every other session, the
 * health endpoint and the idle reaper, all frozen, from one filter that one
 * caller set and then forgot about, on every request for the life of the
 * session.
 *
 * Things that do NOT work here, each checked rather than assumed:
 *
 *   - A time budget measured around the match. `RegExp.prototype.test` cannot
 *     be interrupted in-process, so a budget can only ever report a stall that
 *     has already happened. The two-minute case is a SINGLE match.
 *   - A length cap on the pattern. `^(a+)+$` is 8 characters. The blowup is
 *     driven by the length of the INPUT, not of the pattern.
 *   - V8's non-backtracking engine. Its `l` flag needs the process to be
 *     started with --enable-experimental-regexp-engine, verified unavailable
 *     on the Node this daemon runs under (`new RegExp('a+', 'l')` throws
 *     "Invalid flags supplied to RegExp constructor"), and it drops
 *     lookarounds and backreferences even when enabled.
 *   - A worker thread with a hard kill. It would genuinely bound the match,
 *     but `compileNetworkMatch` is called synchronously from three places and
 *     making it async would ripple through the session store and the read
 *     path, and a worker spawn per `list_network_requests` call is its own
 *     cost on a shared daemon.
 *
 * So the guard refuses the pattern up front, in two layers, and a refusal is
 * a normal tool error the caller can read and act on. Layer one is structural
 * and deterministic; layer two is an empirical probe that catches shapes the
 * structure misses. What neither layer covers is stated at `probePattern`
 * below and repeated in the tool descriptions.
 */

/**
 * A repetition quantifier found in a regex source, and whether it is
 * open-ended.
 *
 * The distinction is what keeps the structural check off realistic patterns.
 * `(\d{1,3}\.){3}` is a group with a repeat inside it repeated again, which a
 * naive star-height rule refuses, and it is a perfectly ordinary IPv4 matcher
 * that can never blow up: both repeats are bounded, so the search space is a
 * couple of dozen splits, and the literal `.` between them removes the
 * ambiguity anyway.
 */
interface Quantifier {
  /** Index just past the quantifier, including a trailing lazy `?`. */
  end: number;
  /** True for `*`, `+` and `{n,}`, i.e. anything with no upper bound. */
  unbounded: boolean;
}

/**
 * `{n}`, `{n,}` or `{n,m}`, or no match when the `{` is a literal brace.
 *
 * Linear by construction: one greedy digit run, one optional comma-plus-digit
 * run, both anchored, neither nested inside the other. The guard must not
 * itself be the thing that backtracks.
 */
const braceQuantifier = /^\{(\d+)(?:,(\d*))?\}/;

function quantifierAt(source: string, i: number): Quantifier | null {
  const lazyEnd = (at: number): number => (source[at] === '?' ? at + 1 : at);
  const c = source[i];
  if (c === '*' || c === '+') return { end: lazyEnd(i + 1), unbounded: true };
  if (c === '?') return { end: lazyEnd(i + 1), unbounded: false };
  if (c !== '{') return null;
  const match = braceQuantifier.exec(source.slice(i));
  if (match === null) return null;
  return { end: lazyEnd(i + match[0].length), unbounded: match[2] === '' };
}

/** What a group's contents turned out to hold, propagated outwards as groups close. */
interface Frame {
  sawQuantifier: boolean;
  sawUnboundedQuantifier: boolean;
}

function emptyFrame(): Frame {
  return { sawQuantifier: false, sawUnboundedQuantifier: false };
}

/**
 * Whether the pattern repeats something that can already repeat, which is the
 * shape catastrophic backtracking needs.
 *
 * The rule, in one sentence, because a rejection a caller cannot act on is its
 * own defect: a repetition applied to a group that already contains a
 * repetition is refused when either of the two is open-ended (`*`, `+` or
 * `{n,}`). So `(a+)+`, `(a+){3}` and `(a{1,3})+` are refused, and
 * `(\d{1,3}\.){3}` is not.
 *
 * This deliberately over-refuses in one direction and under-refuses in the
 * other. `(?:ab)+` repeated is unambiguous and safe, and gets refused anyway,
 * because deciding ambiguity properly is the whole ReDoS-detection problem and
 * a wrong "this one is safe" answer costs the whole machine. `(a|a)+` has no
 * nested quantifier at all and IS catastrophic, measured at 76 ms for 20
 * characters, and gets past this check entirely; that is what the probe below
 * is for.
 */
function repeatsARepeat(source: string): boolean {
  const length = source.length;
  let top = emptyFrame();
  const stack: Frame[] = [];
  /** What the group that just closed contained, or null when the last atom was not a group. */
  let justClosed: Frame | null = null;
  let i = 0;

  while (i < length) {
    const c = source[i];

    if (c === '\\') {
      // An escape is one atom whatever it stands for, and skipping both
      // characters is what stops `\(` and `\+` being read as structure.
      i += 2;
      justClosed = null;
      continue;
    }

    if (c === '[') {
      // Inside a class every metacharacter is literal, so `[+*]` must not be
      // read as two quantifiers.
      i += 1;
      if (source[i] === '^') i += 1;
      if (source[i] === ']') i += 1;
      while (i < length && source[i] !== ']') i += source[i] === '\\' ? 2 : 1;
      i += 1;
      justClosed = null;
      continue;
    }

    if (c === '(') {
      i += 1;
      if (source[i] === '?') {
        i += 1;
        if (source[i] === ':' || source[i] === '=' || source[i] === '!') {
          i += 1;
        } else if (source[i] === '<') {
          i += 1;
          if (source[i] === '=' || source[i] === '!') {
            i += 1;
          } else {
            while (i < length && source[i] !== '>') i += 1;
            i += 1;
          }
        }
      }
      stack.push(top);
      top = emptyFrame();
      justClosed = null;
      continue;
    }

    if (c === ')') {
      const closed = top;
      top = stack.pop() ?? emptyFrame();
      // A quantifier anywhere inside a group counts as a quantifier inside
      // every group that encloses it, so `((a)+)+` is caught as surely as
      // `(a+)+` is.
      top.sawQuantifier ||= closed.sawQuantifier;
      top.sawUnboundedQuantifier ||= closed.sawUnboundedQuantifier;
      justClosed = closed;
      i += 1;
      continue;
    }

    const quantifier = quantifierAt(source, i);
    if (quantifier !== null) {
      if (
        justClosed !== null &&
        justClosed.sawQuantifier &&
        (quantifier.unbounded || justClosed.sawUnboundedQuantifier)
      ) {
        return true;
      }
      top.sawQuantifier = true;
      if (quantifier.unbounded) top.sawUnboundedQuantifier = true;
      justClosed = null;
      i = quantifier.end;
      continue;
    }

    justClosed = null;
    i += 1;
  }

  return false;
}

/**
 * How long one probe match may take before the pattern is refused.
 *
 * No benign regex takes 25 ms on a string this short; a real match is
 * microseconds. The probe escalates the input one character at a time, so the
 * step that trips this budget costs at most the previous step's cost times the
 * pattern's per-character growth factor, about 2 for the measured `^(a+)+$`
 * case. That overshoot is the price of finding out, and it is paid once at
 * compile rather than once per request for the life of a session.
 */
const PROBE_SINGLE_MATCH_BUDGET_MS = 25;

/**
 * A ceiling on the whole probe, for a pattern that is merely expensive
 * everywhere rather than catastrophic at one length. A benign pattern spends
 * well under a millisecond across the entire sweep.
 */
const PROBE_TOTAL_BUDGET_MS = 150;

/**
 * How many times a cycle is repeated at most, so at most 80 characters for a
 * two-character cycle. Past this the escalation has already found anything it
 * is going to find, because the cost of a runaway pattern is already minutes
 * by then.
 */
const PROBE_MAX_LENGTH = 40;

/** Most repeating units the probe will try. Keeps a pathological pattern's own alphabet from exploding the sweep. */
const PROBE_MAX_CYCLES = 40;

/**
 * The repeating units to build probe inputs out of.
 *
 * Catastrophic backtracking is provoked by a long run of something the
 * ambiguous repeat accepts, followed by something the tail rejects. Single
 * characters cover the common shapes: the defaults stand in for `\d`, `\w`,
 * `\s` and the punctuation URLs are made of, and the literals lifted out of
 * the pattern itself cover its own alphabet.
 *
 * Two-character cycles are here because single characters demonstrably are not
 * enough. `(ab|ba|a|b)+c$` has no nested quantifier, so the structural check
 * passes it, and it is linear on runs of one character, so a single-character
 * probe passes it too. Measured against alternating "abab...", it takes 380 ms
 * at 36 characters and 17.2 SECONDS at 44. Pairs are drawn only from the
 * pattern's own literals plus `a` and `0`, which is what keeps the sweep to
 * about a millisecond rather than paying for every combination of the
 * punctuation defaults.
 */
function probeCycles(source: string): string[] {
  const singles = ['a', '0', '/', '.', '-', ' '];
  const literals = ['a', '0'];
  for (const ch of source) {
    if (literals.length >= 8) break;
    if (!literals.includes(ch) && /[A-Za-z0-9_:%~=&?#-]/.test(ch)) {
      literals.push(ch);
      if (!singles.includes(ch)) singles.push(ch);
    }
  }
  const cycles = [...singles];
  for (let i = 0; i < literals.length && cycles.length < PROBE_MAX_CYCLES; i += 1) {
    for (let j = 0; j < literals.length && cycles.length < PROBE_MAX_CYCLES; j += 1) {
      if (i !== j) cycles.push(literals[i]! + literals[j]!);
    }
  }
  return cycles;
}

function timeOneMatch(pattern: RegExp, input: string): number {
  const started = process.hrtime.bigint();
  pattern.test(input);
  return Number(process.hrtime.bigint() - started) / 1e6;
}

/**
 * Runs the candidate against escalating adversarial inputs and reports the
 * first one that blows the budget, or null if none does.
 *
 * WHAT THIS DOES NOT COVER, stated plainly because a guard whose limits are
 * not written down is a guard nobody can reason about later: passing the probe
 * proves nothing in general. The probe only ever feeds the pattern a repeating
 * one or two character cycle. A pattern whose ambiguity needs a longer cycle,
 * or the specific shape of a real URL, is linear on everything the probe tries
 * and still backtracks catastrophically in production. Measured example, and
 * this one is accepted by both layers today: `(abc|cab|bca|a|b|c)+z$` takes
 * 16 ms against 37 characters of repeating "abc" and 534 ms against 46, and
 * keeps growing. Anything that gets through can still stall the daemon, once,
 * for as long as one match takes, because a running match cannot be
 * interrupted. `repeatsARepeat` above covers the common shapes
 * deterministically; this adds the ones with no nested quantifier at all,
 * `(a|a)+` and `(ab|ba|a|b)+c$` being the measured examples.
 *
 * The escalation is one character at a time rather than doubling, so the cost
 * of the step that trips the budget is multiplied by the pattern's growth
 * factor rather than squared. The single re-run exists because a 25 ms GC
 * pause on a busy daemon would otherwise refuse a perfectly good pattern once
 * in a while, and an intermittently rejected filter is worse to live with than
 * a marginally slower probe.
 */
function probePattern(pattern: RegExp): { input: string; ms: number } | null {
  let total = 0;
  for (const cycle of probeCycles(pattern.source)) {
    for (let n = 1; n <= PROBE_MAX_LENGTH; n += 1) {
      const run = cycle.repeat(n);
      // The bare run, for patterns that blow up while succeeding, and the run
      // followed by a space, for the far more common case where the blowup is
      // in a failing tail. A space is used because no URL contains one.
      for (const input of [run, `${run} `]) {
        let ms = timeOneMatch(pattern, input);
        total += ms;
        if (ms > PROBE_SINGLE_MATCH_BUDGET_MS) {
          ms = timeOneMatch(pattern, input);
          total += ms;
          if (ms > PROBE_SINGLE_MATCH_BUDGET_MS) return { input, ms };
        }
        if (total > PROBE_TOTAL_BUDGET_MS) return { input, ms };
      }
    }
  }
  return null;
}

/** The shared tail of every runaway refusal: why the daemon cares, and what to write instead. */
const runawayAdvice =
  'A regular expression cannot be interrupted once it has started, and this daemon is shared by every agent on ' +
  'the machine, so one such match freezes every other session, the health endpoint and the idle reaper along ' +
  'with your own call. Rewrite it so that no open-ended repeat (*, + or {n,}) sits inside another repeat: ' +
  '"(a+)+" is the same language as "a+", "(\\w+/)*" is usually meant as ".*/", and an alternation whose branches ' +
  'can match the same text, like "(a|a)+", wants the duplicate branch removed. urlIncludes takes a plain ' +
  'substring and is never refused.';

/**
 * Compiles one caller-supplied regex source, refusing patterns that could take
 * exponential time against a single URL.
 *
 * Exported so `add_route_rule` uses the same guard. Its `urlMatches` is handed
 * to Playwright's route matcher, which runs in this same process on every
 * intercepted request, so it stalls the event loop exactly the way a capture
 * filter does.
 */
export function compileUrlPattern(source: string, field: string): RegExp {
  let pattern: RegExp;
  try {
    pattern = new RegExp(source);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`${field} is not a valid regular expression: ${message}`);
  }

  if (repeatsARepeat(source)) {
    throw new Error(
      `${field} was refused as a runaway pattern: it applies a repetition to a group that already contains one, ` +
        'and that shape can take time exponential in the length of the URL it is matched against. Measured: ' +
        '"^(a+)+$" takes 1ms against 18 characters, 72ms against 24, and over two minutes against 34. ' +
        runawayAdvice
    );
  }

  const blowup = probePattern(pattern);
  if (blowup !== null) {
    throw new Error(
      `${field} was refused as a runaway pattern: one match against a probe string of ${blowup.input.length} ` +
        `characters took ${blowup.ms.toFixed(0)}ms, where a workable pattern takes microseconds. The cost of this ` +
        'shape grows multiplicatively with the length of the URL, so a slightly longer one would take minutes. ' +
        runawayAdvice
    );
  }

  return pattern;
}

/**
 * Every resource type Chromium can actually report, lowercased.
 *
 * Ground truth rather than memory: this is the complete image of
 * `toResourceType` in playwright-core
 * (packages/playwright-core/src/server/chromium/crNetworkManager.ts, bundled
 * into node_modules/playwright-core/lib/coreBundle.js), which maps the CDP
 * `Network.ResourceType` enum onto these strings and folds Prefetch,
 * SignedExchange, Preflight and FedCM into "other". Nothing outside this list
 * can ever appear on an entry, which is what makes refusing an unknown value
 * safe rather than merely opinionated. A future Playwright that adds one would
 * make this refuse a legitimate filter, which is a loud, greppable failure;
 * the alternative it replaces failed silently.
 */
export const networkResourceTypes = [
  'document',
  'stylesheet',
  'image',
  'media',
  'font',
  'script',
  'texttrack',
  'xhr',
  'fetch',
  'eventsource',
  'websocket',
  'manifest',
  'ping',
  'cspreport',
  'other'
] as const;

const resourceTypeSet = new Set<string>(networkResourceTypes);

/**
 * Compiles a caller's raw filter into criteria ready to test entries against.
 *
 * Both the read-time filter on `list_network_requests` and the capture-time
 * filter on a session go through this one function rather than each rolling
 * its own regex handling and case normalization. A second, subtly different
 * matcher between the two is exactly the kind of divergence that would let a
 * capture filter keep an entry a caller's own read filter then can't find, or
 * the other way round, which is its own silent false pass.
 *
 * That shared funnel is also why the runaway-regex guard lives here: all three
 * `urlMatches` entry points (create_session, set_network_capture_filter and
 * list_network_requests) reach the regex through this one call, so guarding it
 * here guards all three and cannot drift out of step between them.
 */
export function compileNetworkMatch(input: NetworkMatchInput): NetworkMatchCriteria {
  const urlMatches = input.urlMatches !== undefined ? compileUrlPattern(input.urlMatches, 'urlMatches') : undefined;

  let resourceType: string | undefined;
  if (input.resourceType !== undefined) {
    // Lowercased for the same reason `method` is uppercased. resourceType used
    // to be the ONE case-sensitive field here, so "XHR" quietly matched
    // nothing at all while "get" matched every GET. At read time that came
    // back as total: 400, returned: 0, dropped: 0, which this tool's own
    // description tells a caller means "the filter genuinely matched nothing
    // that is still there". The caller was told the traffic was not there.
    resourceType = input.resourceType.toLowerCase();
    if (!resourceTypeSet.has(resourceType)) {
      // Refused rather than left to match nothing. An unrecognized resource
      // type CANNOT match any entry, because the list above is Chromium's
      // whole vocabulary, so accepting it means accepting a filter that is
      // guaranteed to be wrong and saying so only by returning an empty
      // result, which reads exactly like a true negative. At capture time it
      // is worse still: the entries are never buffered, so there is nothing
      // left to re-read once the caller works out what happened.
      throw new Error(
        `resourceType "${input.resourceType}" is not one Chromium reports, so it could only ever match nothing. ` +
          `Use one of: ${networkResourceTypes.join(', ')}. A fetch() for an image URL is "fetch", not "image", ` +
          'and XMLHttpRequest is "xhr".'
      );
    }
  }

  return {
    urlIncludes: input.urlIncludes?.toLowerCase(),
    urlMatches,
    method: input.method?.toUpperCase(),
    resourceType,
    minStatus: input.minStatus,
    maxStatus: input.maxStatus,
    direction: input.direction
  };
}

/** Whether one buffered network entry satisfies a compiled filter. Every field given is ANDed. */
export function matchesNetworkEntry(entry: NetworkEntry, criteria: NetworkMatchCriteria): boolean {
  if (criteria.direction !== undefined && entry.direction !== criteria.direction) return false;
  if (criteria.urlIncludes !== undefined && !entry.url.toLowerCase().includes(criteria.urlIncludes)) return false;
  if (criteria.urlMatches !== undefined && !criteria.urlMatches.test(entry.url)) return false;
  if (criteria.method !== undefined && entry.method?.toUpperCase() !== criteria.method) return false;
  // Lowercased on both sides. Playwright already hands these over lowercased,
  // so the entry side is belt and braces against a future resource type
  // arriving in a different case, not a live difference today.
  if (criteria.resourceType !== undefined && entry.resourceType?.toLowerCase() !== criteria.resourceType) return false;
  if (criteria.minStatus !== undefined && !(entry.status !== undefined && entry.status >= criteria.minStatus)) {
    return false;
  }
  if (criteria.maxStatus !== undefined && !(entry.status !== undefined && entry.status <= criteria.maxStatus)) {
    return false;
  }
  return true;
}
