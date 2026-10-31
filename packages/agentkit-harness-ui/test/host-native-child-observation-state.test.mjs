import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeChildObservationState } from '../src/host/state/native-child-observation.mjs';
import { bindNativeSubagents } from '../src/host/session-task-events.mjs';
import { initialState, reduceAll } from '@kingsoftcloud/agentkit-harness-ui/reducer';

test('parallel child identities follow parent call IDs even when children arrive in reversed order', () => {
  const state = reduceAll(initialState(), [
    { v: 1, id: 'one', type: 'tool.scheduled', callId: 'call-a', name: 'native_start_child', input: { role: 'reader' } },
    { v: 1, id: 'two', type: 'tool.scheduled', callId: 'call-b', name: 'native_start_child', input: { role: 'reader' } },
  ]);
  const child = (id, call) => ({ childRunId: id, parentToolCallId: call, parentRunId: 'parent', sessionId: id + '-session', role: 'reader', goalPreview: id, snapshotRevision: 1 });
  const next = bindNativeSubagents(state, [child('child-b', 'call-b'), child('child-a', 'call-a'), child('other', 'missing')]);
  assert.equal(next.items[0].child.runId, 'child-a'); assert.equal(next.items[1].child.runId, 'child-b');
  assert.equal(state.items[0].child, undefined);
});
test('read-only child mapping retains live provider content, known failures and scope identity', () => {
  const detail = { task: { childRunId: 'child', sessionId: 's' }, observation: { contract: 'agentkit.native-child-observation/v1',
    runId: 'child', sessionId: 's', snapshotRevision: 2, driving: true, phase: 'requesting_model', prompt: { text: 'Read source' },
    rows: [{ id: 'call', kind: 'tool', name: 'read_workspace_file', input: { text: '{"path":"a.mjs"}' }, status: 'failed', result: { text: 'file missing' } }],
    live: { operationKey: 'inference', thinking: 'Actual provider thought', text: 'Actual partial reply' } } };
  const view = nativeChildObservationState(detail);
  assert.equal(view.state.items.find(item => item.callId === 'call').status, 'failed');
  assert.equal(view.state.items.find(item => item.kind === 'thought').text, 'Actual provider thought');
  assert.equal(view.state.items.at(-1).streaming, true);
  detail.observation.driving = false; detail.observation.live = null;
  assert.equal(nativeChildObservationState(detail).state.taskState, 'interrupted');
  detail.observation.runId = 'other'; assert.throws(() => nativeChildObservationState(detail), /不一致/);
});
