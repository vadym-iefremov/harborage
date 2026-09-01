import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';

import { BrowserManager } from '../src/daemon/browserManager.js';
import { createToolHandlers } from '../src/daemon/tools/handlers.js';
import { SessionStore } from '../src/daemon/sessions.js';
import { getFreePort } from './helpers.js';

/**
 * A fixture page with the things a synthetic DOM stub cannot fake: a rich
 * editor that intercepts `beforeinput` the way CodeMirror and Monaco do, a
 * CSS-only `:hover` rule with no JS listener behind it, a focus-ring probe
 * that depends on real keyboard modality, and per-event recorders. Every one
 * of these exists because a QA agent's workaround could not observe it.
 */
const FIXTURE_HTML = `<!doctype html>
<html>
<head>
<style>
  #hoverTarget { width: 120px; height: 40px; background: rgb(0, 0, 255); }
  /* No JS listener at all: only a genuine pointer hover can turn this red. */
  #hoverTarget:hover { background: rgb(255, 0, 0); }
  #clickPad { width: 200px; height: 200px; background: rgb(238, 238, 238); }
</style>
</head>
<body>
  <p id="outside">OUTSIDE TEXT</p>
  <button id="b1">one</button>
  <button id="b2">two</button>
  <input id="plainInput" value="">
  <input id="shoutingInput" value="">
  <textarea id="plainArea"></textarea>
  <div id="editor" contenteditable="true">result</div>
  <div id="hoverTarget"></div>
  <div id="clickPad"></div>
  <div id="lateBloomer" style="display:none">not yet</div>
<script>
  window.__events = [];
  window.__inputEvents = 0;

  // CodeMirror/Monaco in miniature: it takes over insertion itself and writes
  // from its own cursor, ignoring a selection that was installed behind its
  // back. That is exactly why a plain fill appended rather than replaced.
  // A real key press still reaches it as a real key press, so native deletion
  // is deliberately left alone.
  var editor = document.getElementById('editor');
  editor.addEventListener('beforeinput', function (e) {
    if (e.inputType && e.inputType.indexOf('insert') === 0) {
      e.preventDefault();
      var t = e.data != null ? e.data : (e.dataTransfer ? e.dataTransfer.getData('text/plain') : '');
      var sel = window.getSelection();
      var range = sel.getRangeAt(0);
      range.insertNode(document.createTextNode(t));
      range.collapse(false);
    }
  });

  var pad = document.getElementById('clickPad');
  pad.addEventListener('mousedown', function (e) {
    window.__events.push({ kind: 'mousedown', x: e.offsetX, y: e.offsetY, button: e.button });
  });
  pad.addEventListener('click', function (e) {
    window.__events.push({ kind: 'click', x: e.offsetX, y: e.offsetY, detail: e.detail });
  });
  pad.addEventListener('contextmenu', function (e) { e.preventDefault(); });

  document.getElementById('plainInput').addEventListener('input', function () {
    window.__inputEvents++;
  });

  // A field that rewrites what it is given, so a readback that merely echoed
  // the request back would look identical to a readback that is real.
  var shouting = document.getElementById('shoutingInput');
  shouting.addEventListener('input', function () {
    shouting.value = shouting.value.toUpperCase();
  });
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

// ---------------------------------------------------------------------------
// P0-1: same-document navigation
// ---------------------------------------------------------------------------

test('navigate to a hash-only URL leaves the JS context alive and says so in its result', async () => {
  const sessionId = await freshSession();

  await evaluate(sessionId, 'window.__qaMarker = "alive"');

  const result = await handlers.navigate({ sessionId, url: `${baseUrl}#/settings`, settleMs: 0 });
  const body = payload(result);

  // The trap: the marker surviving means React state, timers and the console
  // buffer survived too, while the payload used to look exactly like a load.
  const marker = await evaluate<string | undefined>(sessionId, 'window.__qaMarker');
  assert.equal(marker, 'alive', 'a hash-only navigation really does keep the JS context: the fixture must reproduce that');

  assert.equal(body.sameDocument, true, 'navigate must report a same-document navigation explicitly, not return a payload identical to a real load');
  assert.equal(typeof body.note, 'string', 'a same-document navigation must carry a plain-language note');
  assert.match(String(body.note), /reload/i, 'the note must point the caller at the reload tool');
  assert.equal(body.url, `${baseUrl}#/settings`);

  const navType = await evaluate<string>(sessionId, "performance.getEntriesByType('navigation')[0].type");
  assert.equal(navType, 'navigate', 'no reload happened, so the original navigation entry is still the current one');

  await sessions.releaseSession(sessionId);
});

