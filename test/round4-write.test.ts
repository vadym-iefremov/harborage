import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';

import { BrowserManager } from '../src/daemon/browserManager.js';
import { createToolHandlers } from '../src/daemon/tools/handlers.js';
import { SessionStore } from '../src/daemon/sessions.js';
import { getFreePort } from './helpers.js';

/**
 * Round 4: an adversarial pass found that round 3 had traded one wrong
 * question for another. The guard stopped asking what an element's TAG was and
 * started asking whether `isContentEditable` was true on it, and that property
 * is INHERITED: it reports true on every descendant of an editing host, while
 * a selection is scoped to the HOST. So a write aimed at a widget inside a
 * WYSIWYG region deleted the whole region, and reported matched: true where
 * the original at least said matched: false.
 *
 * The question these tests pin is the one that actually matters: if a deletion
 * happens here, what does it destroy? A form control scopes it to its own
 * value. An editing host scopes it to itself. Anything else scopes it to
 * something larger than was named, and must be refused.
 *
 * Every oracle is read from the page: the element list the page still has, the
 * text a region still holds, the value of the control that really received the
 * characters. Two fixtures below exist only to prove the harm is reachable
 * before the guard is asserted to prevent it, because a guard that refuses
 * something harmless proves nothing.
 *
 * On the editor fixtures: the markers here are the ones real instances were
 * measured to carry, but the instances themselves are not vendored, for the
 * reason round 2 gave and which still holds. What WAS measured against real
 * libraries, each holding the same 400-line, 19889-character document:
 *
 *   CodeMirror 5  `.CodeMirror`   1191 characters read back, gutter line
 *                                 numbers interleaved into the text
 *   Ace           `.ace_editor`   1707 read back, including glyphs from its
 *                                 hidden character-measurement layer
 *   Quill 2.0.2   `.ql-editor`    all 19489 read back and every line break
 *                                 gone, inside `.ql-container`
 *   ProseMirror   `.ProseMirror`  same, and the same node TipTap renders
 *   Lexical       `[data-lexical-editor]`  same
 *
 * Slate's `[data-slate-editor]` was confirmed in slate-react's own bundle
 * rather than instantiated, which needs React.
 */
const CE_REGION = `
<div id="page" contenteditable="true">
  <div id="canvas">
    <div class="node" tabindex="0" data-id="n1">Node one</div>
    <div class="node" tabindex="0" data-id="n2">Node two</div>
    <div class="node" tabindex="0" data-id="n3">Node three</div>
  </div>
  <p id="doc">IMPORTANT USER CONTENT THAT MUST SURVIVE</p>
</div>`;

