import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Config } from '../src/shared/config.js';

const testDir = dirname(fileURLToPath(import.meta.url));
export const repoRoot = join(testDir, '..');
export const daemonEntry = join(repoRoot, 'dist', 'daemon', 'index.js');
export const cliEntry = join(repoRoot, 'dist', 'client', 'cli.js');

/** Binds to port 0 to get an OS-assigned free port, then releases it immediately. */
export function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

const tempDirs: string[] = [];

/** A `Config` isolated to a fresh temp directory and (by default) unused free ports, for one test. */
export async function makeTestConfig(overrides: Partial<Config> = {}): Promise<Config> {
  const stateDir = mkdtempSync(join(tmpdir(), 'harborage-test-'));
  tempDirs.push(stateDir);
  const port = overrides.port ?? (await getFreePort());
  const debugPort = overrides.debugPort ?? (await getFreePort());
  return {
    host: '127.0.0.1',
    port,
    debugPort,
    idleTimeoutMs: 15 * 60 * 1000,
    escalatedIdleTimeoutMs: 60 * 60 * 1000,
    maxInFlightAgeMs: 10 * 60 * 1000,
    sweepIntervalMs: 60 * 1000,
    shutdownGraceMs: 10 * 1000,
    stateDir,
    registryPath: join(stateDir, 'registry.json'),
    daemonLogPath: join(stateDir, 'daemon.log'),
    screenshotCacheDir: join(stateDir, 'screenshots'),
    screenshotCacheTtlMs: 30 * 60 * 1000,
    consoleBufferSize: 200,
    networkBufferSize: 200,
    dialogBufferSize: 200,
    pageErrorBufferSize: 200,
    daemonReadyTimeoutMs: 30 * 1000,
    daemonHealthPollMs: 100,
    testStartupDelayMs: 0,
    ...overrides
  };
}

/** Removes every temp dir created by `makeTestConfig` in this process. Call from an `after()` hook. */
export function cleanupTempDirs(): void {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A trivial local HTTP page that sets a cookie, for storage-state seeding tests. */
export async function startTestPage(): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createHttpServer((_req, res) => {
    res.setHeader('Set-Cookie', 'harborage_test_sid=cookie-value; Path=/');
    res.end('<html><body><h1>harborage test page</h1></body></html>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () => new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve())))
  };
}

export function waitFor(predicate: () => Promise<boolean> | boolean, opts: { timeoutMs?: number; intervalMs?: number; message?: string } = {}): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const intervalMs = opts.intervalMs ?? 50;
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = async () => {
      if (await predicate()) {
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error(opts.message ?? `waitFor: condition not met within ${timeoutMs}ms`));
        return;
      }
      setTimeout(() => void tick(), intervalMs);
    };
    void tick();
  });
}

export interface SpawnedProcess {
  proc: ChildProcess;
  pid: number;
  /** Resolves with the exit code once the process has actually exited. */
  exited: Promise<number | null>;
  kill: () => void;
  /**
   * Everything the process has written to stderr so far, joined. For the
   * daemon that is its structured log: the real deployment redirects the
   * same stream into `~/.harborage/daemon.log`, so asserting on this is
   * asserting on what an operator would actually read afterwards.
   */
  stderrText: () => string;
}

/** Spawns a long-lived, otherwise-inert Node process: a stand-in "client" with a real, controllable PID. */
export function spawnInertProcess(): SpawnedProcess {
  const proc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const exited = new Promise<number | null>(resolve => {
    proc.once('exit', code => resolve(code));
  });
  if (proc.pid === undefined) throw new Error('failed to spawn inert process: no pid');
  return { proc, pid: proc.pid, exited, kill: () => proc.kill('SIGKILL'), stderrText: () => '' };
}

