import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

import { cliEntry, cleanupTempDirs, daemonHealth, makeTestConfig, waitFor, wrapperEnv } from './helpers.js';
import type { Config } from '../src/shared/config.js';
import { toolDefs } from '../src/daemon/tools/schemas.js';
import { minRequestTimeoutMs, requestTimeoutFor, requestTimeoutMarginMs } from '../src/client/wrapper.js';
import { toJSONSchema } from 'zod/v4';

/**
 * Two defects from the same QA round: a schema that silently drops a key it
 * does not recognize (`wait_for({ timeout: 2000 })` running with the
 * 10000ms default instead of erroring), and a client wrapper that could
 * never honor a `timeoutMs` above 60000 because `client.callTool()` ran
 * with no request options and inherited the MCP SDK's 60-second default
 * regardless of what a tool was actually asked to wait for.
 */

const clients: Client[] = [];
const configs: Config[] = [];

after(async () => {
  await Promise.all(clients.splice(0).map(c => c.close().catch(() => {})));
  for (const config of configs.splice(0)) {
    const health = await daemonHealth(config);
    if (!health) continue;
    try {
      process.kill(health.pid, 'SIGTERM');
    } catch {
      // Already gone, which is the outcome we wanted anyway.
    }
    await waitFor(async () => (await daemonHealth(config)) === null, { timeoutMs: 10_000 }).catch(() => {});
  }
  cleanupTempDirs();
});

/** One isolated config per test, remembered so the `after` hook can end its daemon. */
async function testConfig(overrides: Partial<Config> = {}): Promise<Config> {
  const config = await makeTestConfig({ sweepIntervalMs: 60_000, shutdownGraceMs: 60_000, ...overrides });
  configs.push(config);
  return config;
}

/** The plain text of a tool result's first content block, for message assertions without JSON-escaping noise. */
function resultText(result: { content: unknown }): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  return content.map(c => c.text ?? '').join('\n');
}

async function connectWrapper(config: Config, name: string): Promise<Client> {
  const client = new Client({ name, version: '1.0.0' });
  clients.push(client);
  await client.connect(
    new StdioClientTransport({ command: process.execPath, args: [cliEntry], env: wrapperEnv(config) })
  );
  return client;
}

// ---------------------------------------------------------------------------
// Defect 1: unknown and misnamed arguments are silently dropped
// ---------------------------------------------------------------------------

test('wait_for rejects the exact misnamed key from the QA report, and names the real one', () => {
  // The QA report verbatim: { sessionId, selector: '#nope', timeout: 2000 }
  // ran with the 10000ms default because "timeout" (not the schema's
  // "timeoutMs") was silently discarded by a non-strict z.object().
  const parsed = toolDefs.wait_for.inputSchema.safeParse({
    sessionId: 's',
    selector: '#nope',
    timeout: 2000
  });
  assert.equal(parsed.success, false, 'an unrecognized key must be a schema error, not a silent drop');
  const message = parsed.success ? '' : parsed.error.issues.map(i => i.message).join('; ');
  assert.match(message, /"timeout"/, `expected the offending key named, got: ${message}`);
  assert.match(message, /timeoutMs/, `expected the real parameter name suggested, got: ${message}`);
  assert.match(message, /did you mean/i, `expected a near-miss suggestion for "timeout" -> "timeoutMs", got: ${message}`);
});

test('wait_for rejects a wholly invented key, listing the valid parameters but not guessing one', () => {
  const parsed = toolDefs.wait_for.inputSchema.safeParse({
    sessionId: 's',
    selector: '#nope',
    wibble: 'x'
  });
  assert.equal(parsed.success, false, 'an invented key must be a schema error');
  const message = parsed.success ? '' : parsed.error.issues.map(i => i.message).join('; ');
  assert.match(message, /"wibble"/, `expected the offending key named, got: ${message}`);
  assert.match(message, /sessionId/, `expected the valid parameter list, got: ${message}`);
  assert.doesNotMatch(message, /did you mean/i, `"wibble" is not close to any real parameter, got: ${message}`);
});

test('wait_for with its correctly named arguments still parses', () => {
  const parsed = toolDefs.wait_for.inputSchema.safeParse({
    sessionId: 's',
    selector: '#ok',
    timeoutMs: 2000
  });
  assert.equal(parsed.success, true, `expected a correctly named call to parse, got: ${JSON.stringify(parsed)}`);
});

