import { test } from 'node:test';

import { spawnInertProcess } from '../helpers.js';

/**
 * Not part of the suite: it lives under `test/fixtures/` so the `test/*.test.ts`
 * glob cannot reach it, and it is run deliberately, as a subprocess, by
 * `self-reaping.test.ts`.
 *
 * It reproduces the exact shape of the failure this round fixes. A test spawns
 * an inert fixture through the real helper, and then an assertion fails before
 * the line that would have killed it. That is not hypothetical: two fixtures in
 * registry-and-shutdown.test.ts sat between a spawn and a kill with
 * load-sensitive health checks in between, and on a loaded machine those checks
 * lost.
 *
 * What used to happen next is the part worth testing. The un-killed child's
 * handle held this file's event loop open, so the file never exited; the runner
 * waited on the file forever, so the run never finished; and when someone
 * eventually killed the run by hand, the file and its fixture both reparented
 * to PID 1 and stayed there.
 */
test('leaks a fixture, exactly as a failing assertion would', () => {
  const fixture = spawnInertProcess();
  process.stdout.write(`FIXTURE_PID ${fixture.pid}\n`);
  throw new Error('deliberate failure, standing in for a load-induced assertion failure');
});
