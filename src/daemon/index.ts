import { loadConfig } from '../shared/config.js';
import { createStderrLogger, errorFields, type LogFields } from '../shared/logger.js';
import { forgetOwnedProcesses, recordOwnedProcess } from '../shared/ownedProcesses.js';
import { getProcessStartTime } from '../shared/processInfo.js';
import { readRegistry } from '../shared/registry.js';
import { BrowserManager } from './browserManager.js';
import { startHttpServer } from './httpServer.js';
import { createServerFactory } from './server.js';
import { SessionStore } from './sessions.js';
import { startSweepLoop } from './sweep.js';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const config = loadConfig();
  // stderr, because the client wrapper redirects the detached daemon's
  // stderr into ~/.harborage/daemon.log. Nothing here opens that file
  // itself; two writers on one append-mode file interleave half-lines.
  const logger = createStderrLogger();

  if (config.testStartupDelayMs > 0) {
    logger.log('daemon.startup-delayed', { reason: 'HARBORAGE_TEST_STARTUP_DELAY_MS', delayMs: config.testStartupDelayMs });
    await sleep(config.testStartupDelayMs);
  }

  const startedAt = Date.now();

  // This daemon's own OS identity, read once. Every ledger entry it writes is
  // stamped with it so a later `harborage gc` can tell "the daemon that owned
  // this browser is still running" from "that daemon is gone and this is its
  // orphan", by pid AND start time rather than by PID alone.
  const selfStartedAt = await getProcessStartTime(process.pid);

  /**
   * Ledger writes, run strictly one after another and never in parallel.
   *
   * The queue is not tidiness. Every ledger operation is a read, a change and
   * a write, so two of them overlapping means the second writes back a copy of
   * the file it read before the first had finished, undoing it. That is not
   * theoretical: without this queue the shutdown path lost a race under load.
   * Clearing the browser entry and clearing the daemon's own entry overlapped,
   * the browser clear landed second carrying a snapshot that still had the
   * daemon in it, and a daemon that had exited perfectly cleanly left an entry
   * behind claiming it was still running. `harborage gc` would then have
   * reported a phantom, and on a machine where PIDs get recycled a phantom in
   * that file is exactly what must never be there.
   *
   * Writes are still best-effort in the sense that a failure is logged rather
   * than propagated. A ledger this daemon cannot write is a cleanup tool that
   * will be less useful later; a daemon that refuses to serve because it could
   * not write a JSON file is broken now.
   */
  let ledgerQueue: Promise<void> = Promise.resolve();
  function enqueueLedgerWrite(describe: LogFields, op: () => Promise<void>): Promise<void> {
    // Chained off the settled queue either way, so one failed write cannot
    // wedge every write after it.
    const next = ledgerQueue.then(
      () => op(),
      () => op()
    );
    ledgerQueue = next.catch(err => logger.log('ledger.write-failed', { ...describe, ...errorFields(err) }));
    return ledgerQueue;
  }

  const ledger = {
    record: (kind: 'daemon' | 'browser', pid: number, pidStartedAt: string, note: string): Promise<void> => {
      if (!selfStartedAt) return Promise.resolve();
      return enqueueLedgerWrite({ operation: 'record', kind, pid }, () =>
        recordOwnedProcess(config.ownedProcessesPath, {
          kind,
          pid,
          startedAt: pidStartedAt,
          ownerPid: process.pid,
          ownerStartedAt: selfStartedAt,
          recordedAt: Date.now(),
          note
        })
      );
    },
    forget: (pids: number[]): Promise<void> =>
      enqueueLedgerWrite({ operation: 'forget', pids: pids.join(',') }, () =>
        forgetOwnedProcesses(config.ownedProcessesPath, pids)
      )
  };

  const browserManager = new BrowserManager(config.debugPort, {
    onLaunched: pids => {
      for (const pid of pids) {
        void getProcessStartTime(pid).then(pidStartedAt => {
          if (pidStartedAt) ledger.record('browser', pid, pidStartedAt, 'chromium launched by this daemon');
        });
      }
    },
    onClosed: pids => {
      void ledger.forget(pids);
    }
  });
  const sessions = new SessionStore(
    browserManager,
    {
      console: config.consoleBufferSize,
      network: config.networkBufferSize,
      dialog: config.dialogBufferSize,
      pageError: config.pageErrorBufferSize
    },
    logger,
    {
      escalatedIdleTimeoutMs: config.escalatedIdleTimeoutMs,
      maxInFlightAgeMs: config.maxInFlightAgeMs
    }
  );

  /**
   * Best-effort count of registered client wrappers, purely so a shutdown
   * line can state both numbers that fed the decision. A shutdown must never
   * fail because the registry file was unreadable, so this swallows errors
   * and reports an unknown count by omitting the field.
   */
  async function countRegisteredClients(): Promise<number | undefined> {
    try {
      return (await readRegistry(config.registryPath)).length;
    } catch {
      return undefined;
    }
  }

  let shuttingDown = false;
  async function shutdown(reason: string, fields: LogFields = {}): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    // Stop the timer before the first await: otherwise a second sweep can
    // fire mid-teardown and race this one to process.exit().
    sweepHandle.stop();
    // Both counts, every time. "shutting down: client registry is empty"
    // with no session count was exactly the line that hid the fact that
    // live sessions were being destroyed along with the daemon.
    logger.log('daemon.shutdown', {
      reason,
      clients: await countRegisteredClients(),
      sessions: sessions.count(),
      uptimeMs: Date.now() - startedAt,
      ...fields
    });
    await sessions.closeAll();
    await browserManager.close();
    await http.close();
    // Last, and only on a clean shutdown: the ledger's purpose is to name
    // processes that might still be running, and until `browserManager.close()`
    // has returned, this daemon's Chromium is exactly such a process.
    //
    // Awaited, and queued behind the browser's own clear (see
    // `enqueueLedgerWrite`), so this is the final state of the file rather
    // than something a late write can undo.
    await ledger.forget([process.pid]);
    logger.log('daemon.stopped', { reason });
  }

  /**
   * The teardown a fatal error gets: close the browser, then exit.
   *
   * `process.exit()` on its own does in fact take Chromium with it, because
   * Playwright launches it over a pipe on fds 3 and 4 and Chromium exits when
   * that pipe closes. That was verified directly rather than assumed: a daemon
   * with a live session was SIGTERMed and then SIGKILLed, and both times all
   * four of its Chromium processes were gone five seconds later. So this is
   * not a leak fix.
   *
   * It is here because relying on that is relying on an implementation detail
   * of somebody else's launcher, in the one code path where the daemon already
   * knows something has gone wrong. Asking the browser to close first is a
   * couple of lines, it makes the intent legible, and it means a future change
   * to how the browser is launched cannot quietly turn a fatal error into a
   * stranded Chromium. The timeout is the point of the exercise: a browser
   * that will not close must not be able to stop the daemon from dying.
   */
  async function fatalExit(phase: string, err: unknown): Promise<never> {
    logger.log('daemon.error', { phase, fatal: true, ...errorFields(err) });
    try {
      await Promise.race([
        browserManager.close(),
        new Promise<void>(resolve => setTimeout(resolve, 2000).unref())
      ]);
    } catch {
      // Already dying. Nothing useful is left to do about a failed close.
    }
    process.exit(1);
  }

  let http: Awaited<ReturnType<typeof startHttpServer>>;
  try {
    http = await startHttpServer(
      config.host,
      config.port,
      createServerFactory(sessions, {
        debugPort: config.debugPort,
        screenshotCacheDir: config.screenshotCacheDir,
        screenshotCacheTtlMs: config.screenshotCacheTtlMs
      }),
      startedAt
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      // Another daemon instance is already serving this port, nothing to do.
      logger.log('daemon.port-in-use', { port: config.port, action: 'exiting' });
      process.exit(0);
    }
    logger.log('daemon.error', { phase: 'listen', ...errorFields(err) });
    throw err;
  }

  // Read once, at startup, and never re-read. Re-reading it later would defeat
  // the guard entirely: the point of holding the owner's ORIGINAL start time
  // is that a PID the OS has since recycled no longer matches it.
  const ownerStartedAt = config.ownerPid === null ? null : await getProcessStartTime(config.ownerPid);
  if (config.ownerPid !== null && ownerStartedAt === null) {
    // Named an owner that was already gone before this daemon finished
    // starting. Logged and then ignored rather than treated as "shut down
    // immediately", because the likelier cause is a stale environment
    // variable, and a daemon that exits on boot is a much more confusing
    // failure than one that simply has no owner watch.
    logger.log('daemon.owner-unreadable', {
      ownerPid: config.ownerPid,
      action: 'continuing without an owner watch'
    });
  }
  const owner = config.ownerPid !== null && ownerStartedAt !== null ? { pid: config.ownerPid, startedAt: ownerStartedAt } : null;

  const sweepHandle = startSweepLoop(
    {
      sessions,
      registryPath: config.registryPath,
      idleTimeoutMs: config.idleTimeoutMs,
      shutdownGraceMs: config.shutdownGraceMs,
      daemonStartedAt: startedAt,
      screenshotCacheDir: config.screenshotCacheDir,
      screenshotCacheTtlMs: config.screenshotCacheTtlMs,
      logger,
      owner,
      onEmptyRegistryShutdown: async () => {
        await shutdown('registry-empty');
        process.exit(0);
      },
      onOwnerGoneShutdown: async () => {
        await shutdown('owner-gone', { ownerPid: owner?.pid });
        process.exit(0);
      }
    },
    config.sweepIntervalMs
  );

  logger.log('daemon.start', {
    pid: process.pid,
    port: config.port,
    url: `http://${config.host}:${config.port}/mcp`,
    debugPort: config.debugPort,
    sweepIntervalMs: config.sweepIntervalMs,
    idleTimeoutMs: config.idleTimeoutMs,
    shutdownGraceMs: config.shutdownGraceMs,
    ownerPid: owner?.pid
  });

  if (selfStartedAt) {
    ledger.record('daemon', process.pid, selfStartedAt, `serving http://${config.host}:${config.port}/mcp`);
  } else {
    // Without a start time there is no PID-reuse guard, and an unguarded PID
    // in a file that a cleanup tool reads is worse than no entry at all.
    logger.log('daemon.ledger-skipped', {
      reason: 'could not read this process\'s own start time',
      consequence: 'harborage gc will not know about this daemon'
    });
  }

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void shutdown('signal', { signal }).then(() => process.exit(0));
    });
  }

  // These two handlers deliberately keep Node's own fatal behaviour and add
  // only the line that was missing, plus an explicit browser close on the way
  // out (see `fatalExit`). A daemon dying of a stray exception takes every
  // live session down with it, and until now it did so leaving nothing in the
  // log to explain what a subagent had just lost. Whether it should instead
  // survive such an exception is a real question, but it is a lifecycle
  // change, not an observability one, so it is not made here.
  process.on('uncaughtException', err => {
    void fatalExit('uncaught-exception', err);
  });
  process.on('unhandledRejection', reason => {
    void fatalExit('unhandled-rejection', reason);
  });
}

main().catch(err => {
  createStderrLogger().log('daemon.error', { phase: 'startup', fatal: true, ...errorFields(err) });
  process.exit(1);
});
