import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeKernel, MemoryRunStore, configure, emptyUsage, planModeToolDefinitions, todoToolDefinitions,
  coordinatorResponseDefinition, planModeGuidance } from '../../agentkit-harness-core/dist/index.mjs';
import { fixture, scope, digest, tool } from '../../agentkit-harness-core/test/fixtures.mjs';
import { reduceTurnInput } from '../../agentkit-harness-core/dist/turn-input.mjs';
import { SqliteRunStore } from '../src/native/sqlite-store.mjs';
import { createNativeChildOwner } from '../src/native/child-owner.mjs';
import { nativeChildToolDefinitions } from '../src/native/child-tools.mjs';

const childScope = { ...scope, agentId: 'child-agent' };
const output = (text, toolCalls = []) => ({ kind: toolCalls.length ? 'tool_calls' : 'final_candidate', text, toolCalls, usage: emptyUsage() });
const call = (name, args = {}, callId = name) => ({ name, arguments: args, callId });

for (const backend of ['memory', 'sqlite']) for (const planMode of [false, true]) for (const background of [false, true])
test(`${backend}: ${background ? 'background' : 'foreground'} child inherits ${planMode ? 'Plan' : 'build'} and checks its own effects`, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'native-child-plan-'));
  const store = backend === 'sqlite' ? new SqliteRunStore(join(directory, 'runs.sqlite')) : new MemoryRunStore();
  const definitions = nativeChildToolDefinitions(['worker']), start = definitions[0], control = definitions[1];
  const write = tool({ name: 'write', readOnly: false, concurrentSafe: false }), read = tool({ name: 'read' });
  let childModels = 0, parentModels = 0, writes = 0, reads = 0;
  const ports = { tools: { execute: async request => {
    if (request.call.name === 'write') writes++;
    else { assert.equal(request.call.name, 'read'); reads++; }
    return { status: 'ok', content: request.call.name };
  } }, model: { generate: async request => {
    assert.equal(request.tools.some(tool => ['EnterPlanMode', 'ExitPlanMode'].includes(tool.name)), false);
    if (++childModels === 1) return output('', [call('write'), call('TodoWrite', { todos: [] }),
      call('RespondToCoordinator', { summary: 'Inspected', message: 'Child continues with inherited restrictions.' }), call('read')]);
    const results = request.messages.filter(message => message.role === 'tool');
    assert.equal(results[0].content.includes('plan_mode_write_denied'), planMode);
    if (planMode) { assert.match(results[0].content, /coordinator/); assert.doesNotMatch(results[0].content, /ExitPlanMode/); }
    return output('Child findings');
  } } };
  const childConfiguration = configure({ profile: fixture().config.profile, contract: { objective: 'Inspect source' }, hostBindingDigest: 'child',
    todoPolicy: 'session-todos/v1', coordinatorResponsePolicy: 'owned-parent-response/v1',
    tools: [write, read, ...todoToolDefinitions(), coordinatorResponseDefinition()], limits: { maxModelCalls: 3, maxToolCalls: 4 } });
  const owner = createNativeChildOwner({ scope, childScopes: [childScope], store,
    resolveChild: async () => ({ scope: childScope, configuration: childConfiguration, ports }), restoreChild: async () => ports });
  t.after(async () => { await owner.releaseRun({ scope, runId: 'run' }); store.close?.(); rmSync(directory, { recursive: true, force: true }); });
  const { config, snapshot } = fixture({ childPlanPolicy: 'inherit-plan/v1', childTaskPolicy: 'session-controls/v1',
    planModePolicy: 'session-plan/v1', planModeInitialActive: planMode, childLifecyclePolicy: 'owned-background/v2',
    tools: [...planModeToolDefinitions(), start, control], limits: { maxModelCalls: 20, maxToolCalls: 30, effectTimeoutMs: 130000 } });
  const kernel = new NativeKernel({ store, digest, owner: 'parent', ports: { children: owner,
    tools: { execute: request => request.call.name === start.name ? owner.start(request) : owner.control(request) },
    model: { generate: async request => {
      if (++parentModels === 1) return output('', [call(start.name, { role: 'worker', task: 'Inspect source', background })]);
      if (background && parentModels === 2) return output('', [call(control.name, {
        child_run_id: store.load(scope, 'run').snapshot.childRunIds[0], action: 'wait', wait_seconds: 1 })]);
      return output('Parent findings');
    } } } });
  kernel.start(snapshot, config); const done = await kernel.runUntilIdle(scope, 'run');
  assert.equal(done.phase, 'completed'); assert.equal(done.planMode.active, planMode); assert.equal(reads, 1); assert.equal(writes, planMode ? 0 : 1);
  assert.equal(childModels, 2); assert.equal(done.messages.filter(message => message.kind === 'child_response').length, 1);
  const child = store.load(childScope, done.childRunIds[0]);
  assert.equal(child.configuration.planModePolicy, 'inherited-child-plan/v1');
  assert.equal(child.configuration.childOwnerBinding.planMode, planMode); assert.equal(child.snapshot.planMode.active, planMode);
  assert.equal(child.snapshot.todos.revision, 1); assert.ok(done.childBudgetReservations[0].settledUsageDigest);
  assert.match(planModeGuidance(child.snapshot, child.configuration), /inherited/);
  assert.throws(() => reduceTurnInput(child.snapshot, { status: 'admitted', messages: [], planMode: !planMode }, child.configuration), /child_plan_mode_is_immutable/);
  assert.throws(() => configure({ ...child.configuration, tools: [...child.configuration.tools, ...planModeToolDefinitions()] }), /invalid_child_plan_binding/);
});

