import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeKernel, MemoryRunStore, advertisedTools, reduceModel, reduceTools, observeExecutionBudget,
  wallDeliveryOnly, writtenDeliveryPaths, deliverySummaryAllowed, deliveryTaskMessages, emptyUsage, canonical } from '../dist/index.mjs';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { fixture, scope, digest, tool } from './fixtures.mjs';
const path = 'evidence/report.md';
const read = tool({ name: 'read', contextRole: 'workspace_read', deliveryArtifactRole: 'read',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } });
const write = tool({ name: 'write', readOnly: false, concurrentSafe: false, deliveryWrite: true, deliveryArtifactRole: 'write',
  parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } });
const inspect = tool({ name: 'inspect' });
const final = text => ({ kind: 'final_candidate', text, toolCalls: [], usage: emptyUsage() });
const calls = (...toolCalls) => ({ kind: 'tool_calls', text: '', toolCalls, usage: emptyUsage() });
const call = (name, args = {}) => ({ callId: name, name, arguments: args });
function prepared(overrides = {}) {
  const { config, snapshot } = fixture({ tools: [inspect, read, write], limits: { maxWallMs: 600000, finalizationReserveWallMs: 60000 }, ...overrides });
  const head = { ...snapshot, phase: 'preparing_context', activeElapsedMs: 541000 };
  return { config, snapshot: observeExecutionBudget(head, config).snapshot };
}
function written(head, config, options = {}) {
  const selected = call('write', { path, content: 'Unverified evidence' });
  const input = { ...head, phase: 'executing_tools', pendingTools: [selected], messages: [...head.messages,
    { role: 'assistant', content: '', toolCalls: [selected] }] };
  return { ...input, ...reduceTools(input, [{ status: 'ok', content: { ok: true, path }, workspaceChangedPaths: [path], ...options }],
    [selected], { operationKey: 'write-effect' }, config, digest) };
}
test('deadline uses a durable current-goal quote and keeps only sealed delivery writers', () => {
  const { config, snapshot } = prepared();
  assert.equal(wallDeliveryOnly(snapshot, config), true);
  assert.deepEqual(advertisedTools(snapshot, config).map(t => t.name), ['write']);
  assert.equal(wallDeliveryOnly({ ...snapshot, goalRevision: 1 }, config), false);
  assert.equal(wallDeliveryOnly({ ...snapshot, executionBudgetObservation: undefined }, config), false);
  assert.equal(wallDeliveryOnly({ ...snapshot, usage: { ...snapshot.usage, modelCalls: 1 } }, config), true);
  assert.deepEqual(advertisedTools(snapshot, { ...config, limits: { ...config.limits, maxModelCalls: 1 } }), []);
  assert.deepEqual(advertisedTools(snapshot, { ...config, limits: { ...config.limits, maxToolCalls: 0 } }), []);
  assert.deepEqual(advertisedTools(snapshot, { ...config, contract: { ...config.contract, allowedToolNames: ['read'] } }), []);
  for (const elapsed of [0, 539999]) {
    const head = { ...snapshot, executionBudgetObservation: undefined, activeElapsedMs: elapsed };
    assert.equal(wallDeliveryOnly(observeExecutionBudget(head, config).snapshot, config), false);
  }
  assert.equal(wallDeliveryOnly(snapshot, { ...config, limits: { ...config.limits, finalizationReserveWallMs: 0 } }), false);
});
test('only an actual successful requested path grants current-goal inspection and schemas stay immutable', () => {
  const { config, snapshot } = prepared(), next = written(snapshot, config);
  assert.deepEqual(writtenDeliveryPaths(next), [path]);
  const reader = advertisedTools(next, config).find(t => t.name === 'read');
  assert.deepEqual(reader.parameters.properties.path.enum, [path]); assert.equal(read.parameters.properties.path.enum, undefined);
  assert.deepEqual(writtenDeliveryPaths({ ...next, goalRevision: 1 }), []);
  for (const result of [{ status: 'error' }, { status: 'uncertain' }, { workspaceChangedPaths: [] }, { workspaceChangedPaths: ['claimed.md'] }])
    assert.deepEqual(writtenDeliveryPaths(written(snapshot, config, result)), []);
  const unsealed = { ...config, tools: config.tools.map(t => t.name === 'write' ? { ...t, deliveryArtifactRole: 'none' } : t) };
  assert.deepEqual(writtenDeliveryPaths(written(snapshot, unsealed)), []);
  assert.deepEqual(advertisedTools({ ...snapshot, workspaceModifiedPaths: [path] }, config).map(t => t.name), ['write']);
});
for (const forbidden of ['source.py', '../report.md', 'evidence/./report.md']) test(`forbidden delivery read ${forbidden} refuses the entire batch without writes`, () => {
  const { config, snapshot } = prepared(), head = written(snapshot, config);
  const next = reduceModel(head, calls(call('read', { path: forbidden }), call('write', { path, content: 'must not write' })), config, 0, 0, digest);
  assert.equal(next.phase, 'preparing_context'); assert.deepEqual(next.pendingTools, []);
  const results = next.messages.slice(-2); assert.ok(results.every(m => JSON.parse(m.content).content.reason === 'delivery_read_path_not_written'));
});
test('delivery summary has explicit policy, actual receipt, original model reserve and no pending effects', () => {
  const { config: base, snapshot } = prepared();
  for (const policy of ['committed-write-summary/v1', 'delivery-window-summary/v2']) {
    const config = { ...base, limits: { ...base.limits, deliveryContextRecoveryPolicy: policy } };
    const head = written(snapshot, config); assert.equal(deliverySummaryAllowed(head, config), true);
    assert.equal(deliverySummaryAllowed(snapshot, config), policy.endsWith('/v2'));
    assert.equal(deliverySummaryAllowed(head, { ...config, limits: { ...config.limits, maxModelCalls: 1 } }), false);
    assert.equal(deliverySummaryAllowed({ ...head, pendingTools: [call('write')] }, config), false);
    assert.equal(deliverySummaryAllowed({ ...head, goalRevision: 1 }, config), false);
    assert.equal(deliverySummaryAllowed({ ...head, executionBudgetObservation: { ...head.executionBudgetObservation, wallMsRemaining: 0 } }, config), false);
  }
  assert.equal(deliverySummaryAllowed(written(snapshot, base), base), false);
});
test('new fields remain absent on unconfigured runs and invalid policies/roles are rejected', () => {
  const { config, snapshot } = fixture(); assert.equal(Object.hasOwn(config.limits, 'deliveryContextRecoveryPolicy'), false);
  assert.equal(Object.hasOwn(snapshot, 'deliveryArtifacts'), false); assert.equal(Object.hasOwn(snapshot, 'executionBudgetObservation'), false);
  assert.throws(() => fixture({ limits: { deliveryContextRecoveryPolicy: 'claims-pass' } }), /invalid_delivery_context_policy/);
  assert.throws(() => fixture({ tools: [tool({ deliveryArtifactRole: 'all' })] }), /invalid_delivery_artifact_role/);
});
for (const [changes, pagination, expected] of [
  [{}, true, /start_line=3/], [{}, false, /declares no line pagination/],
  [{ partial_line: 1, line_count: 0 }, true, /Do not guess its missing text/],
  [{ end_line: 4 }, true, /earlier ranges may remain unread/],
]) test(`deadline read continuation reflects actual admission: ${expected}`, () => {
  const { config: original, snapshot } = prepared();
  const config = { ...original, tools: original.tools.map(tool => tool.name === 'read' && pagination
    ? { ...tool, parameters: { ...tool.parameters, properties: { ...tool.parameters.properties, start_line: { type: 'integer' } } } } : tool) };
  const head = written(snapshot, config), source = { status: 'ok', content: { ok: true, path,
    content: 'Exact visible text', start_line: 1, end_line: 2, total_lines: 4, partial: true,
    suggested_action: 'Use ArtifactRead on the host artifact reference', ...changes },
    artifact_instruction: 'ArtifactSearch continuation', exactInteger: 9007199254740993n };
  const messages = [{ role: 'assistant', content: '', toolCalls: [call('read', { path })] },
    { role: 'tool', callId: 'read', content: canonical(source) }];
  const before = canonical(messages), view = deliveryTaskMessages(head, config, messages);
  assert.match(JSON.parse(view[1].content).content.suggested_action, expected);
  assert.equal(Object.hasOwn(JSON.parse(view[1].content), 'artifact_instruction'), false);
  assert.ok(view[1].content.includes('9007199254740993')); assert.equal(canonical(messages), before);
  const historical = { ...head, deliveryArtifacts: { goalRevision: 1, paths: [path] } };
  assert.match(JSON.parse(deliveryTaskMessages(historical, config, messages)[1].content).content.suggested_action, /outside current delivery read admission/);
  assert.deepEqual(deliveryTaskMessages(head, { ...config, limits: { ...config.limits, finalizationReserveWallMs: 0 } }, messages), messages);
});
for (const sqlite of [false, true]) test(`${sqlite ? 'SQLite' : 'Memory'} actual file delivery closes exploration, persists scope and survives reopening`, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'deadline-delivery-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const filename = join(dir, 'run.sqlite'); let store = sqlite ? new SqliteRunStore(filename) : new MemoryRunStore(), now = 0, models = 0, effects = [];
  t.after(() => store.close?.()); const { config, snapshot } = fixture({ tools: [inspect, read, write], limits: { maxWallMs: 600000, finalizationReserveWallMs: 60000, leaseMs: 1000000 } });
  const ports = { model: { generate: async request => {
    models++;
    if (models === 1) { assert.ok(request.tools.some(t => t.name === 'inspect')); return calls(call('inspect')); }
    assert.ok(request.messages.some(m => m.kind === 'deadline_delivery_policy'));
    if (models === 2) { assert.deepEqual(request.tools.map(t => t.name), ['write']); return calls(call('inspect')); }
    if (models === 3) return calls(call('write', { path, content: 'Unverified evidence' }));
    if (models === 4) { assert.deepEqual(request.tools.find(t => t.name === 'read').parameters.properties.path.enum, [path]); return calls(call('read', { path })); }
    return final('Delivered honestly; independent verification is missing.');
  } }, tools: { execute: async request => {
    effects.push(request.call.name);
    if (request.call.name === 'inspect') return { status: 'ok', content: 'observed' };
    if (request.call.name === 'write') { writeFileSync(join(dir, 'report.md'), request.call.arguments.content); return { status: 'ok', content: { ok: true, path }, workspaceChangedPaths: [path] }; }
    return { status: 'ok', content: readFileSync(join(dir, 'report.md'), 'utf8') };
  } } };
  let stopped = false;
  let kernel = new NativeKernel({ store, ports, digest, owner: 'first', now: () => now, onCheckpoint: async head => {
    if (head.usage.toolCalls === 1 && !head.pendingIntent && now === 0) now = 541000;
    if (!stopped && head.deliveryArtifacts?.paths.includes(path) && !head.pendingIntent) { stopped = true; throw Error('cold boundary'); }
  } }); kernel.start(snapshot, config);
  await assert.rejects(kernel.runUntilIdle(scope, 'run'), /cold boundary/);
  const saved = canonical(store.load(scope, 'run')); if (sqlite) { store.close(); store = new SqliteRunStore(filename); assert.equal(canonical(store.load(scope, 'run')), saved); }
  kernel = new NativeKernel({ store, ports, digest, owner: 'second', now: () => now });
  const result = await kernel.runUntilIdle(scope, 'run');
  assert.equal(result.phase, 'completed'); assert.equal(result.outcome, 'unverified');
  assert.deepEqual(effects, ['inspect', 'write', 'read']); assert.equal(models, 5); assert.equal(result.activeElapsedMs, 541000);
  assert.equal(readFileSync(join(dir, 'report.md'), 'utf8'), 'Unverified evidence'); assert.deepEqual(writtenDeliveryPaths(result), [path]);
});
test('a running model is aborted by the original wall deadline, not the larger request timeout', async () => {
  const { config, snapshot } = fixture({ limits: { maxWallMs: 400, finalizationReserveWallMs: 300 } });
  const store = new MemoryRunStore(); let aborted = false;
  const kernel = new NativeKernel({ store, digest, owner: 'deadline', ports: { model: { generate: request => new Promise((resolve, reject) => {
    request.signal.addEventListener('abort', () => { aborted = true; reject(request.signal.reason); }, { once: true });
  }) } } }); kernel.start(snapshot, config); const result = await kernel.runUntilIdle(scope, 'run');
  assert.equal(aborted, true); assert.equal(result.outcome, 'budget_exhausted'); assert.equal(result.reason, 'wall_time_hard_limit');
  assert.equal(result.usage.modelCalls, 1); assert.equal(result.usage.toolCalls, 0); assert.equal(result.finalText, '');
});
test('a held write at the hard deadline stays unknown and is never replayed on attach', async () => {
  const { config, snapshot } = fixture({ tools: [write], limits: { maxWallMs: 400, finalizationReserveWallMs: 300 } });
  const store = new MemoryRunStore(); let writes = 0;
  const kernel = new NativeKernel({ store, digest, owner: 'deadline', ports: { model: { generate: async () => calls(call('write', { path, content: 'x' })) },
    tools: { execute: request => { writes++; return new Promise((resolve, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true })); } } } });
  kernel.start(snapshot, config); const result = await kernel.runUntilIdle(scope, 'run');
  assert.equal(result.reason, 'effect_outcome_unknown'); assert.equal(result.phase, 'interrupted'); assert.equal(writes, 1);
  assert.deepEqual(writtenDeliveryPaths(result), []); assert.equal((await kernel.runUntilIdle(scope, 'run')).reason, result.reason); assert.equal(writes, 1);
});

