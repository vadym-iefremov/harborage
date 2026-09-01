import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { after, test } from 'node:test';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

import { cliEntry, cleanupTempDirs, daemonHealth, makeTestConfig, waitFor, wrapperEnv } from './helpers.js';
import { readRegistry } from '../src/shared/registry.js';
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

test('the wrapper puts itself in the client registry before it asks whether a daemon is even up', async () => {
  // The daemon takes three seconds to open its listener, so "the registry
  // already names this wrapper while nothing is answering /health yet" is a
  // state that can only exist if registration genuinely runs first.
  const config = await makeTestConfig({
    sweepIntervalMs: 60_000,
    shutdownGraceMs: 60_000,
    testStartupDelayMs: 3000,
    daemonReadyTimeoutMs: 20_000,
    daemonHealthPollMs: 50
  });
  configs.push(config);

  await connectWrapper(config, 'wrapper-registers-first-test');

  // Ordering, sampled rather than assumed: each pass reads both facts, and
  // the test only passes on a pass that sees a registered wrapper with no
  // daemon behind it. The moment a daemon answers, the window is over and
  // the ordering was the wrong way round.
  //
  // This is the race that made handshake-not-blocked flake. Registering after
  // ensureDaemonRunning meant the wrapper forked `ps` for its own start time
  // and wrote the registry file only once the daemon was already up and
  // already sweeping, so a daemon whose registry was still empty at its first
  // sweep exited underneath the wrapper connecting to it, and the wrapper's
  // first tool call came back as a bare "fetch failed".
  let registeredBeforeDaemonWasUp = false;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const registered = (await readRegistry(config.registryPath)).length > 0;
    const health = await daemonHealth(config);
    if (registered && health === null) {
      registeredBeforeDaemonWasUp = true;
      break;
    }
    if (health !== null) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(
    registeredBeforeDaemonWasUp,
    'the wrapper must be in the registry before any daemon answers /health; registering afterwards leaves a window ' +
      'in which the daemon sees an empty registry and shuts down under a client that is connecting to it'
  );

  // And the ordering did not cost the connection: the daemon still comes up
  // and the wrapper still talks to it.
  await waitFor(async () => (await daemonHealth(config)) !== null, {
    timeoutMs: 20_000,
    message: 'the daemon this wrapper spawned should still have come up'
  });
  const client = clients.at(-1)!;
  const listed = await client.callTool({ name: 'list_sessions', arguments: {} });
  assert.ok(!listed.isError, `expected a working connection after registering first: ${JSON.stringify(listed)}`);
});

test('a daemon that answers /health but drops the MCP handshake gives guidance, not a bare "fetch failed"', async () => {
  const config = await makeTestConfig({ sweepIntervalMs: 60_000, shutdownGraceMs: 60_000 });

  // Deliberately NOT pushed onto `configs`: nothing real is listening here,
  // so the after hook must not try to SIGTERM whatever pid /health reports.
  //
  // This stands in for the narrow race no ordering can close: the daemon was
  // genuinely healthy when ensureDaemonRunning asked, and had gone by the
  // time the handshake reached it. Destroying the socket is what a daemon
  // exiting mid-handshake does to the connection, and it is what produced the
  // ECONNRESET behind the `fetch failed` that made live-session-shutdown
  // flake.
  const server = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', pid: 0, uptimeMs: 0 }));
      return;
    }
    req.socket.destroy();
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(config.port, config.host, resolve));

  const client = await connectWrapper(config, 'wrapper-connect-failure-test');
  const result = await client.callTool({ name: 'list_sessions', arguments: {} });

  assert.ok(result.isError, `expected an error when the handshake cannot complete: ${JSON.stringify(result)}`);
  const message = JSON.stringify(result.content);
  // The whole point: the caller is told what failed and what to do about it,
  // rather than being handed undici's collapsed string with no way to tell a
  // dead daemon from a bug in their own call.
  assert.match(message, /Could not open a connection to the harborage daemon/, message);
  assert.match(message, /No tool call was sent/, message);
  assert.match(message, new RegExp(config.daemonLogPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), message);
  assert.notEqual(message, JSON.stringify([{ type: 'text', text: 'fetch failed' }]));
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
