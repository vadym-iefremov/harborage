import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { after, before, test } from 'node:test';

import { BrowserManager } from '../src/daemon/browserManager.js';
import { SessionStore } from '../src/daemon/sessions.js';
import { getFreePort } from './helpers.js';

const execFileAsync = promisify(execFile);

let debugPort: number;
let browserManager: BrowserManager;
let sessions: SessionStore;

before(async () => {
  debugPort = await getFreePort();
  browserManager = new BrowserManager(debugPort);
  sessions = new SessionStore(browserManager);
});

after(async () => {
  await sessions.closeAll();
  await browserManager.close();
});

test('the launched Chromium process is genuinely headless and sandboxed', async () => {
  // Force the browser to actually launch.
  await sessions.createSession();

  // Find the OS process bound to the debug port we asked Chromium to open,
  // then inspect its real command line, the only way to actually prove
  // "headless" and "sandbox on" rather than just trusting our own launch
  // options were honored.
  const { stdout: lsofOut } = await execFileAsync('lsof', ['-nP', `-iTCP:${debugPort}`, '-sTCP:LISTEN']);
  const line = lsofOut.split('\n').find(l => /LISTEN/.test(l));
  assert.ok(line, `expected a process listening on debug port ${debugPort}, got:\n${lsofOut}`);
  const pid = line!.trim().split(/\s+/)[1];
  assert.ok(pid, 'could not parse PID from lsof output');

  const { stdout: cmd } = await execFileAsync('ps', ['-p', pid!, '-o', 'command=']);

  assert.match(cmd, /--headless\b/, 'expected the real Chromium command line to include --headless');
  assert.doesNotMatch(cmd, /--no-sandbox\b/, 'expected the OS sandbox to stay ON (no --no-sandbox), see browserManager.ts');
  assert.doesNotMatch(cmd, /--headed\b/, 'expected no --headed flag');
});

test('a headless session still renders real content (functional, not just flag-checked)', async () => {
  const { sessionId } = await sessions.createSession();
  const target = sessions.resolve(sessionId);
  await target.page.goto('data:text/html,<h1 id="t">headless render check</h1>');
  const text = await target.page.evaluate(() => document.getElementById('t')?.textContent);
  assert.equal(text, 'headless render check');
  const shot = await target.page.screenshot({ type: 'png' });
  assert.ok(shot.length > 0, 'expected a non-empty screenshot buffer');
  await sessions.releaseSession(sessionId);
});
