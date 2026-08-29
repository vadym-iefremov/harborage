import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { BrowserManager } from '../src/daemon/browserManager.js';
import { createToolHandlers } from '../src/daemon/tools/handlers.js';
import { SessionStore } from '../src/daemon/sessions.js';
import { getFreePort, snapshotRepoFiles } from './helpers.js';

let browserManager: BrowserManager;
let sessions: SessionStore;
let debugPort: number;

before(async () => {
  debugPort = await getFreePort();
  browserManager = new BrowserManager(debugPort);
  sessions = new SessionStore(browserManager);
});

after(async () => {
  await sessions.closeAll();
  await browserManager.close();
});

test('screenshot returns inline base64 image data and writes nothing to disk anywhere in the repo', async () => {
  const filesBefore = snapshotRepoFiles();

  const handlers = createToolHandlers(sessions, debugPort);
  const { sessionId } = await sessions.createSession();
  await sessions.resolve(sessionId).page.goto('data:text/html,<h1 style="color:blue">inline screenshot check</h1>');

  const result = await handlers.screenshot({ sessionId, fullPage: false });

  assert.ok('content' in result, 'expected a content array on the tool result');
  const [block] = (result as { content: { type: string; data: string; mimeType: string }[] }).content;
  assert.equal(block.type, 'image');
  assert.equal(block.mimeType, 'image/png');
  assert.ok(block.data.length > 0, 'expected non-empty base64 image data');
  // Round-trips as valid base64 (throws on invalid input in this context).
  const buffer = Buffer.from(block.data, 'base64');
  assert.ok(buffer.length > 0);
  // A PNG file starts with this exact 8-byte signature.
  assert.deepEqual([...buffer.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const filesAfter = snapshotRepoFiles();
  assert.deepEqual(filesAfter, filesBefore, 'expected the repo file listing to be unchanged after taking a screenshot');

  await sessions.releaseSession(sessionId);
});
