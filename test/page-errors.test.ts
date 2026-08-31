import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';

import { BrowserManager } from '../src/daemon/browserManager.js';
import { SessionStore, type PageErrorEntry } from '../src/daemon/sessions.js';
import { createToolHandlers, type ToolHandlers } from '../src/daemon/tools/handlers.js';
import { getFreePort } from './helpers.js';

let browserManager: BrowserManager;
let sessions: SessionStore;
let handlers: ToolHandlers;
let server: Server;
let base: string;

before(async () => {
  browserManager = new BrowserManager(await getFreePort());
  sessions = new SessionStore(browserManager, { pageError: 3 });
  handlers = createToolHandlers(sessions, {
    debugPort: 0,
    screenshotCacheDir: '/dev/null/unused',
    screenshotCacheTtlMs: 1000
  });
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><body><h1>page errors</h1></body></html>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/`;
});

after(async () => {
  await sessions.closeAll();
  await browserManager.close();
  await new Promise<void>(resolve => server.close(() => resolve()));
});

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function openSession(): Promise<string> {
  const created = await handlers.create_session({});
  const { sessionId } = created.structuredContent as { sessionId: string };
  await handlers.navigate({ sessionId, url: base });
  return sessionId;
}

async function errorsOf(sessionId: string, args: Record<string, unknown> = {}): Promise<PageErrorEntry[]> {
  // Page errors arrive asynchronously from the page's own task queue.
  await sleep(300);
  const read = await handlers.read_page_errors({ sessionId, ...args });
  return (read.structuredContent as { errors: PageErrorEntry[] }).errors;
}

test('an uncaught exception is captured with its message and its stack', async () => {
  const sessionId = await openSession();
  await handlers.evaluate({
    sessionId,
    expression: 'setTimeout(() => { throw new Error("uncaught boom"); }, 0), "queued"'
  });

  const errors = await errorsOf(sessionId);
  assert.equal(errors.length, 1, `expected exactly one error, got ${JSON.stringify(errors)}`);
  assert.equal(errors[0]?.type, 'uncaught-exception');
  assert.equal(errors[0]?.message, 'uncaught boom');
  assert.ok(errors[0]?.stack, 'a bare message with no stack is what made this class of bug hard to chase');
  assert.match(errors[0].stack, /uncaught boom/);

  await handlers.release_session({ sessionId });
});

test('an unhandled promise rejection is captured exactly once, as its own type', async () => {
  const sessionId = await openSession();
  await handlers.evaluate({ sessionId, expression: 'Promise.reject(new Error("rejected boom")), "queued"' });

  const errors = await errorsOf(sessionId);
  assert.equal(errors.length, 1, `a rejection must not be recorded twice, got ${JSON.stringify(errors)}`);
  assert.equal(errors[0]?.type, 'unhandled-rejection');
  assert.equal(errors[0]?.message, 'rejected boom');
  assert.ok(errors[0]?.stack);

  await handlers.release_session({ sessionId });
});

test('a rejection with a non-Error value carries more than "[object Event]"', async () => {
  const sessionId = await openSession();
  await handlers.evaluate({ sessionId, expression: 'Promise.reject(new Event("error")), "queued"' });

  const errors = await errorsOf(sessionId);
  assert.equal(errors.length, 1);
  const entry = errors[0]!;
  assert.equal(entry.type, 'unhandled-rejection');
  // The whole point: "[object Event]" alone is not chaseable.
  assert.equal(entry.valueType, 'Event', 'the rejected value\'s constructor is the missing clue');
  assert.equal(entry.eventType, 'error', 'for an Event, its type is what identifies which one it was');
  assert.ok(entry.detail, 'a serialized dump of the value should be there when there is no stack');

  await handlers.release_session({ sessionId });
});

test('page errors are a separate channel: they do not show up in read_console', async () => {
  const sessionId = await openSession();
  await handlers.evaluate({
    sessionId,
    expression: 'console.log("an ordinary log"), setTimeout(() => { throw new Error("separate channel"); }, 0), "queued"'
  });

  const errors = await errorsOf(sessionId);
  assert.equal(errors.length, 1);

  const console = await handlers.read_console({ sessionId });
  const messages = (console.structuredContent as { messages: { text: string }[] }).messages;
  assert.ok(messages.some(m => m.text.includes('an ordinary log')));
  assert.ok(
    !messages.some(m => m.text.includes('separate channel')),
    'an uncaught exception is not a console message and must not be filed as one'
  );

  await handlers.release_session({ sessionId });
});

test('a tab opened through new_tab buffers its own page errors, filterable by pageId', async () => {
  const sessionId = await openSession();
  const opened = await handlers.new_tab({ sessionId, url: base });
  const { pageId } = opened.structuredContent as { pageId: string };

  await handlers.evaluate({ sessionId, pageId, expression: 'Promise.reject(new Error("in the new tab")), "queued"' });

  const forTab = await errorsOf(sessionId, { pageId });
  assert.equal(forTab.length, 1, 'a tab opened after session creation must be buffered too');
  assert.equal(forTab[0]?.pageId, pageId);
  assert.equal(forTab[0]?.message, 'in the new tab');

  await handlers.release_session({ sessionId });
});

test('the page-error buffer is bounded, dropping the oldest first', async () => {
  const sessionId = await openSession();
  for (let i = 1; i <= 5; i++) {
    await handlers.evaluate({
      sessionId,
      expression: `setTimeout(() => { throw new Error("error ${i}"); }, 0), "queued"`
    });
    await sleep(120);
  }

  const errors = await errorsOf(sessionId);
  assert.equal(errors.length, 3, 'the buffer was configured to hold three');
  assert.deepEqual(
    errors.map(e => e.message),
    ['error 3', 'error 4', 'error 5'],
    'the oldest entries should be the ones dropped'
  );

  await handlers.release_session({ sessionId });
});
