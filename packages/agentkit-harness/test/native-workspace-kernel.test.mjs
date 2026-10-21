import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { NativeKernel, configure, initialSnapshot, canonical, emptyUsage } from '../../agentkit-harness-core/dist/index.mjs';
import { createNativeWorkspaceTools } from '../src/native/workspace-tools.mjs';
import { sessionKeyFor } from '../src/native/workspace-state.mjs';
import { SqliteRunStore } from '../src/native/sqlite-store.mjs';

const scope = { tenantId: 'tenant', workspaceId: 'workspace', userId: 'user', agentId: 'agent' };
const identity = { scope, runId: 'run', sessionId: 'session', turnId: 'turn', buildId: 'build', parentRunId: null, taskChainId: 'chain' };
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');

test('real Native ledger repairs invalid Python through the Node parser and persists both diagnostics', async t => {
  const { base, workspaceRoot, configFor, create } = setup(t), filename = join(base, 'syntax.sqlite');
  writeFileSync(join(workspaceRoot, 'source.py'), 'def f(:\n    return 1\n');
  let tools = create(async () => 'allow'), store = new SqliteRunStore(filename); t.after(() => store.close());
  const config = configFor(tools), steps = [
    ['read_workspace_file', { path: 'source.py' }], ['lint_workspace_file', { path: 'source.py' }],
    ['edit_workspace_file', { path: 'source.py', old_text: 'def f(:', new_text: 'def f():' }],
    ['lint_workspace_file', { path: 'source.py' }],
  ];
  let calls = 0;
  const model = { generate: async () => {
    const step = steps[calls++];
    return step ? { kind: 'tool_calls', text: '', usage: emptyUsage(), toolCalls: [{ callId: `step-${calls}`, name: step[0], arguments: step[1] }] }
      : { kind: 'final_candidate', text: 'Repaired source.py', toolCalls: [], usage: emptyUsage() };
  } };
  let kernel = new NativeKernel({ store, owner: 'first', digest, ports: { model, tools, workspace: tools } });
  kernel.start(initialSnapshot(identity, config, digest(config)), config);
  assert.equal((await kernel.runUntilIdle(scope, 'run')).phase, 'completed');
  const diagnostics = store.load(scope, 'run').receipts.flatMap(item => item.result.results ?? [])
    .filter(item => item.content?.language === 'python');
  assert.deepEqual(diagnostics.map(item => item.status), ['error', 'ok']);
  assert.equal(diagnostics[0].content.issues[0].severity, 'error');
  assert.deepEqual(diagnostics[1].content.issues, []);
  assert.equal(readFileSync(join(workspaceRoot, 'source.py'), 'utf8'), 'def f():\n    return 1\n');
  store.close(); store = new SqliteRunStore(filename); tools = create(async () => 'allow');
  kernel = new NativeKernel({ store, owner: 'replacement', digest, ports: { model, tools, workspace: tools } });
  assert.equal((await kernel.runUntilIdle(scope, 'run')).phase, 'completed'); assert.equal(calls, 5);
});
function setup(t) {
  const base = mkdtempSync(join(tmpdir(), 'native-workspace-kernel-')), workspaceRoot = join(base, 'workspace'), stateDir = join(base, 'state');
  mkdirSync(workspaceRoot); writeFileSync(join(workspaceRoot, 'file.txt'), 'original\n');
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const configFor = tools => configure({ profile: { profileId: 'test', profileVersion: '1', providerFamily: 'fixture', compatibilityDigest: 'fixture/v1' },
    hostBindingDigest: 'fixture-host/v1', tools: tools.definitions, contract: { objective: 'Read and edit file.txt' } });
  const create = authorize => createNativeWorkspaceTools({ workspaceRoot, stateDir, sessionId: 'session', ...(authorize ? { authorize } : {}) });
  const generate = async request => {
    const receipts = request.messages.filter(message => message.role === 'tool');
    if (receipts.length < 2) return { kind: 'tool_calls', text: '', usage: emptyUsage(), toolCalls: [{
      callId: receipts.length ? 'edit' : 'read', name: receipts.length ? 'edit_workspace_file' : 'read_workspace_file',
      arguments: receipts.length ? { path: 'file.txt', old_text: 'original', new_text: 'updated' } : { path: 'file.txt' },
    }] };
    return { kind: 'final_candidate', text: 'Edited file.txt', toolCalls: [], usage: emptyUsage() };
  };
  return { base, workspaceRoot, stateDir, configFor, create, generate };
}

test('actual Native kernel and workspace port resume an approval after SQLite and port reopen', async t => {
  const { base, workspaceRoot, configFor, create, generate } = setup(t), filename = join(base, 'ledger.sqlite');
  let store = new SqliteRunStore(filename); t.after(() => store.close());
  let tools = create(); const config = configFor(tools);
  const first = new NativeKernel({ store, owner: 'first', digest, ports: { model: { generate }, tools, workspace: tools } });
  first.start(initialSnapshot(identity, config, digest(config)), config);
  const pending = await first.runUntilIdle(scope, 'run'); assert.equal(pending.phase, 'awaiting_interaction');
  assert.equal(readFileSync(join(workspaceRoot, 'file.txt'), 'utf8'), 'original\n'); store.close();
  store = new SqliteRunStore(filename); tools = create();
  const replacement = new NativeKernel({ store, owner: 'replacement', digest, ports: { model: { generate }, tools, workspace: tools } });
  replacement.submit(scope, 'run', { commandId: 'approve', kind: 'submit_interaction',
    payload: { interactionId: pending.pendingInteraction.interactionId, decision: 'allow' } });
  const result = await replacement.runUntilIdle(scope, 'run');
  assert.equal(result.phase, 'completed'); assert.equal(result.usage.toolCalls, 2);
  assert.equal(readFileSync(join(workspaceRoot, 'file.txt'), 'utf8'), 'updated\n');
  assert.deepEqual(result.workspaceModifiedPaths, ['file.txt']); assert.deepEqual(readdirSync(workspaceRoot), ['file.txt']);
});

test('a state-write failure after real publication interrupts instead of presenting a safely repeatable tool failure', async t => {
  const { base, workspaceRoot, stateDir, configFor, create, generate } = setup(t), filename = join(base, 'ledger.sqlite');
  let store = new SqliteRunStore(filename), writes = 0; t.after(() => store.close());
  const tools = create(async () => {
    writes++;
    const readStatePath = join(stateDir, sessionKeyFor('session'), 'read-state.json');
    rmSync(readStatePath); mkdirSync(readStatePath); // rename of the new state must fail after publication
    return 'allow';
  });
  const config = configFor(tools), kernel = new NativeKernel({ store, owner: 'first', digest, ports: { model: { generate }, tools, workspace: tools } });
  kernel.start(initialSnapshot(identity, config, digest(config)), config); const result = await kernel.runUntilIdle(scope, 'run');
  assert.equal(result.phase, 'interrupted'); assert.equal(result.reason, 'effect_outcome_unknown'); assert.equal(writes, 1);
  assert.equal(readFileSync(join(workspaceRoot, 'file.txt'), 'utf8'), 'updated\n');
  const receipt = store.load(scope, 'run').receipts.find(receipt => receipt.result.results?.[0]?.status === 'uncertain');
  assert.ok(receipt); assert.equal(receipt.result.results[0].content.executed, true); store.close();
  store = new SqliteRunStore(filename);
  const replacement = new NativeKernel({ store, owner: 'replacement', digest, ports: { model: { generate }, tools, workspace: tools } });
  assert.equal((await replacement.runUntilIdle(scope, 'run')).phase, 'interrupted'); assert.equal(writes, 1);
});