test('the JSON Schema advertised to a caller marks wait_for closed to extra properties', () => {
  const schema = toJSONSchema(toolDefs.wait_for.inputSchema) as { additionalProperties?: unknown };
  assert.equal(schema.additionalProperties, false, 'strict schemas should advertise additionalProperties: false');
});

test('a real wrapper rejects the misnamed key over the actual stdio transport, fast, before ever reaching the daemon', async () => {
  const config = await testConfig();
  const client = await connectWrapper(config, 'round2-unknown-key-test');

  const startedAt = Date.now();
  const result = await client.callTool({
    name: 'wait_for',
    arguments: { sessionId: 'not-a-real-session', selector: '#nope', timeout: 2000 }
  });
  const elapsedMs = Date.now() - startedAt;

  assert.ok(result.isError, `expected a schema error, got: ${JSON.stringify(result)}`);
  const text = resultText(result);
  assert.match(text, /"timeout"/, `expected the offending key named, got: ${text}`);
  assert.match(text, /timeoutMs/, `expected the real parameter suggested, got: ${text}`);
  // The old bug ran wait_for's 10000ms default because the typo was
  // dropped; a schema rejection never reaches the daemon (there is no
  // session to resolve, on purpose: "not-a-real-session" is never looked
  // up), so it comes back in well under a second.
  assert.ok(elapsedMs < 3000, `expected a fast schema rejection, took ${elapsedMs}ms`);

  // The daemon this wrapper would have talked to was never even asked to
  // start, since a request that fails schema validation at the wrapper
  // never leaves the wrapper process.
  const health = await daemonHealth(config);
  assert.equal(health, null, 'a schema-rejected call must not spawn the daemon');
});

// ---------------------------------------------------------------------------
// Defect 2: a fixed 60-second ceiling no caller can raise
// ---------------------------------------------------------------------------

test('requestTimeoutFor: no timeoutMs gets the unchanged 60s floor', () => {
  assert.equal(requestTimeoutFor({}, 10 * 60 * 1000), minRequestTimeoutMs);
});

test('requestTimeoutFor: a small timeoutMs still gets at least the 60s floor', () => {
  assert.equal(requestTimeoutFor({ timeoutMs: 1500 }, 10 * 60 * 1000), minRequestTimeoutMs);
});

test('requestTimeoutFor: a timeoutMs past 60s is no longer clamped down to 60s', () => {
  // This is the exact shape of the bug: timeoutMs: 150000 used to become a
  // transport timeout of 60000 regardless. It must now be timeoutMs plus
  // margin, comfortably clear of the old fixed 60000.
  const result = requestTimeoutFor({ timeoutMs: 150_000 }, 10 * 60 * 1000);
  assert.equal(result, 150_000 + requestTimeoutMarginMs);
  assert.ok(result > minRequestTimeoutMs, 'must not regress to the old fixed 60s cutoff');
});

test('requestTimeoutFor: timeoutMs 0 (evaluate\'s "wait forever") maps to the ceiling, not to Infinity', () => {
  assert.equal(requestTimeoutFor({ timeoutMs: 0 }, 10 * 60 * 1000), 10 * 60 * 1000);
});

test('requestTimeoutFor: a huge timeoutMs is capped at the ceiling, not left unbounded', () => {
  assert.equal(requestTimeoutFor({ timeoutMs: 999_999_999 }, 10 * 60 * 1000), 10 * 60 * 1000);
});

