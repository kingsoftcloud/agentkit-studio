import test from 'node:test';
import assert from 'node:assert/strict';
import { canonical } from '../packages/agentkit-harness-core/dist/index.mjs';
import { managedNativeOwnerProjection, STUDIO_MANAGED_NATIVE_EXECUTION } from '../src/host/services/native-managed-execution.mjs';

const owner = turn => ({ contract: 'dsh.external-turn/v1', turn, engine: STUDIO_MANAGED_NATIVE_EXECUTION,
  binding: canonical({ contract: STUDIO_MANAGED_NATIVE_EXECUTION, configDigest: 'a'.repeat(64), identity: {
    scope: { tenantId: 'tenant', agentId: 'agent', userId: 'user', workspaceId: 'workspace' },
    runId: 'original-run', sessionId: 'original-session', turnId: 'original-command', buildId: 'build', parentRunId: null, taskChainId: 'chain',
  } }) });

test('managed owner fold rebuilds the same closed identity and does not adopt another engine', () => {
  const projection = managedNativeOwnerProjection(), original = owner(2);
  const events = [{ type: 'turn/start', data: { turn: 2 } }, { type: 'turn/owner', data: original },
    { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },
    { type: 'turn/start', data: { turn: 3 } }, { type: 'turn/owner', data: { ...owner(3), engine: 'different-engine/v1' } },
    { type: 'turn/end', data: { turn: 3 } }];
  const fold = () => events.reduce((state, event) => projection.apply(state, event), projection.init());
  assert.deepEqual(fold(), { current: null, lastClosed: original }); assert.deepEqual(fold(), fold());
  assert.deepEqual(projection.stateSchema.parse(JSON.parse(JSON.stringify(fold()))), fold());
});

test('a mismatched Session turn end cannot claim that the managed owner closed', () => {
  const projection = managedNativeOwnerProjection(), original = owner(1);
  const state = projection.apply(projection.init(), { type: 'turn/owner', data: original });
  assert.deepEqual(projection.apply(state, { type: 'turn/end', data: { turn: 2 } }), { current: original, lastClosed: null });
});

test('invalid managed ownership cannot enter a live or restored projection', () => {
  const projection = managedNativeOwnerProjection();
  for (const invalid of [{ ...owner(1), binding: '{}' }, { ...owner(1), turn: 0 }, { ...owner(1), binding: '{"contract":1,"contract":2}' }]) {
    assert.throws(() => projection.apply(projection.init(), { type: 'turn/owner', data: invalid }));
    assert.throws(() => projection.stateSchema.parse({ current: invalid, lastClosed: null }));
  }
});
