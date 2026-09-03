# Proposal: `record_animation`

A harborage tool that lets an agent actually see an animation. Derived from a
working prototype (`capture.mjs`) and 19 blind trials against fixtures with
known ground truth.

## Why not the obvious implementation

A loop of `screenshot()` calls is the intuitive design and it is wrong.

Each call round-trips through the daemon and costs roughly 30 to 100ms, so a
requested 20ms interval silently becomes an uneven ~80ms, and the capture
itself competes with the animation for the main thread. The tool would be
pacing the thing it claims to measure, and would report a frame interval it
never actually achieved. That is the project's cardinal sin: a plausible
success payload that does not describe what happened.

Use CDP `Page.startScreencast`. Frames are pushed from the compositor with
their own timestamps. Measured: ~95 effective fps, 58 frames across a 600ms
animation, versus roughly 10 to 15 for a screenshot loop.

A free diagnostic falls out of this. A stalled page issues no repaints, so it
yields no frames. In the trials the janky fixture captured at 67fps while
every smooth one exceeded 95. The capture rate is itself a jank signal, and
the tool should report it.

## Shape

    record_animation(sessionId, {
      pageId?,
      trigger:      { type: 'click', selector } | { type: 'evaluate', expression } | { type: 'none' },
      durationMs:   number,          // capture window
      frames?:      number,          // frames to return, default 12
      layout?:      'auto' | 'atlas' | 'frames' | 'timeline',   // default 'auto'
      atlasCols?:   number
    })

Returns a labelled atlas image, a numeric change timeline, and capture
metadata (raw frame count, effective fps, dropped-frame estimate).

## What the trials established

Cost, at Claude's 1568px long-edge downscale and ~(w*h)/750 tokens:

| Representation | Tokens | Verdict |
|---|---|---|
| 12 separate frames, full res | 7,680 | only thing that sees sub-5px motion |
| Atlas 4x3, 12 frames | 1,844 | good for gross motion, blind to fine detail |
| Atlas 3x2, 6 frames | 1,639 | too few frames, invents timing anomalies |
| Numeric timeline only | 431 | exact geometry and timing, no identity |
| **Atlas 3x2 + timeline** | **2,070** | **recommended default** |

An atlas saves nothing by packing. Twelve frames pre-shrunk to atlas scale cost
1,848 tokens against the atlas's 1,844. The saving is resolution alone, because
an atlas is a downscale you performed yourself. What packing actually buys is
side-by-side comparability and one image block instead of twelve.

Findings that drive the design:

1. **Diff at full resolution.** The prototype first diffed at 200x150. A real
   3px shift became 0.75px and vanished, and the tool reported a clean, static
   page. This was a silent false pass, caught only because the fixture's ground
   truth was known.

2. **Report displacement, not raw bounding boxes.** Two conditions had the real
   evidence in hand, a bbox creeping y 240 to 241 to 242, and both explicitly
   dismissed it as antialiasing noise. A signal at the noise floor invites the
   reader to argue it away. Emit `"moved 3px down over 500ms"` as a computed
   vector.

3. **Frame the question, or the agent will confabulate an answer.** The
   6-frame atlas, asked the open question "any anomaly?", invented an uneven
   170ms/350ms cadence for what was an even 300ms stagger. Re-run against the
   identical image but asked "was the timing EVEN or UNEVEN, give your
   numbers", and told to report an anomaly only when confident, the same
   representation returned 314ms and 302ms and correctly declined to flag
   anything.

   The fabricated defect was a property of the prompt, not of the resolution.
   This matters because the tool's result payload *is* the prompt for whatever
   reads it. An open "here are some frames, what do you think?" invites
   invention. State the measured quantity and its uncertainty, and let the
   agent judge against that.

   (Six frames still costs almost nothing less than twelve, 1,639 against
   1,844 tokens, so twelve remains the better default. But "six frames is
   unsafe" is not what the evidence shows, and an earlier draft of this
   document said so on the strength of a single contaminated run.)

