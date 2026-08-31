import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Client } from '@modelcontextprotocol/client';
import type { McpServer } from '@modelcontextprotocol/server';

import { BrowserManager } from '../src/daemon/browserManager.js';
import { SessionStore } from '../src/daemon/sessions.js';
import { createServerFactory } from '../src/daemon/server.js';
import { createToolHandlers } from '../src/daemon/tools/handlers.js';
import { toolDefs, toolNames } from '../src/daemon/tools/schemas.js';
import { buildStdioServer } from '../src/client/wrapper.js';

/**
 * The complete tool surface, spelled out so adding or removing a tool is a
 * deliberate, reviewable edit here rather than a silent change.
 */
const expectedToolNames = [
  'click',
  'create_session',
  'drag',
  'escalate_session',
  'evaluate',
  'export_state',
  'file_upload',
  'fill',
  'hover',
  'list_network_requests',
  'list_sessions',
  'list_tabs',
  'navigate',
  'navigate_back',
  'navigate_forward',
  'press_key',
  'read_console',
  'release_session',
  'reload',
  'resize',
  'screenshot',
  'select_option',
  'send_cdp_command',
  'snapshot',
  'type',
  'wait_for',
  'wheel'
];

/**
 * The names actually registered on an `McpServer`, read from the SDK's own
 * `_registeredTools` map. It is private to TypeScript but a plain object at
 * runtime, and it is the only way to see what a server really registered
 * without speaking the protocol to it. If a future SDK version changes the
 * shape, the guard below fails loudly instead of silently asserting nothing.
 */
function registeredToolNames(server: McpServer): string[] {
  const registered = (server as unknown as { _registeredTools?: Record<string, unknown> })._registeredTools;
  assert.ok(
    registered && typeof registered === 'object',
    'McpServer no longer exposes _registeredTools; this test needs a new way to read a server\'s tool list.'
  );
  return Object.keys(registered).sort();
}

/** A wrapper-side `ensureReady` that must never be called: this test registers tools, it does not call them. */
const unusedEnsureReady = (): Promise<Client> => {
  throw new Error('buildStdioServer must not connect to a daemon just to register its tools');
};

test('every tool definition is complete', () => {
  for (const name of toolNames) {
    const def = toolDefs[name];
    assert.equal(typeof def.description, 'string', `${name} has no description`);
    assert.ok(def.description.trim().length > 0, `${name} has an empty description`);
    assert.equal(typeof def.handler, 'function', `${name} has no handler`);
    assert.ok(def.inputSchema, `${name} has no input schema`);
  }
});

test('the tool surface is exactly the twenty-seven tools listed here', () => {
  assert.deepEqual([...toolNames].sort(), expectedToolNames);
  assert.equal(toolNames.length, 27);
  assert.equal(new Set(toolNames).size, toolNames.length, 'duplicate tool name in toolDefs');
});

test('the daemon and the client wrapper register exactly the same tools', () => {
  const sessions = new SessionStore(new BrowserManager(0));
  const daemonServer = createServerFactory(sessions, {
    debugPort: 0,
    screenshotCacheDir: '/dev/null/unused',
    screenshotCacheTtlMs: 1000
  })();
  const wrapperServer = buildStdioServer(unusedEnsureReady);

  const daemonTools = registeredToolNames(daemonServer);
  const wrapperTools = registeredToolNames(wrapperServer);

  assert.deepEqual(daemonTools, expectedToolNames);
  assert.deepEqual(wrapperTools, daemonTools);
});

test('createToolHandlers binds exactly the tools in the registry', () => {
  const sessions = new SessionStore(new BrowserManager(0));
  const handlers = createToolHandlers(sessions, {
    debugPort: 0,
    screenshotCacheDir: '/dev/null/unused',
    screenshotCacheTtlMs: 1000
  });

  assert.deepEqual(Object.keys(handlers).sort(), expectedToolNames);
  for (const name of toolNames) {
    assert.equal(typeof handlers[name], 'function', `${name} is not bound to a function`);
  }
});