const PAGES: Record<string, string> = {
  // A focusable widget inside an editing host. Clicking the widget focuses the
  // REGION, not the widget, which is the half of this that is easy to miss.
  '/ce-region': `<!doctype html><html><body>${CE_REGION}
<script>
  document.getElementById('canvas').addEventListener('keydown', function (e) {
    if (e.key !== 'Delete' && e.key !== 'Backspace') return;
    var f = document.activeElement;
    if (f && f.classList && f.classList.contains('node')) f.remove();
  });
</script></body></html>`,

  '/ce-body': `<!doctype html><html><body contenteditable="true">
<h1 id="h">PAGE TITLE</h1><p id="doc">IMPORTANT USER CONTENT THAT MUST SURVIVE</p>
</body></html>`,

  '/designmode': `<!doctype html><html><body>
<div id="canvas"><div class="node" tabindex="0" data-id="n2">Node two</div></div>
<p id="doc">IMPORTANT USER CONTENT THAT MUST SURVIVE</p>
<script>document.designMode = 'on';</script></body></html>`,

  // An ordinary global shortcut handler that moves focus on the accelerator
  // chord: the time-of-check-to-time-of-use window the old select-all left open.
  '/focus-steal': `<!doctype html><html><body>
<input id="field" value="seed">
<div id="canvas"><div class="node" tabindex="0" data-id="n1">One</div><div class="node" tabindex="0" data-id="n2">Two</div></div>
<script>
  document.getElementById('canvas').addEventListener('keydown', function (e) {
    if (e.key !== 'Delete' && e.key !== 'Backspace') return;
    var f = document.activeElement;
    if (f && f.classList && f.classList.contains('node')) f.remove();
  });
  window.addEventListener('keydown', function (e) {
    if (e.key === 'a' && (e.metaKey || e.ctrlKey)) document.querySelector('[data-id="n2"]').focus();
  }, true);
</script></body></html>`,

  // One element per editor family, carrying the marker each real instance was
  // measured to carry, plus a bare data-mode-id wrapper that means "dark mode"
  // and must NOT poison the writes underneath it.
  '/editors': `<!doctype html><html><body data-mode-id="dark">
<input id="plain" value="seed">
<textarea id="ta">seed</textarea>
<div class="CodeMirror"><div id="cm5" contenteditable="true">cm5</div></div>
<div class="ace_editor"><div id="ace" contenteditable="true">ace</div></div>
<div class="ql-container"><div id="quill" class="ql-editor" contenteditable="true">quill</div></div>
<div id="pm" class="ProseMirror" contenteditable="true">pm</div>
<div id="lexical" data-lexical-editor="true" contenteditable="true">lexical</div>
<div id="slate" data-slate-editor="true" contenteditable="true">slate</div>
</body></html>`,

  // Markers far below the named element, and a panel holding both an editor
  // and an ordinary input.
  '/deep': `<!doctype html><html><body>
<div id="outer"><div><div><div><div><div><div><div><div><div><div><div class="cm-editor"><div id="deepContent" class="cm-content" contenteditable="true">seed</div></div></div></div></div></div></div></div></div></div></div></div>
<div id="panel"><div class="row"><div class="cm-editor"><div class="cm-content" contenteditable="true">snippet</div></div></div><input id="panelInput" value="seed"></div>
</body></html>`,

  // The three shapes where "the caret is inside the target" does not mean the
  // target's readback covers it.
  '/covers': `<!doctype html><html><body>
<div id="row">Name <input id="f" value="seed"></div>
<div id="host"></div>
<div id="host2"></div>
<script>
  var r = document.getElementById('host').attachShadow({ mode: 'open', delegatesFocus: true });
  r.innerHTML = '<input id="inner" value="">';
  var r2 = document.getElementById('host2').attachShadow({ mode: 'open' });
  r2.innerHTML = '<div id="inner2" contenteditable="true">seedce</div>';
</script></body></html>`,

  '/locked': `<!doctype html><html><body>
<input id="ro" value="locked" readonly>
<input id="off" value="off" disabled>
</body></html>`,

  // Focus leaves partway through a slow type, i.e. after the destination check
  // and during the characters.
  '/latemove': `<!doctype html><html><body>
<input id="a" value=""><input id="b" value="">
<script>
  document.getElementById('a').addEventListener('input', function () {
    if (this.value.length >= 2) document.getElementById('b').focus();
  });
</script></body></html>`,

  // The element the locator points at is removed by the page as a result of
  // the write itself, so the readback afterwards cannot resolve.
  '/vanishing': `<!doctype html><html><body>
<input id="ghost" value="">
<script>
  document.getElementById('ghost').addEventListener('input', function () { this.remove(); });
</script></body></html>`
};

let server: Server;
let baseUrl: string;
let browserManager: BrowserManager;
let sessions: SessionStore;
let handlers: ReturnType<typeof createToolHandlers>;

