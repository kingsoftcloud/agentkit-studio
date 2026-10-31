import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { NativeKernel, MemoryRunStore, emptyUsage, prepareEffect, reduceTools, reduceChildBudget, admittedToolBudget, TOOL_RESOURCE_USAGE_CONTRACT } from '../dist/index.mjs';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { fixture, scope, digest, tool } from './fixtures.mjs';

const definition = tool({ name: 'observe', readOnly: false, concurrentSafe: false });
const call = { callId: 'observe-1', name: 'observe', arguments: {} };
const usage = () => ({ ...emptyUsage(), inputTokens: 12, outputTokens: 4, modelCalls: 1, cost: .25, cacheWriteInputTokens: 3 });
const configuration = { tools: [definition], limits: { maxModelCalls: 3, maxWallMs: null, finalizationReserveModelCalls: 1 } };
const response = (calls = []) => ({ kind: calls.length ? 'tool_calls' : 'final_candidate', text: calls.length ? '' : 'Done', toolCalls: calls, usage: emptyUsage() });

function prepared(results) {
  const { snapshot, config } = fixture(configuration);
  const batch = prepareEffect({ ...snapshot, pendingTools: [call] }, 'tool', 'executing_tools', { calls: [call] });
  return () => reduceTools(batch.snapshot, results, [call], batch.intents[0], config, digest);
}

for (const [name, result, code] of [
  ['flag without counters', { resourceUsageReported: false }, 'invalid_tool_usage_report_status'],
  ['nonboolean flag', { resourceUsage: usage(), resourceUsageReported: 'no' }, 'invalid_tool_usage_report_status'],
  ['negative counter', { resourceUsage: { ...usage(), inputTokens: -1 } }, 'invalid_usage'],
  ['missing counter', { resourceUsage: { modelCalls: 1 } }, 'invalid_usage'],
  ['null counter', { resourceUsage: { ...usage(), outputTokens: null } }, 'invalid_usage'],
  ['fractional counter', { resourceUsage: { ...usage(), modelCalls: .5 } }, 'invalid_usage'],
  ['negative cost', { resourceUsage: { ...usage(), cost: -1 } }, 'invalid_usage'],
  ['negative cache writes', { resourceUsage: { ...usage(), cacheWriteInputTokens: -1 } }, 'invalid_usage'],
  ['unknown field', { resourceUsage: { ...usage(), privateNote: 'must_not_be_a_usage_event' } }, 'invalid_usage'],
]) test(`nested tool usage rejects ${name}`, () => {
  assert.throws(prepared([{ status: 'ok', content: {}, ...result }]), { code });
});

test('approval cannot hide an already dispatched or unknown nested resource call', () => {
  for (const result of [
    { resourceUsage: usage() }, { resourceUsage: emptyUsage(), resourceUsageReported: false },
  ]) assert.throws(prepared([{ status: 'approval_required', interactionId: 'approval', content: {}, ...result }]),
    { code: 'tool_resource_usage_before_approval' });
});

for (const backend of ['memory', 'sqlite']) for (const reported of [true, false, undefined]) {
  test(`${backend}: ${reported === false ? 'partial' : reported === true ? 'reported' : 'legacy'} nested usage settles with the tool and survives repeated driving`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'native-tool-usage-'));
    const store = backend === 'sqlite' ? new SqliteRunStore(join(root, 'runs.sqlite')) : new MemoryRunStore();
    t.after(() => { store.close?.(); rmSync(root, { recursive: true, force: true }); });
    let models = 0, effects = 0;
    const kernel = new NativeKernel({ store, owner: 'worker', digest, ports: {
      model: { generate: async () => response(++models === 1 ? [call] : []) },
      tools: { execute: async request => {
        effects++; assert.equal(request.budget.maxModelCallsRemaining, 1);
        return { status: 'ok', content: { caption: 'untrusted observation' }, resourceUsage: usage(),
          ...(reported === undefined ? {} : { resourceUsageReported: reported }) };
      } },
    } });
    const { config, snapshot } = fixture(configuration); kernel.start(snapshot, config);
    const final = await kernel.runUntilIdle(scope, 'run');
    assert.equal(final.phase, 'completed'); assert.equal(models, 2); assert.equal(effects, 1);
    assert.equal(final.usage.modelCalls + final.descendantUsage.modelCalls, 3);
    assert.deepEqual(final.descendantUsage, usage());
    assert.equal(final.diagnostics.descendantUsageIncomplete === true, reported === false);
    const record = store.load(scope, 'run');
    const facts = record.events.filter(event => event.payload.source === 'tool_resources');
    assert.equal(facts.length, 1); assert.equal(facts[0].kind, reported === false ? 'usage.unavailable' : 'usage.reported');
    assert.equal(facts[0].payload.contract, TOOL_RESOURCE_USAGE_CONTRACT);
    assert.deepEqual(facts[0].payload.usage, usage());
    assert.equal(record.events.at(-1).payload.usageComplete, reported !== false);
    const receipt = record.receipts.find(row => row.result.results);
    assert.deepEqual(receipt.result.results[0].resourceUsage, usage());
    assert.equal(receipt.result.results[0].resourceUsageReported, reported);
    assert.deepEqual(await kernel.runUntilIdle(scope, 'run'), final);
    assert.deepEqual(store.load(scope, 'run'), record); assert.equal(models, 2); assert.equal(effects, 1);
  });
}

