import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';

import { BrowserManager } from '../src/daemon/browserManager.js';
import { createToolHandlers } from '../src/daemon/tools/handlers.js';
import { SessionStore } from '../src/daemon/sessions.js';
import { getFreePort } from './helpers.js';

// The listener fires ONLY on the exact state selectElementContents leaves
// behind: a non-collapsed selection whose ends are both inside #field. That
// pins it to the window between the Range being verified and Delete arriving.
const THIEF_SCRIPT = `
  document.addEventListener('selectionchange', function () {
    var sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    var r = sel.getRangeAt(0);
    var f = document.getElementById('field');
    if (r.collapsed) return;
    if (!f.contains(r.startContainer) || !f.contains(r.endContainer)) return;
    window.__fired = (window.__fired || 0) + 1;
    ACTION
  });`;

const PAGES: Record<string, string> = {
  // Widen the selection to a much larger element, in the pinned window.
  '/widen': `<!doctype html><html><body>
<div id="field" contenteditable="true">ORIGINAL</div>
<div id="wide" contenteditable="true"><p id="w1">WIDE ONE</p><p id="w2">WIDE TWO</p><p id="w3">WIDE THREE</p></div>
<script>${THIEF_SCRIPT.replace(
  'ACTION',
  `var sel2 = window.getSelection(); sel2.removeAllRanges();
   var r2 = document.createRange(); r2.selectNodeContents(document.getElementById('wide'));
   sel2.addRange(r2);`
)}</script>
</body></html>`,

  // Collapse the selection in the pinned window.
  '/collapse': `<!doctype html><html><body>
<div id="field" contenteditable="true">ORIGINALCONTENT</div>
<script>${THIEF_SCRIPT.replace(
  'ACTION',
  "window.getSelection().collapse(document.getElementById('field').firstChild, 0);"
)}</script>
</body></html>`,

  // Drop the selection entirely in the pinned window.
  '/drop': `<!doctype html><html><body>
<div id="field" contenteditable="true">ORIGINALCONTENT</div>
<script>${THIEF_SCRIPT.replace('ACTION', 'window.getSelection().removeAllRanges();')}</script>
</body></html>`,

  // The same window, but for the NO-SELECTOR clear path, whose selection is
  // placed by selectFocusedContents.
  '/widen-focused': `<!doctype html><html><body>
<div id="field" contenteditable="true">ORIGINAL</div>
<div id="wide" contenteditable="true"><p>WIDE ONE</p><p>WIDE TWO</p><p>WIDE THREE</p></div>
<script>${THIEF_SCRIPT.replace(
  'ACTION',
  `var sel2 = window.getSelection(); sel2.removeAllRanges();
   var r2 = document.createRange(); r2.selectNodeContents(document.getElementById('wide'));
   sel2.addRange(r2);`
)}</script>
</body></html>`,

  // An editing host whose subtree contains an editor, typed into without a
  // clear so the marker is still there when the readback runs.
  '/comment-with-editor': `<!doctype html><html><body>
<div id="comment" contenteditable="true">See <span class="cm-editor"><span class="cm-content">code</span></span> here.</div>
<div id="panel"><div><div><div><input id="deepPlain" value="seed"></div></div></div><div class="ProseMirror" contenteditable="true">rt</div></div>
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
  const a = server.address();
  baseUrl = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
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

async function fresh(path: string): Promise<string> {
  const { sessionId } = await sessions.createSession();
  await handlers.navigate({ sessionId, url: baseUrl + path });
  return sessionId;
}
function payload(r: unknown): Record<string, unknown> {
  return (r as { structuredContent: Record<string, unknown> }).structuredContent;
}
async function ev<T>(s: string, e: string): Promise<T> {
  return payload(await handlers.evaluate({ sessionId: s, expression: e })).result as T;
}
async function attempt(call: () => Promise<unknown>): Promise<string> {
  try {
    return 'RETURNED ' + JSON.stringify(payload(await call())).slice(0, 600);
  } catch (err) {
    return 'THREW ' + (err instanceof Error ? err.message : String(err)).slice(0, 400);
  }
}

test('S1: selection widened inside the verify-to-Delete window (fill)', async () => {
  const s = await fresh('/widen');
  const snap = "({field: document.getElementById('field').textContent, wide: document.getElementById('wide').textContent, fired: window.__fired||0})";
  console.log('S1 before:', JSON.stringify(await ev(s, snap)));
  console.log('S1 result:', await attempt(() => handlers.fill({ sessionId: s, selector: '#field', value: 'NEW' })));
  console.log('S1 after :', JSON.stringify(await ev(s, snap)));
  await sessions.releaseSession(s);
});

test('S2: selection collapsed inside the window (fill)', async () => {
  const s = await fresh('/collapse');
  console.log('S2 result:', await attempt(() => handlers.fill({ sessionId: s, selector: '#field', value: 'NEW' })));
  console.log('S2 ORACLE field =', JSON.stringify(await ev(s, "document.getElementById('field').textContent")), 'fired=', await ev(s, 'window.__fired||0'));
  await sessions.releaseSession(s);
});

test('S3: selection dropped inside the window (fill)', async () => {
  const s = await fresh('/drop');
  console.log('S3 result:', await attempt(() => handlers.fill({ sessionId: s, selector: '#field', value: 'NEW' })));
  console.log('S3 ORACLE field =', JSON.stringify(await ev(s, "document.getElementById('field').textContent")), 'fired=', await ev(s, 'window.__fired||0'));
  await sessions.releaseSession(s);
});

test('S4: selection widened inside the window, no-selector clear path', async () => {
  const s = await fresh('/widen-focused');
  await handlers.click({ sessionId: s, selector: '#field' });
  const snap = "({field: document.getElementById('field').textContent, wide: document.getElementById('wide').textContent, fired: window.__fired||0})";
  console.log('S4 before:', JSON.stringify(await ev(s, snap)));
  console.log('S4 result:', await attempt(() => handlers.type({ sessionId: s, text: 'NEW', clear: true })));
  console.log('S4 after :', JSON.stringify(await ev(s, snap)));
  await sessions.releaseSession(s);
});

test('S5: subtree marker search over-fire on ordinary targets', async () => {
  const s = await fresh('/comment-with-editor');
  console.log('S5 type(#comment):', await attempt(() => handlers.type({ sessionId: s, selector: '#comment', text: 'Z' })));
  console.log('S5 type(#deepPlain):', await attempt(() => handlers.type({ sessionId: s, selector: '#deepPlain', text: 'Z' })));
  console.log('S5 type(#panel):', await attempt(() => handlers.type({ sessionId: s, selector: '#panel', text: 'Z' })));
  console.log('S5 fill(#comment):', await attempt(() => handlers.fill({ sessionId: s, selector: '#comment', value: 'plain' })));
  await sessions.releaseSession(s);
});
