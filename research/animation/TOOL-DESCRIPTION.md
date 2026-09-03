# record_animation

Capture a running animation and report BOTH what the page declares it is
animating and what actually rendered on screen. These are different questions
and they can disagree: `getAnimations()` reports playState "running" for an
element that is hidden, transparent, off-screen or covered by an overlay, so
the declared channel alone cannot tell you a user would see anything.

The page must already be loaded and settled. Use navigate and wait_for first,
exactly as with every other tool here.

FOR AN ANIMATION THAT RUNS ON PAGE LOAD (a logo intro, a splash, a hero
reveal), settling the page first means the animation is already over before
capture starts. Use `{ type: "navigate", url }` as the trigger instead: the
recording begins before navigation, so the load animation is captured from its
first painted frame. Do not navigate yourself and then call this tool.

## Input

- `sessionId` (string, required)
- `pageId` (string, optional) defaults to the session's active tab
- `trigger` (required) one of:
  `{ type: "click", selector }` | `{ type: "evaluate", expression }`
  | `{ type: "navigate", url }` | `{ type: "none" }`
  Use "none" for an animation already running, such as a spinner.
  Use "navigate" for anything that plays on page load.
- `durationMs` (number, required) how long to capture for. Capture stops at
  this deadline whether or not the animation finished. Set it longer than the
  animation you expect, not shorter.
- `target` (string, optional) a CSS selector to crop to. USUALLY OMIT THIS.
  With no target the capture region is derived from where pixels actually
  changed, which for a logo or a button is tighter than the element's own box
  and costs less. Pass a target only to ignore other things moving on the page,
  such as a clock or a carousel. Naming a wrapper that fills the viewport makes
  the result larger and harder to read, not more precise.
- `frames` (number, optional, default 12) how many frames the contact sheet
  carries. Below 8 the timing between events gets unreliable.

## Result

- `capture` — requestedMs, observedMs, rawFrames, effectiveFps, framesReturned.
  A page that stops repainting emits no frames, so a low effectiveFps against
  a smooth animation is itself evidence of stalling.
- `region` — `{ region, source, reason }`. THIS ONLY CROPS THE RETURNED IMAGE.
  It does not scope any measurement. Every number in `observed` is measured
  across the WHOLE viewport regardless of the crop, so a blank area outside the
  cropped region still shows up in `nonBackgroundPx`. `source` is "caller" when you passed
  a target and "derived" when the tool chose. `reason` says why. Check this
  when the picture is not what you expected.
- `declared` — every Animation the page reports, with duration, delay, target
  and playState. `limitation` names what this channel cannot tell you: the
  keyframe-level easing curve is not exposed.
- `observed` — a per-frame timeline. `adjacentPct` is change against the
  previous frame; `sinceAnchorPct` is change against the first frame. A slow
  fade shows 0 adjacentPct while sinceAnchorPct climbs, so read sinceAnchorPct
  before concluding nothing happened. `nonBackgroundPx` is how many pixels
  differ from the page's own background colour; 0 means the viewport is empty.
- `agreement` — `status` is "agree", "mismatch" or "undetermined", plus `codes`,
  `stalls`, `quietIntervals` and `discriminators`.

Codes you may see: `declared_and_observed_agree`,
`declared_animating_but_no_pixel_change`, `declared_target_outside_viewport`,
`viewport_empty_throughout`, `pixels_changed_with_no_declared_animation`,
`repaint_stall_detected`, `viewport_empty_interval`,
`insufficient_frames_for_timeline`, `declared_channel_unavailable`.

A `stall` is the page not repainting at all, measured from gaps between frame
timestamps. A `quietInterval` is frames arriving normally with nothing
changing, which is often legitimate, such as the pause between staggered items.

This tool reports measurements. It does not decide whether an animation is
correct. `status: "mismatch"` means the two channels disagree, not that there
is a bug; a deliberately hidden element produces the same signature as a
broken one, and only you know which was intended.
