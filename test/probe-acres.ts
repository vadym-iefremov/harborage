import { after, before, test } from 'node:test';

import { BrowserManager } from '../src/daemon/browserManager.js';
import { createToolHandlers } from '../src/daemon/tools/handlers.js';
import { SessionStore } from '../src/daemon/sessions.js';
import { getFreePort } from './helpers.js';

const ACRES = 'http://localhost:5173';
const SCRATCH_FLOW = 'f68a777a-c0d7-4fa6-bba2-61d9dead0a2e';
const SCRATCH_WORKBOOK = '0d9846ff-a345-4b04-8336-2a18602744bd';

let browserManager: BrowserManager;
let sessions: SessionStore;
let handlers: ReturnType<typeof createToolHandlers>;

before(async () => {
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
});

function payload(result: unknown): Record<string, unknown> {
  return (result as { structuredContent: Record<string, unknown> }).structuredContent;
}
async function evaluate<T>(sessionId: string, expression: string): Promise<T> {
  return payload(await handlers.evaluate({ sessionId, expression })).result as T;
}
async function attempt(call: () => Promise<unknown>): Promise<string> {
  try {
    return 'RETURNED ' + JSON.stringify(payload(await call())).slice(0, 1400);
  } catch (err) {
    return 'THREW ' + (err instanceof Error ? err.message : String(err)).slice(0, 400);
  }
}
function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

test('A0: map the real Acres app', async () => {
  const { sessionId } = await sessions.createSession();
  await handlers.navigate({ sessionId, url: ACRES });
  await sleep(2500);

  console.log('A0 store keys:', await evaluate(sessionId, 'Object.keys(window.__acresStore.getState()).join(",")'));

  await evaluate(sessionId, `window.__acresStore.getState().openWorkbook(${JSON.stringify(SCRATCH_WORKBOOK)})`).catch(
    e => console.log('A0 openWorkbook failed:', String(e).slice(0, 200))
  );
  await sleep(2000);
  console.log('A0 nodes:', await evaluate(sessionId, 'JSON.stringify((window.__acresStore.getState().nodes||[]).map(n=>n.id))'));
  console.log('A0 testids:', await evaluate(sessionId, "JSON.stringify(Array.from(new Set(Array.from(document.querySelectorAll('[data-testid]')).map(e=>e.getAttribute('data-testid')))).slice(0,60))"));
  await sessions.releaseSession(sessionId);
});

const NODE_IDS = 'JSON.stringify((window.__acresStore.getState().nodes||[]).map(n=>n.id))';

async function openScratch(): Promise<string> {
  const { sessionId } = await sessions.createSession();
  await handlers.navigate({ sessionId, url: ACRES });
  await sleep(2500);
  await evaluate(sessionId, `window.__acresStore.getState().openWorkbook(${JSON.stringify(SCRATCH_WORKBOOK)})`);
  await sleep(2000);
  return sessionId;
}

test('A1: click a real React Flow node, then type with clear and no selector', async () => {
  const s = await openScratch();
  await handlers.click({ sessionId: s, selector: '[data-testid="node-dkqn4dk4kv"]' });
  await sleep(500);
  console.log('A1 activeElement:', await evaluate(s, '({tag:document.activeElement.tagName, cls:(document.activeElement.getAttribute("class")||"").slice(0,60), ce:document.activeElement.isContentEditable, ti:document.activeElement.getAttribute("tabindex")})'));
  console.log('A1 nodes before:', await evaluate(s, NODE_IDS));
  console.log('A1 result:', await attempt(() => handlers.type({ sessionId: s, text: 'PWNED', clear: true })));
  await sleep(800);
  console.log('A1 nodes after :', await evaluate(s, NODE_IDS));
  await sessions.releaseSession(s);
});

test('A2: the real expression editor ancestry and readback', async () => {
  const s = await openScratch();
  await handlers.click({ sessionId: s, selector: '[data-testid="node-dkqn4dk4kv"]' });
  await sleep(1200);
  console.log('A2 sidebar testids:', await evaluate(s, "JSON.stringify(Array.from(document.querySelectorAll('[data-testid=\"right-sidebar\"] [data-testid]')).map(e=>e.getAttribute('data-testid')).slice(0,40))"));
  console.log('A2 cm present:', await evaluate(s, "({editors: document.querySelectorAll('.cm-editor').length, content: document.querySelectorAll('.cm-content').length, exprInput: document.querySelectorAll('[data-testid=\"expression-editor-input\"]').length})"));
  console.log('A2 ancestry of .cm-content:', await evaluate(s, "(function(){var n=document.querySelector('.cm-content'); if(!n) return 'none'; var out=[]; var i=0; while(n && i<10){ out.push(n.tagName.toLowerCase()+ (n.getAttribute('data-testid')?('[data-testid='+n.getAttribute('data-testid')+']'):'') + (n.getAttribute('class')?('.'+n.getAttribute('class').split(/\\s+/).slice(0,2).join('.')):'')); n=n.parentElement; i++; } return out.join(' <- ');})()"));
  await sessions.releaseSession(s);
});

