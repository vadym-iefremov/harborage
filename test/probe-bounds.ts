import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';

import { BrowserManager } from '../src/daemon/browserManager.js';
import { createToolHandlers } from '../src/daemon/tools/handlers.js';
import { SessionStore } from '../src/daemon/sessions.js';
import { getFreePort } from './helpers.js';

/** A CodeMirror-6-shaped editor buried `n` wrapper levels below #named. */
function nested(depth: number): string {
  const open = Array.from({ length: depth }, (_, i) => `<div id="w${i}">`).join('');
  const close = Array.from({ length: depth }, () => '</div>').join('');
  return `<!doctype html><html><body>
<div id="named">${open}<div class="cm-editor"><div class="cm-scroller"><div id="content" class="cm-content" contenteditable="true">seedcm</div></div></div>${close}</div>
</body></html>`;
}

/** `.cm-content` with `n` ordinary wrappers above it; the caller names the outermost. */
function above(hops: number): string {
  const open = Array.from({ length: hops }, (_, i) => `<div${i === 0 ? ' id="outer"' : ''}>`).join('');
  const close = Array.from({ length: hops }, () => '</div>').join('');
  return `<!doctype html><html><body>${open}<div id="content" class="cm-content" contenteditable="true">seedcm</div>${close}</body></html>`;
}

const PAGES: Record<string, string> = {
  '/d0': nested(0),
  '/d1': nested(1),
  '/d2': nested(2),
  '/d3': nested(3),
  '/up6': above(6),
  '/up8': above(8),
  '/up9': above(9),
  '/up12': above(12),
  // A plain wrapper containing an editor two levels down, typed into
  // non-destructively so the marker is still there when the readback runs.
  '/sidebyside': `<!doctype html><html><body>
<div id="panel"><div class="row"><div class="cm-editor"><div class="cm-content" contenteditable="true">snippet</div></div></div><input id="plain" value="seed"></div>
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

/** Just the honesty fields, so the bound is visible at a glance. */
async function verdict(sessionId: string, selector: string): Promise<string> {
  try {
    const p = payload(await handlers.type({ sessionId, selector, text: 'Z' }));
    return `readbackReliable=${p.readbackReliable} matched=${'matched' in p ? p.matched : '(not claimed)'} richWarning=${String(
      p.note ?? ''
    ).includes('Monaco or CodeMirror')}`;
  } catch (err) {
    return 'THREW ' + (err instanceof Error ? err.message : String(err)).slice(0, 160);
  }
}

test('G1: how far BELOW the named element the markers are still seen', async () => {
  for (const d of [0, 1, 2, 3]) {
    const s = await freshSession(`/d${d}`);
    console.log(`G1 cm-editor ${d + 1} level(s) below #named ->`, await verdict(s, '#named'));
    await sessions.releaseSession(s);
  }
});

test('G2: how far ABOVE the editable node the markers are still seen', async () => {
  for (const h of [6, 8, 9, 12]) {
    const s = await freshSession(`/up${h}`);
    console.log(`G2 .cm-content ${h} hop(s) below #outer ->`, await verdict(s, '#outer'));
    await sessions.releaseSession(s);
  }
});

test('G3: an ordinary input in a panel that also contains an editor', async () => {
  const s = await freshSession('/sidebyside');
  console.log('G3 type(#plain) ->', await verdict(s, '#plain'));
  console.log('G3 type(#panel) ->', await verdict(s, '#panel'));
  await sessions.releaseSession(s);
});
