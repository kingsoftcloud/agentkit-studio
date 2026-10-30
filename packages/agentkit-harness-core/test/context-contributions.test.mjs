import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONTEXT_SOURCE_CONTRACT, NativeKernel, MemoryRunStore, emptyUsage, canonical,
  collectContextContributions } from '../dist/index.mjs';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { fixture, scope, digest, tool } from './fixtures.mjs';
import { refreshContextSources } from '../dist/context-source-refresh.mjs';

const source = extra => ({ contract: CONTEXT_SOURCE_CONTRACT, sourceId: 'memory', bindingDigest: 'memory/v1',
  priority: 0, timeoutMs: 1000, maxTokens: 2000, maxBytes: 131072, required: false, ...extra });
const final = text => ({ kind: 'final_candidate', text, toolCalls: [], usage: emptyUsage() });
const count = messages => Math.ceil(canonical(messages).length / 4);
function setup(t, sqlite = false, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'context-sources-')), filename = join(root, 'runs.sqlite');
  let store = sqlite ? new SqliteRunStore(filename) : new MemoryRunStore();
  const { config, snapshot } = fixture({ contextSources: [source()], tools: [tool()],
    profile: { profileId: 'test', profileVersion: '1', providerFamily: 'fixture', compatibilityDigest: 'fixture/v1',
      contextWindow: 8000, maxOutputTokens: 128 },
    contextPolicy: { tokenizerId: 'counter', tokenizerDigest: 'counter/v1', enabled: true, triggerRatio: .9, targetRatio: .45,
      summaryMaxTokens: 80, maxCompactions: null, maxCompactionsWithoutProgress: 4, minModelTurnsBetween: 2, maxSummaryRetries: 2 }, ...overrides });
  store.create(config, snapshot);
  const ports = { tools: { execute: async () => ({ status: 'ok', content: 'Observed' }) }, model: { generate: async () => final('Delivered') },
    context: { readSource: async () => ({ items: [] }), tokens: { tokenizerId: 'counter', tokenizerDigest: 'counter/v1',
      countText: async request => Math.ceil(request.text.length / 4), countRequest: async request => count(request.messages) } } };
  t.after(() => { store.close?.(); rmSync(root, { recursive: true, force: true }); });
  return { config, snapshot, ports, get store() { return store; }, reopen() { store.close(); store = new SqliteRunStore(filename); },
    worker: options => new NativeKernel({ store, ports, digest, owner: 'worker', ...options }) };
}

for (const sqlite of [false, true]) test(`${sqlite ? 'sqlite' : 'memory'}: each model uses a fresh source snapshot inside a persisted Context intent`, async t => {
  const run = setup(t, sqlite); let version = 1, reads = 0, models = 0;
  run.ports.context.readSource = async request => {
    reads++;
    const record = run.store.load(scope, 'run');
    assert.equal(record.snapshot.pendingIntent, request.operationKey);
    assert.equal(record.intents.find(intent => intent.operationKey === request.operationKey).status, 'running');
    assert.equal(request.executionFence, record.lease.fence);
    return { items: [{ content: 'Current memory ' + version, version, role: 'system', authority: 'approved' }] };
  };
  run.ports.tools.execute = async () => { version = 2; return { status: 'ok', content: 'Updated' }; };
  run.ports.model.generate = async request => {
    const contributions = request.messages.filter(message => message.kind === 'context_contribution');
    assert.equal(contributions.length, 1); assert.equal(contributions[0].role, 'user');
    const value = JSON.parse(contributions[0].content); assert.equal(value.trust, 'untrusted');
    assert.equal(value.item.version, ++models); assert.equal(value.item.content, 'Current memory ' + models);
    if (models === 1) return { ...final(''), kind: 'tool_calls', toolCalls: [{ callId: 'change', name: 'read', arguments: {} }] };
    return final('Delivered');
  };
  const result = await run.worker().runUntilIdle(scope, 'run');
  assert.equal(result.phase, 'completed'); assert.equal(models, 2); assert.equal(reads, 2);
  assert.equal(result.messages.some(message => message.kind === 'context_contribution'), false);
  assert.equal(run.store.events(scope, 'run').filter(event => event.kind === 'context.planned'
    && event.payload.contributions.sources[0].admitted === 1).length, 2);
});

