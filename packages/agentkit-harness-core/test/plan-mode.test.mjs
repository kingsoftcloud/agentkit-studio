import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeKernel, MemoryRunStore, emptyUsage, planModeToolDefinitions, todoToolDefinitions,
  executePlanMode, prepareEffect, planReviewInteractionId, hookResult } from '../dist/index.mjs';
import { reduceTurnInput } from '../dist/turn-input.mjs';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { fixture, tool, scope, digest } from './fixtures.mjs';

const call = (name, args = {}, callId = name) => ({ name, arguments: args, callId });
const enter = call('EnterPlanMode'), exit = call('ExitPlanMode', { plan: '  Inspect then implement.\n' });
const write = call('write'), read = call('read');
const result = (toolCalls = []) => ({ kind: toolCalls.length ? 'tool_calls' : 'final_candidate', text: toolCalls.length ? '' : 'Done', toolCalls, usage: emptyUsage() });
const configuration = (overrides = {}) => fixture({ planModePolicy: 'session-plan/v1', planModeInitialActive: false,
  todoPolicy: 'session-todos/v1', tools: [...planModeToolDefinitions(), ...todoToolDefinitions(),
    tool({ name: 'write', readOnly: false, concurrentSafe: false }), tool({ name: 'read' })], ...overrides });

for (const backend of ['memory', 'sqlite']) {
  test(`${backend}: EnterPlanMode blocks same-batch writes, permits Todo, and exact approval enables implementation`, async t => {
    const directory = mkdtempSync(join(tmpdir(), 'native-plan-'));
    const store = backend === 'sqlite' ? new SqliteRunStore(join(directory, 'runs.sqlite')) : new MemoryRunStore();
    t.after(() => { store.close?.(); rmSync(directory, { recursive: true, force: true }); });
    const { config, snapshot } = configuration(); let models = 0, effects = 0;
    const kernel = new NativeKernel({ store, digest, owner: 'plan', ports: {
      model: { generate: async request => {
        if (++models === 1) return result([enter, write, call('TodoWrite', { todos: [{ content: 'Plan', status: 'in_progress', priority: 'high' }] })]);
        if (models === 2) {
          assert.ok(request.messages.some(message => message.role === 'tool' && message.content.includes('plan_mode_write_denied')));
          return result([exit]);
        }
        if (models === 3) return result([{ ...write, callId: 'approved-write' }]);
        return result();
      } }, tools: { execute: async request => { effects++; assert.equal(request.call.callId, 'approved-write'); return { status: 'ok', content: 'Written' }; } } } });
    kernel.start(snapshot, config); const waiting = await kernel.runUntilIdle(scope, 'run');
    assert.equal(waiting.phase, 'awaiting_interaction'); assert.equal(waiting.planMode.active, true);
    assert.equal(waiting.todos.revision, 1); assert.equal(effects, 0);
    kernel.submit(scope, 'run', { commandId: 'stale', kind: 'submit_interaction', payload: { interactionId: 'other-review', decision: 'allow' } });
    assert.equal((await kernel.runUntilIdle(scope, 'run')).phase, 'awaiting_interaction');
    kernel.submit(scope, 'run', { commandId: 'approve', kind: 'submit_interaction',
      payload: { interactionId: waiting.pendingInteraction.interactionId, decision: 'allow' } });
    const done = await kernel.runUntilIdle(scope, 'run'); assert.equal(done.phase, 'completed'); assert.equal(effects, 1);
    assert.equal(done.planMode.active, false); assert.equal(done.planMode.approvedPlan.plan, exit.arguments.plan);
    const next = kernel.start({ ...snapshot, runId: 'next', turnId: 'next' }, { ...config, planModeInitialActive: true });
    assert.equal(next.planMode.active, true); assert.deepEqual(next.planMode.approvedPlan, done.planMode.approvedPlan);
  });
}

