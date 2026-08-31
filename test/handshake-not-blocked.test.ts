import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

import { cliEntry, cleanupTempDirs, isDaemonHealthy, makeTestConfig, waitFor } from './helpers.js';

const clients: Client[] = [];

after(async () => {
  await Promise.all(clients.splice(0).map(c => c.close().catch(() => {})));
  cleanupTempDirs();
});

test('the client wrapper answers the MCP initialize handshake immediately, even with an artificially slow daemon cold start', async () => {
  const startupDelayMs = 3000;
  const config = await makeTestConfig({
    testStartupDelayMs: startupDelayMs,
    daemonReadyTimeoutMs: 20_000,
    daemonHealthPollMs: 100,
    // Fast enough that this test's own teardown (closing the wrapper, which
    // deregisters it) is followed quickly by the daemon it spawned noticing
    // an empty registry and shutting itself down. See the assertion below.
    sweepIntervalMs: 200,
    shutdownGraceMs: 100
  });

  const client = new Client({ name: 'handshake-timing-test', version: '1.0.0' });
  clients.push(client);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliEntry],
    env: {
      ...process.env,
      HARBORAGE_HOST: config.host,
      HARBORAGE_PORT: String(config.port),
      HARBORAGE_DEBUG_PORT: String(config.debugPort),
      HARBORAGE_STATE_DIR: config.stateDir,
      HARBORAGE_REGISTRY_PATH: config.registryPath,
      HARBORAGE_DAEMON_LOG_PATH: config.daemonLogPath,
      HARBORAGE_TEST_STARTUP_DELAY_MS: String(startupDelayMs),
      HARBORAGE_DAEMON_READY_TIMEOUT_MS: String(config.daemonReadyTimeoutMs),
      HARBORAGE_DAEMON_HEALTH_POLL_MS: String(config.daemonHealthPollMs),
      HARBORAGE_SWEEP_INTERVAL_MS: String(config.sweepIntervalMs),
      HARBORAGE_SHUTDOWN_GRACE_MS: String(config.shutdownGraceMs)
    }
  });

  const handshakeStart = Date.now();
  await client.connect(transport);
  const handshakeMs = Date.now() - handshakeStart;

  assert.ok(
    handshakeMs < startupDelayMs / 2,
    `expected the handshake to complete well before the ${startupDelayMs}ms artificial daemon delay; took ${handshakeMs}ms`
  );

  // The daemon is still cold-starting at this point. The FIRST real tool
  // call is where that cost should actually be paid.
  const firstCallStart = Date.now();
  const result = await client.callTool({ name: 'create_session', arguments: {} });
  const firstCallMs = Date.now() - firstCallStart;

  assert.ok(!result.isError, `expected create_session to eventually succeed once the daemon finished cold-starting: ${JSON.stringify(result)}`);
  assert.ok(
    firstCallMs >= startupDelayMs - 500,
    `expected the first tool call to have waited out most of the ${startupDelayMs}ms cold start; only took ${firstCallMs}ms`
  );

  // A second call, now that the daemon is warm, is fast.
  const secondCallStart = Date.now();
  const created = result.structuredContent as { sessionId: string };
  await client.callTool({ name: 'release_session', arguments: { sessionId: created.sessionId } });
  const secondCallMs = Date.now() - secondCallStart;
  assert.ok(secondCallMs < 2000, `expected a warmed-up call to be fast; took ${secondCallMs}ms`);

  // Closing the client kills the wrapper process (StdioClientTransport's
  // documented teardown), which deregisters itself on the way out; the
  // daemon it spawned should then notice the empty registry and shut
  // itself down on its own: a full real lifecycle, not just the direct
  // spawnDaemonProcess path covered in registry-and-shutdown.test.ts.
  await client.close();
  clients.length = 0;
  await waitFor(async () => !(await isDaemonHealthy(config)), {
    timeoutMs: 10_000,
    message: 'the daemon spawned by this wrapper should have shut itself down after the client disconnected'
  });
});
