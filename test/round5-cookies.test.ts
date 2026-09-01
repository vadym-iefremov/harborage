import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';

import type { BrowserContext, Cookie } from 'playwright';

import { BrowserManager } from '../src/daemon/browserManager.js';
import { createToolHandlers } from '../src/daemon/tools/handlers.js';
import { SessionStore } from '../src/daemon/sessions.js';
import { getFreePort } from './helpers.js';

/**
 * Round 5 QA on set_cookies, for two defects that pull in opposite
 * directions and have to be fixed together.
 *
 * Finding 5, a FALSE FAILURE: the read-back keyed a requested cookie on the
 * caller's `domain` verbatim, but Chromium normalises that domain before it
 * stores it. A cookie asked for as ".127.0.0.1" lands in the jar under
 * "127.0.0.1", the key lookup missed it, and a perfectly good install was
 * reported in `missing`. IP literals and single-label hosts are what you
 * point this at when you are driving a local dev server, so it was the
 * common case rather than an exotic one.
 *
 * Finding 6, a FALSE PASS: the value was not part of the identity key, so an
 * overwrite the browser threw away (sameSite "None" without secure) left the
 * ORIGINAL cookie sitting in the jar under the requested identity, and the
 * tool reported that stale cookie back as if the write had landed.
 *
 * Every assertion here is graded against the jar read straight off the
 * Playwright BrowserContext, and in one case against what the page itself
 * sees through document.cookie, never against what set_cookies chose to
 * report. That matters: in the round that produced these findings, nine of
 * fourteen apparent failures turned out to be defects in the probe rather
 * than in the product.
 */

const PAGE_HTML = `<!doctype html><html><body><h1>round5 cookie fixture</h1></body></html>`;

let server: Server;
let port: number;
let browserManager: BrowserManager;
let sessions: SessionStore;
let handlers: ReturnType<typeof createToolHandlers>;

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
  await handlers.navigate({ sessionId, url: `http://127.0.0.1:${port}/`, settleMs: 0 });
  return sessionId;
}

/** THE ORACLE. Raw Playwright, no tool code between it and the browser. */
function contextOf(sessionId: string): BrowserContext {
  return sessions.resolve(sessionId).session.context;
}

async function jarOf(sessionId: string): Promise<Cookie[]> {
  return contextOf(sessionId).cookies();
}

async function oracleFind(sessionId: string, name: string): Promise<Cookie | undefined> {
  return (await jarOf(sessionId)).find(c => c.name === name);
}

/**
 * What "the tool told me the write landed" means, as one predicate rather
 * than a literal-string check, so a reworded note cannot make a test pass or
 * fail on its own.
 */
function claimsInstalled(result: Record<string, any>, name: string, domain: string, path: string): boolean {
  const named = (result.missing as string[] | undefined) ?? [];
  if (named.includes(name)) return false;
  const flagged = (result.stale as { name: string; domain: string; path: string }[] | undefined) ?? [];
  if (flagged.some(s => s.name === name && s.domain === domain && s.path === path)) return false;
  return (result.cookies as Cookie[]).some(c => c.name === name && c.domain === domain && c.path === path);
}

// ---------------------------------------------------------------------------
// Finding 5: a successfully installed cookie must not be reported missing
// ---------------------------------------------------------------------------

test('a cookie asked for with a leading-dot IP domain is reported installed, not missing', async () => {
  const sessionId = await freshSession();

  const result = payload(
    await handlers.set_cookies({
      sessionId,
      cookies: [{ name: 'sid', value: 'dot-ip-ok', domain: '.127.0.0.1', path: '/' }]
    })
  );

  // Oracle first: confirm the fixture really installed what this test claims
  // it installed, before concluding anything about the tool's reporting.
  const stored = await oracleFind(sessionId, 'sid');
  assert.ok(stored, 'the browser must actually hold the cookie for this test to be about reporting at all');
  assert.equal(stored.domain, '127.0.0.1', 'Chromium strips the leading dot for an IP literal');
  assert.equal(stored.value, 'dot-ip-ok');

  assert.equal(result.missing, undefined, 'an installed cookie must not be listed as missing');
  assert.equal(result.note, undefined, 'an installed cookie must not carry a failure note');
  assert.ok(
    claimsInstalled(result, 'sid', '127.0.0.1', '/'),
    'the read-back must report the cookie under the domain the browser actually stored it under'
  );

  await sessions.releaseSession(sessionId);
});