test('an uncertain tool result retains already incurred resource usage and the incomplete terminal diagnostic', async t => {
  const store = new MemoryRunStore(); let models = 0;
  const kernel = new NativeKernel({ store, owner: 'worker', digest, ports: {
    model: { generate: async () => { models++; return response([call]); } },
    tools: { execute: async () => ({ status: 'uncertain', content: {}, resourceUsage: usage(), resourceUsageReported: false }) },
  } });
  const { config, snapshot } = fixture(configuration); kernel.start(snapshot, config);
  const final = await kernel.runUntilIdle(scope, 'run');
  assert.equal(final.phase, 'interrupted'); assert.equal(final.reason, 'effect_outcome_unknown'); assert.equal(models, 1);
  assert.deepEqual(final.descendantUsage, usage()); assert.equal(final.diagnostics.descendantUsageIncomplete, true);
  assert.equal(store.events(scope, 'run').at(-1).payload.usageComplete, false);
  assert.equal(store.events(scope, 'run').filter(row => row.kind === 'usage.unavailable' && row.payload.source === 'tool_resources').length, 1);
});

test('a forbidden parallel resource call remains accounted when the batch is blocked', () => {
  const { snapshot, config } = fixture({ tools: [tool({ name: 'observe' })] });
  const calls = [call, { ...call, callId: 'observe-2' }];
  const batch = prepareEffect({ ...snapshot, pendingTools: calls }, 'tool', 'executing_tools', { calls });
  const result = reduceTools(batch.snapshot, [
    { status: 'ok', content: {}, resourceUsage: usage(), resourceUsageReported: false },
    { status: 'ok', content: {}, resourceUsage: { ...emptyUsage(), inputTokens: 7 } },
  ], calls, batch.intents[0], config, digest);
  assert.equal(result.reason, 'parallel_readonly_contract_violation');
  assert.equal(result.descendantUsage.modelCalls, 1); assert.equal(result.descendantUsage.inputTokens, 19);
  assert.equal(result.diagnostics.descendantUsageIncomplete, true);
});

test('cancellation before a tool receipt marks usage unknown and fences a late rejection', async () => {
  const store = new MemoryRunStore(), entered = Promise.withResolvers(), release = Promise.withResolvers();
  const kernel = new NativeKernel({ store, owner: 'worker', digest, ports: {
    model: { generate: async () => response([call]) },
    tools: { execute: async () => { entered.resolve(); await release.promise; throw Error('late tool failure'); } },
  } });
  const { config, snapshot } = fixture(configuration); kernel.start(snapshot, config);
  const running = kernel.runUntilIdle(scope, 'run'); await entered.promise;
  kernel.submit(scope, 'run', { commandId: 'cancel', kind: 'cancel', payload: {} });
  const final = await running, saved = store.load(scope, 'run');
  assert.equal(final.phase, 'canceled'); assert.equal(final.diagnostics.descendantUsageIncomplete, true);
  assert.equal(saved.events.at(-1).payload.usageComplete, false);
  assert.equal(saved.events.filter(row => row.kind === 'usage.unavailable' && row.payload.source === 'tool_resources').length, 1);
  release.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(store.load(scope, 'run'), saved);
});

test('a child settlement has one incomplete usage fact and seals its completeness for repeated collection', async () => {
  const store = new MemoryRunStore(); let models = 0, completed;
  const childTool = { ...definition, childBudgetPolicy: 'delegate/v1' };
  const { config, snapshot } = fixture({ ...configuration, tools: [childTool] });
  const kernel = new NativeKernel({ store, owner: 'worker', digest, ports: {
    model: { generate: async () => response(++models === 1 ? [call] : []) },
    tools: { execute: async request => {
      completed = { status: 'ok', content: { childResult: 'observation' }, childRunIds: ['child'],
        childBudgetReservation: { childRunId: 'child', childScope: { ...scope, agentId: 'child' },
          parentOperationKey: request.operationKey, parentToolCallId: call.callId,
          childRequestDigest: digest('child-request'), configurationDigest: digest('child-config'),
          maxModelCalls: 1, maxToolCalls: 0, settledUsageDigest: null, deliveryMode: 'foreground' },
        childBudgetSettlement: { childRunId: 'child', parentOperationKey: request.operationKey,
          childRequestDigest: digest('child-request'), terminalSnapshotDigest: digest('child-terminal') },
        resourceUsage: usage(), resourceUsageReported: false };
      return completed;
    } },
  } });
  kernel.start(snapshot, config); const final = await kernel.runUntilIdle(scope, 'run');
  assert.equal(final.phase, 'completed'); assert.equal(final.diagnostics.descendantUsageIncomplete, true);
  const facts = store.events(scope, 'run').filter(row => ['usage.reported', 'usage.unavailable'].includes(row.kind));
  assert.equal(facts.filter(row => row.payload.source === 'tool_resources').length, 0);
  assert.equal(facts.filter(row => row.kind === 'usage.unavailable' && row.payload.source === 'descendant_runs').length, 1);
  const repeated = { ...completed }; delete repeated.childBudgetReservation;
  const collect = value => reduceChildBudget(final, value, { ...definition, childBudgetPolicy: 'settle/v1' },
    'collect-op', { ...call, callId: 'collect' }, admittedToolBudget(final, config), digest);
  assert.deepEqual(collect(repeated).usage, emptyUsage());
  assert.throws(() => collect({ ...repeated, resourceUsageReported: true }), { code: 'child_budget_settlement_changed' });
});

