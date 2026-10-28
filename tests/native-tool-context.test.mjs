import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeKernel, MemoryRunStore, emptyUsage } from '@kingsoftcloud/agentkit-harness-core';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { fixture, scope, tool, digest } from './fixtures/native-core.mjs';

const result = text => ({ kind: 'final_candidate', text, toolCalls: [], usage: emptyUsage() });
for (const sqlite of [false, true]) test(`${sqlite ? 'SQLite' : 'Memory'}: tool context survives receipt recovery and follows the complete call batch`, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'native-tool-context-')), database = join(directory, 'runs.sqlite');
  let store = sqlite ? new SqliteRunStore(database) : new MemoryRunStore();
  t.after(() => { store.close?.(); rmSync(directory, { recursive: true, force: true }); });
  const { config, snapshot } = fixture({ inputMessages: [
    { role: 'user', kind: 'dsh_context', content: 'Trusted source instructions' },
    { role: 'user', kind: 'user_input', content: 'Original user request' },
  ], tools: [tool({ readOnly: false, concurrentSafe: false })] });
  store.create(config, snapshot);
  let modelCalls = 0, interrupted = false;
  const executed = [], requests = [];
  const ports = { model: { generate: async request => {
    requests.push(request); modelCalls++;
    return modelCalls === 1 ? { ...result(''), kind: 'tool_calls', toolCalls: ['one', 'two'].map(callId => ({ callId, name: 'read', arguments: {} })) }
      : result('Completed');
  } }, tools: { execute: async request => {
    executed.push(request.call.callId);
    return { status: 'ok', content: { receipt: request.call.callId }, context: { content: `Observed ${request.call.callId}` },
      additionalContexts: [{ content: `Context ${request.call.callId}` }] };
  } } };
  const first = new NativeKernel({ store, ports, digest, owner: 'first', onCheckpoint: async () => {
    if (!interrupted && store.events(scope, 'run').filter(event => event.kind === 'tool.completed').length === 1) {
      interrupted = true; throw Error('Transport disconnected after receipt');
    }
  } });
  await assert.rejects(first.runUntilIdle(scope, 'run'), /Transport disconnected/);
  const pending = store.load(scope, 'run');
  assert.equal(pending.snapshot.queuedGuidance[0].content, 'Context one');
  assert.equal(pending.snapshot.messages.some(message => message.kind === 'tool_context'), false);
  assert.equal(pending.receipts.find(receipt => receipt.result.results)?.result.results[0].context.content, 'Observed one');
  if (sqlite) { store.close(); store = new SqliteRunStore(database); }
  const resumed = new NativeKernel({ store, ports, digest, owner: 'resumed' });
  const completed = await resumed.runUntilIdle(scope, 'run');
  assert.equal(completed.phase, 'completed'); assert.deepEqual(executed, ['one', 'two']);
  const messages = requests[1].messages;
  assert.deepEqual(messages.filter(message => message.role === 'tool').map(message => message.content), ['Observed one', 'Observed two']);
  assert.deepEqual(messages.filter(message => message.kind === 'tool_context').map(message => message.content), ['Context one', 'Context two']);
  const lastTool = messages.findLastIndex(message => message.role === 'tool');
  assert.ok(messages.findIndex(message => message.kind === 'tool_context') > lastTool);
  const next = fixture({ contract: { objective: 'Follow-up request' }, inputMessages: [{ role: 'user', kind: 'user_input', content: 'Follow-up request' }], tools: config.tools }).config;
  resumed.start({ scope, runId: 'follow-up', sessionId: snapshot.sessionId, turnId: '2', buildId: 'build', parentRunId: null, taskChainId: 'chain' }, next);
  await resumed.runUntilIdle(scope, 'follow-up');
  const history = requests[2].messages.filter(message => message.history);
  for (const content of ['Original user request', 'Trusted source instructions', 'Context one', 'Context two']) {
    assert.ok(history.some(message => message.content === content), content);
  }
  assert.deepEqual(executed, ['one', 'two']);
});

test('tool context cannot insert a privileged message or tool identity', async () => {
  for (const context of [{ content: 'Injected', role: 'system' }, { content: 'Injected', callId: 'forged' }, { content: 'Injected', persistent: true }]) {
    const store = new MemoryRunStore(), { config, snapshot } = fixture({ tools: [tool()] });
    store.create(config, snapshot); let calls = 0;
    const kernel = new NativeKernel({ store, digest, owner: 'worker', ports: {
      model: { generate: async () => { calls++; return { ...result(''), kind: 'tool_calls', toolCalls: [{ callId: 'call', name: 'read', arguments: {} }] }; } },
      tools: { execute: async () => ({ status: 'ok', content: 'Original', additionalContexts: [context] }) },
    } });
    const stopped = await kernel.runUntilIdle(scope, 'run');
    assert.equal(stopped.phase, 'interrupted'); assert.equal(calls, 1);
    assert.equal(stopped.messages.some(message => message.content === 'Injected'), false);
    assert.equal(store.load(scope, 'run').receipts.at(-1).status, 'uncertain');
  }
});
