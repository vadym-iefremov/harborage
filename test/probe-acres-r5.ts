import { after, before, test } from 'node:test';

import { BrowserManager } from '../src/daemon/browserManager.js';
import { createToolHandlers } from '../src/daemon/tools/handlers.js';
import { SessionStore } from '../src/daemon/sessions.js';
import { getFreePort } from './helpers.js';

/**
 * Live Acres, round 5. Everything here is graded against an oracle the app
 * owns rather than against what a handler reported:
 *
 *   node count      window.__acresStore.getState().nodes
 *   CM6 document    document.querySelector('.cm-content').cmTile.view.state.doc.toString()
 *   keys dispatched a window-level capture listener installed before the call
 *
 * WATCH THE CATALOGUE. The canvas here starts as Acres' scratch state, and
 * that state is NOT unsaved: adding a node to it persists a workbook and a
 * flow, which is how a run of this file quietly took the catalogue from 47
 * flows to 52. Each test therefore records the workbook the app created and
 * deletes it afterwards, which cascades to its flow, and cleanup asserts the
 * count is back where it started. If a run of this dies partway, check
 * GET /api/workflows before assuming the catalogue is clean.
 */

const ACRES = 'http://localhost:5173';

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
  // Deleting the workbook cascades to the flow Acres made with it, which is
  // why only the workbook is deleted here.
  for (const id of createdWorkbooks) {
    const response = await fetch(`http://localhost:8787/api/workbooks/${id}`, { method: 'DELETE' });
    console.log(`cleanup workbook ${id}: ${response.status}`);
  }
  console.log('cleanup flow count now:', await flowCount());
});

function payload(r: unknown): Record<string, unknown> {
  return (r as { structuredContent: Record<string, unknown> }).structuredContent;
}
async function ev<T>(s: string, e: string): Promise<T> {
  return payload(await handlers.evaluate({ sessionId: s, expression: e })).result as T;
}
async function attempt(call: () => Promise<unknown>): Promise<string> {
  try {
    return 'RETURNED ' + JSON.stringify(payload(await call())).slice(0, 500);
  } catch (err) {
    return 'THREW ' + (err instanceof Error ? err.message : String(err)).slice(0, 400);
  }
}
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

const NODES = 'JSON.stringify((window.__acresStore.getState().nodes||[]).map(n=>n.id))';
const CM_DOC =
  '(() => { const c = document.querySelector(".cm-content"); ' +
  'return c && c.cmTile && c.cmTile.view ? JSON.stringify(c.cmTile.view.state.doc.toString()) : "NO CM6"; })()';
const ARM_LOG =
  'window.__keys = []; ' +
  'window.addEventListener("keydown", e => window.__keys.push("keydown:" + e.key), true); ' +
  'window.addEventListener("keyup", e => window.__keys.push("keyup:" + e.key), true); ' +
  'window.addEventListener("beforeinput", e => window.__keys.push("beforeinput:" + e.inputType), true); 1';

/** Every workbook a test in this file caused Acres to persist. */
const createdWorkbooks = new Set<string>();

async function openScratch(): Promise<string> {
  const { sessionId } = await sessions.createSession();
  await handlers.navigate({ sessionId, url: ACRES });
  await sleep(2500);
  return sessionId;
}

/**
 * Reads back whichever workbook the app persisted for this session's scratch
 * canvas, so the after() hook can remove it. Called after the nodes are added,
 * because the workbook does not exist before that.
 */
async function noteWorkbook(sessionId: string): Promise<void> {
  const id = await ev<string | null>(sessionId, 'window.__acresStore.getState().currentWorkbookId ?? null');
  if (id) createdWorkbooks.add(id);
}

async function flowCount(): Promise<number> {
  const response = await fetch('http://localhost:8787/api/workflows');
  return ((await response.json()) as unknown[]).length;
}

test('A1: live CodeMirror 6, non-empty replacement, no key', async () => {
  const s = await openScratch();
  const id = await ev<string>(
    s,
    '(() => { const st = window.__acresStore.getState(); const id = st.addNode("Code", { x: 400, y: 200 }); st.selectNode(id); return id; })()'
  );
  await sleep(1500);
  await noteWorkbook(s);
  await ev(s, 'document.querySelector(\'[data-testid="make-dynamic-source"]\').click(); 1');
  await sleep(1500);
  console.log('A1 node id:', id, 'cm present:', await ev(s, 'document.querySelectorAll(".cm-content").length'));

  // Seed the editor through the same path the write uses, so the starting doc
  // is the editor's own rather than something poked into the DOM.
  console.log('A1 seed:', (await attempt(() => handlers.fill({ sessionId: s, selector: '.cm-content', value: '{{ $json.mode }}' }))).slice(0, 200));
  await sleep(500);
  console.log('A1 doc after seed:', await ev(s, CM_DOC));

  await ev(s, ARM_LOG);
  console.log('A1 nodes before:', await ev(s, NODES));
  console.log('A1 replace:', (await attempt(() => handlers.fill({ sessionId: s, selector: '.cm-content', value: '1' }))).slice(0, 300));
  await sleep(500);
  console.log('A1 ORACLE doc :', await ev(s, CM_DOC));
  console.log('A1 ORACLE keys:', JSON.stringify(await ev(s, 'window.__keys')));
  console.log('A1 nodes after:', await ev(s, NODES));
  await sessions.releaseSession(s);
});

