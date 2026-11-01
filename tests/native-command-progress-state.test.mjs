import test from 'node:test';
import assert from 'node:assert/strict';
import { createStudioNativeCommandProgress } from '../src/host/services/native-command-progress.mjs';
const tick = () => new Promise(resolve => setImmediate(resolve));
const scope = { tenantId: 'local', workspaceId: 'w', userId: 'local-user', agentId: 'a' };
function fixture(project) {
  const controller = new AbortController();
  const request = { scope, runId: 'r', sessionId: 's', operationKey: 'op', executionFence: 2,
    call: { callId: 'c', name: 'run_command', arguments: { command: 'controlled' } } };
  const record = { snapshot: { scope, runId: 'r', sessionId: 's', phase: 'executing_tools', pendingIntent: 'op' },
    lease: { fence: 2, expiresAt: 2000 }, receipts: [],
    intents: [{ operationKey: 'op', kind: 'tool', status: 'running', claimedFence: 2, payload: { calls: [request.call] } }] };
  const owner = createStudioNativeCommandProgress({ workspaceId: 'w', now: () => 1000, project });
  const observation = owner.begin({ request, signal: controller.signal, agent: {}, assertCurrent: () => true });
  return { owner, observation, request, record, controller };
}
test('operator preview comes only from the required projector and is scoped to its live claimed call', async () => {
  const f = fixture(source => ({ kind: 'command_preview', stdout: source.stdout.replaceAll('private', '[hidden]'), stderr: '' }));
  const before = structuredClone(f.record);
  try {
    f.observation.observe({ contract: 'agentkit.local-command-progress/v1', sequence: 1, channel: 'stdout', text: 'private' }); await tick();
    const view = f.owner.read(f.record);
    const pending = f.record.intents[0];
    const readModel = { contract: 'agentkit.native-run-observation/v1', snapshot: f.record.snapshot, lease: f.record.lease,
      facts: { pendingEffect: { operationKey: pending.operationKey, kind: pending.kind, status: pending.status,
        claimedFence: pending.claimedFence, receiptPresent: false,
        calls: pending.payload.calls.map(({ callId, name }) => ({ callId, name })) } } };
    assert.deepEqual(f.owner.read(readModel), view);
    assert.equal(f.owner.read({ ...readModel, facts: { pendingEffect: { ...readModel.facts.pendingEffect, receiptPresent: true } } }), null);
    assert.equal(view.contract, 'agentkit.native-command-previews/v1'); assert.equal(view.calls[0].display.stdout, '[hidden]');
    for (const mutate of [r => { r.snapshot.runId = 'other'; }, r => { r.snapshot.sessionId = 'other'; },
      r => { r.snapshot.scope.agentId = 'other'; }, r => { r.lease.fence = 3; }, r => { r.lease.expiresAt = 999; },
      r => { r.snapshot.phase = 'completed'; }, r => { r.receipts.push({ operationKey: 'op', status: 'committed' }); },
      r => { r.intents[0].payload.calls[0].callId = 'other'; }]) {
      const changed = structuredClone(f.record); mutate(changed); assert.equal(f.owner.read(changed), null);
    }
    assert.deepEqual(f.record, before);
    f.controller.abort(); assert.equal(f.owner.read(f.record), null);
    f.observation.close(); assert.equal(f.owner.read(f.record), null);
    assert.equal(f.owner.begin({ request: { ...f.request, scope: { ...scope, tenantId: 'managed' } },
      signal: f.controller.signal, assertCurrent: () => true }), null);
  } finally { f.owner.close(); }
});
test('closing a tool invocation suppresses an in-flight output policy response', async () => {
  let resolve;
  const f = fixture(() => new Promise(done => { resolve = done; }));
  f.observation.observe({ contract: 'agentkit.local-command-progress/v1', sequence: 1, channel: 'stdout', text: 'held' });
  f.observation.close(); resolve({ kind: 'command_preview', stdout: 'late', stderr: '' }); await tick();
  assert.equal(f.owner.read(f.record), null); f.owner.close();
});
