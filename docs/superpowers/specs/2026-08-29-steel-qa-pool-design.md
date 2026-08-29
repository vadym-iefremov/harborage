# Parallel headless QA browser pool — design

Status: approved design, pre-implementation
Date: 2026-08-29

## 1. Problem

Today, running two Claude Code QA subagents in parallel against the stock
`@playwright/mcp` server (default config, no flags) is unsafe: a live test
confirmed both subagents shared a single browser tab rather than getting
isolated sessions. One subagent navigated to a page and never touched the
browser again, but by the time it checked, its own tab's content had
silently become the other subagent's page, overwritten mid-flight. The
same default config also opens a real, visible browser window (headless
is opt-in, not default), which is the on-screen flicker this project set
out to remove.

Wanted, beyond just fixing that:

- Multiple QA subagents can each drive an isolated browser session at
  once, with no cross-talk.
- No visible windows, no flicker.
- A subagent can start from a pre-seeded browser state (already logged
  in, some setup already done) instead of repeating boilerplate every
  time.
- When a subagent hits something it can't get past (a CAPTCHA, an
  ambiguous form), a human can look at or take over that exact session
  to resolve it, then hand it back.
- Screenshots and other session artifacts land in one fixed place
  outside any project folder, and get cleaned up automatically instead
  of accumulating.
- The underlying service is usable from any project, not duplicated
  per-project, and starts itself on demand rather than needing to be
  manually started, while not sitting resident forever once nothing
  could plausibly still be using it.

## 2. Non-goals

- **Not building our own browser pooling/isolation engine.** Research
  confirmed an existing open-source project (Steel, see below) already
  does this well; reinventing it would be redoing solved work.
- **Not forking Steel.** Nothing identified so far requires changing
  its source; everything we need is either already exposed by its API
  or a config setting. We treat it as an unmodified upstream dependency
  (its official Docker image), the same way any Compose file references
  a public image. If a concrete requirement later turns out to need a
  real source change, that's a reason to revisit this, not a reason to
  fork preemptively.
- **Not tracking literal in-session activity to decide when to shut
  down.** Steel already reclaims idle *sessions* on its own
  (`inactivityTimeout`). Our own shutdown logic only answers a coarser
  question: is any Claude Code process that ever registered as a
  potential user still alive at all. That's deliberately simpler than
  a real usage-based idle timer, and good enough for this.
- **Not auto-fetching/cloning this wrapper on every use, yet.** Until
  this is published to npm, the wrapper repo is set up once by hand by
  whoever wants to use it, and the local `.mcp.json` just points at
  that fixed path. The `npx <package>@latest`-style zero-setup
  experience is explicitly deferred to the npm-distribution phase (see
  §8).

## 3. Why Steel, not a custom build

Researched against actual docs, not assumed: two realistic open-source
candidates exist for pooled/parallel browser automation aimed at agents.

**Browserless** is open-source and self-hostable, but live session
viewing, the one feature that matters most here (the human-escalation
case), is Enterprise-only, and it has no MCP support at all. Ruled out.

**Steel** (`steel-dev/steel-browser`, Apache 2.0) is genuinely free and
self-hostable, and ships an official MCP server
(`steel-dev/steel-mcp-server`) that runs against a self-hosted instance
with no API key needed. Its tools cover what's wanted directly:

| Need | Steel's answer |
|---|---|
| Isolated parallel sessions from one pool | `steel_session_create` / `steel_session_release`, capped and configurable |
| Headless by default | Yes |
| Pre-seeded login/setup state | Sessions API: cookies/localStorage/page state can be saved from one session and restored into another (`sessionContext`, `profileId` + `persistProfile`) |
| Human escalation on a stuck session | `steel_session_live_view` (watch), `steel_session_handoff` (take exclusive control, then return it) |
| Per-session idle cleanup | `inactivityTimeout` auto-releases an idle session |

Gaps Steel doesn't cover, which this project supplies:

1. Nothing manages the Docker container's own lifecycle (Steel's idle
   timeout only releases sessions inside an already-running server).
2. Screenshot/artifact storage location and retention, unconfirmed
   against a live instance as of this writing, needs verifying during
   implementation (§9, open item).
3. No existing project layers this kind of pooling on top of
   Microsoft's own `@playwright/mcp` specifically; Steel uses its own
   automation layer. Not required here, since the actual requirement was
   the capabilities above, not literal `@playwright/mcp` tool-name
   parity.

## 4. Architecture

```
Claude Code session (any project)
        │  .mcp.json → "steel-qa": { command: node, args: [.../bin/cli.js] }
        ▼
 our wrapper CLI (bin/cli.js)
        │  1. ensure Steel's Compose stack is running (start if not)
        │  2. register {pid, startedAt} into the shared registry file
        │  3. exec/hand off stdio to Steel's official steel-mcp-server
        ▼
 steel-mcp-server  ──HTTP──▶  Steel (Docker Compose, official image)
                                   │
                                   ▼
                         pool of isolated browser sessions
                         (create / seed / live-view / handoff / release)

 independent of any Claude session, on its own timer:
 launchd (every 5 min) → sweep script
        │  read registry → drop PIDs that are no longer alive
        │  (liveness = PID exists AND recorded start time still matches,
        │   guards against PID reuse)
        │  if registry now empty → stop the Steel Compose stack
```

Two processes make this work, neither of them a long-lived daemon we
have to babysit:

