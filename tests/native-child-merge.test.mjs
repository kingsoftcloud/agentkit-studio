import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { NativeKernel, configure, emptyUsage } from '../packages/agentkit-harness-core/dist/index.mjs';
import { scope, fixture, digest } from '../packages/agentkit-harness-core/test/fixtures.mjs';
import { SqliteRunStore } from '../packages/agentkit-harness/src/native/sqlite-store.mjs';
import { createNativeChildOwner } from '../packages/agentkit-harness/src/native/child-owner.mjs';
import { nativeChildToolDefinitions } from '../packages/agentkit-harness/src/native/child-tools.mjs';
import { createNativeWorkspaceTools } from '../packages/agentkit-harness/src/native/workspace-tools.mjs';
import { createStudioNativeChildWorkspaces } from '../src/providers/native-child-workspace-host.mjs';
import { createStudioNativeChildMerge } from '../src/providers/native-child-merge.mjs';
import { createNativeToolAuthority } from '../src/providers/native-tool-authority.mjs';

const role = { name: 'writer', tools: ['write_workspace_file', 'write_workspace_files'], concurrentSafe: false };
const childScope = { ...scope, agentId: `${scope.agentId}:child:writer` };
const modelResult = (text, toolCalls = []) => ({ kind: toolCalls.length ? 'tool_calls' : 'final_candidate',
  text, toolCalls, usage: emptyUsage() });
async function setup(t, { authorize = async () => 'allow', previousPublication = () => null,
  beforeMerge, afterMerge, unknownChild = false, twoFiles = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'native-child-merge-')), workspaceRoot = join(root, 'workspace'); mkdirSync(workspaceRoot);
  writeFileSync(join(workspaceRoot, 'parent.txt'), 'parent');
  const store = new SqliteRunStore(join(root, 'runs.sqlite'));
  const fileWorkspaces = createStudioNativeChildWorkspaces({ workspaceRoot, stateDir: join(root, 'state') });
  const merge = createStudioNativeChildMerge({ scope, sessionId: 'session', store, roles: [role], fileWorkspaces,
    previousPublication, authorize });
  let childId, childWorkspace, mergeRequest, mergeResult, models = 0;
  const owner = createNativeChildOwner({ scope, childScopes: [childScope], store, resolveChild: async request => {
    childId = request.childRunId;
    const bound = fileWorkspaces.bind({ scope: childScope, sessionId: request.childSessionId, role }); childWorkspace = bound;
    const tools = createNativeWorkspaceTools({ workspaceRoot: bound.root, stateDir: join(root, 'child-state'),
      sessionId: request.childSessionId, authorize: async () => 'allow' });
    const write = tools.definitions.find(definition => definition.name === (twoFiles ? 'write_workspace_files' : 'write_workspace_file'));
    const authority = createNativeToolAuthority({ scope: childScope, sessionId: request.childSessionId, store });
    return { scope: childScope, configuration: configure({ profile: fixture().config.profile,
      contract: { objective: request.task }, tools: [write], hostBindingDigest: digest(bound.binding),
      hostRecoveryBinding: { childWorkspace: bound.binding }, limits: { maxModelCalls: 3, maxToolCalls: 2 } }),
    ports: { workspace: bound.observer,
      model: { generate: async () => ++models === 1 ? modelResult('', [{ callId: 'write', name: write.name,
        arguments: twoFiles ? { files: [{ path: 'child.txt', content: 'child bytes' }, { path: 'second.txt', content: 'second bytes' }] }
          : { path: 'child.txt', content: 'child bytes' } }]) : modelResult('child delivery') },
      tools: { execute: async request => {
        const result = await tools.execute(request, { assertCurrent: authority });
        if (unknownChild) throw Error('child reply lost after writing'); return result;
      } } } };
  } });
  t.after(async () => { await owner.releaseRun({ scope, runId: 'run' }); store.close(); rmSync(root, { recursive: true, force: true }); });
  let rounds = 0;
  const configuration = fixture({ tools: [...nativeChildToolDefinitions(['writer']), merge.definition],
    childLifecyclePolicy: 'owned-background/v2', limits: { maxModelCalls: 8, maxToolCalls: 8, effectTimeoutMs: 130000 } }).config;
  const kernel = new NativeKernel({ store, digest, owner: 'parent-merge', ports: { children: owner,
    model: { generate: async () => {
      rounds++;
      if (rounds === 1) return modelResult('', [{ callId: 'delegate', name: 'native_delegate',
        arguments: { role: 'writer', task: 'Write isolated evidence' } }]);
      if (rounds === 2) return modelResult('', [{ callId: 'merge', name: merge.definition.name, arguments: { child_run_id: childId } }]);
      return modelResult('parent done');
    } }, tools: { execute: async request => {
      if (request.call.name === 'native_delegate') return owner.start(request);
      mergeRequest = request; await beforeMerge?.({ request, childId, childWorkspace, store, fileWorkspaces, workspaceRoot });
      mergeResult = await merge.execute(request); await afterMerge?.({ result: mergeResult, store }); return mergeResult;
    } } } });
  kernel.start({ scope, runId: 'run', sessionId: 'session', turnId: 'turn', buildId: 'build', parentRunId: null, taskChainId: 'chain' }, configuration);
  return { root, workspaceRoot, store, fileWorkspaces, merge, kernel, run: () => kernel.runUntilIdle(scope, 'run'),
    get childId() { return childId; }, get request() { return mergeRequest; }, get result() { return mergeResult; } };
}

