import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryRunStore, NativeKernel, configure } from '@kingsoftcloud/agentkit-harness-core';
import { fixture, scope, digest, tool } from './fixtures/native-core.mjs';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { freezeNativeDshConfiguration, rebindNativeDshConfiguration } from '@kingsoftcloud/agentkit-harness-node/native/dsh-turn-runtime';
import { nativeRecoveryBinding, readNativeRecoveryBinding, assertNativeRecoveryPreset } from '../src/providers/native-recovery-binding.mjs';

function admission() {
  const binding = { agentId: scope.agentId, agentRevision: 3, buildId: 'frozen-build', runtime: 'harness', local: true,
    nativeEngineContract: 'agentkit.native-dsh-turn/v1' };
  const input = { kind: 'enter', messages: [{ id: 'original-input', role: 'user', content: [
    { type: 'text', text: 'Keep the original task' }, { type: 'image', attachmentId: 'original-image' },
  ] }] };
  const source = { provider: 'original-provider', model: 'original-model' };
  const capsule = nativeRecoveryBinding({ binding, input, source, selection: { maxTokens: 4096 }, systemPrompt: 'Frozen prompt' });
  const config = fixture({ tools: [tool({ name: 'read' })], inputMessages: [{ role: 'user', content: 'Original admitted input' }] }).config;
  return { binding, input, capsule, payload: { input, agent: { session: { id: 'session' } }, turn: 1 }, execution: { scope, buildId: binding.buildId, source,
    configuration: { ...config, hostRecoveryBinding: capsule }, ports: {} } };
}

for (const sqlite of [false, true]) test(`${sqlite ? 'SQLite reopen' : 'memory'}: recovery admission and exact configuration survive without creating a replacement Run`, t => {
  const directory = mkdtempSync(join(tmpdir(), 'native-recovery-binding-'));
  let store = sqlite ? new SqliteRunStore(join(directory, 'runs.sqlite')) : new MemoryRunStore();
  t.after(() => { store.close?.(); rmSync(directory, { recursive: true, force: true }); });
  const f = admission(), configuration = freezeNativeDshConfiguration(f.execution, f.input);
  new NativeKernel({ store, digest, owner: 'original', ports: {} }).start({ scope, sessionId: 'session', runId: 'run',
    turnId: '1', taskChainId: 'session', buildId: 'frozen-build', parentRunId: null }, configuration);
  if (sqlite) { store.close(); store = new SqliteRunStore(join(directory, 'runs.sqlite')); }
  const record = store.load(scope, 'run'), before = structuredClone(record), identity = { agentId: scope.agentId, sessionId: 'session', runId: 'run' };
  const capsule = readNativeRecoveryBinding(record, identity);
  assertNativeRecoveryPreset(capsule, f.binding);
  assert.deepEqual(capsule, f.capsule);
  assert.deepEqual(rebindNativeDshConfiguration(record, f.execution, { ...f.payload, input: { messages: capsule.messages } }), configuration);
  capsule.messages[0].content[0].text = 'Mutated caller copy'; capsule.source.model = 'Other';
  assert.deepEqual(store.load(scope, 'run'), before);
  assert.equal(store.list(scope).length, 1);
  assert.equal(store.sessionHead(scope, 'session').runId, 'run');
  for (const changed of [{ agentId: 'other' }, { sessionId: 'other' }, { runId: 'other' }])
    assert.throws(() => readNativeRecoveryBinding(record, { ...identity, ...changed }), /recovery_identity_mismatch/);
  for (const changed of [{ agentRevision: 4 }, { agentId: 'other' }, { buildId: 'replacement' }, { runtime: 'codex' }, { local: false },
    { nativeEngineContract: 'unknown-engine/v2' }])
    assert.throws(() => assertNativeRecoveryPreset(f.capsule, { ...f.binding, ...changed }), /recovery_preset_changed/);
});

test('recovery rejects model/tool/permission/input/prompt/budget drift before any model or tool port can run', () => {
  const f = admission(), configuration = freezeNativeDshConfiguration(f.execution, f.input);
  const record = { configuration, snapshot: { scope, sessionId: 'session', turnId: '1', buildId: f.binding.buildId, configDigest: digest(configuration) } };
  let effects = 0;
  const ports = { model: { generate() { effects++; } }, tools: { execute() { effects++; } } };
  for (const changed of [
    { source: { ...f.execution.source, model: 'new-model' } },
    { configuration: { ...f.execution.configuration, tools: [tool({ name: 'write', readOnly: false, concurrentSafe: false })] } },
    { configuration: { ...f.execution.configuration, hostBindingDigest: 'changed-permission-pipeline' } },
    { configuration: { ...f.execution.configuration, instructions: 'Different prompt' } },
    { configuration: { ...f.execution.configuration, limits: { ...f.execution.configuration.limits, maxToolCalls: 99 } } },
    { configuration: { ...f.execution.configuration, hostRecoveryBinding: { ...f.capsule, agentRevision: 4 } } },
  ]) assert.throws(() => rebindNativeDshConfiguration(record, { ...f.execution, ports, ...changed }, f.payload), /recovery_configuration_changed/);
  assert.throws(() => rebindNativeDshConfiguration(record, f.execution, { ...f.payload, input: { messages: [{ ...f.input.messages[0], id: 'new-input' }] } }), /recovery_configuration_changed/);
  assert.throws(() => rebindNativeDshConfiguration(record, { ...f.execution, scope: { ...scope, userId: 'foreign' } }, f.payload), /recovery_identity_mismatch/);
  assert.throws(() => rebindNativeDshConfiguration(record, { ...f.execution, buildId: 'replacement' }, f.payload), /recovery_identity_mismatch/);
  assert.throws(() => rebindNativeDshConfiguration(record, f.execution, { ...f.payload, turn: 2 }), /recovery_identity_mismatch/);
  assert.throws(() => rebindNativeDshConfiguration(record, f.execution, { ...f.payload, agent: { session: { id: 'foreign' } } }), /recovery_identity_mismatch/);
  assert.equal(effects, 0);
});

test('opaque Host locators are validated and included in the core configuration digest, while old Runs remain readable', () => {
  const f = admission(), configuration = freezeNativeDshConfiguration(f.execution, f.input);
  const snapshot = { scope, sessionId: 'session', runId: 'run', configDigest: digest(configuration) };
  const identity = { agentId: scope.agentId, sessionId: 'session', runId: 'run' };
  assert.throws(() => readNativeRecoveryBinding({ configuration: { ...configuration, instructions: 'tampered' }, snapshot }, identity), /stored_configuration_mismatch/);
  const legacy = { ...configuration }; delete legacy.hostRecoveryBinding;
  assert.throws(() => readNativeRecoveryBinding({ configuration: legacy, snapshot: { ...snapshot, configDigest: digest(legacy) } }, identity), /recovery_binding_missing/);
  assert.deepEqual(configure(legacy), legacy);
  for (const hostRecoveryBinding of ['string', null, []]) assert.throws(() => configure({ ...configuration, hostRecoveryBinding }), /invalid_host_recovery_binding/);
  for (const changed of [{ agentRevision: 0 }, { maxTokens: 0 }, { buildId: '' }, { messages: [] }, { unknown: true }]) {
    const invalid = { ...configuration, hostRecoveryBinding: { ...f.capsule, ...changed } };
    assert.throws(() => readNativeRecoveryBinding({ configuration: invalid, snapshot: { ...snapshot, configDigest: digest(invalid) } }, identity), /recovery_binding_invalid/);
  }
});
