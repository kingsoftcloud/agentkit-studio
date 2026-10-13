import test from 'node:test';
import assert from 'node:assert/strict';
import * as plugin from '../src/index.mjs';
import { DSH_SESSION_EVENT_TYPES, DSH_ASSISTANT_STREAM_FRAME_TYPES, HARNESS_RUNTIME_CAPABILITIES, runtimeContract } from '../src/contract.mjs';
import manifest from '../agentkit-harness.plugin.json' with { type: 'json' };

test('package entry is a DSH plugin and exposes only DSH-owned runtime capabilities', () => {
  assert.equal(plugin.name, 'agentkit-harness');
  assert.deepEqual(plugin.inject, ['agents', 'sessions', 'llm']);
  assert.deepEqual(manifest.inject, ['agents', 'sessions', 'llm']);
  assert.equal(typeof plugin.apply, 'function');
  assert.equal(runtimeContract().persistenceOwner, 'dsh-session-persistence');
  assert.deepEqual(runtimeContract().sessionEvents, DSH_SESSION_EVENT_TYPES);
  assert.deepEqual(runtimeContract().assistantStreamFrames, DSH_ASSISTANT_STREAM_FRAME_TYPES);
  assert.ok(HARNESS_RUNTIME_CAPABILITIES.includes('dsh-session'));
  assert.ok(!HARNESS_RUNTIME_CAPABILITIES.includes('persistent-store'));
});

test('plugin fails closed when loaded outside a DSH context', () => {
  assert.throws(() => plugin.apply({}), /DSH AgentRegistry/);
});
