import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createLogger, errorFields, formatLogLine, noopLogger } from '../src/shared/logger.js';

const isoAtStart = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z) /;

test('every line starts with a parseable ISO-8601 timestamp, then the harborage prefix and the event name', () => {
  const line = formatLogLine('session.create', { sessionId: 'abc', sessions: 3 });

  const match = isoAtStart.exec(line);
  assert.ok(match, `expected an ISO timestamp at the start of: ${line}`);
  const parsed = new Date(match![1]!);
  assert.ok(!Number.isNaN(parsed.getTime()), 'the leading timestamp must be a real, parseable date');
  assert.equal(parsed.toISOString(), match![1], 'the leading timestamp must round-trip as ISO-8601 UTC');

  assert.equal(line.slice(match![0].length), '[harborage] session.create sessionId=abc sessions=3');
});

test('the timestamp reflects when the line was written, and is close to now', () => {
  const before = Date.now();
  const line = formatLogLine('daemon.start');
  const after = Date.now();

  const stamp = new Date(isoAtStart.exec(line)![1]!).getTime();
  assert.ok(stamp >= before - 1 && stamp <= after + 1, `timestamp ${stamp} should sit between ${before} and ${after}`);
});

test('an event with no fields is just a timestamp, prefix and event name', () => {
  const line = formatLogLine('daemon.stop');
  assert.equal(line.replace(isoAtStart, ''), '[harborage] daemon.stop');
});

test('values containing spaces (or anything else awkward) are quoted, plain ones are not', () => {
  const line = formatLogLine('sweep.error', {
    reason: 'live sessions still open',
    plain: 'live-sessions',
    url: 'http://127.0.0.1:4599/mcp',
    empty: '',
    count: 0,
    flag: false
  });

  const body = line.replace(isoAtStart, '');
  assert.equal(
    body,
    '[harborage] sweep.error reason="live sessions still open" plain=live-sessions url=http://127.0.0.1:4599/mcp empty="" count=0 flag=false'
  );
});

test('an Error field is rendered as its message, not as an empty object', () => {
  const line = formatLogLine('sweep.error', { err: new Error('registry read failed') });
  assert.equal(line.replace(isoAtStart, ''), '[harborage] sweep.error err="registry read failed"');
});

test('undefined fields are omitted entirely rather than logged as undefined', () => {
  const line = formatLogLine('session.release', { sessionId: 'abc', pageId: undefined, sessions: 0 });
  assert.equal(line.replace(isoAtStart, ''), '[harborage] session.release sessionId=abc sessions=0');
});

test('createLogger emits exactly one line per event, with no embedded newline', () => {
  const lines: string[] = [];
  const logger = createLogger(line => lines.push(line));

  logger.log('session.create', { sessionId: 'one', sessions: 1 });
  logger.log('session.release', { sessionId: 'one', sessions: 0 });

  assert.equal(lines.length, 2);
  for (const line of lines) {
    assert.ok(!line.includes('\n'), `a log line must not contain a newline: ${JSON.stringify(line)}`);
    assert.ok(isoAtStart.test(line));
  }
  assert.ok(lines[0]!.endsWith('[harborage] session.create sessionId=one sessions=1'));
  assert.ok(lines[1]!.endsWith('[harborage] session.release sessionId=one sessions=0'));
});

test('the no-op logger swallows everything without throwing', () => {
  assert.doesNotThrow(() => noopLogger.log('session.create', { sessionId: 'x', sessions: 1 }));
});

test('errorFields carries the stack as well as the message, JSON-quoted onto the same line', () => {
  const err = new Error('context is closed');
  const line = formatLogLine('daemon.error', { phase: 'uncaught-exception', ...errorFields(err) });

  assert.ok(!line.includes('\n'), 'a stack must not break the one-event-per-line rule');
  assert.ok(line.includes('err="context is closed"'), line);
  assert.ok(line.includes('stack="Error: context is closed'), line);
});

test('errorFields on a thrown non-Error still logs the value and omits the stack', () => {
  const line = formatLogLine('daemon.error', errorFields('just a string'));
  assert.equal(line.replace(isoAtStart, ''), '[harborage] daemon.error err="just a string"');
});