test('real Native child accounting and committed merge publish only the delivered isolated files', async t => {
  const f = await setup(t, { beforeMerge: ({ workspaceRoot }) => assert.equal(existsSync(join(workspaceRoot, 'child.txt')), false) });
  const final = await f.run(); assert.equal(final.phase, 'completed'); assert.equal(f.result.status, 'ok');
  assert.equal(readFileSync(join(f.workspaceRoot, 'child.txt'), 'utf8'), 'child bytes');
  assert.equal(readFileSync(join(f.workspaceRoot, 'parent.txt'), 'utf8'), 'parent');
  assert.deepEqual(f.result.workspaceChangedPaths, ['child.txt']);
  const receipt = f.store.load(scope, 'run').receipts.flatMap(receipt => receipt.result.results ?? [])
    .find(result => result.content?.schema_version === 'native.child-file-merge/v2');
  assert.equal(receipt.status, 'ok'); assert.equal(receipt.content.child_run_id, f.childId);
  assert.equal(receipt.content.child_revision, f.store.load(childScope, f.childId).snapshot.workspaceRevision);
});

test('a parent conflict publishes nothing and preserves its actual bytes', async t => {
  const f = await setup(t, { beforeMerge: ({ workspaceRoot }) => writeFileSync(join(workspaceRoot, 'child.txt'), 'parent conflict') });
  await f.run(); assert.equal(f.result.status, 'error'); assert.equal(f.result.content.error_code, 'child_workspace_merge_conflict');
  assert.deepEqual(f.result.workspaceChangedPaths, []); assert.equal(readFileSync(join(f.workspaceRoot, 'child.txt'), 'utf8'), 'parent conflict');
});

test('an uncertain child write cannot authorize a merge', async t => {
  const f = await setup(t, { unknownChild: true }); const final = await f.run();
  assert.equal(f.result, undefined, 'the original parent stops before offering another effect');
  assert.equal(final.outcome, 'unverified');
  let rounds = 0, result;
  const kernel = new NativeKernel({ store: f.store, digest, owner: 'later-parent', ports: {
    model: { generate: async () => ++rounds === 1 ? modelResult('', [{ callId: 'later-merge', name: f.merge.definition.name,
      arguments: { child_run_id: f.childId } }]) : modelResult('parent done') },
    tools: { execute: async request => result = await f.merge.execute(request) } } });
  kernel.start({ scope, runId: 'later', sessionId: 'session', turnId: 'later', buildId: 'build', parentRunId: null,
    taskChainId: 'chain' }, fixture({ tools: [f.merge.definition], limits: { effectTimeoutMs: 130000 } }).config);
  await kernel.runUntilIdle(scope, 'later');
  assert.equal(result.status, 'error'); assert.equal(result.content.error_code, 'child_not_accounted');
  assert.equal(existsSync(join(f.workspaceRoot, 'child.txt')), false);
});

