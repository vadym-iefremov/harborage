import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';

import { BrowserManager } from '../src/daemon/browserManager.js';
import { SessionStore } from '../src/daemon/sessions.js';
import { pngDimensions } from '../src/daemon/tools/defs/inspect.js';
import { createToolHandlers } from '../src/daemon/tools/handlers.js';
import { getFreePort } from './helpers.js';

/**
 * A page with one element of an exactly known pixel size, sitting inside a
 * much larger body. That is the shape the QA round complained about: a small
 * panel lost in a 1280x720 viewport of mostly-canvas.
 */
const PANEL_WIDTH = 330;
const PANEL_HEIGHT = 100;

const fixtureHtml = `<!doctype html>
<html><head><style>
  html, body { margin: 0; padding: 0; background: #101014; }
  #spacer { height: 2000px; }
  #panel {
    position: absolute; left: 40px; top: 60px;
    width: ${PANEL_WIDTH}px; height: ${PANEL_HEIGHT}px;
    box-sizing: border-box; background: #f4c542; border: 2px solid #000;
  }
  .twin { width: 10px; height: 10px; background: #333; }
</style></head>
<body>
  <div id="spacer"></div>
  <div id="panel">panel</div>
  <div class="twin"></div><div class="twin"></div>
</body></html>`;

let browserManager: BrowserManager;
let sessions: SessionStore;
let handlers: ReturnType<typeof createToolHandlers>;
let screenshotCacheDir: string;
let server: Server;
let pageUrl: string;

interface CachedPayload {
  mode: string;
  path: string;
  cacheId: string;
  sizeBytes: number;
  width: number;
  height: number;
  expiresAt: string;
}

function structured<T>(result: unknown): T {
  return (result as { structuredContent: T }).structuredContent;
}

function imageBuffer(result: unknown): Buffer {
  const blocks = (result as { content: { type: string; data?: string }[] }).content;
  const image = blocks.find(b => b.type === 'image');
  assert.ok(image?.data, 'expected an inline image content block');
  return Buffer.from(image.data, 'base64');
}

