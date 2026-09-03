/**
 * record_animation prototype.
 *
 * Implements the council verdict: capture BOTH channels in one call and report
 * them as sibling fields with a typed agreement status. The declared channel
 * (getAnimations) says what the page intended; the observed channel (pixels)
 * says what actually rendered. Neither is authoritative alone, and their
 * disagreement is the most diagnostic signal available.
 *
 * Every rule below was forced by a measured failure, not chosen for elegance:
 *
 *  - Diff against an ANCHOR frame, not the previous frame. A real 4s opacity
 *    fade produced 0% adjacent-frame change on all 395 gaps at native capture
 *    rate; it needs ~165ms to accumulate one pixel past threshold. Adjacent
 *    diffing reports a running animation as a dead page.
 *  - Sample the page's actual background colour. A white-based emptiness test
 *    reads 100% "non-white" on every frame of a dark theme and can never
 *    detect a blank screen there.
 *  - Diff at full resolution. At 200x150 a real 3px shift became 0.75px and
 *    vanished, and the tool reported a clean static page.
 *  - Report the tool's OWN selection parameters (crop, sample times, scale).
 *    Those are interpretation performed upstream of the pixels; hiding them
 *    makes the payload only look raw.
 *  - Emit typed codes, never prose conclusions. Summarise the measurement,
 *    never the cause: "moved 0.3px over 12 frames, below the noise floor" is
 *    checkable; "the animation is frozen" is what made an agent invent a bug.
 */

const DIFF_THRESHOLD = 24; // per-pixel summed |dR|+|dG|+|dB|

/** Start a CDP screencast, run the trigger, collect timestamped frames. */
export async function capture(page, client, { trigger, durationMs, viewport }) {
  const frames = [];
  let t0 = null;
  const onFrame = async ({ data, metadata, sessionId }) => {
    const t = metadata.timestamp * 1000;
    if (t0 === null) t0 = t;
    frames.push({ data, t: t - t0 });
    try { await client.send('Page.screencastFrameAck', { sessionId }); } catch {}
  };
  client.on('Page.screencastFrame', onFrame);
  await client.send('Page.startScreencast', {
    format: 'png', everyNthFrame: 1, maxWidth: viewport.width, maxHeight: viewport.height
  });

  // A load-triggered animation (the common case for a logo) cannot be captured
  // by settling the page first and then triggering: it has already finished.
  // The screencast is live before this runs, so a trigger that navigates or
  // reloads gets its load animation recorded from the first painted frame.
  await trigger();

  // The declared channel must be read MID-FLIGHT. Sampled after the animation
  // ends every playState reads "finished" and the cross-check is meaningless.
  await page.waitForTimeout(Math.min(200, Math.max(40, durationMs * 0.2)));
  const declared = await readDeclared(page);

  await page.waitForTimeout(durationMs);
  await client.send('Page.stopScreencast');
  client.off('Page.screencastFrame', onFrame);
  return { frames, declared };
}