test('denied plan review retains mode and returns feedback; malformed plans never ask for approval', async () => {
  const { config, snapshot } = configuration({ planModeInitialActive: true });
  for (const plan of ['', '   ', 'x'.repeat(20001), '💡'.repeat(12000)]) assert.equal(executePlanMode(snapshot, config, call('ExitPlanMode', { plan }), null).status, 'error');
  assert.equal(executePlanMode(snapshot, config, call('ExitPlanMode', { plan: 'plain plan', extra: true }), null).status, 'approval_required');
  assert.equal(executePlanMode(snapshot, config, call('ExitPlanMode', { plan: 'plan', allowedPrompts: [{ tool: 'Bash', prompt: '', extra: true }] }), null).status, 'error');
  const store = new MemoryRunStore(); let models = 0;
  const kernel = new NativeKernel({ store, digest, owner: 'denied-plan', ports: {
    model: { generate: async request => {
      if (++models === 1) return result([exit]);
      assert.match(request.messages.at(-1).content, /Add rollback steps/); return result();
    } }, tools: { execute: async () => assert.fail('No external tool authorized') } } });
  kernel.start(snapshot, config); const waiting = await kernel.runUntilIdle(scope, 'run');
  kernel.submit(scope, 'run', { commandId: 'deny', kind: 'submit_interaction', payload: {
    interactionId: waiting.pendingInteraction.interactionId, decision: 'deny', feedback: 'Add rollback steps' } });
  const done = await kernel.runUntilIdle(scope, 'run'); assert.equal(done.phase, 'completed'); assert.equal(done.planMode.active, true);
  assert.equal(done.planMode.approvedPlan, undefined);
});

test('cold SQLite takeover commits an already-approved pure exit once without asking again or replaying external effects', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'native-plan-exit-')), filename = join(directory, 'runs.sqlite');
  let store = new SqliteRunStore(filename); t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const { config, snapshot } = configuration({ planModeInitialActive: true }); store.create(config, snapshot);
  const lease = store.acquire(scope, 'run', 'lost', 1, 1), calls = [exit];
  const batch = prepareEffect(snapshot, 'tool', 'executing_tools', { calls, interaction: {
    interactionId: planReviewInteractionId(exit), callId: exit.callId, decision: 'allow' } }, {
    pendingTools: calls, messages: [...snapshot.messages, { role: 'assistant', content: '', toolCalls: calls }] });
  store.commit(scope, 'run', lease, 1, 0, batch); store.claim(scope, 'run', lease, 1, batch.snapshot.pendingIntent);
  store.close(); store = new SqliteRunStore(filename);
  const kernel = new NativeKernel({ store, digest, owner: 'new', now: () => 100, ports: {
    model: { generate: async () => result() }, tools: { execute: async () => assert.fail('No external replay') } } });
  const done = await kernel.runUntilIdle(scope, 'run'); assert.equal(done.phase, 'completed');
  assert.equal(done.planMode.active, false); assert.equal(done.planMode.revision, 1);
  assert.equal(done.planMode.approvedPlan.plan, exit.arguments.plan);
  assert.equal(store.load(scope, 'run').events.filter(event => event.kind === 'plan.mode_changed').length, 1);
});

test('only admitted Host mode controls can switch restrictions; old policies reject the extra receipt field', async () => {
  const legacy = fixture(); assert.throws(() => reduceTurnInput(legacy.snapshot, { status: 'admitted', messages: [], planMode: true }), /invalid_turn_input/);
  const { config, snapshot } = configuration();
  assert.throws(() => reduceTurnInput(snapshot, { status: 'rejected', messages: [], planMode: false }), /invalid_turn_input/);
  let models = 0, effects = 0, inputs = 0;
  const store = new MemoryRunStore(), kernel = new NativeKernel({ store, digest, owner: 'host-mode', ports: {
    input: { prepare: async () => ({ status: 'admitted', messages: [], planMode: ++inputs === 1 }) },
    model: { generate: async request => {
      if (++models === 1) return result([read]);
      if (models === 2) return result([write]);
      if (models === 3) { assert.ok(request.messages.some(message => message.role === 'tool' && message.content.includes('plan_mode_write_denied'))); return result([{ ...write, callId: 'after-host-off' }]); }
      return result();
    } }, tools: { execute: async request => { if (request.call.name === 'write') { effects++; assert.equal(request.call.callId, 'after-host-off'); }
      return { status: 'ok', content: 'Observed' }; } } } });
  kernel.start(snapshot, config); assert.equal((await kernel.runUntilIdle(scope, 'run')).phase, 'completed'); assert.equal(effects, 1);
});

