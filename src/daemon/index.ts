import { loadConfig } from '../shared/config.js';
import { createStderrLogger, errorFields, type LogFields } from '../shared/logger.js';
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

  const browserManager = new BrowserManager(config.debugPort);
  const sessions = new SessionStore(
    browserManager,
    { console: config.consoleBufferSize, network: config.networkBufferSize },
    logger
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
    logger.log('daemon.stopped', { reason });
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
      onEmptyRegistryShutdown: async () => {
        await shutdown('registry-empty');
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
    shutdownGraceMs: config.shutdownGraceMs
  });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void shutdown('signal', { signal }).then(() => process.exit(0));
    });
  }

  // These two handlers deliberately keep Node's own fatal behaviour and add
  // only the line that was missing. A daemon dying of a stray exception
  // takes every live session down with it, and until now it did so leaving
  // nothing in the log to explain what a subagent had just lost. Whether it
  // should instead survive such an exception is a real question, but it is
  // a lifecycle change, not an observability one, so it is not made here.
  process.on('uncaughtException', err => {
    logger.log('daemon.error', { phase: 'uncaught-exception', fatal: true, ...errorFields(err) });
    process.exit(1);
  });
  process.on('unhandledRejection', reason => {
    logger.log('daemon.error', { phase: 'unhandled-rejection', fatal: true, ...errorFields(reason) });
    process.exit(1);
  });
}

main().catch(err => {
  createStderrLogger().log('daemon.error', { phase: 'startup', fatal: true, ...errorFields(err) });
  process.exit(1);
});
