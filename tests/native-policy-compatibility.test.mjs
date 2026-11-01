import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeKernel, MemoryRunStore, canonical, emptyUsage } from '@kingsoftcloud/agentkit-harness-core';
import { fixture, scope, digest } from './fixtures/native-core.mjs';
import { freezeNativeDshConfiguration, rebindNativeDshConfiguration, NATIVE_DSH_TURN_CONTRACT } from '@kingsoftcloud/agentkit-harness-node/native/dsh-turn-runtime';
import { restoredPolicyConfiguration } from '../src/host/services/native-harness-bindings.mjs';
import { nativeDshOwnership, readNativeDshOwnership } from '@kingsoftcloud/agentkit-harness-node/native/dsh-turn-ownership';

test('historical Studio/DSH ownership revalidates without adding manifests or changing its original digest', async () => {
  const input = { messages: [{ role: 'user', id: 'legacy-input', content: [{ type: 'text', text: 'Continue old task' }] }] };
  const { config, snapshot } = fixture({ inputMessages: [{ role: 'user', content: 'Continue old task' }] }), source = { provider: 'fixture', model: 'test' };
  const binding = { scope, buildId: snapshot.buildId, source, configuration: config };
  const old = freezeNativeDshConfiguration(binding, input); delete old.policyModules;
  const identity = { ...snapshot, turnId: '1', runId: `native-dsh-${digest({ contract: NATIVE_DSH_TURN_CONTRACT,
    scope, sessionId: snapshot.sessionId, turn: 1 })}` };
  const store = new MemoryRunStore(), kernel = new NativeKernel({ store, digest, owner: 'restored', ports: {
    model: { generate: async () => ({ kind: 'final_candidate', text: 'Restored', toolCalls: [], usage: emptyUsage() }) },
    tools: { execute: async () => assert.fail('No tools') } } });
  const current = kernel.start(identity, old), record = store.load(scope, current.runId);
  const ownership = nativeDshOwnership({ identity: Object.fromEntries(['scope','runId','sessionId','turnId','buildId','parentRunId','taskChainId'].map(k => [k, current[k]])),
    configuration: old, input, source });
  assert.equal(readNativeDshOwnership(ownership, { sessionId: current.sessionId, turn: 1 }).configDigest, digest(old));
  const restored = rebindNativeDshConfiguration(record, binding, { agent: { session: { id: current.sessionId } }, turn: 1, input });
  assert.equal(canonical(restored), canonical(old));
  assert.equal((await kernel.runUntilIdle(scope, current.runId)).finalText, 'Restored');
  assert.equal(store.load(scope, current.runId).configuration.policyModules, undefined);
  assert.throws(() => rebindNativeDshConfiguration(record, { ...binding, configuration: { ...config,
    policyModules: [...config.policyModules, { id: 'changed.strategy', version: '1', implementation: 'changed/v1' }] } },
  { agent: { session: { id: current.sessionId } }, turn: 1, input }), /native_dsh_recovery_configuration_changed/);
});

test('Studio binding reconstruction preserves explicit modules and legacy absence without aliasing', () => {
  const { config } = fixture();
  const restored = restoredPolicyConfiguration({ configuration: config });
  assert.deepEqual(restored.policyModules, config.policyModules);
  restored.policyModules[0].version = 'mutated';
  assert.equal(config.policyModules[0].version, '1');
  delete config.policyModules;
  assert.deepEqual(restoredPolicyConfiguration({ configuration: config }), { engine: config.engine });
  assert.deepEqual(restoredPolicyConfiguration(), {});
});