test('wall clock rollback cannot extend the monotonic active deadline', async () => {
  const { config, snapshot } = fixture({ limits: { maxWallMs: 70, finalizationReserveWallMs: 60 } });
  const store = new MemoryRunStore(); let wall = 10000, elapsed = 0, models = 0;
  const kernel = new NativeKernel({ store, digest, owner: 'monotonic-deadline', now: () => wall,
    monotonicNow: () => elapsed, ports: { model: { generate: async () => {
      models++; elapsed += 80; wall -= 1000; return final('Returned after the original deadline.');
    } } } });
  kernel.start(snapshot, config); const result = await kernel.runUntilIdle(scope, 'run');
  assert.equal(models, 1); assert.equal(result.outcome, 'budget_exhausted');
  assert.equal(result.reason, 'wall_time_hard_limit'); assert.equal(result.activeElapsedMs, 80);
  assert.equal(result.finalText, '');
});

test('an expired prepared model retires atomically without a claim or dispatch', async () => {
  const { config, snapshot } = fixture({ limits: { maxWallMs: 70, finalizationReserveWallMs: 60 } });
  const store = new MemoryRunStore(); let now = 0;
  const kernel = new NativeKernel({ store, digest, owner: 'prepared-deadline', now: () => now,
    onCheckpoint: async head => { if (head.phase === 'requesting_model' && head.pendingIntent) now = 80; },
    ports: { model: { generate: async () => assert.fail('Expired prepared model must not dispatch') } } });
  kernel.start(snapshot, config); const result = await kernel.runUntilIdle(scope, 'run');
  assert.equal(result.outcome, 'budget_exhausted'); assert.equal(result.reason, 'wall_time_hard_limit');
  const record = store.load(scope, 'run');
  assert.equal(record.intents.length, 1); assert.equal(record.receipts[0].status, 'not_dispatched');
  assert.equal(record.snapshot.usage.modelCalls, 0);
  assert.deepEqual(await kernel.runUntilIdle(scope, 'run'), result);
});

