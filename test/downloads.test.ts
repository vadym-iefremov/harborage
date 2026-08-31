import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';
import { dirname } from 'node:path';

import { BrowserManager } from '../src/daemon/browserManager.js';
import { createToolHandlers } from '../src/daemon/tools/handlers.js';
import { SessionStore } from '../src/daemon/sessions.js';
import { downloadDir } from '../src/daemon/tools/defs/storage.js';
import { cleanupTempDirs, getFreePort, makeTestConfig } from './helpers.js';
import type { Config } from '../src/shared/config.js';

/** Exactly what a real "export CSV" button looks like from the browser's side. */
const ATTACHMENT_BODY = 'id,name\n1,alpha\n2,beta\n';

const FIXTURE_HTML = `<!doctype html>
<html><body>
  <a id="dl" href="/report.csv">download the report</a>
  <button id="inert">does nothing at all</button>
  <a id="notAttachment" href="/plain.txt">a link that just navigates</a>
</body></html>`;

let server: Server;
let baseUrl: string;
let browserManager: BrowserManager;
let sessions: SessionStore;
let handlers: ReturnType<typeof createToolHandlers>;
let config: Config;

before(async () => {
  server = createServer((req, res) => {
    if (req.url?.startsWith('/report.csv')) {
      res.setHeader('content-type', 'text/csv');
      res.setHeader('content-disposition', 'attachment; filename="quarterly report.csv"');
      res.end(ATTACHMENT_BODY);
      return;
    }
    if (req.url?.startsWith('/plain.txt')) {
      res.setHeader('content-type', 'text/plain');
      res.end('just a page, no attachment');
      return;
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(FIXTURE_HTML);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}/`;

  config = await makeTestConfig();
  browserManager = new BrowserManager(await getFreePort());
  sessions = new SessionStore(browserManager);
  handlers = createToolHandlers(sessions, {
    debugPort: await getFreePort(),
    screenshotCacheDir: config.screenshotCacheDir,
    screenshotCacheTtlMs: config.screenshotCacheTtlMs
  });
});

after(async () => {
  await sessions.closeAll();
  await browserManager.close();
  await new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve())));
  // The saved downloads live under the temp state dir, so this is what stops
  // the suite leaving files behind on the machine.
  cleanupTempDirs();
});

function payload(result: unknown): Record<string, any> {
  return (result as { structuredContent: Record<string, any> }).structuredContent;
}

async function freshSession(): Promise<string> {
  const { sessionId } = await sessions.createSession();
  await handlers.navigate({ sessionId, url: baseUrl });
  return sessionId;
}

async function rejection(fn: () => Promise<unknown>): Promise<Error> {
  try {
    await fn();
  } catch (err) {
    return err as Error;
  }
  throw new assert.AssertionError({ message: 'expected the call to reject, but it resolved' });
}

test('download_file clicks the trigger, waits for the download, and saves the real bytes', async () => {
  const sessionId = await freshSession();

  const body = payload(await handlers.download_file({ sessionId, selector: '#dl' }));

  assert.equal(body.suggestedFilename, 'quarterly report.csv', 'the server-suggested name is reported verbatim');
  assert.equal(body.sizeBytes, Buffer.byteLength(ATTACHMENT_BODY));
  assert.equal(readFileSync(body.path as string, 'utf8'), ATTACHMENT_BODY, 'the saved file must be the real payload');
  assert.equal(statSync(body.path as string).size, body.sizeBytes, 'sizeBytes must be measured off the file on disk');
  assert.match(String(body.url), /report\.csv/);

  await sessions.releaseSession(sessionId);
});

test('downloads land in a per-session directory, never a shared one', async () => {
  const [a, b] = await Promise.all([freshSession(), freshSession()]);

  const [pathA, pathB] = await Promise.all([
    handlers.download_file({ sessionId: a, selector: '#dl' }).then(r => payload(r).path as string),
    handlers.download_file({ sessionId: b, selector: '#dl' }).then(r => payload(r).path as string)
  ]);

  assert.equal(dirname(pathA), downloadDir(config.screenshotCacheDir, a));
  assert.equal(dirname(pathB), downloadDir(config.screenshotCacheDir, b));
  assert.notEqual(dirname(pathA), dirname(pathB), 'one session must not be able to read another session\'s downloads');
  assert.notEqual(pathA, pathB);
  // Two agents grabbing the same file name must not overwrite each other.
  assert.equal(readFileSync(pathA, 'utf8'), ATTACHMENT_BODY);
  assert.equal(readFileSync(pathB, 'utf8'), ATTACHMENT_BODY);

  await Promise.all([sessions.releaseSession(a), sessions.releaseSession(b)]);
});

test('two downloads in one session get separate files rather than clobbering each other', async () => {
  const sessionId = await freshSession();
  const first = payload(await handlers.download_file({ sessionId, selector: '#dl' }));
  const second = payload(await handlers.download_file({ sessionId, selector: '#dl' }));

  assert.notEqual(first.path, second.path, 'the same suggested filename twice must not overwrite the first file');
  assert.equal(readFileSync(first.path as string, 'utf8'), ATTACHMENT_BODY);
  assert.equal(readFileSync(second.path as string, 'utf8'), ATTACHMENT_BODY);

  await sessions.releaseSession(sessionId);
});

test('a trigger that starts no download times out saying exactly that, not "save failed"', async () => {
  const sessionId = await freshSession();

  const err = await rejection(() => handlers.download_file({ sessionId, selector: '#inert', timeoutMs: 1200 }));
  assert.match(err.message, /no download started/i, 'the message must name the real outcome: nothing was ever offered');
  assert.match(err.message, /1200/, 'it must say how long it waited');
  assert.doesNotMatch(err.message, /saveAs|ENOENT/i, 'a failed save is a different outcome and must not be implied');

  // A link that merely navigates is the same "no download" outcome, and is the
  // case an agent hits when a Content-Disposition header is missing.
  const navErr = await rejection(() =>
    handlers.download_file({ sessionId, selector: '#notAttachment', timeoutMs: 1200 })
  );
  assert.match(navErr.message, /no download started/i);

  await sessions.releaseSession(sessionId);
});

test('download_file can be triggered by an expression as well as by a selector', async () => {
  const sessionId = await freshSession();

  const body = payload(
    await handlers.download_file({ sessionId, expression: "document.getElementById('dl').click()" })
  );
  assert.equal(readFileSync(body.path as string, 'utf8'), ATTACHMENT_BODY);

  const both = await rejection(() =>
    handlers.download_file({ sessionId, selector: '#dl', expression: 'void 0' })
  );
  assert.match(both.message, /exactly one/i, 'passing both triggers is a contradiction, not a silent preference');

  const neither = await rejection(() => handlers.download_file({ sessionId }));
  assert.match(neither.message, /exactly one/i);

  await sessions.releaseSession(sessionId);
});