for (const backend of ['memory', 'sqlite']) test(`${backend}: exact parent plan approval rebinds a continued child Run without changing the original`, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'native-child-plan-approval-'));
  const store = backend === 'sqlite' ? new SqliteRunStore(join(directory, 'runs.sqlite')) : new MemoryRunStore();
  const definitions = nativeChildToolDefinitions(['worker']);
  const write = tool({ name: 'write', readOnly: false, concurrentSafe: false });
  const models = new Map(), writes = [];
  const childPorts = { model: { generate: async request => {
    const step = models.get(request.runId) ?? 0; models.set(request.runId, step + 1);
    return step === 0 ? output('', [call('write')]) : output(`Child evidence ${request.runId}`);
  } }, tools: { execute: async request => { writes.push(request.runId); return { status: 'ok', content: 'Written' }; } } };
  const owner = createNativeChildOwner({ scope, childScopes: [childScope], store,
    resolveChild: async request => ({ scope: childScope, configuration: configure({ profile: fixture().config.profile,
      contract: { objective: request.task }, hostBindingDigest: 'child', tools: [write], limits: { maxModelCalls: 3, maxToolCalls: 2 } }), ports: childPorts }),
    restoreChild: async () => childPorts });
  t.after(async () => { await owner.releaseRun({ scope, runId: 'run' }); store.close?.(); rmSync(directory, { recursive: true, force: true }); });
  const { config, snapshot } = fixture({ childPlanPolicy: 'inherit-plan/v1', planModePolicy: 'session-plan/v1', planModeInitialActive: true,
    childLifecyclePolicy: 'owned-background/v2', tools: [...planModeToolDefinitions(), ...definitions],
    limits: { maxModelCalls: 30, maxToolCalls: 30, effectTimeoutMs: 130000 } });
  let parentModels = 0, original;
  const kernel = new NativeKernel({ store, digest, owner: 'parent', ports: { children: owner,
    tools: { execute: request => owner.start(request) }, model: { generate: async () => {
      if (++parentModels === 1) return output('', [call('native_delegate', { role: 'worker', task: 'Explore' }, 'explore')]);
      if (parentModels === 2) {
        original = store.load(childScope, store.load(scope, 'run').snapshot.childRunIds[0]);
        return output('', [call('ExitPlanMode', { plan: 'Implement after reviewing the child findings.' })]);
      }
      if (parentModels === 3) return output('', [call('native_delegate', { role: 'worker', task: 'Implement',
        continuation_of: original.snapshot.runId }, 'implement')]);
      return output('Delivered');
    } } } });
  kernel.start(snapshot, config); const waiting = await kernel.runUntilIdle(scope, 'run');
  assert.equal(waiting.phase, 'awaiting_interaction'); assert.equal(waiting.planMode.active, true);
  assert.deepEqual(writes, []); assert.equal(original.snapshot.planMode.active, true);
  kernel.submit(scope, 'run', { commandId: 'approve', kind: 'submit_interaction', payload: {
    interactionId: waiting.pendingInteraction.interactionId, decision: 'allow' } });
  const done = await kernel.runUntilIdle(scope, 'run'); assert.equal(done.phase, 'completed'); assert.equal(done.planMode.active, false);
  assert.equal(done.childRunIds.length, 2); assert.deepEqual(store.load(childScope, original.snapshot.runId), original);
  const next = store.load(childScope, done.childRunIds[1]);
  assert.equal(next.snapshot.sessionId, original.snapshot.sessionId); assert.equal(next.snapshot.parentRunId, original.snapshot.runId);
  assert.equal(next.configuration.childOwnerBinding.planMode, false); assert.equal(next.snapshot.planMode.active, false);
  assert.deepEqual(writes, [next.snapshot.runId]); assert.ok(done.childBudgetReservations.every(row => row.settledUsageDigest));
});

test('Plan delegation fails closed without its actual child admission port; send/stop stay denied', async () => {
  const definitions = nativeChildToolDefinitions(['worker']), denied = [];
  const { config, snapshot } = fixture({ childPlanPolicy: 'inherit-plan/v1', planModePolicy: 'session-plan/v1', planModeInitialActive: true,
    childLifecyclePolicy: 'owned-background/v2', tools: [...planModeToolDefinitions(), ...definitions], limits: { effectTimeoutMs: 130000 } });
  let models = 0;
  const kernel = new NativeKernel({ store: new MemoryRunStore(), digest, owner: 'missing-owner', ports: {
    tools: { execute: async () => assert.fail('No bypass through an external child tool') },
    model: { generate: async request => {
      if (++models === 1) return output('', [call('native_start_child', { role: 'worker', task: 'Inspect' }),
        call('native_child_control', { child_run_id: 'foreign', action: 'send', message: 'Write now' }, 'send'),
        call('native_child_control', { child_run_id: 'foreign', action: 'stop' }, 'stop')]);
      denied.push(...request.messages.filter(message => message.role === 'tool')); return output('Denied');
    } } } });
  kernel.start(snapshot, config); assert.equal((await kernel.runUntilIdle(scope, 'run')).phase, 'completed');
  assert.equal(denied.length, 3); assert.ok(denied.every(message => message.content.includes('plan_mode_write_denied')));
});
