import { after, before, test } from 'node:test';

import { BrowserManager } from '../src/daemon/browserManager.js';
import { createToolHandlers } from '../src/daemon/tools/handlers.js';
import { SessionStore } from '../src/daemon/sessions.js';
import { getFreePort } from './helpers.js';

const ACRES = 'http://localhost:5173';
const WB = '32d0773e-a918-4f1f-83bc-4ea5789a3cd5';
const NODE = 'gts0g7gmwn';

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

function payload(r: unknown): Record<string, unknown> {
  return (r as { structuredContent: Record<string, unknown> }).structuredContent;
}
async function ev<T>(s: string, e: string): Promise<T> {
  return payload(await handlers.evaluate({ sessionId: s, expression: e })).result as T;
}
async function attempt(call: () => Promise<unknown>): Promise<string> {
  try {
    return 'RETURNED ' + JSON.stringify(payload(await call())).slice(0, 800);
  } catch (err) {
    return 'THREW ' + (err instanceof Error ? err.message : String(err)).slice(0, 400);
  }
}
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));
const NODES = 'JSON.stringify((window.__acresStore.getState().nodes||[]).map(n=>n.id))';

async function open(): Promise<string> {
  const { sessionId } = await sessions.createSession();
  await handlers.navigate({ sessionId, url: ACRES });
  await sleep(2500);
  await ev(sessionId, `window.__acresStore.getState().openWorkbook(${JSON.stringify(WB)})`);
  await sleep(2000);
  return sessionId;
}

test('B1: the real inline rename input on the canvas, no-selector clear', async () => {
  const s = await open();
  await handlers.click({ sessionId: s, selector: `[data-testid="node-name-${NODE}"]`, clickCount: 2 });
  await sleep(700);
  console.log('B1 rename input present:', await ev(s, `document.querySelectorAll('[data-testid="node-rename-${NODE}"]').length`));
  console.log('B1 active:', await ev(s, '({tag:document.activeElement.tagName, tid:document.activeElement.getAttribute("data-testid")})'));
  console.log('B1 nodes before:', await ev(s, NODES));
  console.log('B1 result:', await attempt(() => handlers.type({ sessionId: s, text: 'PWNED', clear: true })));
  await sleep(600);
  console.log('B1 nodes after :', await ev(s, NODES));
  await sessions.releaseSession(s);
});

test('B2: fill the real inline rename input', async () => {
  const s = await open();
  await handlers.click({ sessionId: s, selector: `[data-testid="node-name-${NODE}"]`, clickCount: 2 });
  await sleep(700);
  console.log('B2 nodes before:', await ev(s, NODES));
  console.log('B2 result:', await attempt(() => handlers.fill({ sessionId: s, selector: `[data-testid="node-rename-${NODE}"]`, value: 'RenamedByProbe' })));
  await sleep(600);
  console.log('B2 nodes after :', await ev(s, NODES));
  await sessions.releaseSession(s);
});

test('B3: press_key Delete directly while the rename input has focus (fixture control)', async () => {
  const s = await open();
  await handlers.click({ sessionId: s, selector: `[data-testid="node-name-${NODE}"]`, clickCount: 2 });
  await sleep(700);
  console.log('B3 nodes before:', await ev(s, NODES));
  await handlers.press_key({ sessionId: s, key: 'Delete' });
  await sleep(600);
  console.log('B3 nodes after :', await ev(s, NODES));
  await sessions.releaseSession(s);
});

test('B4: the expression editor readback through param-source and field-source', async () => {
  const s = await open();
  await handlers.click({ sessionId: s, selector: `[data-testid="node-${NODE}"]` });
  await sleep(1200);
  await handlers.click({ sessionId: s, selector: '[data-testid="make-dynamic-source"]' });
  await sleep(1200);
  for (const sel of ['.cm-content', '[data-testid="expression-editor-input"]', '[data-testid="param-source"]', '[data-testid="field-source"]']) {
    console.log(`B4 type(${sel}):`, (await attempt(() => handlers.type({ sessionId: s, selector: sel, text: 'Z' }))).slice(0, 340));
  }
  console.log('B4 fill(.cm-content) refusal check:', (await attempt(() => handlers.fill({ sessionId: s, selector: '[data-testid="param-source"]', value: 'x' }))).slice(0, 300));
  await sessions.releaseSession(s);
});

test('B5: the command palette input', async () => {
  const s = await open();
  await handlers.click({ sessionId: s, selector: '[data-testid="btn-command-palette"]' }).catch(() => undefined);
  await sleep(900);
  console.log('B5 nodes before:', await ev(s, NODES));
  console.log('B5 active:', await ev(s, '({tag:document.activeElement.tagName, tid:document.activeElement.getAttribute("data-testid")})'));
  console.log('B5 result:', await attempt(() => handlers.type({ sessionId: s, text: 'set', clear: true })));
  await sleep(500);
  console.log('B5 nodes after :', await ev(s, NODES));
  await sessions.releaseSession(s);
});