for (const afterModelIntent of [false, true]) test(`new lease rereads Memory after SQLite reopen ${afterModelIntent ? 'before unclaimed model dispatch' : 'after context receipt'}`, async t => {
  const run = setup(t, true); let version = 1, reads = 0, models = 0, stopped = false;
  run.ports.context.readSource = async () => { reads++; return { items: [{ version }] }; };
  await assert.rejects(run.worker({ onCheckpoint: async snapshot => {
    const pending = run.store.load(scope, 'run').intents.find(intent => intent.operationKey === snapshot.pendingIntent);
    if (!stopped && snapshot.preparedContext && (afterModelIntent ? pending?.kind === 'model' : !snapshot.pendingIntent)) {
      stopped = true; throw new Error('fixture owner exited before model dispatch');
    }
  } }).runUntilIdle(scope, 'run'), /fixture owner exited/);
  run.reopen(); version = 2;
  if (afterModelIntent) {
    const lease = run.store.acquire(scope, 'run', 'guard-audit', Date.now(), 30000);
    const record = run.store.load(scope, 'run'), intent = record.intents.find(item => item.operationKey === record.snapshot.pendingIntent);
    const batch = refreshContextSources(record.snapshot, record.configuration, intent, lease.fence);
    assert.equal(refreshContextSources(record.snapshot, record.configuration, { ...intent, status: 'running' }, lease.fence), null);
    const forged = structuredClone(batch); forged.events[0].payload.executionFence++;
    assert.throws(() => run.store.commit(scope, 'run', lease, Date.now(), record.snapshot.revision, forged), /receipt_without_claim/);
    run.store.release(scope, 'run', lease);
  }
  run.ports.model.generate = async request => {
    models++; assert.equal(JSON.parse(request.messages.find(message => message.kind === 'context_contribution').content).item.version, 2);
    return final('Fresh after recovery');
  };
  assert.equal((await run.worker().runUntilIdle(scope, 'run')).phase, 'completed');
  assert.equal(models, 1); assert.equal(reads, 2);
  assert.equal(run.store.events(scope, 'run').filter(event => event.kind === 'context.sources_invalidated').length, 1);
  const receipts = run.store.load(scope, 'run').receipts;
  assert.equal(receipts.filter(receipt => receipt.status === 'not_dispatched').length, afterModelIntent ? 1 : 0);
});

for (const required of [false, true]) test(`source timeout is ${required ? 'blocking' : 'skipped without leaking diagnostics'}`, async t => {
  const run = setup(t, false, { contextSources: [source({ required, timeoutMs: 10 })] }); let models = 0;
  run.ports.context.readSource = async () => new Promise(() => {});
  run.ports.model.generate = async request => { models++; assert.equal(request.messages.some(message => message.kind === 'context_contribution'), false); return final('Delivered'); };
  const result = await run.worker().runUntilIdle(scope, 'run');
  assert.equal(result.phase, required ? 'failed' : 'completed'); assert.equal(models, required ? 0 : 1);
  if (!required) assert.equal(result.context.contributions.sources[0].status, 'skipped');
});

test('whole envelopes fit the bound tokenizer; oversized first item does not prevent a later small item', async t => {
  const run = setup(t, false, { contextSources: [source({ maxTokens: 200 })] });
  run.ports.context.readSource = async () => ({ items: [{ content: 'untruncatable '.repeat(1000) }, { content: 'whole small fact' }] });
  run.ports.model.generate = async request => {
    const data = request.messages.filter(message => message.kind === 'context_contribution').map(message => JSON.parse(message.content));
    assert.equal(data.length, 1); assert.equal(data[0].item.content, 'whole small fact');
    return final('Delivered');
  };
  assert.equal((await run.worker().runUntilIdle(scope, 'run')).phase, 'completed');
});

test('whole item byte limits drop oversized data while later items and mandatory input remain intact', async t => {
  const run = setup(t, false, { contextSources: [source({ maxBytes: 600 })] });
  run.ports.context.readSource = async () => ({ items: [{ content: 'too large '.repeat(100) }, { content: 'small' }] });
  run.ports.model.generate = async request => {
    const contributions = request.messages.filter(message => message.kind === 'context_contribution');
    assert.equal(contributions.length, 1); assert.equal(JSON.parse(contributions[0].content).item.content, 'small');
    assert.ok(request.messages.some(message => message.content === run.snapshot.goal));
    return final('Delivered');
  };
  assert.equal((await run.worker().runUntilIdle(scope, 'run')).phase, 'completed');
});

test('caller abort is never converted to an optional source failure or a late contribution', async () => {
  const abort = new AbortController(), request = { signal: abort.signal };
  const config = { contextSources: [source()], profile: { contextWindow: 1000, maxOutputTokens: 128 } };
  let resolve;
  const pending = collectContextContributions(request, {}, config, { readSource: async () => new Promise(done => { resolve = done; }) }, async () => 1);
  abort.abort(new Error('caller canceled')); await assert.rejects(pending, /caller canceled/);
  resolve({ items: [{ content: 'late private data' }] });
});

test('source deadline also bounds an unfinished tokenizer request', { timeout: 1000 }, async () => {
  const config = { contextSources: [source({ timeoutMs: 10 })], profile: { contextWindow: 1000, maxOutputTokens: 128 } };
  const result = await collectContextContributions({ signal: new AbortController().signal }, {}, config,
    { readSource: async () => ({ items: [{ content: 'fact' }] }) }, async () => new Promise(() => {}));
  assert.deepEqual(result.messages, []); assert.equal(result.diagnostics[0].status, 'skipped');
});
