import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';

import { BrowserManager } from '../src/daemon/browserManager.js';
import { createToolHandlers } from '../src/daemon/tools/handlers.js';
import { SessionStore } from '../src/daemon/sessions.js';
import { getFreePort } from './helpers.js';

/**
 * The write fence went up in one frame and came down in another.
 *
 * `installWriteFence` runs through a Locator, so its listeners land on the
 * ELEMENT's frame. The teardown took a `Page` and evaluated on the MAIN frame.
 * Through a frame-prefixed selector, which `list_frames` tells agents to build
 * and which both `fill` and `type` accept, those are different documents: the
 * teardown cleared a fence that was never there and read a `blocked` flag off a
 * `window` that had none, while the real fence stayed installed in the iframe.
 *
 * That is a leak of BEHAVIOUR, not of memory. The guard is a capture-phase
 * keydown listener that cancels any keystroke whose selection is not inside the
 * element it was installed for, so it silently suppressed every later write into
 * that frame for the life of the document.
 *
 * The oracle throughout is read from INSIDE the frame, never from the tool's own
 * report, because the return value of the teardown is precisely what was wrong:
 * it described a fence that was not there.
 */
const INNER = `<!doctype html><html><body>
<input id="field" value="start">
<div id="editable" contenteditable="true">EDIT ME</div>
</body></html>`;

const OUTER = `<!doctype html><html><body>
<h1>outer</h1>
<iframe id="f" src="/inner" width="600" height="300"></iframe>
</body></html>`;

/** The prefix `list_frames` hands out, and what `find` prepends to a selector inside a frame. */
const IN_FRAME = 'iframe >> nth=0 >> internal:control=enter-frame >> ';

let server: Server;
let baseUrl: string;
let browserManager: BrowserManager;
let sessions: SessionStore;
let handlers: ReturnType<typeof createToolHandlers>;

