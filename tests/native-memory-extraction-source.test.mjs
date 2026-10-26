import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NativeKernel, MemoryRunStore, configure, emptyUsage, canonical } from '../packages/agentkit-harness-core/dist/index.mjs';
import { fixture, scope, digest } from '../packages/agentkit-harness-core/test/fixtures.mjs';
import { SqliteRunStore } from '../packages/agentkit-harness/src/native/sqlite-store.mjs';
import { SqliteNativeMemoryProvider } from '../packages/agentkit-harness/src/native/memory-store.mjs';
import { memoryDigest } from '../packages/agentkit-harness/src/native/memory-candidate.mjs';
import { buildNativeMemoryTools, nativeMemoryRequestDigest } from '../packages/agentkit-harness/src/native/memory-tools.mjs';
import { nativeRecoveryBinding } from '../src/providers/native-recovery-binding.mjs';
import { captureStudioNativeMemoryExtraction as capture, assertStudioNativeMemoryExtractionCurrent as assertCurrent }
  from '../src/providers/native-memory-extraction-source.mjs';

const final = () => ({ kind: 'final_candidate', text: 'I saved that fact.', toolCalls: [], usage: emptyUsage() });
function setup(t, backend = 'memory', ports = {}, toolDefinitions = []) {
  const root = mkdtempSync(join(tmpdir(), 'memory-source-'));
  let store = backend === 'memory' ? new MemoryRunStore() : new SqliteRunStore(join(root, 'runs.sqlite'));
  t.after(() => { store.close?.(); rmSync(root, { recursive: true, force: true }); });
  const record = { metadata: { id: scope.agentId, local: true, revision: 1 }, spec: { runtime: { type: 'harness' } } };
  const options = runId => ({ store, scope, sessionId: 'session', runId, record });
  const configuration = (text, { source = { kind: 'user' }, revision = 1, buildId = null } = {}) => {
    const raw = { id: 'input', role: 'user', content: [{ type: 'text', text }], source,
      providerReplay: { signature: 'PRIVATE_REPLAY' }, media: ['PRIVATE_MEDIA'], presentation: { private: 'PRIVATE_PRESENTATION' } };
    const base = fixture().config;
    return configure({ ...base, limits: { ...base.limits, effectTimeoutMs: 120001 },
      tools: toolDefinitions, inputMessages: [{ role: 'user', kind: 'user_input', content: text }],
      hostRecoveryBinding: nativeRecoveryBinding({ binding: { agentId: scope.agentId, agentRevision: revision, buildId },
        input: { messages: [raw] }, source: { provider: 'fixture', model: 'fixture' }, selection: {}, systemPrompt: '' }) });
  };
  async function run(runId, text, extra) {
    const kernel = new NativeKernel({ store, owner: 'source-owner', digest,
      ports: { model: { generate: async () => final() }, ...ports } });
    kernel.start({ scope, runId, sessionId: 'session', turnId: runId, parentRunId: null,
      taskChainId: 'chain', buildId: extra?.buildId ?? 'revision-test' }, configuration(text, extra));
    return kernel.runUntilIdle(scope, runId);
  }
  return { run, configuration, options, store: () => store, record,
    reopen() { if (backend === 'sqlite') { store.close(); store = new SqliteRunStore(join(root, 'runs.sqlite')); } } };
}

for (const backend of ['memory', 'sqlite']) {
  test(`${backend}: ordinary prose has ledger-proven stable source identities through continuation and cold reopening`, async t => {
    const f = setup(t, backend);
    await f.run('one', 'Our invoice timestamps use UTC.');
    const first = capture(f.options('one'));
    assert.equal(first.sources.length, 1);
    const firstSource = first.sources[0];
    assert.equal(firstSource.content, 'Our invoice timestamps use UTC.');
    assert.equal(firstSource.sourceDigest, memoryDigest(firstSource.content));
    assert.equal(first.boundaryId, first.messages.at(-1).id);
    assert.equal(assertCurrent(first, f.options('one')), undefined);
    assert.doesNotMatch(canonical(first), /PRIVATE_REPLAY|PRIVATE_MEDIA|PRIVATE_PRESENTATION|providerReplay|presentation/);
    assert.equal(first.messages.filter(message => !message.synthetic && !message.modelOnly).length, 1);
    f.reopen();
    assert.deepEqual(capture(f.options('one')), first);
    await f.run('two', 'Our reports use the same timezone.');
    const second = capture(f.options('two'));
    assert.deepEqual(second.sources.find(item => item.content === firstSource.content), firstSource);
    const priorBoundary = second.messages.findIndex(message => message.id === first.boundaryId);
    assert.ok(priorBoundary >= 0, `completed boundary ${first.boundaryId} survives history: ${second.messages.map(item => item.id).join(',')}`);
    const fresh = second.sources.find(item => item.content === 'Our reports use the same timezone.');
    assert.ok(second.messages.slice(priorBoundary + 1).some(item => item.id === fresh.sourceEventId));
    assert.throws(() => assertCurrent(first, f.options('one')), { code: 'studio_native_memory_extraction_not_current_head' });
    assert.throws(() => assertCurrent({ ...second, sourceDigest: memoryDigest('forged') }, f.options('two')),
      { code: 'studio_native_memory_extraction_stale_or_tampered' });
  });
}