test('a cookie asked for with a leading-dot single-label domain is reported installed, not missing', async () => {
  const sessionId = await freshSession();

  const result = payload(
    await handlers.set_cookies({
      sessionId,
      cookies: [{ name: 'sid', value: 'dot-localhost-ok', domain: '.localhost', path: '/' }]
    })
  );

  const stored = await oracleFind(sessionId, 'sid');
  assert.ok(stored, 'the browser must actually hold the cookie');
  assert.equal(stored.domain, 'localhost', 'Chromium strips the leading dot for a single-label host');

  assert.equal(result.missing, undefined);
  assert.ok(claimsInstalled(result, 'sid', 'localhost', '/'));

  await sessions.releaseSession(sessionId);
});

test('an uppercase and an IDN domain are reported installed, not missing', async () => {
  const sessionId = await freshSession();

  const result = payload(
    await handlers.set_cookies({
      sessionId,
      cookies: [
        { name: 'upper', value: 'u', domain: '.EXAMPLE.COM', path: '/' },
        { name: 'idn', value: 'i', domain: 'münchen.de', path: '/' }
      ]
    })
  );

  const jar = await jarOf(sessionId);
  assert.equal(jar.find(c => c.name === 'upper')?.domain, '.example.com');
  assert.equal(jar.find(c => c.name === 'idn')?.domain, 'xn--mnchen-3ya.de');

  assert.equal(result.missing, undefined, 'lowercasing and IDN-to-punycode are not rejections');
  assert.ok(claimsInstalled(result, 'upper', '.example.com', '/'));
  assert.ok(claimsInstalled(result, 'idn', 'xn--mnchen-3ya.de', '/'));

  await sessions.releaseSession(sessionId);
});

test('a leading-dot public suffix, which Chromium demotes to host-only, is reported installed', async () => {
  const sessionId = await freshSession();

  // ".co.uk" cannot be a domain cookie, so Chromium keeps it as host-only
  // "co.uk". This one is not predictable from the shape of the string: it
  // needs the public suffix list. The read-back has to cope with it anyway.
  const result = payload(
    await handlers.set_cookies({
      sessionId,
      cookies: [{ name: 'psl', value: 'p', domain: '.co.uk', path: '/' }]
    })
  );

  assert.equal((await oracleFind(sessionId, 'psl'))?.domain, 'co.uk');
  assert.equal(result.missing, undefined);
  assert.ok(claimsInstalled(result, 'psl', 'co.uk', '/'));

  await sessions.releaseSession(sessionId);
});

test('a partitioned cookie whose partitionKey Chromium rewrites to the site is reported installed', async () => {
  const sessionId = await freshSession();

  // Chromium stores the partition as the top-level SITE, so
  // "https://top.example.com" comes back as "https://example.com". Keying
  // the read-back on the requested string is the same false failure as the
  // domain one, one field along.
  const result = payload(
    await handlers.set_cookies({
      sessionId,
      cookies: [
        {
          name: 'chips',
          value: 'c',
          domain: 'third.test',
          path: '/',
          secure: true,
          sameSite: 'None',
          partitionKey: 'https://top.example.com'
        }
      ]
    })
  );

  const stored = await oracleFind(sessionId, 'chips');
  assert.ok(stored, 'the partitioned cookie must actually be in the jar');
  assert.equal((stored as { partitionKey?: string }).partitionKey, 'https://example.com');

  assert.equal(result.missing, undefined);
  assert.ok(claimsInstalled(result, 'chips', 'third.test', '/'));

  await sessions.releaseSession(sessionId);
});

test('the page itself can read a cookie installed with a leading-dot IP domain', async () => {
  const sessionId = await freshSession();

  await handlers.set_cookies({
    sessionId,
    cookies: [{ name: 'visible', value: 'to-the-page', domain: '.127.0.0.1', path: '/' }]
  });

  // Second oracle: what the document sees, straight through page.evaluate,
  // with no harborage code in the path. This is what makes "the fixture
  // really installed it" a fact rather than an assumption.
  const page = sessions.resolve(sessionId).page;
  await page.reload();
  const documentCookie = await page.evaluate(() => document.cookie);
  assert.match(documentCookie, /visible=to-the-page/);

  await sessions.releaseSession(sessionId);
});

// ---------------------------------------------------------------------------
// Finding 5 must not overshoot into finding 6: a genuinely rejected cookie
// still has to read as rejected
// ---------------------------------------------------------------------------

