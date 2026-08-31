/**
 * A deliberately tiny structured logger: one line per event, written to
 * stderr.
 *
 * Why this exists at all: the daemon's log over a whole working evening
 * used to hold nothing but alternating "listening" / "shutting down" lines
 * with no timestamps, which made it impossible to correlate a subagent
 * reporting "my session died" with anything the daemon actually did. The
 * two properties that fix that are a timestamp on every line and an event
 * for every session lifecycle transition, so both are non-optional here.
 *
 * Why stderr rather than a file handle of our own: the client wrapper
 * already redirects the detached daemon's stdout/stderr into
 * `~/.harborage/daemon.log` when it spawns it (see `client/daemonManager`).
 * Opening a second writer onto the same file from inside the daemon would
 * mean two independent append streams and interleaved half-lines.
 *
 * Why no log levels: nothing in the daemon currently wants to filter by
 * severity, and the event name (`sweep.error`, `session.create`) already
 * carries that distinction where it matters. A level system would be
 * machinery with no reader.
 */

/** Structured key/value payload for one event. `undefined` values are dropped, not logged. */
export type LogFields = Record<string, unknown>;

export interface Logger {
  /** Writes one line: timestamp, `[harborage]`, the dotted event name, then `key=value` pairs. */
  log(event: string, fields?: LogFields): void;
}

/**
 * Values matching this are emitted bare. Anything else gets JSON-quoted, so
 * a value containing a space can never be mistaken for the start of the
 * next `key=value` pair by whoever is reading (or grepping) the log.
 */
const bareValue = /^[\w./:@+-]+$/;

function quote(raw: string): string {
  return bareValue.test(raw) ? raw : JSON.stringify(raw);
}

function formatValue(value: unknown): string {
  // An Error's own enumerable properties are empty, so JSON.stringify would
  // render the single most useful field in the whole log as `{}`.
  if (value instanceof Error) return quote(value.message);
  if (typeof value === 'string') return quote(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return String(value);
  return quote(JSON.stringify(value) ?? String(value));
}

/**
 * Builds one log line. Exported separately from `Logger` so tests can assert
 * on the exact shape without capturing a stream.
 */
export function formatLogLine(event: string, fields: LogFields = {}): string {
  let line = `${new Date().toISOString()} [harborage] ${event}`;
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    line += ` ${key}=${formatValue(value)}`;
  }
  return line;
}

/**
 * A logger that hands each finished line to `write`, without a trailing
 * newline. Tests inject a collector here; the daemon injects stderr.
 */
export function createLogger(write: (line: string) => void): Logger {
  return {
    log(event, fields) {
      write(formatLogLine(event, fields));
    }
  };
}

/** The real daemon logger: one line per event on stderr, which the client wrapper redirects to `daemon.log`. */
export function createStderrLogger(): Logger {
  return createLogger(line => {
    process.stderr.write(`${line}\n`);
  });
}

/**
 * The fields worth logging about a thrown value. Split out because the
 * message alone is rarely enough to fix a daemon-side failure, and the
 * stack, JSON-quoted onto the same line, is the difference between a log
 * that says something broke and a log that says where.
 */
export function errorFields(err: unknown): LogFields {
  return { err, stack: err instanceof Error ? err.stack : undefined };
}

/**
 * Default for call sites that have no logger to inject, notably tests that
 * construct a `SessionStore` directly and do not care about its output.
 */
export const noopLogger: Logger = { log: () => {} };
