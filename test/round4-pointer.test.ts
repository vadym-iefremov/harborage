import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';

import { BrowserManager } from '../src/daemon/browserManager.js';
import { createToolHandlers } from '../src/daemon/tools/handlers.js';
import { SessionStore } from '../src/daemon/sessions.js';
import { getFreePort } from './helpers.js';

/**
 * Modifier leaks in drag and wheel, checked against the page rather than against the tool.
 *
 * Both tools hold modifier keys down for the duration of a gesture and release them in a
 * `finally`. The acquisition used to sit OUTSIDE that `try`, so a modifier list that threw
 * partway through (Playwright rejects an unknown key name) left every modifier already
 * pressed stuck down for the rest of the session. Nothing surfaced it: the tool call itself
 * failed loudly, and then every later key press and click in that session silently carried a
 * modifier nobody asked for.
 *
 * The oracle here is the PAGE'S OWN VIEW of a later, ordinary event, never the tool's word.
 * After a gesture, the fixture's capturing keydown listener records ctrlKey/shiftKey/metaKey/
 * altKey exactly as the browser delivered them, and a stuck modifier shows up there whatever
 * the tool reported and whatever `keyboard.up` was or was not called with. Asserting that the
 * call threw, or that a release was attempted, would prove nothing about the browser's actual
 * modifier state, which is the only thing that affects the next caller.
 */
