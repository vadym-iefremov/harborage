import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';

import { BrowserManager } from '../src/daemon/browserManager.js';
import { SessionStore } from '../src/daemon/sessions.js';
import { createToolHandlers } from '../src/daemon/tools/handlers.js';
import { getFreePort, waitFor } from './helpers.js';

/** A page that fires one save-shaped POST, one failing GET and one image, on load. */
const fixtureHtml = `<!doctype html>
<html><body>
<img src="/logo.png" alt="">
<script>
  (async () => {
    await fetch('/api/save', { method: 'POST', body: '{}' });
    await fetch('/api/missing');
    window.__done = true;
  })();
</script>
</body></html>`;

interface Entry {
  direction: 'request' | 'response';
  url: string;
  method?: string;
  status?: number;
  resourceType?: string;
}
interface Payload {
  requests: Entry[];
  total: number;
  returned: number;
}

let browserManager: BrowserManager;
let sessions: SessionStore;
let handlers: ReturnType<typeof createToolHandlers>;
let server: Server;
let base: string;
let sessionId: string;

function structured(result: unknown): Payload {
  return (result as { structuredContent: Payload }).structuredContent;
}

before(async () => {
  const debugPort = await getFreePort();
  browserManager = new BrowserManager(debugPort);
  sessions = new SessionStore(browserManager);
  handlers = createToolHandlers(sessions, {
    debugPort,
    screenshotCacheDir: '/dev/null/unused',
    screenshotCacheTtlMs: 1000
  });

  server = createServer((req, res) => {
    const url = req.url ?? '/';
    if (url.startsWith('/api/save')) {
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }
    if (url.startsWith('/api/missing')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{"ok":false}');
      return;
    }
    if (url.startsWith('/logo.png')) {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      // A 1x1 transparent PNG.
      res.end(
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
          'base64'
        )
      );
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(fixtureHtml);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

  ({ sessionId } = await sessions.createSession());
  await sessions.resolve(sessionId).page.goto(`${base}/`);
  await waitFor(async () => {
    const all = structured(await handlers.list_network_requests({ sessionId }));
    return all.requests.some(r => r.url.includes('/api/missing') && r.direction === 'response');
  }, { message: 'fixture page never finished its requests' });
});

after(async () => {
  await sessions.closeAll();
  await browserManager.close();
  await new Promise<void>(resolve => server.close(() => resolve()));
});

test('with no filters the whole buffer comes back, plus counts saying how much that is', async () => {
  const payload = structured(await handlers.list_network_requests({ sessionId }));
  assert.ok(payload.requests.length >= 6, `expected the document, image and two fetches, got ${payload.requests.length}`);
  assert.equal(payload.total, payload.requests.length);
  assert.equal(payload.returned, payload.requests.length);
});

test('urlIncludes narrows to one endpoint, and the counts show what was filtered out', async () => {
  const payload = structured(await handlers.list_network_requests({ sessionId, urlIncludes: '/api/save' }));

  assert.ok(payload.requests.length > 0);
  assert.ok(payload.requests.every(r => r.url.includes('/api/save')));
  assert.equal(payload.returned, payload.requests.length);
  assert.ok(payload.total > payload.returned, 'total must still describe the whole buffer, not the filtered slice');
});

test('urlMatches takes a regular expression', async () => {
  const payload = structured(await handlers.list_network_requests({ sessionId, urlMatches: '/api/(save|missing)$' }));
  assert.ok(payload.requests.length >= 4);
  assert.ok(payload.requests.every(r => /\/api\/(save|missing)$/.test(r.url)));

  await assert.rejects(() => handlers.list_network_requests({ sessionId, urlMatches: '([' }), /regular expression|regex/i);
});

test('method matches case-insensitively, and only ever matches request entries', async () => {
  const payload = structured(await handlers.list_network_requests({ sessionId, method: 'post' }));

  assert.equal(payload.requests.length, 1);
  assert.equal(payload.requests[0]!.direction, 'request');
  assert.equal(payload.requests[0]!.method, 'POST');
  assert.ok(payload.requests[0]!.url.includes('/api/save'));
});

test('minStatus alone answers "show me the failures" in one call', async () => {
  const payload = structured(await handlers.list_network_requests({ sessionId, minStatus: 400 }));

  assert.equal(payload.requests.length, 1);
  assert.equal(payload.requests[0]!.status, 404);
  assert.ok(payload.requests[0]!.url.includes('/api/missing'));
});

test('minStatus and maxStatus together bound a range', async () => {
  const payload = structured(await handlers.list_network_requests({ sessionId, minStatus: 200, maxStatus: 299 }));

  assert.ok(payload.requests.length >= 3);
  assert.ok(payload.requests.every(r => r.status !== undefined && r.status >= 200 && r.status <= 299));
  assert.ok(payload.requests.some(r => r.status === 201));
});

test('resourceType filters to one kind of load', async () => {
  const doc = structured(await handlers.list_network_requests({ sessionId, resourceType: 'document' }));
  assert.ok(doc.requests.length >= 1);
  assert.ok(doc.requests.every(r => r.resourceType === 'document'));

  const image = structured(await handlers.list_network_requests({ sessionId, resourceType: 'image' }));
  assert.ok(image.requests.some(r => r.url.includes('/logo.png')));
});

test('direction filters requests from responses', async () => {
  const responses = structured(await handlers.list_network_requests({ sessionId, direction: 'response' }));
  assert.ok(responses.requests.length > 0);
  assert.ok(responses.requests.every(r => r.direction === 'response'));
});

test('filters combine, and a filter matching nothing returns an empty list rather than everything', async () => {
  const combined = structured(
    await handlers.list_network_requests({ sessionId, urlIncludes: '/api/', direction: 'request', method: 'GET' })
  );
  assert.equal(combined.requests.length, 1);
  assert.ok(combined.requests[0]!.url.includes('/api/missing'));

  const none = structured(await handlers.list_network_requests({ sessionId, urlIncludes: 'nothing-matches-this' }));
  assert.deepEqual(none.requests, []);
  assert.equal(none.returned, 0);
  assert.ok(none.total > 0, 'an empty result must still say the buffer was not empty');
});

test('clear: true still drains the whole buffer, not just the filtered slice', async () => {
  const { sessionId: other } = await sessions.createSession();
  await sessions.resolve(other).page.goto(`${base}/`);
  await waitFor(async () => structured(await handlers.list_network_requests({ sessionId: other })).total > 3);

  await handlers.list_network_requests({ sessionId: other, urlIncludes: '/api/save', clear: true });
  const left = structured(await handlers.list_network_requests({ sessionId: other }));
  assert.equal(left.total, 0, 'clear drains the buffer itself, so a filtered read must not leave the rest behind');

  await sessions.releaseSession(other);
});

interface ConsolePayload {
  messages: { type: string; text: string }[];
  total: number;
  returned: number;
}

test('read_console filters by type and by text, and reports how much the buffer held', async () => {
  const { sessionId: noisy } = await sessions.createSession();
  const target = sessions.resolve(noisy);
  await target.page.goto('data:text/html,<h1>console filtering</h1>');
  await target.page.evaluate(() => {
    console.log('routine chatter');
    console.warn('warning: SAVE is slow');
    console.error('save failed: 500');
  });

  const all = (await handlers.read_console({ sessionId: noisy })) as { structuredContent: ConsolePayload };
  assert.ok(all.structuredContent.total >= 3);
  assert.equal(all.structuredContent.returned, all.structuredContent.messages.length);

  const failures = (await handlers.read_console({ sessionId: noisy, types: ['error', 'warning'] })) as {
    structuredContent: ConsolePayload;
  };
  assert.equal(failures.structuredContent.messages.length, 2);
  assert.ok(failures.structuredContent.messages.every(m => m.type === 'error' || m.type === 'warning'));
  assert.ok(failures.structuredContent.total > failures.structuredContent.returned);

  const bySubstring = (await handlers.read_console({ sessionId: noisy, textIncludes: 'SAVE' })) as {
    structuredContent: ConsolePayload;
  };
  assert.equal(bySubstring.structuredContent.messages.length, 2, 'textIncludes should match case-insensitively');

  await sessions.releaseSession(noisy);
});