4. **Escalate on a fine-detail signature.** When the timeline shows sustained
   change below ~1% with a near-static bbox, the motion is sub-pixel and an
   atlas cannot carry it. Return full-resolution crops of the bbox instead. A
   crop is a fraction of a full frame and keeps every pixel that matters.

## `layout: 'auto'`

    capture -> full-res diff -> classify
      bbox travels > 5% of viewport   -> atlas 3x2 + timeline   (gross motion)
      change < 1%, bbox near-static   -> full-res bbox crops + timeline (fine)
      no change at all                -> timeline only, and say plainly
                                         that nothing changed

## Honest limits

- Nothing here measures perceived smoothness. It measures geometry over time.
- The timeline cannot report colour or identity, which is exactly why the
  default pairs it with an atlas.
- Trials ran on one model tier, one run per cell, on synthetic CSS fixtures.
  The direction of the results is clear and the failures are reproducible, but
  the numbers are indicative, not statistical.

---

# Round 2: realistic fixtures (logo, page transitions, micro-interaction)

The first fixture set was large flat shapes on white. Five realistic fixtures
were built and measured to test whether the findings generalise. Three did not,
and one design decision inverts completely.

## Crop first, then compose. It is cheaper AND sharper.

Measured on a 182x77 logo animating inside an 800x600 page:

| | Tokens | Logo renders at |
|---|---|---|
| Full-page atlas 4x3 | 1,930 | 88x37 (3px strokes become 1.5px, wordmark illegible) |
| **Atlas of full-res crops** | **300** | **182x77, no downscale at all** |

6.4x cheaper at four times the linear resolution, because 94% of the full-page
atlas is empty white space you paid for. The same holds for the button
micro-interaction (293 tokens) and the spinner (276 tokens).

Cropping is therefore not a fallback for when the atlas fails. For any element
smaller than roughly a third of the viewport it is strictly better on both
axes, and most real UI animation is small: logos, buttons, spinners, toasts,
badges, menus.

## The union bounding box degrades on multi-region change

Predicted to collapse to the whole viewport on a page transition. Measured: it
averages 33% of the viewport and reaches full width (799 of 800px), not the
whole area, because the fixture's content sits in a horizontal band. The
prediction was directionally right and quantitatively overstated.

The structure is still destroyed. At t=192ms the union reads one 799x277 box,
while connected-component clustering on the same frame finds **four** distinct
regions: the incoming screen at 300x300@500,40 plus three fragments of the
outgoing screen at x=0. Emit disjoint regions, not a union.

## A stall and a blank screen have the same signature

Both produce `changedPct: 0` and `bbox: null`. On the janky fixture that meant
a frozen element; on transition-blank it meant an empty viewport. Reporting
either as "stalled" would be a confident wrong diagnosis.

Separating them needs an emptiness measure, and it must be **absolute, not a
percentage**. A normal light-themed UI is already 98-100% white, so the
percentage carries no signal. Counting non-background pixels is binary and
needs no threshold:

    transition-blank   219ms   0 non-background px   <- viewport truly empty
                       252ms   0
                       419ms   0
                       436ms   0
    transition-ok      minimum 8,325 non-background px, never empty

Ground truth for the injected bug was blank from 250ms to 420ms. Detected
exactly, with no tuning.

Two caveats on that detector:
- The pre-trigger frame at t=0 is legitimately empty in every capture, so it
  must be excluded or the check fires on every animation.
- "Non-background" must mean the page's actual background colour, not white.
  A dark-themed app breaks a hardcoded white test.

## Confirmed on realistic content

- **Frame rate as a jank signal held.** Smooth fixtures captured at 93-110fps;
  spinner-stall at 77 and transition-blank at 78.
- **Even resampling is wrong.** The 120ms button press yielded 14 raw frames in
  a 300ms window. Inside a realistic 2s capture, uniform sampling would put
  roughly one frame inside the interaction. Sample where `changedPct` is high.

## Still untested

Real sites with photographic images or video, dark themes, scroll-linked
animation, canvas/WebGL content, and cross-document view transitions.
