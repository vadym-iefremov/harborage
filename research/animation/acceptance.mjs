/**
 * Acceptance run for the record_animation prototype.
 *
 * Every fixture has a known ground truth. This asserts the prototype reports
 * what is really there AND does not report defects that are not there. A false
 * alarm costs an agent more than a miss, so every smooth fixture carries an
 * explicit stall:false expectation rather than being left unchecked.
 */
import { chromium } from '../../node_modules/playwright/index.mjs';
import { capture, observe, crossCheck } from './prototype.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, '..', '..', 'test', 'fixtures', 'animation');
const SCRATCH = '/private/tmp/claude-502/-Users-vadym-Projects-harborage/fd95b3a8-0025-40fa-a79d-db85af6f1cf7/scratchpad/anim';
const VIEW = { width: 800, height: 600 };

const CASES = [
  ['synthetic', 'slide',            700,  { motion: true, stall: false }],
  ['synthetic', 'ease',             700,  { motion: true, stall: false }],
  ['synthetic', 'janky',           1000,  { motion: true, stall: true, stallAboutMs: 270 }],
  ['synthetic', 'subtle',           650,  { motion: true, stall: false }],
  ['synthetic', 'stagger',         1000,  { motion: true, stall: false }],
  ['realistic', 'logo',            1300,  { motion: true, stall: false }],
  ['realistic', 'transition-ok',    650,  { motion: true, stall: false, neverEmpty: true }],
  ['realistic', 'transition-blank', 950,  { motion: true, emptyInterval: true }],
  ['realistic', 'micro',            300,  { motion: true, stall: false }],
  ['realistic', 'spinner-stall',   2100,  { motion: true, stall: true, stallAboutMs: 400 }],
  ['extended',  'dark',             650,  { motion: true, stall: false }],
  ['extended',  'photo',            750,  { motion: true, stall: false }],
  ['extended',  'canvas',          1000,  { motion: true, stall: false }],
  ['extended',  'scroll',           850,  { motion: true, stall: false }],
  ['extended',  'reveal-slow',     4200,  { motion: true, stall: false }],
];

const FILES = {
  synthetic: path.join(FIX, 'synthetic.html'),
  realistic: path.join(FIX, 'realistic.html'),
  extended:  path.join(SCRATCH, 'fixtures3.html'),
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: VIEW, deviceScaleFactor: 1 });
const client = await page.context().newCDPSession(page);
await client.send('Page.enable');
const work = await browser.newPage({ viewport: { width: 100, height: 100 } });
await work.goto('about:blank');

let pass = 0, fail = 0;
const rows = [];

for (const [file, name, ms, want] of CASES) {
  await page.goto('file://' + FILES[file]);
  await page.evaluate(() => window.reset());
  await page.waitForTimeout(120);

  const { frames, declared } = await capture(page, client, {
    trigger: () => page.evaluate(n => window.play(n), name),
    durationMs: ms, viewport: VIEW
  });

  const step = Math.max(1, Math.floor(frames.length / 24));
  const sub = frames.filter((_, i) => i % step === 0);
  const timeline = await observe(work, sub, declared.backgroundColor, VIEW);
  const check = crossCheck(declared, timeline, VIEW, frames.map(f => f.t));

  const post = timeline.slice(1);
  const motion = Math.max(0, ...post.map(r => r.sinceAnchorPct)) > 0;
  const stall = check.stalls.length > 0;
  const longestStall = stall ? Math.max(...check.stalls.map(s => s.durationMs)) : 0;
  const everEmpty = post.some(r => r.nonBackgroundPx === 0);
  // reveal-slow's signature: nothing frame-to-frame, real progress vs anchor
  const adjacentAllZero = post.every(r => r.adjacentPct === 0);

  const problems = [];
  if (want.motion !== motion) problems.push(`motion ${want.motion}->${motion}`);
  if (want.stall !== undefined && want.stall !== stall) problems.push(`stall ${want.stall}->${stall}`);
  if (want.stallAboutMs && Math.abs(longestStall - want.stallAboutMs) > 250)
    problems.push(`stall ${longestStall}ms not ~${want.stallAboutMs}ms`);
  if (want.neverEmpty && everEmpty) problems.push('went empty, should not');
  if (want.emptyInterval && !check.quietIntervals.some(q => q.viewportEmptyThroughout))
    problems.push('blank interval not flagged empty');
  // The adjacent-vs-anchor blindness only appears at NATIVE capture cadence,
  // where frames are ~10ms apart. This table subsamples to ~160ms spacing, so
  // that condition cannot arise here. It is tested in native-cadence.mjs.

  const ok = problems.length === 0;
  ok ? pass++ : fail++;
  rows.push({ name, ok, motion, stall, longestStall, everEmpty, adjacentAllZero,
              status: check.status, problems });
}

console.log('fixture           motion stall stallMs empty adjAll0 status        result');
for (const r of rows)
  console.log(
    `${r.name.padEnd(17)} ${String(r.motion).padEnd(6)} ${String(r.stall).padEnd(5)} ` +
    `${String(r.longestStall).padStart(6)} ${String(r.everEmpty).padEnd(5)} ` +
    `${String(r.adjacentAllZero).padEnd(7)} ${r.status.padEnd(13)} ${r.ok ? 'OK' : r.problems.join('; ')}`);
console.log(`\n${pass} passed, ${fail} failed`);

await browser.close();
process.exit(fail ? 1 : 0);
