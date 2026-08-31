import assert from 'node:assert/strict';
import { test } from 'node:test';

import { getProcessStartTime } from '../src/shared/processInfo.js';
import { pruneDead } from '../src/shared/registry.js';
import { spawnInertProcess } from './helpers.js';

test('pruneDead keeps a live entry whose recorded startedAt matches reality', async () => {
  const proc = spawnInertProcess();
  try {
    const startedAt = await getProcessStartTime(proc.pid);
    assert.ok(startedAt, 'expected to read a start time for a process we just spawned');

    const { kept, dropped } = await pruneDead([{ pid: proc.pid, startedAt: startedAt! }]);
    assert.equal(dropped.length, 0);
    assert.equal(kept.length, 1);
    assert.equal(kept[0]!.pid, proc.pid);
  } finally {
    proc.kill();
    await proc.exited;
  }
});

test('pruneDead drops an entry whose PID no longer exists', async () => {
  const proc = spawnInertProcess();
  const startedAt = await getProcessStartTime(proc.pid);
  assert.ok(startedAt);
  const pid = proc.pid;
  proc.kill();
  await proc.exited;

  // Give the OS a moment to fully reap the process table entry.
  await new Promise(resolve => setTimeout(resolve, 100));

  const { kept, dropped } = await pruneDead([{ pid, startedAt: startedAt! }]);
  assert.equal(kept.length, 0);
  assert.equal(dropped.length, 1);
});

test('pruneDead drops a live PID whose recorded startedAt does not match: the PID-reuse guard', async () => {
  const proc = spawnInertProcess();
  try {
    // A real, live PID, but a startedAt that does not match this process's
    // actual start time, simulating "a different process now holds this
    // PID than the one that registered it".
    const bogusStartedAt = 'Thu Jan  1 00:00:00 1970';
    const { kept, dropped } = await pruneDead([{ pid: proc.pid, startedAt: bogusStartedAt }]);
    assert.equal(kept.length, 0, 'a live PID with a mismatched startedAt must NOT be kept');
    assert.equal(dropped.length, 1);
    assert.equal(dropped[0]!.pid, proc.pid);
  } finally {
    proc.kill();
    await proc.exited;
  }
});

test('pruneDead handles a mix of entries independently', async () => {
  const live = spawnInertProcess();
  try {
    const liveStartedAt = await getProcessStartTime(live.pid);
    const dead = spawnInertProcess();
    const deadStartedAt = await getProcessStartTime(dead.pid);
    dead.kill();
    await dead.exited;
    await new Promise(resolve => setTimeout(resolve, 100));

    const { kept, dropped } = await pruneDead([
      { pid: live.pid, startedAt: liveStartedAt! },
      { pid: dead.pid, startedAt: deadStartedAt! },
      { pid: live.pid, startedAt: 'not-the-real-start-time' }
    ]);

    assert.equal(kept.length, 1);
    assert.equal(kept[0]!.pid, live.pid);
    assert.equal(dropped.length, 2);
  } finally {
    live.kill();
    await live.exited;
  }
});
