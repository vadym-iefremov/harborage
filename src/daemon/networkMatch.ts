import type { NetworkEntry } from './sessions.js';

/**
 * A network filter exactly as a caller writes it: an unparsed regex source
 * for urlMatches, mixed-case strings for urlIncludes and method.
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

/**
 * Compiles a caller's raw filter into criteria ready to test entries against.
 *
 * Both the read-time filter on `list_network_requests` and the capture-time
 * filter on a session go through this one function rather than each rolling
 * its own regex handling and case normalization. A second, subtly different
 * matcher between the two is exactly the kind of divergence that would let a
 * capture filter keep an entry a caller's own read filter then can't find, or
 * the other way round, which is its own silent false pass.
 */
export function compileNetworkMatch(input: NetworkMatchInput): NetworkMatchCriteria {
  let urlMatches: RegExp | undefined;
  if (input.urlMatches !== undefined) {
    try {
      urlMatches = new RegExp(input.urlMatches);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`urlMatches is not a valid regular expression: ${message}`);
    }
  }
  return {
    urlIncludes: input.urlIncludes?.toLowerCase(),
    urlMatches,
    method: input.method?.toUpperCase(),
    resourceType: input.resourceType,
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
  if (criteria.resourceType !== undefined && entry.resourceType !== criteria.resourceType) return false;
  if (criteria.minStatus !== undefined && !(entry.status !== undefined && entry.status >= criteria.minStatus)) {
    return false;
  }
  if (criteria.maxStatus !== undefined && !(entry.status !== undefined && entry.status <= criteria.maxStatus)) {
    return false;
  }
  return true;
}
