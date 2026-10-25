import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeKernel, emptyUsage } from '../packages/agentkit-harness-core/dist/index.mjs';
import { fixture, scope, digest, tool } from '../packages/agentkit-harness-core/test/fixtures.mjs';
import { SqliteRunStore } from '../packages/agentkit-harness/src/native/sqlite-store.mjs';
import { nativeChildToolDefinitions } from '../packages/agentkit-harness/src/native/child-tools.mjs';
import { createStudioNativeChildren, nativeChildRoles } from '../src/providers/native-subagents.mjs';

const output = (text, toolCalls = []) => ({ kind: toolCalls.length ? 'tool_calls' : 'final_candidate', text, toolCalls, usage: emptyUsage() });
for (const childTaskPolicy of [undefined, 'session-controls/v1']) test(`cold child owner retains ${childTaskPolicy ?? 'legacy absent'} session controls exactly`, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'native-child-policy-')), filename = join(directory, 'runs.sqlite');
  let store = new SqliteRunStore(filename), parentModels = 0;
  const owners = [], tools = [tool({ name: 'read_workspace_file' })], start = nativeChildToolDefinitions(['reader'])[0];
  t.after(async () => { for (const owner of owners) await owner.releaseRun({ scope, runId: 'run' }); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const roles = nativeChildRoles({ subAgents: [{ name: 'reader', instructions: 'Read source', tools: ['read_workspace_file'] }] });
  const makeChildren = () => createStudioNativeChildren({ roles, scope, sessionId: 'session', store, tools, childTaskPolicy,
    resolveModel: async () => ({ profile: fixture().config.profile, model: { generate: async request =>
      request.messages.some(message => message.role === 'tool') ? output('Restored child result')
        : output('', [{ name: 'read_workspace_file', callId: 'read', arguments: {} }]) } }),
    bindTools: authority => {
      assert.deepEqual(authority.toolNames, ['read_workspace_file']);
      return { tools: { execute: async request => request.interaction
        ? { status: 'ok', content: 'Approved actual read' } : { status: 'approval_required', content: {}, interactionId: 'approve-read' } } };
    }, verificationFactory: async () => undefined });
  const makeKernel = children => new NativeKernel({ store, digest, owner: `parent-${owners.length}`, ports: { children: children.owner,
    tools: { execute: request => children.execute(request) }, model: { generate: async () => ++parentModels === 1
      ? output('', [{ name: start.name, callId: 'start', arguments: { role: 'reader', task: 'Read source' } }]) : output('Parent final') } } });
  let children = await makeChildren(); owners.push(children.owner);
  const { config, snapshot } = fixture({ tools: [start], childLifecyclePolicy: 'owned-background/v2', childApprovalPolicy: 'owned-child-approval/v1',
    ...(childTaskPolicy ? { childTaskPolicy } : {}), limits: { maxModelCalls: 20, maxToolCalls: 30, effectTimeoutMs: 130000 } });
  let kernel = makeKernel(children); kernel.start(snapshot, config);
  const waiting = await kernel.runUntilIdle(scope, 'run'); assert.equal(waiting.phase, 'awaiting_interaction');
  const reservation = waiting.childBudgetReservations[0], before = store.load(reservation.childScope, reservation.childRunId).configuration;
  assert.equal(Object.hasOwn(before, 'todoPolicy'), Boolean(childTaskPolicy));
  assert.equal(Object.hasOwn(before, 'coordinatorResponsePolicy'), Boolean(childTaskPolicy));
  assert.equal(before.tools.some(tool => tool.name === 'RespondToCoordinator'), Boolean(childTaskPolicy));
  // No active worker exists at the durable approval boundary. Replace the store
  // connection, owner and parent Kernel; restore must use the original tool set.
  store.close(); owners.length = 0; store = new SqliteRunStore(filename);
  children = await makeChildren(); owners.push(children.owner); kernel = makeKernel(children); kernel.attach(scope, 'run');
  kernel.submit(scope, 'run', { commandId: 'approve', kind: 'submit_interaction', payload: {
    interactionId: waiting.pendingInteraction.interactionId, decision: 'allow' } });
  const done = await kernel.runUntilIdle(scope, 'run'); assert.equal(done.phase, 'completed', JSON.stringify({ reason: done.reason,
    child: store.load(reservation.childScope, reservation.childRunId).snapshot, receipts: store.load(scope, 'run').receipts.slice(-2) }));
  assert.equal(store.load(reservation.childScope, reservation.childRunId).snapshot.phase, 'completed');
  assert.deepEqual(store.load(reservation.childScope, reservation.childRunId).configuration, before);
  assert.equal(Object.hasOwn(store.load(scope, 'run').configuration, 'childTaskPolicy'), Boolean(childTaskPolicy));
});
