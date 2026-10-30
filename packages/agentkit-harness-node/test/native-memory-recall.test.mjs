import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { nativeMemoryQueryTerms, nativeMemoryKeywordCoverage, admitNativeMemoryRecords } from '../src/native/memory-recall.mjs';
import { SqliteNativeMemoryProvider } from '../src/native/memory-store.mjs';
import { nativeMemoryScopeBindings, nativeUserMemoryCandidate, memoryDigest } from '../src/native/memory-candidate.mjs';

const principal = { tenantId: 'tenant', workspaceId: 'workspace', agentId: 'agent', userId: 'user' };
function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'memory-recall-')), filename = join(root, 'memory.sqlite');
  const provider = new SqliteNativeMemoryProvider(filename, { principal });
  t.after(() => { provider.close(); rmSync(root, { recursive: true, force: true }); });
  let seq = 0;
  const add = content => {
    const sourceEventId = 'source-' + ++seq, candidate = nativeUserMemoryCandidate({ text: '记住：' + content,
      sourceEventId, ...nativeMemoryScopeBindings(principal)[0] });
    return provider.get(provider.applyCandidate({ candidate, sourceSessionId: 'session', sourceDigest: memoryDigest(content),
      operationKey: sourceEventId }).memoryId);
  };
  const change = (id, patch) => {
    const db = new DatabaseSync(filename);
    try { const value = JSON.parse(db.prepare('SELECT data FROM memory_records WHERE memory_id=?').get(id).data);
      db.prepare('UPDATE memory_records SET data=? WHERE memory_id=?').run(JSON.stringify({ ...value, ...patch }), id);
    } finally { db.close(); }
  };
  return { provider, add, change, filename };
}

test('reference lexical terms use bounded ASCII words and CJK bigrams; confidence is not relevance', () => {
  assert.deepEqual(nativeMemoryQueryTerms('Vim vim foo_bar 中文输入'), ['vim', 'foo_bar', '中文', '文输', '输入']);
  assert.equal(nativeMemoryKeywordCoverage('Vim editor 中文', 'Vim 中文'), .6667);
  assert.equal(nativeMemoryKeywordCoverage('Vim', 'I prefer Emacs'), 0);
  assert.equal(nativeMemoryKeywordCoverage('?', 'anything'), 0);
  assert.equal(nativeMemoryQueryTerms('word '.repeat(100)).length, 1);
  assert.ok(nativeMemoryQueryTerms(Array.from({ length: 80 }, (_, i) => 'term' + i).join(' ')).length === 16);
});

test('actual SQLite recall ranks relevant facts before unrelated importance, scopes every read and refreshes after correction/forget', t => {
  const { provider, add } = setup(t);
  for (let index = 0; index < 40; index++) add('Unrelated note ' + index);
  const original = add('My preferred editor is Vim');
  let result = provider.search({ query: 'preferred editor', topK: 1, minScore: 1 });
  assert.equal(result.status, 'ok'); assert.equal(result.retrievalStrategy, 'keyword');
  assert.deepEqual(result.records.map(record => record.memoryId), [original.memoryId]);
  provider.mutate({ action: 'correct', memoryId: original.memoryId, expectedVersion: 1, operationKey: 'correct',
    sourceEventId: 'correction', sourceSessionId: 'session', content: 'My preferred editor is Emacs' });
  assert.deepEqual(provider.search({ query: 'Vim', minScore: 1 }).records, []);
  result = provider.search({ query: 'Emacs', minScore: 1 });
  assert.equal(result.records[0].version, 2);
  provider.mutate({ action: 'forget', memoryId: original.memoryId, expectedVersion: 2, operationKey: 'forget',
    sourceEventId: 'forget', sourceSessionId: 'session' });
  assert.deepEqual(provider.search({ query: 'Emacs' }).records, []);
});

test('recall excludes inactive, expired, future and high-sensitivity data at both storage and Host admission', t => {
  const { provider, add, change } = setup(t), now = Date.parse('2030-01-01T00:00:00Z');
  const records = Array.from({ length: 7 }, (_, index) => add('Editor choice ' + index));
  change(records[0].memoryId, { status: 'deleted' });
  change(records[1].memoryId, { expiresAt: '2029-12-31T23:59:59Z' });
  change(records[2].memoryId, { validTo: '2030-01-01T00:00:00Z' });
  change(records[3].memoryId, { validFrom: '2030-01-01T00:00:01' });
  change(records[4].memoryId, { sensitivity: 'high' });
  change(records[5].memoryId, { expiresAt: '2030-01-01T01:00:01+01:00' });
  assert.deepEqual(new Set(provider.search({ query: 'editor', topK: 8, minScore: 1, now }).records.map(record => record.memoryId)),
    new Set([records[5].memoryId, records[6].memoryId]));
  assert.deepEqual(admitNativeMemoryRecords([{ ...records[0], status: 'expired' }], { principal, scopes: ['user'], now }), []);
  assert.throws(() => admitNativeMemoryRecords([{ ...records[0], validFrom: '2030-02-30T00:00:00Z' }],
    { principal, scopes: ['user'], now }), /timestamp_invalid/);
});

test('corrupt scope or content never becomes recalled data and provider failures disclose no database details', t => {
  const { provider, add, change, filename } = setup(t), original = add('Vim editor');
  for (const patch of [{ contentHash: memoryDigest('different') }, { tenantId: 'other-tenant' }]) {
    change(original.memoryId, { ...original, ...patch });
    assert.deepEqual(provider.search({ query: 'Vim' }), { status: 'failed', records: [], errorCode: 'provider_error',
      provider: 'local-default', retrievalStrategy: 'keyword' });
  }
  change(original.memoryId, original);
  for (const key of Object.keys(principal)) {
    const other = new SqliteNativeMemoryProvider(filename, { principal: { ...principal, [key]: 'foreign' } });
    try { assert.deepEqual(other.search({ query: 'Vim', minScore: 0 }).records, []); } finally { other.close(); }
  }
  assert.throws(() => provider.search({ query: 'Vim', topK: 65 }), /search_invalid/);
  assert.throws(() => provider.search({ query: '\ud800' }), /query_invalid/);
});

test('CJK natural questions use coverage threshold and duplicate content keeps the newest active version', t => {
  const { provider, add } = setup(t), fact = add('我的编辑器偏好是Vim');
  assert.equal(provider.search({ query: '编辑器偏好', minScore: 1 }).records[0].memoryId, fact.memoryId);
  assert.deepEqual(provider.search({ query: '编辑器偏好语言', minScore: 1 }).records, []);
  assert.equal(provider.search({ query: '编辑器偏好语言', minScore: .45 }).records.length, 1);
  const newer = { ...fact, memoryId: 'newer-version', version: 2 };
  assert.deepEqual(admitNativeMemoryRecords([fact, newer], { principal, scopes: ['user'] }), [newer]);
});
