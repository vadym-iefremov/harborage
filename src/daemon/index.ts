import { loadConfig } from '../shared/config.js';
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

  if (config.testStartupDelayMs > 0) {
    console.error(`[harborage] HARBORAGE_TEST_STARTUP_DELAY_MS set, delaying startup by ${config.testStartupDelayMs}ms`);
    await sleep(config.testStartupDelayMs);
  }

  const startedAt = Date.now();

  const browserManager = new BrowserManager(config.debugPort);
  const sessions = new SessionStore(browserManager);

  let shuttingDown = false;
  async function shutdown(reason: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`[harborage] shutting down: ${reason}`);
    sweepHandle.stop();
    await sessions.closeAll();
    await browserManager.close();
    await http.close();
  }

  let http: Awaited<ReturnType<typeof startHttpServer>>;
  try {
    http = await startHttpServer(config.host, config.port, createServerFactory(sessions, config.debugPort), startedAt);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      // Another daemon instance is already serving this port — nothing to do.
      console.error(`[harborage] port ${config.port} already in use, assuming another daemon instance is running`);
      process.exit(0);
    }
    throw err;
  }

  const sweepHandle = startSweepLoop(
    {
      sessions,
      registryPath: config.registryPath,
      idleTimeoutMs: config.idleTimeoutMs,
      shutdownGraceMs: config.shutdownGraceMs,
      daemonStartedAt: startedAt,
      onEmptyRegistryShutdown: async () => {
        await shutdown('client registry is empty');
        process.exit(0);
      }
    },
    config.sweepIntervalMs
  );

  console.error(`[harborage] daemon listening on http://${config.host}:${config.port}/mcp (pid ${process.pid})`);

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void shutdown(`received ${signal}`).then(() => process.exit(0));
    });
  }
}

main().catch(err => {
  console.error('[harborage] daemon failed to start:', err);
  process.exit(1);
});
