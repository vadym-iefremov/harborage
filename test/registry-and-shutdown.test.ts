import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { getProcessStartTime } from '../src/shared/processInfo.js';
import { readRegistry, registerSelf } from '../src/shared/registry.js';
import { isDaemonHealthy, makeTestConfig, cleanupTempDirs, spawnDaemonProcess, spawnInertProcess, waitFor, type SpawnedProcess } from './helpers.js';

const liveProcs: SpawnedProcess[] = [];
function track(p: SpawnedProcess): SpawnedProcess {
  liveProcs.push(p);
  return p;
}

after(async () => {
  for (const p of liveProcs.splice(0)) {
    p.kill();
  }
  cleanupTempDirs();
});

test('a fresh daemon does NOT self-shut-down before its grace period, even with an empty registry', async () => {
  const config = await makeTestConfig({ sweepIntervalMs: 150, shutdownGraceMs: 3000 });
  const daemon = track(spawnDaemonProcess(config));

  await waitFor(() => isDaemonHealthy(config), { timeoutMs: 10_000, message: 'daemon never became healthy' });
  // Registry is empty from the moment it starts (nobody has registered).
  // Several sweeps fire well before the 3s grace period elapses.
  await new Promise(resolve => setTimeout(resolve, 800));
  assert.equal(await isDaemonHealthy(config), true, 'daemon should still be alive, the grace period has not elapsed');

  daemon.kill();
  await daemon.exited;
});

test('the daemon self-shuts-down once its client registry is (and stays) empty, past the grace period', async () => {
  const config = await makeTestConfig({ sweepIntervalMs: 150, shutdownGraceMs: 200 });
  const daemon = track(spawnDaemonProcess(config));

  await waitFor(() => isDaemonHealthy(config), { timeoutMs: 10_000, message: 'daemon never became healthy' });
  await waitFor(async () => !(await isDaemonHealthy(config)), {
    timeoutMs: 10_000,
    message: 'daemon should have self-shut-down once its (empty) registry outlived the grace period'
  });

  const exitCode = await daemon.exited;
  assert.equal(exitCode, 0);
});

test('a stale registry entry (dead PID) gets pruned, and the daemon shuts down once that empties it', async () => {
  const config = await makeTestConfig({ sweepIntervalMs: 150, shutdownGraceMs: 100 });

  // Register a client whose process is already dead before the daemon ever starts.
  const ghost = spawnInertProcess();
  const ghostStartedAt = await getProcessStartTime(ghost.pid);
  assert.ok(ghostStartedAt);
  ghost.kill();
  await ghost.exited;
  await registerSelf(config.registryPath, ghost.pid, ghostStartedAt!);

  const daemon = track(spawnDaemonProcess(config));
  await waitFor(() => isDaemonHealthy(config), { timeoutMs: 10_000 });

  await waitFor(async () => !(await isDaemonHealthy(config)), {
    timeoutMs: 10_000,
    message: 'daemon should have pruned the dead PID, found the registry empty, and shut down'
  });

  const finalRegistry = await readRegistry(config.registryPath);
  assert.deepEqual(finalRegistry, [], 'the stale entry should have been pruned from the registry file');
});

test('a live, correctly-registered client keeps the daemon alive; removing it lets the daemon shut down', async () => {
  const config = await makeTestConfig({ sweepIntervalMs: 150, shutdownGraceMs: 100 });

  // Registered before the daemon starts, which is the order the real wrapper
  // uses (see registerInDaemonRegistry in src/client/wrapper.ts) and the same
  // order the stale-entry test above already used. Registering after the
  // daemon was healthy meant this setup had to spawn a process and fork `ps`
  // inside the daemon's 150ms sweep interval, and losing that race exits the
  // daemon on an empty registry, which shows up here as the assertion below
  // failing for a reason that has nothing to do with what it is testing.
  const client = spawnInertProcess();
  const startedAt = await getProcessStartTime(client.pid);
  assert.ok(startedAt);
  await registerSelf(config.registryPath, client.pid, startedAt!);

  const daemon = track(spawnDaemonProcess(config));
  await waitFor(() => isDaemonHealthy(config), { timeoutMs: 10_000 });

  // Several sweeps pass while the client is alive and correctly registered.
  await new Promise(resolve => setTimeout(resolve, 700));
  assert.equal(await isDaemonHealthy(config), true, 'daemon should stay up while a live client is registered');

  client.kill();
  await client.exited;

  await waitFor(async () => !(await isDaemonHealthy(config)), {
    timeoutMs: 10_000,
    message: 'daemon should shut down once its only registered client has died'
  });
});
