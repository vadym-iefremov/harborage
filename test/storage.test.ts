import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';

import { BrowserManager } from '../src/daemon/browserManager.js';
import { createToolHandlers } from '../src/daemon/tools/handlers.js';
import { SessionStore } from '../src/daemon/sessions.js';
import { toolDefs } from '../src/daemon/tools/schemas.js';
import { getFreePort } from './helpers.js';

/**
 * A fixture that sets a cookie server-side and does nothing else. The point of
 * these tests is the cookie jar and the two web storage areas, so the page
 * itself stays boring: everything interesting is done through the tools.
 *
 * Two host names are served off the same port. `127.0.0.1` and `localhost`
 * resolve to the same machine but are two DIFFERENT origins and two different
 * cookie domains, which is what makes the url and domain filters testable
 * without a second server.
 */
const FIXTURE_HTML = `<!doctype html>
<html><body><h1>harborage storage fixture</h1></body></html>`;

let server: Server;
let port: number;
let browserManager: BrowserManager;
let sessions: SessionStore;
let handlers: ReturnType<typeof createToolHandlers>;

/** The URL of the fixture on a given host name. */
function urlFor(host: string, path = '/'): string {
  return `http://${host}:${port}${path}`;
}

before(async () => {
  server = createServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    // Two cookies, so a name filter has something to leave behind.
    res.setHeader('Set-Cookie', ['sid=server-set; Path=/', 'theme=dark; Path=/']);
    res.end(FIXTURE_HTML);
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

/** The `structuredContent` of a tool result, typed loosely: these tests assert on individual fields. */
function payload(result: unknown): Record<string, any> {
  return (result as { structuredContent: Record<string, any> }).structuredContent;
}

/** A fresh session already sitting on the fixture page, served from `host`. */
async function freshSession(host = '127.0.0.1'): Promise<string> {
  const { sessionId } = await sessions.createSession();
  await handlers.navigate({ sessionId, url: urlFor(host), settleMs: 0 });
  return sessionId;
}

/** Evaluates an expression in the session's tab and returns its value. */
async function evaluate<T>(sessionId: string, expression: string): Promise<T> {
  const result = await handlers.evaluate({ sessionId, expression });
  return payload(result).result as T;
}

async function rejection(fn: () => Promise<unknown>): Promise<Error> {
  try {
    await fn();
  } catch (err) {
    return err as Error;
  }
  throw new assert.AssertionError({ message: 'expected the call to reject, but it resolved' });
}

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------

test('get_cookies reads the live jar, and filters it by url and by name', async () => {
  const sessionId = await freshSession();

  const all = payload(await handlers.get_cookies({ sessionId }));
  const names = (all.cookies as { name: string }[]).map(c => c.name).sort();
  assert.deepEqual(names, ['sid', 'theme'], 'both server-set cookies must come back');
  assert.equal(all.count, 2);

  const byName = payload(await handlers.get_cookies({ sessionId, names: ['sid'] }));
  assert.equal(byName.count, 1);
  assert.equal((byName.cookies as { name: string; value: string }[])[0].value, 'server-set');

  // A url filter is Playwright's own, applied by the browser: a cookie scoped
  // to 127.0.0.1 must not show up when asking about a different host.
  const byUrl = payload(await handlers.get_cookies({ sessionId, urls: ['http://example.com/'] }));
  assert.equal(byUrl.count, 0, 'cookies for another origin must not be returned');

  await sessions.releaseSession(sessionId);
});

test('set_cookies installs a cookie the page itself can then read', async () => {
  const sessionId = await freshSession();

  const written = payload(
    await handlers.set_cookies({
      sessionId,
      cookies: [{ name: 'authToken', value: 'abc123', domain: '127.0.0.1', path: '/' }]
    })
  );
  assert.equal(written.requested, 1);
  const installed = (written.cookies as { name: string; value: string }[]).find(c => c.name === 'authToken');
  assert.ok(installed, 'set_cookies must report the cookie back as it now exists in the jar, not echo the request');
  assert.equal(installed.value, 'abc123');

  // The real proof: a reload sends it, and document.cookie sees it.
  await handlers.reload({ sessionId, settleMs: 0 });
  const fromPage = await evaluate<string>(sessionId, 'document.cookie');
  assert.match(fromPage, /authToken=abc123/, 'the cookie must actually be in the browser, not just in our reply');

  await sessions.releaseSession(sessionId);
});

test('clear_cookies with a name filter removes only that cookie and reports what went', async () => {
  const sessionId = await freshSession();

  const cleared = payload(await handlers.clear_cookies({ sessionId, name: 'sid' }));
  assert.equal(cleared.removedCount, 1);
  assert.deepEqual(
    (cleared.removed as { name: string }[]).map(c => c.name),
    ['sid']
  );
  assert.equal(cleared.remainingCount, 1, 'the other cookie must survive a name-filtered clear');

  const left = payload(await handlers.get_cookies({ sessionId }));
  assert.deepEqual((left.cookies as { name: string }[]).map(c => c.name), ['theme']);

  await sessions.releaseSession(sessionId);
});

test('clear_cookies with a domain filter leaves another domain alone', async () => {
  const sessionId = await freshSession();
  await handlers.set_cookies({
    sessionId,
    cookies: [{ name: 'other', value: 'keep', domain: 'localhost', path: '/' }]
  });

  const cleared = payload(await handlers.clear_cookies({ sessionId, domain: '127.0.0.1' }));
  assert.equal(cleared.removedCount, 2, 'both 127.0.0.1 cookies go');

  const left = payload(await handlers.get_cookies({ sessionId }));
  assert.deepEqual((left.cookies as { name: string }[]).map(c => c.name), ['other']);

  await sessions.releaseSession(sessionId);
});

test('clear_cookies with no filter empties the whole jar', async () => {
  const sessionId = await freshSession();
  const cleared = payload(await handlers.clear_cookies({ sessionId }));
  assert.equal(cleared.removedCount, 2);
  assert.equal(cleared.remainingCount, 0);
  assert.equal(payload(await handlers.get_cookies({ sessionId })).count, 0);
  await sessions.releaseSession(sessionId);
});

test('clear_cookies rejects an unrecognised filter key instead of silently clearing everything', () => {
  // Playwright 1.62 ignores an unknown key in its filter object, so
  // clearCookies({ nmae: 'sid' }) wipes the entire jar and reports success.
  // The schema has to catch that typo, because nothing downstream can.
  const parsed = toolDefs.clear_cookies.inputSchema.safeParse({ sessionId: 's', nmae: 'sid' });
  assert.equal(parsed.success, false, 'an unknown filter key must be a schema error, not a full wipe');

  const empty = toolDefs.clear_cookies.inputSchema.safeParse({ sessionId: 's', name: '' });
  assert.equal(empty.success, false, 'an empty-string filter is treated by Playwright as no filter at all');
});

// ---------------------------------------------------------------------------
// localStorage and sessionStorage
// ---------------------------------------------------------------------------

for (const area of ['localStorage', 'sessionStorage'] as const) {
  test(`${area}: set, get, remove and clear all report the state that really resulted`, async () => {
    const sessionId = await freshSession();

    const set = payload(await handlers.set_storage({ sessionId, area, key: 'token', value: 'v1' }));
    assert.equal(set.area, area);
    assert.equal(set.value, 'v1', 'a write must report the value read back out of storage');
    assert.equal(set.matched, true);
    assert.equal(set.count, 1);
    assert.ok(String(set.origin).includes('127.0.0.1'), 'the origin the write landed on must be reported');

    // Proof it is really there, seen from the page rather than from our reply.
    const fromPage = await evaluate<string | null>(sessionId, `${area}.getItem('token')`);
    assert.equal(fromPage, 'v1');

    const got = payload(await handlers.get_storage({ sessionId, area, key: 'token' }));
    assert.equal(got.value, 'v1');
    assert.equal(got.present, true);

    const missing = payload(await handlers.get_storage({ sessionId, area, key: 'nope' }));
    assert.equal(missing.value, null);
    assert.equal(missing.present, false, 'an absent key must be distinguishable from a key holding an empty value');

    await handlers.set_storage({ sessionId, area, key: 'second', value: 'v2' });
    const all = payload(await handlers.get_storage({ sessionId, area }));
    assert.deepEqual(all.items, { token: 'v1', second: 'v2' });
    assert.equal(all.count, 2);

    const removed = payload(await handlers.remove_storage({ sessionId, area, key: 'token' }));
    assert.equal(removed.removed, true);
    assert.equal(removed.value, null, 'the key must be reported as gone, read back after the delete');
    assert.equal(removed.count, 1);

    const noop = payload(await handlers.remove_storage({ sessionId, area, key: 'token' }));
    assert.equal(noop.removed, false, 'removing an absent key must say it removed nothing, not claim success');

    const cleared = payload(await handlers.clear_storage({ sessionId, area }));
    assert.equal(cleared.removedCount, 1);
    assert.equal(cleared.count, 0);
    assert.equal(await evaluate<number>(sessionId, `${area}.length`), 0);

    await sessions.releaseSession(sessionId);
  });
}

test('the two storage areas are separate: writing one does not touch the other', async () => {
  const sessionId = await freshSession();

  await handlers.set_storage({ sessionId, area: 'localStorage', value: 'local-value', key: 'k' });
  await handlers.set_storage({ sessionId, area: 'sessionStorage', value: 'session-value', key: 'k' });

  assert.equal(payload(await handlers.get_storage({ sessionId, area: 'localStorage', key: 'k' })).value, 'local-value');
  assert.equal(payload(await handlers.get_storage({ sessionId, area: 'sessionStorage', key: 'k' })).value, 'session-value');

  await handlers.clear_storage({ sessionId, area: 'sessionStorage' });
  assert.equal(
    payload(await handlers.get_storage({ sessionId, area: 'localStorage', key: 'k' })).value,
    'local-value',
    'clearing sessionStorage must leave localStorage untouched'
  );

  await sessions.releaseSession(sessionId);
});

test('storage is per origin: a value written on one host is invisible on another', async () => {
  const sessionId = await freshSession('127.0.0.1');
  await handlers.set_storage({ sessionId, area: 'localStorage', key: 'k', value: 'from-127' });

  await handlers.navigate({ sessionId, url: urlFor('localhost'), settleMs: 0 });
  const other = payload(await handlers.get_storage({ sessionId, area: 'localStorage', key: 'k' }));
  assert.equal(other.present, false, 'a different origin is a different storage area');
  assert.ok(String(other.origin).includes('localhost'), 'the reply must name the origin it actually read');

  await sessions.releaseSession(sessionId);
});

test('a tab still on about:blank gets a refusal naming the problem, not a confusing SecurityError', async () => {
  // The false-pass this prevents: an agent clears storage on a tab that never
  // navigated, reads a bare success, and concludes the app's state was reset.
  const { sessionId } = await sessions.createSession();

  for (const area of ['localStorage', 'sessionStorage'] as const) {
    for (const call of [
      () => handlers.get_storage({ sessionId, area }),
      () => handlers.set_storage({ sessionId, area, key: 'k', value: 'v' }),
      () => handlers.remove_storage({ sessionId, area, key: 'k' }),
      () => handlers.clear_storage({ sessionId, area })
    ]) {
      const err = await rejection(call);
      assert.match(err.message, /about:blank/, `${area}: the refusal must name the URL the tab is actually on`);
      assert.match(err.message, /origin/i, `${area}: the refusal must explain that storage is scoped to an origin`);
      assert.doesNotMatch(err.message, /SecurityError/, `${area}: a raw SecurityError is what this replaces`);
    }
  }

  await sessions.releaseSession(sessionId);
});

// ---------------------------------------------------------------------------
// Isolation: the whole reason this product exists
// ---------------------------------------------------------------------------

test('two concurrent sessions share no cookies and no storage, through the tools', async () => {
  const [a, b] = await Promise.all([freshSession(), freshSession()]);
  assert.notEqual(a, b);

  await Promise.all([
    handlers.set_cookies({ sessionId: a, cookies: [{ name: 'who', value: 'A', domain: '127.0.0.1', path: '/' }] }),
    handlers.set_cookies({ sessionId: b, cookies: [{ name: 'who', value: 'B', domain: '127.0.0.1', path: '/' }] }),
    handlers.set_storage({ sessionId: a, area: 'localStorage', key: 'who', value: 'A' }),
    handlers.set_storage({ sessionId: b, area: 'localStorage', key: 'who', value: 'B' }),
    handlers.set_storage({ sessionId: a, area: 'sessionStorage', key: 'who', value: 'A' }),
    handlers.set_storage({ sessionId: b, area: 'sessionStorage', key: 'who', value: 'B' })
  ]);

  const read = async (sessionId: string) => ({
    cookie: (payload(await handlers.get_cookies({ sessionId, names: ['who'] })).cookies as { value: string }[])[0]?.value,
    local: payload(await handlers.get_storage({ sessionId, area: 'localStorage', key: 'who' })).value,
    session: payload(await handlers.get_storage({ sessionId, area: 'sessionStorage', key: 'who' })).value
  });

  assert.deepEqual(await read(a), { cookie: 'A', local: 'A', session: 'A' });
  assert.deepEqual(await read(b), { cookie: 'B', local: 'B', session: 'B' });

  // Destructive calls in one session must not reach into the other either.
  await Promise.all([
    handlers.clear_cookies({ sessionId: a }),
    handlers.clear_storage({ sessionId: a, area: 'localStorage' }),
    handlers.clear_storage({ sessionId: a, area: 'sessionStorage' })
  ]);

  assert.deepEqual(await read(a), { cookie: undefined, local: null, session: null });
  assert.deepEqual(await read(b), { cookie: 'B', local: 'B', session: 'B' }, 'clearing session A must leave session B whole');

  await Promise.all([sessions.releaseSession(a), sessions.releaseSession(b)]);
});
