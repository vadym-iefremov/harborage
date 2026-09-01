import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';

import { BrowserManager } from '../src/daemon/browserManager.js';
import { createToolHandlers } from '../src/daemon/tools/handlers.js';
import { SessionStore } from '../src/daemon/sessions.js';
import { getFreePort } from './helpers.js';

/**
 * Round 3 QA findings, all of them about a write going somewhere the caller
 * never named while the result read as though nothing had happened.
 *
 * Every assertion here is checked against something OUTSIDE the tool's own
 * report: the element that really received the text, the count of nodes the
 * page still has, the value of the input the key press acted on. Round 2's
 * fixes passed tests that only asserted the tool returned the string they
 * expected, and then certified the exact failure they were built to prevent
 * on a real page. A test that believes the tool cannot catch the tool.
 *
 * What the fixtures reproduce and why they are shaped this way:
 *
 * #canvas is a miniature React Flow. Its nodes carry tabindex="0" for the
 * same reason the real one does (so the widget can handle arrow keys), a
 * click focuses one, and a Delete key press removes the focused node. That
 * last part is what makes this fixture able to FAIL: press Delete against it
 * and a node really is gone, which is exactly what `type` with clear: true
 * did on the real Acres canvas, three nodes down to two. The first test below
 * proves the fixture destroys data before the second asserts the tool no
 * longer lets it.
 *
 * #wrap/#inner is the fill ancestor case: a plain div wrapping a focused
 * contenteditable. On the real Acres inspector the same shape is a CodeMirror
 * wrapper, and the write landed in the editor.
 *
 * #cmWrap reproduces the marker placement the upward-only walk could not see:
 * `[data-testid="expression-editor-input"] > .cm-editor > .cm-scroller >
 * .cm-content`, which is Acres's real ancestry, probed rather than guessed.
 * #deepPage is its control: a CodeMirror buried four levels down, so the
 * downward search has something it must NOT flag.
 *
 * The shadow fixtures use real attachShadow, not a simulation, because the
 * defect is document.activeElement retargeting to the host, which only a
 * genuine shadow root does.
 */