test('navigate to a different document reports sameDocument false, present rather than absent', async () => {
  const sessionId = await freshSession();
  await evaluate(sessionId, 'window.__qaMarker = "alive"');

  const body = payload(await handlers.navigate({ sessionId, url: `${baseUrl}?second`, settleMs: 0 }));

  assert.equal(body.sameDocument, false, 'the field must be present in the false case so its absence can never be read as false');
  assert.ok(!('note' in body) || body.note === undefined, 'a real load needs no same-document warning');
  const marker = await evaluate<string | undefined>(sessionId, 'window.__qaMarker');
  assert.equal(marker, undefined, 'a real document load discards the JS context');

  await sessions.releaseSession(sessionId);
});

test('navigate to about:blank is a real document change, not a same-document navigation', async () => {
  // page.goto() returns null here too, so response === null on its own would
  // mislabel this one.
  const sessionId = await freshSession();
  const body = payload(await handlers.navigate({ sessionId, url: 'about:blank', settleMs: 0 }));
  assert.equal(body.sameDocument, false);
  await sessions.releaseSession(sessionId);
});

test('reload genuinely discards the JS context', async () => {
  const sessionId = await freshSession();
  await evaluate(sessionId, 'window.__qaMarker = "alive"');

  const body = payload(await handlers.reload({ sessionId, settleMs: 0 }));
  assert.equal(body.url, baseUrl);

  const marker = await evaluate<string | undefined>(sessionId, 'window.__qaMarker');
  assert.equal(marker, undefined, 'reload must discard the JS context');

  const navType = await evaluate<string>(sessionId, "performance.getEntriesByType('navigation')[0].type");
  assert.equal(navType, 'reload', 'the browser itself must classify this as a reload');

  await sessions.releaseSession(sessionId);
});

test('reload after a hash navigation is what forces the real load the hash did not', async () => {
  const sessionId = await freshSession();
  await evaluate(sessionId, 'window.__qaMarker = "alive"');
  await handlers.navigate({ sessionId, url: `${baseUrl}#/settings`, settleMs: 0 });
  assert.equal(await evaluate(sessionId, 'window.__qaMarker'), 'alive');

  await handlers.reload({ sessionId, settleMs: 0 });
  assert.equal(await evaluate(sessionId, 'window.__qaMarker'), undefined);
  assert.equal(await evaluate(sessionId, 'location.hash'), '#/settings', 'reload keeps the hash, it just reloads the document');

  await sessions.releaseSession(sessionId);
});

// ---------------------------------------------------------------------------
// P0-2: fill replaces, and reads back
// ---------------------------------------------------------------------------

test('fill replaces a rich editor\'s contents instead of inserting into them', async () => {
  const sessionId = await freshSession();

  const body = payload(await handlers.fill({ sessionId, selector: '#editor', value: '{{ $json.mode }}' }));

  const actual = await evaluate<string>(sessionId, "document.getElementById('editor').textContent");
  assert.equal(actual, '{{ $json.mode }}', 'fill must replace, not concatenate onto the existing value');
  assert.equal(body.value, '{{ $json.mode }}', 'fill must return what the field actually contains afterwards');
  assert.equal(body.matched, true);

  const outside = await evaluate<string>(sessionId, "document.getElementById('outside').textContent");
  assert.equal(outside, 'OUTSIDE TEXT', 'select-all must stay scoped to the editor, not eat the page');

  await sessions.releaseSession(sessionId);
});

test('fill can empty a rich editor', async () => {
  const sessionId = await freshSession();
  const body = payload(await handlers.fill({ sessionId, selector: '#editor', value: '' }));
  assert.equal(body.value, '');
  assert.equal(body.matched, true);
  assert.equal(await evaluate(sessionId, "document.getElementById('editor').textContent"), '');
  await sessions.releaseSession(sessionId);
});

