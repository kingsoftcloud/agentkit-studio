import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeKernel, MemoryRunStore, emptyUsage, prepareEffect, todoToolDefinitions, executeTodo,
  todoReminder, toolDiscoveryDefinitions } from '../dist/index.mjs';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { fixture, scope, digest, tool } from './fixtures.mjs';

const item = (content = 'Inspect source', status = 'in_progress', priority = 'high') => ({ content, status, priority });
const write = (todos, callId = 'write') => ({ name: 'TodoWrite', callId, arguments: { todos } });
const read = { name: 'TodoRead', callId: 'read', arguments: {} };
const result = (toolCalls = []) => ({ kind: toolCalls.length ? 'tool_calls' : 'final_candidate', text: toolCalls.length ? '' : 'Done', toolCalls, usage: emptyUsage() });
const configuration = (overrides = {}) => fixture({ todoPolicy: 'session-todos/v1', tools: todoToolDefinitions(), ...overrides });
const noExternal = { execute: async () => assert.fail('Session Todo controls must never invoke an external tool') };

for (const backend of ['memory', 'sqlite']) {
  const setup = t => {
    if (backend === 'memory') return new MemoryRunStore();
    const directory = mkdtempSync(join(tmpdir(), 'native-todos-'));
    const store = new SqliteRunStore(join(directory, 'run.sqlite'));
    t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); }); return store;
  };
  test(`${backend}: serialized full-list writes and reads preserve priorities and reference validation`, async t => {
    const store = setup(t), { config, snapshot } = configuration(); let models = 0;
    const kernel = new NativeKernel({ store, digest, owner: 'todos', ports: { tools: noExternal, model: { generate: async request => {
      if (++models === 1) return result([write([{ ...item(' '), discarded: 'not persisted' }, item('Parallel')])]);
      if (models === 2) {
        assert.equal(JSON.parse(request.messages.at(-1).content).summary.inProgress, 2);
        return result([read]);
      }
      if (models === 3) {
        assert.deepEqual(JSON.parse(request.messages.at(-1).content).todos, [item(' '), item('Parallel')]);
        return result([write([item('Finished', 'completed', 'low')], 'replace'), { ...read, callId: 'read-after-write' }]);
      }
      assert.deepEqual(JSON.parse(request.messages.at(-1).content).todos, [item('Finished', 'completed', 'low')]); return result();
    } } } });
    kernel.start(snapshot, config); const done = await kernel.runUntilIdle(scope, 'run');
    assert.equal(done.phase, 'completed'); assert.equal(done.todos.revision, 2);
    assert.equal(done.todos.assistantTurns, 4);
    assert.deepEqual(done.todos.items, [item('Finished', 'completed', 'low')]);
    assert.equal(store.load(scope, 'run').events.filter(event => event.kind === 'todo.updated').length, 2);
    const next = kernel.start({ ...snapshot, runId: 'next', turnId: 'next' }, config);
    assert.deepEqual(next.todos, done.todos); assert.match(next.messages.find(message => message.kind === 'todo_state').content, /Finished/);
    const foreign = kernel.start({ ...snapshot, runId: 'foreign', sessionId: 'foreign' }, config);
    assert.equal(foreign.todos.revision, 0); assert.deepEqual(foreign.todos.items, []);
  });
  test(`${backend}: lost claimed session write is settled once without replaying external effects`, async t => {
    const store = setup(t), { config, snapshot } = configuration(); store.create(config, snapshot);
    const lease = store.acquire(scope, 'run', 'lost-worker', 1, 1), calls = [write([item()])];
    const batch = prepareEffect(snapshot, 'tool', 'executing_tools', { calls, interaction: null }, {
      pendingTools: calls, messages: [...snapshot.messages, { role: 'assistant', content: '', toolCalls: calls }] });
    store.commit(scope, 'run', lease, 1, 0, batch); store.claim(scope, 'run', lease, 1, batch.snapshot.pendingIntent);
    const kernel = new NativeKernel({ store, digest, owner: 'new-worker', now: () => 100, ports: {
      tools: noExternal, model: { generate: async () => result() } } });
    const done = await kernel.runUntilIdle(scope, 'run');
    assert.equal(done.phase, 'completed'); assert.deepEqual(done.todos.items, [item()]); assert.equal(done.todos.revision, 1);
    assert.equal(done.recoveryRetriesUsed, 0); assert.equal(done.usage.toolCalls, 1);
    const record = store.load(scope, 'run');
    assert.equal(record.events.filter(event => event.kind === 'todo.updated').length, 1);
    assert.equal(record.receipts.find(receipt => receipt.operationKey === batch.snapshot.pendingIntent).result.recoveryPolicy, 'session-todos/v1');
    await kernel.runUntilIdle(scope, 'run'); assert.equal(store.load(scope, 'run').snapshot.todos.revision, 1);
  });
}

