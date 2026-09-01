import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { collectGcReport, reapOrphans } from '../src/client/gc.js';
import { recordOwnedProcess, readOwnedProcesses } from '../src/shared/ownedProcesses.js';
import { getProcessStartTime } from '../src/shared/processInfo.js';
import {
  cleanupTempDirs,
  isDaemonHealthy,
  killSpawnedProcesses,
  makeTestConfig,
  spawnDaemonProcess,
  spawnInertProcess,
  waitFor
} from './helpers.js';

/**
 * gc is the one piece of this codebase that deliberately kills processes it
 * did not spawn in this process, on a machine that also carries the
 * developer's real work and several other agents. So the tests that matter
 * most here are the ones proving what it does NOT touch. Over-reaping is a
 * far worse outcome than the leak gc exists to clean up: an earlier round of
 * this project killed the shared daemon out from under every other agent by
 * pattern-matching a command line.
 */

after(() => {
  killSpawnedProcesses();
  cleanupTempDirs();
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('gc reports an orphan: a recorded process whose owning daemon is gone', async () => {
  const config = await makeTestConfig();

  // A dead "daemon", and a live process it is recorded as having started.
  const deadOwner = spawnInertProcess();
  const deadOwnerStartedAt = await getProcessStartTime(deadOwner.pid);
  assert.ok(deadOwnerStartedAt);
  deadOwner.kill();
  await deadOwner.exited;

  const stranded = spawnInertProcess();
  const strandedStartedAt = await getProcessStartTime(stranded.pid);
  assert.ok(strandedStartedAt);
  await recordOwnedProcess(config.ownedProcessesPath, {
    kind: 'browser',
    pid: stranded.pid,
    startedAt: strandedStartedAt!,
    ownerPid: deadOwner.pid,
    ownerStartedAt: deadOwnerStartedAt!,
    recordedAt: Date.now()
  });

  const report = await collectGcReport(config);
  const finding = report.findings.find(f => f.pid === stranded.pid);
  assert.ok(finding, 'gc should have found the stranded process');
  assert.equal(finding!.verdict, 'orphan');

  // The report alone must change nothing.
  assert.equal(alive(stranded.pid), true, 'a report-only run must not kill anything');

  const reaped = await reapOrphans(config, report);
  assert.ok(reaped.killed!.includes(stranded.pid), 'gc --kill should have signalled the orphan');
  assert.deepEqual(reaped.survivedKill, [], 'nothing gc signalled should still be alive');
  // Verified against the OS, not against what gc believes it did. A previous
  // attempt at this cleanup by hand reported three processes dead while they
  // were still spinning at full CPU, because its pattern silently matched
  // nothing and its verification used the same broken pattern.
  assert.equal(alive(stranded.pid), false, 'the orphan should actually be gone');

  const remaining = await readOwnedProcesses(config.ownedProcessesPath);
  assert.equal(remaining.length, 0, 'the reaped entry should be dropped from the ledger');
});

test('gc leaves a recorded process alone while the daemon that owns it is alive', async () => {
  const config = await makeTestConfig();

  const liveOwner = spawnInertProcess();
  const liveOwnerStartedAt = await getProcessStartTime(liveOwner.pid);
  const owned = spawnInertProcess();
  const ownedStartedAt = await getProcessStartTime(owned.pid);
  assert.ok(liveOwnerStartedAt && ownedStartedAt);

  await recordOwnedProcess(config.ownedProcessesPath, {
    kind: 'browser',
    pid: owned.pid,
    startedAt: ownedStartedAt!,
    ownerPid: liveOwner.pid,
    ownerStartedAt: liveOwnerStartedAt!,
    recordedAt: Date.now()
  });

  const report = await collectGcReport(config);
  const finding = report.findings.find(f => f.pid === owned.pid);
  assert.equal(finding!.verdict, 'owned-and-live');

  const reaped = await reapOrphans(config, report);
  assert.deepEqual(reaped.killed, [], 'gc --kill must not touch a process whose owner is still running');
  assert.equal(alive(owned.pid), true);
  assert.equal(alive(liveOwner.pid), true);
});

test('gc will not kill a live PID whose recorded start time no longer matches: the PID-reuse guard', async () => {
  // The scenario that makes an unguarded cleanup tool dangerous. A daemon
  // recorded pid N, that daemon and its browser both died, and the OS has
  // since handed pid N to something else entirely, quite possibly the
  // developer's own work. The recorded start time is what tells the two
  // apart, and gc must believe it over the bare PID.
  const config = await makeTestConfig();

  const deadOwner = spawnInertProcess();
  const deadOwnerStartedAt = await getProcessStartTime(deadOwner.pid);
  assert.ok(deadOwnerStartedAt);
  deadOwner.kill();
  await deadOwner.exited;

  const innocent = spawnInertProcess();
  await recordOwnedProcess(config.ownedProcessesPath, {
    kind: 'browser',
    pid: innocent.pid,
    // A real, live PID with a start time that is not this process's. Exactly
    // what a recycled PID looks like from the ledger's point of view.
    startedAt: 'Thu Jan  1 00:00:00 1970',
    ownerPid: deadOwner.pid,
    ownerStartedAt: deadOwnerStartedAt!,
    recordedAt: Date.now()
  });

  const report = await collectGcReport(config);
  assert.equal(
    report.findings.some(f => f.pid === innocent.pid),
    false,
    'a live PID whose recorded start time does not match must never be reported as harborage\'s'
  );
  assert.equal(report.staleLedgerEntries, 1, 'it should be counted as a stale ledger entry instead');

  const reaped = await reapOrphans(config, report);
  assert.deepEqual(reaped.killed, [], 'gc --kill must signal nothing here');
  assert.equal(alive(innocent.pid), true, 'the unrelated process holding the recycled PID must be untouched');

  innocent.kill();
  await innocent.exited;
});

test('gc never reaps a daemon that is answering /health', async () => {
  // The failure this guards against is the one that already happened once in
  // this project: a cleanup that took down the shared daemon every other agent
  // on the machine was using.
  const owner = spawnInertProcess();
  const config = await makeTestConfig({ sweepIntervalMs: 60_000, shutdownGraceMs: 60_000 });
  const daemon = spawnDaemonProcess(config, { HARBORAGE_OWNER_PID: String(owner.pid) });
  await waitFor(() => isDaemonHealthy(config), { timeoutMs: 30_000, message: 'daemon never became healthy' });

  await waitFor(async () => (await readOwnedProcesses(config.ownedProcessesPath)).some(e => e.kind === 'daemon'), {
    timeoutMs: 15_000,
    message: 'the daemon should have recorded itself'
  });

  const report = await collectGcReport(config);
  const finding = report.findings.find(f => f.pid === daemon.pid);
  assert.ok(finding, 'gc should see the running daemon');
  assert.equal(finding!.verdict, 'serving');
  assert.equal(report.daemonHealthy, true);

  const reaped = await reapOrphans(config, report);
  assert.deepEqual(reaped.killed, [], 'gc --kill must not signal a daemon that is serving requests');
  assert.equal(alive(daemon.pid), true, 'the serving daemon must still be running');
  assert.equal(await isDaemonHealthy(config), true, 'and must still be answering');

  daemon.kill();
  owner.kill();
});

test('gc finds nothing to do on a clean state directory', async () => {
  const config = await makeTestConfig();
  const report = await collectGcReport(config);
  assert.deepEqual(report.findings, []);
  assert.equal(report.staleLedgerEntries, 0);
  assert.equal(report.liveClients, 0);
  assert.equal(report.daemonHealthy, false);
});
