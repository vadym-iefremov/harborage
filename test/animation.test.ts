import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { BrowserManager } from '../src/daemon/browserManager.js';
import { SessionStore } from '../src/daemon/sessions.js';
import { createToolHandlers, type ToolHandlers } from '../src/daemon/tools/handlers.js';
import { getFreePort } from './helpers.js';

let browserManager: BrowserManager;
let sessions: SessionStore;
let handlers: ToolHandlers;
let server: Server;
let base: string;
/** A real directory, only for the one test that actually writes a cached sheet. */
let cacheDir: string;
let cachingHandlers: ToolHandlers;

/**
 * Fixtures with KNOWN ground truth. Every assertion below is against a number
 * written into the CSS here, not against whatever the tool happened to report
 * the first time it ran.
 */
const PAGES: Record<string, string> = {
  // 600px of travel in exactly 600ms, linear.
  '/slide': `<style>body{margin:0;background:#fff}
    @keyframes mv{from{transform:translateX(0)}to{transform:translateX(600px)}}
    #box{width:80px;height:80px;background:#2563eb;margin-top:260px}
    .go{animation:mv 600ms linear forwards}</style>
    <div id="box"></div>
    <script>window.go=()=>document.getElementById('box').classList.add('go')</script>`,

  // Moves, FREEZES for a third of its life, then moves again. The freeze is in
  // keyframe percentages, so the page genuinely stops repainting.
  '/stall': `<style>body{margin:0;background:#fff}
    @keyframes j{0%{transform:translateX(0)}33%{transform:translateX(200px)}
      66%{transform:translateX(200px)}100%{transform:translateX(600px)}}
    #box{width:80px;height:80px;background:#16a34a;margin-top:260px}
    .go{animation:j 900ms linear forwards}</style>
    <div id="box"></div>
    <script>window.go=()=>document.getElementById('box').classList.add('go')</script>`,

  // Declared running, renders nothing: visibility:hidden. The silent false pass.
  '/invisible': `<style>body{margin:0;background:#fff}
    @keyframes mv{from{transform:translateX(0)}to{transform:translateX(400px)}}
    .bar{height:60px;background:#e5e7eb}
    #ghost{width:120px;height:60px;background:#2563eb;visibility:hidden}
    .go{animation:mv 500ms linear forwards}</style>
    <div class="bar"></div><div id="ghost"></div>
    <script>window.go=()=>document.getElementById('ghost').classList.add('go')</script>`,

  // A fade so slow that consecutive frames are pixel-identical at capture rate.
  '/slowfade': `<style>body{margin:0;background:#fff}
    @keyframes f{from{opacity:0}to{opacity:1}}
    #panel{width:300px;height:200px;background:#0e3b45;opacity:0;margin:80px}
    .go{animation:f 3000ms linear forwards}</style>
    <div id="panel"></div>
    <script>window.go=()=>document.getElementById('panel').classList.add('go')</script>`,

  // Dark theme: a white-based emptiness test is blind here.
  '/dark': `<style>body{margin:0;background:#0d1117}
    @keyframes u{from{transform:translateY(40px);opacity:0}to{transform:translateY(0);opacity:1}}
    #card{width:320px;height:180px;background:#1f6feb;opacity:0;margin:120px}
    .go{animation:u 500ms ease-out forwards}</style>
    <div id="card"></div>
    <script>window.go=()=>document.getElementById('card').classList.add('go')</script>`,

  // Animates on LOAD, with no way to re-trigger it.
  '/onload': `<style>body{margin:0;background:#fff}
    @keyframes mv{from{transform:translateX(0)}to{transform:translateX(500px)}}
    #box{width:80px;height:80px;background:#e8964a;margin-top:260px;animation:mv 600ms linear forwards}
    </style><div id="box"></div>`,

  // Nothing ever animates.
  '/static': `<style>body{margin:0;background:#fff}</style><h1>nothing happens here</h1>
    <script>window.go=()=>{}</script>`
};

