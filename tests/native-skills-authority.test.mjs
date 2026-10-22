import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeSkillTools } from '../packages/agentkit-harness/src/native/skill-tools.mjs';
import { createStudioNativeSkills } from '../src/providers/native-dsh-skills.mjs';
import { createNativeToolAuthority } from '../src/providers/native-tool-authority.mjs';
import { NativeKernel, emptyUsage } from '../packages/agentkit-harness-core/dist/index.mjs';
import { SqliteRunStore } from '../packages/agentkit-harness/src/native/sqlite-store.mjs';
import { scope, fixture, digest } from '../packages/agentkit-harness-core/test/fixtures.mjs';

const agent = { session: { id: 'session' } };
const identity = { scope, runId: 'run', sessionId: 'session', turnId: 'turn', buildId: 'build',
  parentRunId: null, taskChainId: 'chain', operationKey: 'operation', executionFence: 1 };
function setup(options = {}) {
  const tools = createNativeSkillTools({ authorize: async () => 'allow', skillSpaceIds: ['space'], ...options });
  const request = (name = 'list_skills', args = {}) => ({ ...identity, signal: new AbortController().signal,
    definition: structuredClone(tools.definitions.find(d => d.name === name)), call: { callId: 'call', name, arguments: args } });
  const port = (assertCurrent = () => true) => tools.forAgent(agent, { scope, sessionId: 'session', assertCurrent }).tools;
  return { tools, request, port };
}

test('a formal definition and a synchronous live authority are mandatory', async () => {
  let calls = 0;
  const f = setup({ serviceClient: { listSkillsBySpaceId: async () => { calls++; return { activeSkills: [] }; } } });
  const request = f.request(); delete request.definition;
  assert.equal((await f.port().execute(request)).content.code, 'NATIVE_SKILL_DEFINITION_FORGED');
  assert.throws(() => f.tools.forAgent(agent, { scope, sessionId: 'session' }), /guard_required/);
  assert.throws(() => f.tools.forAgent(agent, { scope, sessionId: 'other', assertCurrent: () => true }), /session_mismatch/);
  assert.equal((await f.port(async () => { throw new Error('async guard rejected'); }).execute(f.request())).status, 'error');
  assert.equal(calls, 0);
});

test('signal replacement during permission approval cannot enter a service', async () => {
  let release, entered, calls = 0;
  const ready = new Promise(resolve => { entered = resolve; });
  const waiting = new Promise(resolve => { release = resolve; });
  const f = setup({ authorize: async () => { entered(); await waiting; return 'allow'; },
    serviceClient: { listSkillsBySpaceId: async () => { calls++; return { activeSkills: [] }; } } });
  const request = f.request(), running = f.port().execute(request);
  await ready; request.signal = new AbortController().signal; release();
  assert.equal((await running).content.code, 'NATIVE_SKILL_DRIFT');
  assert.equal(calls, 0);
});

test('authority revoked by the first service response blocks a second bound space', async () => {
  let live = true, calls = 0;
  const f = setup({ skillSpaceIds: ['first', 'second'], serviceClient: {
    listSkillsBySpaceId: async () => { calls++; live = false; return { activeSkills: [] }; },
  } });
  const result = await f.port(() => live).execute(f.request());
  assert.equal(result.status, 'error'); assert.equal(calls, 1);
});

test('an incomplete listing cannot authorize an exact load or report a complete discovery', async () => {
  let loads = 0;
  const f = setup({ serviceClient: { listSkillsBySpaceId: async () => ({ activeSkills: [{ name: 'alpha' }], truncated: true }) },
    loadSkillFn: async () => { loads++; } });
  const result = await f.port().execute(f.request('load_skill', { skill_name: 'alpha' }));
  assert.equal(result.status, 'error'); assert.equal(result.content.error_type, 'SKILL_LISTING_INCOMPLETE');
  assert.equal(loads, 0);
});

test('a loader cannot substitute another version under the selected skill name', async () => {
  const f = setup({ serviceClient: { listSkillsBySpaceId: async () => ({ activeSkills: [
    { name: 'alpha', skillId: 'skill', versionId: 'version-1', contentHash: 'hash-1' },
  ] }) }, loadSkillFn: async () => ({ content: 'Substituted instructions', skillId: 'skill', versionId: 'version-2',
    contentHash: 'hash-2', spaceId: 'space' }) });
  const result = await f.port().execute(f.request('load_skill', { skill_name: 'alpha' }));
  assert.equal(result.status, 'error'); assert.equal(result.content.error_type, 'SKILL_LOADER_IDENTITY_MISMATCH');
  assert.equal(result.content.instructions, undefined);
});

test('post-dispatch malformed results preserve uncertainty and original operation identity', async () => {
  for (const result of [null, undefined, 'bad', {}, { ok: true }, { uncertain: true, executed: false }]) {
    let calls = 0;
    const f = setup({ executeWorkflow: async () => { calls++; return result; } });
    const output = await f.port().execute(f.request('execute_skills', { workflow_prompt: 'run' }));
    assert.equal(output.status, 'uncertain'); assert.equal(output.content.operationKey, 'operation');
    assert.equal(output.content.executed, undefined); assert.equal(calls, 1);
  }
});

