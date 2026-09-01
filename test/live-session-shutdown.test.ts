import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

import { BrowserManager } from '../src/daemon/browserManager.js';
import { SessionStore } from '../src/daemon/sessions.js';
import { runSweepOnce, type SweepDeps } from '../src/daemon/sweep.js';
import { createLogger, noopLogger, type Logger } from '../src/shared/logger.js';
import { getProcessStartTime } from '../src/shared/processInfo.js';
import { readRegistry, registerSelf } from '../src/shared/registry.js';
import {
  cleanupTempDirs,
  getFreePort,
  isDaemonHealthy,
  makeTestConfig,
  spawnDaemonProcess,
  spawnInertProcess,
  waitFor,
  type SpawnedProcess
} from './helpers.js';

let browserManager: BrowserManager;
let sessions: SessionStore;

const liveProcs: SpawnedProcess[] = [];
function track(p: SpawnedProcess): SpawnedProcess {
  liveProcs.push(p);
  return p;
}

before(async () => {
  browserManager = new BrowserManager(await getFreePort());
  sessions = new SessionStore(browserManager);
});

after(async () => {
  for (const p of liveProcs.splice(0)) p.kill();
  await sessions.closeAll();
  await browserManager.close();
  cleanupTempDirs();
});

interface SweepCall {
  outcome: Awaited<ReturnType<typeof runSweepOnce>>;
  shutdownCalls: number;
  lines: string[];
}

/** One sweep pass against the shared SessionStore, with an isolated registry file and a capturing logger. */
async function sweepOnce(overrides: Partial<SweepDeps> & { registryPath: string }): Promise<SweepCall> {
  let shutdownCalls = 0;
  const lines: string[] = [];
  const deps: SweepDeps = {
    sessions,
    idleTimeoutMs: 60_000,
    shutdownGraceMs: 0,
    // Well past any grace period, so the gate under test is the only thing deciding.
    daemonStartedAt: Date.now() - 60_000,
    screenshotCacheDir: `${overrides.registryPath}-screenshots`,
    screenshotCacheTtlMs: 60_000,
    logger: createLogger(line => lines.push(line)),
    onEmptyRegistryShutdown: async () => {
      shutdownCalls += 1;
    },
    ...overrides
  };
  const outcome = await runSweepOnce(deps);
  return { outcome, shutdownCalls, lines };
}

test('an empty client registry does NOT shut the daemon down while a session is still live', async () => {
  const config = await makeTestConfig();
  const { sessionId } = await sessions.createSession();

  const { outcome, shutdownCalls } = await sweepOnce({ registryPath: config.registryPath });

  assert.equal(outcome.remainingClients, 0, 'this test is only meaningful with an empty registry');
  assert.equal(outcome.liveSessions, 1);
  assert.equal(outcome.triggeredShutdown, false, 'a live session must veto the empty-registry shutdown');
  assert.equal(shutdownCalls, 0);

  // The session is not merely still listed: it still drives a real browser.
  await sessions.resolve(sessionId).page.goto('data:text/html,<h1 id="h">survived the sweep</h1>');
  assert.equal(await sessions.resolve(sessionId).page.textContent('#h'), 'survived the sweep');

  await sessions.releaseSession(sessionId);
});

test('an empty registry with zero live sessions still shuts the daemon down, exactly as before', async () => {
  const config = await makeTestConfig();
  await sessions.closeAll();

  const { outcome, shutdownCalls } = await sweepOnce({ registryPath: config.registryPath });

  assert.equal(outcome.liveSessions, 0);
  assert.equal(outcome.triggeredShutdown, true);
  assert.equal(shutdownCalls, 1);
});

test('a session reaped by the same sweep pass does not keep the daemon alive', async () => {
  const config = await makeTestConfig();
  await sessions.closeAll();
  const { sessionId } = await sessions.createSession();
  await new Promise(resolve => setTimeout(resolve, 40));

  // reapIdle runs before the shutdown gate inside runSweepOnce, so this
  // session is gone by the time the gate counts. Counting a session that
  // this very pass already closed would deadlock the daemon's shutdown.
  const { outcome, shutdownCalls } = await sweepOnce({ registryPath: config.registryPath, idleTimeoutMs: 20 });

  assert.deepEqual(outcome.reapedSessions, [sessionId]);
  assert.equal(outcome.liveSessions, 0);
  assert.equal(outcome.triggeredShutdown, true);
  assert.equal(shutdownCalls, 1);
});