const ANCESTRY = "(function(){var n=document.querySelector('.cm-content'); if(!n) return 'none'; var out=[]; var i=0; while(n && i<10){ out.push(n.tagName.toLowerCase()+ (n.getAttribute('data-testid')?('[data-testid='+n.getAttribute('data-testid')+']'):'') + (n.getAttribute('class')?('.'+n.getAttribute('class').split(/\\s+/).slice(0,2).join('.')):'')); n=n.parentElement; i++; } return out.join(' <- ');})()";
// CodeMirror 6's own authoritative document, reached through the view the DOM node carries.
const CM_DOC = "(function(){var el=document.querySelector('.cm-editor'); if(!el) return null; var k=Object.keys(el).find(function(x){return x.indexOf('__cm')===0 || x.indexOf('cmView')>=0;}); var v = el.cmView && el.cmView.view; if(!v){ var c=document.querySelector('.cm-content'); v = c && c.cmView && c.cmView.view; } return v ? v.state.doc.toString() : ('NOVIEW keys=' + Object.keys(el).slice(0,8).join('|'));})()";

test('A3: open the real expression editor and probe every selector at, above and below it', async () => {
  const s = await openScratch();
  await handlers.click({ sessionId: s, selector: '[data-testid="node-dkqn4dk4kv"]' });
  await sleep(1200);
  await handlers.click({ sessionId: s, selector: '[data-testid="make-dynamic-source"]' }).catch(e => console.log('A3 make-dynamic failed', String(e).slice(0,150)));
  await sleep(1200);
  console.log('A3 cm present:', await evaluate(s, "({editors: document.querySelectorAll('.cm-editor').length, content: document.querySelectorAll('.cm-content').length, exprInput: document.querySelectorAll('[data-testid=\"expression-editor-input\"]').length})"));
  console.log('A3 ancestry:', await evaluate(s, ANCESTRY));
  console.log('A3 cm doc:', JSON.stringify(String(await evaluate(s, CM_DOC)).slice(0, 120)));
  await sessions.releaseSession(s);
});

test('A4: open the real code editor modal and probe it', async () => {
  const s = await openScratch();
  await handlers.click({ sessionId: s, selector: '[data-testid="node-dkqn4dk4kv"]' });
  await sleep(1200);
  await handlers.click({ sessionId: s, selector: '[data-testid="code-open-source"]' }).catch(e => console.log('A4 open failed', String(e).slice(0,150)));
  await sleep(1500);
  console.log('A4 cm present:', await evaluate(s, "({editors: document.querySelectorAll('.cm-editor').length, content: document.querySelectorAll('.cm-content').length})"));
  console.log('A4 ancestry:', await evaluate(s, ANCESTRY));
  console.log('A4 cm doc:', JSON.stringify(String(await evaluate(s, CM_DOC)).slice(0, 200)));
  await sessions.releaseSession(s);
});

const LONG = Array.from({ length: 300 }, (_, i) => `row ${i} ${'y'.repeat(40)}`).join('\n');

/** The app's own state for the node param, which is the ground truth the DOM readback is supposed to reflect. */
const STORE_SOURCE = "(function(){var n=(window.__acresStore.getState().nodes||[])[0]; return n && n.data && n.data.params ? JSON.stringify(n.data.params).slice(0,160) : JSON.stringify(Object.keys(n||{}));})()";

async function openExpressionEditor(): Promise<string> {
  const s = await openScratch();
  await handlers.click({ sessionId: s, selector: '[data-testid="node-dkqn4dk4kv"]' });
  await sleep(1200);
  await handlers.click({ sessionId: s, selector: '[data-testid="make-dynamic-source"]' });
  await sleep(1200);
  return s;
}

test('A5: what each selector at and above the real editor reports', async () => {
  const s = await openExpressionEditor();
  console.log('A5 store shape:', await evaluate(s, STORE_SOURCE));
  for (const sel of [
    '.cm-content',
    '[data-testid="expression-editor-input"]',
    '[data-testid="expression-editor"]',
    '[data-testid="param-source"]',
    '[data-testid="field-source"]'
  ]) {
    console.log(`A5 type(${sel}):`, (await attempt(() => handlers.type({ sessionId: s, selector: sel, text: 'Z' }))).slice(0, 620));
  }
  await sessions.releaseSession(s);
});

test('A6: a long write into the real editor, read back through each wrapper', async () => {
  const s = await openExpressionEditor();
  console.log('A6 fill(.cm-content) long:', (await attempt(() => handlers.fill({ sessionId: s, selector: '.cm-content', value: LONG }))).slice(0, 400));
  await sleep(800);
  const domLen = await evaluate<number>(s, "document.querySelector('.cm-content').textContent.length");
  const storeVal = await evaluate<string>(s, "(function(){var n=(window.__acresStore.getState().nodes||[])[0]; try { return JSON.stringify(n.data.params.source); } catch(e){ return 'ERR '+String(e); }})()");
  console.log('A6 ORACLE store source length =', typeof storeVal === 'string' ? storeVal.length : storeVal, ' DOM .cm-content textContent length =', domLen, ' intended length =', LONG.length);
  console.log('A6 type(param-source) after long write:', (await attempt(() => handlers.type({ sessionId: s, selector: '[data-testid="param-source"]', text: 'Z' }))).slice(0, 700));
  await sessions.releaseSession(s);
});