test('Todo validation rejects invalid wrappers and priority without mutating state; item extras are stripped', () => {
  const { config, snapshot } = configuration();
  for (const call of [write([item('', 'pending')]), write([{ content: 'No priority', status: 'pending' }]),
    { ...write([]), arguments: { todos: [], unknown: true } }, { ...read, arguments: { unknown: true } }]) {
    assert.equal(executeTodo(snapshot, config, call).status, 'error'); assert.equal(snapshot.todos.revision, 0);
  }
  assert.deepEqual(executeTodo(snapshot, config, write([{ ...item(), extra: true }, item()])).content.todos, [item(), item()]);
  assert.deepEqual(executeTodo(snapshot, config, write([])).content.todos, []);
  // Reference has an output budget, not a 32K input-state limit.
  assert.equal(executeTodo(snapshot, config, write([item('x'.repeat(33000))])).status, 'ok');
});

test('reminder cadence counts persisted assistant turns, excludes inference retries, and respects output continuation', () => {
  const { config, snapshot } = configuration(); snapshot.usage.modelCalls = 100;
  assert.equal(todoReminder(snapshot, config), null);
  snapshot.todos.assistantTurns = 10;
  const first = todoReminder(snapshot, config); assert.ok(first); assert.equal(first.todos.lastReminderAssistantTurn, 10);
  const next = { ...snapshot, ...first };
  assert.equal(todoReminder(next, config), null);
  next.todos.assistantTurns = 20; assert.ok(todoReminder(next, config));
  next.todos.lastWriteAssistantTurn = 15; assert.equal(todoReminder(next, config), null);
  next.todos.assistantTurns = 25; assert.ok(todoReminder(next, config));
  next.messages.push({ role: 'user', kind: 'continuation_observation', content: 'Continue the truncated output.' });
  assert.equal(todoReminder(next, config), null);
});

test('deferred search resolves Native Todo calls to durable session state', async () => {
  const { config, snapshot } = configuration({ toolDiscoveryPolicy: 'local-tool-search/v1',
    tools: [...toolDiscoveryDefinitions(), ...todoToolDefinitions(true)] }); let models = 0;
  const store = new MemoryRunStore(), kernel = new NativeKernel({ store, digest, owner: 'deferred-todos', ports: {
    tools: noExternal, model: { generate: async () => ++models === 1 ? result([{ name: 'ToolSearch', callId: 'search', arguments: { query: 'select:TodoRead,TodoWrite' } }])
      : models === 2 ? result([{ name: 'DeferredToolCall', callId: 'wrapped', arguments: { name: 'TodoWrite', input: { todos: [item()] } } }]) : result() } } });
  kernel.start(snapshot, config); const done = await kernel.runUntilIdle(scope, 'run');
  assert.equal(done.phase, 'completed'); assert.deepEqual(done.todos.items, [item()]); assert.equal(done.todos.revision, 1);
});

