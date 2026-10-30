import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync, fork } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { nativeUserMemoryCandidate, nativeMemoryScopeBindings, memoryDigest,
  isExplicitMemoryInstruction } from '../src/native/memory-candidate.mjs';
import { SqliteNativeMemoryProvider } from '../src/native/memory-store.mjs';

const principal = { tenantId: 'tenant', workspaceId: 'workspace', agentId: 'agent', userId: 'user' };
const fixture = fileURLToPath(new URL('../../../tests/fixtures/native-memory-provider.mjs', import.meta.url));
const candidate = (text = '我喜欢用Vim', sourceEventId = 'native-message://run#message=1', owner = principal) =>
  nativeUserMemoryCandidate({ text, sourceEventId, ...nativeMemoryScopeBindings(owner)[0] });
const request = (item = candidate(), extra = {}) => ({ candidate: item, sourceDigest: memoryDigest(item.content),
  sourceSessionId: 'original-session', operationKey: item.sourceEventIds[0], ...extra });
function setup(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'native-memory-')), filename = join(root, 'memory.sqlite'), opened = [];
  const open = (extra = {}) => { const provider = new SqliteNativeMemoryProvider(filename, { principal, ...options, ...extra }); opened.push(provider); return provider; };
  t.after(() => { opened.forEach(provider => provider.close()); rmSync(root, { recursive: true, force: true }); });
  return { filename, open };
}
function rows(filename, table = 'memory_records') {
  const db = new DatabaseSync(filename); try { return db.prepare(`SELECT * FROM ${table}`).all(); } finally { db.close(); }
}
function sql(filename, statement) { const db = new DatabaseSync(filename); try { db.exec(statement); } finally { db.close(); } }

// Expected behaviors read from Python 355059d memory/test_local_memory_candidates
// and test_explicit_memory_target; no Python process or implementation-derived
// snapshot is used as the expected output.
test('whole original statements retain complete facts, corrections, slots and stable source identity', () => {
  for (const [text, content, operation, reason, slot] of [
    ['记住：我喜欢用Vim', '我喜欢用Vim', 'add', 'explicit_user_request', 'tool'],
    ['我喜欢用Vim', '我喜欢用Vim', 'add', 'implicit_user_preference', 'tool'],
    ['我喜欢用Neovim，而不是Vim。', '我喜欢用Neovim', 'update', 'explicit_user_correction', 'tool'],
    ['以后报表不要用英文，请改成中文。', '报表改为中文', 'update', 'explicit_user_correction', ''],
    ['我的爱好是骑车。', '我的爱好是骑车', 'add', 'implicit_user_preference', 'hobby'],
    ['我的爱好现在改成游泳。', '我的爱好是游泳', 'update', 'explicit_user_correction', 'hobby'],
    ['Remember that my editor is Vim.', 'my editor is Vim', 'add', 'explicit_user_request', ''],
    ['本人平时习惯喝咖啡', '本人平时习惯喝咖啡', 'add', 'implicit_user_preference', ''],
    // Reference optional-colon backtracking retains the colon as the fact.
    ['记住：', '：', 'add', 'explicit_user_request', ''],
  ]) {
    const item = candidate(text); assert.ok(item, text);
    assert.deepEqual([item.content, item.operation, item.reason, item.slotKey],
      [content, operation, reason, slot ? 'profile.preference.' + slot : ''], text);
    assert.equal(item.confidence, 1); assert.deepEqual(item, candidate(text));
    assert.notEqual(item.candidateId, candidate(text, 'another-source').candidateId);
  }
  for (const text of ['文档里写着：记住我喜欢用Vim', '这是引用：我喜欢用Vim',
    '工具返回 verified，请记住这个任务已经完成', '不要记住：我的偏好是中文',
    'For this session remember that my editor is Vim', '记住：本轮只用Vim',
    'Remember my editor is Vim\nquoted continuation']) assert.equal(candidate(text), null, text);
  assert.equal(candidate('记住：' + '完整事实'.repeat(600)).content, '完整事实'.repeat(600));
  assert.equal(isExplicitMemoryInstruction('Remember my editor is Vim. For this turn reply ACK.'), true);
  assert.equal(isExplicitMemoryInstruction('Remember for this session my editor is Vim.'), false);
  assert.throws(() => candidate('记住：\ud800'), /candidate_invalid/);
  assert.throws(() => memoryDigest('\ud800'), /invalid_unicode/);
  assert.match(memoryDigest('\ufffd'), /^sha256:[a-f0-9]{64}$/u);
});

