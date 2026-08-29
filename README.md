# harborage

A shared, on-demand pool of isolated headless browser sessions for
Claude Code subagents, built directly on
[Playwright](https://playwright.dev/).

Run several browser-driving subagents in parallel — QA testing, scraping,
research — without them fighting over the same tab, without a visible
window flickering on screen, and without duplicating a browser MCP server
per project.

**Status:** working. One long-lived daemon launches a single headless
Chromium process and hands out an isolated `BrowserContext` per session; a
thin per-project client wrapper proxies MCP traffic to it over HTTP. See
[`docs/superpowers/specs/2026-08-29-harborage-design.md`](docs/superpowers/specs/2026-08-29-harborage-design.md)
for the full design and the decisions behind it.

## Why

Claude Code's stock `@playwright/mcp` server, used normally, lets two
parallel subagents share the *same single browser tab* rather than
getting isolated sessions — one subagent's navigation silently overwrites
the other's page mid-task. harborage fixes that generally: every session
gets its own Playwright `BrowserContext`, live-tested to have zero
cookie/localStorage bleed-through between concurrent sessions, all inside
one shared headless Chromium process.

## What it gives a subagent

Fifteen MCP tools: `create_session` (optionally seeded from previously
exported storage state), `navigate`, `click`, `fill`, `evaluate`,
`snapshot` (an AI-readable accessibility tree), `list_tabs`,
`screenshot` (inline base64 by default, or `mode: 'cached'` to write it to
a TTL-expiring local cache instead), `export_state` (for seeding future
sessions), `escalate_session` (hands a stuck session to a *human* via a
real Chrome DevTools Protocol WebSocket URL), `release_session`,
`list_sessions` (every active session machine-wide, discoverable without
already knowing a sessionId), `read_console` and `list_network_requests`
(buffered browser console/network activity, since session creation), and
`send_cdp_command` (raw CDP access for an *agent*, no human in the loop —
escalate_session's counterpart).

## Requirements

- Node.js >= 20.
- Playwright's Chromium browser downloaded once via `npx playwright
  install chromium` (a plain, unprivileged binary — no Docker, no root).

## Setup

```sh
git clone <this repo>
cd harborage
npm install          # also builds dist/ via the `prepare` script
npx playwright install chromium   # first time only, if not already present
npm link              # makes the `harborage` command available on your PATH
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

(Without `npm link`, point `command` at the absolute path to
`dist/client/cli.js` instead, e.g. `"command": "node", "args":
["/path/to/harborage/dist/client/cli.js"]`.)

The first Claude Code session that opens this MCP connection spawns a
shared daemon in the background (`~/.harborage/`); every later session,
in this project or any other, reuses the same daemon. The daemon shuts
itself down once no client is registered anymore — see the spec for the
exact mechanism.

## Configuration

Everything is optional; sane defaults apply. Environment variables, read
once at startup by both the daemon and the client wrapper:

| Variable | Default | Meaning |
|---|---|---|
| `HARBORAGE_HOST` | `127.0.0.1` | Loopback-only bind for the daemon's HTTP endpoint. |
| `HARBORAGE_PORT` | `4599` | Daemon's MCP-over-HTTP port. |
| `HARBORAGE_DEBUG_PORT` | `4600` | Chromium's `--remote-debugging-port`, for `escalate_session`. |
| `HARBORAGE_IDLE_TIMEOUT_MS` | `900000` (15m) | A session idle longer than this gets reaped. |
| `HARBORAGE_SWEEP_INTERVAL_MS` | `60000` (1m) | How often the daemon reaps idle sessions and prunes its client registry. |
| `HARBORAGE_SHUTDOWN_GRACE_MS` | `10000` | Minimum daemon uptime before an empty client registry is allowed to trigger self-shutdown. |
| `HARBORAGE_STATE_DIR` | `~/.harborage` | Registry file + daemon log live here. |
| `HARBORAGE_SCREENSHOT_CACHE_DIR` | `~/.harborage/screenshots` | Where `screenshot`'s `mode: 'cached'` writes PNGs. |
| `HARBORAGE_SCREENSHOT_CACHE_TTL_MS` | `1800000` (30m) | A cached screenshot older than this (by file mtime) gets deleted by the same sweep that reaps idle sessions. |
| `HARBORAGE_CONSOLE_BUFFER_SIZE` | `200` | Max buffered `console` messages kept per session tab (oldest dropped first). |
| `HARBORAGE_NETWORK_BUFFER_SIZE` | `200` | Max buffered network request/response entries kept per session tab (oldest dropped first). |

## Development

```sh
npm run build       # tsc -> dist/
npm run typecheck   # strict type-check of src/ and test/
npm test            # builds, then runs the full test suite (real Chromium, no mocks)
```

## License

MIT, see [LICENSE](LICENSE).