/** The declared channel: what the page says it is doing. */
async function readDeclared(page) {
  return await page.evaluate(() => {
    const bg = (() => {
      for (const el of [document.body, document.documentElement]) {
        const c = getComputedStyle(el).backgroundColor;
        if (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') return c;
      }
      return 'rgb(255, 255, 255)';
    })();
    if (!document.getAnimations) return { supported: false, backgroundColor: bg, animations: [] };
    return {
      supported: true,
      backgroundColor: bg,
      animations: document.getAnimations().map(a => {
        const t = a.effect?.getTiming?.() ?? {};
        const el = a.effect?.target;
        const r = el?.getBoundingClientRect?.();
        return {
          name: a.animationName || a.transitionProperty || a.id || null,
          playState: a.playState,
          durationMs: typeof t.duration === 'number' ? t.duration : null,
          delayMs: t.delay ?? null,
          iterations: t.iterations ?? null,
          effectEasing: t.easing ?? null,
          target: el ? (el.tagName + (el.id ? '#' + el.id : '')) : null,
          rect: r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null,
          inViewport: r ? (r.right > 0 && r.left < innerWidth && r.bottom > 0 && r.top < innerHeight) : null
        };
      })
    };
  });
}

/**
 * The observed channel. Runs inside a Chromium page so canvas does the pixel
 * work; no image library needed.
 */
export async function observe(work, frames, backgroundColor, viewport) {
  return await work.evaluate(async ({ frames, backgroundColor, VW, VH, TH }) => {
    const load = s => new Promise(r => { const i = new Image(); i.onload = () => r(i); i.src = s; });
    const imgs = await Promise.all(frames.map(f => load('data:image/png;base64,' + f.data)));

    const bg = (() => {
      const m = backgroundColor.match(/\d+/g) || [255, 255, 255];
      return [+m[0], +m[1], +m[2]];
    })();

    const ca = new OffscreenCanvas(VW, VH), xa = ca.getContext('2d', { willReadFrequently: true });
    const cb = new OffscreenCanvas(VW, VH), xb = cb.getContext('2d', { willReadFrequently: true });
    const px = im => { xb.clearRect(0, 0, VW, VH); xb.drawImage(im, 0, 0); return xb.getImageData(0, 0, VW, VH).data; };

    const GW = 40, GH = 30, CW = VW / GW, CH = VH / GH;
    const anchorData = px(imgs[0]);
    let anchor = 0;
    const out = [];

    for (let i = 0; i < imgs.length; i++) {
      xa.clearRect(0, 0, VW, VH); xa.drawImage(imgs[i], 0, 0);
      const cur = xa.getImageData(0, 0, VW, VH).data;

      // emptiness, measured against the page's ACTUAL background colour
      let nonBg = 0;
      for (let p = 0; p < cur.length; p += 4)
        if (Math.abs(cur[p] - bg[0]) + Math.abs(cur[p+1] - bg[1]) + Math.abs(cur[p+2] - bg[2]) > TH) nonBg++;

      const measure = (ref) => {
        let n = 0, mnx = VW, mny = VH, mxx = -1, mxy = -1;
        const grid = new Uint8Array(GW * GH);
        for (let p = 0; p < cur.length; p += 4) {
          const d = Math.abs(ref[p] - cur[p]) + Math.abs(ref[p+1] - cur[p+1]) + Math.abs(ref[p+2] - cur[p+2]);
          if (d > TH) {
            n++;
            const q = p / 4, x = q % VW, y = (q - x) / VW;
            if (x < mnx) mnx = x; if (x > mxx) mxx = x;
            if (y < mny) mny = y; if (y > mxy) mxy = y;
            grid[Math.floor(y / CH) * GW + Math.floor(x / CW)] = 1;
          }
        }
        return { n, bbox: mxx < 0 ? null : { x: mnx, y: mny, w: mxx - mnx, h: mxy - mny }, grid };
      };

      const prev = i > 0 ? px(imgs[i - 1]) : null;
      const adj = prev ? measure(prev) : { n: 0, bbox: null, grid: new Uint8Array(GW * GH) };
      // ANCHOR diff: what catches a fade too slow to register frame to frame.
      const cum = measure(anchorData);

      // disjoint regions from the anchor diff, so multi-region change survives
      const seen = new Uint8Array(GW * GH), regions = [];
      for (let g = 0; g < cum.grid.length; g++) {
        if (!cum.grid[g] || seen[g]) continue;
        const st = [g]; seen[g] = 1;
        let a1 = GW, b1 = GH, a2 = -1, b2 = -1, cells = 0;
        while (st.length) {
          const k = st.pop(), gx = k % GW, gy = (k - gx) / GW;
          cells++;
          if (gx < a1) a1 = gx; if (gx > a2) a2 = gx;
          if (gy < b1) b1 = gy; if (gy > b2) b2 = gy;
          for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
            const nx = gx + dx, ny = gy + dy;
            if (nx < 0 || ny < 0 || nx >= GW || ny >= GH) continue;
            const nk = ny * GW + nx;
            if (cum.grid[nk] && !seen[nk]) { seen[nk] = 1; st.push(nk); }
          }
        }
        regions.push({ x: Math.round(a1*CW), y: Math.round(b1*CH),
                       w: Math.round((a2-a1+1)*CW), h: Math.round((b2-b1+1)*CH), cells });
      }
      regions.sort((p, q) => q.cells - p.cells);

      out.push({
        // Scope matters and was previously left implicit: an agent reading a
        // 50%-of-viewport crop region reasonably assumed the emptiness count
        // was scoped to it too, and hedged its answer for no reason. Every
        // measurement here is VIEWPORT-WIDE; `region` describes only the
        // cropping of the returned image.
        scope: 'viewport',
        frame: i, tMs: Math.round(frames[i].t),
        adjacentPct: +(100 * adj.n / (VW*VH)).toFixed(3),
        sinceAnchorPct: +(100 * cum.n / (VW*VH)).toFixed(3),
        anchorFrame: anchor,
        nonBackgroundPx: nonBg,
        bbox: cum.bbox,
        regions: regions.slice(0, 4)
      });
    }
    return out;
  }, { frames, backgroundColor, VW: viewport.width, VH: viewport.height, TH: DIFF_THRESHOLD });
}

