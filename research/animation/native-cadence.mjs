/**
 * Regression test for the anchor-diff fix.
 *
 * At native capture cadence a slow fade produces zero adjacent-frame change.
 * This asserts the failure is real, and that diffing against an anchor frame
 * recovers the signal. If both columns ever read zero, the tool is blind to
 * slow animation and is reporting a running page as a dead one.
 */
import { chromium } from '../../node_modules/playwright/index.mjs';
import { capture, observe } from './prototype.mjs';

const SCRATCH='/private/tmp/claude-502/-Users-vadym-Projects-harborage/fd95b3a8-0025-40fa-a79d-db85af6f1cf7/scratchpad/anim';
const VIEW={width:800,height:600};
const b=await chromium.launch();
const page=await b.newPage({viewport:VIEW,deviceScaleFactor:1});
const client=await page.context().newCDPSession(page);
await client.send('Page.enable');
const work=await b.newPage({viewport:{width:100,height:100}}); await work.goto('about:blank');

await page.goto('file://'+SCRATCH+'/fixtures3.html');
await page.evaluate(()=>window.reset()); await page.waitForTimeout(120);
const {frames,declared}=await capture(page,client,{
  trigger:()=>page.evaluate(()=>window.play('reveal-slow')), durationMs:4200, viewport:VIEW});

// take 25 CONSECUTIVE native-rate frames from the middle of the fade
const mid=Math.floor(frames.length/2);
const native=frames.slice(mid,mid+25);
const tl=await observe(work,native,declared.backgroundColor,VIEW);

const spacing=Math.round((native[native.length-1].t-native[0].t)/(native.length-1));
const adjMax=Math.max(...tl.slice(1).map(r=>r.adjacentPct));
const ancMax=Math.max(...tl.slice(1).map(r=>r.sinceAnchorPct));
console.log(`total frames captured : ${frames.length} over ${Math.round(frames[frames.length-1].t)}ms`);
console.log(`native frame spacing  : ~${spacing}ms`);
console.log(`max ADJACENT-frame change : ${adjMax}%   <- what a naive liveness check sees`);
console.log(`max SINCE-ANCHOR change   : ${ancMax}%   <- what the anchor diff sees`);
const verdict = adjMax===0 && ancMax>0;
console.log(`\n${verdict ? 'PASS' : 'FAIL'}: adjacent diffing is blind (${adjMax}%) while the anchor diff detects the fade (${ancMax}%)`);
await b.close();
process.exit(verdict?0:1);