/** Spawns the real daemon entrypoint against `config`, with extra env overrides layered on top. */
export function spawnDaemonProcess(config: Config, extraEnv: Record<string, string> = {}): SpawnedProcess {
  const proc = spawn(
    process.execPath,
    [daemonEntry],
    {
      // stderr is piped, not ignored, so tests can read the daemon's own
      // structured log the same way an operator reads daemon.log.
      stdio: ['ignore', 'ignore', 'pipe'],
      env: {
        ...process.env,
        HARBORAGE_HOST: config.host,
        HARBORAGE_PORT: String(config.port),
        HARBORAGE_DEBUG_PORT: String(config.debugPort),
        HARBORAGE_IDLE_TIMEOUT_MS: String(config.idleTimeoutMs),
        HARBORAGE_ESCALATED_IDLE_TIMEOUT_MS: String(config.escalatedIdleTimeoutMs),
        HARBORAGE_MAX_IN_FLIGHT_AGE_MS: String(config.maxInFlightAgeMs),
        HARBORAGE_SWEEP_INTERVAL_MS: String(config.sweepIntervalMs),
        HARBORAGE_SHUTDOWN_GRACE_MS: String(config.shutdownGraceMs),
        HARBORAGE_STATE_DIR: config.stateDir,
        HARBORAGE_REGISTRY_PATH: config.registryPath,
        HARBORAGE_DAEMON_LOG_PATH: config.daemonLogPath,
        HARBORAGE_SCREENSHOT_CACHE_DIR: config.screenshotCacheDir,
        HARBORAGE_SCREENSHOT_CACHE_TTL_MS: String(config.screenshotCacheTtlMs),
        HARBORAGE_CONSOLE_BUFFER_SIZE: String(config.consoleBufferSize),
        HARBORAGE_NETWORK_BUFFER_SIZE: String(config.networkBufferSize),
        HARBORAGE_DIALOG_BUFFER_SIZE: String(config.dialogBufferSize),
        HARBORAGE_PAGE_ERROR_BUFFER_SIZE: String(config.pageErrorBufferSize),
        HARBORAGE_TEST_STARTUP_DELAY_MS: String(config.testStartupDelayMs),
        ...extraEnv
      }
    }
  );
  const stderrChunks: string[] = [];
  proc.stderr?.setEncoding('utf8');
  proc.stderr?.on('data', (chunk: string) => stderrChunks.push(chunk));

  const exited = new Promise<number | null>(resolve => {
    proc.once('exit', code => resolve(code));
  });
  if (proc.pid === undefined) throw new Error('failed to spawn daemon: no pid');
  return {
    proc,
    pid: proc.pid,
    exited,
    kill: () => proc.kill('SIGKILL'),
    stderrText: () => stderrChunks.join('')
  };
}

export async function isDaemonHealthy(config: Config): Promise<boolean> {
  try {
    const res = await fetch(`http://${config.host}:${config.port}/health`, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

function collectFiles(dir: string, ignore: Set<string>, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (ignore.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(full, ignore, out);
    } else {
      out.push(full);
    }
  }
}

/** A sorted, repo-relative file listing, skipping VCS/build/dependency directories. */
export function snapshotRepoFiles(): string[] {
  const ignore = new Set(['node_modules', 'dist', '.git']);
  const out: string[] = [];
  collectFiles(repoRoot, ignore, out);
  return out.map(f => relative(repoRoot, f)).sort();
}

export function fileExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * The full `HARBORAGE_*` environment one client wrapper needs to run fully
 * isolated: its own ports, its own state dir, its own registry. Kept here
 * rather than inline in each test because a forgotten variable silently
 * points a test at the real machine-wide daemon on port 4599.
 */
export function wrapperEnv(config: Config, extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    HARBORAGE_HOST: config.host,
    HARBORAGE_PORT: String(config.port),
    HARBORAGE_DEBUG_PORT: String(config.debugPort),
    HARBORAGE_IDLE_TIMEOUT_MS: String(config.idleTimeoutMs),
    HARBORAGE_ESCALATED_IDLE_TIMEOUT_MS: String(config.escalatedIdleTimeoutMs),
    HARBORAGE_MAX_IN_FLIGHT_AGE_MS: String(config.maxInFlightAgeMs),
    HARBORAGE_SWEEP_INTERVAL_MS: String(config.sweepIntervalMs),
    HARBORAGE_SHUTDOWN_GRACE_MS: String(config.shutdownGraceMs),
    HARBORAGE_STATE_DIR: config.stateDir,
    HARBORAGE_REGISTRY_PATH: config.registryPath,
    HARBORAGE_DAEMON_LOG_PATH: config.daemonLogPath,
    HARBORAGE_SCREENSHOT_CACHE_DIR: config.screenshotCacheDir,
    HARBORAGE_SCREENSHOT_CACHE_TTL_MS: String(config.screenshotCacheTtlMs),
    HARBORAGE_DAEMON_READY_TIMEOUT_MS: String(config.daemonReadyTimeoutMs),
    HARBORAGE_DAEMON_HEALTH_POLL_MS: String(config.daemonHealthPollMs),
    HARBORAGE_TEST_STARTUP_DELAY_MS: String(config.testStartupDelayMs),
    ...extra
  };
}

/** The daemon's `/health` payload, or null if nothing is listening. */
export async function daemonHealth(config: Config): Promise<{ pid: number; uptimeMs: number } | null> {
  try {
    const res = await fetch(`http://${config.host}:${config.port}/health`, { signal: AbortSignal.timeout(1000) });
    if (!res.ok) return null;
    return (await res.json()) as { pid: number; uptimeMs: number };
  } catch {
    return null;
  }
}

/** PNG width/height, read from the IHDR chunk (big-endian uint32s at byte offsets 16 and 20). */
export function pngSize(png: Buffer): { width: number; height: number } {
  const magic = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  if (!png.subarray(0, 4).equals(magic)) throw new Error('not a PNG: bad magic bytes');
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}
