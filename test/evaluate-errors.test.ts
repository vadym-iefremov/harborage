import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { BrowserManager } from '../src/daemon/browserManager.js';
import { SessionStore } from '../src/daemon/sessions.js';
import { createToolHandlers } from '../src/daemon/tools/handlers.js';
import { getFreePort } from './helpers.js';

let browserManager: BrowserManager;
let sessions: SessionStore;
let handlers: ReturnType<typeof createToolHandlers>;
let sessionId: string;

interface EvalFailure {
  error: string;
  line?: number;
  column?: number;
  positionKnown: boolean;
  expression: string;
  timedOut?: boolean;
  timeoutMs?: number;
}

function structured<T>(result: unknown): T {
  return (result as { structuredContent: T }).structuredContent;
}

function textOf(result: unknown): string {
  return (result as { content: { type: string; text?: string }[] }).content
    .filter(b => b.type === 'text')
    .map(b => b.text ?? '')
    .join('\n');
}

function isError(result: unknown): boolean {
  return (result as { isError?: boolean }).isError === true;
}

before(async () => {
  const debugPort = await getFreePort();
  browserManager = new BrowserManager(debugPort);
  sessions = new SessionStore(browserManager);
  handlers = createToolHandlers(sessions, {
    debugPort,
    screenshotCacheDir: '/dev/null/unused',
    screenshotCacheTtlMs: 1000
  });
  ({ sessionId } = await sessions.createSession());
  await sessions.resolve(sessionId).page.goto('data:text/html,<h1 id="title">evaluate probe</h1>');
});

after(async () => {
  await sessions.closeAll();
  await browserManager.close();
});

test('a fault in a multi-line expression is reported against the line it happened on, with the source echoed', async () => {
  const expression = ['(() => {', '  const a = 1;', '  const b = 2;', '  return a.b.c.d;', '})()'].join('\n');

  const result = await handlers.evaluate({ sessionId, expression });
  const payload = structured<EvalFailure>(result);

  assert.ok(isError(result), 'a thrown expression must come back flagged as an error');
  assert.equal(payload.positionKnown, true);
  assert.equal(payload.line, 4);
  assert.equal(payload.column, 14);
  assert.match(payload.error, /TypeError/);

  const rendered = textOf(result);
  // Every line of the submitted source is echoed, numbered.
  assert.match(rendered, /1 \| \(\(\) => \{/);
  assert.match(rendered, /5 \| \}\)\(\)/);
  // The offending line is marked, and a caret points into it.
  assert.match(rendered, /> +4 \|   return a\.b\.c\.d;/);
  assert.match(rendered, /\^/);
  assert.match(rendered, /line 4/);
});

test('leading blank lines are trimmed before evaluation, so the echoed source is the source the numbers refer to', async () => {
  // Playwright trims the expression before evaluating it, which shifts every
  // line number. Echoing the trimmed text is what keeps the number honest.
  const result = await handlers.evaluate({ sessionId, expression: '\n\n// a note\nnull.boom' });
  const payload = structured<EvalFailure>(result);

  assert.ok(isError(result));
  assert.equal(payload.positionKnown, true);
  assert.equal(payload.line, 2);
  assert.equal(payload.expression, '// a note\nnull.boom');
  assert.match(textOf(result), /> +2 \| null\.boom/);
});

test('a syntax error still echoes the numbered source, and does not invent a position', async () => {
  const result = await handlers.evaluate({ sessionId, expression: '{ a: 1, b: 2 }' });
  const payload = structured<EvalFailure>(result);

  assert.ok(isError(result));
  assert.match(payload.error, /SyntaxError/);
  assert.equal(payload.positionKnown, false);
  assert.equal(payload.line, undefined);
  assert.match(textOf(result), /1 \| \{ a: 1, b: 2 \}/);
  assert.match(textOf(result), /no (source )?position/i);
});

test('a fault inside a helper defined in the expression points at the helper, not the call site', async () => {
  const expression = [
    '(() => {',
    '  const helper = () => { throw new TypeError("deep"); };',
    '  return helper();',
    '})()'
  ].join('\n');

  const payload = structured<EvalFailure>(await handlers.evaluate({ sessionId, expression }));
  assert.equal(payload.line, 2, 'the innermost frame is the useful one');
});

test('multi-line statements, an awaited async IIFE and DOM access all work, and are documented as working', async () => {
  const statements = structured<{ result: unknown }>(
    await handlers.evaluate({ sessionId, expression: 'const a = 2;\nconst b = 40;\na + b;' })
  );
  assert.equal(statements.result, 42);

  const asyncIife = structured<{ result: unknown }>(
    await handlers.evaluate({
      sessionId,
      expression: '(async () => {\n  const v = await Promise.resolve(41);\n  return v + 1;\n})()'
    })
  );
  assert.equal(asyncIife.result, 42);

  const dom = structured<{ result: unknown }>(
    await handlers.evaluate({ sessionId, expression: 'document.getElementById("title").textContent' })
  );
  assert.equal(dom.result, 'evaluate probe');
});

test('a bare function expression is evaluated, not called, which is the trap the description has to warn about', async () => {
  const payload = structured<{ result: unknown }>(await handlers.evaluate({ sessionId, expression: '() => 42' }));
  assert.equal(payload.result, undefined, 'a function-shaped string comes back as an unserializable function value');
});

test('an expression that never settles is bounded by timeoutMs instead of hanging the tool call', async () => {
  const started = Date.now();
  const result = await handlers.evaluate({ sessionId, expression: 'new Promise(() => {})', timeoutMs: 400 });
  const elapsed = Date.now() - started;
  const payload = structured<EvalFailure>(result);

  assert.ok(isError(result));
  assert.equal(payload.timedOut, true);
  assert.equal(payload.timeoutMs, 400);
  assert.ok(elapsed < 5000, `expected the call to give up promptly, waited ${elapsed}ms`);
  // The error says what it was waiting on and for how long.
  assert.match(textOf(result), /400/);
  assert.match(textOf(result), /new Promise/);

  // The session is still usable afterwards: the abandoned evaluation must not
  // wedge the tab or leak an unhandled rejection into the daemon.
  const after = structured<{ result: unknown }>(await handlers.evaluate({ sessionId, expression: '1 + 1' }));
  assert.equal(after.result, 2);
});

test('a fast expression is unaffected by a generous timeout', async () => {
  const payload = structured<{ result: unknown }>(
    await handlers.evaluate({ sessionId, expression: '"quick"', timeoutMs: 10_000 })
  );
  assert.equal(payload.result, 'quick');
});