test('known workflow failure is executed while pre-dispatch denial is not', async () => {
  const f = setup({ executeWorkflow: async () => ({ ok: false, exit_code: 1, runtime_id: 'runtime' }) });
  const failed = await f.port().execute(f.request('execute_skills', { workflow_prompt: 'run' }));
  assert.equal(failed.status, 'error'); assert.equal(failed.content.executed, true);
  const denied = await f.port(() => false).execute(f.request('execute_skills', { workflow_prompt: 'run' }));
  assert.equal(denied.content.executed, false);
});

test('Native approval envelopes preserve interaction identity before dispatch and from backend', async () => {
  let calls = 0;
  const f = setup({ authorize: async () => ({ status: 'approval_required', interactionId: 'consent' }),
    executeWorkflow: async () => { calls++; } });
  assert.deepEqual(await f.port().execute(f.request('execute_skills', { workflow_prompt: 'run' })),
    { status: 'approval_required', interactionId: 'consent', content: { executed: false } });
  assert.equal(calls, 0);
  const g = setup({ executeWorkflow: async () => ({ status: 'approval_required', interactionId: 'remote-consent' }) });
  const result = await g.port().execute(g.request('execute_skills', { workflow_prompt: 'run' }));
  assert.equal(result.status, 'approval_required'); assert.equal(result.interactionId, 'remote-consent');
});

test('provider binds Agent revision and Build alongside trusted session authority', async () => {
  assert.throws(() => createStudioNativeSkills({ authorize: async () => 'allow', agentId: 'agent', agentRevision: 4,
    executeWorkflow: async () => ({ ok: true, exit_code: 0 }) }), /backend_binding_required/);
  const provider = createStudioNativeSkills({ authorize: async () => 'allow', agentId: 'agent', agentRevision: 4, buildId: 'build' });
  assert.throws(() => provider.forAgent(agent, { scope, sessionId: 'session', agentRevision: 3, assertCurrent: () => true }), /revision_mismatch/);
  const port = provider.forAgent(agent, { scope, sessionId: 'session', agentRevision: 4, assertCurrent: () => true }).tools;
  const f = setup(), request = f.request(); request.buildId = 'other-build';
  assert.equal((await port.execute(request)).content.code, 'NATIVE_SKILL_BINDING_BUILD_MISMATCH');
});

test('an empty authorization decision denies without entering the backend', async () => {
  let calls = 0;
  const f = setup({ authorize: async () => null, executeWorkflow: async () => { calls++; } });
  const output = await f.port().execute(f.request('execute_skills', { workflow_prompt: 'run' }));
  assert.equal(output.status, 'error'); assert.equal(output.content.executed, false); assert.equal(calls, 0);
});

test('real SQLite intent authorizes the Skills port once and rejects the original request after completion', async t => {
  const root = mkdtempSync(join(tmpdir(), 'native-skills-authority-'));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const filename = join(root, 'ledger.sqlite'); let store = new SqliteRunStore(filename);
  t.after(() => store.close());
  let serviceCalls = 0, modelCalls = 0, original;
  const f = setup({ serviceClient: { listSkillsBySpaceId: async () => { serviceCalls++; return { activeSkills: [] }; } } });
  // Match the production Host's explicit effect window around the longest tool.
  const { config, snapshot } = fixture({ tools: f.tools.definitions,
    limits: { effectTimeoutMs: Math.max(120000, ...f.tools.definitions.map(d => d.timeoutMs + 10000)) } });
  const guard = createNativeToolAuthority({ scope, sessionId: 'session', store });
  const port = f.port(guard);
  const kernel = new NativeKernel({ store, owner: 'host', digest, ports: {
    tools: { execute: request => { original = request; return port.execute(request); } },
    model: { generate: async () => !modelCalls++ ? { kind: 'tool_calls', text: '', usage: emptyUsage(),
      toolCalls: [{ callId: 'list', name: 'list_skills', arguments: {} }] }
      : { kind: 'final_candidate', text: 'done', usage: emptyUsage(), toolCalls: [] } },
  } });
  kernel.start(snapshot, config);
  assert.equal((await kernel.runUntilIdle(scope, 'run')).phase, 'completed');
  const loaded = store.load(scope, 'run'), intent = loaded.intents.find(i => i.kind === 'tool');
  const receipt = loaded.receipts.find(r => r.operationKey === intent.operationKey);
  assert.equal(receipt.status, 'committed'); assert.equal(receipt.result.results[0].status, 'ok');
  assert.equal(serviceCalls, 1);
  assert.equal((await port.execute(original)).content.code, 'NATIVE_SKILL_AUTHORITY_EXPIRED');
  store.close(); store = new SqliteRunStore(filename);
  const reopened = f.port(createNativeToolAuthority({ scope, sessionId: 'session', store }));
  assert.equal((await reopened.execute(original)).status, 'error'); assert.equal(serviceCalls, 1);
});