before(async () => {
  server = createServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(PAGES[(req.url ?? '/').split('?')[0]] ?? '<!doctype html><html><body>none</body></html>');
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

async function freshSession(path: string): Promise<string> {
  const { sessionId } = await sessions.createSession();
  await handlers.navigate({ sessionId, url: baseUrl + path });
  return sessionId;
}

function payload(result: unknown): Record<string, unknown> {
  return (result as { structuredContent: Record<string, unknown> }).structuredContent;
}

async function evaluate<T>(sessionId: string, expression: string): Promise<T> {
  const result = await handlers.evaluate({ sessionId, expression });
  return payload(result).result as T;
}

async function rejection(call: () => Promise<unknown>): Promise<string | null> {
  try {
    await call();
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** The whole editing region's text, whitespace-collapsed, which is the oracle for "was it wiped". */
function regionText(sessionId: string): Promise<string> {
  return evaluate<string>(sessionId, "document.getElementById('page').textContent.replace(/\\s+/g, ' ').trim()");
}

// ---------------------------------------------------------------------------
// isContentEditable is inherited; a selection is scoped to the editing host
// ---------------------------------------------------------------------------

test('clicking a widget inside a contenteditable region focuses the REGION, and Delete there really wipes it', async () => {
  const sessionId = await freshSession('/ce-region');

  // This test exists so the guards below mean something. Both halves are
  // measured, and both were surprises worth pinning: Chromium does not focus
  // the widget the click landed on, and the deletion that follows is scoped to
  // the whole region rather than to anything the caller could have named.
  await handlers.click({ sessionId, selector: '[data-id="n2"]' });
  assert.equal(
    await evaluate<string>(sessionId, 'document.activeElement.id'),
    'page',
    'the click focuses the editing host, not the widget with the tabindex'
  );

  assert.match(await regionText(sessionId), /IMPORTANT USER CONTENT/);
  await handlers.press_key({ sessionId, key: 'ControlOrMeta+a' });
  await handlers.press_key({ sessionId, key: 'Delete' });
  // Chromium leaves one container element behind rather than emptying the
  // subtree exactly, which is beside the point: the user's content is gone and
  // most of the nodes with it. Measured on this fixture: three nodes and 68
  // characters before, one node and nothing readable after.
  assert.ok(
    (await evaluate<number>(sessionId, "document.querySelectorAll('#canvas .node').length")) < 3,
    'nodes really are destroyed this way'
  );
  assert.doesNotMatch(
    await regionText(sessionId),
    /IMPORTANT USER CONTENT/,
    'the region really can be emptied this way, or the guards below prove nothing'
  );

  await sessions.releaseSession(sessionId);
});

test('type with clear and no selector refuses when the caret sits in an editing region nothing named', async () => {
  const sessionId = await freshSession('/ce-region');
  await handlers.click({ sessionId, selector: '[data-id="n2"]' });
  const before = await regionText(sessionId);

  const message = await rejection(() => handlers.type({ sessionId, text: 'PWNED', clear: true }));

  assert.notEqual(message, null, 'this used to go through and take the whole region with it');
  assert.match(String(message), /will not clear/i);
  assert.match(String(message), /id="page"/, 'the refusal has to name the region so the retry is one argument away');
  assert.match(String(message), /nothing was cleared/i);

  assert.equal(await regionText(sessionId), before, 'the region must be untouched');
  assert.equal(await evaluate<number>(sessionId, "document.querySelectorAll('#canvas .node').length"), 3);

  await sessions.releaseSession(sessionId);
});

test('type with no selector and no clear still works in that region, because nothing is deleted', async () => {
  const sessionId = await freshSession('/ce-region');
  await handlers.click({ sessionId, selector: '[data-id="n2"]' });

  const body = payload(await handlers.type({ sessionId, text: 'Z' }));

  assert.match(await regionText(sessionId), /Z/, 'an insertion has no blast radius, so it is not refused');
  assert.equal(await evaluate<number>(sessionId, "document.querySelectorAll('#canvas .node').length"), 3);
  assert.equal(typeof body.value, 'string');

  await sessions.releaseSession(sessionId);
});

test('fill aimed at a widget inside an editing region refuses and names the host it would have destroyed', async () => {
  const sessionId = await freshSession('/ce-region');
  const before = await regionText(sessionId);

  const message = await rejection(() => handlers.fill({ sessionId, selector: '[data-id="n2"]', value: 'REPLACED' }));

  assert.match(String(message), /sits inside a contenteditable region but is not the editable element itself/i);
  assert.match(String(message), /scoped to the editing host/i);
  assert.match(String(message), /id="page"/, 'the host is what would have been destroyed, so it has to be named');

  assert.equal(await regionText(sessionId), before);
  assert.equal(await evaluate<number>(sessionId, "document.querySelectorAll('#canvas .node').length"), 3);

  await sessions.releaseSession(sessionId);
});

test('type with a selector and clear aimed at a widget inside an editing region refuses the same way', async () => {
  const sessionId = await freshSession('/ce-region');
  const before = await regionText(sessionId);

  const message = await rejection(() => handlers.type({ sessionId, selector: '[data-id="n2"]', text: 'X', clear: true }));

  assert.match(String(message), /is not the editable element itself/i);
  assert.equal(await regionText(sessionId), before, 'the clear routes through the same guard fill uses');

  await sessions.releaseSession(sessionId);
});

test('fill and type refuse a contenteditable body instead of replacing the whole page', async () => {
  const sessionId = await freshSession('/ce-body');
  const before = await evaluate<string>(sessionId, "document.body.textContent.replace(/\\s+/g, ' ').trim()");
  assert.match(before, /IMPORTANT USER CONTENT/);

  const filled = await rejection(() => handlers.fill({ sessionId, selector: 'body', value: 'WIPED' }));
  assert.match(String(filled), /will not replace the contents of <body>/i);
  assert.match(String(filled), /entire page/i);
  assert.equal(await evaluate<string>(sessionId, "document.body.textContent.replace(/\\s+/g, ' ').trim()"), before);

  const typed = await rejection(() => handlers.type({ sessionId, selector: 'body', text: 'X', clear: true }));
  assert.match(String(typed), /will not replace the contents of <body>/i);
  assert.equal(await evaluate<string>(sessionId, "document.body.textContent.replace(/\\s+/g, ' ').trim()"), before);

  await sessions.releaseSession(sessionId);
});

test('designMode makes every element inherit editability, and a write is still refused', async () => {
  const sessionId = await freshSession('/designmode');
  const before = await evaluate<string>(sessionId, "document.body.textContent.replace(/\\s+/g, ' ').trim()");

  assert.equal(
    await evaluate<boolean>(sessionId, "document.querySelector('[data-id=\"n2\"]').isContentEditable"),
    true,
    'designMode is what makes the inherited property true here, with no contenteditable attribute anywhere'
  );

  const message = await rejection(() => handlers.fill({ sessionId, selector: '[data-id="n2"]', value: 'REPLACED' }));
  assert.match(String(message), /is not the editable element itself|cannot receive text/i);
  assert.equal(await evaluate<string>(sessionId, "document.body.textContent.replace(/\\s+/g, ' ').trim()"), before);
  assert.equal(await evaluate<number>(sessionId, "document.querySelectorAll('#canvas .node').length"), 1);

  await sessions.releaseSession(sessionId);
});

test('a page that moves focus on the accelerator chord can no longer redirect the deletion', async () => {
  const sessionId = await freshSession('/focus-steal');
  await handlers.click({ sessionId, selector: '#field' });

  // The old path pressed the platform select-all several round trips after the
  // guard had checked what was focused. This page moves focus on that very
  // chord, and the Delete that followed removed a canvas node while the field
  // was untouched and the result blamed the page for rewriting the input.
  const body = payload(await handlers.type({ sessionId, text: 'hello', clear: true }));

  assert.equal(await evaluate<string>(sessionId, "document.getElementById('field').value"), 'hello');
  assert.equal(
    await evaluate<number>(sessionId, "document.querySelectorAll('#canvas .node').length"),
    2,
    'no node may be deleted: the selection is scoped to the field and set in the same round trip that checks it'
  );
  assert.equal(body.matched, true);

  await sessions.releaseSession(sessionId);
});

// ---------------------------------------------------------------------------
// Which editors the marker list knows about
// ---------------------------------------------------------------------------

test('every editor family that defeats a textContent readback is recognised', async () => {
  const sessionId = await freshSession('/editors');

  for (const [selector, family] of [
    ['#cm5', 'virtualizing'],
    ['#ace', 'virtualizing'],
    ['#quill', 'rich-text'],
    ['#pm', 'rich-text'],
    ['#lexical', 'rich-text'],
    ['#slate', 'rich-text']
  ] as const) {
    const body = payload(await handlers.fill({ sessionId, selector, value: 'x' }));
    assert.equal(body.readbackReliable, false, `${selector} must not be vouched for`);
    assert.equal(body.matched, undefined, `${selector} must claim neither true nor false`);
    assert.match(String(body.note), new RegExp(family, 'i'), `${selector} must get the message that fits it`);
  }

  await sessions.releaseSession(sessionId);
});

test('a bare data-mode-id wrapper no longer poisons every write beneath it', async () => {
  const sessionId = await freshSession('/editors');

  // data-mode-id used to be listed unqualified. It is a generic attribute
  // name, and on this page it means "dark mode" on the body. Every write under
  // it, plain inputs included, came back readbackReliable: false advising
  // monaco.editor.getModels(). The upward walk is 8 hops, so there was no
  // escaping it from anywhere on such a page.
  const input = payload(await handlers.fill({ sessionId, selector: '#plain', value: 'hello' }));
  assert.equal(input.readbackReliable, true);
  assert.equal(input.matched, true);
  assert.equal(await evaluate<string>(sessionId, "document.getElementById('plain').value"), 'hello');

  const area = payload(await handlers.fill({ sessionId, selector: '#ta', value: 'world' }));
  assert.equal(area.readbackReliable, true);
  assert.equal(area.matched, true);

  await sessions.releaseSession(sessionId);
});

// ---------------------------------------------------------------------------
// How far the marker search reaches
// ---------------------------------------------------------------------------

test('a marker anywhere below the named element is found, not just within a level budget', async () => {
  const sessionId = await freshSession('/deep');

  // A two-level budget was fitted to one wrapper on the Acres inspector and
  // landed one level short of Acres's own outer test ids. The question is not
  // how close the editor is: it is whether the text about to be read back
  // contains an editor's render, and at eleven levels down it still does.
  await evaluate(sessionId, "document.getElementById('deepContent').focus()");
  const body = payload(await handlers.type({ sessionId, selector: '#outer', text: 'Z' }));

  assert.equal(body.readbackReliable, false);
  assert.equal(body.matched, undefined);

  await sessions.releaseSession(sessionId);
});

test('a plain input is not flagged just because a panel elsewhere on the page holds an editor', async () => {
  const sessionId = await freshSession('/deep');

  const plain = payload(await handlers.fill({ sessionId, selector: '#panelInput', value: 'hello' }));
  assert.equal(plain.readbackReliable, true, 'the input has no editor in its own subtree, so its readback is honest');
  assert.equal(plain.matched, true);

  // Its containing panel is a different matter, and flagging it is the honest
  // answer rather than an over-correction: the panel's textContent really does
  // include the editor's truncated render.
  await evaluate(sessionId, "document.querySelector('#panel .cm-content').focus()");
  const panel = payload(await handlers.type({ sessionId, selector: '#panel', text: 'Z' }));
  assert.equal(panel.readbackReliable, false);

  await sessions.releaseSession(sessionId);
});

// ---------------------------------------------------------------------------
// "The caret is inside the target" is not "the target's readback covers it"
// ---------------------------------------------------------------------------

test('type at a wrapper whose focused child is a form control does not claim the readback covers it', async () => {
  const sessionId = await freshSession('/covers');
  await evaluate(sessionId, "document.getElementById('f').focus()");

  const body = payload(await handlers.type({ sessionId, selector: '#row', text: 'ABC' }));

  // The oracle: a form control keeps its text in .value, which is never part
  // of an ancestor's textContent.
  // Where the caret lands inside the control is the browser's call, so the
  // oracle is that the characters are in THAT control, not the order.
  assert.match(await evaluate<string>(sessionId, "document.getElementById('f').value"), /ABC/);
  assert.equal(await evaluate<string>(sessionId, "document.getElementById('row').textContent.trim()"), 'Name');

  assert.equal(body.matched, undefined, 'a readback blind to the write cannot answer "matched"');
  assert.match(String(body.note), /does NOT cover it/);
  assert.match(String(body.note), /id="f"/);

  await sessions.releaseSession(sessionId);
});

test('type at a shadow host with delegatesFocus does not claim the readback covers the inner control', async () => {
  const sessionId = await freshSession('/covers');

  const body = payload(await handlers.type({ sessionId, selector: '#host', text: 'ABC' }));

  assert.equal(
    await evaluate<string>(sessionId, "document.getElementById('host').shadowRoot.getElementById('inner').value"),
    'ABC',
    'delegatesFocus sends the characters into the shadow tree'
  );
  assert.equal(await evaluate<string>(sessionId, "document.getElementById('host').textContent"), '');
  assert.equal(body.value, '', 'the host really does read back empty');
  assert.equal(body.matched, undefined);
  assert.match(String(body.note), /does NOT cover it/);

  await sessions.releaseSession(sessionId);
});

test('type at a shadow host whose inner contenteditable has focus says the same', async () => {
  const sessionId = await freshSession('/covers');
  await evaluate(sessionId, "document.getElementById('host2').shadowRoot.getElementById('inner2').focus()");

  const body = payload(await handlers.type({ sessionId, selector: '#host2', text: 'ABC' }));

  assert.equal(
    await evaluate<string>(sessionId, "document.getElementById('host2').shadowRoot.getElementById('inner2').textContent"),
    'ABCseedce'
  );
  assert.equal(body.matched, undefined);
  assert.match(String(body.note), /does NOT cover it/);

  await sessions.releaseSession(sessionId);
});

test('a wrapper whose focused child really is covered still claims matched', async () => {
  const sessionId = await freshSession('/deep');
  await evaluate(sessionId, "document.getElementById('deepContent').focus()");

  // The control for the three above: a contenteditable child in the same tree
  // IS part of its ancestor's textContent, so the comparison still means
  // something and the note must say so rather than the opposite.
  const body = payload(await handlers.type({ sessionId, selector: '#outer', text: 'Z' }));
  assert.match(String(body.note), /does cover that child/);

  await sessions.releaseSession(sessionId);
});

// ---------------------------------------------------------------------------
// Saying only what was measured
// ---------------------------------------------------------------------------

test('a zero-match failure reports the count it took at the start, not one it invented', async () => {
  const sessionId = await freshSession('/locked');
  sessions.resolve(sessionId).page.setDefaultTimeout(1200);

  const message = await rejection(() => handlers.fill({ sessionId, selector: '#nothing', value: 'x' }));
  assert.match(String(message), /matched 0 element\(s\) when the call started/);
  assert.match(String(message), /matches no elements now/);

  await sessions.releaseSession(sessionId);
});

test('a failure that arrives after the write does not claim nothing was written', async () => {
  const sessionId = await freshSession('/vanishing');
  sessions.resolve(sessionId).page.setDefaultTimeout(1200);

  // The page removes the input as a result of the write itself, so the readback
  // afterwards cannot resolve the locator. The old message said the selector
  // "matched no elements when the call started" and that "Nothing was written",
  // both false, on a call that had counted one match and then changed the page.
  const message = await rejection(() => handlers.fill({ sessionId, selector: '#ghost', value: 'landed' }));

  assert.notEqual(message, null);
  assert.match(String(message), /matched 1 element\(s\) when the call started/);
  assert.match(String(message), /AFTER the write was attempted/i);
  assert.doesNotMatch(String(message), /Nothing was written/);

  await sessions.releaseSession(sessionId);
});

// ---------------------------------------------------------------------------
// Focus that moves during the characters, and controls that take none
// ---------------------------------------------------------------------------

test('type reports a caret that moves away while the characters are still going', async () => {
  const sessionId = await freshSession('/latemove');

  const body = payload(await handlers.type({ sessionId, selector: '#a', text: 'abcdef', delay: 10 }));

  // The oracle: the two fields split the string between them.
  assert.equal(await evaluate<string>(sessionId, "document.getElementById('a').value"), 'ab');
  assert.equal(await evaluate<string>(sessionId, "document.getElementById('b').value"), 'cdef');

  assert.equal(body.matched, undefined, 'four characters went somewhere else, so "matched" has no answer');
  assert.match(String(body.note), /moved away .* WHILE the characters were being typed/i);
  assert.match(String(body.note), /id="b"/, 'and where they went has to be named');

  await sessions.releaseSession(sessionId);
});

test('fill refuses a readonly or disabled control at once instead of waiting out the timeout', async () => {
  const sessionId = await freshSession('/locked');
  sessions.resolve(sessionId).page.setDefaultTimeout(1200);

  const readonly = await rejection(() => handlers.fill({ sessionId, selector: '#ro', value: 'x' }));
  assert.match(String(readonly), /it is readonly/i);
  assert.doesNotMatch(String(readonly), /hidden, still animating/, 'that explanation was never true for a readonly input');
  assert.equal(await evaluate<string>(sessionId, "document.getElementById('ro').value"), 'locked');

  const disabled = await rejection(() => handlers.fill({ sessionId, selector: '#off', value: 'x' }));
  assert.match(String(disabled), /it is disabled/i);
  assert.equal(await evaluate<string>(sessionId, "document.getElementById('off').value"), 'off');

  await sessions.releaseSession(sessionId);
});

test('type with no selector says readonly plainly when the focused control is one', async () => {
  const sessionId = await freshSession('/locked');
  await evaluate(sessionId, "document.getElementById('ro').focus()");

  const message = await rejection(() => handlers.type({ sessionId, text: 'x', clear: true }));
  assert.match(String(message), /it is readonly/i);
  assert.equal(await evaluate<string>(sessionId, "document.getElementById('ro').value"), 'locked');

  await sessions.releaseSession(sessionId);
});
