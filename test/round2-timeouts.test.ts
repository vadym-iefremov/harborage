import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

import { cliEntry, cleanupTempDirs, daemonHealth, makeTestConfig, waitFor, wrapperEnv } from './helpers.js';
import type { Config } from '../src/shared/config.js';
import { toolDefs } from '../src/daemon/tools/schemas.js';
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
