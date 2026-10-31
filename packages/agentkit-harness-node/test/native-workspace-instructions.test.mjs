import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeWorkspaceInstructions } from '../src/native/workspace-instructions.mjs';
import { nativeWorkspaceContextBinding } from '../src/native/workspace-context.mjs';
import { collectContextContributions, canonical, projectWorkspaceTouchEvidence, NativeKernel, emptyUsage } from '@kingsoftcloud/agentkit-harness-core';
import { SqliteRunStore } from '../src/native/sqlite-store.mjs';
import { fixture, scope, digest } from '../../agentkit-harness-core/test/fixtures.mjs';
const contextPolicy = { tokenizerId: 'fixture', tokenizerDigest: 'fixture/v1', enabled: false, triggerRatio: .9, targetRatio: .5,
  summaryMaxTokens: 100, maxCompactions: 1, maxCompactionsWithoutProgress: 1, minModelTurnsBetween: 1, maxSummaryRetries: 1 };

async function setup(t) {
  const parent = await mkdtemp(join(await realpath(tmpdir()), 'native-current-instructions-'));
  const root = join(parent, 'workspace'), global = join(parent, 'global');
  await mkdir(root); await mkdir(global); await mkdir(join(root, 'src'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const binding = nativeWorkspaceContextBinding(root, { instructionRoots: [global] });
  const source = createNativeWorkspaceInstructions(binding), signal = new AbortController().signal;
  const read = state => source.readSource({ source: source.source, snapshot: { context: { instructionScopes: state } }, signal });
  return { parent, root, global, binding, source, signal, read };
}

test('root, global and discovered scoped rules are fresh after replacement/deletion and reader reconstruction', async t => {
  const f = await setup(t);
  await writeFile(join(f.root, 'AGENTS.md'), 'ROOT_RULE');
  await writeFile(join(f.root, 'CLAUDE.md'), 'ROOT_RULE'); // same-scope dedup
  await writeFile(join(f.global, 'AGENTS.md'), 'GLOBAL_RULE');
  await writeFile(join(f.root, 'src', 'AGENTS.md'), 'NESTED_RULE');
  const first = await f.read();
  assert.deepEqual(first.items[0].files.map(file => file.content), ['GLOBAL_RULE', 'ROOT_RULE']);
  const state = await f.source.scopes(undefined, [join(f.root, 'src', 'file.ts')], f.signal);
  assert.deepEqual(state.directories, ['', 'src']);
  assert.deepEqual((await f.read(state)).items[0].files.map(file => file.content), ['GLOBAL_RULE', 'ROOT_RULE', 'NESTED_RULE']);
  await writeFile(join(f.root, 'src', 'AGENTS.md'), 'UPDATED_NESTED_RULE');
  await rm(join(f.root, 'AGENTS.md')); await rm(join(f.root, 'CLAUDE.md'));
  const restored = createNativeWorkspaceInstructions(structuredClone(f.binding));
  const latest = await restored.readSource({ source: restored.source, snapshot: { context: { instructionScopes: state } }, signal: f.signal });
  assert.deepEqual(latest.items[0].files.map(file => file.content), ['GLOBAL_RULE', 'UPDATED_NESTED_RULE']);
  await rm(join(f.root, 'src', 'AGENTS.md')); await rm(join(f.global, 'AGENTS.md'));
  assert.deepEqual((await f.read(state)).items[0].files, []);
});

test('escaping instruction links and oversized files fail explicitly; cancellation never becomes absence', async t => {
  const f = await setup(t), outside = join(f.parent, 'outside.md');
  await writeFile(outside, 'OUTSIDE_RULE'); await symlink(outside, join(f.root, 'AGENTS.md'));
  await assert.rejects(f.read(), /workspace_instruction_path_escape/);
  await rm(join(f.root, 'AGENTS.md')); await writeFile(join(f.root, 'AGENTS.md'), 'X'.repeat(65537));
  await assert.rejects(f.read(), /workspace_instruction_file_too_large/);
  const abort = new AbortController(); abort.abort(Error('owner canceled'));
  await assert.rejects(f.source.readSource({ source: f.source.source, snapshot: { context: {} }, signal: abort.signal }), /owner canceled/);
  await assert.rejects(f.source.scopes(undefined, [outside], f.signal), /workspace_instruction_path_escape/);
});

test('the Core source envelope carries the whole current snapshot, without writing file content into history', async t => {
  const f = await setup(t); await writeFile(join(f.root, 'AGENTS.md'), 'CURRENT_RULE');
  const snapshot = { context: {}, messages: [] }, config = { contextSources: [f.source.source], profile: { contextWindow: 10000, maxOutputTokens: 128 } };
  const result = await collectContextContributions({ signal: f.signal }, snapshot, config,
    { readSource: request => f.source.readSource(request) }, async messages => Math.ceil(canonical(messages).length / 4));
  assert.equal(JSON.parse(result.messages[0].content).purpose, 'workspace_instructions');
  assert.match(result.messages[0].content, /CURRENT_RULE/); assert.deepEqual(snapshot.messages, []);
});

test('SQLite compact workspace evidence preserves scopes across reopen and matches the memory projector', async t => {
  const f = await setup(t), filename = join(f.parent, 'runs.sqlite');
  const { config, snapshot } = fixture({ contextSources: [f.source.source], contextPolicy });
  snapshot.context.instructionScopes = await f.source.scopes(undefined, ['src/file.ts'], f.signal);
  let store = new SqliteRunStore(filename);
  store.create(config, snapshot);
  const expected = projectWorkspaceTouchEvidence(store.load(scope, 'run'));
  store.close(); store = new SqliteRunStore(filename);
  try { assert.deepEqual(store.workspaceTouchEvidence(scope, 'run'), expected); }
  finally { store.close(); }
});

for (const change of ['replace', 'delete']) test(`unclaimed model dispatch rereads actual scoped files after SQLite cold restart: ${change}`, async t => {
  const f = await setup(t), filename = join(f.parent, 'cold.sqlite'), path = join(f.root, 'src', 'AGENTS.md');
  await writeFile(path, 'BEFORE_OWNER_EXIT');
  const { config, snapshot } = fixture({ contextSources: [f.source.source], contextPolicy });
  snapshot.context.instructionScopes = await f.source.scopes(undefined, ['src/file.ts'], f.signal);
  let store = new SqliteRunStore(filename), reader = f.source, reads = 0, models = 0;
  store.create(config, snapshot);
  const ports = { context: { readSource: async request => { reads++; return reader.readSource(request); },
    tokens: { tokenizerId: 'fixture', tokenizerDigest: 'fixture/v1',
      countText: async ({ text }) => Math.ceil(text.length / 4),
      countRequest: async ({ messages }) => Math.ceil(canonical(messages).length / 4) } },
  model: { generate: async request => {
    models++; assert.doesNotMatch(canonical(request.messages), /BEFORE_OWNER_EXIT/);
    assert.equal(canonical(request.messages).includes('AFTER_OWNER_EXIT'), change === 'replace');
    return { kind: 'final_candidate', text: 'Delivered', toolCalls: [], usage: emptyUsage() };
  } } };
  try {
    await assert.rejects(new NativeKernel({ store, ports, digest, owner: 'first-owner', onCheckpoint: async state => {
      if (state.preparedContext) throw Error('owner exited before model');
    } }).runUntilIdle(scope, 'run'), /owner exited before model/);
    assert.equal(models, 0); store.close();
    if (change === 'replace') await writeFile(path, 'AFTER_OWNER_EXIT'); else await rm(path);
    reader = createNativeWorkspaceInstructions(structuredClone(f.binding)); store = new SqliteRunStore(filename);
    const done = await new NativeKernel({ store, ports, digest, owner: 'cold-owner' }).runUntilIdle(scope, 'run');
    assert.equal(done.phase, 'completed'); assert.equal(models, 1); assert.equal(reads, 2);
    assert.equal(store.events(scope, 'run').filter(event => event.kind === 'context.sources_invalidated').length, 1);
    assert.doesNotMatch(canonical(done.messages), /BEFORE_OWNER_EXIT|AFTER_OWNER_EXIT/);
  } finally { store.close(); }
});

test('actual file guidance remains current through Kernel summary calls that omit all rules', async t => {
  const f = await setup(t), path = join(f.root, 'src', 'AGENTS.md');
  await writeFile(join(f.root, 'AGENTS.md'), 'ROOT_MUST_SURVIVE_SUMMARY');
  await writeFile(path, 'NESTED_BEFORE_SUMMARY');
  const { config, snapshot } = fixture({ contextSources: [f.source.source],
    profile: { profileId: 'small', profileVersion: '1', providerFamily: 'fixture', compatibilityDigest: 'summary',
      contextWindow: 3000, maxOutputTokens: 256 }, contextPolicy: { ...contextPolicy, enabled: true,
      triggerRatio: .8, targetRatio: .5, summaryMaxTokens: 256, maxCompactions: 3, maxCompactionsWithoutProgress: 3,
      minModelTurnsBetween: 0, summaryFormatPolicy: 'task-continuity/v1', budgetTiming: 'before-model/v1', continuityPlacement: 'after-history/v1' } });
  snapshot.context.instructionScopes = await f.source.scopes(undefined, ['src/file.ts'], f.signal);
  for (let index = 0; index < 50; index++) snapshot.messages.push({ role: 'assistant',
    content: `Past observation ${index}: ` + 'unrelated code observation '.repeat(20) });
  snapshot.usage.modelCalls = 20;
  const store = new SqliteRunStore(join(f.parent, 'summary.sqlite')); let summaries = 0, tasks = 0;
  store.create(config, snapshot);
  try {
    const done = await new NativeKernel({ store, digest, owner: 'summary-owner', ports: {
      context: { readSource: request => f.source.readSource(request), tokens: { tokenizerId: 'fixture', tokenizerDigest: 'fixture/v1',
        countText: async ({ text }) => Math.ceil(text.length / 4),
        countRequest: async ({ messages, tools }) => Math.ceil(canonical({ messages, tools }).length / 4) } },
      model: { generate: async request => {
        if (request.purpose === 'compaction') {
          summaries++; await writeFile(path, 'NESTED_AFTER_SUMMARY');
          return { kind: 'final_candidate', toolCalls: [], usage: emptyUsage(), text: canonical({ objective: ['Complete task'],
            constraints: [], completed: ['History summarized'], pending: [], evidence: [], failures: [], artifacts: [], nextSteps: ['Continue'] }) };
        }
        tasks++; assert.match(canonical(request.messages), /ROOT_MUST_SURVIVE_SUMMARY/);
        assert.match(canonical(request.messages), /NESTED_AFTER_SUMMARY/);
        assert.doesNotMatch(canonical(request.messages), /NESTED_BEFORE_SUMMARY/);
        return { kind: 'final_candidate', text: 'Delivered.', toolCalls: [], usage: emptyUsage() };
      } },
    } }).runUntilIdle(scope, 'run');
    assert.equal(done.phase, 'completed', done.reason); assert.ok(summaries > 0); assert.equal(tasks, 1);
    assert.ok(done.contextState.compactions > 0);
    assert.doesNotMatch(canonical(done.messages), /ROOT_MUST_SURVIVE_SUMMARY|NESTED_AFTER_SUMMARY/);
  } finally { store.close(); }
});