before(async () => {
  const debugPort = await getFreePort();
  browserManager = new BrowserManager(debugPort);
  sessions = new SessionStore(browserManager);
  screenshotCacheDir = join(mkdtempSync(join(tmpdir(), 'harborage-test-')), 'screenshots');
  handlers = createToolHandlers(sessions, { debugPort, screenshotCacheDir, screenshotCacheTtlMs: 30 * 60 * 1000 });

  server = createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(fixtureHtml);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  pageUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/`;
});

after(async () => {
  await sessions.closeAll();
  await browserManager.close();
  await new Promise<void>(resolve => server.close(() => resolve()));
});

async function freshSession(): Promise<string> {
  const { sessionId } = await sessions.createSession();
  await sessions.resolve(sessionId).page.goto(pageUrl);
  return sessionId;
}

test('pngDimensions reads width and height out of a PNG header, and rejects anything else', async () => {
  const sessionId = await freshSession();
  const result = await handlers.screenshot({ sessionId });
  const dims = pngDimensions(imageBuffer(result));
  assert.equal(dims.width, 1280);
  assert.equal(dims.height, 720);

  assert.throws(() => pngDimensions(Buffer.from('not a png at all, not even close')), /PNG/i);
  assert.throws(() => pngDimensions(Buffer.alloc(4)), /PNG/i);

  await sessions.releaseSession(sessionId);
});

test('selector captures just that element, at exactly its own pixel size', async () => {
  const sessionId = await freshSession();

  const result = await handlers.screenshot({ sessionId, selector: '#panel' });
  const payload = structured<{ width: number; height: number; selector: string }>(result);

  assert.equal(payload.width, PANEL_WIDTH);
  assert.equal(payload.height, PANEL_HEIGHT);
  assert.equal(payload.selector, '#panel');

  // The reported numbers are the truth about the bytes, not about the request.
  assert.deepEqual(pngDimensions(imageBuffer(result)), { width: PANEL_WIDTH, height: PANEL_HEIGHT });

  await sessions.releaseSession(sessionId);
});

test('clip captures exactly the requested region', async () => {
  const sessionId = await freshSession();

  const result = await handlers.screenshot({ sessionId, clip: { x: 10, y: 20, width: 200, height: 120 } });
  const payload = structured<{ width: number; height: number }>(result);

  assert.equal(payload.width, 200);
  assert.equal(payload.height, 120);
  assert.deepEqual(pngDimensions(imageBuffer(result)), { width: 200, height: 120 });

  await sessions.releaseSession(sessionId);
});

test('contradictory capture options are rejected, never silently ignored', async () => {
  const sessionId = await freshSession();

  await assert.rejects(
    () => handlers.screenshot({ sessionId, selector: '#panel', clip: { x: 0, y: 0, width: 10, height: 10 } }),
    /selector.*clip|clip.*selector/i
  );
  await assert.rejects(() => handlers.screenshot({ sessionId, selector: '#panel', fullPage: true }), /fullPage/i);
  await assert.rejects(
    () => handlers.screenshot({ sessionId, clip: { x: 0, y: 0, width: 10, height: 10 }, fullPage: true }),
    /fullPage/i
  );

  await sessions.releaseSession(sessionId);
});

test('a selector matching nothing fails fast with a useful message instead of hanging', async () => {
  const sessionId = await freshSession();
  const started = Date.now();

  await assert.rejects(
    () => handlers.screenshot({ sessionId, selector: '#no-such-element', timeoutMs: 500 }),
    /#no-such-element/
  );
  assert.ok(Date.now() - started < 10_000, 'expected the bounded selector wait to give up quickly');

  await sessions.releaseSession(sessionId);
});

test('a selector matching several elements says so rather than picking one at random', async () => {
  const sessionId = await freshSession();
  await assert.rejects(() => handlers.screenshot({ sessionId, selector: '.twin', timeoutMs: 500 }), /\.twin/);
  await sessions.releaseSession(sessionId);
});

test('every screenshot result reports the pixel dimensions of the file it produced', async () => {
  const sessionId = await freshSession();

  // Inline.
  const inline = await handlers.screenshot({ sessionId });
  const inlinePayload = structured<{ width: number; height: number; mode: string }>(inline);
  assert.deepEqual({ width: inlinePayload.width, height: inlinePayload.height }, pngDimensions(imageBuffer(inline)));
  assert.equal(inlinePayload.mode, 'inline');

  // Cached: the numbers must describe the bytes on disk, which is the whole
  // point. A cached capture used to hand back a path and nothing else, so a
  // viewport mismatch was invisible without opening the file.
  const cached = await handlers.screenshot({ sessionId, mode: 'cached' });
  const cachedPayload = structured<CachedPayload>(cached);
  assert.ok(existsSync(cachedPayload.path));
  assert.deepEqual(
    { width: cachedPayload.width, height: cachedPayload.height },
    pngDimensions(readFileSync(cachedPayload.path))
  );

  // Full page is taller than the viewport, and says so.
  const full = await handlers.screenshot({ sessionId, fullPage: true });
  const fullPayload = structured<{ width: number; height: number }>(full);
  assert.deepEqual({ width: fullPayload.width, height: fullPayload.height }, pngDimensions(imageBuffer(full)));
  assert.ok(fullPayload.height > 1000, `expected a full-page capture to be tall, got ${fullPayload.height}`);

  await sessions.releaseSession(sessionId);
});

test('reported dimensions describe the capture even when a CDP viewport override disagrees with innerWidth', async () => {
  const sessionId = await freshSession();

  await handlers.send_cdp_command({
    sessionId,
    method: 'Emulation.setDeviceMetricsOverride',
    params: { width: 400, height: 800, deviceScaleFactor: 1, mobile: false }
  });

  const innerWidth = structured<{ result: number }>(await handlers.evaluate({ sessionId, expression: 'innerWidth' })).result;
  const shot = await handlers.screenshot({ sessionId, mode: 'cached' });
  const payload = structured<CachedPayload>(shot);

  // Whatever Chromium actually did with the override, the numbers we hand
  // back are read out of the PNG, so an agent can see the mismatch.
  assert.deepEqual({ width: payload.width, height: payload.height }, pngDimensions(readFileSync(payload.path)));
  assert.ok(Number.isInteger(innerWidth) && innerWidth > 0);

  await sessions.releaseSession(sessionId);
});

test('two concurrent sessions cache their screenshots in separate per-session directories', async () => {
  const first = await freshSession();
  const second = await freshSession();

  const a = structured<CachedPayload>(await handlers.screenshot({ sessionId: first, mode: 'cached' }));
  const b = structured<CachedPayload>(await handlers.screenshot({ sessionId: second, mode: 'cached' }));

  assert.notEqual(dirname(a.path), dirname(b.path), 'two sessions must not share one screenshot directory');
  assert.equal(dirname(a.path), join(screenshotCacheDir, first));
  assert.equal(dirname(b.path), join(screenshotCacheDir, second));
  assert.ok(existsSync(a.path) && existsSync(b.path));

  await sessions.releaseSession(first);
  await sessions.releaseSession(second);
});

test('a clip reaching past the viewport edge is truncated, and the result says so', async () => {
  const sessionId = await freshSession();

  // Chromium quietly shrinks a clip to what is actually on screen. Reading
  // the size back out of the PNG is what makes that visible.
  const result = await handlers.screenshot({ sessionId, clip: { x: 1200, y: 0, width: 400, height: 50 } });
  const payload = structured<{ width: number; height: number }>(result);

  assert.ok(payload.width < 400, `expected the clip to be truncated at the viewport edge, got ${payload.width}`);
  assert.deepEqual(pngDimensions(imageBuffer(result)), { width: payload.width, height: payload.height });

  await sessions.releaseSession(sessionId);
});

test('a clip below the fold fails with the coordinate space spelled out, not a bare Playwright error', async () => {
  const sessionId = await freshSession();

  // clip is measured against the viewport, so a region further down the page
  // is out of range. Saying which coordinate space it is in is the whole
  // difference between a fixable error and a confusing one.
  await assert.rejects(
    () => handlers.screenshot({ sessionId, clip: { x: 0, y: 1800, width: 100, height: 50 } }),
    /viewport/i
  );

  await sessions.releaseSession(sessionId);
});

test('a wrapped Playwright failure carries no terminal escape codes into the agent-facing message', async () => {
  const sessionId = await freshSession();

  // Playwright dims its call log with ANSI escape codes, which are noise to
  // everything downstream of a terminal, an agent's transcript included.
  const err = await handlers
    .screenshot({ sessionId, selector: '#nope', timeoutMs: 400 })
    .then(() => undefined, (e: unknown) => e as Error);

  assert.ok(err, 'expected the missing selector to fail');
  assert.doesNotMatch(err.message, new RegExp('\\u001b'), 'the message still contains ANSI escape codes');
  assert.match(err.message, /waiting for locator/);

  await sessions.releaseSession(sessionId);
});
