import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { inflateSync } from 'node:zlib';
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
    requestTimeoutCeilingMs: 10 * 60 * 1000,
    requestTimeoutFloorMs: 60 * 1000,
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
        HARBORAGE_REQUEST_TIMEOUT_CEILING_MS: String(config.requestTimeoutCeilingMs),
        HARBORAGE_REQUEST_TIMEOUT_FLOOR_MS: String(config.requestTimeoutFloorMs),
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

/**
 * A sorted, repo-relative file listing, skipping VCS, build, dependency and
 * agent-scratch directories.
 *
 * `.claude` is ignored for a different reason than the other three, and the
 * distinction matters. The others are noise. `.claude` is where git worktrees
 * and agent scratch files live, it is gitignored, and it is written to by
 * OTHER processes while a test runs. Without it here, a caller asserting "this
 * tool wrote nothing to disk" fails whenever anything else on the machine
 * happens to touch a scratch file mid-run, which is a false failure about a
 * process the test is not testing. Measured directly: the screenshot inline
 * test failed in a full suite and passed in isolation, purely because a
 * sibling was writing probe files under `.claude/worktrees` at the time.
 *
 * The assertion this protects is unchanged in strength: a screenshot written
 * anywhere a human would call the repo, the root, `src/`, `test/`, `assets/`
 * or `docs/`, is still caught. Only the gitignored scratch tree is exempt,
 * and nothing in this project writes there on purpose.
 */
export function snapshotRepoFiles(): string[] {
  const ignore = new Set(['node_modules', 'dist', '.git', '.claude']);
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
    HARBORAGE_REQUEST_TIMEOUT_CEILING_MS: String(config.requestTimeoutCeilingMs),
    HARBORAGE_REQUEST_TIMEOUT_FLOOR_MS: String(config.requestTimeoutFloorMs),
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

/**
 * One decoded PNG: its dimensions and an RGBA byte array, four bytes per
 * pixel in row-major order.
 */
export interface DecodedPng {
  width: number;
  height: number;
  /** RGBA, 8 bits per channel, length width * height * 4. */
  pixels: Uint8Array;
}

/**
 * Decodes a PNG down to raw RGBA bytes, so a test can read the colour the
 * browser ACTUALLY painted rather than the colour some other code path in the
 * same process believes it painted.
 *
 * This exists because of how the round-2 contrast fixes failed. They asserted
 * that computed_style returned the ratio the test had computed from the same
 * parser and the same compositing code computed_style itself uses, so a whole
 * class of "the number is confidently wrong" bugs sailed through green. A
 * screenshot is the one artefact in reach that neither the parser nor the
 * compositor had a hand in producing: Chromium rasterised it. Comparing
 * against that is the only assertion here worth making.
 *
 * Deliberately narrow: 8-bit non-interlaced truecolour, with or without an
 * alpha channel, which is every screenshot Chromium's CDP capture produces.
 * Anything else throws rather than being decoded approximately, because a
 * silently wrong oracle is worse than no oracle.
 */
export function decodePng(png: Buffer): DecodedPng {
  const magic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!png.subarray(0, 8).equals(magic)) throw new Error('not a PNG: bad signature');

  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const bitDepth = png.readUInt8(24);
  const colorType = png.readUInt8(25);
  const interlace = png.readUInt8(28);
  if (bitDepth !== 8) throw new Error(`decodePng only handles 8-bit PNGs, got bit depth ${bitDepth}`);
  if (colorType !== 2 && colorType !== 6) {
    throw new Error(`decodePng only handles truecolour PNGs (colour type 2 or 6), got ${colorType}`);
  }
  if (interlace !== 0) throw new Error('decodePng does not handle interlaced PNGs');

  const channels = colorType === 6 ? 4 : 3;
  const idat: Buffer[] = [];
  let offset = 8;
  while (offset + 8 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    if (type === 'IDAT') idat.push(png.subarray(dataStart, dataStart + length));
    if (type === 'IEND') break;
    offset = dataStart + length + 4;
  }
  if (idat.length === 0) throw new Error('PNG carries no IDAT chunk');

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = new Uint8Array(width * height * 4);
  // The previous row's UNFILTERED bytes, which is what every PNG filter type
  // above 1 refers back to. Starts as zeroes for row 0, per the spec.
  let previous = new Uint8Array(stride);

  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const rowStart = y * (stride + 1) + 1;
    const current = new Uint8Array(stride);
    for (let x = 0; x < stride; x += 1) {
      const value = raw[rowStart + x];
      const left = x >= channels ? current[x - channels] : 0;
      const up = previous[x];
      const upLeft = x >= channels ? previous[x - channels] : 0;
      let reconstructed: number;
      switch (filter) {
        case 0:
          reconstructed = value;
          break;
        case 1:
          reconstructed = value + left;
          break;
        case 2:
          reconstructed = value + up;
          break;
        case 3:
          reconstructed = value + Math.floor((left + up) / 2);
          break;
        case 4: {
          // Paeth: pick whichever of left / up / up-left the linear estimate
          // of the three lands closest to.
          const estimate = left + up - upLeft;
          const dLeft = Math.abs(estimate - left);
          const dUp = Math.abs(estimate - up);
          const dUpLeft = Math.abs(estimate - upLeft);
          const predictor = dLeft <= dUp && dLeft <= dUpLeft ? left : dUp <= dUpLeft ? up : upLeft;
          reconstructed = value + predictor;
          break;
        }
        default:
          throw new Error(`unknown PNG filter type ${filter} on row ${y}`);
      }
      current[x] = reconstructed & 0xff;
    }
    for (let x = 0; x < width; x += 1) {
      const from = x * channels;
      const to = (y * width + x) * 4;
      out[to] = current[from];
      out[to + 1] = current[from + 1];
      out[to + 2] = current[from + 2];
      out[to + 3] = channels === 4 ? current[from + 3] : 255;
    }
    previous = current;
  }

  return { width, height, pixels: out };
}

/** The RGBA the browser painted at one pixel of a decoded capture. */
export function pixelAt(image: DecodedPng, x: number, y: number): { r: number; g: number; b: number; a: number } {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) {
    throw new Error(`pixel (${x}, ${y}) is outside the ${image.width}x${image.height} capture`);
  }
  const index = (y * image.width + x) * 4;
  return {
    r: image.pixels[index],
    g: image.pixels[index + 1],
    b: image.pixels[index + 2],
    a: image.pixels[index + 3]
  };
}

/** WCAG 2.x relative luminance, computed here rather than imported, so the oracle shares no code with the tool. */
function oracleLuminance(rgb: { r: number; g: number; b: number }): number {
  const channel = (value: number): number => {
    const scaled = value / 255;
    return scaled <= 0.03928 ? scaled / 12.92 : Math.pow((scaled + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
}

/**
 * The true WCAG contrast ratio between two PAINTED pixels.
 *
 * Written out longhand here on purpose. Importing contrastRatio from the tool
 * would make every assertion below circular: the test would be checking that
 * the tool agrees with itself.
 */
export function paintedContrastRatio(
  a: { r: number; g: number; b: number },
  b: { r: number; g: number; b: number }
): number {
  const first = oracleLuminance(a);
  const second = oracleLuminance(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}
