import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NativeKernel, MemoryRunStore, emptyUsage, transition, modelContextMessages,
  contextSourceDigest, validateContextMessages } from '../dist/index.mjs';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { fixture, scope, digest, tool } from './fixtures.mjs';

const final = () => ({ kind: 'final_candidate', text: 'Done', toolCalls: [], usage: emptyUsage() });
for (const backend of ['memory', 'sqlite']) {
  const setup = t => {
    const dir = mkdtempSync(join(tmpdir(), 'native-context-view-')), filename = join(dir, 'ledger.sqlite');
    const stores = [], open = () => {
      const store = backend === 'memory' ? new MemoryRunStore() : new SqliteRunStore(filename);
      stores.push(store); return store;
    };
    t.after(() => { for (const store of stores) store.close?.(); rmSync(dir, { recursive: true, force: true }); });
    return { open };
  };
  test(`${backend}: compacted model views preserve actual tool receipts and subsequent session history`, async t => {
    const { open } = setup(t), store = open(), { snapshot, config } = fixture({ tools: [tool()] });
    let models = 0, preparations = 0;
    const kernel = new NativeKernel({ store, owner: 'worker', digest, ports: {
      context: { prepare: async request => {
        preparations++;
        if (request.runId !== 'run' || !request.snapshot.messages.some(message => message.role === 'tool')) {
          return { messages: request.snapshot.messages, context: { generation: preparations } };
        }
        assert.equal(request.snapshot.messages.find(message => message.role === 'tool').content, '"original observation"');
        return { messages: [{ role: 'user', content: 'Compact summary of earlier execution', kind: 'summary' }],
          context: { generation: preparations, workspaceCursor: 'forged', preparedCursor: 'forged' } };
      } },
      model: { generate: async request => {
        if (++models === 1) return { kind: 'tool_calls', text: '', usage: emptyUsage(), toolCalls: [{ callId: 'read1', name: 'read', arguments: {} }] };
        if (request.runId === 'run') assert.deepEqual(request.messages.map(message => message.content), ['Compact summary of earlier execution']);
        else assert.equal(request.messages.find(message => message.role === 'tool').content, '"original observation"');
        return final();
      } },
      tools: { execute: async () => ({ status: 'ok', content: 'original observation' }) },
    } });
    kernel.start(snapshot, config);
    const result = await kernel.runUntilIdle(scope, 'run');
    assert.equal(result.phase, 'completed'); assert.equal(result.preparedContext, null);
    assert.equal(result.messages.find(message => message.role === 'tool').content, '"original observation"');
    assert.equal(result.messages.some(message => message.kind === 'summary'), false);
    assert.equal(result.context.workspaceCursor, undefined); assert.equal(result.context.adapter.workspaceCursor, 'forged');
    assert.notEqual(result.context.preparedCursor, 'forged');
    const inherited = kernel.start({ ...snapshot, runId: 'next', turnId: 'next' }, config);
    assert.equal(inherited.messages.find(message => message.role === 'tool').content, '"original observation"');
    assert.equal(inherited.messages.some(message => message.kind === 'summary'), false);
    assert.equal((await kernel.runUntilIdle(scope, 'next')).phase, 'completed');
    assert.equal(store.events(scope, 'run').filter(event => event.kind === 'context.prepared').length, 2);
  });
  test(`${backend}: the ledger rejects mutation or deletion of previously committed transcript messages`, t => {
    const { open } = setup(t), store = open(), { snapshot, config } = fixture();
    store.create(config, snapshot); const lease = store.acquire(scope, 'run', 'worker', 0, 100);
    for (const messages of [[], [{ role: 'user', content: 'overwritten' }]]) {
      assert.throws(() => store.commit(scope, 'run', lease, 1, 0, transition(snapshot, { messages })), { code: 'transcript_is_append_only' });
      assert.deepEqual(store.load(scope, 'run').snapshot, snapshot);
    }
  });
  test(`${backend}: an orphaned tool view stops before any model request`, async t => {
    const { open } = setup(t), store = open(), { snapshot, config } = fixture(); let modelCalls = 0;
    const kernel = new NativeKernel({ store, owner: 'worker', digest, ports: {
      context: { prepare: async () => ({ messages: [{ role: 'tool', callId: 'orphan', content: 'unpaired' }], context: {} }) },
      model: { generate: async () => { modelCalls++; return final(); } }, tools: { execute: async () => assert.fail() },
    } });
    kernel.start(snapshot, config); const result = await kernel.runUntilIdle(scope, 'run');
    assert.equal(modelCalls, 0); assert.equal(result.outcome, 'blocked'); assert.equal(result.reason, 'invalid_context_tool_pairing');
    assert.deepEqual(result.messages, snapshot.messages);
    assert.equal(store.load(scope, 'run').receipts[0].status, 'failed');
  });
  for (const command of ['guide', 'steer']) test(`${backend}: ${command} between serialized tools preserves protocol pairing`, async t => {
    const { open } = setup(t), store = open(), { snapshot, config } = fixture({ tools: [tool({ readOnly: false, concurrentSafe: false })] });
    let models = 0, kernel; const executions = [];
    kernel = new NativeKernel({ store, owner: 'worker', digest, ports: {
      context: { prepare: async request => ({ messages: request.snapshot.messages, context: {} }) },
      model: { generate: async request => {
        if (++models === 1) return { kind: 'tool_calls', text: '', usage: emptyUsage(), toolCalls: ['one', 'two'].map(callId => ({ callId, name: 'read', arguments: {} })) };
        const last = request.messages.at(-1); assert.equal(last.kind, command === 'guide' ? 'guidance' : 'steering');
        assert.equal(last.content, 'New direction');
        const second = request.messages.find(message => message.role === 'tool' && message.callId === 'two');
        if (command === 'steer') assert.deepEqual(JSON.parse(second.content), { status: 'not_dispatched', reason: 'goal_steered', executed: false });
        else assert.equal(second.content, '"two"');
        return final();
      } }, tools: { execute: async request => {
        executions.push(request.call.callId);
        if (request.call.callId === 'one') kernel.submit(scope, 'run', { commandId: command, kind: command,
          payload: { text: 'New direction', ...(command === 'steer' ? { expectedGoalRevision: 0 } : {}) } });
        return { status: 'ok', content: request.call.callId };
      } },
    } });
    kernel.start(snapshot, config); const result = await kernel.runUntilIdle(scope, 'run');
    assert.equal(result.phase, 'completed'); assert.equal(result.queuedGuidance.length, 0);
    assert.deepEqual(executions, command === 'guide' ? ['one', 'two'] : ['one']);
    assert.equal(result.usage.toolCalls, executions.length);
    validateContextMessages(result.messages);
  });
  test(`${backend}: guidance received with a final candidate returns to the model before completion`, async t => {
    const { open } = setup(t), store = open(), { snapshot, config } = fixture(); let models = 0, kernel;
    kernel = new NativeKernel({ store, owner: 'worker', digest, ports: {
      model: { generate: async request => {
        if (++models === 1) kernel.submit(scope, 'run', { commandId: 'guide-final', kind: 'guide', payload: { text: 'Include the new requirement' } });
        else assert.equal(request.messages.at(-1).content, 'Include the new requirement');
        return { ...final(), text: `Answer ${models}` };
      } }, tools: { execute: async () => assert.fail() },
    } });
    kernel.start(snapshot, config); const result = await kernel.runUntilIdle(scope, 'run');
    assert.equal(models, 2); assert.equal(result.finalText, 'Answer 2'); assert.equal(result.phase, 'completed');
  });
}

