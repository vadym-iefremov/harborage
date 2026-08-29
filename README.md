# harborage

A shared, on-demand pool of isolated headless browser sessions for
Claude Code subagents, built on [Steel](https://github.com/steel-dev/steel-browser)
(self-hosted, unmodified) and its official MCP server.

Run several browser-driving subagents in parallel without them fighting
over the same tab, without a visible window flickering on screen, and
without duplicating a browser MCP server per project. See
[`docs/superpowers/specs/2026-08-29-harborage-design.md`](docs/superpowers/specs/2026-08-29-harborage-design.md)
for the full design and rationale.

**Status:** design complete, implementation in progress. Not usable yet.

## Requirements

- [Docker](https://www.docker.com/) installed and running.
- Node.js.

## License

MIT, see [LICENSE](LICENSE). Steel itself is Apache 2.0, this repo only
wraps it as an unmodified upstream dependency and doesn't redistribute
its source.
