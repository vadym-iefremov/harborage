# Standardising how agents invoke harborage's browser-automation tools

Scope: this addresses the general question ("how should agents reliably get
correct results from harborage's tools") through the concrete case that
forced it, an animation-capture tool that returns images plus numeric data.
No code in harborage was changed; this is a recommendation document only.

## 0. The finding that drives everything below

19 blind trials, one variable changed: the shape of the result payload.

- Payload A: raw frames, no computed summary. The reading agent invented a
  defect that was not there.
- Payload B: the measured quantity plus its uncertainty, same image. The same
  agent answered correctly.

This is not a quirk of one prompt. It is the same failure mode the rest of
this document is built around: **an agent reading a tool result treats that
result as ground truth about the world, not as one piece of evidence to
weigh.** Whatever shape the payload has becomes the frame the agent reasons
inside. An open-ended payload invites it to build its own frame, and it
builds a wrong one. A payload that hands over a conclusion with no way to
check it gets accepted uncritically. The task is to find the shape in
between.

harborage already has a working answer to this, in production, in
`computed_style` and `element_box`. Section 1 names the shape. Section 4
shows it is not a local accident, it agrees with Anthropic's own tool-writing
guidance, with how Playwright's MCP server divides its own labour, and with
two recent papers on why models confabulate from partial evidence.

## 1. How the result should be structured

**Recommendation: option (c) and (d) together, with one restriction on (b)
that turns out to be the whole answer.**

Comparing the four options in the prompt:

| Option | What happens |
|---|---|
| (a) raw data only | Agent has to build its own summary. It builds a confident, wrong one. This is what produced the invented defect. |
| (b) raw data + computed summary sentence | Depends entirely on what the sentence claims. See below. |
| (c) summary + confidence/uncertainty | Works, but only if the confidence is computed from the data, not asked of the agent. |
| (d) summary + "what this evidence cannot tell you" | Works, and is the piece that stops a stated summary from over-claiming. |

The tension named in the prompt is real: a stated conclusion anchors the
agent and suppresses its own judgement, but raw data invites confabulation.
Both halves of that tension are confirmed by outside research (section 4),
and they are not actually in conflict once you separate two things that
option (b) conflates:

- **A summary of the measurement** ("position changed by 0.3 px across 12
  sampled frames spanning 400 ms after trigger") is a fact about the data.
  It is checkable against the raw samples sitting right next to it.
- **A summary of the cause** ("the animation is frozen") is a diagnosis. It
  is not checkable from the payload, because the payload cannot see intent.
  That is exactly the sentence that anchored the 19-trial agent into
  inventing a defect: state a cause, not a measurement, and the agent
  inherits the cause instead of forming its own view of the measurement.

So the fix is not "add a summary" or "don't add a summary." It is: **the
computed field always describes the DATA, never the CAUSE.** Causal words
("frozen", "broken", "stuck") belong only inside an explicit, structured
alternatives field the agent has to actively read (section 2), never inside
the summary sentence itself. This is precisely how `computed_style` already
behaves: it reports `contrast.ratio` and `contrast.passes` (data), and when
it cannot account for what is painted, it does not guess a cause, it reports
a `null` ratio plus a machine-readable `unaccountedFor` code and a prose
`ratioUnavailable` explaining why answering would be a guess.

Confidence has the same discipline applied to it: **compute it, do not ask
the agent to self-rate it, and do not ask the model producing the tool
result to self-rate it either.** `computed_style` never says "I am 90%
confident in this contrast ratio." It reports `borderline: true` with a
`borderlineNote` derived from a measured quantity (how close the ratio sits
to a threshold, how thin a stroke is relative to a device pixel, both
sourced from actual sub-pixel coverage sweeps documented in the tool's own
description). A research result cited in section 4 independently confirms
this is the right call: geometric/task-specific verification of a vision
claim outperforms a model's own self-assessed confidence by a wide margin
(87% vs 13% of predictive power, in the cited study). Confidence that
matters is a property of the measurement, not a feeling the agent or the
tool-implementation model reports about itself.

**"What this evidence cannot tell you" (option d) is not optional decoration,
it is the mechanism that lets you state a summary at all without it
over-claiming.** Every harborage description that reports a computed value
pairs it with an explicit, enumerated list of what that value does NOT
account for: `computed_style`'s "What the compositing does NOT account for,
and these are common: background images and gradients, CSS filters..." and
`element_box`'s "What it does NOT do: it never waits... It does not tell you
what an element looks like." Carry that same discipline into the per-call
result, not just the tool description, because the description is read once
at connection time and the result is read every single call. See the JSON
shape in section 3.

## 2. Ambiguous findings: report the discriminator, name the hypotheses, never collapse to a verdict

The prompt's example: "element frozen" and "page went blank" produce the
same numeric signature (no measurable change between sampled frames).
Three options were posed: report "stalled," report both hypotheses, or
report the raw discriminator and let the agent decide.

**None of the three alone is right; the combination is.** Reporting only
"stalled" is a single unchecked word doing the same anchoring damage as a
stated conclusion in section 1. Reporting only the raw discriminator
(numbers, no framing) reproduces the exact failure from the 19 trials:
handed nothing but data, an agent invents a story. The answer, matching
`computed_style`'s `unaccountedFor` and `element_box`'s `occludedBy`/
`topmostUnknownReason` pattern exactly, is:

1. State the data-level fact plainly and narrowly: "no measurable change
   across N sampled frames over M ms." That is checkable and not in dispute.
2. Enumerate every cause consistent with that fact, as a **machine-readable
   list of short codes**, not prose the agent has to parse and might skim.
   `element_frozen`, `page_blank`, `trigger_did_not_fire`,
   `capture_started_before_trigger` and so on.
3. For each code, say what OTHER evidence (already available elsewhere in
   harborage's tool surface, or obtainable with one more call) would
   distinguish it, the same way `topmostUnknownReason` says "scroll it into
   view, then ask again" rather than leaving the agent to guess a next step.
4. Set an explicit `ambiguous: true` boolean the agent can branch on, so
   "check whether this is settled before you conclude anything" is a field,
   not something the agent has to remember to consider. `computed_style`'s
   own comment on this point is worth quoting directly: *"Do not read a
   prose caveat and infer this: check the field."*

This costs nothing extra to compute, since the tool already has to look at
page state (console errors, page-error buffer, whether the trigger's own
side effects fired) to build the discriminator list, and it turns a genuine
unknown into something the agent can act on deliberately instead of
resolving by guessing, which is exactly the gap the 19 trials exposed.

## 3. Multi-step sequencing: follow harborage's existing grain, don't invent a new style

The animation capture needs: create session, navigate, wait for ready,
trigger, capture, interpret. The prompt asks whether this should be one fat
tool, several composable tools, or a documented "recipe."

**Look at what the other 59 tools actually do, because the answer is already
decided by precedent and it is consistent:**

- **Session and page lifecycle stay separate tools** (`create_session`,
  `navigate`, `wait_for`). Every existing capability that needs a ready page
  — `screenshot`, `computed_style`, `element_box`, `snapshot` — assumes the
  caller already has one and does not fold session setup into itself. There
  is no precedent anywhere in the 59 tools for a capability tool that also
  creates sessions or navigates. Do not break that pattern for animation
  capture: `create_session` → `navigate` → `wait_for` stay exactly as they
  are, called by the agent, before the new tool runs.
- **A single measurement that has an internal, timing-sensitive multi-step
  shape IS one tool**, and this is the load-bearing precedent for the new
  tool's "trigger, then sample frames" step. `screenshot` internally chooses
  between capturing viewport, a selector, or a clip, and always reads real
  pixel dimensions back out of the PNG rather than trusting the request; the
  caller cannot do that read-back itself without the tool. `computed_style`
  internally walks the ancestor chain, composites colours, forces pseudo-
  states over CDP, and releases them again, all inside one call, because
  splitting that into agent-orchestrated steps would reintroduce exactly the
  race conditions the tool exists to remove (an agent calling three separate
  tools to force `:hover`, read a colour, then release `:hover` cannot do so
  atomically with respect to other calls touching the same page). **The
  animation tool's trigger-and-sample step belongs together for the same
  reason**: if triggering and the first frame sample are two separate agent-
  orchestrated tool calls, the interval between them is unbounded and
  unmeasured, and the "how much time actually elapsed before the first
  sample" question, which the whole tool exists to answer precisely, becomes
  exactly as unreliable as if the agent had eyeballed it.
- **Interpretation is never folded into a measurement tool.** Nothing in the
  59 tools decides "is this good or bad" on the agent's behalf; each one
  reports a measurement (`contrast.ratio`, `topmostAtCentre`,
  `hiddenReasons`) and leaves the verdict, when there is a real judgement
  call left after the discriminators are handed over, to whatever reads the
  result. Section 2's `ambiguous` / cause-codes field is how a measurement
  tool hands over an unresolved judgement call explicitly, rather than
  resolving it itself and calling that "interpretation."
- **Cross-referencing in descriptions, not a "recipe" tool.** `list_frames`
  names the five tools that accept its `frameId`; `computed_style` tells the
  reader to take a screenshot when its own model breaks down; `element_box`
  says "For 'is it actually visible to a human', take a screenshot." No tool
  in harborage narrates a multi-tool workflow as a separate "recipe"
  artefact; the sequencing lives as pointers inside each tool's own
  description, at the exact point where a caller would otherwise reach for
  the wrong tool. Follow that: the new tool's description should say
  explicitly which tool to call first (`wait_for` for readiness) and which
  tool to reach for when its own signature comes back ambiguous
  (`read_console`, `read_page_errors`, `element_box` against a pre-trigger
  baseline), rather than writing a separate document nobody reads.

**Net shape**: one new tool, `capture_animation` (or similar), that assumes
a ready page, performs trigger + timed multi-frame sampling + per-frame
numeric discriminators + optional cached-mode images as one atomic call
(mirroring `screenshot`'s internal step-choice and `computed_style`'s
internal multi-step measurement), and stops there. It does not create
sessions, does not navigate, and does not emit a verdict, only data,
a data-grounded summary, and — when the data underdetermines the cause —
an explicit, enumerated set of candidate causes with next steps. This is
one new tool, not several and not a fat one, and it matches the grain of
every comparable tool already in the codebase.

Worth naming as a slightly awkward corner: Anthropic's own tool-writing
guidance (section 4) recommends going further and consolidating whole
*workflows* ("`schedule_event` instead of `list_users` + `list_events` +
`create_event`"). Taken literally that would argue for folding session
creation and navigation into this tool too. harborage's own 59-tool surface
does not do that anywhere, and for a good reason specific to this project:
sessions and pages are long-lived, reused across many calls in a QA agent's
run, while an animation capture is one call among many against an
already-open page. Consolidating session setup into every capability tool
would mean either creating a throwaway session per capture (defeating the
whole point of a session pool shared across a run) or accepting an
awkward "optionally reuse an existing session" parameter on every tool that
does not exist today. Apply Anthropic's consolidation advice at the grain
harborage already uses it at — a *single measurement's* internal steps —
not at the grain of a whole agent task.

## 4. Prior art

Three sources gave concrete, checkable patterns rather than generic advice.

**Anthropic, "Writing effective tools for AI agents"**
(anthropic.com/engineering/writing-tools-for-agents). Directly relevant
findings, not paraphrase-only advice:

- Tools should "return only high-signal information back to agents," and
  should prefer natural-language, semantically meaningful identifiers over
  low-level technical ones (`uuid`, raw pixel URLs, MIME types) — resolving
  arbitrary identifiers to interpretable language "significantly improves
  Claude's precision in retrieval tasks by reducing hallucinations." This
  backs the recommendation in section 2 to return named cause-codes
  (`element_frozen`, `trigger_did_not_fire`) rather than raw numeric flags
  the agent has to remember the meaning of.
- A `ResponseFormat` enum (`concise` vs `detailed`) let the same tool serve
  both a cheap default and a verbose mode on demand, with the concise
  version using roughly a third the tokens while keeping essential
  information. This is worth adopting directly for a per-frame-sample tool,
  where a run over dozens of frames can otherwise flood the transcript:
  default to per-sample numeric discriminators only, with a `detail: "full"`
  option to get every per-frame field.
- Its consolidation advice (fold multi-call workflows into one tool) is real
  and is exactly what motivates bundling trigger+sampling into one call in
  section 3, but taken at the grain of a whole agent task it would conflict
  with harborage's own working precedent of small, single-purpose,
  cross-referencing tools. Section 3 above resolves this explicitly rather
  than silently picking a side.

**Playwright's own MCP server** (playwright.dev/mcp), which harborage's
`snapshot` tool is directly descended from (same "AI-readable accessibility
tree, not pixels" design). Its own documented rationale for splitting
accessibility-tree tools from screenshot tools is a direct, independent
confirmation that this problem is real and not specific to harborage: the
accessibility tree "does not capture whether an animation ran, whether a
chart rendered correctly, or whether a toast notification said what it was
supposed to say" — for those, the agent has to reason over a screenshot —
and vision tokens run three to five times the cost of text tokens on every
major API. Two consequences for the new tool: (1) it confirms there is a
genuine gap in harborage's current surface that this tool is right to fill,
nothing else answers "did the animation actually move"; (2) it argues for
making the numeric per-frame discriminators the primary decision data and
images strictly secondary evidence (cached-mode references, not inline
base64, exactly as `screenshot`'s own `mode: "cached"` already does for bulk
captures) — an agent should be able to answer "did it move" from numbers
alone in the common case, and reach for an image only when the numbers
leave it genuinely undetermined.

**Two recent papers, cited for the specific mechanism, not generic
"uncertainty is good" advice:**

- *Anchored Confabulation: Partial Evidence Non-Monotonically Amplifies
  Confident Hallucination in LLMs* (arXiv:2604.25931). Directly measures the
  effect this document is built around: handing a model partial evidence
  without framing produces confident wrong answers, and prepending an
  explicit epistemic-humility frame — literally, "you have been given k of n
  facts; express genuine uncertainty about the rest" — measurably reduces
  that confabulation rate (their reported figures: 0.656 baseline down to
  0.538 with the framing added). This is the mechanism behind section 2's
  requirement to state explicitly, as data, how many discriminators were
  available and which causes remain undecided, rather than trusting the
  agent to infer partiality from an unmarked payload.
- *Predicting When to Trust Vision-Language Models for Spatial Reasoning*
  (arXiv:2601.11644). Found that externally computed, task-specific
  verification of a vision claim carries far more predictive weight than
  a model's own self-reported confidence (87.4% vs 12.7% of predictive
  power, per their reported breakdown). This is the direct justification
  for section 1's rule that confidence in the payload must be a computed
  property of the measurement (frame count relative to expected duration,
  sample-to-sample noise floor, whatever the actual computation is) and
  never a self-rating solicited from either the agent or the tool's own
  implementation.

## 5. Proposed payload shape

This follows `computed_style`'s existing template exactly: raw
discriminators, a data-grounded (never causal) summary, computed (never
self-rated) confidence, `null` as a first-class "cannot determine" value,
machine-readable codes paired with prose explanations, and cached-mode
image references rather than inline base64 for a multi-frame capture.

```jsonc
{
  "pageId": "p_3f1a",
  "selector": "#hero-spinner",
  "trigger": { "kind": "click", "selector": "#play-button" },

  // Raw discriminators. Every claim in "summary" and "signature" below must
  // be reconstructible from this array alone — nothing here is inferred.
  "samples": [
    { "index": 0, "tMs": 0,   "box": { "x": 120, "y": 80, "width": 64, "height": 64 }, "opacity": 1, "transform": "matrix(1,0,0,1,0,0)" },
    { "index": 1, "tMs": 33,  "box": { "x": 120, "y": 80, "width": 64, "height": 64 }, "opacity": 1, "transform": "matrix(1,0,0,1,0,0)" },
    { "index": 2, "tMs": 66,  "box": { "x": 120, "y": 80, "width": 64, "height": 64 }, "opacity": 1, "transform": "matrix(1,0,0,1,0,0)" }
    // ... one entry per sampled frame
  ],

  // Cached-mode image references only (mirrors screenshot's mode: "cached"):
  // an agent that needs to actually look reaches for these explicitly,
  // rather than every call flooding the transcript with base64 frames.
  "frameImages": [
    { "index": 0, "cacheId": "b7e1...", "path": "/Users/.../screenshots/.../b7e1....png", "expiresAt": "2026-09-03T18:00:00.000Z" }
  ],

  // Data-level summary. Note what is absent: no word here claims a cause.
  "summary": {
    "sampledFrames": 12,
    "sampledOverMs": 400,
    "maxFrameToFrameDeltaPx": 0.3,
    "meanFrameToFrameDeltaPx": 0.1,
    "captureNoiseFloorPx": 0.4
  },

  // A data-SHAPE classification, checkable directly against "samples" and
  // "summary" above, deliberately not a causal word ("frozen", "broken").
  "signature": "no_measurable_change",

  // Computed from the data (noise floor vs. observed delta), never
  // self-rated by the agent or by the model that produced this result.
  "confidence": {
    "value": "high",
    "basis": "maxFrameToFrameDeltaPx (0.3) is below captureNoiseFloorPx (0.4): the sampled positions genuinely do not move, this is not a case of noise obscuring small real motion."
  },

  // Present only when the signature does not, by itself, distinguish
  // between real causes. Absent entirely on an unambiguous result: an agent
  // should be able to check `"ambiguous" in result` rather than parse prose.
  "ambiguous": true,
  "possibleCauses": [
    {
      "code": "element_frozen",
      "detail": "The element exists, is visible, and its own animation never advanced.",
      "distinguishBy": "Compare styles.animationPlayState across samples (included in detail mode); a genuinely frozen CSS animation still reports \"running\"."
    },
    {
      "code": "page_blank",
      "detail": "The page went blank or reset (a crash, a client-side redirect, a full unmount) and the selector is now matching nothing meaningful, or is matching a same-shaped placeholder.",
      "distinguishBy": "Call read_page_errors and read_console for this session: a crash or unmount usually leaves an uncaught exception or an unmounted-component warning in one of those buffers."
    },
    {
      "code": "trigger_did_not_fire",
      "detail": "The trigger selector may not have received the click/event at all.",
      "distinguishBy": "Call element_box on the trigger selector before re-running: occludedBy will show whether something else was actually receiving the click."
    }
  ]
}
```

Field-by-field justification, tying back to sections 1–2:

- `samples` is option (a), kept, because raw data is exactly what lets an
  agent (or a human) check every other field against ground truth. Raw data
  alone was the failure mode in the 19 trials only because nothing else was
  present; paired with the rest of this shape it is what makes the rest of
  the shape trustworthy rather than an unverifiable assertion.
- `summary` is option (b), restricted to data-level claims only, per the
  section 1 resolution of the anchoring-vs-confabulation tension.
- `confidence` is option (c), computed from `captureNoiseFloorPx` vs the
  observed delta, never solicited as a self-rating.
- `ambiguous` + `possibleCauses` is option (d) made concrete and structured,
  and is the direct implementation of section 2: state the data-level fact
  once, then hand over every cause consistent with it as checkable codes,
  each with its own next step, rather than collapsing to a single word or
  saying nothing.

## 6. Where this is uncertain

- The exact discriminators worth sampling (`box`, `opacity`, `transform` are
  a plausible starting set, matching what `computed_style` and `element_box`
  already know how to read) should be driven by what the real defects in
  this codebase's animations actually look like, which this document has no
  visibility into. Treat the sample shape above as a template, not a final
  schema.
- `captureNoiseFloorPx` needs an actual measured value from harborage's own
  capture pipeline (screenshot/CDP timing jitter at the relevant
  `deviceScaleFactor`), the same way `computed_style`'s stroke-coverage
  thresholds are backed by an actual sweep documented in its description
  ("measured across ten offsets per width..."). This document proposes the
  field, not the number; measure it before shipping the tool, or the
  `confidence` field becomes exactly the kind of unchecked assertion this
  whole document argues against.
- I could not verify a JSON example directly from Anthropic's tool-writing
  article; its concrete examples in the published post are shown as images,
  not text, so the "concise vs detailed" and consolidation claims are
  reported as described in the article's prose, not quoted verbatim from a
  code sample I could read.
- Whether `ambiguous`/`possibleCauses` should be a flat list (as drafted) or
  itself ranked by likelihood is a judgement call I have not tested; a
  ranked list risks reintroducing an anchor ("the first cause listed must be
  the real one"), which is why the draft above is deliberately unranked and
  unweighted. Worth a second look once real capture data exists to test
  against.