const FIXTURE_HTML = `<!doctype html>
<html>
<head></head>
<body>
  <input id="plainInput" value="hello world">
  <input id="dupInput" class="dup" value="one">
  <input id="dupInput2" class="dup" value="two">
  <input id="box" type="checkbox">
  <input id="picker" type="file">
  <select id="chooser"><option value="a">A</option><option value="b">B</option></select>

  <div id="wrap"><div id="inner" contenteditable="true">seedinner</div></div>
  <div id="classOnlyWrap"><div class="only-editable extra" contenteditable="true">classseed</div></div>

  <div id="cmWrap" data-testid="expression-editor-input"><div class="cm-editor"><div class="cm-scroller"><div id="cmContent" class="cm-content" contenteditable="true">cmseed</div></div></div></div>

  <div id="deepPage"><div><div><div><div class="cm-editor"><div class="cm-content" contenteditable="true">deep</div></div></div></div></div></div>

  <div id="canvas">
    <div class="node" tabindex="0" data-id="n1">Node one</div>
    <div class="node" tabindex="0" data-id="n2">Node two</div>
    <div class="node" tabindex="0" data-id="n3">Node three</div>
  </div>

  <div id="shadowHost"></div>
  <div class="cm-editor"><div id="richShadowHost"></div></div>

<script>
  // A miniature React Flow: nodes take focus on click because they carry a
  // tabindex, and Delete removes the focused one. This is the behaviour that
  // turned a "nothing happened" result into a lost node on the real canvas.
  document.getElementById('canvas').addEventListener('keydown', function (e) {
    if (e.key !== 'Delete' && e.key !== 'Backspace') return;
    var focused = document.activeElement;
    if (focused && focused.classList.contains('node')) focused.remove();
  });

  var host = document.getElementById('shadowHost');
  var root = host.attachShadow({ mode: 'open' });
  root.innerHTML =
    '<div id="shadowEditable" contenteditable="true">shadowseed</div>' +
    '<div class="cm-editor"><div id="shadowCmContent" class="cm-content" contenteditable="true">shadowcm</div></div>';

  // The marker is in the LIGHT dom, above the host; the editable node is
  // inside the shadow root. Detection has to climb out through the host to
  // see it, which a parentElement-only walk cannot do.
  var richHost = document.getElementById('richShadowHost');
  var richRoot = richHost.attachShadow({ mode: 'open' });
  richRoot.innerHTML = '<div id="richShadowEditable" contenteditable="true">richshadowseed</div>';
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
  await handlers.navigate({ sessionId, url: baseUrl });
  return sessionId;
}

/** The `structuredContent` of a tool result, typed loosely: these tests assert on individual fields. */
function payload(result: unknown): Record<string, unknown> {
  return (result as { structuredContent: Record<string, unknown> }).structuredContent;
}

/** Evaluates an expression in the session's tab and returns its value, the same way interaction.test.ts does. */
async function evaluate<T>(sessionId: string, expression: string): Promise<T> {
  const result = await handlers.evaluate({ sessionId, expression });
  return payload(result).result as T;
}

/** The message of whatever a call threw, or null when it did not throw at all. */
async function rejection(call: () => Promise<unknown>): Promise<string | null> {
  try {
    await call();
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

// ---------------------------------------------------------------------------
// Cause C: the typing guard tested tag name, not "can this receive text"
// ---------------------------------------------------------------------------

test('the canvas fixture really does lose a node to a Delete key press', async () => {
  const sessionId = await freshSession();

  // This test exists so the next one means something. A guard that refuses a
  // harmless call proves nothing; the harm has to be reachable in this exact
  // fixture, through the same keystroke the tool's clear path presses.
  await handlers.click({ sessionId, selector: '[data-id="n2"]' });
  assert.equal(
    await evaluate<string>(sessionId, 'document.activeElement.tagName'),
    'DIV',
    'a click on a tabindex node leaves focus on a plain div, which is the whole trap'
  );
  assert.equal(await evaluate<number>(sessionId, "document.querySelectorAll('#canvas .node').length"), 3);

  await handlers.press_key({ sessionId, key: 'Delete' });

  assert.equal(
    await evaluate<number>(sessionId, "document.querySelectorAll('#canvas .node').length"),
    2,
    'the fixture must be able to destroy data, or the guard test below is testing nothing'
  );

  await sessions.releaseSession(sessionId);
});

test('type with clear and no selector refuses on a focused canvas node, and the node survives', async () => {
  const sessionId = await freshSession();

  await handlers.click({ sessionId, selector: '[data-id="n2"]' });
  const idsBefore = await evaluate<string[]>(
    sessionId,
    "Array.from(document.querySelectorAll('#canvas .node')).map(n => n.dataset.id)"
  );
  assert.deepEqual(idsBefore, ['n1', 'n2', 'n3']);

  const message = await rejection(() => handlers.type({ sessionId, text: 'PWNED', clear: true }));

  assert.notEqual(message, null, 'the call must refuse rather than press select-all and Delete at document level');
  assert.match(String(message), /cannot receive text/i);
  assert.match(String(message), /tabindex/i, 'the message has to explain why a plain div had focus at all');
  assert.match(String(message), /nothing was cleared/i);

  // The oracle: the page's own node list, not the tool's report.
  const idsAfter = await evaluate<string[]>(
    sessionId,
    "Array.from(document.querySelectorAll('#canvas .node')).map(n => n.dataset.id)"
  );
  assert.deepEqual(idsAfter, ['n1', 'n2', 'n3'], 'every node must still be there after the refusal');

  await sessions.releaseSession(sessionId);
});

test('type with no selector on a focused canvas node refuses instead of returning the widget as a field value', async () => {
  const sessionId = await freshSession();

  await handlers.click({ sessionId, selector: '[data-id="n2"]' });
  const message = await rejection(() => handlers.type({ sessionId, text: 'x' }));

  assert.notEqual(message, null, 'the readback problem is reachable without clear too, and is refused on its own');
  assert.match(String(message), /cannot receive text/i);
  assert.match(String(message), /nothing was typed/i);

  // The node's own text is the oracle: nothing was typed into it either.
  assert.equal(await evaluate<string>(sessionId, "document.querySelector('[data-id=\"n2\"]').textContent"), 'Node two');

  await sessions.releaseSession(sessionId);
});

test('type with no selector still works when the focused element genuinely holds text', async () => {
  const sessionId = await freshSession();

  await evaluate(sessionId, "document.getElementById('plainInput').focus()");
  const body = payload(await handlers.type({ sessionId, text: '!', clear: true }));

  assert.equal(await evaluate<string>(sessionId, "document.getElementById('plainInput').value"), '!');
  assert.equal(body.value, '!');
  assert.equal(body.matched, true);

  await sessions.releaseSession(sessionId);
});

// ---------------------------------------------------------------------------
// Cause C: fill's focus guard let an ANCESTOR of the focused field through
// ---------------------------------------------------------------------------

test('fill on a non-editable ancestor of the focused field refuses, and the field is untouched', async () => {
  const sessionId = await freshSession();

  await evaluate(sessionId, "document.getElementById('inner').focus()");
  const message = await rejection(() => handlers.fill({ sessionId, selector: '#wrap', value: 'PWNED' }));

  assert.notEqual(message, null, 'the old guard passed this because focus was INSIDE the target, and wrote into the child');
  assert.match(String(message), /cannot receive text/i);
  assert.match(String(message), /id="inner"/, 'the refusal has to name what actually holds the caret');
  assert.match(String(message), /nothing was written/i);

  // The oracle is the element that used to receive the text, read directly.
  assert.equal(
    await evaluate<string>(sessionId, "document.getElementById('inner').textContent"),
    'seedinner',
    'the focused child must not have been written into'
  );

  await sessions.releaseSession(sessionId);
});

test('a refusal names an element with no id by its class, because that is the selector to use next', async () => {
  const sessionId = await freshSession();

  // A CodeMirror's editable node carries no id at all, so "<div>" on its own
  // leaves the caller no better off than before the refusal. This is that
  // shape reduced to its essentials.
  await evaluate(sessionId, "document.querySelector('.only-editable').focus()");
  const message = await rejection(() => handlers.fill({ sessionId, selector: '#classOnlyWrap', value: 'PWNED' }));

  assert.match(String(message), /class="only-editable/, 'the caret holder has to be nameable from the message');
  assert.equal(
    await evaluate<string>(sessionId, "document.querySelector('.only-editable').textContent"),
    'classseed'
  );

  await sessions.releaseSession(sessionId);
});

test('fill still writes when the selector names the editable element itself', async () => {
  const sessionId = await freshSession();

  const body = payload(await handlers.fill({ sessionId, selector: '#inner', value: 'written properly' }));

  assert.equal(await evaluate<string>(sessionId, "document.getElementById('inner').textContent"), 'written properly');
  assert.equal(body.matched, true);
  assert.equal(body.readbackReliable, true);

  await sessions.releaseSession(sessionId);
});

test('fill refuses form controls that hold no typed text, and names the tool that does the job', async () => {
  const sessionId = await freshSession();

  const checkbox = await rejection(() => handlers.fill({ sessionId, selector: '#box', value: 'true' }));
  assert.match(String(checkbox), /type="checkbox"/);
  assert.match(String(checkbox), /click/i, 'a checkbox is clicked, not typed into');

  const file = await rejection(() => handlers.fill({ sessionId, selector: '#picker', value: '/etc/passwd' }));
  assert.match(String(file), /file_upload/);

  // The <select> refusal predates this round and is deliberately kept as it was.
  const select = await rejection(() => handlers.fill({ sessionId, selector: '#chooser', value: 'b' }));
  assert.match(String(select), /select_option/);

  // Nothing was toggled on the way past.
  assert.equal(await evaluate<boolean>(sessionId, "document.getElementById('box').checked"), false);

  await sessions.releaseSession(sessionId);
});

// ---------------------------------------------------------------------------
// Cause D: rich-editor detection walked parentElement only
// ---------------------------------------------------------------------------

test('a selector one hop ABOVE the editor root is recognised as a rich editor', async () => {
  const sessionId = await freshSession();

  // Acres's real ancestry, and the exact selector a QA agent reaches for. The
  // upward-only walk could not see markers that sit below the named element.
  await evaluate(sessionId, "document.getElementById('cmContent').focus()");
  const body = payload(await handlers.type({ sessionId, selector: '[data-testid="expression-editor-input"]', text: 'Z' }));

  assert.equal(body.readbackReliable, false, 'the wrapper\'s textContent is not the editor\'s document');
  assert.equal(body.matched, undefined, 'a readback that cannot be trusted must claim neither true nor false');
  assert.match(String(body.note), /monaco|codemirror/i);

  await sessions.releaseSession(sessionId);
});

test('fill on the wrapper above an editor root refuses and points at the editable node inside it', async () => {
  const sessionId = await freshSession();

  const message = await rejection(() =>
    handlers.fill({ sessionId, selector: '[data-testid="expression-editor-input"]', value: 'PWNED' })
  );

  assert.match(String(message), /cannot receive text/i);
  assert.match(String(message), /cm-content/, 'the way out has to be named, not just the problem');

  assert.equal(
    await evaluate<string>(sessionId, "document.getElementById('cmContent').textContent"),
    'cmseed',
    'the editor must not have been written into'
  );

  await sessions.releaseSession(sessionId);
});

test('the downward search does not flag an ordinary container that merely holds an editor somewhere', async () => {
  const sessionId = await freshSession();

  // The control for the test above. #deepPage has a CodeMirror four levels
  // down; flagging it would make the flag mean nothing, because on a page with
  // an editor anywhere almost every container would carry it.
  await evaluate(sessionId, "document.getElementById('plainInput').focus()");
  const body = payload(await handlers.type({ sessionId, selector: '#plainInput', text: '!' }));

  assert.equal(body.readbackReliable, true, 'a plain input on a page that contains an editor is still a plain input');
  assert.equal(body.matched, true);

  const deep = await rejection(() => handlers.fill({ sessionId, selector: '#deepPage', value: 'x' }));
  assert.match(String(deep), /cannot receive text/i);
  assert.doesNotMatch(
    String(deep),
    /monaco or codemirror/i,
    'a container four levels above an editor is not a rich-editor wrapper, and must not be described as one'
  );

  await sessions.releaseSession(sessionId);
});

// ---------------------------------------------------------------------------
// Cause D: detection could not cross a shadow boundary in either direction
// ---------------------------------------------------------------------------

test('fill writes into a shadow-DOM contenteditable instead of refusing it', async () => {
  const sessionId = await freshSession();

  const body = payload(await handlers.fill({ sessionId, selector: '#shadowEditable', value: 'SHADOWFILL' }));

  // The oracle is the element inside the shadow root, reached explicitly:
  // nothing about the light DOM can see it.
  assert.equal(
    await evaluate<string>(sessionId, "document.getElementById('shadowHost').shadowRoot.getElementById('shadowEditable').textContent"),
    'SHADOWFILL',
    'the write must actually land; this used to throw a focus error and never write at all'
  );
  assert.equal(body.matched, true);

  await sessions.releaseSession(sessionId);
});

test('a no-selector type into a focused shadow editor reads back the editor, not the host', async () => {
  const sessionId = await freshSession();

  await evaluate(
    sessionId,
    "document.getElementById('shadowHost').shadowRoot.getElementById('shadowCmContent').focus()"
  );
  // document.activeElement RETARGETS: the page reports the host, which is a
  // plain div whose own textContent is empty. That is what the old guard and
  // the old readback both saw.
  assert.equal(await evaluate<string>(sessionId, 'document.activeElement.id'), 'shadowHost');

  const body = payload(await handlers.type({ sessionId, text: 'XX' }));

  const oracle = await evaluate<string>(
    sessionId,
    "document.getElementById('shadowHost').shadowRoot.getElementById('shadowCmContent').textContent"
  );
  assert.equal(oracle, 'XXshadowcm', 'the write lands in the shadow editor either way; that was never the bug');
  assert.equal(body.previousValue, 'shadowcm', 'previousValue must be the editor\'s text, not the host\'s empty string');
  assert.equal(body.value, oracle, 'the reported value has to be the text the element that received it now holds');
  assert.equal(body.readbackReliable, false, 'and the marker inside the shadow root still has to be found');

  await sessions.releaseSession(sessionId);
});

test('a rich-editor marker in the light DOM above a shadow host is still found from inside the root', async () => {
  const sessionId = await freshSession();

  const body = payload(await handlers.fill({ sessionId, selector: '#richShadowEditable', value: 'crossed' }));

  assert.equal(
    await evaluate<string>(sessionId, "document.getElementById('richShadowHost').shadowRoot.getElementById('richShadowEditable').textContent"),
    'crossed',
    'the write lands'
  );
  assert.equal(
    body.readbackReliable,
    false,
    'the .cm-editor sits outside the shadow root, so the upward walk has to step out through the host to see it'
  );

  await sessions.releaseSession(sessionId);
});

test('the selector path and the no-selector path describe the same element the same way', async () => {
  const sessionId = await freshSession();

  // One function serves both call shapes now (locator.evaluate passes the
  // element first, page.evaluate passes the argument first). If that ever
  // breaks, one path silently stops detecting anything, which is precisely
  // the failure mode of the two near-identical copies it replaced.
  await evaluate(sessionId, "document.getElementById('cmContent').focus()");
  const viaSelector = payload(await handlers.type({ sessionId, selector: '#cmContent', text: 'a' }));
  await evaluate(sessionId, "document.getElementById('cmContent').focus()");
  const viaFocus = payload(await handlers.type({ sessionId, text: 'b' }));

  assert.equal(viaSelector.readbackReliable, false);
  assert.equal(viaFocus.readbackReliable, false, 'both paths must reach the same verdict about the same element');

  await evaluate(sessionId, "document.getElementById('plainInput').focus()");
  const plainSelector = payload(await handlers.type({ sessionId, selector: '#plainInput', text: 'a' }));
  await evaluate(sessionId, "document.getElementById('plainInput').focus()");
  const plainFocus = payload(await handlers.type({ sessionId, text: 'b' }));

  assert.equal(plainSelector.readbackReliable, true);
  assert.equal(plainFocus.readbackReliable, true);

  await sessions.releaseSession(sessionId);
});

// ---------------------------------------------------------------------------
// Finding 10: multi-match writes, and hover on a selector matching nothing
// ---------------------------------------------------------------------------

test('fill and type refuse a multi-match selector with guidance instead of a raw strict-mode error', async () => {
  const sessionId = await freshSession();

  const filled = await rejection(() => handlers.fill({ sessionId, selector: '.dup', value: 'PWNED' }));
  assert.match(String(filled), /^fill will not write into/, 'the tool that refused has to name itself');
  assert.match(String(filled), /matches 2 elements/);
  assert.match(String(filled), /nth=0|narrow the selector|find/i, 'and say how to get past it');
  assert.doesNotMatch(String(filled), /strict mode violation/, 'Playwright\'s own wording is what this replaces');

  const typed = await rejection(() => handlers.type({ sessionId, selector: '.dup', text: 'PWNED' }));
  assert.match(String(typed), /^type will not write into/);

  // Neither input was written to on the way to the refusal.
  assert.equal(await evaluate<string>(sessionId, "document.getElementById('dupInput').value"), 'one');
  assert.equal(await evaluate<string>(sessionId, "document.getElementById('dupInput2').value"), 'two');

  await sessions.releaseSession(sessionId);
});

test('a single-match selector is unaffected by the multi-match guard', async () => {
  const sessionId = await freshSession();

  const body = payload(await handlers.fill({ sessionId, selector: '#dupInput', value: 'narrowed' }));
  assert.equal(await evaluate<string>(sessionId, "document.getElementById('dupInput').value"), 'narrowed');
  assert.equal(body.matched, true);

  await sessions.releaseSession(sessionId);
});

test('hover on a selector matching nothing explains itself instead of throwing a bare timeout', async () => {
  const sessionId = await freshSession();
  // The wait is Playwright's and is deliberately kept: an element that appears
  // a moment later is still one to hover. Only the explanation was missing, so
  // the timeout is shortened here rather than removed, to keep the suite quick.
  sessions.resolve(sessionId).page.setDefaultTimeout(1200);

  const message = await rejection(() => handlers.hover({ sessionId, selector: '#nothing-here' }));

  assert.notEqual(message, null);
  assert.doesNotMatch(String(message), /^TimeoutError/, 'a raw Playwright timeout is what this replaces');
  assert.match(String(message), /matched no elements/i);
  assert.match(String(message), /find|wait_for/, 'the message has to name what to do next');
  assert.match(String(message), /pointer was not moved/i);

  await sessions.releaseSession(sessionId);
});

test('hover on an element that exists but cannot be reached says which of the two problems it is', async () => {
  const sessionId = await freshSession();
  sessions.resolve(sessionId).page.setDefaultTimeout(1200);

  await evaluate(sessionId, "document.getElementById('plainInput').style.display = 'none'");
  const message = await rejection(() => handlers.hover({ sessionId, selector: '#plainInput' }));

  assert.match(String(message), /could not act on/i);
  assert.match(String(message), /element_box|computed_style/, 'a page problem needs the tools that diagnose a page');
  assert.doesNotMatch(String(message), /matched no elements/i, 'it does match; that is the point of the distinction');

  await sessions.releaseSession(sessionId);
});

// ---------------------------------------------------------------------------
// Finding 3: press_key's note asserted something measurably false
// ---------------------------------------------------------------------------

test('Control+k really deletes text on macOS, and the note does not claim otherwise', async () => {
  const sessionId = await freshSession();

  await evaluate(
    sessionId,
    "(() => { const i = document.getElementById('plainInput'); i.focus(); i.setSelectionRange(5, 5); return true; })()"
  );
  const result = payload(await handlers.press_key({ sessionId, key: 'Control+k' }));

  // The oracle is the input's own value. On macOS Chromium honours the emacs
  // editing bindings, so this really does cut from the caret to end of line.
  const after = await evaluate<string>(sessionId, "document.getElementById('plainInput').value");
  const note = result.note === undefined ? '' : String(result.note);

  if (process.platform === 'darwin') {
    assert.equal(after, 'hello', 'Control+k is not inert here: it deleted the rest of the line');
    assert.notEqual(note, '', 'a Control chord on macOS still gets the modifier note');
    assert.doesNotMatch(
      note,
      /did not trigger a browser built-in editing accelerator/,
      'that claim is measurably false, and it is what made a caller press again and destroy more text'
    );
    assert.doesNotMatch(note, /do nothing at all/, 'the note must not tell the caller the press was a no-op');
    assert.match(note, /Control\+k/, 'it names the binding that destroys text');
    assert.match(note, /read the field back/i, 'and says what to do instead of assuming');
  } else {
    // Control IS this platform's accelerator modifier off macOS, so no note
    // fires at all and the emacs bindings are not in play.
    assert.equal(note, '');
  }

  await sessions.releaseSession(sessionId);
});

test('the modifier note still fires for the case it was built for, and still points at the portable form', async () => {
  const sessionId = await freshSession();

  await evaluate(sessionId, "document.getElementById('plainInput').focus()");
  const result = payload(await handlers.press_key({ sessionId, key: `${process.platform === 'darwin' ? 'Control' : 'Meta'}+a` }));

  assert.match(String(result.note), /ControlOrMeta/, 'the firing logic is unchanged; only the wording was wrong');

  // And the exemption still holds: the portable form gets no note.
  const portable = payload(await handlers.press_key({ sessionId, key: 'ControlOrMeta+a' }));
  assert.equal(portable.note, undefined);

  await sessions.releaseSession(sessionId);
});