test('a genuinely rejected cookie on a leading-dot IP domain is still reported missing', async () => {
  const sessionId = await freshSession();

  const result = payload(
    await handlers.set_cookies({
      sessionId,
      cookies: [{ name: 'sid', value: 'rejected', domain: '.127.0.0.1', path: '/', sameSite: 'None' }]
    })
  );

  assert.equal(await oracleFind(sessionId, 'sid'), undefined, 'the browser must have dropped it');
  assert.deepEqual(result.missing, ['sid'], 'tolerating the dot must not make a rejection read as a success');
  assert.equal(claimsInstalled(result, 'sid', '127.0.0.1', '/'), false);

  await sessions.releaseSession(sessionId);
});

test('a rejected leading-dot write does not borrow the host-only cookie already in the jar', async () => {
  const sessionId = await freshSession();

  await handlers.set_cookies({
    sessionId,
    cookies: [{ name: 'sid', value: 'HOST-ONLY-OLD', domain: '127.0.0.1', path: '/' }]
  });

  // The dot-tolerant lookup would find that host-only cookie. The value
  // check is what stops it standing in for a write the browser refused.
  const result = payload(
    await handlers.set_cookies({
      sessionId,
      cookies: [{ name: 'sid', value: 'DOMAIN-NEW', domain: '.127.0.0.1', path: '/', sameSite: 'None' }]
    })
  );

  assert.equal((await oracleFind(sessionId, 'sid'))?.value, 'HOST-ONLY-OLD', 'the jar must still hold the old value');
  assert.equal(claimsInstalled(result, 'sid', '127.0.0.1', '/'), false, 'a refused write must never read as installed');

  await sessions.releaseSession(sessionId);
});

// ---------------------------------------------------------------------------
// Finding 6: a rejected overwrite must not report success
// ---------------------------------------------------------------------------

test('an overwrite the browser threw away is not reported as the cookie that was asked for', async () => {
  const sessionId = await freshSession();

  await handlers.set_cookies({
    sessionId,
    cookies: [{ name: 'sid', value: 'ORIGINAL', domain: '127.0.0.1', path: '/' }]
  });
  assert.equal((await oracleFind(sessionId, 'sid'))?.value, 'ORIGINAL', 'the fixture must install ORIGINAL first');

  const result = payload(
    await handlers.set_cookies({
      sessionId,
      cookies: [{ name: 'sid', value: 'REPLACED', domain: '127.0.0.1', path: '/', sameSite: 'None', secure: false }]
    })
  );

  // Oracle: the jar still holds ORIGINAL, so the write did not land.
  assert.equal((await oracleFind(sessionId, 'sid'))?.value, 'ORIGINAL', 'Chromium must have refused the overwrite');

  assert.equal(
    claimsInstalled(result, 'sid', '127.0.0.1', '/'),
    false,
    'the stale ORIGINAL cookie must not be reported as the requested write'
  );
  assert.deepEqual(result.stale, [{ name: 'sid', domain: '127.0.0.1', path: '/', differs: ['value', 'sameSite'] }]);
  assert.equal(result.missing, undefined, 'the cookie IS in the jar, so "missing" would be a lie about a different thing');
  assert.match(result.note as string, /did not accept/i);

  await sessions.releaseSession(sessionId);
});

test('an overwrite the browser accepted is reported plainly, with no stale flag', async () => {
  const sessionId = await freshSession();

  await handlers.set_cookies({
    sessionId,
    cookies: [{ name: 'sid', value: 'ORIGINAL', domain: '127.0.0.1', path: '/' }]
  });
  const result = payload(
    await handlers.set_cookies({
      sessionId,
      cookies: [{ name: 'sid', value: 'SECOND', domain: '127.0.0.1', path: '/' }]
    })
  );

  assert.equal((await oracleFind(sessionId, 'sid'))?.value, 'SECOND');
  assert.equal(result.stale, undefined);
  assert.equal(result.missing, undefined);
  assert.equal(result.note, undefined);
  assert.ok(claimsInstalled(result, 'sid', '127.0.0.1', '/'));

  await sessions.releaseSession(sessionId);
});

// ---------------------------------------------------------------------------
// Finding 6 must not overshoot into a new false failure: everything Chromium
// legitimately changes about an ACCEPTED cookie has to stay invisible
// ---------------------------------------------------------------------------

test('an expiry Chromium clamps to its 400 day cap is not reported as a rejection', async () => {
  const sessionId = await freshSession();

  const tenYears = Math.floor(Date.now() / 1000) + 10 * 365 * 24 * 60 * 60;
  const result = payload(
    await handlers.set_cookies({
      sessionId,
      cookies: [{ name: 'long', value: 'v', domain: '127.0.0.1', path: '/', expires: tenYears }]
    })
  );

  const stored = await oracleFind(sessionId, 'long');
  assert.ok(stored, 'the cookie must be in the jar');
  assert.ok(stored.expires < tenYears - 86400, 'the fixture is only meaningful if Chromium really clamped the expiry');

  assert.equal(result.stale, undefined, 'a clamped expiry is Chromium being Chromium, not a refused write');
  assert.equal(result.missing, undefined);
  assert.ok(claimsInstalled(result, 'long', '127.0.0.1', '/'));

  await sessions.releaseSession(sessionId);
});