test('a real wrapper actually passes the derived timeout to the transport: the ceiling is enforced end to end', async () => {
  // A small configured ceiling, so this proves real enforcement without the
  // suite waiting out the production 10-minute default.
  const config = await testConfig({ requestTimeoutCeilingMs: 1500 });
  const client = await connectWrapper(config, 'round2-ceiling-test');

  const created = await client.callTool({ name: 'create_session', arguments: {} });
  assert.ok(!created.isError, `expected create_session to succeed: ${JSON.stringify(created)}`);
  const { sessionId } = created.structuredContent as { sessionId: string };

  const startedAt = Date.now();
  // wait_for's own timeout (5000ms) would resolve this around 5008ms if
  // nothing cut it off first; the 1500ms ceiling must win.
  const result = await client.callTool(
    { name: 'wait_for', arguments: { sessionId, selector: '#never-appears', timeoutMs: 5000 } },
    // This call's own hop (test -> wrapper) is a separate connection with
    // its own 60s SDK default; it is given generous headroom here purely so
    // IT does not fire first and mask what is under test: the wrapper's
    // OWN outgoing call to the daemon, which is what the 1500ms ceiling
    // bounds.
    { timeout: 30_000 }
  );
  const elapsedMs = Date.now() - startedAt;

  assert.ok(result.isError, `expected the ceiling to cut the call off as an error, got: ${JSON.stringify(result)}`);
  const text = resultText(result);
  assert.match(text, /timed out/i, `expected a timeout-shaped error, got: ${text}`);
  assert.ok(elapsedMs < 4000, `expected the 1500ms ceiling to cut this off well short of wait_for's own 5008ms, took ${elapsedMs}ms`);
  assert.ok(elapsedMs >= 1200, `expected the call to run for roughly the ceiling, took only ${elapsedMs}ms`);
});

test('a real wrapper gives evaluate\'s timeoutMs: 0 the "as long as the ceiling allows" treatment, not a hang', async () => {
  const config = await testConfig({ requestTimeoutCeilingMs: 1500 });
  const client = await connectWrapper(config, 'round2-forever-test');

  const created = await client.callTool({ name: 'create_session', arguments: {} });
  const { sessionId } = created.structuredContent as { sessionId: string };

  const startedAt = Date.now();
  // A promise that never settles is exactly what evaluate's own doc string
  // uses to describe why "0 waits forever" needs a wrapper-side ceiling at all.
  const result = await client.callTool(
    { name: 'evaluate', arguments: { sessionId, expression: 'new Promise(() => {})', timeoutMs: 0 } },
    { timeout: 30_000 }
  );
  const elapsedMs = Date.now() - startedAt;

  assert.ok(result.isError, `expected the ceiling to cut this off, got: ${JSON.stringify(result)}`);
  assert.ok(elapsedMs < 4000, `expected the ceiling to bound "forever", took ${elapsedMs}ms`);
  assert.ok(elapsedMs >= 1200, `expected the call to run for roughly the ceiling, took only ${elapsedMs}ms`);
});

test('a call whose timeoutMs exceeds 60s is no longer cut off at 60s by the wrapper (the slow one)', async () => {
  // The one test in this file allowed to actually run past a minute: proving
  // the OLD fixed 60000ms transport cutoff is gone requires living past it
  // for real. Kept to exactly one, and to as little over 60s as leaves a
  // safe margin: wait_for's own overhead was measured at single-digit
  // milliseconds (70000ms -> 70006ms), so one second of margin is generous,
  // not padding for its own sake.
  const config = await testConfig();
  const client = await connectWrapper(config, 'round2-past-60s-test');

  const created = await client.callTool({ name: 'create_session', arguments: {} });
  const { sessionId } = created.structuredContent as { sessionId: string };

  const startedAt = Date.now();
  const result = await client.callTool(
    { name: 'wait_for', arguments: { sessionId, selector: '#never-appears', timeoutMs: 61_000 } },
    // Generous on the outer (test -> wrapper) hop for the same reason as the
    // ceiling test above: only the wrapper -> daemon leg is under test here.
    { timeout: 120_000 }
  );
  const elapsedMs = Date.now() - startedAt;

  // Before this fix: an SdkError REQUEST_TIMEOUT at ~60002ms, carrying none
  // of wait_for's own context. Now: wait_for's own real failure, because the
  // wrapper's transport timeout (61000 + 10000 margin) outlasts it.
  assert.ok(result.isError, `expected wait_for's own timeout error, got: ${JSON.stringify(result)}`);
  const text = resultText(result);
  assert.match(text, /wait_for gave up after/, `expected wait_for's own message, got: ${text}`);
  assert.doesNotMatch(text, /request timed out/i, `must not be the bare transport timeout, got: ${text}`);
  assert.ok(elapsedMs > 60_000, `expected this to genuinely outlast the old 60s cutoff, took ${elapsedMs}ms`);
  assert.ok(elapsedMs < 65_000, `expected wait_for's own ~61000ms timeout to fire, not something later, took ${elapsedMs}ms`);
});
