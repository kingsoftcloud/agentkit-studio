import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NativeKernel, MemoryRunStore, configure, emptyUsage, todoToolDefinitions, coordinatorResponseDefinition } from '../../agentkit-harness-core/dist/index.mjs';
import { fixture, scope, digest, tool } from '../../agentkit-harness-core/test/fixtures.mjs';
import { SqliteRunStore } from '../src/native/sqlite-store.mjs';
import { createNativeChildOwner } from '../src/native/child-owner.mjs';
import { nativeChildToolDefinitions } from '../src/native/child-tools.mjs';

const childScope = { ...scope, agentId: 'child-agent' };
const output = (text = '', toolCalls = []) => ({ kind: toolCalls.length ? 'tool_calls' : 'final_candidate', text, toolCalls, usage: emptyUsage() });
const todo = content => ({ content, status: 'in_progress', priority: 'high' });
const call = (name, args, callId = name) => ({ name, arguments: args, callId });

for (const backend of ['memory', 'sqlite']) for (const foreground of [false, true])
test(`${backend}: ${foreground ? 'foreground' : 'live background'} child owns its Todo and reports without completing`, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'native-coordinator-owner-'));
  const store = backend === 'sqlite' ? new SqliteRunStore(join(directory, 'runs.sqlite')) : new MemoryRunStore();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let childModels = 0, parentModels = 0, childReads = 0, sawLive = false;
  const read = tool({ name: 'read_evidence' }), controls = [...todoToolDefinitions(), coordinatorResponseDefinition()];
  const childConfig = configure({ profile: fixture().config.profile, contract: { objective: 'Find and fix' }, hostBindingDigest: 'child',
    todoPolicy: 'session-todos/v1', coordinatorResponsePolicy: 'owned-parent-response/v1', tools: [read, ...controls], limits: { maxModelCalls: 5, maxToolCalls: 4 } });
  const ports = { model: { generate: async request => {
    childModels++;
    if (childModels === 1) return output('', [call('TodoWrite', { todos: [todo('Child-only task')] })]);
    if (childModels === 2) return output('', [call('RespondToCoordinator', { summary: 'Found cause', message: 'Working on the fix; not finished.' })]);
    if (childModels === 3) {
      assert.match(request.messages.at(-1).content, /Continue the current task/);
      return output('', [call('read_evidence', {})]);
    }
    return output('Final child result');
  } }, tools: { execute: async request => {
    assert.equal(request.call.name, 'read_evidence');
    if (!foreground) await gate;
    request.signal.throwIfAborted(); childReads++; return { status: 'ok', content: 'Actual child evidence' };
  } } };
  const owner = createNativeChildOwner({ scope, childScopes: [childScope], store,
    resolveChild: async () => ({ scope: childScope, configuration: childConfig, ports }), restoreChild: async () => ports });
  t.after(async () => { release(); await owner.releaseRun({ scope, runId: 'run' }); store.close?.(); rmSync(directory, { recursive: true, force: true }); });
  const start = nativeChildToolDefinitions(['worker'])[0], heartbeat = tool({ name: 'parent_read' });
  const { config, snapshot } = fixture({ childTaskPolicy: 'session-controls/v1', childLifecyclePolicy: 'owned-background/v2',
    todoPolicy: 'session-todos/v1', tools: [...todoToolDefinitions(), start, heartbeat], limits: { maxModelCalls: 30, maxToolCalls: 100, effectTimeoutMs: 130000 } });
  const kernel = new NativeKernel({ store, digest, owner: 'parent', ports: { children: owner,
    tools: { execute: async request => request.call.name === start.name ? owner.start(request) : { status: 'ok', content: 'Parent read' } },
    model: { generate: async request => {
      parentModels++;
      if (parentModels === 1) return output('', [call('TodoWrite', { todos: [todo('Parent-only task')] })]);
      if (parentModels === 2) return output('', [call(start.name, { role: 'worker', task: 'Find and fix', background: !foreground,
        model_call_limit: 5, tool_call_limit: 4 }), call('parent_read', {}, 'same-batch-read')]);
      if (request.messages.some(message => message.kind === 'child_response')) {
        const batchIndex = request.messages.findIndex(message => message.toolCalls?.some(item => item.name === start.name));
        assert.deepEqual(request.messages.slice(batchIndex + 1, batchIndex + 3).map(message => message.role), ['tool', 'tool']);
        const report = request.messages.find(message => message.kind === 'child_response');
        assert.match(report.content, /not finished/); assert.equal(JSON.parse(report.content).parentAcceptance, 'not_evaluated');
        const child = store.list(childScope)[0];
        if (!foreground && !sawLive) { assert.notEqual(child.phase, 'completed'); assert.equal(childReads, 0); sawLive = true; release(); }
        return output('Parent uses final child evidence only after collection');
      }
      await new Promise(resolve => setTimeout(resolve, 5));
      return output('', [call('parent_read', {}, `parent-read-${parentModels}`)]);
    } } } });
  kernel.start(snapshot, config); const done = await kernel.runUntilIdle(scope, 'run');
  assert.equal(done.phase, 'completed'); assert.equal(childReads, 1); assert.equal(childModels, 4);
  if (!foreground) assert.equal(sawLive, true);
  assert.deepEqual(done.todos.items, [todo('Parent-only task')]);
  assert.equal(done.messages.filter(message => message.kind === 'child_response').length, 1);
  const child = store.load(childScope, done.childRunIds[0]);
  assert.equal(child.snapshot.phase, 'completed'); assert.deepEqual(child.snapshot.todos.items, [todo('Child-only task')]);
  assert.equal(child.events.filter(event => event.kind === 'coordinator.response_queued').length, 1);
  assert.equal(done.childResponseCursors[child.snapshot.runId], child.events.find(event => event.kind === 'coordinator.response_queued').seq);
  assert.ok(done.childBudgetReservations[0].settledUsageDigest); assert.equal(done.descendantUsage.modelCalls, 4);
  assert.deepEqual(done.queuedGuidance, []); assert.equal(done.goalRevision, 0);
});
