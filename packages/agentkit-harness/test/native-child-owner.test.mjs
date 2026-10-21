import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { NativeKernel, MemoryRunStore, configure, emptyUsage } from '../../agentkit-harness-core/dist/index.mjs';
import { fixture, scope, digest, tool } from '../../agentkit-harness-core/test/fixtures.mjs';
import { SqliteRunStore } from '../src/native/sqlite-store.mjs';
import { createNativeChildOwner } from '../src/native/child-owner.mjs';

const childScope = { ...scope, agentId: 'child-agent' };
const startDefinition = tool({ name: 'native_start_child', readOnly: false, concurrentSafe: false, childBudgetPolicy: 'start/v1',
  parameters: { type: 'object', required: ['role', 'task'], properties: { role: { type: 'string' }, task: { type: 'string' } } } });
const childDefinition = tool({ name: 'write_proof', readOnly: false, concurrentSafe: false });
const call = { callId: 'start-1', name: startDefinition.name, arguments: { role: 'worker', task: 'Write the child proof' } };
const response = (text, toolCalls = []) => ({ kind: toolCalls.length ? 'tool_calls' : 'final_candidate', text, toolCalls, usage: emptyUsage() });
const childConfig = () => configure({ profile: fixture().config.profile, contract: { objective: call.arguments.task }, tools: [childDefinition],
  hostBindingDigest: 'child-fixture', limits: { maxModelCalls: 3, maxToolCalls: 2 } });

function setup(t, backend, { approval = false, uncertain = false, hold = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'native-child-owner-'));
  const store = backend === 'sqlite' ? new SqliteRunStore(join(dir, 'runs.sqlite')) : new MemoryRunStore();
  let writes = 0, starts = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const childPorts = { model: { generate: async request => request.messages.some(message => message.role === 'tool')
    ? response('Child evidence') : response('', [{ callId: 'child-write', name: childDefinition.name, arguments: {} }]) },
  tools: { execute: async request => {
    if (approval && !request.interaction) return { status: 'approval_required', content: {}, interactionId: 'child-host-approval' };
    if (approval) assert.equal(request.interaction.decision, 'allow');
    await gate;
    request.signal.throwIfAborted();
    writes++; writeFileSync(join(dir, 'proof.txt'), `writes=${writes}`);
    if (uncertain) throw new Error('crash after write');
    return { status: 'ok', content: 'Written' };
  } } };
  const owner = createNativeChildOwner({ scope, childScopes: [childScope], store,
    resolveChild: async () => { starts++; return { scope: childScope, configuration: childConfig(), ports: childPorts }; },
    restoreChild: async () => childPorts });
  t.after(async () => { release(); await owner.releaseRun({ scope, runId: 'run' }); store.close?.(); rmSync(dir, { recursive: true, force: true }); });
  const { config, snapshot } = fixture({ tools: [startDefinition], limits: { maxModelCalls: 20, maxToolCalls: 20 },
    childLifecyclePolicy: 'owned-background/v2', childApprovalPolicy: 'owned-child-approval/v1' });
  let rounds = 0, observed = false;
  const kernel = new NativeKernel({ store, digest, owner: 'parent', ports: { children: owner,
    tools: { execute: request => owner.start(request) }, model: { generate: async request => {
      rounds++;
      if (rounds === 1) return response('', [call]);
      observed = request.messages.some(message => message.kind === 'background_child_observation');
      return response(observed ? 'Parent used child evidence' : 'Premature parent draft');
    } } }, onCheckpoint: async current => {
      const intent = store.load(scope, 'run').intents.find(item => item.operationKey === current.pendingIntent);
      if (!approval && !hold && intent?.kind === 'child' && intent.payload.action === 'wait') release();
    } });
  kernel.start(snapshot, config);
  return { dir, store, owner, kernel, release, writes: () => writes, starts: () => starts, observed: () => observed };
}

