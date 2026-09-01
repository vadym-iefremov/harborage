# Contributing to harborage

Bug reports, questions and pull requests are all welcome. This file covers
how the project is laid out, the one rule every tool has to follow, and what
a change needs before it is ready to merge.

## Getting set up

```sh
git clone https://github.com/vadym-iefremov/harborage.git
cd harborage
npm install                       # also builds dist/ via the `prepare` script
npx playwright install chromium   # first time only
npm test                          # 346 tests against real Chromium, ~15s
```

If `npm test` passes, your environment is good.

### Working without disturbing a running daemon

harborage is a shared daemon, so a session of Claude Code somewhere on your
machine may be using the one you are about to restart. Run your development
instance on its own port, debug port and state directory:

```sh
HARBORAGE_PORT=4699 \
HARBORAGE_DEBUG_PORT=4700 \
HARBORAGE_STATE_DIR=/tmp/harborage-dev \
npm run daemon
```

All three have to change together. Sharing a state directory across two
instances means sharing a registry file, and they will fight over it.

## How the code is laid out

| Path | What lives there |
|---|---|
| `src/daemon/` | The real implementation. Owns the single Chromium process, the sessions, and every tool handler. |
| `src/daemon/tools/defs/` | One module per tool category. A tool's description, input schema and handler all live together here. |
| `src/daemon/tools/schemas.ts` | Composes the `defs/` modules into one table. It does nothing else. |
| `src/client/` | The stdio wrapper each project talks to. Registers pass-through tools and forwards calls to the daemon over HTTP. |
| `src/shared/` | Config, the client registry, the logger, process helpers. Imported by both sides. |
| `test/` | The suite. One file per concern, real Chromium throughout. |

The daemon and the client wrapper both drive their tool registration from the
same `toolDefs` table, so the two cannot silently drift apart. That is why
adding a tool means adding one entry to one `defs/` module and nothing else.

## The rule for every tool: report what actually happened

This is the project's whole reason for existing, so it is not negotiable.

The most damaging thing a browser tool can do to an AI agent is succeed
quietly while doing nothing. The agent's job is telling truth from
appearance, and a success payload identical to a real one hands it
appearance. A human sees a screenshot and notices. An agent reads your JSON
and believes it.

Concretely, a new tool must:

- **Read state back after changing it.** Do not report the value you were
  asked to set. Report the value that is now actually there.
- **Say so when it cannot do what was asked**, rather than returning a bare
  success. An empty selector match, a rule that matched nothing, a permission
  the browser refused.
- **Flag doing something subtly different from what was asked.** A
  same-document navigation is not a page load. A drag the browser turned into
  a text selection is not a drag. Name the difference in the result.

If a reviewer can write a scenario where your tool returns success while the
page is untouched, the tool is not finished.

### Descriptions are the agent's only documentation

An agent never reads this repository. The `description` string and the Zod
`.describe()` on each field are the entire manual it gets. Write them for a
reader who cannot see your code and cannot experiment cheaply: name the
failure that is easy to hit, say what a parameter is matched against, and
spell out what is mutually exclusive with what. The existing definitions in
`defs/network.ts` are a good model.

### Tools that drive the mouse or keyboard

A session has one virtual mouse and one virtual keyboard. Two tools using
them at once interleave their presses and both report success while
corrupting each other. If your tool moves, clicks, drags, types or presses,
set `serializesInput: true` on the definition. `invokeTool` then serializes
it per session. Everything else, including reads and `evaluate`, keeps
running fully in parallel, and there is a test asserting exactly that, so the
lock cannot quietly widen into serializing whole sessions.

## Tests

```sh
npm run typecheck   # strict, covers src/ and test/
npm test            # builds first, then runs everything
```

There are no mocks of the browser or the protocol layer, deliberately. The
bugs this project cares about are exactly the ones a mock would hide, so
tests run against real Chromium and real daemon and wrapper subprocesses.

A new tool needs at least:

1. A test that it does the thing.
2. **A test that it reports failure when it cannot do the thing.** This is
   the one that matters. Point it at a selector that does not match, a rule
   that intercepts nothing, an element that is covered, and assert the result
   says so rather than returning success.

For a bug fix, write the test that fails first, then fix it. Several tests in
the suite exist because a QA agent recorded a false pass, and each one is
named after the lie it caught.

### Anything a test spawns must be able to clean up after itself

The suite starts real OS processes: daemons, browsers, and inert stand-in
clients. Spawn them through `spawnDaemonProcess` and `spawnInertProcess` in
`test/helpers.ts` and nothing else. Those helpers track what they start and
kill it from a `process.on('exit')` handler, so cleanup no longer depends on
an `after()` hook that a thrown assertion may never reach.

That is not a hypothetical. Two fixtures once sat between a spawn and a kill
with load-sensitive health checks in between. On a loaded machine those checks
lost, the kill was skipped, and the surviving child's handle held its test
file's event loop open: the file never exited, the runner waited on it, and
`npm test` never returned. Two runs on one machine reached fifty-five minutes
at 0% CPU that way, and ten pinned processes plus six orphaned fixtures were
alive at once, on a laptop that overheated twice.

Three things now stop that, and each covers a case the others cannot:

- **The helpers track and kill what they spawn**, so a skipped `kill()` costs
  nothing.
- **The inert fixture watches its own parent** and exits when it is gone. This
  is the only one that survives the parent being SIGKILLed, where no cleanup
  code in the parent runs at all.
- **`--test-force-exit` and `--test-timeout` in the `test` script.**
  `--test-timeout` bounds a test that never returns; `--test-force-exit`
  bounds a run whose tests have all finished but whose event loop will not
  drain, which no timeout can catch because at that point no test is running.
  Do not remove either. `test/self-reaping.test.ts` fails if you do.

If a test genuinely needs a daemon to outlive it, say so explicitly with
`HARBORAGE_OWNER_PID: ''`, rather than by not cleaning up.

### Before removing a git worktree, check nothing is running inside it

This has already gone wrong once here: two worktrees were deleted while test
suites were still running inside them, which left those runs unrecoverable and
their processes stranded. `git worktree list` does not tell you this, and
neither does the branch being merged.

```sh
lsof -a -d cwd -- "$WORKTREE" 2>/dev/null   # anything whose working directory is in there
pgrep -fl "$WORKTREE"                       # anything launched from a path inside it
```

Only remove the worktree if both come back empty. Never kill what they find in
order to clear the way, and never use a broad `pkill`: those are somebody
else's running tests.

## Pull requests

- Branch from `main`.
- Keep a pull request to one concern. A tool fix and a lifecycle change are
  two pull requests.
- Run `npm run typecheck` and `npm test` before pushing. CI runs both, but
  the local loop is 15 seconds and the CI loop is not.
- Say in the description what would have gone wrong without the change. If it
  fixes a silent failure, describe the failure.

### Commit messages

The history uses a short imperative subject line and a body that explains the
reasoning, not the diff. Say what was broken, why the fix is shaped the way
it is, and what you deliberately did not do. `git log` in this repository is
the reference. Long bodies are welcome, and future readers of a subtle
concurrency fix will thank you for one.

## Reporting a bug

The daemon log is almost always the answer, so include it. It lives at
`~/.harborage/daemon.log` and carries one structured line per event: daemon
start and stop, session create, release and reap with ids and remaining
counts, and every shutdown decision including the ones that decline.

A good report has the tool call you made, the result you got back, what you
expected instead, and the relevant window of that log.

## Licence

By contributing, you agree that your contributions are licensed under the
[MIT Licence](LICENSE) that covers the project.