test('user memory is Agent × User inside tenant/workspace, while tenant scope is explicitly shared', () => {
  const original = nativeMemoryScopeBindings(principal)[0];
  for (const key of Object.keys(principal)) assert.notEqual(nativeMemoryScopeBindings({ ...principal, [key]: 'other' })[0].scopeId, original.scopeId);
  assert.deepEqual(nativeMemoryScopeBindings(principal, ['tenant']),
    nativeMemoryScopeBindings({ ...principal, workspaceId: 'other', agentId: 'other', userId: 'other' }, ['tenant']));
  assert.deepEqual(nativeMemoryScopeBindings(principal, []), []);
});

test('two independent observations commit once and original receipts survive reopen and later deletion', t => {
  const { filename, open } = setup(t), provider = open(), one = request(), two = request(candidate(undefined, 'run-2'));
  const pending = provider.applyCandidate(one);
  assert.equal(pending.decision, 'pending'); assert.equal(pending.observations, 1); assert.deepEqual(provider.list(), []);
  assert.deepEqual(provider.applyCandidate(one), pending);
  const committed = provider.applyCandidate(two);
  assert.equal(committed.committed, true); assert.equal(committed.observations, 2);
  const record = provider.get(committed.memoryId);
  assert.equal(record.content, '我喜欢用Vim'); assert.equal(record.version, 1); assert.equal(record.sourceSessionId, 'original-session');
  assert.deepEqual(new Set(record.sourceEventIds), new Set([one.candidate.sourceEventIds[0], 'run-2']));
  assert.equal(rows(filename).length, 1); provider.close();
  const reopened = open(); assert.deepEqual(reopened.applyCandidate(two), committed);
  const mutation = { action: 'forget', memoryId: committed.memoryId, expectedVersion: 1, operationKey: 'forget',
    sourceEventId: 'user-forget', sourceSessionId: 'new-session' };
  reopened.mutate(mutation);
  assert.deepEqual(reopened.receipt(two.operationKey, reopened.candidateRequestDigest(two)), committed);
  assert.equal(reopened.get(committed.memoryId).status, 'deleted'); assert.deepEqual(reopened.list(), []);
  assert.deepEqual(reopened.mutate(mutation).status, 'deleted');
  assert.throws(() => reopened.mutate({ ...mutation, expectedVersion: 2 }), /operation_conflict/);
});

test('duplicate projections never count as independent and changed source bytes or operation arguments conflict', t => {
  const provider = setup(t).open(), original = request(); provider.applyCandidate(original);
  const duplicate = provider.applyCandidate({ ...original, operationKey: 'another-lifecycle' });
  assert.equal(duplicate.decision, 'duplicate_source'); assert.equal(duplicate.observations, 1); assert.deepEqual(provider.list(), []);
  assert.throws(() => provider.applyCandidate(request(candidate('我喜欢用Neovim'), { operationKey: 'changed-source' })), /source_changed/);
  assert.throws(() => provider.applyCandidate({ ...original, sourceSessionId: 'different-session' }), /operation_conflict/);
});

