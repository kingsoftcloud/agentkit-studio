import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeKernel, MemoryRunStore, configure, emptyUsage, canonical, admitBackgroundNotification,
  BACKGROUND_COMMAND_CONTRACT } from '@kingsoftcloud/agentkit-harness-core';
import { freezeNativeDshConfiguration } from '@kingsoftcloud/agentkit-harness-node/native/dsh-turn-runtime';
import { scope, digest, tool } from './fixtures/native-core.mjs';

const launch = tool({ name: 'run_command', readOnly: false, concurrentSafe: false, backgroundCommandPolicy: 'owned-command-launch/v1' });
const finish = () => ({ kind: 'final_candidate', text: 'Done', toolCalls: [], usage: emptyUsage() });
const identity = runId => ({ scope, runId, sessionId: 'session', turnId: runId, buildId: 'build', parentRunId: null, taskChainId: 'chain' });
function frozen(text, { declared = 'same-execution-resources', instructions = 'Stable instructions', ...overrides } = {}, original) {
  const config = configure({ profile: { profileId: 'test', profileVersion: '1', providerFamily: 'fixture', compatibilityDigest: 'fixture/v1' },
    tools: [launch], contract: { objective: text }, inputMessages: [{ role: 'user', content: text }], instructions,
    hostBindingDigest: declared, backgroundNotificationPolicy: 'completed-before-model/v1', sessionInjectionPolicy: 'next-turn-inbox/v1',
    limits: { maxModelCalls: 7, maxToolCalls: 3 }, ...overrides });
  return freezeNativeDshConfiguration({ scope, buildId: 'build', source: { provider: 'fixture', model: 'test' }, configuration: config },
    { messages: [{ id: text, role: 'user', content: [{ type: 'text', text }] }] }, config.contract, original);
}
async function prepared(options = {}) {
  const store = new MemoryRunStore(), sourceConfiguration = frozen('Start a background command'); let calls = 0;
  const kernel = new NativeKernel({ store, owner: 'source', digest, ports: {
    model: { generate: async () => ++calls === 1 ? { ...finish(), kind: 'tool_calls',
      toolCalls: [{ callId: 'launch', name: 'run_command', arguments: {} }] } : finish() },
    tools: { execute: async request => ({ status: 'ok', content: { backend: 'sandbox/local_process' }, backgroundCommandRef: {
      taskId: '1'.repeat(64), sourceRunId: request.runId, operationKey: request.operationKey } }) },
    background: { contract: BACKGROUND_COMMAND_CONTRACT, observe: async () => [] },
  } });
  kernel.start(identity('source'), sourceConfiguration); await kernel.runUntilIdle(scope, 'source');
  const nextConfiguration = frozen('Answer another question', options);
  const next = new NativeKernel({ store, owner: 'next', digest, ports: {
    model: { generate: async () => finish() }, background: { contract: BACKGROUND_COMMAND_CONTRACT, observe: async () => [] },
  } });
  next.start(identity('next'), nextConfiguration); await next.runUntilIdle(scope, 'next');
  let observations = 0;
  const admit = () => admitBackgroundNotification({ store, scope, sourceRunId: 'source', taskId: '1'.repeat(64), digest,
    signal: new AbortController().signal, observe: async request => { observations++; return {
      ref: request.ref, status: 'completed', exitCode: 0, stdout: 'Actual command result', stderr: '',
    }; } });
  return { store, sourceConfiguration, nextConfiguration, admit, observations: () => observations };
}

test('C3: a later explicit user turn changes its input binding without stranding the owned background completion', async () => {
  const f = await prepared(), source = f.store.load(scope, 'source');
  assert.notEqual(f.sourceConfiguration.hostBindingDigest, f.nextConfiguration.hostBindingDigest);
  assert.equal(f.sourceConfiguration.backgroundSessionBindingDigest, f.nextConfiguration.backgroundSessionBindingDigest);
  f.store.inject(scope, 'session', { injectionId: 'pending-data', text: 'New external data', source: { kind: 'channel', ref: 'event' } });
  const notice = await f.admit();
  assert.equal(notice.snapshot.parentRunId, 'next'); assert.equal(notice.snapshot.goal, 'Answer another question');
  assert.equal(notice.snapshot.sessionInjections.length, 1);
  assert.equal(notice.configuration.limits.maxModelCalls, 5, 'Notice spends only the original source budget');
  assert.deepEqual(f.store.load(scope, 'source'), source);
  let calls = 0;
  const kernel = new NativeKernel({ store: f.store, owner: 'notice', digest, ports: {
    model: { generate: async request => { calls++; assert.match(canonical(request.messages), /Actual command result/);
      assert.match(canonical(request.messages), /New external data/); return finish(); } },
    background: { contract: BACKGROUND_COMMAND_CONTRACT, observe: async () => [] },
  } });
  await kernel.runUntilIdle(scope, notice.snapshot.runId);
  assert.equal((await f.admit()).created, false); assert.equal(calls, 1);
});

for (const change of [{ declared: 'changed-resources' }, { instructions: 'Changed policy instructions' },
  { profile: { profileId: 'other', profileVersion: '1', providerFamily: 'fixture', compatibilityDigest: 'fixture/v1' } },
  { tools: [{ ...launch, permissions: ['new-permission'] }] }])
  test(`background session binding still refuses execution authority drift: ${Object.keys(change)[0]}`, async () => {
    const f = await prepared(change);
    await assert.rejects(f.admit(), { code: 'background_notification_binding_changed' });
    assert.equal(f.observations(), 0);
  });

test('old frozen turn bindings do not silently acquire the new cross-turn notification policy', () => {
  const modern = frozen('Original input');
  const legacy = structuredClone(modern); delete legacy.backgroundSessionBindingDigest;
  const restored = frozen('Original input', {}, legacy);
  assert.equal(restored.backgroundSessionBindingDigest, undefined);
  assert.deepEqual(restored, legacy);
});
