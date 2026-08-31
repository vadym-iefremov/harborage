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
