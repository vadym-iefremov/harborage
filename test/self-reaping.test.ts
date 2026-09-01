import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { join } from 'node:path';

import { readOwnedProcesses } from '../src/shared/ownedProcesses.js';
import { getProcessStartTime, listDescendantPids } from '../src/shared/processInfo.js';
import {
  cleanupTempDirs,
  inertFixtureParentEnvVar,
  inertFixtureProgram,
  isDaemonHealthy,
  killSpawnedProcesses,
  makeTestConfig,
  repoRoot,
  spawnDaemonProcess,
  spawnInertProcess,
  waitFor
} from './helpers.js';

/**
 * These tests are about processes outliving the thing that made them, so all
 * of them assert against the live process table rather than against a return
 * value. That is deliberate. Two earlier rounds of this project shipped fixes
 * that passed tests asserting a function returned the string the author
 * expected, and shipped the exact failure the fix was written to prevent. The
 * only oracle worth anything here is "is this PID still alive", asked of the
 * OS.
 */

after(async () => {
  killSpawnedProcesses();
  cleanupTempDirs();
});

/** Whether a PID is alive right now. Signal 0 checks for existence without delivering anything. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForDeath(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await sleep(100);
  }
  return !alive(pid);
}

test('an inert fixture exits by itself when its parent is SIGKILLed', async () => {
  // A middleman, so the fixture's parent can be killed outright without
  // killing this test. SIGKILL specifically: it runs no handler in the
  // parent at all, which is exactly the case that no amount of cleanup code
  // in the parent could ever cover, and exactly how the leaked fixtures found
  // on the developer's machine came to have parent PID 1.
  const middleman = spawn(
    process.execPath,
    [
      '-e',
      "const { spawn } = require('node:child_process');" +
        `const child = spawn(process.execPath, ['-e', ${JSON.stringify(inertFixtureProgram)}], ` +
        `{ stdio: 'ignore', env: { ...process.env, ${JSON.stringify(inertFixtureParentEnvVar)}: String(process.pid) } });` +
        "process.stdout.write('PID ' + child.pid + '\\n');" +
        'setInterval(() => {}, 1000);'
    ],
    { stdio: ['ignore', 'pipe', 'ignore'] }
  );

  let fixturePid = 0;
  try {
    const pidLine = await new Promise<string>((resolve, reject) => {
      middleman.stdout!.setEncoding('utf8');
      middleman.stdout!.once('data', resolve);
      middleman.once('error', reject);
      setTimeout(() => reject(new Error('middleman never reported a fixture pid')), 10_000).unref();
    });
    fixturePid = Number(pidLine.trim().split(/\s+/)[1]);
    assert.ok(fixturePid > 0, `expected a fixture pid, got ${JSON.stringify(pidLine)}`);

    // Killed the instant the pid is known, without waiting for the fixture to
    // finish booting. This is the harder case and it is the one a first
    // version of the fixture failed: if the parent dies while Node is still
    // starting the child, a child that reads its own parent at startup reads
    // 1, and then compares 1 against 1 forever. The expected parent is handed
    // in through the environment for exactly this reason.
    process.kill(middleman.pid!, 'SIGKILL');

    assert.equal(
      await waitForDeath(fixturePid, 10_000),
      true,
      `fixture ${fixturePid} should have noticed it was orphaned and exited on its own`
    );
  } finally {
    // By explicit PID, both of them, whatever happened above.
    for (const pid of [fixturePid, middleman.pid ?? 0]) {
      if (pid > 0) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Already gone, which is the point.
        }
      }
    }
  }
});

test('a test run whose test file leaks a fixture still terminates, and leaves nothing behind', async () => {
  // The regression test for the actual failure. `leaks-a-fixture.test.ts`
  // spawns a fixture through the real helper and never kills it, which is what
  // a failed assertion between the spawn and the kill amounts to. Before this
  // round, the un-killed child's handle held its test file's event loop open,
  // the runner waited on that file forever, and `npm test` never returned. Two
  // sibling agents had runs wedged for over forty minutes on exactly this, and
  // ten pinned test-file processes plus six fixtures were alive at once.
  //
  // Two separate mechanisms have to hold for this to pass, which is why the
  // assertion is at the level of a whole run rather than one process:
  // `--test-force-exit` (in the `test` script) ends a run whose event loop
  // will not drain, and the fixture's own orphan watch means that what the
  // forced exit strands does not survive.
  const script = join(repoRoot, 'test', 'fixtures', 'leaks-a-fixture.test.ts');
  const tsx = join(repoRoot, 'node_modules', '.bin', 'tsx');
  // Exactly the flags the `test` script uses, because those flags are half of
  // what is being tested here.
  //
  // `NODE_TEST_CONTEXT` has to go. Node's test runner sets it in the
  // environment of every test file it runs, and a nested runner that sees it
  // believes it is itself a test-file child, switches to the internal
  // child-process reporter and writes nothing to stdout. Inheriting it made
  // this test fail with an empty capture while the thing it was testing was
  // working perfectly.
  const { NODE_TEST_CONTEXT: _nodeTestContext, ...env } = process.env;
  const runner = spawn(tsx, ['--test', '--test-force-exit', '--test-timeout=180000', script], {
    stdio: ['ignore', 'pipe', 'ignore'],
    env
  });

  let stdout = '';
  runner.stdout!.setEncoding('utf8');
  runner.stdout!.on('data', (chunk: string) => {
    stdout += chunk;
  });

  await new Promise<void>((resolve, reject) => {
    runner.once('exit', () => resolve());
    runner.once('error', reject);
    setTimeout(
      () => reject(new Error('the test run never terminated: a leaked fixture is still pinning a test file')),
      60_000
    ).unref();
  });

  const match = /FIXTURE_PID (\d+)/.exec(stdout);
  assert.ok(match, `expected a fixture pid on stdout, got ${JSON.stringify(stdout)}`);
  const fixturePid = Number(match[1]);

  assert.equal(
    await waitForDeath(fixturePid, 15_000),
    true,
    `fixture ${fixturePid} outlived the test run that leaked it`
  );
});

test('a daemon exits on its own once its owner dies, even holding a live browser session', async () => {
  // The other half of the same principle, applied to the daemon. A live
  // browser session rightly vetoes the registry-empty shutdown, which used to
  // mean a daemon whose test had died sat on a Chromium for the full
  // fifteen-minute idle timeout. An owner that is gone is different from an
  // empty registry: there is nobody left for that session to be work for.
  const owner = spawnInertProcess();
  const config = await makeTestConfig({ sweepIntervalMs: 200, shutdownGraceMs: 60_000, idleTimeoutMs: 15 * 60 * 1000 });
  const daemon = spawnDaemonProcess(config, { HARBORAGE_OWNER_PID: String(owner.pid) });

  await waitFor(() => isDaemonHealthy(config), { timeoutMs: 30_000, message: 'daemon never became healthy' });

  // A real session, so a real Chromium is running and really is vetoing the
  // ordinary shutdown path. Driven over the daemon's own MCP endpoint rather
  // than in-process, so this is the deployed code path.
  const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
  const client = new Client({ name: 'harborage-owner-watch-test', version: '0.2.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://${config.host}:${config.port}/mcp`)));
  await client.callTool({ name: 'create_session', arguments: {} }, { timeout: 120_000 });

  const browserPids = await listDescendantPids(daemon.pid);
  assert.ok(browserPids.length > 0, 'the daemon should have launched at least one browser process');

  // The shutdown grace period is a minute, so nothing but the owner watch can
  // possibly be what ends this daemon.
  owner.kill();
  await owner.exited;

  const exitCode = await Promise.race([
    daemon.exited,
    sleep(30_000).then(() => 'timed-out' as const)
  ]);
  assert.notEqual(exitCode, 'timed-out', 'the daemon should have noticed its owner was gone and exited');
  assert.equal(alive(daemon.pid), false, 'the daemon process should be gone');
  assert.match(daemon.stderrText(), /owner-gone/, 'the daemon should say why it shut down');

  for (const pid of browserPids) {
    assert.equal(
      await waitForDeath(pid, 15_000),
      true,
      `browser process ${pid} should have gone with the daemon, not been left behind`
    );
  }

  await client.close().catch(() => {
    // The daemon it was talking to is gone; closing is tidiness, not correctness.
  });
});

test('a SIGKILLed daemon takes every one of its browser processes with it', async () => {
  // Measured rather than assumed. The concern was that 56 headless Chromium
  // processes on the developer's machine meant browsers outliving their
  // daemons. They did not: this asserts the actual behaviour so a future
  // change to how the browser is launched cannot quietly break it.
  const owner = spawnInertProcess();
  const config = await makeTestConfig({ sweepIntervalMs: 60_000, shutdownGraceMs: 60_000 });
  const daemon = spawnDaemonProcess(config, { HARBORAGE_OWNER_PID: String(owner.pid) });
  await waitFor(() => isDaemonHealthy(config), { timeoutMs: 30_000, message: 'daemon never became healthy' });

  const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
  const client = new Client({ name: 'harborage-kill-test', version: '0.2.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://${config.host}:${config.port}/mcp`)));
  await client.callTool({ name: 'create_session', arguments: {} }, { timeout: 120_000 });

  const browserPids = await listDescendantPids(daemon.pid);
  assert.ok(browserPids.length > 0, 'the daemon should have launched at least one browser process');

  daemon.kill();
  await daemon.exited;

  for (const pid of browserPids) {
    assert.equal(await waitForDeath(pid, 20_000), true, `browser process ${pid} outlived the daemon that launched it`);
  }

  owner.kill();
  await client.close().catch(() => {
    // Nothing on the other end any more.
  });
});

test('the daemon writes what it owns into its ledger, and clears its own entry on a clean shutdown', async () => {
  const owner = spawnInertProcess();
  const config = await makeTestConfig({ sweepIntervalMs: 200, shutdownGraceMs: 60_000 });
  const daemon = spawnDaemonProcess(config, { HARBORAGE_OWNER_PID: String(owner.pid) });
  await waitFor(() => isDaemonHealthy(config), { timeoutMs: 30_000, message: 'daemon never became healthy' });

  const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
  const client = new Client({ name: 'harborage-ledger-test', version: '0.2.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://${config.host}:${config.port}/mcp`)));
  await client.callTool({ name: 'create_session', arguments: {} }, { timeout: 120_000 });

  await waitFor(
    async () => {
      const entries = await readOwnedProcesses(config.ownedProcessesPath);
      return entries.some(e => e.kind === 'daemon') && entries.some(e => e.kind === 'browser');
    },
    { timeoutMs: 20_000, message: 'the daemon should have recorded itself and its browser in the ledger' }
  );

  const entries = await readOwnedProcesses(config.ownedProcessesPath);
  const daemonEntry = entries.find(e => e.kind === 'daemon');
  const browserEntry = entries.find(e => e.kind === 'browser');
  assert.equal(daemonEntry!.pid, daemon.pid, 'the daemon entry should name the real daemon PID');
  assert.equal(browserEntry!.ownerPid, daemon.pid, 'the browser entry should name the daemon that started it');

  // The recorded start times are the PID-reuse guard, and an entry without a
  // correct one is worse than no entry: it is a PID a cleanup tool would
  // believe.
  assert.equal(await getProcessStartTime(daemon.pid), daemonEntry!.startedAt);
  assert.equal(await getProcessStartTime(browserEntry!.pid), browserEntry!.startedAt);
  assert.equal(alive(browserEntry!.pid), true, 'the recorded browser PID should be a real, live process');

  // A clean shutdown clears the daemon's own entry, so gc does not later
  // report a daemon that ended properly as something left behind.
  owner.kill();
  await owner.exited;
  await daemon.exited;
  await waitFor(
    async () => (await readOwnedProcesses(config.ownedProcessesPath)).every(e => e.kind !== 'daemon'),
    { timeoutMs: 15_000, message: 'a cleanly shut down daemon should remove its own ledger entry' }
  );

  await client.close().catch(() => {
    // Gone with the daemon.
  });
});

test('the test script keeps the two flags that stop a wedged run from lasting forever', async () => {
  // A guard on the harness itself, because both flags are invisible until the
  // day they matter and a tidy-up that dropped them would silently restore the
  // failure they were added for.
  //
  // Measured, not assumed. A test file that blocks forever while holding a
  // live child handle was run both ways: with neither flag its runner was
  // still going ten seconds later and would have gone on indefinitely, which
  // is how two runs on this machine reached fifty-five minutes at 0% CPU with
  // nobody noticing. With both flags the same file failed as a
  // `testTimeoutFailure` in three seconds and left nothing behind.
  //
  // They cover different failures and neither substitutes for the other.
  // `--test-timeout` bounds a test that never returns. `--test-force-exit`
  // bounds a run whose tests have all FINISHED but whose event loop will not
  // drain, which no timeout can ever catch because at that point no test is
  // running to time out. The wedge on this machine was the second kind.
  const packageJson = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.match(packageJson.scripts.test, /--test-force-exit/);
  assert.match(packageJson.scripts.test, /--test-timeout=\d+/);
});
