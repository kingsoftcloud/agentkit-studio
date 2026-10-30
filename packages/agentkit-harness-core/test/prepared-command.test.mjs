import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NativeKernel, MemoryRunStore, emptyUsage, plan, prepareEffect, transition, validateContextMessages } from '../dist/index.mjs';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { fixture, scope, digest, tool } from './fixtures.mjs';

const final = () => ({ kind: 'final_candidate', text: 'Current answer', toolCalls: [], usage: emptyUsage() });
const newText = 'Use the new requirement';
const command = (kind, text = newText) => ({ commandId: `control-${kind}`, kind,
  payload: { text, ...(kind === 'steer' ? { expectedGoalRevision: 0 } : {}) } });

for (const backend of ['memory', 'sqlite']) {
  const setup = t => {
    const dir = mkdtempSync(join(tmpdir(), 'native-prepared-control-'));
    const filename = join(dir, 'ledger.sqlite');
    let store = backend === 'sqlite' ? new SqliteRunStore(filename) : new MemoryRunStore();
    t.after(() => { store.close?.(); rmSync(dir, { recursive: true, force: true }); });
    return { get store() { return store; }, reopen() {
      if (backend === 'sqlite') { store.close(); store = new SqliteRunStore(filename); }
      return store;
    } };
  };
  function prepared(store, kind, configInput = {}, interaction = null) {
    const { snapshot, config } = fixture(configInput);
    store.create(config, snapshot);
    const lease = store.acquire(scope, 'run', 'preparer', 1, 1);
    let current = snapshot;
    if (kind === 'model') {
      while (current.pendingIntent === null) current = store.commit(scope, 'run', lease, 1, current.revision,
        plan(current, config, { context: false, workspace: false, verification: false }));
    } else {
      const call = { callId: 'obsolete', name: 'write', arguments: {} };
      current = store.commit(scope, 'run', lease, 1, current.revision,
        prepareEffect(current, 'tool', 'executing_tools', { calls: [call], interaction }, {
          pendingTools: [call], messages: [...current.messages, { role: 'assistant', content: '', toolCalls: [call] }],
        }));
    }
    return { config, current, lease, key: current.pendingIntent };
  }
  const worker = (store, ports) => new NativeKernel({ store, ports, digest, owner: 'replacement', now: () => 10 });

  test(`${backend}: stale revision guidance cannot retire the prepared original request`, async t => {
    const state = setup(t), { key, lease } = prepared(state.store, 'model', { limits: { maxModelCalls: 1 } });
    state.store.release(scope, 'run', lease); const store = state.reopen(); let requests = 0;
    const kernel = worker(store, { model: { generate: async request => {
      requests++; assert.equal(request.operationKey, key); assert.equal(request.messages.some(message => message.kind === 'guidance'), false);
      return final();
    } }, tools: { execute: async () => assert.fail('no tool authorized') } });
    kernel.submit(scope, 'run', { commandId: 'stale-guidance', kind: 'guide', payload: { text: 'obsolete', expectedGoalRevision: 2 } });
    const result = await kernel.runUntilIdle(scope, 'run'); assert.equal(result.phase, 'completed'); assert.equal(requests, 1);
    assert.equal(store.events(scope, 'run').find(event => event.payload.commandId === 'stale-guidance').payload.reason, 'stale_goal_revision');
  });

  for (const kind of ['guide', 'steer']) test(`${backend}: ${kind} retires a prepared model without spending the only model attempt`, async t => {
    const state = setup(t);
    const { key, lease } = prepared(state.store, 'model', { limits: { maxModelCalls: 1 } });
    assert.equal(state.store.load(scope, 'run').snapshot.usage.modelCalls, 0);
    state.store.release(scope, 'run', lease);
    const store = state.reopen();
    let dispatched = 0;
    const kernel = worker(store, {
      model: { generate: async request => {
        dispatched++; assert.notEqual(request.operationKey, key);
        assert.equal(request.messages.at(-1).content, newText);
        return final();
      } }, tools: { execute: async () => assert.fail('no tool authorized') },
    });
    kernel.submit(scope, 'run', command(kind));
    const result = await kernel.runUntilIdle(scope, 'run');
    assert.equal(result.phase, 'completed'); assert.equal(dispatched, 1);
    assert.equal(result.usage.modelCalls, 1);
    const record = store.load(scope, 'run');
    assert.equal(record.intents.find(intent => intent.operationKey === key).status, 'prepared');
    assert.deepEqual(record.receipts.find(receipt => receipt.operationKey === key), {
      operationKey: key, status: 'not_dispatched', result: { code: 'superseded_before_dispatch', commandId: `control-${kind}`, executed: false },
    });
    assert.equal(record.commands[0].consumed, true);
  });

  for (const kind of ['guide', 'steer']) test(`${backend}: ${kind} at a prepared write boundary preserves tool-pairing and execution authority`, async t => {
    const state = setup(t);
    const { key, lease } = prepared(state.store, 'tool', { tools: [tool({ name: 'write', readOnly: false, concurrentSafe: false })] });
    state.store.release(scope, 'run', lease);
    const store = state.reopen(); let executed = 0;
    const kernel = worker(store, {
      model: { generate: async request => {
        validateContextMessages(request.messages);
        assert.equal(request.messages.at(-1).content, newText);
        const receipt = JSON.parse(request.messages.find(message => message.role === 'tool').content);
        if (kind === 'steer') assert.equal(receipt.executed, false);
        else assert.equal(receipt.written, true);
        return final();
      } }, tools: { execute: async request => {
        executed++; assert.notEqual(request.operationKey, key);
        return { status: 'ok', content: { written: true } };
      } },
    });
    kernel.submit(scope, 'run', command(kind));
    const result = await kernel.runUntilIdle(scope, 'run');
    assert.equal(result.phase, 'completed'); assert.equal(executed, Number(kind === 'guide'));
    assert.equal(result.usage.toolCalls, executed);
    assert.equal(store.load(scope, 'run').receipts.find(receipt => receipt.operationKey === key).status, 'not_dispatched');
  });

  for (const kind of ['guide', 'steer']) test(`${backend}: ${kind} cannot turn a lost claimed write into authority to execute again`, async t => {
    const state = setup(t);
    const { key, lease } = prepared(state.store, 'tool', { tools: [tool({ name: 'write', readOnly: false, concurrentSafe: false })] });
    state.store.claim(scope, 'run', lease, 1, key);
    const store = state.reopen();
    const kernel = worker(store, {
      model: { generate: async () => assert.fail('unknown write must be reconciled first') },
      tools: { execute: async () => assert.fail('unknown write must never repeat') },
    });
    kernel.submit(scope, 'run', command(kind));
    const result = await kernel.runUntilIdle(scope, 'run');
    assert.equal(result.phase, 'interrupted'); assert.equal(result.reason, 'effect_outcome_unknown');
    assert.equal(result.usage.toolCalls, 1);
    const record = store.load(scope, 'run');
    assert.equal(record.receipts[0].status, 'uncertain');
    assert.equal(record.events.find(event => event.kind === 'command.applied').payload.reason, 'recovery_required');
    assert.equal(record.commands[0].consumed, true);
  });

  test(`${backend}: a claimed effect cannot be falsely retired as undispatched`, t => {
    const { store } = setup(t);
    const { key, lease } = prepared(store, 'tool', { tools: [tool({ name: 'write', readOnly: false, concurrentSafe: false })] });
    store.claim(scope, 'run', lease, 1, key); store.enqueue(scope, 'run', command('steer'));
    const before = store.load(scope, 'run').snapshot;
    const batch = transition(before, { pendingIntent: null }, [], { commandId: 'control-steer', receipts: [{
      operationKey: key, status: 'not_dispatched', result: { code: 'superseded_before_dispatch', commandId: 'control-steer', executed: false },
    }] });
    assert.throws(() => store.commit(scope, 'run', lease, 1, before.revision, batch), { code: 'receipt_without_claim' });
    assert.deepEqual(store.load(scope, 'run').snapshot, before);
  });

  test(`${backend}: guidance preserves a previously approved prepared tool's bound decision`, async t => {
    const state = setup(t);
    const interaction = { interactionId: 'approval', callId: 'obsolete', decision: 'allow' };
    const { key, lease } = prepared(state.store, 'tool', { tools: [tool({ name: 'write', readOnly: false, concurrentSafe: false })] }, interaction);
    state.store.release(scope, 'run', lease); const store = state.reopen(); let calls = 0;
    const kernel = worker(store, {
      model: { generate: async () => final() }, tools: { execute: async request => {
        calls++; assert.deepEqual(request.interaction, interaction); assert.notEqual(request.operationKey, key);
        return { status: 'ok', content: 'published once' };
      } },
    });
    kernel.submit(scope, 'run', command('guide'));
    assert.equal((await kernel.runUntilIdle(scope, 'run')).phase, 'completed'); assert.equal(calls, 1);
  });

  for (const kind of ['guide', 'steer']) test(`${backend}: ${kind} after a lost pure-inference claim applies before its replacement request`, async t => {
    const state = setup(t);
    const { key, lease } = prepared(state.store, 'model', { modelRecoveryPolicy: 'pure-inference/v1', limits: { maxModelCalls: 2 } });
    state.store.claim(scope, 'run', lease, 1, key); const store = state.reopen(); let calls = 0;
    const kernel = worker(store, {
      model: { generate: async request => {
        calls++; assert.equal(request.messages.at(-1).content, newText); assert.notEqual(request.operationKey, key);
        return final();
      } }, tools: { execute: async () => assert.fail() },
    });
    kernel.submit(scope, 'run', command(kind)); const result = await kernel.runUntilIdle(scope, 'run');
    assert.equal(result.phase, 'completed'); assert.equal(calls, 1); assert.equal(result.usage.modelCalls, 2);
    assert.equal(store.load(scope, 'run').receipts.find(receipt => receipt.operationKey === key).status, 'uncertain');
  });

  test(`${backend}: guidance while paused retires a prepared request and waits for explicit resume`, async t => {
    const state = setup(t);
    const { lease } = prepared(state.store, 'model', { limits: { maxModelCalls: 1 } });
    state.store.release(scope, 'run', lease); const store = state.reopen(); let calls = 0;
    const kernel = worker(store, {
      model: { generate: async request => { calls++; assert.equal(request.messages.at(-1).content, newText); return final(); } },
      tools: { execute: async () => assert.fail() },
    });
    kernel.submit(scope, 'run', { commandId: 'pause', kind: 'pause', payload: {} });
    kernel.submit(scope, 'run', command('guide'));
    const paused = await kernel.runUntilIdle(scope, 'run');
    assert.equal(paused.phase, 'paused'); assert.equal(paused.pendingIntent, null); assert.equal(calls, 0);
    assert.equal(paused.usage.modelCalls, 0);
    kernel.submit(scope, 'run', { commandId: 'resume', kind: 'resume', payload: {} });
    const finished = await kernel.runUntilIdle(scope, 'run');
    assert.equal(finished.phase, 'completed'); assert.equal(calls, 1); assert.equal(finished.usage.modelCalls, 1);
  });

  test(`${backend}: guidance replacing a prepared compaction retains its required compaction purpose`, async t => {
    const state = setup(t), { config, snapshot } = fixture(); const store = state.store;
    store.create(config, snapshot); const lease = store.acquire(scope, 'run', 'preparer', 1, 1);
    store.commit(scope, 'run', lease, 1, 0, prepareEffect(snapshot, 'context', 'compacting', { forceCompaction: true }));
    store.release(scope, 'run', lease); let preparations = 0;
    const kernel = worker(state.reopen(), {
      context: { prepare: async request => {
        preparations++; assert.equal(request.forceCompaction, true); assert.equal(request.snapshot.messages.at(-1).content, newText);
        return { messages: request.snapshot.messages, context: {} };
      } }, model: { generate: async () => final() }, tools: { execute: async () => assert.fail() },
    });
    kernel.submit(scope, 'run', command('guide'));
    assert.equal((await kernel.runUntilIdle(scope, 'run')).phase, 'completed'); assert.equal(preparations, 1);
  });
}