test('delivery-window v2 repairs context before any write, charges the summary and keeps exploration closed', async () => {
  const contextPolicy = { tokenizerId: 'deadline-counter', tokenizerDigest: 'deadline-count/v1', enabled: true,
    triggerRatio: .99, targetRatio: .45, summaryMaxTokens: 128, maxCompactions: 4,
    maxCompactionsWithoutProgress: 4, minModelTurnsBetween: 2, maxSummaryRetries: 2 };
  const { config, snapshot } = fixture({ tools: [inspect, read, write], contextPolicy,
    profile: { ...fixture().config.profile, contextWindow: 12000, maxOutputTokens: 256 },
    limits: { maxWallMs: 600000, finalizationReserveWallMs: 60000, leaseMs: 1000000, deliveryContextRecoveryPolicy: 'delivery-window-summary/v2' } });
  let now = 0, tasks = 0, summaries = 0, writes = 0;
  const store = new MemoryRunStore();
  const worker = new NativeKernel({ store, digest, owner: 'context-delivery', now: () => now, onCheckpoint: async head => {
    if (head.usage.toolCalls === 2 && !head.pendingIntent && now === 0) now = 541000;
  }, ports: { model: { generate: async request => {
    if (request.tools.length === 0 && request.messages.some(message => message.kind === 'compaction_instructions')) {
      summaries++; return final('Observed two source receipts; independent acceptance remains unavailable.');
    }
    tasks++;
    if (tasks <= 2) return calls({ ...call('inspect'), callId: `inspect-${tasks}` });
    assert.equal(request.tools.some(tool => tool.name === 'inspect'), false);
    if (tasks === 3) return { kind: 'context_overflow', text: '', toolCalls: [], usage: emptyUsage() };
    if (tasks === 4) return calls(call('write', { path, content: 'Observed, unverified evidence.' }));
    return final('Delivered incomplete evidence honestly.');
  } }, tools: { execute: async request => {
    if (request.call.name === 'write') { writes++; return { status: 'ok', content: { ok: true, path }, workspaceChangedPaths: [path] }; }
    return { status: 'ok', content: 'Actual source observation '.repeat(20) };
  } }, context: { tokens: { tokenizerId: contextPolicy.tokenizerId, tokenizerDigest: contextPolicy.tokenizerDigest,
    countRequest: async request => Math.ceil(canonical({ messages: request.messages, tools: request.tools }).length / 4),
    countText: async request => Math.ceil(request.text.length / 4) } } } });
  worker.start(snapshot, config); const result = await worker.runUntilIdle(scope, 'run');
  assert.equal(result.phase, 'completed', result.reason); assert.equal(result.outcome, 'unverified');
  assert.equal(summaries, 1); assert.equal(writes, 1); assert.equal(tasks, 5); assert.equal(result.usage.modelCalls, 6);
  assert.equal(result.contextState.compactions, 1); assert.equal(result.activeElapsedMs, 541000);
});
