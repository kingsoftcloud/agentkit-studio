import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeKernel, MemoryRunStore, emptyUsage, planModeToolDefinitions } from '../packages/agentkit-harness-core/dist/index.mjs';
import { createNativeHostInteraction } from '../src/providers/native-host-interaction.mjs';
import { fixture, scope, digest } from '../packages/agentkit-harness-core/test/fixtures.mjs';

async function pending() {
  const { config, snapshot } = fixture({ planModePolicy: 'session-plan/v1', planModeInitialActive: true,
    tools: planModeToolDefinitions() });
  const store = new MemoryRunStore(), kernel = new NativeKernel({ store, digest, owner: 'review', ports: {
    model: { generate: async () => ({ kind: 'tool_calls', text: '', usage: emptyUsage(),
      toolCalls: [{ callId: 'exit', name: 'ExitPlanMode', arguments: { plan: 'Exact plan with rollback.\n' } }] }) },
    tools: { execute: async () => assert.fail('Session controls must remain internal') } } });
  kernel.start(snapshot, config); const waiting = await kernel.runUntilIdle(scope, 'run');
  assert.equal(waiting.phase, 'awaiting_interaction');
  return { store, kernel, waiting, payload: { agent: { session: { id: 'session' } }, signal: new AbortController().signal } };
}

for (const selected of [['Approve'], ['Keep planning'], ['Approve', 'Keep planning']]) {
  test(`Native plan uses the detailed existing review UI and fails closed for ${selected.join('/')}`, async () => {
    const f = await pending(); let questions = 0;
    const interact = createNativeHostInteraction({ store: f.store, ctx: { get: name => name === 'userQuestions'
      ? { ask: async request => {
        questions++; assert.equal(request.questions[0].detail, 'Exact plan with rollback.\n');
        assert.equal(request.questions[0].intent.kind, 'plan-review');
        assert.match(request.questions[0].intent.callId, /^ak-native-[a-f0-9]{64}$/);
        return { answers: [{ id: 'plan-review', selected }] };
      } } : { request: async () => assert.fail('Generic permission approval cannot approve a plan') } } });
    const command = await interact(f.payload, f.waiting); assert.equal(questions, 1);
    assert.equal(command.payload.decision, selected.length === 1 && selected[0] === 'Approve' ? 'allow' : 'deny');
    assert.equal(f.store.load(scope, 'run').snapshot.planMode.active, true, 'UI alone cannot mutate Native mode');
  });
}

test('custom review feedback cannot be interpreted as approval', async () => {
  const f = await pending();
  const interact = createNativeHostInteraction({ store: f.store, ctx: { get: name => name === 'userQuestions' ? {
    ask: async () => ({ answers: [{ id: 'plan-review', selected: ['Approve'], custom: 'Revise rollback first' }] }) } : undefined } });
  const command = await interact(f.payload, f.waiting);
  assert.equal(command.payload.decision, 'deny'); assert.equal(command.payload.feedback, 'Revise rollback first');
});

test('dismissed review ends work without another model call or a workspace grant', async () => {
  const f = await pending();
  const interact = createNativeHostInteraction({ store: f.store, ctx: { get: name => name === 'userQuestions' ? {
    ask: async () => { throw Object.assign(Error('Dismissed'), { code: 'ASK_CANCELLED' }); } } : undefined } });
  const command = await interact(f.payload, f.waiting); assert.equal(command.kind, 'cancel');
  f.kernel.submit(scope, 'run', command); const done = await f.kernel.runUntilIdle(scope, 'run');
  assert.equal(done.phase, 'canceled'); assert.equal(done.usage.modelCalls, 1); assert.equal(done.planMode.active, true);
});

test('missing plan review channel never falls back to generic tool approval', async () => {
  const f = await pending();
  const interact = createNativeHostInteraction({ store: f.store, ctx: { get: name => name === 'approval' ? {
    request: async () => assert.fail('A generic grant does not review the full plan') } : undefined } });
  assert.equal(await interact(f.payload, f.waiting), null);
});

test('a changed checkpoint invalidates an in-flight plan review result', async () => {
  const f = await pending();
  const interact = createNativeHostInteraction({ store: f.store, ctx: { get: name => name === 'userQuestions' ? {
    ask: async () => {
      f.kernel.submit(scope, 'run', { commandId: 'pause', kind: 'pause', payload: {} });
      await f.kernel.runUntilIdle(scope, 'run'); return { answers: [{ id: 'plan-review', selected: ['Approve'] }] };
    } } : undefined } });
  await assert.rejects(interact(f.payload, f.waiting), { code: 'studio_native_approval_checkpoint_stale' });
  assert.equal(f.store.load(scope, 'run').snapshot.planMode.active, true);
});