test('permission refusal cannot publish or consume a previous-publication grant', async t => {
  let reads = 0;
  const f = await setup(t, { authorize: async () => 'deny', previousPublication: () => { reads++; return null; } });
  await f.run(); assert.equal(f.result.status, 'error'); assert.equal(reads, 0);
  assert.equal(existsSync(join(f.workspaceRoot, 'child.txt')), false);
});

test('a signal replaced during permission approval cannot publish', async t => {
  let f;
  f = await setup(t, { authorize: async () => { f.request.signal = new AbortController().signal; return 'allow'; } });
  await f.run(); assert.equal(f.result.status, 'error'); assert.equal(f.result.content.error_code, 'child_merge_authority_lost');
  assert.equal(existsSync(join(f.workspaceRoot, 'child.txt')), false);
});

test('a forged completed child locator cannot access another workspace', async t => {
  const f = await setup(t, { beforeMerge: ({ request }) => { request.call.arguments.child_run_id = 'forged-child'; } });
  await f.run(); assert.equal(f.result.status, 'error'); assert.equal(f.result.content.error_code, 'child_merge_authority_lost');
  assert.equal(existsSync(join(f.workspaceRoot, 'child.txt')), false);
});

test('authority loss after a real publication preserves an uncertain operation and applied prefix', async t => {
  const f = await setup(t, { twoFiles: true, beforeMerge: ({ fileWorkspaces, workspaceRoot }) => {
    const original = fileWorkspaces.files.merge.bind(fileWorkspaces.files);
    fileWorkspaces.files.merge = (workspace, options) => original(workspace, { ...options,
      assertCurrent: () => !existsSync(join(workspaceRoot, 'child.txt')) && options.assertCurrent() });
  } });
  const final = await f.run(); assert.equal(final.outcome, 'unverified'); assert.equal(f.result.status, 'uncertain');
  assert.deepEqual(f.result.workspaceChangedPaths, ['child.txt']); assert.deepEqual(f.result.content.applied, ['child.txt']);
  assert.equal(f.result.content.runId, 'run'); assert.equal(f.result.content.child_run_id, f.childId);
  assert.equal(f.result.content.operationKey, f.request.operationKey);
  assert.equal(readFileSync(join(f.workspaceRoot, 'child.txt'), 'utf8'), 'child bytes');
  assert.equal(existsSync(join(f.workspaceRoot, 'second.txt')), false);
  assert.equal(f.store.load(scope, 'run').receipts.filter(receipt => receipt.result.results
    ?.some(result => result.status === 'uncertain' && result.content?.schema_version === 'native.child-file-merge/v2')).length, 1);
});

test('a real process exit after publication reopens as unknown and never republishes automatically', async t => {
  const root = mkdtempSync(join(tmpdir(), 'native-child-merge-crash-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const worker = spawnSync(process.execPath, [fileURLToPath(new URL('./fixtures/native-child-merge-crash.mjs', import.meta.url)), root],
    { encoding: 'utf8', timeout: 15000 });
  assert.equal(worker.status, 87, worker.stderr);
  assert.equal(readFileSync(join(root, 'workspace', 'child.txt'), 'utf8'), 'published once before crash');
  const store = new SqliteRunStore(join(root, 'runs.sqlite')); t.after(() => store.close());
  const original = store.load(scope, 'run'), pending = original.snapshot.pendingIntent;
  assert.equal(original.intents.find(intent => intent.operationKey === pending).payload.calls[0].name, 'native_child_merge');
  assert.equal(original.receipts.some(receipt => receipt.operationKey === pending), false);
  if (original.lease?.expiresAt > Date.now()) await new Promise(resolve => setTimeout(resolve, original.lease.expiresAt - Date.now() + 10));
  let dispatches = 0;
  const replacement = new NativeKernel({ store, digest, owner: 'replacement', ports: {
    model: { generate: async () => modelResult('inspect the unknown publication') },
    tools: { execute: async () => { dispatches++; throw Error('must not repeat an unknown merge'); } } } });
  const result = await replacement.runUntilIdle(scope, 'run');
  assert.equal(result.phase, 'interrupted'); assert.equal(result.reason, 'effect_outcome_unknown'); assert.equal(dispatches, 0);
  assert.equal(store.load(scope, 'run').receipts.find(receipt => receipt.operationKey === pending).status, 'uncertain');
  assert.equal(readFileSync(join(root, 'publications.log'), 'utf8').trim().split('\n').length, 1);
});
