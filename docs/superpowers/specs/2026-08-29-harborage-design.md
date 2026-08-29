# harborage: shared browser session pool — design

Status: implemented (see the codebase for the source of truth; this doc
records the decisions and why)
Date: 2026-08-29

This supersedes the earlier Steel-based design
(`2026-08-29-steel-qa-pool-design.md`, since removed from the working
tree). That design adopted a third-party self-hosted service (Steel) and
its own MCP server, on the theory that pooled/parallel browser isolation
was solved work not worth reimplementing. Live testing of a self-hosted
Steel instance found it hard-limited to one browser session at a time,
a dealbreaker for the actual goal (parallel subagents). This design builds
the pooling directly on Playwright instead — a much smaller amount of code
than expected, because Playwright's own `browser.newContext()` already
provides genuine per-session isolation within a single launched Chromium
process.

## 1. Problem

A live test proved that Claude Code's stock `@playwright/mcp` server, used
normally, lets two parallel subagents share the *same single tab* rather
than getting isolated sessions — one subagent's navigation silently
overwrote the other's page mid-task. Wanted, beyond just fixing that:

- Several subagents can each drive an isolated browser session at once,
  with zero cross-talk, without a visible window flickering on screen.
- Screenshots come back inline in the tool response, never written to disk.
- A subagent can start from pre-seeded browser state (already logged in)
  instead of repeating setup every time.
- When a subagent hits something it can't get past (a CAPTCHA, an
  ambiguous form), a human can take over that exact session to resolve it.
- The pool is usable from any project (not duplicated per-project), starts
  itself on demand, and actually reaps idle/abandoned sessions — unlike
  Microsoft's own `@playwright/mcp`, which only cleans up a session on an
  *explicit* termination call and leaves a crashed/killed client's session
  orphaned forever.

## 2. Architecture

```
Claude Code session (any project)
   │  .mcp.json → "harborage": { type: "stdio", command: "harborage" }
   ▼
client wrapper (bin/cli.js, one process per Claude Code MCP connection)
   │  1. serveStdio() starts immediately — the MCP `initialize` handshake
   │     never waits on the daemon (see §5)
   │  2. in the background: health-check the daemon; spawn it (detached)
   │     if unhealthy; wait for it; register {pid, startedAt} into the
   │     shared registry file
   │  3. each tool call forwards, unchanged, to the daemon over an MCP
   │     Client connected via Streamable HTTP
   ▼
daemon (one long-lived Node.js process, ~/.harborage, shared machine-wide)
   │  MCP server over Streamable HTTP (@modelcontextprotocol/server v2)
   │  in-memory table: sessionId -> { context, pages, createdAt, lastActivity }
   │  one Chromium process (launched lazily — see §4)
   │  one setInterval sweep: reap idle sessions + prune the client
   │  registry + self-shutdown when it empties (see §6)
   ▼
Chromium (headless, sandboxed, one process, N browser contexts)
```

Two processes, matching the spec:

- **The client wrapper** is what `.mcp.json` actually spawns — one per
  Claude Code MCP connection. It's a thin stdio<->HTTP proxy: an
  `McpServer` on the stdio side (talking to Claude Code) whose 11 tool
  handlers each forward the call, arguments and result unchanged, to an
  MCP `Client` connected to the daemon's `/mcp` endpoint. Tool
  name/description/Zod schema live in one shared module
  (`src/daemon/tools/schemas.ts`) imported by both the daemon (which
  implements the tools for real) and the wrapper (which registers
  matching pass-through tools), so the two can't silently drift apart.
- **The daemon** is the actual engine: one Chromium process, one
  in-memory session table, one MCP-over-HTTP endpoint, one periodic sweep.
  It's spawned on demand by whichever client wrapper needs it first, and
  shuts itself down once nothing needs it anymore (§6).

### Why a real MCP Client/Server pair, not raw byte piping, for the proxy

The wrapper could in principle just pipe stdio bytes to/from an HTTP
socket. It doesn't, because Streamable HTTP isn't a flat byte stream —
it has session IDs, an SSE upgrade path, and its own framing — so a raw
proxy would mean reimplementing that transport's client-side semantics by
hand. Using the SDK's real `Client` (which already implements Streamable
HTTP correctly) to talk to the daemon, behind an equally real `McpServer`
on the stdio side, costs one extra protocol hop but means both legs are
spec-correct by construction. Given the tool surface is small and fixed
(11 tools, known upfront), this was a better trade than building and
maintaining a generic bidirectional protocol-level proxy.

## 3. Tool surface

| Tool | Purpose |
|---|---|
| `create_session` | New isolated session; optional `storageState` to seed cookies/localStorage. Returns `sessionId`. |
| `navigate` | Go to a URL in a session's tab. |
| `click` | Click an element (Playwright selector). |
| `fill` | Fill a form field. |
| `evaluate` | Run a JS expression in the page, get the JSON-serialized result back. |
| `snapshot` | AI-optimized ARIA accessibility tree of the tab (`locator.ariaSnapshot({mode: 'ai'})`) — structure and text, not pixels. |
| `list_tabs` | List a session's open tabs. |
| `screenshot` | PNG, returned inline as base64 — never written to disk. |
| `export_state` | Returns the session's current `storageState` (cookies + localStorage), for seeding future sessions. |
| `escalate_session` | Resolves the session's current CDP target and returns its `webSocketDebuggerUrl` for a human to attach to directly. |
| `release_session` | Closes the session's `BrowserContext`. |