test('a prepared view survives SQLite reopen but guidance invalidates its source binding', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'native-context-reopen-')), filename = join(dir, 'ledger.sqlite');
  let store = new SqliteRunStore(filename), preparations = 0, first;
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const { snapshot, config } = fixture();
  const ports = {
    context: { prepare: async request => {
      preparations++;
      if (preparations === 1) first.submit(scope, 'run', { commandId: 'pause', kind: 'pause', payload: {} });
      return { messages: request.snapshot.messages, context: { preparations } };
    } }, model: { generate: async request => { assert.equal(request.messages.at(-1).content, 'Updated guidance'); return final(); } },
    tools: { execute: async () => assert.fail() },
  };
  first = new NativeKernel({ store, owner: 'first', digest, ports }); first.start(snapshot, config);
  const paused = await first.runUntilIdle(scope, 'run'); assert.equal(paused.phase, 'paused');
  assert.equal(paused.preparedContext.sourceDigest, contextSourceDigest(paused, digest)); store.close();
  store = new SqliteRunStore(filename); const replacement = new NativeKernel({ store, owner: 'replacement', digest, ports });
  assert.deepEqual(replacement.attach(scope, 'run').preparedContext, paused.preparedContext);
  replacement.submit(scope, 'run', { commandId: 'guide', kind: 'guide', payload: { text: 'Updated guidance' } });
  replacement.submit(scope, 'run', { commandId: 'resume', kind: 'resume', payload: {} });
  assert.equal((await replacement.runUntilIdle(scope, 'run')).phase, 'completed'); assert.equal(preparations, 2);
  assert.throws(() => modelContextMessages({ ...paused, goalRevision: 1 }, digest), { code: 'context_binding_mismatch' });
});

test('context validation refuses split tool groups and accepts out-of-order paired parallel results', () => {
  const assistant = { role: 'assistant', content: '', toolCalls: [
    { callId: 'a', name: 'read', arguments: {} }, { callId: 'b', name: 'read', arguments: {} },
  ] };
  assert.throws(() => validateContextMessages([assistant, { role: 'user', content: 'injected between receipts' }]), { code: 'invalid_context_tool_pairing' });
  assert.throws(() => validateContextMessages([assistant, { role: 'tool', callId: 'a', content: '' }]), { code: 'invalid_context_tool_pairing' });
  assert.equal(validateContextMessages([assistant, { role: 'tool', callId: 'b', content: '' }, { role: 'tool', callId: 'a', content: '' }]).length, 3);
});