before(async () => {
  server = createServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end((req.url ?? '/').startsWith('/inner') ? INNER : OUTER);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/`;

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

async function freshSession(): Promise<string> {
  const { sessionId } = await sessions.createSession();
  await handlers.navigate({ sessionId, url: baseUrl });
  // The iframe has to have loaded before a frame-prefixed selector can resolve.
  await sessions.resolve(sessionId).page.waitForSelector('iframe');
  await sessions.resolve(sessionId).page.frames()[1].waitForSelector('#field');
  return sessionId;
}

function payload(result: unknown): Record<string, unknown> {
  return (result as { structuredContent: Record<string, unknown> }).structuredContent;
}

/** Reads from INSIDE the iframe, which is the only honest oracle here. */
function inFrame<T>(sessionId: string, expression: string): Promise<T> {
  return sessions.resolve(sessionId).page.frames()[1].evaluate(expression) as Promise<T>;
}

/** Whether either document is still holding a fence. Both must be clear afterwards. */
async function fenceState(sessionId: string): Promise<{ main: string; frame: string }> {
  const frames = sessions.resolve(sessionId).page.frames();
  return {
    main: (await frames[0].evaluate('typeof window.__harborageWriteFence')) as string,
    frame: (await frames[1].evaluate('typeof window.__harborageWriteFence')) as string
  };
}

test('a fill through a frame-prefixed selector leaves no fence behind in that frame', async () => {
  const sessionId = await freshSession();

  const body = payload(await handlers.fill({ sessionId, selector: IN_FRAME + '#field', value: 'FIRST' }));
  assert.equal(body.value, 'FIRST');
  assert.equal(await inFrame<string>(sessionId, "document.getElementById('field').value"), 'FIRST');

  assert.deepEqual(
    await fenceState(sessionId),
    { main: 'undefined', frame: 'undefined' },
    'the fence has to come down in the frame it went up in, and it went up in the iframe'
  );

  await sessions.releaseSession(sessionId);
});

test('a contenteditable fill in a frame does not suppress every later write into that frame', async () => {
  const sessionId = await freshSession();

  // This is the mode that installs the cancelling capture-phase guard, so it is
  // the one whose leak had teeth.
  const first = payload(await handlers.fill({ sessionId, selector: IN_FRAME + '#editable', value: 'REPLACED' }));
  assert.equal(first.value, 'REPLACED');
  assert.equal(await inFrame<string>(sessionId, "document.getElementById('editable').textContent"), 'REPLACED');
  assert.equal((await fenceState(sessionId)).frame, 'undefined', 'no fence may survive the call');

  // THE ORACLE THAT MATTERS. Asserting the teardown returned something proves
  // nothing, because it returned a value about the wrong frame. A second write
  // landing is what proves the guard is gone.
  const before = await inFrame<string>(sessionId, "document.getElementById('field').value");
  await handlers.type({ sessionId, selector: IN_FRAME + '#field', text: 'ZZZ' });
  const afterValue = await inFrame<string>(sessionId, "document.getElementById('field').value");

  // Where in the field the caret lands is the browser's call, so the oracle is
  // that the characters ARRIVED, not the order they arrived in.
  assert.notEqual(afterValue, before, 'the characters have to arrive; with the leak they never did');
  assert.match(afterValue, /ZZZ/);
  assert.match(afterValue, new RegExp(before));

  await sessions.releaseSession(sessionId);
});

test('repeated writes into a frame keep landing, call after call', async () => {
  const sessionId = await freshSession();

  // The leak was cumulative: one contenteditable write armed it, and everything
  // after it in that document was silently dropped. Three writes in a row is the
  // cheapest way to show the fence is not accumulating.
  for (const value of ['one', 'two', 'three']) {
    await handlers.fill({ sessionId, selector: IN_FRAME + '#field', value });
    assert.equal(
      await inFrame<string>(sessionId, "document.getElementById('field').value"),
      value,
      `write "${value}" has to land`
    );
    assert.equal((await fenceState(sessionId)).frame, 'undefined');
  }

  await sessions.releaseSession(sessionId);
});

test('a write in the main frame is unaffected by any of this', async () => {
  const sessionId = await freshSession();

  // The control: the main-frame path was always correct, and threading the
  // frame through must not have changed it.
  await sessions.resolve(sessionId).page.evaluate(
    "document.body.insertAdjacentHTML('beforeend', '<input id=\"outer\" value=\"seed\">')"
  );
  const body = payload(await handlers.fill({ sessionId, selector: '#outer', value: 'MAIN' }));

  assert.equal(body.value, 'MAIN');
  assert.equal(body.matched, true);
  assert.deepEqual(await fenceState(sessionId), { main: 'undefined', frame: 'undefined' });

  await sessions.releaseSession(sessionId);
});

test('a no-selector type says focus is inside a frame rather than that the element cannot take text', async () => {
  const sessionId = await freshSession();

  await sessions.resolve(sessionId).page.frames()[1].evaluate("document.getElementById('field').focus()");
  // document.activeElement on the MAIN frame retargets to the iframe ELEMENT,
  // the same shape as a shadow host, and this path has no frame to descend into.
  assert.equal(
    await sessions.resolve(sessionId).page.evaluate('document.activeElement.tagName'),
    'IFRAME',
    'the main frame really does report the iframe element, which is what made the old message misleading'
  );

  const before = await inFrame<string>(sessionId, "document.getElementById('field').value");
  await assert.rejects(
    () => handlers.type({ sessionId, text: 'QQ' }),
    /focus is inside that frame/i,
    'refusing is right; blaming the element for not taking text was not'
  );
  assert.match(
    await handlers
      .type({ sessionId, text: 'QQ' })
      .then(() => '', (err: Error) => err.message),
    /internal:control=enter-frame/,
    'and the message has to hand over the selector shape that works'
  );

  assert.equal(
    await inFrame<string>(sessionId, "document.getElementById('field').value"),
    before,
    'nothing may be typed on a refusal'
  );

  await sessions.releaseSession(sessionId);
});