A session can have multiple tabs (`pageId`, defaulting to the
most-recently-active one); a tab opened by the page itself
(`window.open`, `target="_blank"`) becomes reachable through `list_tabs`
and becomes the new default target, matching what a person watching the
browser would expect.

## 4. Decisions this project had to make (called out explicitly, per the brief)

### 4.1 Chromium launch: lazy, not eager

The daemon launches Chromium on the **first `create_session` call**, not
at daemon startup. The client wrapper's ensure-running step spawns the
daemon unconditionally whenever a Claude Code session opens the MCP
connection — whether or not that session ever calls a browser tool.
Eager launch would pay Chromium's RAM (~150-300MB) and startup latency
for every MCP-configured session, including ones that never touch a
browser. Lazy launch means only sessions that actually use the pool pay
that cost; the first real `create_session` in a daemon's lifetime just
waits slightly longer.

### 4.2 One in-process timer, not a second scheduled process

Both idle-session reaping and client-registry pruning + self-shutdown run
off **one `setInterval` inside the daemon** (`src/daemon/sweep.ts`), not
a separate externally-scheduled script (e.g. a `launchd`/cron job, the
approach the earlier Steel-based design used). The daemon is already a
long-lived process once started — there's no correctness gap versus a
second scheduled process, and one fewer moving part (no installer, no
"first run installs a persistent OS-level job" step, nothing to keep in
sync with the daemon's own state). The trade-off this accepts: if the
daemon itself is killed with `SIGKILL` (not the graceful signals it
already handles), nothing sweeps until it's started again — acceptable,
since the same restart is also what re-launches Chromium and rebuilds the
session table; a dead daemon has nothing left to sweep.

### 4.3 Self-shutdown grace period

A freshly-started daemon does **not** shut itself down just because the
registry happens to be empty on its very first sweep. `shutdownGraceMs`
(default 10s) must elapse since daemon startup before an empty registry
is honored. Without this, a slow-to-register client (or two daemons
racing to start, see §4.5) could see the daemon shut itself down before
the client that just spawned it ever gets to register — self-healing
(the next call just spawns it again) but wasteful. Verified directly in
`test/registry-and-shutdown.test.ts`: a fresh daemon survives several
sweep intervals with an empty registry when still inside its grace
period, and shuts down once the same empty registry outlives it.

### 4.4 `--remote-debugging-port` is always on, from launch

Chromium can't open a CDP debugging port after the process has already
started, so it's passed unconditionally in `chromium.launch()`'s args,
every time. `escalate_session` doesn't "turn on" debugging — it resolves
the session's current CDP `targetId` (via `context.newCDPSession`) and
looks it up against `http://localhost:<debugPort>/json/list`, which is
already serving every open page independently, each with its own
`webSocketDebuggerUrl`. Verified live: a real CDP client can fetch a
screenshot and target info through this port while the session is
otherwise idle.

### 4.5 `chromiumSandbox: true` — a real correction to the starting assumption

The brief's starting assumption was "don't pass `--no-sandbox`, and the
sandbox stays on by default." **That assumption doesn't hold as stated.**
Directly inspecting the real command line of a Chromium process launched
by `chromium.launch({ headless: true })` (no other options) showed
`--no-sandbox` present, even though nothing in this project's own code
ever passed it. The cause: Playwright's own `chromiumSandbox` launch
option **defaults to `false`**, and false means Playwright adds
`--no-sandbox` itself. Simply omitting the flag from our own `args`, as
originally assumed, is not sufficient — the library injects it anyway
unless told otherwise. The fix is to pass `chromiumSandbox: true`
explicitly in `browserManager.ts`. Confirmed working (page loads
succeed, sessions function normally) with the sandbox genuinely enabled
this way, and confirmed via the same command-line inspection that
`--no-sandbox` is now actually absent (`test/headless.test.ts`).

## 5. The MCP handshake must never wait on daemon readiness

Claude Code's own MCP startup-handshake timeout isn't publicly
documented. The wrapper's `runWrapper()` calls `serveStdio()`
synchronously, before anything that could block — the daemon
health-check-and-spawn work is kicked off in the background
(`void ensureReady()...`, not awaited) in the same tick. Only the first
actual tool call `await`s the (memoized) readiness promise. Proven with a
dedicated test-only hook: `HARBORAGE_TEST_STARTUP_DELAY_MS` (zero in every
real deployment) makes the daemon sleep before opening its listener;
`test/handshake-not-blocked.test.ts` spawns the real wrapper against a
3-second artificial cold start and asserts the handshake completes in a
small fraction of that time, while the first tool call visibly waits out
most of it.

## 6. Lifecycle and cleanup

- **Idle session reaping.** Every sweep tick, any session whose
  `lastActivity` is older than `idleTimeoutMs` (default 15 minutes) gets
  its `BrowserContext` closed and removed from the table. Any tool call
  that touches a session (`resolve()`) refreshes `lastActivity`; checking
  idleness itself does not count as activity.
- **Client registry.** `~/.harborage/registry.json` — machine-level, not
  per-project, since the pool is meant to be shared across projects. Each
  client wrapper registers `{pid, startedAt}` on startup (best-effort
  deregisters on graceful exit) where `startedAt` is that PID's real OS
  process-start time (`ps -o lstart=`), not just a timestamp the wrapper
  made up.
- **PID-reuse guard.** Every sweep, each registry entry is re-checked:
  alive *and* its live `lstart` still equals the recorded `startedAt`.
  A dead PID is dropped. A **live** PID whose `lstart` no longer matches
  (a different process has since reused that number) is *also* dropped —
  this is the actual guard against PID reuse, not just a liveness check.
  Verified directly against real spawned/killed processes in
  `test/pid-reuse-guard.test.ts`.
- **Daemon self-shutdown.** Once the registry is empty *and* the grace
  period (§4.3) has elapsed, the daemon closes every session, closes
  Chromium, closes its HTTP server, and exits. The next client that needs
  it triggers ensure-running again — a few seconds of cold-start latency,
  never a correctness bug.
- **Two daemons racing to start.** If two client wrappers both see the
  daemon as unhealthy and both spawn it, the loser's `listen()` fails
  with `EADDRINUSE`; it logs that another instance is already serving and
  exits `0` rather than crashing. Wasteful (one extra short-lived
  process) but not a correctness issue.

## 7. Testing

19 tests, `npm test` (builds, then runs against the real compiled
`dist/`), all against real Chromium and real daemon/wrapper subprocesses
— no mocks of the browser or the protocol layer:

| File | Proves |
|---|---|
| `isolation.test.ts` | Two concurrent sessions: zero localStorage/cookie bleed-through; genuinely separate `BrowserContext`s. |
| `headless.test.ts` | The real launched process's command line has `--headless` and not `--no-sandbox`; a headless session still renders and screenshots real content. |
| `idle-reap.test.ts` | A session idle past a short threshold gets reaped; activity resets the clock; only stale sessions get reaped out of a mix. |
| `registry-and-shutdown.test.ts` | A fresh daemon survives an empty registry within its grace period, then shuts down once that period elapses; a stale dead-PID entry gets pruned and (once that empties the registry) triggers shutdown; a live, correctly-registered client keeps the daemon up, and removing it lets it shut down. |
| `pid-reuse-guard.test.ts` | `pruneDead` keeps a live+matching entry, drops a dead PID, and — the actual reuse guard — drops a *live* PID whose recorded start time doesn't match. |
| `handshake-not-blocked.test.ts` | The real wrapper's MCP handshake completes in well under half of an artificially-slowed 3s daemon cold start; the first tool call visibly pays that cost; the daemon it spawned shuts itself down after the client disconnects. |
| `screenshot-inline.test.ts` | Screenshot content is inline base64 PNG (magic-byte checked); a whole-repo file listing (excluding `node_modules`/`dist`/`.git`) is byte-identical before and after. |
| `seeding.test.ts` | `export_state` on a session with a real cookie + localStorage value, fed into `create_session`, produces a session that already has both — before any navigation in the seeded session sets anything itself. |

All three consecutive full runs during development passed with zero
flakiness, and left zero orphaned Chromium or daemon processes behind
(checked via `ps aux` after each run).

## 8. Known gaps / follow-ups

- **No launchd/systemd install step.** The daemon's lifecycle is entirely
  self-managed (§4.2/§6); nothing needs installing on the machine. This
  is a deliberate simplification versus the earlier Steel-based design,
  not an oversight.
- **No npm publish yet.** `bin` is wired up (`dist/client/cli.js`) and
  `npm install` (via `prepare`) already builds it, so
  `npx github:<owner>/harborage#<pinned-ref>` should work today the same
  way it was verified to for the earlier design, but this hasn't been
  re-verified against this codebase specifically.
- **`click`/`fill` take a raw Playwright selector string**, not an
  accessibility-tree `ref` the way `@playwright/mcp` and the `snapshot`
  tool's own AI-mode refs work. A subagent using `snapshot` to find an
  element gets a `ref=eN}` id back but has to re-target it as a selector
  (e.g. by role/text) for `click`/`fill` rather than passing the ref
  straight through. Simpler to implement and enough for real QA/scraping
  work today; wiring `snapshot`'s refs directly into `click`/`fill` would
  need per-session ref-tracking state this design deliberately doesn't
  have yet.
- **No per-session concurrency limit / max-sessions cap.** Nothing stops
  a caller from opening far more sessions than the machine can hold. Not
  needed for the current use case (a handful of parallel QA subagents),
  worth adding if usage grows.
- **`evaluate` runs an arbitrary string expression with no sandboxing
  beyond the page's own JS context.** Same trust model as
  `@playwright/mcp`'s equivalent — a subagent driving its own session can
  run arbitrary JS in that session's page. Not a new risk this project
  introduces, just worth naming.