before(async () => {
  browserManager = new BrowserManager(await getFreePort());
  sessions = new SessionStore(browserManager, {});
  handlers = createToolHandlers(sessions, {
    debugPort: 0,
    screenshotCacheDir: '/dev/null/unused',
    screenshotCacheTtlMs: 1000
  });
  cacheDir = mkdtempSync(join(tmpdir(), 'harborage-anim-'));
  cachingHandlers = createToolHandlers(sessions, {
    debugPort: 0,
    screenshotCacheDir: cacheDir,
    screenshotCacheTtlMs: 60_000
  });
  server = createServer((req, res) => {
    const body = PAGES[req.url ?? ''] ?? '<html><body>not a fixture</body></html>';
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(body);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

after(async () => {
  await sessions.closeAll();
  await browserManager.close();
  await new Promise<void>(resolve => server.close(() => resolve()));
  rmSync(cacheDir, { recursive: true, force: true });
});

interface AnimationResult {
  capture: { requestedMs: number; observedMs: number; rawFrames: number; effectiveFps: number; trigger: string };
  region: { crop: { x: number; y: number; w: number; h: number } | null; source: string; reason: string };
  declared: { supported: boolean; backgroundColor: string; animations: { playState: string; durationMs: number | null }[] };
  observed: { scope: string; timeline: { tMs: number; adjacentPct: number; sinceAnchorPct: number; nonBackgroundPx: number }[] };
  agreement: {
    status: string;
    codes: string[];
    stalls: { durationMs: number }[];
    quietIntervals: { durationMs: number; viewportEmptyThroughout: boolean }[];
    discriminators: { maxChangeSinceAnchorPct: number };
  };
  contactSheet?: { mode: string; width: number; height: number; path?: string };
}

type Trigger =
  | { type: 'click'; selector: string }
  | { type: 'evaluate'; expression: string }
  | { type: 'navigate'; url: string }
  | { type: 'none' };

interface RecordOpts {
  trigger: Trigger;
  durationMs: number;
  target?: string;
  frames?: number;
  mode?: 'inline' | 'cached';
}

async function record(path: string, opts: RecordOpts): Promise<AnimationResult> {
  const created = await handlers.create_session({ viewport: { width: 800, height: 600 } });
  const sessionId = (created.structuredContent as { sessionId: string }).sessionId;
  try {
    if (opts.trigger.type !== 'navigate') {
      await handlers.navigate({ sessionId, url: base + path });
    }
    const result = await handlers.record_animation({ sessionId, ...opts });
    return result.structuredContent as AnimationResult;
  } finally {
    await handlers.release_session({ sessionId });
  }
}

test('reports a plain animation as declared and observed agreeing, with real capture metadata', async () => {
  const r = await record('/slide', {
    trigger: { type: 'evaluate', expression: 'window.go()' },
    durationMs: 800
  });
  assert.equal(r.agreement.status, 'agree');
  assert.ok(r.agreement.codes.includes('declared_and_observed_agree'));
  assert.ok(r.capture.rawFrames > 10, `expected a real frame stream, got ${r.capture.rawFrames}`);
  assert.ok(r.capture.effectiveFps > 20, `expected >20fps, got ${r.capture.effectiveFps}`);
  assert.equal(r.declared.animations[0].durationMs, 600);
  assert.ok(r.agreement.discriminators.maxChangeSinceAnchorPct > 0);
  assert.equal(r.agreement.stalls.length, 0, 'a smooth animation must not report a stall');
});

test('a mid-animation freeze is reported as a stall, measured from frame timestamps', async () => {
  const r = await record('/stall', {
    trigger: { type: 'evaluate', expression: 'window.go()' },
    durationMs: 1100
  });
  assert.ok(r.agreement.codes.includes('repaint_stall_detected'), `codes: ${r.agreement.codes.join(',')}`);
  const longest = Math.max(...r.agreement.stalls.map(s => s.durationMs));
  // The freeze is a third of 900ms. Generous bounds: this asserts a real
  // stall was found, not that timing is exact under load.
  assert.ok(longest > 150 && longest < 500, `stall of ${longest}ms not in the expected range`);
});

test('an animation that is declared running but renders nothing is a mismatch, not a success', async () => {
  const r = await record('/invisible', {
    trigger: { type: 'evaluate', expression: 'window.go()' },
    durationMs: 700
  });
  assert.equal(r.agreement.status, 'mismatch');
  assert.ok(r.agreement.codes.includes('declared_animating_but_no_pixel_change'));
  assert.ok(r.declared.animations.some(a => a.playState === 'running' || a.playState === 'finished'));
  assert.equal(r.agreement.discriminators.maxChangeSinceAnchorPct, 0);
});

test('a page with visible content is never reported as an empty viewport', async () => {
  // The invisible fixture has a grey bar that is always painted. Claiming the
  // viewport was empty would be a confident false statement, and `every` on an
  // empty frame list makes that claim vacuously easy to emit.
  const r = await record('/invisible', {
    trigger: { type: 'evaluate', expression: 'window.go()' },
    durationMs: 700
  });
  assert.ok(
    !r.agreement.codes.includes('viewport_empty_throughout'),
    'claimed the viewport was empty while a grey bar was painted throughout'
  );
});

test('a fade too slow to register between frames is still detected, via the anchor diff', async () => {
  const r = await record('/slowfade', {
    trigger: { type: 'evaluate', expression: 'window.go()' },
    durationMs: 2500
  });
  const rows = r.observed.timeline.slice(1);
  const maxAdjacent = Math.max(...rows.map(x => x.adjacentPct));
  const maxAnchor = Math.max(...rows.map(x => x.sinceAnchorPct));
  assert.ok(maxAnchor > 0, 'the anchor diff must see a slow fade');
  assert.ok(maxAnchor > maxAdjacent, `anchor ${maxAnchor} should exceed adjacent ${maxAdjacent} on a slow fade`);
  assert.equal(r.agreement.status, 'agree');
});

test('emptiness is measured against the page background, so a dark theme is not always non-empty', async () => {
  const r = await record('/dark', {
    trigger: { type: 'evaluate', expression: 'window.go()' },
    durationMs: 700
  });
  assert.match(r.declared.backgroundColor, /13, 17, 23/, 'must read the page background, not assume white');
  const first = r.observed.timeline[0];
  // Against the true background the first frame is empty; against white it
  // would read as 480000 non-background pixels and never be empty at all.
  assert.ok(first.nonBackgroundPx < 1000, `dark background misread: ${first.nonBackgroundPx} non-background px`);
});

test('a load-time animation is captured by triggering the navigation, not by navigating first', async () => {
  const withNavigate = await record('/onload', {
    trigger: { type: 'navigate', url: `${base}/onload` },
    durationMs: 900
  });
  assert.ok(withNavigate.capture.rawFrames > 10, `navigate trigger captured only ${withNavigate.capture.rawFrames} frames`);
  assert.ok(withNavigate.agreement.discriminators.maxChangeSinceAnchorPct > 0, 'load animation was not captured');
  assert.equal(withNavigate.capture.trigger, 'navigate');
});

test('a page where nothing animates says so rather than inventing motion', async () => {
  const r = await record('/static', { trigger: { type: 'none' }, durationMs: 500 });
  assert.notEqual(r.agreement.status, 'agree');
  assert.equal(r.agreement.discriminators.maxChangeSinceAnchorPct, 0);
  assert.equal(r.agreement.stalls.length, 0);
  assert.ok(!r.agreement.codes.includes('declared_and_observed_agree'));
});

test('a target selector that matches nothing says so instead of silently using the viewport', async () => {
  const r = await record('/slide', {
    trigger: { type: 'evaluate', expression: 'window.go()' },
    durationMs: 700,
    target: '#does-not-exist'
  });
  assert.equal(r.region.source, 'caller');
  assert.match(r.region.reason, /matched nothing/);
});

test('the crop region reports whether the tool or the caller chose it', async () => {
  const derived = await record('/slide', {
    trigger: { type: 'evaluate', expression: 'window.go()' },
    durationMs: 700
  });
  assert.equal(derived.region.source, 'derived');
  assert.match(derived.region.reason, /changed pixels/);

  const explicit = await record('/slide', {
    trigger: { type: 'evaluate', expression: 'window.go()' },
    durationMs: 700,
    target: '#box'
  });
  assert.equal(explicit.region.source, 'caller');
  assert.match(explicit.region.reason, /#box/);
});

test('observed values are viewport-scoped even when the returned image is cropped', async () => {
  const r = await record('/slide', {
    trigger: { type: 'evaluate', expression: 'window.go()' },
    durationMs: 700,
    target: '#box'
  });
  assert.equal(r.observed.scope, 'viewport');
  assert.ok(r.region.crop !== null && r.region.crop.w < 800, 'expected a crop narrower than the viewport');
});

test('cached mode writes a file and returns its path instead of inline image data', async () => {
  const created = await cachingHandlers.create_session({ viewport: { width: 800, height: 600 } });
  const sessionId = (created.structuredContent as { sessionId: string }).sessionId;
  try {
    await cachingHandlers.navigate({ sessionId, url: `${base}/slide` });
    const result = await cachingHandlers.record_animation({
      sessionId,
      trigger: { type: 'evaluate', expression: 'window.go()' },
      durationMs: 700,
      mode: 'cached'
    });
    const sheet = (result.structuredContent as AnimationResult).contactSheet;
    assert.equal(sheet?.mode, 'cached');
    assert.ok(sheet?.path, 'cached mode must return a path');
    assert.ok(
      !result.content.some(block => block.type === 'image'),
      'cached mode must not also send the image inline'
    );
  } finally {
    await cachingHandlers.release_session({ sessionId });
  }
});

test('record_animation takes the per-session input lock, since a click trigger drives the mouse', async () => {
  const { toolDefs } = await import('../src/daemon/tools/schemas.js');
  assert.equal(
    toolDefs.record_animation.serializesInput,
    true,
    'a tool that clicks must serialize, or a concurrent drag corrupts it'
  );
});
