import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { after, test } from 'node:test';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

import { cliEntry, cleanupTempDirs, daemonHealth, makeTestConfig, waitFor, wrapperEnv } from './helpers.js';
import type { Config } from '../src/shared/config.js';

const clients: Client[] = [];
const servers: Server[] = [];
const configs: Config[] = [];

/**
 * These tests deliberately give their daemons a long sweep interval, so that
 * a daemon cannot shut itself down in the middle of a test about daemons
 * dying. That also means none of them would self-shutdown promptly on the
 * way out, so this hook ends them itself: leaving a stray daemon (and its
 * Chromium) behind per test run is exactly the property the project checks
 * for after every suite.
 */
after(async () => {
  // Clients first: closing one kills its wrapper, which deregisters itself.
  await Promise.all(clients.splice(0).map(c => c.close().catch(() => {})));
  for (const config of configs.splice(0)) {
    const health = await daemonHealth(config);
    if (!health) continue;
    try {
      process.kill(health.pid, 'SIGTERM');
    } catch {
      // Already gone, which is the outcome we wanted anyway.
    }
    await waitFor(async () => (await daemonHealth(config)) === null, { timeoutMs: 10_000 }).catch(() => {});
  }
  await Promise.all(
    servers.splice(0).map(s => new Promise<void>(resolve => s.close(() => resolve())))
  );
  cleanupTempDirs();
});

/** One isolated config per test, remembered so the `after` hook can end its daemon. */
async function testConfig(): Promise<Config> {
  // A long sweep interval keeps the daemon from self-shutting-down mid-test;
  // the after hook is what actually ends it.
  const config = await makeTestConfig({ sweepIntervalMs: 60_000, shutdownGraceMs: 60_000 });
  configs.push(config);
  return config;
}

/**
 * A wrapper process is the thing under test here, not a stand-in for one:
 * every one of these cases only reproduces through the real stdio wrapper,
 * because the bug being covered lives in how the wrapper memoizes its
 * connection to the daemon.
 */
async function connectWrapper(config: Config, name: string): Promise<Client> {
  const client = new Client({ name, version: '1.0.0' });
  clients.push(client);
  await client.connect(
    new StdioClientTransport({ command: process.execPath, args: [cliEntry], env: wrapperEnv(config) })
  );
  return client;
}