/**
 * Cross-check the two channels. Emits typed codes only: it states what was
 * measured and what that measurement cannot distinguish, never a cause.
 */
export function crossCheck(declared, timeline, viewport, frameTimings) {
  const codes = [];
  const post = timeline.slice(1); // frame 0 predates the trigger by construction

  const maxSinceAnchor = Math.max(0, ...post.map(r => r.sinceAnchorPct));
  const anyPixelChange = maxSinceAnchor > 0;
  const declaredAnimating = declared.supported &&
    declared.animations.some(a => a.playState === 'running' || a.playState === 'finished');

  const emptyFrames = post.filter(r => r.nonBackgroundPx === 0);
  // `every` on an empty array is vacuously true. An invisible element causes
  // no repaints and therefore no frames, so `post` is routinely empty exactly
  // when this claim would be most wrong. Require real evidence.
  const allEmpty = post.length > 0 && emptyFrames.length === post.length;

  if (!declared.supported) codes.push('declared_channel_unavailable');
  // Too few frames to say anything about how the page changed over time.
  if (post.length < 2) codes.push('insufficient_frames_for_timeline');

  if (declaredAnimating && !anyPixelChange) {
    codes.push('declared_animating_but_no_pixel_change');
    const offscreen = declared.animations.filter(a => a.inViewport === false);
    if (offscreen.length) codes.push('declared_target_outside_viewport');
    if (allEmpty) codes.push('viewport_empty_throughout');
  }
  if (!declaredAnimating && anyPixelChange) codes.push('pixels_changed_with_no_declared_animation');
  if (declaredAnimating && anyPixelChange) codes.push('declared_and_observed_agree');

  // Two DIFFERENT things, kept apart because conflating them was wrong.
  //
  // A stall is the page not repainting at all. The screencast emits nothing
  // while that is true, so it appears as an unusually long interval between
  // consecutive captured frames, never as zero-change frames. Looking for
  // zero-change frames missed a real 300ms freeze entirely.
  //
  // A quiet interval is frames arriving normally with nothing changing. That
  // is common and legitimate (the pause between staggered items), so it is
  // reported as a measurement and never called a defect.
  const stalls = [];
  if (frameTimings && frameTimings.length > 4) {
    const deltas = frameTimings.slice(1).map((t, i) => t - frameTimings[i]).sort((a, b) => a - b);
    const median = deltas[Math.floor(deltas.length / 2)] || 16;
    const limit = Math.max(median * 4, 100);
    for (let i = 1; i < frameTimings.length; i++) {
      const d = frameTimings[i] - frameTimings[i - 1];
      if (d > limit) stalls.push({
        fromMs: Math.round(frameTimings[i - 1]), toMs: Math.round(frameTimings[i]),
        durationMs: Math.round(d), medianFrameIntervalMs: Math.round(median)
      });
    }
  }
  if (stalls.length) codes.push('repaint_stall_detected');

  const quiet = [];
  for (let i = 1; i < post.length; i++) {
    // progressing slowly still counts as motion: compare against the anchor,
    // not the previous frame. A 4s fade shows 0% adjacent change on every gap.
    const progressing = post[i].sinceAnchorPct > post[i - 1].sinceAnchorPct;
    if (post[i].adjacentPct === 0 && !progressing) {
      let j = i;
      while (j + 1 < post.length && post[j + 1].adjacentPct === 0 &&
             post[j + 1].sinceAnchorPct <= post[j].sinceAnchorPct) j++;
      const span = post[j].tMs - post[i - 1].tMs;
      if (span >= 100) quiet.push({
        fromMs: post[i - 1].tMs, toMs: post[j].tMs, durationMs: span,
        viewportEmptyThroughout: post.slice(i, j + 1).every(r => r.nonBackgroundPx === 0)
      });
      i = j;
    }
  }
  if (quiet.some(q => q.viewportEmptyThroughout)) codes.push('viewport_empty_interval');

  const status = codes.includes('declared_animating_but_no_pixel_change') ? 'mismatch'
    : codes.includes('declared_and_observed_agree') ? 'agree'
    : 'undetermined';

  return {
    status,
    codes,
    stalls,
    quietIntervals: quiet,
    discriminators: {
      maxChangeSinceAnchorPct: maxSinceAnchor,
      minNonBackgroundPx: Math.min(...post.map(r => r.nonBackgroundPx)),
      declaredAnimationCount: declared.animations.length,
      note: status === 'mismatch'
        ? 'The page reports an animation running. No pixels changed. These are different questions and this capture cannot say which is correct.'
        : null
    }
  };
}