- **The wrapper CLI** runs once per Claude Code session that opens the
  MCP connection, does its ensure/register/handoff, then effectively
  *becomes* `steel-mcp-server` for the rest of that session's life
  (stdio piped straight through). Its own status/log output goes to
  stderr only, never stdout, since stdout is the live MCP protocol
  channel from the moment the connection opens; writing anything else
  there would corrupt the handshake.
- **The sweep script** is not a resident watchdog. It's a short-lived
  script that `launchd`'s own timer (`StartInterval: 300`) wakes up
  every 5 minutes, does its check, and exits. Nothing is watching in
  between, the OS wakes it.

## 5. Components

1. **`docker-compose.yml`** — references Steel's official published
   image only, no vendored source.
2. **`bin/cli.js`** — the wrapper: ensure-running, register, handoff.
   Registered in `.mcp.json` for now as
   `{"command": "node", "args": ["<absolute path>/bin/cli.js"]}`
   (see §8 for why this isn't `npx` yet).
3. **Registry file** — a small JSON file, `[{pid, startedAt}, ...]`,
   living in a fixed machine-level location outside any single
   project (e.g. `~/.steel-qa-pool/registry.json`), since this is a
   shared resource across whatever projects use it, not tied to one
   project or to `~/.claude` specifically (this is meant to be a
   separate, shareable tool).
4. **`bin/sweep.js`** — the periodic prune-and-maybe-stop script.
5. **launchd plist + installer** — installs the `StartInterval` job
   that runs `sweep.js` every 5 minutes. Installed automatically on
   first run of the CLI, with a clear log line saying it did so
   (writing a persistent LaunchAgent is a real, lasting change to the
   machine, and should never happen silently, especially once this is
   shared with other people who won't be expecting it otherwise).
6. **Artifact storage config** — Steel configured to write
   screenshots/session artifacts to one fixed location outside any
   project folder, plus a retention sweep (can piggyback on the same
   5-minute `sweep.js` run, or its own interval) deleting anything past
   a configured age. Exact configuration mechanism is an open item,
   see §9.

## 6. Flows

**Normal QA session.** A subagent's Claude Code session opens the
`steel-qa` MCP connection → wrapper CLI ensures Steel is running,
registers its PID, hands off to `steel-mcp-server` → subagent calls
`steel_session_create`, drives its isolated session, calls
`steel_session_release` when done (or lets `inactivityTimeout` do it).

**Escalation (stuck on a wall).** Subagent recognizes it's blocked
(CAPTCHA, ambiguous form) → reports the Steel session id to the team
lead along with what it's stuck on → team lead calls
`steel_session_live_view` to look, or `steel_session_handoff` to take
exclusive control → resolves it manually → hands control back to the
subagent to continue.

**Seeding.** Team lead prepares a session once (logs in, completes some
setup), persists it via Steel's profile mechanism
(`profileId` + `persistProfile`) → subagents spawned afterward create
their sessions from that saved profile instead of repeating the
login/setup themselves.

**Shutdown.** Every 5 minutes, independent of any session:
`sweep.js` reads the registry, drops any `{pid, startedAt}` whose
process is no longer alive or whose start time no longer matches (PID
reuse guard) → if the registry is now empty, stops the Steel Compose
stack. The next session that wants to use the pool just triggers
ensure-running again, a few seconds of container startup latency, not
a failure.

## 7. Edge cases

- **Docker not installed or not running.** Surfaced as a clear error
  from the wrapper CLI, not a silent failure. (Confirmed present on
  this machine but not currently running as of this writing.)
- **A new session starts right as the sweep is stopping the stack.**
  Self-healing: worst case is the new session's ensure-running restarts
  it a few seconds later. Not a correctness issue, just latency.
- **PID reuse.** Guarded by storing and re-checking the process's start
  time alongside its PID, not PID existence alone.

## 8. Distribution (this phase vs. later)

**Now:** the repo is cloned locally by hand by whoever wants to use it.
`.mcp.json` points at the absolute local path
(`node <path>/bin/cli.js`), no auto-clone, no `npx` resolution. This is
a deliberate simplification, not a missing feature, until there's a
published package to fetch.

**Later (out of scope for this spec):** publish to npm, so
`.mcp.json` can use `"command": "npx", "args": ["-y", "steel-qa-pool@latest"]`
the same way `@playwright/mcp` is used today, no local clone needed at
all. This is the point at which "no setup beyond having Docker" becomes
literally true for anyone.

## 9. Open items (deliberately unresolved here, resolve during implementation)

- Exact mechanism for Steel's artifact/screenshot storage location and
  retention: needs checking directly against a running instance, not
  assumed from docs alone.
- Registry file's exact path and permissions.
- Repo name (working name in this doc: `steel-qa-pool`) and whether it
  starts public or private on GitHub.
- The QA skill that dispatches N subagents against this pool is a
  separate, later layer on top of this infrastructure and is not part
  of this spec. It will need its own naming/trigger-condition design so
  it doesn't collide with the existing `voltagent-qa-sec` agents.

## 10. Testing plan

- Re-run the two-parallel-subagent spike against this pool (instead of
  stock `@playwright/mcp`) and confirm no tab/session collision this
  time, each gets its own isolated session.
- Confirm no visible browser window appears.
- Confirm artifact files land in the configured location, not inside
  any project folder.
- Kill a fake registered PID, wait past one sweep interval, confirm the
  Steel stack actually stops.
- Confirm ensure-running cleanly restarts Steel after a stop.
