import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';

import { BrowserManager } from '../src/daemon/browserManager.js';
import { createToolHandlers } from '../src/daemon/tools/handlers.js';
import { SessionStore } from '../src/daemon/sessions.js';
import { getFreePort } from './helpers.js';

/**
 * Round 2 QA: set_cookies used to read its own result back by cookie NAME
 * only. Cookie names like "session", "token" and "sid" collide across
 * domains constantly, so a cookie the browser genuinely rejected could be
 * reported as installed whenever an unrelated, same-named cookie for a
 * different domain already sat in the jar. These tests install that
 * decoy cookie first, on a real second domain the same server answers to,
 * exactly the collision the fix is for.
 */

const PAGE_HTML = `<!doctype html><html><body><h1>round2 cookie fixture</h1></body></html>`;

let server: Server;
let port: number;
let browserManager: BrowserManager;
let sessions: SessionStore;
let handlers: ReturnType<typeof createToolHandlers>;

function urlFor(host: string): string {
  return `http://${host}:${port}/`;
}

before(async () => {
  server = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(PAGE_HTML);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  port = typeof address === 'object' && address ? address.port : 0;

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

async function freshSession(): Promise<string> {
  const { sessionId } = await sessions.createSession();
  await handlers.navigate({ sessionId, url: urlFor('127.0.0.1') });
  return sessionId;
}

test('a rejected cookie is reported missing, even when a same-named cookie already exists on another domain', async () => {
  const sessionId = await freshSession();

  // The decoy: a real, successfully-installed "sid" cookie, but scoped to a
  // domain nothing in this test is asking about.
  await handlers.set_cookies({
    sessionId,
    cookies: [{ name: 'sid', value: 'decoy-from-localhost', domain: 'localhost', path: '/' }]
  });

  // sameSite "None" without secure: true is dropped by the browser outright.
  // Before the fix, the read-back matched this request by name alone, found
  // the decoy above, and reported the rejected cookie as installed.
  const result = payload(
    await handlers.set_cookies({
      sessionId,
      cookies: [{ name: 'sid', value: 'should-be-rejected', domain: '127.0.0.1', path: '/', sameSite: 'None' }]
    })
  );

  assert.deepEqual(result.missing, ['sid'], 'the rejected 127.0.0.1 cookie must be reported missing');
  assert.equal(
    (result.cookies as { name: string; domain: string }[]).some(c => c.name === 'sid' && c.domain === '127.0.0.1'),
    false,
    'the decoy on another domain must not stand in for the cookie that was actually requested'
  );
  assert.match(result.note as string, /did not keep/i);

  // The decoy itself must be untouched: this call was never about it.
  const jar = payload(await handlers.get_cookies({ sessionId }));
  const decoy = (jar.cookies as { name: string; domain: string; value: string }[]).find(
    c => c.name === 'sid' && c.domain === 'localhost'
  );
  assert.ok(decoy, 'the decoy cookie must still be in the jar');
  assert.equal(decoy!.value, 'decoy-from-localhost');

  await sessions.releaseSession(sessionId);
});

test('a rejected cookie is reported missing even when a same-named cookie exists on the SAME domain but a different path', async () => {
  const sessionId = await freshSession();

  await handlers.set_cookies({
    sessionId,
    cookies: [{ name: 'sid', value: 'decoy-other-path', domain: '127.0.0.1', path: '/admin/' }]
  });

  const result = payload(
    await handlers.set_cookies({
      sessionId,
      cookies: [{ name: 'sid', value: 'should-be-rejected', domain: '127.0.0.1', path: '/', sameSite: 'None' }]
    })
  );

  assert.deepEqual(result.missing, ['sid']);
  assert.equal(
    (result.cookies as { name: string; path: string }[]).some(c => c.name === 'sid' && c.path === '/'),
    false
  );

  await sessions.releaseSession(sessionId);
});

test('installing a cookie under a name that collides with another domain still reports success for the one that really landed', async () => {
  const sessionId = await freshSession();

  await handlers.set_cookies({
    sessionId,
    cookies: [{ name: 'sid', value: 'decoy-from-localhost', domain: 'localhost', path: '/' }]
  });

  const result = payload(
    await handlers.set_cookies({
      sessionId,
      cookies: [{ name: 'sid', value: 'the-real-one', domain: '127.0.0.1', path: '/' }]
    })
  );

  assert.equal(result.missing, undefined, 'a cookie the browser genuinely accepted must not be reported missing');
  const installed = (result.cookies as { name: string; domain: string; value: string }[]).find(
    c => c.name === 'sid' && c.domain === '127.0.0.1'
  );
  assert.ok(installed, 'the cookie that really landed on 127.0.0.1 must be in the result');
  assert.equal(installed!.value, 'the-real-one');

  await sessions.releaseSession(sessionId);
});

test('a cookie given by url is matched by the domain and path the browser actually derives from it', async () => {
  const sessionId = await freshSession();

  await handlers.set_cookies({
    sessionId,
    cookies: [{ name: 'token', value: 'decoy', domain: '127.0.0.1', path: '/other/' }]
  });

  const result = payload(
    await handlers.set_cookies({
      sessionId,
      cookies: [{ name: 'token', value: 'via-url', url: `http://127.0.0.1:${port}/some/page` }]
    })
  );

  assert.equal(result.missing, undefined);
  const installed = (result.cookies as { name: string; domain: string; path: string; value: string }[]).find(
    c => c.name === 'token' && c.value === 'via-url'
  );
  assert.ok(installed, 'the url-derived cookie must be found by its real domain and path, not confused with the decoy');
  assert.equal(installed!.domain, '127.0.0.1');
  assert.equal(installed!.path, '/some/', 'path must be the url\'s directory, matching what the browser actually stored');

  await sessions.releaseSession(sessionId);
});