test('legacy external TodoWrite keeps its original meaning when session Todo policy is absent', async () => {
  const { config, snapshot } = fixture({ tools: [tool({ name: 'TodoWrite', readOnly: false, concurrentSafe: false })] });
  let models = 0, effects = 0;
  const store = new MemoryRunStore(), kernel = new NativeKernel({ store, digest, owner: 'legacy-todo', ports: {
    model: { generate: async () => ++models === 1 ? result([write([])]) : result() },
    tools: { execute: async () => { effects++; return { status: 'ok', content: 'External result' }; } } } });
  kernel.start(snapshot, config); const done = await kernel.runUntilIdle(scope, 'run');
  assert.equal(done.phase, 'completed'); assert.equal(effects, 1); assert.equal(Object.hasOwn(done, 'todos'), false);
});

test('SQLite reopen after committed write resumes without repeating it; explicit clear survives next turn', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'native-todo-resume-')), filename = join(directory, 'run.sqlite');
  let store = new SqliteRunStore(filename), models = 0, paused = false;
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const { config, snapshot } = configuration();
  let kernel = new NativeKernel({ store, digest, owner: 'before-close', onCheckpoint: async state => {
    if (!paused && state.todos.revision === 1) {
      paused = true; kernel.submit(scope, 'run', { commandId: 'pause', kind: 'pause', payload: {} });
    }
  }, ports: { tools: noExternal, model: { generate: async () => { models++; return result([write([item()])]); } } } });
  kernel.start(snapshot, config); assert.equal((await kernel.runUntilIdle(scope, 'run')).phase, 'paused');
  store.close(); store = new SqliteRunStore(filename);
  kernel = new NativeKernel({ store, digest, owner: 'after-close', ports: { tools: noExternal, model: { generate: async request => {
    if (++models === 2) { assert.match(request.messages.at(-1).content, /Inspect source/); return result([write([], 'clear')]); }
    return result();
  } } } });
  kernel.attach(scope, 'run'); kernel.submit(scope, 'run', { commandId: 'resume', kind: 'resume', payload: {} });
  const done = await kernel.runUntilIdle(scope, 'run'); assert.equal(done.phase, 'completed');
  assert.equal(done.todos.revision, 2); assert.deepEqual(done.todos.items, []);
  assert.equal(store.load(scope, 'run').events.filter(event => event.kind === 'todo.updated').length, 2);
  const next = kernel.start({ ...snapshot, runId: 'next', turnId: 'next' }, config);
  assert.equal(next.todos.revision, 2); assert.deepEqual(next.todos.items, []);
});

test('actual context compaction retains authoritative todos despite contradictory model summary', async () => {
  const { config, snapshot } = configuration({ profile: { ...fixture().config.profile, contextWindowTokens: 30000, maxOutputTokens: 128 },
    contextPolicy: { tokenizerId: 'counter', tokenizerDigest: 'count/v1', enabled: true, triggerRatio: .9, targetRatio: .5,
      summaryMaxTokens: 128, maxCompactions: null, maxCompactionsWithoutProgress: 4, minModelTurnsBetween: 1, maxSummaryRetries: 1 } });
  let tasks = 0, summaries = 0;
  const store = new MemoryRunStore(), kernel = new NativeKernel({ store, digest, owner: 'compact-todos', ports: {
    tools: noExternal,
    context: { tokens: { tokenizerId: 'counter', tokenizerDigest: 'count/v1', countText: async request => Math.ceil(request.text.length / 4),
      countRequest: async request => Math.ceil(JSON.stringify(request.messages).length / 4) + 100 } },
    model: { generate: async request => {
      if (request.purpose === 'compaction') { summaries++; return { ...result(), text: 'All tasks were cleared (incorrect summary).' }; }
      if (++tasks === 1) return result([write([item()])]);
      if (tasks === 2) return { ...result(), kind: 'context_overflow', text: '' };
      const continuity = request.messages.find(message => message.kind === 'execution_continuity');
      assert.deepEqual(JSON.parse(continuity.content).todos, [item()]); return result();
    } } } });
  kernel.start(snapshot, config); const done = await kernel.runUntilIdle(scope, 'run');
  assert.equal(done.phase, 'completed'); assert.ok(summaries > 0); assert.equal(tasks, 3);
  assert.deepEqual(done.todos.items, [item()]); assert.equal(done.todos.assistantTurns, 2);
});
