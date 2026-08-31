import assert from 'node:assert/strict';
import { test } from 'node:test';

import { inspectTools } from '../src/daemon/tools/defs/inspect.js';

/**
 * A tool description is the only documentation an agent ever reads, so these
 * assert the specific things the QA round got wrong for want of a sentence.
 */

function describedFields(name: keyof typeof inspectTools): Record<string, string> {
  const shape = inspectTools[name].inputSchema.shape as Record<string, { description?: string }>;
  return Object.fromEntries(Object.entries(shape).map(([key, field]) => [key, field.description ?? '']));
}

test('no inspect tool description or field description contains an em-dash', () => {
  for (const [name, def] of Object.entries(inspectTools)) {
    assert.ok(!def.description.includes('—'), `${name}'s description still contains an em-dash`);
    for (const [field, text] of Object.entries(describedFields(name as keyof typeof inspectTools))) {
      assert.ok(!text.includes('—'), `${name}.${field}'s description still contains an em-dash`);
    }
  }
});

test('every field of every inspect tool is described', () => {
  for (const name of Object.keys(inspectTools) as (keyof typeof inspectTools)[]) {
    for (const [field, text] of Object.entries(describedFields(name))) {
      assert.ok(text.length > 0, `${name}.${field} has no .describe()`);
    }
  }
});

test('screenshot says what each mode actually hands back, and how to scope a capture', () => {
  const { description } = inspectTools.screenshot;
  assert.match(description, /base64/i);
  // "cached" returns a path, and a path is not something you can look at.
  assert.match(description, /path/i);
  assert.match(description, /read|open/i);
  assert.match(description, /selector/);
  assert.match(description, /clip/);
  assert.match(description, /width|height|dimension/i);
});

test('evaluate documents multi-line bodies, statements, async, and the function-string trap', () => {
  const { description } = inspectTools.evaluate;
  assert.match(description, /multi-line|multiline/i);
  assert.match(description, /statement/i);
  assert.match(description, /async|await/i);
  // A bare `() => ...` string is evaluated, never called: that silently
  // returns undefined and cost a QA agent real time.
  assert.match(description, /not called|never called|is not invoked/i);
});

test('list_network_requests warns that the buffer is bounded, so empty can mean evicted', () => {
  const { description } = inspectTools.list_network_requests;
  assert.match(description, /bounded|capped|limited/i);
  assert.match(description, /oldest|evict|drop/i);
});

test('send_cdp_command points captures at screenshot rather than growing a second capture path', () => {
  const { description } = inspectTools.send_cdp_command;
  assert.match(description, /screenshot/);
  assert.match(description, /selector/);
  assert.match(description, /clip/);
});
