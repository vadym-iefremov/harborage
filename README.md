<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/harborage-logo-dark.png">
    <img src="assets/harborage-logo-light.png" alt="harborage" width="304">
  </picture>
</p>

<p align="center">
  <em>A shared, on-demand pool of isolated headless browser sessions for Claude Code subagents.</em>
</p>

<p align="center">
  <a href="https://github.com/vadym-iefremov/harborage/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/vadym-iefremov/harborage/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="MIT licence" src="https://img.shields.io/badge/licence-MIT-0E3B45"></a>
  <img alt="Node 20+" src="https://img.shields.io/badge/node-%E2%89%A520-0E3B45">
</p>

---

Run several browser-driving subagents in parallel, for QA testing, scraping
or research, without them fighting over the same tab, without a visible
window flickering on screen, and without duplicating a browser MCP server
per project.

One long-lived daemon launches a single headless Chromium process and hands
out an isolated `BrowserContext` per session. A thin per-project client
wrapper proxies MCP traffic to it over HTTP.

**Status:** working, and battle-tested. Six QA agents drove seven concurrent
isolated sessions through roughly 470 tool calls against a live React app
with zero tool failures and no cross-session bleed. See
[`docs/superpowers/specs/2026-08-29-harborage-design.md`](docs/superpowers/specs/2026-08-29-harborage-design.md)
for the full design and the decisions behind it.

## Why

Claude Code's stock `@playwright/mcp` server, used normally, lets two
parallel subagents share the *same single browser tab* rather than getting
isolated sessions: one subagent's navigation silently overwrites the other's
page mid-task. harborage fixes that generally. Every session gets its own
Playwright `BrowserContext`, live-tested to have zero cookie, localStorage or
state bleed-through between concurrent sessions, all inside one shared
headless Chromium process.

It is also headless by construction. A browser MCP server that opens a real
window fights the human for the pointer and the screen. harborage cannot,
because there is no window.

## Requirements

