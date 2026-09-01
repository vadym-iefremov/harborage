import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';

import { BrowserManager } from '../src/daemon/browserManager.js';
import { createToolHandlers } from '../src/daemon/tools/handlers.js';
import { SessionStore } from '../src/daemon/sessions.js';
import { getFreePort } from './helpers.js';

/**
 * Round 2 QA finding C: `press_key` reports an ordinary success for a
 * platform-mismatched modifier chord (Control+a on macOS) even though it
 * selected nothing, because the browser has no accelerator bound to that
 * chord at all. Confirmed live on macOS before this fix; the expectations
 * below are derived from process.platform rather than hardcoded to darwin,
 * so this suite proves the same thing on whatever platform runs it.
 */
const FIXTURE_HTML = `<!doctype html>
<html>
<head></head>
<body>
  <input id="target" value="abcdef">
</body>
</html>`;

let server: Server;
let baseUrl: string;
let browserManager: BrowserManager;
let sessions: SessionStore;
let handlers: ReturnType<typeof createToolHandlers>;

before(async () => {
  server = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(FIXTURE_HTML);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}/`;

  browserManager = new BrowserManager(await getFreePort());
  sessions = new SessionStore(browserManager);
  handlers = createToolHandlers(sessions, {
    debugPort: await getFreePort(),
    screenshotCacheDir: '/dev/null/unused',
    screenshotCacheTtlMs: 1000
  });
});

after(async () => {
  await sessions.closeAll();
  await browserManager.close();
  await new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve())));
});

/** A fresh session already sitting on the fixture page. */
async function freshSession(): Promise<string> {
  const { sessionId } = await sessions.createSession();
  await handlers.navigate({ sessionId, url: baseUrl, settleMs: 0 });
  return sessionId;
}

/** The `structuredContent` of a tool result, typed loosely: these tests assert on individual fields. */
function payload(result: unknown): Record<string, unknown> {
  return (result as { structuredContent: Record<string, unknown> }).structuredContent;
}

/** Evaluates an expression in the session's tab and returns its value. */
async function evaluate<T>(sessionId: string, expression: string): Promise<T> {
  const result = await handlers.evaluate({ sessionId, expression });
  return payload(result).result as T;
}

/** The browser's own select-all modifier on this platform: Meta on macOS, Control everywhere else. */
const nativeModifier = process.platform === 'darwin' ? 'Meta' : 'Control';
/** The modifier that looks plausible but has no accelerator bound to it here. */
const otherModifier = nativeModifier === 'Meta' ? 'Control' : 'Meta';

/** Focuses #target and collapses its selection to an empty caret at position 0, so a real select-all is unambiguous. */
async function resetSelection(sessionId: string): Promise<void> {
  await evaluate(
    sessionId,
    "(() => { const el = document.getElementById('target'); el.focus(); el.setSelectionRange(0, 0); return true; })()"
  );
}

async function selectionOf(sessionId: string): Promise<[number, number]> {
  return evaluate<[number, number]>(
    sessionId,
    "(() => { const el = document.getElementById('target'); return [el.selectionStart, el.selectionEnd]; })()"
  );
}

test('press_key always reports the platform it ran on', async () => {
  const sessionId = await freshSession();
  const body = payload(await handlers.press_key({ sessionId, selector: '#target', key: 'a' }));
  assert.equal(body.platform, process.platform);
  await sessions.releaseSession(sessionId);
});

test(`press_key with ${nativeModifier}+a really selects all, and carries no platform note`, async () => {
  const sessionId = await freshSession();
  await resetSelection(sessionId);

  const body = payload(await handlers.press_key({ sessionId, selector: '#target', key: `${nativeModifier}+a` }));

  assert.deepEqual(await selectionOf(sessionId), [0, 6], 'this platform\'s own accelerator modifier must really select all 6 characters');
  assert.equal(body.note, undefined, 'the chord matches this platform\'s own accelerator, so nothing needs flagging');

  await sessions.releaseSession(sessionId);
});

test(`press_key with ${otherModifier}+a reports success but selects nothing, and says so`, async () => {
  const sessionId = await freshSession();
  await resetSelection(sessionId);

  const body = payload(await handlers.press_key({ sessionId, selector: '#target', key: `${otherModifier}+a` }));

  // This is the false pass finding C exists for: the call above did not
  // throw, "ok" in shape, yet the field's selection never moved.
  assert.deepEqual(await selectionOf(sessionId), [0, 0], 'the wrong-platform modifier must genuinely select nothing, reproducing the false pass');
  assert.equal(typeof body.note, 'string', 'a chord with no accelerator on this platform must be flagged');
  assert.match(String(body.note), new RegExp(otherModifier));
  assert.match(String(body.note), new RegExp(nativeModifier));
  assert.match(String(body.note), /ControlOrMeta/);

  await sessions.releaseSession(sessionId);
});

test('press_key with ControlOrMeta+a selects all on every platform, and carries no note', async () => {
  const sessionId = await freshSession();
  await resetSelection(sessionId);

  const body = payload(await handlers.press_key({ sessionId, selector: '#target', key: 'ControlOrMeta+a' }));

  assert.deepEqual(await selectionOf(sessionId), [0, 6], 'ControlOrMeta must resolve to this platform\'s real accelerator');
  assert.equal(body.note, undefined, 'the portable modifier is never the wrong one, so it must never be flagged');

  await sessions.releaseSession(sessionId);
});

test('press_key with a plain, unmodified key carries no platform note', async () => {
  const sessionId = await freshSession();
  const body = payload(await handlers.press_key({ sessionId, selector: '#target', key: 'a' }));
  assert.equal(body.note, undefined);
  await sessions.releaseSession(sessionId);
});

test('press_key with a non-accelerator chord (Shift+Tab) carries no platform note either', async () => {
  const sessionId = await freshSession();
  const body = payload(await handlers.press_key({ sessionId, key: 'Shift+Tab' }));
  assert.equal(body.note, undefined, 'Shift is not Control or Meta, so it is never what this note is about');
  await sessions.releaseSession(sessionId);
});