test('source capture rejects mismatched Session/Build/revision and non-completed Runs', async t => {
  const f = setup(t);
  await f.run('one', 'Our invoices use UTC.', { buildId: 'build-1' });
  assert.throws(() => capture(f.options('one')), { code: 'studio_native_memory_extraction_capsule_unbound' });
  const options = { ...f.options('one'), buildId: 'build-1' };
  assert.equal(capture(options).parent.buildId, 'build-1');
  assert.throws(() => capture({ ...options, sessionId: 'foreign' }), { code: 'studio_native_memory_extraction_snapshot_unbound' });
  assert.throws(() => capture({ ...options, record: { ...f.record, metadata: { ...f.record.metadata, revision: 2 } } }),
    { code: 'studio_native_memory_extraction_capsule_unbound' });
  const kernel = new NativeKernel({ store: f.store(), owner: 'unstarted', digest, ports: {} });
  kernel.start({ scope, sessionId: 'session', runId: 'unfinished', turnId: 'unfinished', buildId: 'build-1',
    parentRunId: null, taskChainId: 'chain' }, f.configuration('Pending input.', { buildId: 'build-1' }));
  assert.throws(() => capture({ ...options, runId: 'unfinished' }), { code: 'studio_native_memory_extraction_snapshot_unbound' });
});

for (const source of [{ kind: 'schedule' }, { kind: 'context' }, { kind: 'model' }, null]) {
  test(`non-human admission ${source?.kind ?? 'missing'} is not an automatic Memory citation source`, async t => {
    const f = setup(t);
    await f.run('one', 'Remember my timezone is UTC.', { source });
    const snapshot = capture(f.options('one'));
    assert.deepEqual(snapshot.sources, []);
    assert.ok(snapshot.messages.every(message => message.modelOnly === true));
    assert.ok(!snapshot.messages.some(message => message.directMemoryWrite));
  });
}

test('a direct Memory write requires the real locked call, ledger result and SQLite owner receipt', async t => {
  const provider = new SqliteNativeMemoryProvider(':memory:', { principal: scope, scopes: ['user'] });
  t.after(() => provider.close());
  const policy = { enabled: true, providerRef: 'local-default', scopes: ['user'],
    recall: { enabled: true, maxTokens: 1600, topK: 8, minScore: .45 },
    write: { mode: 'candidate', flushBeforeCompaction: true, flushAfterTurn: true }, rollout: 'enabled' };
  const lockedDigest = memoryDigest('locked-memory-build');
  const tools = buildNativeMemoryTools({ policy, principal: scope, lockedDigest, provider,
    authorize: async () => 'allow', consent: async () => 'allow', resolveAuthority: () => 'explicit_user',
    resolveMutationSource: () => ({ sourceSessionId: 'session', sourceEventId: 'original-user',
      sourceGoalRevision: '1', sourceGoalDigest: memoryDigest('user input'), horizon: [] }),
    planner: { countMessage: message => Math.ceil(canonical(message).length / 4) } });
  let calls = 0;
  const f = setup(t, 'sqlite', { tools, model: { generate: async () => ++calls === 1
    ? { kind: 'tool_calls', text: '', usage: emptyUsage(), toolCalls: [{ name: 'manage_memory', callId: 'manual',
      arguments: { action: 'remember', scope: 'user', content: 'My timezone is UTC.' } }] } : final() } }, tools.definitions);
  await f.run('direct', 'Remember my timezone is UTC.');
  assert.equal(provider.list().length, 1);
  assert.throws(() => capture(f.options('direct')), { code: 'studio_native_memory_extraction_direct_write_unconfirmed' });
  const directWriteReceipt = ({ operationKey, call, definition }) => provider.reconcile({ operationKey,
    requestDigest: nativeMemoryRequestDigest({ call, definition, lockedDigest }) }).receipt;
  const snapshot = capture({ ...f.options('direct'), directWriteReceipt });
  assert.equal(snapshot.messages.filter(message => message.directMemoryWrite).length, 1);
  assert.throws(() => capture({ ...f.options('direct'), directWriteReceipt: () => ({ committed: true }) }),
    { code: 'studio_native_memory_extraction_direct_write_unconfirmed' });
  f.reopen();
  assert.deepEqual(capture({ ...f.options('direct'), directWriteReceipt }), snapshot);
});