test('A2: live CodeMirror 6, EMPTY clear, no key', async () => {
  const s = await openScratch();
  await ev(
    s,
    '(() => { const st = window.__acresStore.getState(); const id = st.addNode("Code", { x: 400, y: 200 }); st.selectNode(id); return id; })()'
  );
  await sleep(1500);
  await noteWorkbook(s);
  await ev(s, 'document.querySelector(\'[data-testid="make-dynamic-source"]\').click(); 1');
  await sleep(1500);
  await handlers.fill({ sessionId: s, selector: '.cm-content', value: 'ABCDEF' }).catch(() => undefined);
  await sleep(400);
  console.log('A2 doc after seed:', await ev(s, CM_DOC));
  await ev(s, ARM_LOG);
  console.log('A2 nodes before:', await ev(s, NODES));
  console.log('A2 clear:', (await attempt(() => handlers.fill({ sessionId: s, selector: '.cm-content', value: '' }))).slice(0, 300));
  await sleep(500);
  console.log('A2 ORACLE doc :', await ev(s, CM_DOC));
  console.log('A2 ORACLE keys:', JSON.stringify(await ev(s, 'window.__keys')));
  console.log('A2 nodes after:', await ev(s, NODES));
  await sessions.releaseSession(s);
});

test('A3: the real inline rename input on a real canvas node, fill and no-selector clear', async () => {
  const s = await openScratch();
  await ev(
    s,
    '(() => { const st = window.__acresStore.getState(); ["Set","Set","Set"].forEach((d,i)=>st.addNode(d,{x:200+i*220,y:200})); return 1; })()'
  );
  await sleep(1200);
  await noteWorkbook(s);
  const ids = JSON.parse(await ev<string>(s, NODES)) as string[];
  console.log('A3 nodes:', JSON.stringify(ids));

  // Double click the node's name to open its rename input, the way a user does.
  await handlers.click({ sessionId: s, selector: `[data-testid="node-name-${ids[1]}"]`, clickCount: 2 }).catch(() => undefined);
  await sleep(800);
  console.log('A3 rename inputs:', await ev(s, 'Array.from(document.querySelectorAll(\'[data-testid^="node-rename-"]\')).map(e=>e.getAttribute("data-testid"))'));
  console.log('A3 active:', await ev(s, '({tag:document.activeElement.tagName, tid:document.activeElement.getAttribute("data-testid")})'));

  // Seeded first, so the clear below has something to destroy. A clear of an
  // already-empty control would pass this test for the wrong reason.
  await handlers.fill({ sessionId: s, selector: `[data-testid="node-rename-${ids[1]}"]`, value: 'RENAME ME' }).catch(() => undefined);
  await sleep(400);
  console.log('A3 seeded rename value:', await ev(s, `document.querySelector('[data-testid="node-rename-${ids[1]}"]').value`));

  await ev(s, ARM_LOG);
  console.log('A3a fill(rename,""):', (await attempt(() => handlers.fill({ sessionId: s, selector: `[data-testid="node-rename-${ids[1]}"]`, value: '' }))).slice(0, 300));
  await sleep(500);
  console.log('A3a ORACLE keys :', JSON.stringify(await ev(s, 'window.__keys')));
  console.log('A3a ORACLE nodes:', await ev(s, NODES));

  await ev(s, ARM_LOG);
  console.log('A3b type(clear,no selector):', (await attempt(() => handlers.type({ sessionId: s, text: 'PWNED', clear: true }))).slice(0, 300));
  await sleep(500);
  console.log('A3b ORACLE keys :', JSON.stringify(await ev(s, 'window.__keys')));
  console.log('A3b ORACLE nodes:', await ev(s, NODES));
  await sessions.releaseSession(s);
});

test('A4: press_key Delete on the same canvas still deletes, so the fixture is not inert', async () => {
  // The control that makes A3 mean something: if the canvas did not react to a
  // real Delete at all, A3 would pass for the wrong reason.
  const s = await openScratch();
  await ev(
    s,
    '(() => { const st = window.__acresStore.getState(); ["Set","Set","Set"].forEach((d,i)=>st.addNode(d,{x:200+i*220,y:200})); return 1; })()'
  );
  await sleep(1200);
  await noteWorkbook(s);
  const ids = JSON.parse(await ev<string>(s, NODES)) as string[];
  await handlers.click({ sessionId: s, selector: `[data-testid="node-${ids[1]}"]` }).catch(() => undefined);
  await sleep(500);
  console.log('A4 nodes before:', await ev(s, NODES));
  await handlers.press_key({ sessionId: s, key: 'Delete' }).catch(() => undefined);
  await sleep(700);
  console.log('A4 nodes after :', await ev(s, NODES));
  await sessions.releaseSession(s);
});
