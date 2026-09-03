import { chromium } from '/Users/vadym/Projects/harborage/node_modules/playwright/index.mjs';
import { capture, observe, crossCheck } from '/Users/vadym/Projects/harborage/research/animation/prototype.mjs';
import fs from 'node:fs';
const VIEW={width:800,height:600};
// A logo that animates on LOAD, with no way to re-trigger it.
fs.writeFileSync('/tmp/loadlogo.html',`<style>
 body{margin:0;background:#fff;display:grid;place-items:center;height:100vh}
 @keyframes draw{from{stroke-dashoffset:1}to{stroke-dashoffset:0}}
 @keyframes fade{from{opacity:0}to{opacity:1}}
 .m path{stroke-dasharray:1;stroke-dashoffset:1;animation:draw 700ms linear forwards}
 .w{opacity:0;animation:fade 300ms 700ms linear forwards;font:600 22px system-ui;color:#0e3b45}
 .wrap{display:flex;gap:12px;align-items:center}
</style><div class="wrap">
<svg class="m" width="56" height="56" viewBox="0 0 56 56"><path pathLength="1"
 d="M28 4 L50 16 L50 40 L28 52 L6 40 L6 16 Z" fill="none" stroke="#1d4ed8" stroke-width="3"/></svg>
<div class="w">Meridian</div></div>`);

const b=await chromium.launch();
const page=await b.newPage({viewport:VIEW,deviceScaleFactor:1});
const client=await page.context().newCDPSession(page); await client.send('Page.enable');
const work=await b.newPage({viewport:{width:100,height:100}}); await work.goto('about:blank');

// WRONG WAY: navigate first, settle, then capture. The animation is over.
await page.goto('file:///tmp/loadlogo.html');
await page.waitForTimeout(1500);
const wrong=await capture(page,client,{trigger:async()=>{},durationMs:1200,viewport:VIEW});
const wtl=await observe(work,wrong.frames.slice(0,12),wrong.declared.backgroundColor,VIEW);

// RIGHT WAY: start recording, THEN navigate.
await page.goto('about:blank');
const right=await capture(page,client,{
  trigger:()=>page.goto('file:///tmp/loadlogo.html'),durationMs:1200,viewport:VIEW});
const step=Math.max(1,Math.floor(right.frames.length/12));
const rtl=await observe(work,right.frames.filter((_,i)=>i%step===0),right.declared.backgroundColor,VIEW);

const maxOf=t=>Math.max(0,...t.slice(1).map(r=>r.sinceAnchorPct));
console.log(`settle-then-capture : ${wrong.frames.length} frames, max change ${maxOf(wtl)}%  <- animation already over`);
console.log(`capture-then-navigate: ${right.frames.length} frames, max change ${maxOf(rtl)}%  <- load animation captured`);
console.log(`\n${maxOf(wtl)===0 && maxOf(rtl)>0 ? 'PASS' : 'FAIL'}: the navigate trigger is required for load animations`);
await b.close();