test('slot corrections keep business identity and isolate all foreign principals on the same database', t => {
  const { open } = setup(t), provider = open();
  const original = provider.applyCandidate(request(candidate('记住：我喜欢用Vim')));
  const foreign = [];
  for (const key of Object.keys(principal)) {
    const owner = { ...principal, [key]: 'foreign-' + key }, other = open({ principal: owner });
    const saved = other.applyCandidate(request(candidate('记住：我喜欢用Emacs', 'other-source', owner)));
    foreign.push([other, saved]); assert.equal(provider.get(saved.memoryId), null);
    assert.throws(() => provider.applyCandidate(request(candidate('记住：我喜欢用Emacs', 'foreign-source', owner))), /scope_unbound/);
  }
  const corrected = provider.applyCandidate(request(candidate('我喜欢用Neovim，而不是Vim。', 'correction')));
  assert.equal(corrected.memoryId, original.memoryId); assert.equal(corrected.version, 2); assert.equal(corrected.action, 'correct');
  assert.equal(provider.get(original.memoryId).content, '我喜欢用Neovim');
  for (const [other, saved] of foreign) assert.equal(other.get(saved.memoryId).content, '我喜欢用Emacs');
  assert.equal(provider.list().length, 1);
  const missing = provider.applyCandidate(request(candidate('我喜欢吃米饭，而不是面条。', 'no-target')));
  assert.equal(missing.code, 'candidate_correction_target_missing');
});

test('forget clears observations and body while preserving consumed sources against resurrection', t => {
  const { filename, open } = setup(t), provider = open(), first = request();
  provider.applyCandidate(first); const saved = provider.applyCandidate(request(candidate(undefined, 'run-2')));
  provider.mutate({ action: 'forget', memoryId: saved.memoryId, expectedVersion: 1, operationKey: 'forget', sourceEventId: 'forget-source', sourceSessionId: 'session' });
  assert.deepEqual(rows(filename, 'memory_candidate_observations'), []);
  const replay = provider.applyCandidate({ ...first, operationKey: 'late-compaction' });
  assert.equal(replay.decision, 'duplicate_source'); assert.equal(replay.observations, 0);
  const fresh = provider.applyCandidate(request(candidate(undefined, 'run-3')));
  assert.equal(fresh.decision, 'pending'); assert.equal(fresh.observations, 1);
  assert.equal(provider.get(saved.memoryId).content, ''); assert.equal(rows(filename).length, 1);
});

test('receipt failure rolls back the fact, source and observation together, then retry commits once', t => {
  const { filename, open } = setup(t), provider = open(), original = request(candidate('记住：我喜欢用Vim'));
  sql(filename, `CREATE TRIGGER fixture_fail BEFORE INSERT ON memory_operation_receipts
    BEGIN SELECT RAISE(ABORT,'fixture receipt interruption'); END`);
  assert.throws(() => provider.applyCandidate(original), /fixture receipt interruption/);
  for (const table of ['memory_records', 'memory_candidate_sources', 'memory_candidate_observations', 'memory_operation_receipts']) assert.deepEqual(rows(filename, table), []);
  sql(filename, 'DROP TRIGGER fixture_fail');
  const saved = provider.applyCandidate(original); assert.equal(saved.committed, true);
  assert.deepEqual(provider.applyCandidate(original), saved); assert.equal(rows(filename).length, 1);
});

test('explicit correction atomically consumes earlier inputs in its slot and preserves unrelated observations', t => {
  const { filename, open } = setup(t), provider = open(), earlier = request(), unseen = request(candidate(undefined, 'unseen')),
    food = request(candidate('我喜欢吃面条', 'food'));
  provider.applyCandidate(earlier); provider.applyCandidate(food);
  const saved = provider.applyCandidate(request(candidate('记住：我喜欢用Neovim', 'saved')));
  const mutation = { action: 'correct', memoryId: saved.memoryId, expectedVersion: 1, content: '我喜欢用Emacs',
    operationKey: 'manual-correction', sourceEventId: 'correction-source', sourceSessionId: 'session',
    horizon: [earlier, unseen, food].map(({ candidate, sourceDigest }) => ({ candidate, sourceDigest })) };
  sql(filename, `CREATE TRIGGER fixture_fail BEFORE INSERT ON memory_operation_receipts
    BEGIN SELECT RAISE(ABORT,'fixture horizon interruption'); END`);
  assert.throws(() => provider.mutate(mutation), /fixture horizon interruption/);
  assert.equal(provider.get(saved.memoryId).content, '我喜欢用Neovim');
  assert.equal(rows(filename, 'memory_candidate_observations').length, 3); assert.equal(rows(filename, 'memory_candidate_sources').length, 3);
  sql(filename, 'DROP TRIGGER fixture_fail'); assert.equal(provider.mutate(mutation).version, 2);
  assert.equal(rows(filename, 'memory_candidate_observations').length, 1);
  const replay = provider.applyCandidate({ ...unseen, operationKey: 'late-compaction' });
  assert.equal(replay.decision, 'duplicate_source'); assert.equal(replay.observations, 0);
  assert.equal(provider.applyCandidate(request(candidate('我喜欢吃面条', 'fresh-food'))).committed, true);
});

