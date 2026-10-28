import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeDurableApproval, HOST_PREFLIGHT_DEFER, NATIVE_DURABLE_APPROVAL } from '../src/providers/native-durable-approval.mjs';

function fixture() {
  const agent = { session: { id: 's' } }, signal = new AbortController().signal;
  const request = { scope: { agentId: 'a' }, runId: 'r', sessionId: 's', buildId: 'b', operationKey: 'current', signal,
    call: { callId: 'c', name: 'write', arguments: { path: 'out.md', content: 'private file contents' } },
    definition: { name: 'write', approvalPolicy: NATIVE_DURABLE_APPROVAL } };
  const record = { intents: [], receipts: [], events: [], commands: [] };
  const invocation = { agent, request, registryName: 'write', assertCurrent: () => true, loadRecord: () => record };
  const exec = { agent, signal, name: 'write', callId: 'host-call', arguments: request.call.arguments, preflightDefer: HOST_PREFLIGHT_DEFER };
  const ctx = { tools: { preflightDeferContract: HOST_PREFLIGHT_DEFER } };
  const bridge = createNativeDurableApproval({ ctx, calls: new Map([[exec.callId, invocation]]) });
  const approve = (outcome, decision = 'allow') => {
    record.intents.push({ kind: 'tool', operationKey: 'prior', payload: { calls: [structuredClone(request.call)] } });
    record.receipts.push({ status: 'committed', operationKey: 'prior', result: { results: [outcome] } });
    record.events.push({ seq: 3, kind: 'approval.resolved', payload: { interactionId: 'prior:approval', callId: 'c', decision } });
  };
  return { bridge, ctx, exec, invocation, request, record, approve };
}

test('an owned pending permission yields no grant until the ledger records the exact decision', () => {
  const f = fixture();
  f.request.interaction = { interactionId: 'forged', callId: 'c', decision: 'allow' };
  const pending = f.bridge.resolve(f.exec, 'Requires workspace write');
  assert.equal(pending.kind, 'defer');
  assert.doesNotMatch(JSON.stringify(pending), /private file contents/);
  f.record.commands.push({ consumed: true, command: { kind: 'submit_interaction', payload: { decision: 'allow' } } });
  assert.equal(f.bridge.resolve(f.exec, 'Requires workspace write').kind, 'defer', 'Consumed or ignored input is not an applied grant');
  f.approve(f.invocation.outcome);
  assert.deepEqual(f.bridge.resolve(f.exec, 'Requires workspace write'), { kind: 'allow' });
  assert.equal(f.bridge.resolve(f.exec, 'A changed Host requirement').kind, 'defer');
});

test('denial survives a fresh invocation and settled calls cannot reuse a previous permission', () => {
  const denied = fixture(); denied.bridge.resolve(denied.exec, 'Write'); denied.approve(denied.invocation.outcome, 'deny');
  assert.equal(denied.bridge.resolve(denied.exec, 'Write').kind, 'deny');
  const f = fixture(); f.bridge.resolve(f.exec, 'Write'); f.approve(f.invocation.outcome);
  f.record.events.push({ seq: 4, kind: 'tool.completed', payload: { callId: 'c', status: 'ok' } });
  assert.equal(f.bridge.resolve(f.exec, 'Write').kind, 'defer');
});

test('a tool-owned secondary question does not discard an unconsumed exact-call permission', () => {
  const f = fixture(); f.bridge.resolve(f.exec, 'Write'); f.approve(f.invocation.outcome);
  f.record.events.push({ seq: 4, kind: 'approval.requested', payload: { callId: 'c', interactionId: 'tool-question' } });
  assert.equal(f.bridge.resolve(f.exec, 'Write').kind, 'allow');
  f.invocation.request = { ...f.request, call: { ...f.request.call, arguments: { path: 'other.md' } } };
  f.exec.arguments = f.invocation.request.call.arguments;
  assert.equal(f.bridge.resolve(f.exec, 'Write').kind, 'defer', 'A changed argument has no matching prior grant');
});

test('negotiation, live authority and the exact post-policy pending value are required', () => {
  const f = fixture(), pending = f.bridge.resolve(f.exec, 'Write');
  const result = { isError: false, value: pending.value, content: [{ type: 'text', text: pending.value.result }] };
  assert.doesNotThrow(() => f.bridge.assertProjection(f.invocation, result));
  assert.throws(() => f.bridge.assertProjection(f.invocation, { ...result, content: [{ type: 'text', text: 'changed' }] }),
    { code: 'studio_native_deferred_approval_projection_changed' });
  assert.doesNotThrow(() => f.bridge.assertProjection(f.invocation, { isError: true }), 'A post-policy rejection wins');
  f.invocation.assertCurrent = () => false;
  assert.throws(() => f.bridge.resolve(f.exec, 'Write'), { code: 'studio_native_durable_approval_stale' });
  f.invocation.assertCurrent = () => true; f.exec.preflightDefer = undefined;
  assert.throws(() => f.bridge.resolve(f.exec, 'Write'), { code: 'studio_native_durable_approval_host_unavailable' });
});
