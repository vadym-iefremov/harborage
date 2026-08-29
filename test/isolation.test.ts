import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { BrowserManager } from '../src/daemon/browserManager.js';
import { SessionStore } from '../src/daemon/sessions.js';
import { getFreePort, startTestPage } from './helpers.js';

let browserManager: BrowserManager;
let sessions: SessionStore;
let page: { url: string; close: () => Promise<void> };

before(async () => {
  browserManager = new BrowserManager(await getFreePort());
  sessions = new SessionStore(browserManager);
  page = await startTestPage();
});

after(async () => {
  await sessions.closeAll();
  await browserManager.close();
  await page.close();
});

test('two concurrent sessions have zero state bleed-through', async () => {
  const { sessionId: idA } = await sessions.createSession();
  const { sessionId: idB } = await sessions.createSession();
  assert.notEqual(idA, idB);

  const a = sessions.resolve(idA);
  const b = sessions.resolve(idB);

  await Promise.all([a.page.goto(page.url), b.page.goto(page.url)]);

  // Set distinct localStorage values in each session concurrently.
  await Promise.all([
    a.page.evaluate(() => localStorage.setItem('marker', 'session-A')),
    b.page.evaluate(() => localStorage.setItem('marker', 'session-B'))
  ]);

  const [valueInA, valueInB] = await Promise.all([
    a.page.evaluate(() => localStorage.getItem('marker')),
    b.page.evaluate(() => localStorage.getItem('marker'))
  ]);

  assert.equal(valueInA, 'session-A');
  assert.equal(valueInB, 'session-B');
  assert.notEqual(valueInA, valueInB);

  // Cookies set via document.cookie in one context must not appear in the other.
  await Promise.all([
    a.page.evaluate(() => {
      document.cookie = 'clientMarker=A-cookie; path=/';
    }),
    b.page.evaluate(() => {
      document.cookie = 'clientMarker=B-cookie; path=/';
    })
  ]);

  const [cookiesA, cookiesB] = await Promise.all([
    sessions.resolve(idA).session.context.cookies(),
    sessions.resolve(idB).session.context.cookies()
  ]);

  const markerA = cookiesA.find(c => c.name === 'clientMarker')?.value;
  const markerB = cookiesB.find(c => c.name === 'clientMarker')?.value;
  assert.equal(markerA, 'A-cookie');
  assert.equal(markerB, 'B-cookie');

  await sessions.releaseSession(idA);
  await sessions.releaseSession(idB);
});

test('sessions run on genuinely separate BrowserContexts', async () => {
  const { sessionId: idA } = await sessions.createSession();
  const { sessionId: idB } = await sessions.createSession();
  const a = sessions.resolve(idA);
  const b = sessions.resolve(idB);
  assert.notEqual(a.session.context, b.session.context);
  await sessions.releaseSession(idA);
  await sessions.releaseSession(idB);
});