- Node.js >= 20.
- Playwright's Chromium, downloaded once via `npx playwright install
  chromium`. It is a plain, unprivileged binary. No Docker, no root.

## Quick start

```sh
git clone https://github.com/vadym-iefremov/harborage.git
cd harborage
npm install                       # also builds dist/ via the `prepare` script
npx playwright install chromium   # first time only, if not already present
npm link                          # puts the `harborage` command on your PATH
```

Add it to a project's `.mcp.json`:

```json
{
  "mcpServers": {
    "harborage": {
      "type": "stdio",
      "command": "harborage"
    }
  }
}
```

Without `npm link`, point `command` at the absolute path to
`dist/client/cli.js` instead:

```json
{
  "mcpServers": {
    "harborage": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/harborage/dist/client/cli.js"]
    }
  }
}
```

Then restart Claude Code and re-approve the changed project config.

> **Editing `.mcp.json` mid-session does nothing.** Claude Code reads it only
> at session start, so a newly added server will not appear in `/mcp` and no
> subagent can reach its tools until you fully restart the CLI. This costs a
> restart cycle to discover, so it is worth knowing in advance.

The first Claude Code session that opens this MCP connection spawns a shared
daemon in the background (`~/.harborage/`). Every later session, in this
project or any other, reuses the same daemon. The daemon shuts itself down
once nothing needs it anymore, see [Lifecycle](#lifecycle).

## Design rule: a tool reports what actually happened

The most damaging thing a browser tool can do to an AI agent is succeed
quietly while doing nothing. An agent's whole job is telling truth from
appearance, and a success payload identical to a real one hands it
appearance.

Two real examples drove this rule. `navigate` to a URL differing only in the
hash used to return a payload identical to a real page load while the JS
context, React state and console buffer all survived untouched: four of five
QA agents hit it and two recorded false passes. And `fill` on a CodeMirror
editor inserted instead of replacing, so an agent drew conclusions about a
value it had never actually set.

So, across the surface:

- A tool that changes state reads it back and reports what it really is.
- A tool that cannot do what was asked says so, rather than returning a bare
  success.
- A tool that did something subtly different from what was asked reports that
  explicitly. A same-document navigation, a drag the browser turned into a
  text selection, a mock that never matched.

## What a subagent gets

**59 MCP tools.** Every tool takes a `sessionId`. Most take an optional
`pageId` and default to the session's active tab.

<details>
<summary><strong>Sessions and tabs (12)</strong></summary>

`create_session` (optionally seeded from exported storage state, with an
optional viewport, `deviceScaleFactor` and `networkCaptureFilter`),
`release_session`, `list_sessions` (every active session machine-wide,
discoverable without already knowing a sessionId), `list_tabs`, `new_tab`,
`close_tab`, `select_tab`, `export_state`, `handle_dialog` (policy for
`alert` / `confirm` / `prompt`, plus what actually appeared),
`read_page_errors` (uncaught exceptions and unhandled rejections, a
separate channel from console output), `escalate_session`, which hands a
stuck session to a *human* through a real Chrome DevTools WebSocket URL,
and `set_network_capture_filter`, which changes or removes a session's
network capture filter while it is already running, for the common case of
only discovering a flood of noise after it has already happened.

</details>

<details>
<summary><strong>Interaction (15)</strong></summary>

`navigate` (reporting same-document navigations explicitly), `reload`,
`click` (with an optional offset inside the element), `fill`, `type`
(per-character key events), `press_key`, `hover`, `drag`, `wheel`,
`select_option`, `file_upload`, `resize`, `wait_for`, `navigate_back`,
`navigate_forward`.

</details>

<details>
<summary><strong>Inspection (10)</strong></summary>

`snapshot` (an AI-readable accessibility tree), `evaluate` (with a timeout,
and failures that echo the numbered source with the faulting line marked),
`screenshot` (inline base64, or a TTL-expiring per-session cache; whole
viewport, full page, one element, or an explicit clip; always reporting its
real pixel dimensions), `read_console`, `list_network_requests`,
`computed_style` (composited colour and WCAG contrast, and it can force
`:hover` or `:focus-visible`), `element_box` (geometry, visibility, and what
is occluding it), `list_frames`, `find` (returns a selector the other tools
accept), and `send_cdp_command` for raw CDP.

</details>

<details>
<summary><strong>Emulation (8)</strong></summary>

`emulate_media` (colour scheme, so the light theme is finally testable, plus
reduced motion and forced colours), `set_user_agent`, `set_timezone`,
`set_locale`, `grant_permissions`, `clear_permissions`, `set_geolocation`,
`emulate_clock` (a fake clock, so a test that would take an hour of real
waiting takes a millisecond).

</details>

<details>
<summary><strong>Network (6)</strong></summary>

`add_route_rule` (fulfil, abort or rewrite matching requests, so a 413 or a
500 is a one-line deterministic test), `list_route_rules`,
`remove_route_rule`, `clear_route_rules`, `set_offline`,
`set_network_conditions`.

</details>

<details>
<summary><strong>Storage (8)</strong></summary>

`get_cookies`, `set_cookies`, `clear_cookies`, `get_storage`, `set_storage`,
`remove_storage`, `clear_storage`, `download_file`.

</details>

## Configuration

Everything is optional and sane defaults apply. These environment variables
are read once at startup by both the daemon and the client wrapper.

### Network and paths

| Variable | Default | Meaning |
|---|---|---|
| `HARBORAGE_HOST` | `127.0.0.1` | Loopback-only bind for the daemon's HTTP endpoint. |
| `HARBORAGE_PORT` | `4599` | Daemon's MCP-over-HTTP port. |
| `HARBORAGE_DEBUG_PORT` | `4600` | Chromium's `--remote-debugging-port`, for `escalate_session`. |
| `HARBORAGE_STATE_DIR` | `~/.harborage` | Registry file, daemon log, screenshot cache and downloads live here. |
| `HARBORAGE_REGISTRY_PATH` | `$STATE_DIR/registry.json` | Where the client registry is written. |
| `HARBORAGE_DAEMON_LOG_PATH` | `$STATE_DIR/daemon.log` | Where the daemon writes its structured log. |

### Lifecycle and reaping

| Variable | Default | Meaning |
|---|---|---|
| `HARBORAGE_IDLE_TIMEOUT_MS` | `900000` (15m) | A session idle longer than this gets reaped. |
| `HARBORAGE_ESCALATED_IDLE_TIMEOUT_MS` | `3600000` (1h) | Idle timeout for a session handed to a human by `escalate_session`, since no tool call marks it as active while a person drives it. |
| `HARBORAGE_MAX_IN_FLIGHT_AGE_MS` | `600000` (10m) | A tool call in flight stops the reaper touching its session. Past this age the call is treated as stuck, so a wedged call cannot pin a session or the shared daemon forever. |
| `HARBORAGE_SWEEP_INTERVAL_MS` | `60000` (1m) | How often the daemon reaps idle sessions and prunes its client registry. |
| `HARBORAGE_SHUTDOWN_GRACE_MS` | `10000` | Minimum daemon uptime before an empty client registry is allowed to trigger self-shutdown. |
| `HARBORAGE_DAEMON_READY_TIMEOUT_MS` | `60000` (1m) | How long a client wrapper waits for a daemon it just spawned to become healthy. |
| `HARBORAGE_DAEMON_HEALTH_POLL_MS` | `200` | Interval between those health checks. |

### Buffers and caches

| Variable | Default | Meaning |
|---|---|---|
| `HARBORAGE_SCREENSHOT_CACHE_DIR` | `$STATE_DIR/screenshots` | Where `screenshot`'s `mode: 'cached'` writes PNGs, in a per-session subdirectory. |
| `HARBORAGE_SCREENSHOT_CACHE_TTL_MS` | `14400000` (4h) | A cached screenshot older than this gets deleted by the same sweep that reaps idle sessions. |
| `HARBORAGE_CONSOLE_BUFFER_SIZE` | `200` | Max buffered `console` messages per session (oldest dropped first; `read_console` reports how many were dropped). |
| `HARBORAGE_NETWORK_BUFFER_SIZE` | `400` | Max buffered network request and response entries per session (oldest dropped first; `list_network_requests` reports how many were dropped, and a session capture filter keeps noise out of the ring in the first place). |
| `HARBORAGE_DIALOG_BUFFER_SIZE` | `200` | Max buffered JavaScript dialog records per session (oldest dropped first; `handle_dialog` reports how many were dropped). |
| `HARBORAGE_PAGE_ERROR_BUFFER_SIZE` | `200` | Max buffered uncaught exceptions and unhandled rejections per session (oldest dropped first; `read_page_errors` reports how many were dropped). |

Running a second, isolated instance, for developing harborage itself without
touching a daemon that is serving real work, means overriding the port, the
debug port and the state directory together:

```sh
HARBORAGE_PORT=4699 HARBORAGE_DEBUG_PORT=4700 HARBORAGE_STATE_DIR=/tmp/harborage-dev
```

## Lifecycle

- **Idle sessions are reaped** after `HARBORAGE_IDLE_TIMEOUT_MS`. A call in
  flight protects its own session, up to `HARBORAGE_MAX_IN_FLIGHT_AGE_MS`.
- **The daemon shuts itself down** once no client is registered *and* no
  session is live. Both counts matter: checking only the registry used to let
  the daemon exit during a parallel fan-out and take every in-flight session
  with it.
- **The daemon log** (`~/.harborage/daemon.log`) carries one timestamped,
  structured line per event: daemon start and stop, session create, release
  and reap with ids and remaining counts, and every shutdown decision
  including the ones that decline, with both counts. When a subagent reports
  a dead session, this is where the answer is.

## Picking up changes to harborage itself

Three different things change in three different places, so the right action
depends on what you changed:

| What changed | What to do |
|---|---|
| A tool's **behaviour** (daemon-side logic) | Rebuild, then stop the daemon. The next tool call respawns it from the new build. |
| A tool's **description or input schema**, or a **new tool** | Rebuild, then `/mcp` and reconnect harborage, which respawns the stdio client so Claude Code re-reads the tool list. |
| `.mcp.json` itself | Fully restart Claude Code. |

The tool list a Claude Code session holds is fixed when the stdio client
process starts, so a new tool cannot appear until that process is replaced.
Restarting only the daemon is not enough for that case.

Stopping the daemon is safe. A client wrapper whose daemon has gone away
health-checks, respawns it and retries the call once. Browser sessions do not
survive it, since the Chromium died with the daemon, so an older sessionId
comes back as a clean session-not-found rather than a transport error.

## Development

```sh
npm run build       # tsc -> dist/
npm run typecheck   # strict type-check of src/ and test/
npm test            # builds, then runs the full suite (real Chromium, no mocks)
```

346 tests, all against real Chromium and real daemon and wrapper
subprocesses. There are no mocks of the browser or the protocol layer,
deliberately: the bugs this project cares about are exactly the ones a mock
would hide.

## Contributing

Bug reports and pull requests are welcome. See
[CONTRIBUTING.md](CONTRIBUTING.md) for how the project is laid out, what a
good change looks like, and the one rule every new tool has to follow.

## Licence

MIT, see [LICENSE](LICENSE).

Built on [Playwright](https://playwright.dev/). The wordmark is set in
[Jost](https://github.com/indestructible-type/Jost), licensed under the SIL
Open Font License.
