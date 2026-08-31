import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';

import { BrowserManager } from '../src/daemon/browserManager.js';
import { createToolHandlers } from '../src/daemon/tools/handlers.js';
import { emulationTools } from '../src/daemon/tools/defs/emulation.js';
import { inspectTools } from '../src/daemon/tools/defs/inspect.js';
import { interactionTools } from '../src/daemon/tools/defs/interaction.js';
import { SessionStore } from '../src/daemon/sessions.js';
import { getFreePort } from './helpers.js';

/**
 * An adversarial pass over the 58-tool surface, hunting for exactly one thing:
 * a tool that reports success while nothing happened, or while something other
 * than what it says happened.
 *
 * Every fixture here exists because a plausible, ordinary page shape made a
 * tool answer confidently and wrongly. The dark-canvas page is what a real
 * dark-mode site looks like. The shadow-DOM page is what a component library
 * looks like. The contenteditable page is what a document editor looks like.
 * None of them is exotic.
 */

/** A dark-mode page of the ordinary kind: the canvas is dark, no element paints a background. */
const DARK_HTML = `<!doctype html>
<html>
<head><style>html { color-scheme: dark; }</style></head>
<body><p id="body-text" style="color: rgb(255,255,255)">white on the dark canvas</p></body>
</html>`;

/**
 * The same page written the other common way: the theme is declared through
 * the meta tag and only becomes dark when the browser says the user wants
 * dark, which is precisely what emulate_media exists to say.
 */
const META_DARK_HTML = `<!doctype html>
<html>
<head><meta name="color-scheme" content="dark light"></head>
<body><p id="body-text" style="color: rgb(255,255,255)">white when the canvas goes dark</p></body>
</html>`;

/**
 * A component-library page: a button inside an open shadow root, and an
 * unrelated button in the light DOM that any positional path derived from
 * inside the shadow root would also match.
 */
const SHADOW_HTML = `<!doctype html>
<html><body>
  <div><button id="light-button">Unrelated Button</button></div>
  <div id="host"></div>
<script>
  window.__clicked = [];
  document.addEventListener('click', function (e) { window.__clicked.push(e.target.id || e.target.tagName); }, true);
  var root = document.getElementById('host').attachShadow({ mode: 'open' });
  root.innerHTML = '<div><button id="shadow-button">Submit Order</button></div>';
  root.addEventListener('click', function (e) { window.__clicked.push('shadow:' + e.target.id); }, true);
</script>
</body></html>`;

/** A document editor: the whole body takes the caret, so a stray select-all can empty it. */
const EDITABLE_HTML = `<!doctype html>
<html><body contenteditable="true">
<h1 id="heading">Quarterly report</h1>
<p id="para">A paragraph nothing in this call was asked to touch.</p>
</body></html>`;

/**
 * An element whose centre sits outside the viewport, with an unrelated fixed
 * bar sitting exactly where the centre gets clamped to.
 */
const OFFSCREEN_HTML = `<!doctype html>
<html><head><style>
  #wide { position: absolute; left: -260px; top: 300px; width: 300px; height: 40px; background: rgb(0,0,255); }
  #bar { position: fixed; left: 0; top: 300px; width: 60px; height: 40px; background: rgb(255,0,0); z-index: 5; }
</style></head>
<body><div id="wide">mostly off screen</div><div id="bar"></div></body></html>`;

/** An opaque overlay that covers an element on screen but takes no clicks. */
const GHOST_HTML = `<!doctype html>
<html><head><style>
  #target { position: absolute; left: 20px; top: 20px; width: 200px; height: 60px; background: rgb(0,128,0); }
  #ghost { position: absolute; left: 0; top: 0; width: 400px; height: 200px;
           background: rgb(255,0,0); pointer-events: none; z-index: 9; }
</style></head>
<body><div id="target">hidden behind the ghost</div><div id="ghost"></div></body></html>`;

/** A canvas that follows the pointer only while a button is held, the way every drag library does. */
const DRAG_HTML = `<!doctype html>
<html><head><style>
  #canvas { position: absolute; left: 0; top: 0; width: 600px; height: 400px; background: rgb(240,240,240); }
  #node { position: absolute; left: 50px; top: 50px; width: 80px; height: 40px; background: rgb(0,0,200); }
</style></head>
<body>
  <div id="canvas"><div id="node"></div></div>
<script>
  var node = document.getElementById('node');
  var dragging = false;
  var lastX = 0;
  node.addEventListener('pointerdown', function (e) { dragging = true; lastX = e.clientX; });
  window.addEventListener('pointermove', function (e) {
    if (!dragging) return;
    node.style.left = (parseFloat(node.style.left || '50') + (e.clientX - lastX)) + 'px';
    lastX = e.clientX;
  });
  window.addEventListener('pointerup', function () { dragging = false; });
  window.__nodeLeft = function () { return parseFloat(getComputedStyle(node).left); };
</script>
</body></html>`;