for (const backend of ['memory', 'sqlite']) {
  test(`${backend}: a real child Kernel executes its tool once; parent waits and reconsiders its premature candidate`, { timeout: 10000 }, async t => {
    const { store, kernel, dir, writes, starts, observed } = setup(t, backend);
    const result = await kernel.runUntilIdle(scope, 'run');
    assert.equal(result.phase, 'completed'); assert.equal(result.finalText, 'Parent used child evidence');
    assert.equal(writes(), 1); assert.equal(starts(), 1); assert.equal(observed(), true);
    assert.equal(readFileSync(join(dir, 'proof.txt'), 'utf8'), 'writes=1');
    assert.equal(result.usage.toolCalls, 1); assert.equal(result.descendantUsage.modelCalls, 2); assert.equal(result.descendantUsage.toolCalls, 1);
    const usage = store.events(scope, 'run').filter(event => event.kind === 'usage.reported' && event.payload.source === 'descendant_runs');
    assert.equal(usage.length, 1); assert.equal(usage[0].payload.usage.modelCalls, 2);
    assert.equal(result.children.length, 1); assert.equal(result.children[0].state, 'completed'); assert.equal(result.children[0].notified, true);
    assert.match(result.childBudgetReservations[0].settledUsageDigest, /^[0-9a-f]{64}$/);
    const record = store.load(childScope, result.childRunIds[0]);
    assert.equal(record.configuration.childOwnerBinding.parent.runId, 'run');
    assert.equal(record.configuration.delegationDepth, 1);
    assert.equal(record.configuration.limits.maxModelCalls, 3);
    assert.equal(record.configuration.limits.maxToolCalls, 2);
    assert.equal(record.snapshot.parentRunId, null);
  });

  test(`${backend}: a child approval is bridged to the parent and rejects a stale interaction`, { timeout: 10000 }, async t => {
    const { store, kernel, release, writes } = setup(t, backend, { approval: true });
    const pending = await kernel.runUntilIdle(scope, 'run');
    assert.equal(pending.phase, 'awaiting_interaction'); assert.equal(writes(), 0);
    assert.equal(pending.childApproval.toolCall.name, childDefinition.name);
    assert.ok(store.events(scope, 'run').some(event => event.kind === 'approval.requested' && event.payload.source === 'child_tool'));
    kernel.submit(scope, 'run', { commandId: 'stale', kind: 'submit_interaction', payload: { interactionId: 'wrong', decision: 'allow' } });
    assert.equal((await kernel.runUntilIdle(scope, 'run')).phase, 'awaiting_interaction');
    assert.equal(writes(), 0);
    release();
    kernel.submit(scope, 'run', { commandId: 'allow-child', kind: 'submit_interaction', payload: {
      interactionId: pending.pendingInteraction.interactionId, decision: 'allow' } });
    const result = await kernel.runUntilIdle(scope, 'run');
    assert.equal(result.phase, 'completed'); assert.equal(writes(), 1);
    assert.equal(result.descendantUsage.toolCalls, 1);
  });

  test(`${backend}: an uncertain child write is never retried or accepted as a complete child result`, { timeout: 10000 }, async t => {
    const { kernel, writes } = setup(t, backend, { uncertain: true });
    const result = await kernel.runUntilIdle(scope, 'run');
    assert.notEqual(result.phase, 'completed'); assert.equal(writes(), 1);
    assert.equal(result.reason, 'child_receipt_unavailable');
    assert.equal(result.childBudgetReservations[0].settledUsageDigest, null);
    assert.deepEqual(await kernel.runUntilIdle(scope, 'run'), result); assert.equal(writes(), 1);
  });

  test(`${backend}: pausing the parent's active child wait leaves the child owned and resume collects it once`, { timeout: 10000 }, async t => {
    const { kernel, store, release, writes } = setup(t, backend, { hold: true });
    const running = kernel.runUntilIdle(scope, 'run');
    for (let tries = 0; tries < 500; tries++) {
      const parent = store.load(scope, 'run'), intent = parent.intents.find(item => item.operationKey === parent.snapshot.pendingIntent);
      if (intent?.kind === 'child' && intent.payload.action === 'wait' && intent.status === 'running') break;
      await new Promise(resolve => setTimeout(resolve, 2));
    }
    kernel.submit(scope, 'run', { commandId: 'pause-wait', kind: 'pause', payload: {} });
    const paused = await running;
    assert.equal(paused.phase, 'paused'); assert.equal(writes(), 0);
    assert.equal(paused.childBudgetReservations[0].settledUsageDigest, null);
    assert.ok(store.load(scope, 'run').receipts.some(receipt => receipt.result.reason === 'child_observation_paused'));
    release();
    kernel.submit(scope, 'run', { commandId: 'resume-wait', kind: 'resume', payload: {} });
    const final = await kernel.runUntilIdle(scope, 'run');
    assert.equal(final.phase, 'completed'); assert.equal(writes(), 1); assert.equal(final.descendantUsage.toolCalls, 1);
  });

  test(`${backend}: parent cancellation stops an active child and a late tool cannot write`, { timeout: 10000 }, async t => {
    const { kernel, store, release, writes } = setup(t, backend, { hold: true });
    const running = kernel.runUntilIdle(scope, 'run');
    for (let tries = 0; tries < 500; tries++) {
      const parent = store.load(scope, 'run'), intent = parent.intents.find(item => item.operationKey === parent.snapshot.pendingIntent);
      if (intent?.kind === 'child' && intent.payload.action === 'wait' && intent.status === 'running') break;
      await new Promise(resolve => setTimeout(resolve, 2));
    }
    kernel.submit(scope, 'run', { commandId: 'cancel-parent', kind: 'cancel', payload: {} });
    const canceled = await running;
    assert.equal(canceled.phase, 'canceled'); assert.equal(writes(), 0);
    release(); await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(writes(), 0);
    const child = store.load(childScope, canceled.childRunIds[0]);
    assert.equal(child.snapshot.phase, 'canceled');
    assert.ok(store.load(scope, 'run').intents.some(intent => intent.kind === 'child' && intent.payload.action === 'cancel'));
  });
}