/** Change-weighted sampling: pick frames where change happens, not on a clock. */
export function sampleFrames(frames, timeline, n) {
  if (frames.length <= n) return frames.map((_, i) => i);
  const weights = timeline.map((r, i) => (i === 0 ? 0 : r.adjacentPct + 0.001));
  const total = weights.reduce((a, b) => a + b, 0);
  const picks = [0];
  let acc = 0, want = total / (n - 1);
  for (let i = 1; i < weights.length && picks.length < n; i++) {
    acc += weights[i];
    if (acc >= want) { picks.push(i); acc = 0; }
  }
  while (picks.length < n) {
    const missing = frames.map((_, i) => i).find(i => !picks.includes(i));
    if (missing === undefined) break;
    picks.push(missing);
  }
  return picks.slice(0, n).sort((a, b) => a - b);
}

/**
 * Resolve the capture region.
 *
 * If the caller names a target, that is authoritative and is reported as
 * `source: "caller"`. If not, the region is derived from where pixels actually
 * changed and reported as `source: "derived"`, because a region the tool chose
 * for itself is an interpretation and hiding it makes the payload only look
 * raw. A caller can always see which happened and why.
 */
export async function resolveRegion(page, timeline, viewport, target) {
  const pad = 12;
  if (target) {
    const r = await page.evaluate(sel => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { x: b.x, y: b.y, w: b.width, h: b.height };
    }, target);
    if (!r) return { region: null, source: 'caller', targetFound: false, reason: `selector ${target} matched nothing` };
    return {
      region: {
        x: Math.max(0, Math.round(r.x - pad)), y: Math.max(0, Math.round(r.y - pad)),
        w: Math.min(viewport.width, Math.round(r.w + pad * 2)),
        h: Math.min(viewport.height, Math.round(r.h + pad * 2))
      },
      source: 'caller', targetFound: true, reason: `bounds of ${target}`
    };
  }
  let mnx = viewport.width, mny = viewport.height, mxx = 0, mxy = 0, any = false;
  for (const r of timeline) if (r.bbox) {
    any = true;
    mnx = Math.min(mnx, r.bbox.x); mny = Math.min(mny, r.bbox.y);
    mxx = Math.max(mxx, r.bbox.x + r.bbox.w); mxy = Math.max(mxy, r.bbox.y + r.bbox.h);
  }
  if (!any) return { region: null, source: 'derived', reason: 'no pixels changed anywhere' };
  const region = {
    x: Math.max(0, mnx - pad), y: Math.max(0, mny - pad),
    w: Math.min(viewport.width, mxx + pad) - Math.max(0, mnx - pad),
    h: Math.min(viewport.height, mxy + pad) - Math.max(0, mny - pad)
  };
  const frac = (region.w * region.h) / (viewport.width * viewport.height);
  return {
    region, source: 'derived',
    reason: `union of changed pixels, ${(frac * 100).toFixed(0)}% of viewport`,
    coversWholeViewport: frac > 0.6
  };
}

/** Estimated image tokens: (w*h)/750 after a 1568px long-edge downscale. */
export function imageTokens(w, h) {
  const s = Math.min(1, 1568 / Math.max(w, h));
  return Math.round((w * s) * (h * s) / 750);
}