test('fill still replaces plain form controls atomically', async () => {
  const sessionId = await freshSession();

  await handlers.fill({ sessionId, selector: '#plainInput', value: 'first' });
  const body = payload(await handlers.fill({ sessionId, selector: '#plainInput', value: 'second' }));

  assert.equal(body.value, 'second');
  assert.equal(body.matched, true);
  assert.equal(await evaluate(sessionId, "document.getElementById('plainInput').value"), 'second');

  const areaBody = payload(await handlers.fill({ sessionId, selector: '#plainArea', value: 'line one' }));
  assert.equal(areaBody.value, 'line one');

  await sessions.releaseSession(sessionId);
});

test('fill says so when the page rewrote what was written', async () => {
  const sessionId = await freshSession();

  const body = payload(await handlers.fill({ sessionId, selector: '#shoutingInput', value: 'quiet' }));

  assert.equal(body.value, 'QUIET', 'the readback must be the field\'s real content, not an echo of the request');
  assert.equal(body.requested, 'quiet');
  assert.equal(body.matched, false);
  assert.equal(typeof body.note, 'string', 'a mismatch must be stated explicitly, not returned as a bare success');

  await sessions.releaseSession(sessionId);
});

// ---------------------------------------------------------------------------
// P1-3: press_key
// ---------------------------------------------------------------------------

test('press_key establishes keyboard modality, which a programmatic focus cannot', async () => {
  const sessionId = await freshSession();

  // A real mouse click puts the page in pointer modality, exactly as any
  // earlier step of a QA run would.
  await handlers.click({ sessionId, selector: '#b1' });
  const focusVisible = (id: string) => evaluate<boolean>(sessionId, `!!document.querySelector('#${id}:focus-visible')`);

  await evaluate(sessionId, "document.getElementById('b2').focus()");
  assert.equal(await evaluate(sessionId, "!!document.querySelector('#b2:focus')"), true, 'the button is focused');
  assert.equal(await focusVisible('b2'), false, 'this is the false pass: a programmatic focus reports no focus ring');

  const body = payload(await handlers.press_key({ sessionId, key: 'Shift+Tab' }));

  assert.equal(await evaluate(sessionId, 'document.activeElement.id'), 'b1');
  assert.equal(await focusVisible('b1'), true, 'a real key event is what makes the focus ring measurable');
  assert.equal((body.activeElement as { id: string }).id, 'b1', 'press_key should report where focus landed');
  assert.equal(body.focusVisible, true);

  await sessions.releaseSession(sessionId);
});

test('press_key can target one element and repeat', async () => {
  const sessionId = await freshSession();

  await handlers.press_key({ sessionId, selector: '#plainInput', key: 'a' });
  await handlers.press_key({ sessionId, selector: '#plainInput', key: 'b', repeat: 3 });

  assert.equal(await evaluate(sessionId, "document.getElementById('plainInput').value"), 'abbb');
  await sessions.releaseSession(sessionId);
});

// ---------------------------------------------------------------------------
// P1-4: hover
// ---------------------------------------------------------------------------

test('hover triggers a CSS-only :hover rule, which synthetic pointer events cannot', async () => {
  const sessionId = await freshSession();
  const bg = () => evaluate<string>(sessionId, "getComputedStyle(document.getElementById('hoverTarget')).backgroundColor");

  assert.equal(await bg(), 'rgb(0, 0, 255)');

  const body = payload(await handlers.hover({ sessionId, selector: '#hoverTarget' }));

  assert.equal(await bg(), 'rgb(255, 0, 0)', 'only a real pointer move satisfies a CSS :hover rule');
  assert.equal(body.hovering, true, 'hover should confirm the element really matches :hover afterwards');

  await sessions.releaseSession(sessionId);
});

// ---------------------------------------------------------------------------
// P1-5: click at a point
// ---------------------------------------------------------------------------

test('click lands at the requested offset inside the element', async () => {
  const sessionId = await freshSession();

  await handlers.click({ sessionId, selector: '#clickPad', x: 12, y: 34 });

  const events = await evaluate<{ kind: string; x: number; y: number; button: number; detail?: number }[]>(
    sessionId,
    'window.__events'
  );
  const down = events.find(e => e.kind === 'mousedown');
  assert.ok(down, 'expected a mousedown on the pad');
  assert.equal(down!.x, 12);
  assert.equal(down!.y, 34);

  await sessions.releaseSession(sessionId);
});