test('policy absence preserves legacy external plan tool semantics', async () => {
  const { config, snapshot } = fixture({ tools: [tool({ name: 'EnterPlanMode', readOnly: false, concurrentSafe: false })] });
  let models = 0, effects = 0; const store = new MemoryRunStore();
  const kernel = new NativeKernel({ store, digest, owner: 'old-plan', ports: {
    model: { generate: async () => ++models === 1 ? result([enter]) : result() },
    tools: { execute: async () => { effects++; return { status: 'ok', content: 'External meaning' }; } } } });
  kernel.start(snapshot, config); const done = await kernel.runUntilIdle(scope, 'run');
  assert.equal(done.phase, 'completed'); assert.equal(effects, 1); assert.equal(Object.hasOwn(done, 'planMode'), false);
});

test('frozen MCP Plan access preserves approval and denies destructive and legacy unknown tools', async () => {
  const mcp = (name, destructive) => tool({ name, readOnly: false, concurrentSafe: false,
    planModeAccess: { contract: 'zcode-mcp-plan/v1', destructive } });
  const { config, snapshot } = configuration({ planModeInitialActive: true, todoPolicy: undefined, tools: [...planModeToolDefinitions(),
    mcp('allowed', false), mcp('destructive', true), tool({ name: 'mcp_named_but_unbound', readOnly: false, concurrentSafe: false })] });
  const store = new MemoryRunStore(); let models = 0; const invoked = [];
  const kernel = new NativeKernel({ store, digest, owner: 'mcp-plan', ports: {
    model: { generate: async request => {
      if (++models === 1) return result([call('allowed'), call('destructive'), call('mcp_named_but_unbound')]);
      assert.equal(request.messages.filter(message => message.role === 'tool' && message.content.includes('plan_mode_write_denied')).length, 2);
      return result();
    } }, tools: { execute: async request => {
      invoked.push(request); assert.equal(request.call.name, 'allowed'); assert.equal(request.definition.readOnly, false);
      if (!request.interaction) return { status: 'approval_required', interactionId: 'mcp-review', content: 'Review MCP action' };
      assert.equal(request.interaction.decision, 'allow'); return { status: 'ok', content: 'MCP result' };
    } } } });
  kernel.start(snapshot, config); const waiting = await kernel.runUntilIdle(scope, 'run'); assert.equal(waiting.phase, 'awaiting_interaction');
  kernel.submit(scope, 'run', { commandId: 'allow-mcp', kind: 'submit_interaction', payload: { interactionId: waiting.pendingInteraction.interactionId, decision: 'allow' } });
  const done = await kernel.runUntilIdle(scope, 'run'); assert.equal(done.phase, 'completed');
  assert.equal(done.planMode.active, true); assert.equal(invoked.length, 2);
});

test('Plan access never turns MCP hints into repeatable-read or concurrency authority', () => {
  const base = tool({ name: 'mcp', readOnly: false, concurrentSafe: false,
    planModeAccess: { contract: 'zcode-mcp-plan/v1', destructive: false } });
  for (const override of [{ readOnly: true }, { concurrentSafe: true }, { recoveryPolicy: 'safe-read/v1' },
    { planModeAccess: { contract: 'zcode-mcp-plan/v1', destructive: 'false' } },
    { planModeAccess: { contract: 'zcode-mcp-plan/v1', destructive: false, allow: true } }])
    assert.throws(() => fixture({ tools: [{ ...base, ...override }] }), /invalid_plan_mode_access|invalid_tool_concurrency/);
});

test('dynamic Plan command permission fails closed without its port and only seals active-mode requests', async () => {
  for (const decision of [undefined, false, true, 'inactive']) {
    const definition = tool({ name: 'run_command', readOnly: false, concurrentSafe: false,
      backgroundCommandPolicy: 'owned-command-launch/v1', planModeCommandPolicy: 'zcode-posix-readonly/v1',
      parameters: { type: 'object', required: ['command'], properties: { command: { type: 'string' } } } });
    const { config, snapshot } = configuration({ planModeInitialActive: decision !== 'inactive',
      tools: [...planModeToolDefinitions(), ...todoToolDefinitions(), definition] });
    let models = 0, effects = 0, checks = 0;
    const kernel = new NativeKernel({ store: new MemoryRunStore(), digest, owner: 'command-plan', ports: {
      model: { generate: async request => {
        if (++models === 1) return result([call('run_command', { command: 'pwd' })]);
        if (decision === undefined || decision === false) assert.match(request.messages.at(-1).content, /plan_mode_write_denied/);
        return result();
      } }, tools: { ...(decision === undefined ? {} : { checkPlanMode: async request => {
        checks++; assert.equal(request.planMode, 'session-plan/v1'); return decision === true;
      } }), execute: async request => {
        effects++; assert.equal(request.planMode, decision === true ? 'session-plan/v1' : undefined);
        return { status: 'ok', content: 'Read command result' };
      } } } });
    kernel.start(snapshot, config); assert.equal((await kernel.runUntilIdle(scope, 'run')).phase, 'completed');
    assert.equal(effects, decision === true || decision === 'inactive' ? 1 : 0);
    assert.equal(checks, decision === true || decision === false ? 1 : 0);
  }
});