const KEY_ORACLE_HTML = `<!doctype html>
<html>
<body style="margin:0">
  <div id="pad" style="position:absolute;left:20px;top:20px;width:400px;height:260px;background:rgb(230,230,240)"></div>
  <div id="scroller" style="position:absolute;left:20px;top:300px;width:320px;height:160px;overflow:auto;background:rgb(240,235,225)">
    <div style="height:1600px">tall</div>
  </div>
<script>
  // Capturing, on the document, so it fires for a key sent to whatever happens to have focus
  // after a gesture, including the body.
  window.__hbKeys = [];
  document.addEventListener('keydown', function (e) {
    window.__hbKeys.push({
      key: e.key,
      ctrlKey: e.ctrlKey,
      shiftKey: e.shiftKey,
      metaKey: e.metaKey,
      altKey: e.altKey
    });
  }, true);

  // The same question asked of a pointer event and a wheel event, so a "fix" that simply
  // stopped pressing modifiers at all would fail these rather than pass them.
  window.__hbPointer = [];
  document.addEventListener('pointerdown', function (e) {
    window.__hbPointer.push({ ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey });
  }, true);

  window.__hbWheel = [];
  document.addEventListener('wheel', function (e) {
    window.__hbWheel.push({ ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey });
  }, true);
</script>
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
    res.end(KEY_ORACLE_HTML);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;

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

function payload(result: unknown): Record<string, any> {
  return (result as { structuredContent: Record<string, any> }).structuredContent;
}

async function evaluate<T>(sessionId: string, expression: string): Promise<T> {
  const result = await handlers.evaluate({ sessionId, expression });
  return payload(result).result as T;
}

/** A fresh session, so a modifier stuck by one case can never be inherited by another. */
async function sessionOnFixture(): Promise<string> {
  const { sessionId } = await sessions.createSession();
  await handlers.navigate({ sessionId, url: baseUrl });
  return sessionId;
}

interface KeyRecord {
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}

/**
 * The oracle.
 *
 * Clears the fixture's log so the modifier key presses the gesture itself made cannot be
 * mistaken for the probe, then sends one ordinary key through the normal press_key path and
 * returns what the PAGE saw arrive. Any modifier flag set here is a modifier the browser
 * still had held down, which is the whole failure: it is invisible from the tool's own result
 * and it changes the meaning of every later key press and click in the session.
 */
async function probeHeldModifiers(sessionId: string): Promise<KeyRecord> {
  await evaluate(sessionId, 'window.__hbKeys = [], "ok"');
  await handlers.press_key({ sessionId, key: 'a' });
  const seen = await evaluate<KeyRecord[]>(sessionId, 'window.__hbKeys');
  assert.equal(seen.length, 1, `expected exactly one keydown from the probe, saw ${JSON.stringify(seen)}`);
  return seen[0];
}

function assertNothingHeld(seen: KeyRecord, what: string): void {
  const held = (['ctrlKey', 'shiftKey', 'metaKey', 'altKey'] as const).filter(flag => seen[flag]);
  assert.deepEqual(
    held,
    [],
    `${what}: the page saw a later, unrelated key press arrive with ${held.join(' and ')} set, so ` +
      `${held.length === 1 ? 'that modifier is' : 'those modifiers are'} still held down in the browser. ` +
      `The event was ${JSON.stringify(seen)}.`
  );
  // A held Shift also rewrites the key itself, so this is a second, independent read of the
  // same state that does not depend on the flags being reported correctly.
  assert.equal(seen.key, 'a', `${what}: the probe key arrived as ${JSON.stringify(seen.key)} rather than "a"`);
}

/**
 * A modifier list whose first entry is real and whose second one Playwright rejects.
 *
 * Deliberately routed past the zod enum, which the MCP layer applies and these handlers do
 * not: the point is to make `keyboard.down` reject on the SECOND element with the first one
 * already pressed, which is the exact partial-failure shape. Playwright throws
 * `Unknown key: "NotARealKeyName"` for a multi-character name it does not know, with no
 * browser round trip involved, so this is deterministic rather than timing-dependent.
 */
const partiallyValidModifiers = ['Shift', 'NotARealKeyName'] as unknown as ('Shift' | 'Control' | 'Alt' | 'Meta')[];
const partiallyValidCtrlModifiers = ['Control', 'NotARealKeyName'] as unknown as (
  | 'Shift'
  | 'Control'
  | 'Alt'
  | 'Meta'
)[];

test('drag releases a modifier it managed to press even when a later one throws', async () => {
  const sessionId = await sessionOnFixture();

  await assert.rejects(
    () =>
      handlers.drag({
        sessionId,
        source: { x: 60, y: 60 },
        target: { x: 300, y: 200 },
        modifiers: partiallyValidModifiers
      }),
    /Unknown key/,
    'the invalid modifier should still fail the call loudly'
  );

  assertNothingHeld(await probeHeldModifiers(sessionId), 'drag with a modifier list that threw partway');
});

test('wheel releases a modifier it managed to press even when a later one throws', async () => {
  const sessionId = await sessionOnFixture();

  await assert.rejects(
    () =>
      handlers.wheel({
        sessionId,
        point: { x: 100, y: 360 },
        deltaY: 120,
        modifiers: partiallyValidCtrlModifiers
      }),
    /Unknown key/,
    'the invalid modifier should still fail the call loudly'
  );

  assertNothingHeld(await probeHeldModifiers(sessionId), 'wheel with a modifier list that threw partway');
});

test('drag still holds its modifiers for the gesture and releases them afterwards', async () => {
  const sessionId = await sessionOnFixture();
  await evaluate(sessionId, 'window.__hbPointer = [], "ok"');

  await handlers.drag({
    sessionId,
    source: { x: 60, y: 60 },
    target: { x: 300, y: 200 },
    modifiers: ['Shift', 'Alt']
  });

  // Proves the modifiers were genuinely applied, so a fix that released correctly by never
  // pressing anything could not pass this file.
  const pressed = await evaluate<{ shiftKey: boolean; altKey: boolean }[]>(sessionId, 'window.__hbPointer');
  assert.equal(pressed.length, 1, `expected one pointerdown, saw ${JSON.stringify(pressed)}`);
  assert.equal(pressed[0].shiftKey, true, 'the page should have seen the press with Shift held');
  assert.equal(pressed[0].altKey, true, 'the page should have seen the press with Alt held');

  assertNothingHeld(await probeHeldModifiers(sessionId), 'drag with a modifier list that succeeded');
});

test('wheel still holds its modifiers for the gesture and releases them afterwards', async () => {
  const sessionId = await sessionOnFixture();
  await evaluate(sessionId, 'window.__hbWheel = [], "ok"');

  await handlers.wheel({
    sessionId,
    point: { x: 100, y: 360 },
    deltaY: 120,
    modifiers: ['Control', 'Shift']
  });

  // The ctrlKey on a wheel event is the whole reason wheel takes modifiers: it is what a
  // trackpad pinch looks like to a page. If it never reached the page, the release below
  // would be trivially satisfied and would prove nothing.
  const turned = await evaluate<{ ctrlKey: boolean; shiftKey: boolean }[]>(sessionId, 'window.__hbWheel');
  assert.ok(turned.length >= 1, `expected at least one wheel event, saw ${JSON.stringify(turned)}`);
  assert.equal(turned[0].ctrlKey, true, 'the page should have seen the wheel with Control held');
  assert.equal(turned[0].shiftKey, true, 'the page should have seen the wheel with Shift held');

  assertNothingHeld(await probeHeldModifiers(sessionId), 'wheel with a modifier list that succeeded');
});