test('SQLite rolls back the model-attempt charge together with a failed claim transaction', t => {
  const dir = mkdtempSync(join(tmpdir(), 'native-claim-accounting-')); let fail = false;
  const store = new SqliteRunStore(join(dir, 'ledger.sqlite'), { beforeCommit: ({ record }) => {
    if (fail && record.intents.some(intent => intent.status === 'running')) throw new Error('claim-commit-fault');
  } });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const { snapshot, config } = fixture(); store.create(config, snapshot);
  const lease = store.acquire(scope, 'run', 'worker', 1, 10);
  const prepared = store.commit(scope, 'run', lease, 1, 0, prepareEffect(snapshot, 'model', 'requesting_model', {}));
  fail = true;
  assert.throws(() => store.claim(scope, 'run', lease, 1, prepared.pendingIntent), /claim-commit-fault/);
  const unchanged = store.load(scope, 'run');
  assert.equal(unchanged.snapshot.usage.modelCalls, 0); assert.equal(unchanged.intents[0].status, 'prepared');
  fail = false; store.claim(scope, 'run', lease, 1, prepared.pendingIntent);
  const claimed = store.load(scope, 'run');
  assert.equal(claimed.snapshot.usage.modelCalls, 1); assert.equal(claimed.intents[0].status, 'running');
});
