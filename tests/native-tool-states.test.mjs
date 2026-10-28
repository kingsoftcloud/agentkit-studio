import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeToolStates } from '../src/providers/native-tool-states.mjs';
import { nativeTaskState } from '../src/client/dsh/session-task-events.mjs';
const record = () => ({ snapshot: { scope: { tenantId: 't', workspaceId: 'w', userId: 'u', agentId: 'a' }, runId: 'run' },
  intents: [{ kind: 'tool', operationKey: 'write', payload: { calls: [{ callId: 'write', name: 'write_workspace_file' }] } }],
  receipts: [{ operationKey: 'write', status: 'committed', result: { results: [{ status: 'uncertain', content: { code: 'tool_outcome_unknown' } }] } }] });
test('canonical unknown writes stay uncertain in a cancelled Session without changing published result messages', () => {
  const source = record(), before = structuredClone(source), toolStates = nativeToolStates(source);
  const state = { taskState: 'running', items: [{ kind: 'tool', callId: toolStates.calls[0].callId, status: 'failed' }] };
  const projected = nativeTaskState(state, { runId: 'run', phase: 'canceled', toolStates }, false);
  assert.equal(projected.taskState, 'cancelled'); assert.equal(projected.items[0].status, 'uncertain');
  assert.deepEqual(source, before); assert.doesNotMatch(JSON.stringify(toolStates), /tool_outcome_unknown|write_workspace_file/);
  assert.equal(nativeTaskState(state, { runId: 'another-run', phase: 'canceled', toolStates }, false).items[0].status, 'failed');
});
test('a later committed receipt observation supersedes uncertainty, while active calls have no invented result', () => {
  const source = record(); source.receipts = [];
  assert.deepEqual(nativeToolStates(source).calls, []);
  source.receipts = record().receipts;
  source.intents.push({ kind: 'tool_receipt', operationKey: 'observe', payload: { originalOperationKey: 'write' } });
  source.receipts.push({ operationKey: 'observe', status: 'committed', result: { result: { status: 'ok', content: 'private result' } } });
  assert.equal(nativeToolStates(source).calls[0].status, 'completed');
  assert.doesNotMatch(JSON.stringify(nativeToolStates(source)), /private result/);
});

test('only a current claimed tool is running; a published call and a stopped owner do not imply dispatch', () => {
  const source = record(); source.receipts = []; source.snapshot.phase = 'executing_tools'; source.snapshot.pendingIntent = 'write';
  assert.equal(nativeToolStates(source, { driving: true }).calls[0].status, 'running');
  assert.deepEqual(nativeToolStates(source, { driving: false }).calls, []);
  source.snapshot.pendingIntent = 'another'; assert.deepEqual(nativeToolStates(source, { driving: true }).calls, []);
});