test('the declined shutdown is logged with both counts, and is not logged at all while clients are registered', async () => {
  const config = await makeTestConfig();
  await sessions.closeAll();
  const { sessionId } = await sessions.createSession();

  const declined = await sweepOnce({ registryPath: config.registryPath });
  const declinedLines = declined.lines.filter(l => l.includes('sweep.shutdown-declined'));
  assert.equal(declinedLines.length, 1, `expected exactly one declined line, got: ${JSON.stringify(declined.lines)}`);
  assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /.test(declinedLines[0]!), declinedLines[0]);
  assert.ok(declinedLines[0]!.includes('reason=live-sessions'), declinedLines[0]);
  assert.ok(declinedLines[0]!.includes('clients=0'), declinedLines[0]);
  assert.ok(declinedLines[0]!.includes('sessions=1'), declinedLines[0]);

  // A registered client is the boring, every-minute case: logging a decline
  // for it every sweep would bury the interesting lines.
  const client = track(spawnInertProcess());
  const startedAt = await getProcessStartTime(client.pid);
  assert.ok(startedAt);
  await registerSelf(config.registryPath, client.pid, startedAt!);

  const quiet = await sweepOnce({ registryPath: config.registryPath });
  assert.equal(quiet.outcome.remainingClients, 1);
  assert.equal(quiet.outcome.triggeredShutdown, false);
  assert.deepEqual(quiet.lines.filter(l => l.includes('sweep.shutdown-declined')), []);

  client.kill();
  await client.exited;
  await sessions.releaseSession(sessionId);
});

test('killing the last registered client wrapper mid-flight leaves the daemon and its live session intact', async () => {
  const config = await makeTestConfig({ sweepIntervalMs: 150, shutdownGraceMs: 100, idleTimeoutMs: 60_000 });

  // A registered client wrapper, in the same order the real wrapper does it:
  // into the registry FIRST, before anything asks whether a daemon is up.
  // That ordering is the production fix for this exact race (see
  // registerInDaemonRegistry in src/client/wrapper.ts), not a convenience
  // here. Registering only after the daemon was healthy left this setup
  // racing the daemon's own 150ms sweep, which exits on an empty registry
  // with no live session: spawning the stand-in process and forking `ps` for
  // its start time had to finish inside that window, and on a loaded machine
  // it sometimes did not. The daemon then exited at `sweep.shutdown
  // reason=registry-empty clients=0 sessions=0 uptimeMs=170` and the connect
  // below failed with `fetch failed` (cause: ECONNRESET). Nothing about the
  // property under test moves: the daemon still meets a registry holding
  // exactly one live wrapper, which is what the kill below then empties.
  const wrapper = track(spawnInertProcess());
  const startedAt = await getProcessStartTime(wrapper.pid);
  assert.ok(startedAt);
  await registerSelf(config.registryPath, wrapper.pid, startedAt!);

  const daemon = track(spawnDaemonProcess(config));
  await waitFor(() => isDaemonHealthy(config), { timeoutMs: 20_000, message: 'daemon never became healthy' });

  const client = new Client({ name: 'live-session-shutdown-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://${config.host}:${config.port}/mcp`)));

  const created = await client.callTool({ name: 'create_session', arguments: {} });
  assert.ok(!created.isError, JSON.stringify(created));
  const { sessionId } = created.structuredContent as { sessionId: string };
  await client.callTool({
    name: 'navigate',
    arguments: { sessionId, url: 'data:text/html,<h1 id="h">before the kill</h1>' }
  });

  // The wrapper dies without deregistering, the way a SIGKILLed or crashed
  // Claude Code session does. The registry empties on the next sweep while
  // this session is still mid-work.
  wrapper.kill();
  await wrapper.exited;

  await waitFor(async () => (await readRegistry(config.registryPath)).length === 0, {
    timeoutMs: 10_000,
    message: 'the dead wrapper should have been pruned from the registry'
  });
  // Several more sweeps pass with a provably empty registry.
  await new Promise(resolve => setTimeout(resolve, 900));

  assert.equal(await isDaemonHealthy(config), true, 'the daemon must not exit while a session is still live');

  const after = await client.callTool({
    name: 'navigate',
    arguments: { sessionId, url: 'data:text/html,<h1 id="h">after the kill</h1>' }
  });
  assert.ok(!after.isError, `the surviving session must still be usable: ${JSON.stringify(after)}`);
  const evaluated = await client.callTool({
    name: 'evaluate',
    arguments: { sessionId, expression: "document.querySelector('#h').textContent" }
  });
  assert.equal((evaluated.structuredContent as { result: string }).result, 'after the kill');

  const daemonLog = daemon.stderrText();
  assert.ok(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[harborage] daemon\.start /m.test(daemonLog),
    `expected a timestamped daemon.start line in:\n${daemonLog}`
  );
  assert.ok(
    /\[harborage] sweep\.shutdown-declined reason=live-sessions clients=0 sessions=1/.test(daemonLog),
    `expected the declined shutdown decision to be visible in the log:\n${daemonLog}`
  );

  // Releasing the last session lets the daemon do what it was always meant
  // to do once nothing is left: shut itself down.
  await client.callTool({ name: 'release_session', arguments: { sessionId } });
  await client.close();

  await waitFor(async () => !(await isDaemonHealthy(config)), {
    timeoutMs: 15_000,
    message: 'the daemon should shut down once the registry is empty AND no sessions remain'
  });
  assert.equal(await daemon.exited, 0);

  const finalLog = daemon.stderrText();
  assert.ok(
    /\[harborage] session\.release sessionId=/.test(finalLog),
    `expected a session.release line in:\n${finalLog}`
  );
  assert.ok(
    /\[harborage] daemon\.shutdown reason=[^\s]+ clients=0 sessions=0/.test(finalLog),
    `expected a shutdown line carrying the reason and both counts in:\n${finalLog}`
  );
});
