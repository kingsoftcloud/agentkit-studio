import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeKernel, MemoryRunStore, emptyUsage, prepareEffect, coordinatorResponseDefinition,
  executeCoordinatorResponse, reduceCoordinatorResponses, configure, CHILD_OWNER_CONTRACT } from '../dist/index.mjs';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { fixture, scope, digest } from './fixtures.mjs';

const call = { name: 'RespondToCoordinator', callId: 'response-1', arguments: { summary: 'Located the cause', message: 'Still fixing it; this is progress, not the final result.' } };
const response = (toolCalls = []) => ({ kind: toolCalls.length ? 'tool_calls' : 'final_candidate', text: toolCalls.length ? '' : 'Final child evidence', toolCalls, usage: emptyUsage() });
const binding = { contract: CHILD_OWNER_CONTRACT, parent: fixture().snapshot, parentOperationKey: 'start-op', parentToolCallId: 'start',
  parentExecutionFence: 1, childRequestDigest: digest('child'), role: 'worker', maxModelCalls: 3, maxToolCalls: 2 };
// The Host owner validates the parent's real ledger. These tests isolate the child receipt machinery.
const configuration = () => fixture({ coordinatorResponsePolicy: 'owned-parent-response/v1', childOwnerBinding: binding,
  limits: { maxModelCalls: 3, maxToolCalls: 2 }, tools: [coordinatorResponseDefinition()] });

for (const backend of ['memory', 'sqlite']) test(`${backend}: lost response claim queues exactly once in the receipt commit`, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'native-response-'));
  const store = backend === 'sqlite' ? new SqliteRunStore(join(directory, 'run.sqlite')) : new MemoryRunStore();
  t.after(() => { store.close?.(); rmSync(directory, { recursive: true, force: true }); });
  const { config, snapshot } = configuration(); store.create(config, snapshot);
  const lease = store.acquire(scope, 'run', 'lost', 1, 1);
  const batch = prepareEffect(snapshot, 'tool', 'executing_tools', { calls: [call], interaction: null }, {
    pendingTools: [call], messages: [...snapshot.messages, { role: 'assistant', content: '', toolCalls: [call] }] });
  store.commit(scope, 'run', lease, 1, 0, batch); store.claim(scope, 'run', lease, 1, batch.snapshot.pendingIntent);
  let models = 0;
  const kernel = new NativeKernel({ store, digest, owner: 'new', now: () => 100, ports: {
    tools: { execute: async () => assert.fail('No external delivery before or after commit') },
    model: { generate: async request => { models++; assert.match(request.messages.at(-1).content, /Continue the current task/); return response(); } } } });
  const done = await kernel.runUntilIdle(scope, 'run');
  assert.equal(done.phase, 'completed'); assert.equal(models, 1); assert.equal(done.usage.toolCalls, 1);
  const record = store.load(scope, 'run'), facts = record.events.filter(event => event.kind === 'coordinator.response_queued');
  assert.equal(facts.length, 1); assert.equal(facts[0].payload.message, call.arguments.message);
  assert.equal(record.receipts.find(row => row.operationKey === batch.snapshot.pendingIntent).result.recoveryPolicy, 'owned-parent-response/v1');
  await kernel.runUntilIdle(scope, 'run'); assert.equal(store.load(scope, 'run').events.filter(event => event.kind === 'coordinator.response_queued').length, 1);
});

test('response validates the reference strict shape and UTF-16 limits, retaining whitespace', () => {
  const { config, snapshot } = configuration();
  for (const args of [{ summary: '', message: 'm' }, { summary: 's', message: '' }, { ...call.arguments, extra: true },
    { summary: '😀'.repeat(101), message: 'm' }, { summary: 's', message: '😀'.repeat(10001) }])
    assert.equal(executeCoordinatorResponse(snapshot, config, { ...call, arguments: args }, digest).status, 'error');
  assert.equal(executeCoordinatorResponse(snapshot, config, { ...call, arguments: { summary: ' ', message: ' ' } }, digest).status, 'ok');
  const unowned = configure({ ...config, childOwnerBinding: undefined });
  assert.throws(() => new NativeKernel({ store: new MemoryRunStore(), digest, owner: 'parent', ports: {} }).start(snapshot, unowned), /coordinator_response_parent_unavailable/);
});

test('parent consumes only its child facts as data, with monotonic durable cursors and no guidance debt', () => {
  const { config, snapshot } = fixture({ childTaskPolicy: 'session-controls/v1', childLifecyclePolicy: 'owned-background/v2' });
  const report = { childRunId: 'child', childToolCallId: 'c', sequence: 20,
    responseId: `response_${digest({ childRunId: 'child', childToolCallId: 'c' })}`, ...call.arguments };
  const changes = reduceCoordinatorResponses(snapshot, config, [report], ['child'], digest), updated = { ...snapshot, ...changes };
  assert.equal(changes.messages.at(-1).kind, 'child_response'); assert.equal(JSON.parse(changes.messages.at(-1).content).trust, 'data');
  assert.equal(updated.childResponseCursors.child, 20); assert.deepEqual(updated.queuedGuidance, []);
  assert.deepEqual(reduceCoordinatorResponses(updated, config, [report], ['child'], digest), {});
  assert.throws(() => reduceCoordinatorResponses(snapshot, config, [report], ['other-child'], digest), /invalid_coordinator_response/);
  assert.throws(() => reduceCoordinatorResponses(snapshot, config, [report, report], ['child'], digest), /invalid_coordinator_response/);
  assert.throws(() => reduceCoordinatorResponses(snapshot, fixture().config, [report], ['child'], digest), /coordinator_responses_unavailable/);
});