for (const point of ['before_receipt', 'after_commit']) test(`SIGKILL ${point} preserves known usage and its missing part without repeating the effect`, async t => {
  const root = mkdtempSync(join(tmpdir(), 'native-tool-usage-kill-')), filename = join(root, 'runs.sqlite'), marker = join(root, 'effect.txt');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = `
    import { NativeKernel,emptyUsage } from ${JSON.stringify(new URL('../dist/index.mjs', import.meta.url).href)};
    import { fixture,scope,digest } from ${JSON.stringify(new URL('./fixtures.mjs', import.meta.url).href)};
    import { SqliteRunStore } from ${JSON.stringify(import.meta.resolve('@kingsoftcloud/agentkit-harness-node/native/sqlite-store'))};
    import { appendFileSync } from 'node:fs';
    const store=new SqliteRunStore(${JSON.stringify(filename)}), commit=store.commit.bind(store);
    store.commit=(...args)=>{const saved=commit(...args);if(${point === 'after_commit'}&&args.at(-1).receipts?.some(row=>row.result.results))process.kill(process.pid,'SIGKILL');return saved};
    const kernel=new NativeKernel({store,owner:'killed-worker',digest,ports:{
      model:{generate:async()=>(${JSON.stringify(response([call]))})},
      tools:{execute:async()=>{appendFileSync(${JSON.stringify(marker)},'original\\n');if(${point === 'before_receipt'})process.kill(process.pid,'SIGKILL');return {status:'ok',content:{caption:'partial'},resourceUsage:${JSON.stringify(usage())},resourceUsageReported:false}}}
    }});
    const {config,snapshot}=fixture(${JSON.stringify(configuration)});kernel.start(snapshot,config);await kernel.runUntilIdle(scope,'run');
    throw Error('kill gate was not reached');
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8', timeout: 15000 });
  assert.equal(child.signal, 'SIGKILL', child.stderr); assert.equal(readFileSync(marker, 'utf8'), 'original\n');
  const store = new SqliteRunStore(filename); t.after(() => store.close());
  const committed = store.load(scope, 'run');
  assert.deepEqual(committed.snapshot.descendantUsage, point === 'after_commit' ? usage() : emptyUsage());
  assert.equal(committed.receipts.filter(row => row.result.results).length, point === 'after_commit' ? 1 : 0);
  if (point === 'after_commit') assert.equal(committed.snapshot.diagnostics.descendantUsageIncomplete, true);
  else assert.ok(committed.snapshot.pendingIntent);
  // Expire the killed worker's real persisted lease through the public clock
  // injection; no direct record/schema edits or second tool launch.
  const recoveryNow = Math.max(Date.now(), committed.lease.expiresAt + 1); let models = 0;
  const kernel = new NativeKernel({ store, owner: 'cold-worker', digest, now: () => recoveryNow, ports: {
    model: { generate: async () => { models++; return response(); } },
    tools: { execute: async () => assert.fail('Committed tool effect cannot repeat') },
  } });
  const final = await kernel.runUntilIdle(scope, 'run');
  assert.equal(final.phase, point === 'after_commit' ? 'completed' : 'interrupted');
  assert.equal(models, point === 'after_commit' ? 1 : 0);
  assert.deepEqual(final.descendantUsage, point === 'after_commit' ? usage() : emptyUsage());
  assert.equal(final.diagnostics.descendantUsageIncomplete, true);
  const facts = store.events(scope, 'run');
  assert.equal(facts.filter(row => row.payload.source === 'tool_resources').length, 1);
  assert.equal(facts.at(-1).payload.usageComplete, false); assert.equal(readFileSync(marker, 'utf8'), 'original\n');
  assert.deepEqual(await kernel.runUntilIdle(scope, 'run'), final); assert.equal(models, point === 'after_commit' ? 1 : 0);
});
