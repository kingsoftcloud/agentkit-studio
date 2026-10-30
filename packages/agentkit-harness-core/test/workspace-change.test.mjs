import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeKernel, MemoryRunStore, emptyUsage, reduceTools, WORKSPACE_CHANGE_CONTRACT, validateWorkspaceChange } from '../dist/index.mjs';
import { fixture, tool, digest } from './fixtures.mjs';

const command = tool({ name: 'run_command', readOnly: false, concurrentSafe: false, workspaceChangePolicy: 'observed-command/v1' });
const observation = { contract: WORKSPACE_CHANGE_CONTRACT, status: 'unavailable', revision: null, reason: 'inventory_limit' };
const result = { status: 'ok', content: { exit_code: 0 }, workspaceChangeObservation: observation };

test('an incomplete change inventory preserves the committed process result and invalidates old workspace/browser evidence', () => {
  const { config, snapshot } = fixture({ tools: [command], workspaceObservationPolicy: { role: 'browser', pathSuffixes: ['.js'] } });
  const calls = [{ callId: 'command', name: 'run_command', arguments: {} }];
  const current = { ...snapshot, phase: 'executing_tools', workspaceRevision: 'old-revision',
    workspaceObservationStatus: 'captured', lastBrowserObservation: { toolCall: 0 }, pendingTools: calls };
  const changed = reduceTools(current, [result], calls, { operationKey: 'execute-once' }, config, digest);
  assert.equal(changed.pendingIntent, null); assert.deepEqual(changed.pendingTools, []);
  assert.equal(changed.reason, undefined); assert.equal(changed.outcome, undefined);
  assert.equal(changed.messages.at(-1).name, 'run_command');
  assert.match(changed.messages.at(-1).content, /"exit_code":0/);
  assert.equal(changed.workspaceRevision, null);
  assert.equal(changed.workspaceObservationStatus, 'unavailable');
  assert.equal(changed.workspaceDirtySinceCheckpoint, true);
  assert.equal(changed.lastWorkspaceMutationToolCall, 1);
  assert.equal(changed.lastWebMutationToolCall, 1);
  assert.deepEqual(changed.workspaceModifiedPaths, []);
});

test('a command with an unavailable inventory continues the task without replay or an unknown-effect interruption', async () => {
  const store = new MemoryRunStore(), { config, snapshot } = fixture({ tools: [command] });
  store.create(config, snapshot); let models = 0, executed = 0;
  const kernel = new NativeKernel({ store, digest, owner: 'worker', ports: {
    model: { generate: async () => ++models === 1 ? { kind: 'tool_calls', text: '',
      toolCalls: [{ callId: 'once', name: 'run_command', arguments: {} }], usage: emptyUsage() }
      : { kind: 'final_candidate', text: 'Command completed; changed-file inventory unavailable.', toolCalls: [], usage: emptyUsage() } },
    tools: { execute: async () => { executed++; return result; } },
  } });
  const done = await kernel.runUntilIdle(snapshot.scope, snapshot.runId);
  assert.equal(executed, 1); assert.equal(models, 2); assert.equal(done.phase, 'completed');
  assert.notEqual(done.reason, 'effect_outcome_unknown');
  assert.equal(done.workspaceObservationStatus, 'unavailable');
  assert.equal(done.outcome, 'unverified');
});

test('only a pinned mutating command can submit a complete or unavailable inventory; unknown never means no changes', () => {
  assert.deepEqual(validateWorkspaceChange(result, command), observation);
  assert.throws(() => validateWorkspaceChange(result, tool()), { code: 'workspace_change_not_owned' });
  for (const invalid of [
    { ...result, workspaceChangedPaths: [] },
    { ...result, workspaceChangeObservation: { ...observation, revision: 'pretend-complete' } },
    { ...result, workspaceChangeObservation: { ...observation, reason: 'arbitrary exception text' } },
  ]) assert.throws(() => validateWorkspaceChange(invalid, command), { code: 'invalid_workspace_change_observation' });
  const captured = { ...result, workspaceChangedPaths: ['index.html'], workspaceChangeObservation: {
    contract: WORKSPACE_CHANGE_CONTRACT, status: 'captured', revision: 'new-revision', reason: null } };
  assert.equal(validateWorkspaceChange(captured, command).revision, 'new-revision');
  assert.throws(() => fixture({ tools: [{ ...command, name: 'arbitrary-tool' }] }), { code: 'invalid_workspace_change_policy' });
});