test('a session cookie, which has no expiry at all, is not reported as a rejection', async () => {
  const sessionId = await freshSession();

  const result = payload(
    await handlers.set_cookies({
      sessionId,
      cookies: [{ name: 'sess', value: 'v', domain: '127.0.0.1', path: '/' }]
    })
  );

  assert.equal((await oracleFind(sessionId, 'sess'))?.expires, -1, 'a session cookie reads back as expires -1');
  assert.equal(result.stale, undefined);
  assert.equal(result.missing, undefined);

  await sessions.releaseSession(sessionId);
});

test('flags the browser adds on its own, from an https url, are not reported as a rejection', async () => {
  const sessionId = await freshSession();

  // An https url marks the cookie secure and takes the path from the url's
  // directory. Neither was asked for in so many words, so neither can count
  // as the browser refusing what was asked for.
  const result = payload(
    await handlers.set_cookies({
      sessionId,
      cookies: [{ name: 'fromurl', value: 'v', url: 'https://url.test/some/page' }]
    })
  );

  const stored = await oracleFind(sessionId, 'fromurl');
  assert.ok(stored);
  assert.equal(stored.secure, true, 'the fixture is only meaningful if the browser really added secure');
  assert.equal(stored.path, '/some/');
  assert.equal(stored.sameSite, 'Lax', 'and defaulted sameSite, which was never requested either');

  assert.equal(result.stale, undefined);
  assert.equal(result.missing, undefined);
  assert.ok(claimsInstalled(result, 'fromurl', 'url.test', '/some/'));

  await sessions.releaseSession(sessionId);
});

test('the same cookie asked for twice in one call reports the last write, not a stale first one', async () => {
  const sessionId = await freshSession();

  // addCookies applies the array in order, so the second entry wins. Judging
  // the first one against the final jar would invent a rejection that never
  // happened.
  const result = payload(
    await handlers.set_cookies({
      sessionId,
      cookies: [
        { name: 'dup', value: 'FIRST', domain: '.127.0.0.1', path: '/' },
        { name: 'dup', value: 'SECOND', domain: '127.0.0.1', path: '/' }
      ]
    })
  );

  assert.equal((await oracleFind(sessionId, 'dup'))?.value, 'SECOND');
  assert.equal(result.stale, undefined);
  assert.equal(result.missing, undefined);

  await sessions.releaseSession(sessionId);
});

test('an https url with an explicit secure:false is an accepted write, not a refused one', async () => {
  const sessionId = await freshSession();

  // The pair contradicts itself and the url wins: measured, the cookie is
  // accepted and stored with secure true. Comparing the requested flag
  // naively would announce a refusal for a write that landed, which is the
  // false failure the finding 6 fix must not become.
  const result = payload(
    await handlers.set_cookies({
      sessionId,
      cookies: [{ name: 'contradiction', value: 'v', url: 'https://url.test/', secure: false }]
    })
  );

  const stored = await oracleFind(sessionId, 'contradiction');
  assert.ok(stored, 'the browser must have accepted it');
  assert.equal(stored.secure, true, 'the fixture is only meaningful if the url really overrode secure:false');

  assert.equal(result.stale, undefined);
  assert.equal(result.missing, undefined);
  assert.ok(claimsInstalled(result, 'contradiction', 'url.test', '/'));

  await sessions.releaseSession(sessionId);
});

test('an expiry inside the 400 day cap is stored exactly and is not reported as a rejection', async () => {
  const sessionId = await freshSession();

  // The other side of the clamp test above: 400 days is honoured to the
  // second, 401 is cut back. Both have to read as installed.
  const now = Math.floor(Date.now() / 1000);
  const result = payload(
    await handlers.set_cookies({
      sessionId,
      cookies: [{ name: 'atcap', value: 'v', domain: '127.0.0.1', path: '/', expires: now + 400 * 24 * 60 * 60 }]
    })
  );

  assert.equal((await oracleFind(sessionId, 'atcap'))?.expires, now + 400 * 24 * 60 * 60);
  assert.equal(result.stale, undefined);
  assert.equal(result.missing, undefined);

  await sessions.releaseSession(sessionId);
});
