import assert from 'node:assert/strict';
import { test } from 'node:test';

import { getProcessStartTime, probeProcess } from '../src/shared/processInfo.js';
import { pruneDead } from '../src/shared/registry.js';
import { spawnInertProcess } from './helpers.js';

/**
 * Runs `body` with `ps` unreachable, by pointing PATH at a directory that
 * does not contain it.
 *
 * This is the deterministic stand-in for fork starvation. The real trigger is
 * `EAGAIN` when the machine is at its process limit, which cannot be summoned
 * on demand without putting the machine there; what matters to the code under
 * test is identical either way, namely that the spawn fails with a STRING
 * errno rather than `ps` running and answering with a numeric exit status.
 * node:test gives each test file its own process, and this restores PATH
 * regardless, so nothing leaks past the call.
 */
async function withPsUnreachable<T>(body: () => Promise<T>): Promise<T> {
  const previous = process.env.PATH;
  process.env.PATH = '/nonexistent-harborage-test-path';
  try {
    return await body();
  } finally {
    process.env.PATH = previous;
  }
}

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

test('probeProcess tells "the PID is gone" apart from "ps could not answer"', async () => {
  const proc = spawnInertProcess();
  try {
    const alive = await probeProcess(proc.pid);
    assert.equal(alive.state, 'alive');

    // Same live PID, but nothing able to ask about it. The answer must be
    // "unknown", never "gone": the process is demonstrably still running.
    const unknown = await withPsUnreachable(() => probeProcess(proc.pid));
    assert.equal(unknown.state, 'unknown', JSON.stringify(unknown));
    assert.equal(unknown.state === 'unknown' && unknown.reason, 'ENOENT');
  } finally {
    proc.kill();
    await proc.exited;
  }

  // And a PID that really is gone still reads as gone, not as unknown, so
  // the distinction has not been bought by making everything unprovable.
  const dead = spawnInertProcess();
  const deadPid = dead.pid;
  dead.kill();
  await dead.exited;
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal((await probeProcess(deadPid)).state, 'gone');
});

test('pruneDead keeps an entry it could not probe, instead of calling it dead', async () => {
  const proc = spawnInertProcess();
  try {
    const startedAt = await getProcessStartTime(proc.pid);
    assert.ok(startedAt);

    const { kept, dropped, unresolved } = await withPsUnreachable(() =>
      pruneDead([{ pid: proc.pid, startedAt: startedAt! }])
    );

    // The asymmetry that matters: keeping a dead entry costs one more sweep,
    // dropping a live one empties the registry and lets the daemon exit on
    // top of a client still using it.
    assert.equal(dropped.length, 0, 'an unprobeable entry must not be treated as proven dead');
    assert.equal(kept.length, 1);
    assert.equal(unresolved.length, 1, 'and it must be reported as kept-on-no-evidence, not as proven alive');
    assert.equal(unresolved[0]!.entry.pid, proc.pid);
    assert.equal(unresolved[0]!.reason, 'ENOENT');
  } finally {
    proc.kill();
    await proc.exited;
  }
});

test('a probe failure does not smuggle a reused PID back in: the guard still needs a real answer', async () => {
  const proc = spawnInertProcess();
  try {
    // A live PID whose recorded startedAt is wrong is a DIFFERENT process,
    // and must still be dropped when ps can answer. The unresolved path must
    // not become a way for a mismatched entry to survive.
    const { kept, dropped, unresolved } = await pruneDead([
      { pid: proc.pid, startedAt: 'Thu Jan  1 00:00:00 1970' }
    ]);
    assert.equal(kept.length, 0);
    assert.equal(dropped.length, 1);
    assert.equal(unresolved.length, 0);
  } finally {
    proc.kill();
    await proc.exited;
  }
});
