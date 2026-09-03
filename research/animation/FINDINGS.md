# Why `record_animation` is shaped the way it is

Every rule in `src/daemon/tools/defs/animation.ts` was forced by a measured
failure. This records which, so a later change does not quietly undo one.

The fixtures the measurements ran against are in `test/fixtures/animation/`,
and the regressions they produced are in `test/animation.test.ts`.

## Two channels, because each is confidently wrong alone

`getAnimations()` reports `playState: "running"` identically for an element
that is visible, one at `visibility:hidden`, one at `opacity:0`, one at
`left:-9999px`, and one under an opaque overlay. Five states, one signal. It
reports intent, not whether anyone could see it, so a tool built on it alone
is a silent false pass by construction.

Pixels cannot see a schedule, an easing curve, or the difference between
finished and never started. So both ship, and their disagreement is reported
as `agreement.status` rather than resolved into a verdict.

## Diff against an anchor frame, not the previous one

A genuinely running four-second opacity fade produced **0% adjacent-frame
change on all 395 gaps** at native capture rate. It needs roughly 165ms to
move a single pixel past the threshold. A liveness check built on adjacent
diffs reports that animation as a dead page.

`sinceAnchorPct` exists for this. Measured on the same capture: 0% adjacent
against 12.41% since-anchor.

## A stall is a gap between timestamps, not a frame that shows no change

A frozen page emits no frames at all, so a freeze never appears as a
zero-change frame. The first version looked for zero-change frames, missed a
real 300ms freeze, and fired on the legitimate pause between staggered items.

Under a `navigate` trigger the same gaps are reported as
`paint_gaps_during_navigation` instead. Real sites produce them on a clean
load: MDN gave 503ms and 1131ms. Calling those jank would hand someone a
fabricated bug on the first page they tried.

## Measure emptiness against the page's own background

A white-based test reads 100% non-white on every frame of a dark theme and can
never report a blank screen there. Against the true background colour, a
planted blank-transition bug was located at 168ms against a true 170ms.

## Crop the image, but measure the whole viewport

For a 182x77 logo in an 800x600 page, a full-page contact sheet costs 1,930
tokens and renders the logo at 88x37, where a 3px stroke becomes 1.5px and the
wordmark is unreadable. Cropped to the changed region it costs 300 tokens at
full resolution. Cheaper *and* sharper, because 94% of the full-page sheet is
background you paid for. See `examples/logo-crop.png` against
`examples/logo-fullpage.png`.

An atlas saves nothing by packing. Twelve frames pre-shrunk to atlas scale cost
1,848 tokens against the atlas's 1,844. The saving is resolution alone.

`region` therefore crops the returned image only. Every value in `observed` is
viewport-wide, because an agent that assumed otherwise hedged a correct answer
for no reason.

## Report the measurement, never the cause

Handed an open-ended payload, an agent invented an uneven stagger cadence that
did not exist. Handed the same image with the measured quantity and its
uncertainty stated, it answered correctly and declined to flag anything.

So the payload states what was measured and what the measurement cannot
distinguish, in typed codes rather than prose. `status: "mismatch"` means the
two channels disagree, not that there is a bug: a deliberately hidden element
gives the same signature as a broken one.

## What is still unknown

The diff threshold is tuned on flat colour. Video and heavy photographic
content may push the noise floor above it. Real sites also yield far fewer
frames than fixtures, 2 to 10 at 6-12fps against 50-100 at 95fps, because page
load is mostly waiting, so a bare `navigate` capture usually reports
`undetermined`. The tool is most useful pointed at a specific interaction on an
already-loaded page.