for (const kind of ['MCP', 'command']) test(`cold claimed ${kind} admitted in planning is reconciled instead of re-executed`, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'native-plan-mcp-')), filename = join(directory, 'runs.sqlite');
  let store = new SqliteRunStore(filename); t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const name = kind === 'MCP' ? 'mcp' : 'run_command';
  const mcp = call(name); const { config, snapshot } = configuration({ planModeInitialActive: true, todoPolicy: undefined, tools: [...planModeToolDefinitions(),
    tool({ name, readOnly: false, concurrentSafe: false, ...(kind === 'MCP'
      ? { planModeAccess: { contract: 'zcode-mcp-plan/v1', destructive: false } }
      : { planModeCommandPolicy: 'zcode-posix-readonly/v1', backgroundCommandPolicy: 'owned-command-launch/v1' }) })] });
  store.create(config, snapshot); const lease = store.acquire(scope, 'run', 'lost', 1, 1);
  const batch = prepareEffect(snapshot, 'tool', 'executing_tools', { calls: [mcp], interaction: null }, {
    pendingTools: [mcp], messages: [...snapshot.messages, { role: 'assistant', content: '', toolCalls: [mcp] }] });
  store.commit(scope, 'run', lease, 1, 0, batch); store.claim(scope, 'run', lease, 1, batch.snapshot.pendingIntent);
  store.close(); store = new SqliteRunStore(filename);
  const done = await new NativeKernel({ store, digest, owner: 'replacement', now: () => 100, ports: {
    model: { generate: async () => assert.fail('Must reconcile before inference') },
    tools: { execute: async () => assert.fail('No blind MCP replay') } } }).runUntilIdle(scope, 'run');
  assert.equal(done.phase, 'interrupted'); assert.equal(done.reason, 'effect_outcome_unknown'); assert.equal(done.planMode.active, true);
});

test('takeover of a claimed pure session control preserves the durable pre-tool hook denial', async () => {
  for (const attempted of [enter, call('TodoWrite', { todos: [{ content: 'Denied', status: 'pending', priority: 'high' }] })]) {
    const { config, snapshot } = configuration({ hooks: [{ hookId: 'deny', sourceRef: 'host://deny',
      bindingDigest: `sha256:${'a'.repeat(64)}`, executionPolicyDigest: `sha256:${'b'.repeat(64)}`, readOnly: true,
      events: ['PreToolUse'], timeoutMs: 100, maxInputBytes: 64000, maxOutputBytes: 64000, failureMode: 'block' }] });
    const store = new MemoryRunStore(), claim = store.claim.bind(store); let models = 0;
    const ports = { tools: { execute: async () => assert.fail('No external effect') },
      model: { generate: async () => ++models === 1 ? result([attempted]) : result() },
      hooks: { invoke: async request => hookResult(request, 'ok', { action: 'deny', additionalContext: [], updatedArguments: null }) } };
    store.claim = (...args) => {
      const value = claim(...args);
      if (store.load(scope, 'run').intents.find(intent => intent.operationKey === args.at(-1))?.kind === 'tool') throw Error('Process lost after claim');
      return value;
    };
    const first = new NativeKernel({ store, ports, digest, owner: 'lost', now: () => 1 }); first.start(snapshot, config);
    await assert.rejects(first.runUntilIdle(scope, 'run'), /Process lost after claim/);
    store.claim = claim;
    const done = await new NativeKernel({ store, ports, digest, owner: 'replacement', now: () => 100 }).runUntilIdle(scope, 'run');
    assert.equal(done.phase, 'completed'); assert.equal(done.planMode.active, false); assert.equal(done.todos.revision, 0);
    assert.ok(done.messages.some(message => message.role === 'tool' && message.content.includes('pre_tool_hook_denied')));
  }
});
