import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadConfig } from '../src/shared/config.js';

/**
 * loadConfig reads process.env directly, so these tests own the relevant
 * variables for the duration of the file. node:test runs each test file in
 * its own process, so this cannot leak into another test's config.
 */
function withEnv(name: string, value: string | undefined, run: () => void): void {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    run();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

test('cached screenshots default to a four hour TTL, long enough to outlive a QA run', () => {
  withEnv('HARBORAGE_SCREENSHOT_CACHE_TTL_MS', undefined, () => {
    assert.equal(loadConfig().screenshotCacheTtlMs, 4 * 60 * 60 * 1000);
  });
});

test('the screenshot TTL is still overridable by environment variable', () => {
  withEnv('HARBORAGE_SCREENSHOT_CACHE_TTL_MS', '1234', () => {
    assert.equal(loadConfig().screenshotCacheTtlMs, 1234);
  });
});

/** `withEnv` for more than one variable at a time, restoring all of them. */
function withEnvs(vars: Record<string, string | undefined>, run: () => void): void {
  const names = Object.keys(vars);
  const previous = names.map(name => [name, process.env[name]] as const);
  for (const [name, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    run();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

/**
 * The invariant that was silently false: the shutdown grace is only ever
 * evaluated by a sweep, and the first sweep runs at an uptime of
 * `sweepIntervalMs`, so a grace at or below that can never decline anything.
 * The old pairing (10s grace, 60s sweep) shipped exactly that, which made the
 * knob's documented protection unreachable in every real deployment. Pinned
 * as a relationship rather than as two numbers, because the numbers are
 * allowed to change and the relationship is not.
 */
test('the default shutdown grace outlives the first sweep, so it can actually decline one', () => {
  withEnvs({ HARBORAGE_SWEEP_INTERVAL_MS: undefined, HARBORAGE_SHUTDOWN_GRACE_MS: undefined }, () => {
    const config = loadConfig();
    assert.ok(
      config.shutdownGraceMs > config.sweepIntervalMs,
      `a grace of ${config.shutdownGraceMs}ms can never decline a sweep that first runs at ` +
        `${config.sweepIntervalMs}ms; it would be dead code in the shipped configuration`
    );
  });
});

test('the default grace follows a tuned sweep interval instead of drifting away from it', () => {
  withEnvs({ HARBORAGE_SWEEP_INTERVAL_MS: '5000', HARBORAGE_SHUTDOWN_GRACE_MS: undefined }, () => {
    const config = loadConfig();
    assert.equal(config.sweepIntervalMs, 5000);
    assert.ok(
      config.shutdownGraceMs > config.sweepIntervalMs,
      `derived grace ${config.shutdownGraceMs}ms must still outlive a 5000ms sweep interval`
    );
  });
});

test('an explicitly configured shutdown grace still wins over the derived default', () => {
  withEnvs({ HARBORAGE_SWEEP_INTERVAL_MS: '5000', HARBORAGE_SHUTDOWN_GRACE_MS: '1234' }, () => {
    assert.equal(loadConfig().shutdownGraceMs, 1234);
  });
});
