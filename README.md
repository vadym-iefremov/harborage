# harborage

A shared, on-demand pool of isolated headless browser sessions for
Claude Code subagents, built directly on
[Playwright](https://playwright.dev/).

Run several browser-driving subagents in parallel without them fighting
over the same tab, without a visible window flickering on screen, and
without duplicating a browser MCP server per project.

**Status:** redesigning from scratch (an earlier design built on a
third-party self-hosted browser service turned out to hard-limit
self-hosted use to one session at a time, a dealbreaker for this
project's actual goal). New design in progress. Not usable yet.

## Requirements

- Node.js.

## License

MIT, see [LICENSE](LICENSE).
