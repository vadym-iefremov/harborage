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

test('export_state -> create_session(seed) carries cookies and localStorage over', async () => {
  const { sessionId: sourceId } = await sessions.createSession();
  const source = sessions.resolve(sourceId);
  // Visiting the page picks up the Set-Cookie response header from startTestPage().
  await source.page.goto(page.url);
  await source.page.evaluate(() => localStorage.setItem('sessionMarker', 'seeded-from-source'));

  const storageState = await source.session.context.storageState();
  assert.ok(storageState.cookies.some(c => c.name === 'harborage_test_sid'), 'expected the exported state to include the cookie set by the test page');
  assert.ok(
    storageState.origins.some(o => o.localStorage.some(item => item.name === 'sessionMarker')),
    'expected the exported state to include the localStorage value set in the source session'
  );

  const { sessionId: seededId } = await sessions.createSession(storageState);
  const seeded = sessions.resolve(seededId);

  // A brand-new session, seeded from export_state, already has the cookie
  // before we ever navigate it anywhere in this test.
  const cookiesBeforeNav = await seeded.session.context.cookies();
  assert.ok(cookiesBeforeNav.some(c => c.name === 'harborage_test_sid' && c.value === 'cookie-value'));

  // Navigating to the same origin exposes the seeded localStorage too.
  await seeded.page.goto(page.url);
  const seededValue = await seeded.page.evaluate(() => localStorage.getItem('sessionMarker'));
  assert.equal(seededValue, 'seeded-from-source');

  await sessions.releaseSession(sourceId);
  await sessions.releaseSession(seededId);
});

test('a session created without storageState starts with none of that state', async () => {
  const { sessionId } = await sessions.createSession();
  const target = sessions.resolve(sessionId);
  await target.page.goto(page.url);
  const value = await target.page.evaluate(() => localStorage.getItem('sessionMarker'));
  assert.equal(value, null);
  await sessions.releaseSession(sessionId);
});