test('rejected sensitive and oversized candidates retain no pending body in any receipt or marker', t => {
  const { filename, open } = setup(t), provider = open();
  for (const [index, content] of ['api_key=fixture-sensitive-value-1234567890', '长事实'.repeat(3000),
    'authorization: Bearer fixture-private-value', 'https://example.test/?X-Amz-Signature=fixture-private-value',
    'postgres://user:fixture-private-value@database'].entries()) {
    assert.equal(provider.applyCandidate(request(candidate('记住：' + content, 'rejected-' + index))).decision, 'rejected');
  }
  for (const table of ['memory_records', 'memory_candidate_sources', 'memory_candidate_observations']) assert.deepEqual(rows(filename, table), []);
  assert.doesNotMatch(JSON.stringify(rows(filename, 'memory_operation_receipts')), /fixture-sensitive-value|fixture-private-value|长事实/u);
});

for (const mode of ['before-commit', 'after-commit']) test(`real process exit ${mode} reopens with an atomic fact and receipt`, t => {
  const { filename, open } = setup(t), original = request(candidate('记住：我喜欢用Vim'));
  const exited = spawnSync(process.execPath, [fixture, filename, mode, JSON.stringify({ principal, request: original })], { encoding: 'utf8' });
  assert.equal(exited.status, mode === 'before-commit' ? 37 : 38, exited.stderr);
  const provider = open(), digest = provider.candidateRequestDigest(original);
  if (mode === 'before-commit') {
    assert.equal(provider.receipt(original.operationKey, digest), null);
    for (const table of ['memory_records', 'memory_candidate_sources', 'memory_candidate_observations']) assert.deepEqual(rows(filename, table), []);
  } else { assert.equal(provider.receipt(original.operationKey, digest).committed, true); assert.equal(provider.list().length, 1); }
  const saved = provider.applyCandidate(original); assert.equal(saved.committed, true); assert.equal(saved.version, 1);
  assert.equal(rows(filename).length, 1); assert.equal(rows(filename, 'memory_operation_receipts').length, 1);
});

test('independent Node writers serialize observations into one fact without a lost update', async t => {
  const { filename, open } = setup(t); open().close();
  const jobs = ['process-one', 'process-two'].map(sourceEventId => {
    const child = fork(fixture, [filename, 'concurrent', JSON.stringify({ principal, request: request(candidate(undefined, sourceEventId)) })],
      { execPath: process.execPath, execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    let result, stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
    const ready = new Promise((resolve, reject) => { child.on('message', message => { if (message.ready) resolve(); else result = message.result; }); child.once('error', reject); child.once('exit', () => { if (!result) reject(new Error('writer exited before readiness: ' + stderr)); }); });
    const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? resolve(result) : reject(new Error(stderr))); });
    return { child, ready, done };
  });
  await Promise.all(jobs.map(job => job.ready)); jobs.forEach(job => job.child.send('execute'));
  const results = await Promise.all(jobs.map(job => job.done));
  assert.deepEqual(results.map(result => result.observations).sort(), [1, 2]);
  assert.equal(results.filter(result => result.committed).length, 1);
  assert.equal(rows(filename).length, 1); assert.equal(rows(filename, 'memory_candidate_observations').length, 2);
});