/** A page server that counts hits on `/hit`, so a test can prove work ran exactly once. */
async function startCountingServer(): Promise<{ url: string; hits: () => number }> {
  let hits = 0;
  const server = createServer((req, res) => {
    if (req.url === '/hit') {
      hits += 1;
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('hit');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><body><h1>counting server</h1></body></html>');
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { url: `http://127.0.0.1:${port}/`, hits: () => hits };
}

async function killDaemon(config: Config): Promise<number> {
  const health = await daemonHealth(config);
  assert.ok(health, 'expected a healthy daemon to kill');
  process.kill(health.pid, 'SIGKILL');
  await waitFor(async () => (await daemonHealth(config)) === null, {
    timeoutMs: 10_000,
    message: 'the daemon should have stopped answering /health after SIGKILL'
  });
  return health.pid;
}

test('a live wrapper recovers when its daemon is SIGKILLed: the next tool call respawns it and succeeds', async () => {
  const config = await testConfig();
  const client = await connectWrapper(config, 'wrapper-reconnect-test');

  const first = await client.callTool({ name: 'create_session', arguments: {} });
  assert.ok(!first.isError, `expected the first call to succeed: ${JSON.stringify(first)}`);

  const deadPid = await killDaemon(config);

  // Before the fix this returned {"text":"fetch failed"} forever, because the
  // wrapper kept its dead Client memoized and never re-ran ensureDaemonRunning.
  const afterKill = await client.callTool({ name: 'list_sessions', arguments: {} });
  assert.ok(
    !afterKill.isError,
    `expected the wrapper to respawn the daemon and retry, got: ${JSON.stringify(afterKill)}`
  );

  const health = await daemonHealth(config);
  assert.ok(health, 'expected a fresh daemon to be healthy after the retry');
  assert.notEqual(health.pid, deadPid, 'expected a genuinely new daemon process, not the killed one');
});

test('after a daemon restart, a sessionId from before it died gives a clean session-not-found error, not a transport error', async () => {
  const config = await testConfig();
  const client = await connectWrapper(config, 'wrapper-stale-session-test');

  const created = await client.callTool({ name: 'create_session', arguments: {} });
  assert.ok(!created.isError, `expected create_session to succeed: ${JSON.stringify(created)}`);
  const { sessionId } = created.structuredContent as { sessionId: string };

  await killDaemon(config);

  // The Chromium that held this session died with the daemon, so the session
  // is genuinely gone. The point is that the caller is told THAT, rather than
  // being handed "fetch failed" with no way to tell the two apart.
  const stale = await client.callTool({ name: 'list_tabs', arguments: { sessionId } });
  assert.ok(stale.isError, `expected an error for a session that died with the daemon: ${JSON.stringify(stale)}`);
  const message = JSON.stringify(stale.content);
  assert.match(message, /No session with id/, `expected a session-not-found error, got: ${message}`);
  assert.doesNotMatch(message, /fetch failed/, 'a dead-daemon transport error must not leak to the caller');

  // And the connection is genuinely working again, not merely reporting a nicer error.
  const fresh = await client.callTool({ name: 'create_session', arguments: {} });
  assert.ok(!fresh.isError, `expected a new session on the respawned daemon: ${JSON.stringify(fresh)}`);
});

test('a tool that genuinely ran and failed is not retried: the work happens exactly once', async () => {
  const config = await testConfig();
  const client = await connectWrapper(config, 'wrapper-no-retry-test');
  const page = await startCountingServer();

  const created = await client.callTool({ name: 'create_session', arguments: {} });
  const { sessionId } = created.structuredContent as { sessionId: string };
  await client.callTool({ name: 'navigate', arguments: { sessionId, url: page.url } });

  const before = await daemonHealth(config);
  assert.ok(before);

  // Hits the server once, then throws. A retry would show up as a second hit.
  const failed = await client.callTool({
    name: 'evaluate',
    arguments: {
      sessionId,
      expression: 'fetch("/hit").then(() => { throw new Error("deliberate tool failure"); })'
    }
  });

  assert.ok(failed.isError, `expected the tool to report failure: ${JSON.stringify(failed)}`);
  assert.match(JSON.stringify(failed.content), /deliberate tool failure/);
  assert.equal(page.hits(), 1, 'a tool error that really ran must not be retried');

  const afterHealth = await daemonHealth(config);
  assert.ok(afterHealth);
  assert.equal(afterHealth.pid, before.pid, 'a tool error must not trigger a daemon respawn');

  await client.callTool({ name: 'release_session', arguments: { sessionId } });
});

test('concurrent calls that all hit the dead daemon share one reconnect, and spawn one daemon between them', async () => {
  const config = await testConfig();
  const client = await connectWrapper(config, 'wrapper-concurrent-reconnect-test');

  const warmup = await client.callTool({ name: 'list_sessions', arguments: {} });
  assert.ok(!warmup.isError, `expected the warmup call to succeed: ${JSON.stringify(warmup)}`);

  await killDaemon(config);

  const results = await Promise.all(
    Array.from({ length: 4 }, () => client.callTool({ name: 'list_sessions', arguments: {} }))
  );
  for (const result of results) {
    assert.ok(!result.isError, `every concurrent call should recover, got: ${JSON.stringify(result)}`);
  }

  // The daemon's own stderr lands in daemonLogPath. Exactly two daemons
  // should ever have started here: the original and the one replacement.
  // A second racing spawn would show up as a `daemon.port-in-use` line
  // (the EADDRINUSE loser), which is the wasteful outcome the single-flight
  // memoization exists to prevent.
  const log = await readFile(config.daemonLogPath, 'utf8');
  const starts = log.match(/daemon\.start\b/g) ?? [];
  assert.equal(starts.length, 2, `expected exactly two daemon starts, log was:\n${log}`);
  assert.doesNotMatch(log, /daemon\.port-in-use/, 'concurrent calls must not race to spawn several daemons');
});