for (const boundary of ['startup', 'collection']) test(`Node process death before parent ${boundary} receipt reconciles the same sealed child`, { timeout: 15000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'native-child-process-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const worker = spawnSync(process.execPath, [fileURLToPath(new URL('./fixtures/native-child-crash-worker.mjs', import.meta.url)), dir, boundary],
    { encoding: 'utf8', timeout: 10000 });
  assert.equal(worker.status, 0, worker.stderr);
  const store = new SqliteRunStore(join(dir, 'runs.sqlite'));
  t.after(() => store.close());
  let starts = 0;
  const owner = createNativeChildOwner({ scope, childScopes: [childScope], store,
    resolveChild: async () => { starts++; throw new Error('must not restart'); } });
  const kernel = new NativeKernel({ store, owner: 'replacement-parent', digest, ports: { children: owner,
    tools: { execute: async () => { throw new Error('must not dispatch startup again'); } },
    model: { generate: async request => {
      assert.ok(request.messages.some(message => message.kind === 'background_child_observation'));
      return response('Recovered parent');
    } } } });
  const result = await kernel.runUntilIdle(scope, 'run');
  assert.equal(result.phase, 'completed'); assert.equal(result.finalText, 'Recovered parent');
  assert.equal(starts, 0); assert.equal(readFileSync(join(dir, 'proof.txt'), 'utf8'), 'one write');
  assert.equal(result.childRunIds.length, 1); assert.equal(result.descendantUsage.modelCalls, 2); assert.equal(result.descendantUsage.toolCalls, 1);
  assert.equal(result.usage.toolCalls, 1);
  assert.equal(store.events(scope, 'run').filter(event => event.kind === 'usage.reported' && event.payload.source === 'descendant_runs').length, 1);
  assert.ok(store.load(scope, 'run').receipts.some(receipt => receipt.result.recoveryPolicy === (boundary === 'startup'
    ? 'owned-child-start/v1' : 'owned-child-observation/v1')));
});

test('an expired parent cannot start a child after a slow Host binding lookup', { timeout: 10000 }, async t => {
  const store = new MemoryRunStore();
  let enter, release, childModels = 0;
  const entered = new Promise(resolve => { enter = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const owner = createNativeChildOwner({ scope, childScopes: [childScope], store, resolveChild: async () => {
    enter(); await gate;
    return { scope: childScope, configuration: childConfig(), ports: {
      model: { generate: async () => { childModels++; return response('Must not run'); } }, tools: { execute: async () => ({ status: 'ok', content: {} }) },
    } };
  } });
  t.after(async () => owner.releaseRun({ scope, runId: 'run' }));
  const { config, snapshot } = fixture({ tools: [startDefinition], childLifecyclePolicy: 'owned-background/v2' });
  const kernel = new NativeKernel({ store, owner: 'stale-parent', digest, ports: {
    model: { generate: async () => response('', [call]) }, tools: { execute: request => owner.start(request) }, children: owner,
  } });
  kernel.start(snapshot, config);
  const running = kernel.runUntilIdle(scope, 'run');
  await entered;
  store.acquire(scope, 'run', 'replacement', Date.now() + 200000, 10000);
  release();
  await assert.rejects(running, /stale_fence|lease_lost/);
  assert.equal(childModels, 0); assert.deepEqual(store.list(childScope), []);
});