test('click accepts a mouse button and a click count', async () => {
  const sessionId = await freshSession();

  await handlers.click({ sessionId, selector: '#clickPad', x: 5, y: 6, button: 'right' });
  await handlers.click({ sessionId, selector: '#clickPad', x: 7, y: 8, clickCount: 2 });

  const events = await evaluate<{ kind: string; x: number; y: number; button: number; detail?: number }[]>(
    sessionId,
    'window.__events'
  );
  assert.ok(
    events.some(e => e.kind === 'mousedown' && e.button === 2 && e.x === 5),
    'expected a right-button mousedown at the requested offset'
  );
  assert.ok(
    events.some(e => e.kind === 'click' && e.detail === 2),
    'expected a double click (detail 2) at the requested offset'
  );

  await sessions.releaseSession(sessionId);
});

test('click rejects a half-specified position rather than silently centring', async () => {
  const sessionId = await freshSession();
  await assert.rejects(
    () => handlers.click({ sessionId, selector: '#clickPad', x: 10 }),
    /both/i,
    'giving only one of x/y must be an explicit error'
  );
  await sessions.releaseSession(sessionId);
});

// ---------------------------------------------------------------------------
// P1-6: resize
// ---------------------------------------------------------------------------

/** Bytes 16..24 of a PNG are width then height, each a big-endian uint32. */
function pngDimensions(base64: string): { width: number; height: number } {
  const buffer = Buffer.from(base64, 'base64');
  assert.equal(buffer.subarray(1, 4).toString('latin1'), 'PNG', 'expected a PNG');
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

test('resize changes the viewport AND the pixels a screenshot captures', async () => {
  const sessionId = await freshSession();

  const before = await evaluate<number>(sessionId, 'window.innerWidth');
  assert.notEqual(before, 500, 'the fixture viewport must start somewhere other than the size we resize to');

  const body = payload(await handlers.resize({ sessionId, width: 500, height: 640 }));
  assert.equal(body.innerWidth, 500, 'resize should read the viewport back from the page');
  assert.equal(await evaluate(sessionId, 'window.innerWidth'), 500);

  const shot = (await handlers.screenshot({ sessionId })) as { content: { type: string; data: string }[] };
  const { width, height } = pngDimensions(shot.content[0]!.data);
  assert.equal(width, 500, 'the screenshot must follow the resize, or every responsive screenshot is misleading');
  assert.equal(height, 640);

  await sessions.releaseSession(sessionId);
});

// ---------------------------------------------------------------------------
// P1-7: wait_for
// ---------------------------------------------------------------------------

test('wait_for waits for a selector state and reports how long it waited', async () => {
  const sessionId = await freshSession();

  await evaluate(
    sessionId,
    "setTimeout(() => { document.getElementById('lateBloomer').style.display = 'block'; }, 150), 'scheduled'"
  );

  const body = payload(await handlers.wait_for({ sessionId, selector: '#lateBloomer', state: 'visible' }));
  assert.equal(body.satisfied, true);
  assert.equal(typeof body.waitedMs, 'number');
  assert.ok((body.waitedMs as number) >= 100, `expected to have actually waited, got ${String(body.waitedMs)}ms`);

  await sessions.releaseSession(sessionId);
});

test('wait_for polls a JavaScript expression until it is truthy', async () => {
  const sessionId = await freshSession();

  await evaluate(sessionId, "setTimeout(() => { window.__ready = true; }, 120), 'scheduled'");

  const body = payload(await handlers.wait_for({ sessionId, expression: 'window.__ready === true' }));
  assert.equal(body.satisfied, true);
  assert.ok((body.waitedMs as number) >= 80);

  await sessions.releaseSession(sessionId);
});

test('wait_for rejects both-or-neither rather than guessing', async () => {
  const sessionId = await freshSession();

  await assert.rejects(() => handlers.wait_for({ sessionId }), /exactly one/i);
  await assert.rejects(
    () => handlers.wait_for({ sessionId, selector: '#outside', expression: 'true' }),
    /exactly one/i
  );

  await sessions.releaseSession(sessionId);
});

test('wait_for times out with a message naming what it waited for and for how long', async () => {
  const sessionId = await freshSession();

  await assert.rejects(
    () => handlers.wait_for({ sessionId, expression: 'window.__neverSet === true', timeoutMs: 300 }),
    (err: Error) => {
      assert.match(err.message, /__neverSet/, 'the error must name what it was waiting for');
      assert.match(err.message, /300|\d+ms/, 'the error must say how long it waited');
      return true;
    }
  );

  await assert.rejects(
    () => handlers.wait_for({ sessionId, selector: '#nothingLikeThis', state: 'visible', timeoutMs: 300 }),
    /#nothingLikeThis/
  );

  await sessions.releaseSession(sessionId);
});

// ---------------------------------------------------------------------------
// P1-8: type
// ---------------------------------------------------------------------------

test('type fires one input event per character, which fill cannot', async () => {
  const sessionId = await freshSession();

  await evaluate(sessionId, 'window.__inputEvents = 0');
  const body = payload(await handlers.type({ sessionId, selector: '#plainInput', text: 'abcd' }));

  assert.equal(await evaluate(sessionId, 'window.__inputEvents'), 4, 'each character must be its own input event');
  assert.equal(body.value, 'abcd');
  assert.equal(body.matched, true);

  await sessions.releaseSession(sessionId);
});

test('type appends by default and clears only when asked', async () => {
  const sessionId = await freshSession();

  await handlers.fill({ sessionId, selector: '#plainInput', value: 'seed' });

  const appended = payload(await handlers.type({ sessionId, selector: '#plainInput', text: '-more' }));
  assert.equal(appended.value, 'seed-more', 'type simulates a user typing, so it must not clear first');
  assert.equal(appended.matched, true, 'appending is the documented behaviour, so it is a match, not a mismatch');

  const cleared = payload(await handlers.type({ sessionId, selector: '#plainInput', text: 'fresh', clear: true }));
  assert.equal(cleared.value, 'fresh');

  await sessions.releaseSession(sessionId);
});

test('type reports back what a rewriting field actually contains', async () => {
  const sessionId = await freshSession();

  const body = payload(await handlers.type({ sessionId, selector: '#shoutingInput', text: 'quiet' }));
  assert.equal(body.value, 'QUIET');
  assert.equal(body.matched, false);
  assert.equal(typeof body.note, 'string');

  await sessions.releaseSession(sessionId);
});

test('type without a selector goes to whatever has focus', async () => {
  const sessionId = await freshSession();

  await evaluate(sessionId, "document.getElementById('plainArea').focus()");
  const body = payload(await handlers.type({ sessionId, text: 'focused' }));

  assert.equal(await evaluate(sessionId, "document.getElementById('plainArea').value"), 'focused');
  assert.equal(body.value, 'focused');

  await sessions.releaseSession(sessionId);
});

test('type into a rich editor inserts at the caret, and fill is the way to replace', async () => {
  const sessionId = await freshSession();

  // Focusing a contenteditable puts the caret at the start, so a user typing
  // there inserts at the start. The point is that nothing was cleared.
  const inserted = payload(await handlers.type({ sessionId, selector: '#editor', text: '!' }));
  assert.equal(inserted.value, '!result', 'typing must insert at the caret, not replace the editor\'s contents');
  assert.equal(inserted.matched, true, 'inserting is the documented behaviour, so it is a match');

  const replaced = payload(await handlers.fill({ sessionId, selector: '#editor', value: 'replaced' }));
  assert.equal(replaced.value, 'replaced', 'fill is the tool that replaces');

  await sessions.releaseSession(sessionId);
});

test('fill refuses to select-all when the target never took focus', async () => {
  const sessionId = await freshSession();

  // A plain div cannot take focus, so a select-all pressed against it would
  // scope to the whole document and the following delete would empty the page.
  await assert.rejects(() => handlers.fill({ sessionId, selector: '#outside', value: 'nope' }), /focus/i);

  assert.equal(
    await evaluate(sessionId, "document.getElementById('outside').textContent"),
    'OUTSIDE TEXT',
    'the page must survive a fill aimed at something that cannot be edited'
  );
  assert.equal(await evaluate(sessionId, "!!document.getElementById('editor')"), true, 'the rest of the page must survive too');

  await sessions.releaseSession(sessionId);
});
