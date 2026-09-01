import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';

import { BrowserManager } from '../src/daemon/browserManager.js';
import { createToolHandlers } from '../src/daemon/tools/handlers.js';
import { SessionStore } from '../src/daemon/sessions.js';
import { getFreePort } from './helpers.js';

const SCRATCH = '/private/tmp/claude-502/-Users-vadym-Projects-acresio/f3591e65-83a7-455a-bc26-043ee94bb791/scratchpad';
const CM5_JS = readFileSync(`${SCRATCH}/cm5.js`, 'utf8');
const CM5_CSS = readFileSync(`${SCRATCH}/cm5.css`, 'utf8');
const ACE_JS = readFileSync(`${SCRATCH}/ace.js`, 'utf8');

/** 400 lines of real text, so a virtualizing editor genuinely cannot render it all. */
const LONG_DOC = Array.from({ length: 400 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n');

const PAGES: Record<string, string> = {
  // A wrapper div whose focused child is an ordinary <input>. No shadow DOM,
  // no editor: the most everyday shape there is.
  '/row': `<!doctype html><html><body>
<div id="row"><label for="f">Name</label><input id="f" value="seed"></div>
</body></html>`,

  // An open shadow root with delegatesFocus, and one without.
  '/shadow': `<!doctype html><html><body>
<div id="host"></div>
<div id="host2"></div>
<script>
  document.getElementById('host').attachShadow({mode:'open', delegatesFocus:true}).innerHTML =
    '<input id="inner" value="seed">';
  document.getElementById('host2').attachShadow({mode:'open'}).innerHTML =
    '<div id="inner2" contenteditable="true">seedce</div>';
</script>
</body></html>`,

  // data-mode-id is one of the four markers. It is a generic-looking attribute
  // name; here it means "dark mode" on an ordinary page wrapper.
  '/modeid': `<!doctype html><html><body>
<div id="app" data-mode-id="dark">
  <form><input id="plain" value="seed"><textarea id="ta">tseed</textarea></form>
</div>
</body></html>`,

  // Acres's real ancestry, plus one more wrapper: the markers now sit THREE
  // levels below the element a caller would name.
  '/deep': `<!doctype html><html><body>
<div id="field"><div data-testid="expression-editor-input"><div class="cm-editor"><div class="cm-scroller"><div id="content" class="cm-content" contenteditable="true">seedcm</div></div></div></div></div>
</body></html>`,

  // A plain comment box (contenteditable, not an editor) that happens to
  // contain a read-only CodeMirror snippet two levels below it.
  '/comment': `<!doctype html><html><body>
<div id="comment" contenteditable="true">Please look at <div class="cm-editor"><div class="cm-content">code</div></div> above.</div>
</body></html>`,

  // Real CodeMirror 5 (class ".CodeMirror", not ".cm-editor") and real Ace.
  '/cm5': `<!doctype html><html><head><style>${CM5_CSS}
  .CodeMirror { height: 200px; }</style></head><body>
<div id="wrap"></div>
<script>${CM5_JS}</script>
<script>
  window.__cm = CodeMirror(document.getElementById('wrap'), { value: ${JSON.stringify(LONG_DOC)}, lineNumbers: true });
</script>
</body></html>`,

  '/ace': `<!doctype html><html><head><style>#editor{height:200px;width:600px;}</style></head><body>
<div id="editor"></div>
<script>${ACE_JS}</script>
<script>
  window.__ace = ace.edit('editor');
  window.__ace.setValue(${JSON.stringify(LONG_DOC)}, -1);
</script>
</body></html>`,

  // Focus moves away partway through a slow type, i.e. AFTER the destination
  // check the round-3 author added and DURING the characters.
  '/latemove': `<!doctype html><html><body>
<input id="a" value="">
<input id="b" value="">
<script>
  var n = 0;
  document.getElementById('a').addEventListener('keydown', function () {
    n += 1;
    if (n === 3) document.getElementById('b').focus();
  });
</script>
</body></html>`
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
  return payload(await handlers.evaluate({ sessionId, expression })).result as T;
}
async function attempt(call: () => Promise<unknown>): Promise<string> {
  try {
    return 'RETURNED ' + JSON.stringify(payload(await call())).slice(0, 1200);
  } catch (err) {
    return 'THREW ' + (err instanceof Error ? err.message : String(err)).slice(0, 500);
  }
}

test('F1: type at a wrapper div whose focused child is a plain <input>', async () => {
  const s = await freshSession('/row');
  await handlers.click({ sessionId: s, selector: '#f' });
  console.log('F1 result:', await attempt(() => handlers.type({ sessionId: s, selector: '#row', text: 'ABC' })));
  console.log('F1 ORACLE input.value =', JSON.stringify(await evaluate<string>(s, "document.getElementById('f').value")));
  console.log('F1 ORACLE row.textContent =', JSON.stringify(await evaluate<string>(s, "document.getElementById('row').textContent")));
  await sessions.releaseSession(s);
});

test('F2: type at an open shadow host (delegatesFocus) whose inner input takes the text', async () => {
  const s = await freshSession('/shadow');
  console.log('F2 result:', await attempt(() => handlers.type({ sessionId: s, selector: '#host', text: 'ABC' })));
  console.log(
    'F2 ORACLE inner.value =',
    JSON.stringify(await evaluate<string>(s, "document.getElementById('host').shadowRoot.getElementById('inner').value"))
  );
  console.log('F2 ORACLE host.textContent =', JSON.stringify(await evaluate<string>(s, "document.getElementById('host').textContent")));
  await sessions.releaseSession(s);
});

test('F2b: type at a shadow host whose inner contenteditable already has focus', async () => {
  const s = await freshSession('/shadow');
  await evaluate(s, "document.getElementById('host2').shadowRoot.getElementById('inner2').focus()");
  console.log('F2b result:', await attempt(() => handlers.type({ sessionId: s, selector: '#host2', text: 'ABC' })));
  console.log(
    'F2b ORACLE inner2.textContent =',
    JSON.stringify(await evaluate<string>(s, "document.getElementById('host2').shadowRoot.getElementById('inner2').textContent"))
  );
  await sessions.releaseSession(s);
});

test('F3: data-mode-id on an ordinary page wrapper', async () => {
  const s = await freshSession('/modeid');
  console.log('F3 fill(#plain):', await attempt(() => handlers.fill({ sessionId: s, selector: '#plain', value: 'hello' })));
  console.log('F3 ORACLE value =', JSON.stringify(await evaluate<string>(s, "document.getElementById('plain').value")));
  console.log('F3 fill(#ta):', await attempt(() => handlers.fill({ sessionId: s, selector: '#ta', value: 'world' })));
  await sessions.releaseSession(s);
});

test('F4: CodeMirror 6 markers three levels below the named element', async () => {
  const s = await freshSession('/deep');
  console.log('F4 type(#field):', await attempt(() => handlers.type({ sessionId: s, selector: '#field', text: 'Z' })));
  console.log('F4 type([data-testid]):', await attempt(() => handlers.type({ sessionId: s, selector: '[data-testid="expression-editor-input"]', text: 'Z' })));
  await sessions.releaseSession(s);
});

test('F5: an ordinary contenteditable comment box containing a CodeMirror two levels below', async () => {
  const s = await freshSession('/comment');
  console.log('F5 fill(#comment):', await attempt(() => handlers.fill({ sessionId: s, selector: '#comment', value: 'plain reply' })));
  console.log('F5 ORACLE textContent =', JSON.stringify(await evaluate<string>(s, "document.getElementById('comment').textContent")));
  await sessions.releaseSession(s);
});

test('F6: REAL CodeMirror 5 with a 400-line document', async () => {
  const s = await freshSession('/cm5');
  const truth = await evaluate<number>(s, 'window.__cm.getValue().length');
  const cls = await evaluate<string>(s, "document.querySelector('.CodeMirror').className");
  const editable = await evaluate<string>(
    s,
    "(function(){var t=document.querySelector('.CodeMirror textarea'); return t? 'textarea' : (document.querySelector('.CodeMirror [contenteditable]')? 'contenteditable':'none');})()"
  );
  console.log('F6 real doc length =', truth, ' wrapper class =', cls, ' input node =', editable);
  console.log('F6 rendered textContent length =', await evaluate<number>(s, "document.querySelector('.CodeMirror').textContent.length"));
  console.log('F6 type(.CodeMirror):', await attempt(() => handlers.type({ sessionId: s, selector: '.CodeMirror', text: 'Z' })));
  console.log('F6 ORACLE cm.getValue().length after =', await evaluate<number>(s, 'window.__cm.getValue().length'));
  await sessions.releaseSession(s);
});

test('F7: REAL Ace with a 400-line document', async () => {
  const s = await freshSession('/ace');
  console.log('F7 real doc length =', await evaluate<number>(s, 'window.__ace.getValue().length'));
  console.log('F7 rendered textContent length =', await evaluate<number>(s, "document.getElementById('editor').textContent.length"));
  console.log('F7 classes =', await evaluate<string>(s, "document.getElementById('editor').className"));
  console.log('F7 type(#editor):', await attempt(() => handlers.type({ sessionId: s, selector: '#editor', text: 'Z' })));
  console.log('F7 ORACLE ace.getValue().length after =', await evaluate<number>(s, 'window.__ace.getValue().length'));
  await sessions.releaseSession(s);
});

test('F8: focus moves partway through the characters, after the destination check', async () => {
  const s = await freshSession('/latemove');
  console.log('F8 result:', await attempt(() => handlers.type({ sessionId: s, selector: '#a', text: 'abcdef', delay: 10 })));
  console.log('F8 ORACLE a =', JSON.stringify(await evaluate<string>(s, "document.getElementById('a').value")));
  console.log('F8 ORACLE b =', JSON.stringify(await evaluate<string>(s, "document.getElementById('b').value")));
  await sessions.releaseSession(s);
});