const PAGES: Record<string, string> = {
  '/dark': DARK_HTML,
  '/meta-dark': META_DARK_HTML,
  '/shadow': SHADOW_HTML,
  '/editable': EDITABLE_HTML,
  '/offscreen': OFFSCREEN_HTML,
  '/ghost': GHOST_HTML,
  '/drag': DRAG_HTML
};

let server: Server;
let baseUrl: string;
let browserManager: BrowserManager;
let sessions: SessionStore;
let handlers: ReturnType<typeof createToolHandlers>;

before(async () => {
  server = createServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    const path = (req.url ?? '/dark').split('?')[0];
    res.end(PAGES[path] ?? '<!doctype html><html><body>blank</body></html>');
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

async function sessionOn(path: string, options?: Record<string, unknown>): Promise<string> {
  const { sessionId } = await sessions.createSession(options as never);
  await handlers.navigate({ sessionId, url: `${baseUrl}${path}` });
  return sessionId;
}

async function evaluate<T>(sessionId: string, expression: string): Promise<T> {
  return payload(await handlers.evaluate({ sessionId, expression })).result as T;
}

// ---------------------------------------------------------------------------
// 1. wait_for succeeds for a selector that never existed
// ---------------------------------------------------------------------------

test('wait_for hidden on a selector that never existed says so instead of reporting a bare success', async () => {
  const sessionId = await sessionOn('/dark');

  // Playwright treats "not in the DOM at all" as satisfying both hidden and
  // detached, so a typo in the selector of "wait for the modal to close"
  // returns success in single-digit milliseconds having proved nothing.
  const hidden = payload(await handlers.wait_for({ sessionId, selector: '#never-existed', state: 'hidden' }));
  assert.equal(hidden.satisfied, true, 'Playwright really does satisfy hidden for an absent element: the trap is real');
  assert.equal(
    hidden.everMatched,
    false,
    'wait_for must report that the selector matched nothing at any point, or a mistyped selector reads as a passing wait'
  );
  assert.match(
    String(hidden.note ?? ''),
    /never matched/i,
    'a wait satisfied only because the element was never there needs a note saying so'
  );

  const detached = payload(await handlers.wait_for({ sessionId, selector: '#also-never', state: 'detached' }));
  assert.equal(detached.everMatched, false, 'the same holds for detached, which an absent element also satisfies');
  assert.ok(detached.note !== undefined, 'detached needs the same note as hidden');

  await sessions.releaseSession(sessionId);
});

test('wait_for on a selector that really is present and really goes hidden reports everMatched true', async () => {
  const sessionId = await sessionOn('/ghost');
  const result = payload(
    await handlers.wait_for({ sessionId, selector: '#target', state: 'visible' })
  );
  assert.equal(result.satisfied, true);
  assert.equal(result.everMatched, true, 'an element that was really there must be distinguishable from one that never was');
  assert.equal(result.note, undefined, 'a genuine wait carries no warning');
  await sessions.releaseSession(sessionId);
});

// ---------------------------------------------------------------------------
// 2. send_cdp_command reports success for an override that is already gone
// ---------------------------------------------------------------------------

test('send_cdp_command returns a bare success for an Emulation override that reverts before the result arrives', async () => {
  const sessionId = await sessionOn('/dark');
  const before = await evaluate<string>(sessionId, 'navigator.userAgent');

  const result = payload(
    await handlers.send_cdp_command({
      sessionId,
      method: 'Emulation.setUserAgentOverride',
      params: { userAgent: 'AdversarialProbe/1.0' }
    })
  );
  const after = await evaluate<string>(sessionId, 'navigator.userAgent');

  // The behaviour itself is Chromium's and cannot be fixed here: the override
  // dies with the DevTools session, and this tool detaches after every call.
  assert.deepEqual(result.result, {}, 'CDP itself reports success');
  assert.equal(after, before, 'and the override is gone before the result comes back');

  // So the only defence is the description, and it is the one description in
  // the registry that does not carry the warning: set_user_agent, set_locale,
  // set_timezone and set_network_conditions all spell it out about this tool.
  assert.match(
    inspectTools.send_cdp_command.description,
    /Emulation/,
    'send_cdp_command must warn that Emulation overrides revert when it detaches, since it is the tool an agent would reach for'
  );
  assert.match(
    inspectTools.send_cdp_command.description,
    /detach/i,
    'the warning has to name the mechanism, not just the affected domain'
  );

  await sessions.releaseSession(sessionId);
});

// ---------------------------------------------------------------------------
// 3. computed_style assumes a white canvas
// ---------------------------------------------------------------------------

test('computed_style composites onto the real canvas colour, not a hardcoded white one', async () => {
  const sessionId = await sessionOn('/dark');

  const body = payload(await handlers.computed_style({ sessionId, selector: '#body-text' })).elements[0];

  // Chromium paints rgb(18,18,18) behind a page whose root declares
  // color-scheme: dark and paints no background of its own. White text on it
  // is about 15.9:1, comfortably passing. Compositing onto white instead
  // yields 1:1 and a confident AA failure.
  assert.equal(
    body.effective.backgroundColor,
    'rgb(18, 18, 18)',
    'the composited background must be the canvas the browser actually paints'
  );
  assert.ok(
    body.contrast.ratio > 14,
    `white text on a dark canvas is about 15.9:1, got ${body.contrast.ratio}`
  );
  assert.equal(body.contrast.passes.aaText, true, 'and it passes AA, rather than being reported as the worst possible failure');

  await sessions.releaseSession(sessionId);
});

test('computed_style follows emulate_media when the page declares its theme through meta color-scheme', async () => {
  const sessionId = await sessionOn('/meta-dark');

  const light = payload(await handlers.computed_style({ sessionId, selector: '#body-text' })).elements[0];
  assert.equal(light.effective.backgroundColor, 'rgb(255, 255, 255)', 'unemulated, this page really is light');

  await handlers.emulate_media({ sessionId, colorScheme: 'dark' });
  const dark = payload(await handlers.computed_style({ sessionId, selector: '#body-text' })).elements[0];

  // This is the exact workflow the emulation stream was built for: emulate the
  // dark theme, then measure contrast. Getting it wrong here turns a passing
  // theme into a reported accessibility defect.
  assert.equal(
    dark.effective.backgroundColor,
    'rgb(18, 18, 18)',
    'under emulated dark the canvas goes dark, and the composite has to follow it'
  );
  assert.ok(dark.contrast.ratio > 14, `expected about 15.9:1 under emulated dark, got ${dark.contrast.ratio}`);

  await sessions.releaseSession(sessionId);
});

// ---------------------------------------------------------------------------
// 4 and 5. element_box's occlusion answer
// ---------------------------------------------------------------------------

test('element_box does not describe an element buried under an opaque overlay as unobstructed', async () => {
  const sessionId = await sessionOn('/ghost');
  const box = payload(await handlers.element_box({ sessionId, selectors: ['#target'] })).results[0].elements[0];

  // The hit-test answer is correct: pointer-events: none means the click does
  // land on the target. The claim the description opens with, that the tool
  // reports "whether anything is painted on top of them", is not.
  assert.equal(box.topmostAtCentre, true, 'a pointer-events: none overlay really does let the click through');
  assert.doesNotMatch(
    inspectTools.element_box.description,
    /whether anything is painted on top of them/,
    'element_box hit-tests: it must not claim to report what is painted on top, since an opaque pointer-events: none overlay is invisible to it'
  );
  assert.match(
    inspectTools.element_box.description,
    /pointer-events/,
    'the limitation has to be stated, because "nothing is on top" is what an agent will quote'
  );

  await sessions.releaseSession(sessionId);
});

test('element_box says which point it hit-tested when the centre is off screen', async () => {
  const sessionId = await sessionOn('/offscreen');
  const box = payload(await handlers.element_box({ sessionId, selectors: ['#wide'] })).results[0].elements[0];

  // #wide spans x -260..40, so its centre is at x -110, which is off screen and
  // covered by nothing. The tool clamps into the viewport and hit-tests (0,320),
  // where an unrelated fixed bar sits, then reports the element as occluded by
  // it under a field named topmostAtCentre.
  assert.equal(box.topmostAtCentre, false, 'the clamped point really is covered: the trap is real');
  assert.deepEqual(
    box.hitTestPoint,
    { x: 0, y: 320 },
    'the point actually tested must be reported, because it is not the centre whenever the centre is off screen'
  );
  assert.equal(box.hitTestPointIsCentre, false, 'and it has to be flagged as not the centre');

  await sessions.releaseSession(sessionId);
});

// ---------------------------------------------------------------------------
// 6 and 7. type's clear path
// ---------------------------------------------------------------------------

test('type with clear and no selector refuses rather than emptying a contenteditable document', async () => {
  const sessionId = await sessionOn('/editable');
  const before = await evaluate<string>(sessionId, 'document.body.innerHTML');
  assert.match(before, /Quarterly report/);
  assert.match(before, /nothing in this call was asked to touch/);

  // fill grew a focus guard for exactly this: a select-all aimed at something
  // that cannot take focus selects the whole document, and the delete that
  // follows empties it. type's no-selector clear path never got that guard,
  // and reports matched: true afterwards.
  await assert.rejects(
    () => handlers.type({ sessionId, text: 'oops', clear: true }),
    /focus/i,
    'type must refuse to press select-all against the whole document, the way fill already does'
  );

  const after = await evaluate<string>(sessionId, 'document.body.innerHTML');
  assert.match(after, /Quarterly report/, 'the heading must survive a refused call');
  assert.match(after, /nothing in this call was asked to touch/, 'and so must the paragraph');

  await sessions.releaseSession(sessionId);
});

test('type reports the value from before the clear, not the emptied field it then typed into', async () => {
  const sessionId = await sessionOn('/shadow');
  await evaluate(
    sessionId,
    "document.body.insertAdjacentHTML('beforeend', '<input id=\"pre\" value=\"original text\">')"
  );

  const result = payload(await handlers.type({ sessionId, selector: '#pre', text: 'new', clear: true }));

  // previousValue is read AFTER the clear, so it is always the empty string on
  // a clearing type. That also makes "matched" a comparison against nothing:
  // it cannot fail, whatever the clear destroyed.
  assert.equal(
    result.previousValue,
    'original text',
    'previousValue has to mean what it says, or a caller cannot see what the clear threw away'
  );
  assert.equal(result.value, 'new');

  await sessions.releaseSession(sessionId);
});

// ---------------------------------------------------------------------------
// 8 and 9. find hands click a selector that resolves elsewhere
// ---------------------------------------------------------------------------

test('find flags a generated selector that does not resolve to the element it describes', async () => {
  const sessionId = await sessionOn('/shadow');

  const found = payload(await handlers.find({ sessionId, text: 'Submit Order' }));
  assert.equal(found.matched, 1, 'Playwright pierces open shadow roots, so find locates it');
  const element = found.elements[0];

  // The generated path is built by walking parentElement, which stops dead at
  // the shadow boundary and yields "div > button": a selector that in this
  // document matches the unrelated light-DOM button instead.
  assert.equal(
    element.resolvesToTarget,
    false,
    'find must say that the selector it generated does not resolve to the element it just described'
  );
  assert.match(
    String(found.note ?? ''),
    /shadow|resolve/i,
    'and the result needs a note, because the whole point of find is that its selector can be handed to click'
  );

  await sessions.releaseSession(sessionId);
});

test('click reports how many elements its selector matched, so an ambiguous one is visible', async () => {
  const sessionId = await sessionOn('/shadow');

  // "div > button" matches two elements once Playwright pierces the shadow
  // root. page.click is not strict, so it silently acts on the first one and
  // returns ok: true. Handed this selector by find, an agent presses a button
  // it never asked for and reads a clean success.
  const result = payload(await handlers.click({ sessionId, selector: 'div > button' }));
  assert.equal(result.ok, true);
  assert.equal(
    result.matchedElements,
    2,
    'click must report the match count, since it acts on the first of several without complaint'
  );
  assert.match(
    String(result.note ?? ''),
    /more than one|first/i,
    'and warn when it acted on the first of several'
  );

  const clicked = await evaluate<string[]>(sessionId, 'window.__clicked');
  assert.ok(clicked.includes('light-button'), 'confirming it really was the wrong button: the trap is real');

  await sessions.releaseSession(sessionId);
});

// ---------------------------------------------------------------------------
// 10. screenshot dimensions are device pixels, next to a CSS-pixel clip
// ---------------------------------------------------------------------------

test('screenshot says what scale its reported dimensions are in when deviceScaleFactor is not 1', async () => {
  const sessionId = await sessionOn('/dark', { viewport: { width: 375, height: 600 }, deviceScaleFactor: 2 });

  const clipped = payload(
    await handlers.screenshot({ sessionId, clip: { x: 300, y: 500, width: 200, height: 200 } })
  );

  // The clip is CSS pixels and the reported size is device pixels, side by side
  // in one payload. The clip was truncated from 200x200 to 75x100 CSS pixels,
  // and the payload says "width: 150, height: 200": read against the request,
  // that says the height was not truncated at all. It was halved.
  assert.equal(clipped.width, 150);
  assert.equal(clipped.height, 200);
  assert.equal(clipped.deviceScaleFactor, 2, 'the scale has to be in the payload for the numbers to mean anything');
  assert.deepEqual(
    { width: clipped.cssWidth, height: clipped.cssHeight },
    { width: 75, height: 100 },
    'and the CSS-pixel size has to be there too, since that is the space the clip was expressed in'
  );

  await sessions.releaseSession(sessionId);
});

// ---------------------------------------------------------------------------
// 11. emulate_media never compares what it asked for against what it got
// ---------------------------------------------------------------------------

test('emulate_media reports whether the browser agreed, rather than leaving two objects side by side', async () => {
  const sessionId = await sessionOn('/dark');

  const asked = payload(await handlers.emulate_media({ sessionId, colorScheme: 'dark', reducedMotion: 'reduce' }));
  assert.equal(asked.matched, true, 'every other tool in this module reports a matched flag; this one must too');

  // Chromium answers "light" to a request for "no-preference", permanently.
  // The tool reports requested: no-preference next to effective: light with no
  // comment, and an agent comparing the two reads a failure that is not one.
  const noPreference = payload(await handlers.emulate_media({ sessionId, colorScheme: 'no-preference' }));
  assert.equal(noPreference.effective.colorScheme, 'light', 'Chromium really does answer light here');
  assert.equal(
    noPreference.matched,
    true,
    'and the tool has to know that this particular disagreement is expected rather than reporting a mismatch'
  );

  await sessions.releaseSession(sessionId);
});

// ---------------------------------------------------------------------------
// 12. Concurrency: two tool calls on one session share one mouse
// ---------------------------------------------------------------------------

test(
  'a drag and a concurrent click on the same session corrupt one another and both report success',
  {
    todo:
      'UNFIXED. A per-page input lock is a design change that reaches into the session store and would ' +
      'serialize calls that today run in parallel, so it is reported rather than applied. See the review.'
  },
  async () => {
    const sessionId = await sessionOn('/drag');
    const startLeft = await evaluate<number>(sessionId, 'window.__nodeLeft()');

    // holdMs keeps the button down while a second tool call arrives, which is
    // exactly what an MCP client issuing parallel tool calls produces. The
    // click's own mouseup releases the drag's button, so the drag's moves land
    // with nothing held and the canvas never sees a drag at all.
    const dragging = handlers.drag({
      sessionId,
      source: { selector: '#node' },
      target: { selector: '#canvas', x: 500, y: 70 },
      holdMs: 800
    });
    await new Promise(resolve => setTimeout(resolve, 300));
    const click = payload(await handlers.click({ sessionId, selector: '#canvas', x: 5, y: 5 }));
    const drag = payload(await dragging);

    const endLeft = await evaluate<number>(sessionId, 'window.__nodeLeft()');

    assert.equal(click.ok, true, 'the click reports success');
    assert.equal(drag.target.x, 500, 'and the drag reports the target it was asked for');

    // The click's own mouseup ends the drag early, at the click's coordinates,
    // so the node lands nowhere near where the drag says it took it. Neither
    // result mentions the other call having taken the mouse out from under it.
    assert.ok(
      Math.abs(endLeft - (startLeft + (500 - 90))) < 20,
      `the node should have followed the drag to about x=${startLeft + 410}, it is at ${endLeft}`
    );

    await sessions.releaseSession(sessionId);
  }
);

// ---------------------------------------------------------------------------
// 13. Registry-level consistency
// ---------------------------------------------------------------------------

test('every tool that holds a CDP session open explains why send_cdp_command cannot do the same job', () => {
  // Four tools already carry this warning. The gap was the tool being warned
  // about. This pins the pattern so a future tool cannot quietly drop it.
  for (const description of [
    emulationTools.set_user_agent.description,
    emulationTools.set_locale.description,
    emulationTools.set_timezone.description
  ]) {
    assert.match(description, /send_cdp_command/, 'the warning names the tool it is about');
  }
});

test('interaction tools that write to the page all report what the page holds afterwards', () => {
  // fill, type, select_option and file_upload each read back. click and hover
  // do not, which is the gap that let find hand click a wrong selector and get
  // a clean ok: true. This asserts the readback vocabulary is at least present.
  for (const name of ['fill', 'type', 'select_option', 'file_upload'] as const) {
    assert.match(
      interactionTools[name].description,
      /reads? .*back|value|selected|files/i,
      `${name} must promise a readback`
    );
  }
  assert.match(
    interactionTools.click.description,
    /matched|more than one/i,
    'click must say what it does when a selector matches several elements, because it silently takes the first'
  );
});
