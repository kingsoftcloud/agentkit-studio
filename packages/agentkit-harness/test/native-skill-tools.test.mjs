import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSkillNames, matchSkillRefs, skillManifestItem, selectPublicSkillRefs, createNativeSkillTools, SKILL_TOOL_CONTRACT } from '../src/native/skill-tools.mjs';
import { createStudioNativeSkills } from '../../../src/providers/native-dsh-skills.mjs';
import { createNativeSkillEventJournal, nativeSkillEventEvidence } from '../src/native/skill-events.mjs';

const SCOPE = { tenantId: 't', workspaceId: 'w', userId: 'u', agentId: 'a' };
const IDENTITY = { scope: SCOPE, runId: 'r1', sessionId: 's1', turnId: 't1', buildId: 'b1', parentRunId: null, taskChainId: 'c1', operationKey: 'op1', executionFence: 1 };
const AGENT = { session: { id: 's1' } };
const AUTHORITY = { scope: SCOPE, sessionId: 's1', assertCurrent: () => true };

function makeTools(opts = {}) {
  let serviceCalls = 0;
  const serviceClient = opts.serviceClient || { listSkillsBySpaceId: async () => { serviceCalls++; return { activeSkills: [] }; } };
  const auth = opts.authorize || (async () => 'allow');
  const tools = createNativeSkillTools({
    serviceClient, executeWorkflow: opts.executeWorkflow, loadSkillFn: opts.loadSkillFn, authorize: auth,
    skillSpaceIds: opts.skillSpaceIds || ['space'], publicSpaceIds: opts.publicSpaceIds || [],
    publicAllowlist: opts.publicAllowlist || [], boundSkillNames: opts.boundSkillNames || [],
  });
  return { tools, serviceCalls: () => serviceCalls };
}

function exec(tools, name, args = {}, overrides = {}) {
  return tools.forAgent(AGENT, AUTHORITY).tools.execute({
    definition: structuredClone(tools.definitions.find(d => d.name === name)),
    call: { callId: 'c1', name, arguments: args }, signal: new AbortController().signal,
    ...IDENTITY, ...overrides,
  });
}

// --- pure helpers ---

test('normalizeSkillNames handles all input shapes', () => {
  assert.deepEqual(normalizeSkillNames(null), []);
  assert.deepEqual(normalizeSkillNames('a, b , a'), ['a', 'b']);
  assert.deepEqual(normalizeSkillNames(['x', 'y', ' x ']), ['x', 'y']);
});

test('matchSkillRefs dedupes by cache key', () => {
  const refs = [{ name: 'dup', cacheKey: 'k1', skillId: 's1', description: '', aliases: [], tags: [] },
    { name: 'dup', cacheKey: 'k1', skillId: 's2', description: '', aliases: [], tags: [] }];
  assert.equal(matchSkillRefs(refs, 'dup', { skillNames: ['dup'] }).length, 1);
});

test('skillManifestItem truncates long descriptions', () => {
  assert.ok(skillManifestItem({ name: 't', description: 'x'.repeat(300), version: '1', aliases: [], tags: [] }, 's').description.length <= 240);
});

test('createNativeSkillTools requires authorize callback', () => {
  assert.throws(() => createNativeSkillTools({}), /authorize_required/);
});

test('definitions are isolated between instances', () => {
  const t1 = createNativeSkillTools({ authorize: async () => 'allow' });
  const t2 = createNativeSkillTools({ authorize: async () => 'allow' });
  assert.notStrictEqual(t1.definitions, t2.definitions);
  assert.notStrictEqual(t1.definitions[0], t2.definitions[0]);
});

// --- fix #1: forged/mutated definition → zero service calls ---

test('forged definition (wrong permissions) → rejected, zero service calls', async () => {
  const { tools, serviceCalls } = makeTools();
  const forgedDef = { ...tools.definitions[1], permissions: ['evil'] }; // list_skills with wrong permissions
  const r = await exec(tools, 'list_skills', {}, { definition: forgedDef });
  assert.equal(r.status, 'error');
  assert.equal(r.content.code, 'NATIVE_SKILL_DEFINITION_FORGED');
  assert.equal(serviceCalls(), 0);
});

test('mutated public definition is rejected against the original internal formal', async () => {
  const { tools, serviceCalls } = makeTools();
  tools.definitions[1].permissions = ['evil'];
  const r = await exec(tools, 'list_skills');
  assert.equal(r.status, 'error');
  assert.equal(r.content.code, 'NATIVE_SKILL_DEFINITION_FORGED');
  assert.equal(serviceCalls(), 0);
});

test('same instance definition mutation → public copy unaffected', () => {
  const { tools } = makeTools();
  const def1 = tools.definitions[1];
  def1._test = true;
  // A second factory call should not see the mutation.
  const { tools: tools2 } = makeTools();
  assert.equal(tools2.definitions[1]._test, undefined);
});

// --- fix #2: foreign binding → rejected ---

test('forAgent requires agent.session.id', () => {
  const tools = createNativeSkillTools({ authorize: async () => 'allow', skillSpaceIds: ['s'] });
  assert.throws(() => tools.forAgent({}, AUTHORITY), /agent_session_required/);
});

test('forAgent requires authority.scope', () => {
  const tools = createNativeSkillTools({ authorize: async () => 'allow', skillSpaceIds: ['s'] });
  assert.throws(() => tools.forAgent(AGENT, {}), /authority_scope_required/);
});

test('request scope mismatch with authority → rejected', async () => {
  const { tools, serviceCalls } = makeTools();
  const foreignScope = { tenantId: 't', workspaceId: 'w', userId: 'u', agentId: 'EVIL' };
  const r = await exec(tools, 'list_skills', {}, { scope: foreignScope });
  assert.equal(r.status, 'error');
  assert.equal(r.content.code, 'NATIVE_SKILL_AUTHORITY_SCOPE_MISMATCH');
  assert.equal(serviceCalls(), 0);
});

test('request sessionId mismatch with authority → rejected', async () => {
  const { tools, serviceCalls } = makeTools();
  const r = await exec(tools, 'list_skills', {}, { sessionId: 'foreign-session' });
  assert.equal(r.status, 'error');
  assert.equal(r.content.code, 'NATIVE_SKILL_AUTHORITY_SESSION_MISMATCH');
  assert.equal(serviceCalls(), 0);
});

// --- fix #3: run drift after authorization → rejected ---

test('runId drift after authorization await → rejected, zero service calls', async () => {
  let authResolve;
  const { tools, serviceCalls } = makeTools({
    authorize: () => new Promise(resolve => { authResolve = resolve; }),
  });
  const request = { definition: structuredClone(tools.definitions.find(d => d.name === 'list_skills')), call: { callId: 'c1', name: 'list_skills', arguments: {} }, signal: new AbortController().signal, ...IDENTITY };
  const promise = tools.forAgent(AGENT, AUTHORITY).tools.execute(request);
  // Mutate runId while authorization is pending.
  request.runId = 'drifted-run';
  authResolve('allow');
  const r = await promise;
  assert.equal(r.status, 'error');
  assert.match(r.content.code, /DRIFT|CANCELLED/);
  assert.equal(serviceCalls(), 0, 'zero service calls after runId drift');
});

// --- missing identity → zero service calls (review repro) ---

test('all identity missing → rejected, zero service calls', async () => {
  const { tools, serviceCalls } = makeTools();
  const r = await tools.forAgent(AGENT, AUTHORITY).tools.execute({ call: { name: 'list_skills', arguments: {} } });
  assert.equal(r.status, 'error');
  assert.equal(serviceCalls(), 0);
});

test('missing callId → rejected', async () => {
  const { tools } = makeTools();
  const r = await exec(tools, 'list_skills', {}, { call: { name: 'list_skills', arguments: {} } });
  assert.equal(r.status, 'error');
  assert.equal(r.content.code, 'NATIVE_SKILL_CALL_ID_MISSING');
});

// --- fix #4: uncertain after workflow, approval_required ---

test('uncertain backend result → status uncertain, not error', async () => {
  const events = [], journal = createNativeSkillEventJournal({ runtimeId: 'original-runtime', request: { runId: 'r1' }, bindingDigest: 'binding', events });
  journal.emit('skill.workflow.failed', 'uncertain', { errorCategory: 'outcome_unknown' });
  const { tools } = makeTools({ executeWorkflow: async () => ({ uncertain: true, error_type: 'timeout', ...nativeSkillEventEvidence(events) }) });
  const r = await exec(tools, 'execute_skills', { workflow_prompt: 'test' });
  assert.equal(r.status, 'uncertain');
  assert.equal(r.content.uncertain, true);
  assert.equal(r.content.executed, undefined);
  assert.deepEqual(r.content.skill_events, events);
});

test('backend throw after effectStarted → uncertain', async () => {
  const { tools } = makeTools({ executeWorkflow: async () => { throw Object.assign(new Error('crash'), { code: 'runtime_crash' }); } });
  const r = await exec(tools, 'execute_skills', { workflow_prompt: 'test' });
  assert.equal(r.status, 'uncertain');
  assert.equal(r.content.uncertain, true);
});

test('cancel after actual workflow dispatch preserves uncertain locator', async () => {
  const controller = new AbortController();
  let calls = 0;
  const { tools } = makeTools({ executeWorkflow: async () => {
    calls++; controller.abort(); return { ok: true, exit_code: 0, runtime_id: 'original-runtime' };
  } });
  const r = await exec(tools, 'execute_skills', { workflow_prompt: 'test' }, { signal: controller.signal });
  assert.equal(calls, 1);
  assert.equal(r.status, 'uncertain');
  assert.equal(r.content.runtime_id, 'original-runtime');
  assert.equal(r.content.operationKey, 'op1');
  assert.notEqual(r.content.executed, false);
});

test('a dispatched backend cannot claim a clean approval pause after side effects', async () => {
  let effects = 0;
  const { tools } = makeTools({ executeWorkflow: async () => { effects++; return { approval_required: true, interactionId: 'appr-1' }; } });
  const r = await exec(tools, 'execute_skills', { workflow_prompt: 'test' });
  assert.equal(effects, 1);
  assert.equal(r.status, 'uncertain');
  assert.equal(r.content.error_type, 'invalid_skill_approval');
  assert.equal(r.content.interactionId, 'appr-1');
  assert.equal(r.content.uncertain, true);
  assert.equal(r.content.executed, undefined);
  assert.equal(r.content.operationKey, 'op1');
});

test('execute_skills passes full call and definition to backend', async () => {
  let received;
  const { tools } = makeTools({ executeWorkflow: async (req) => { received = req; return { ok: true, exit_code: 0 }; } });
  await exec(tools, 'execute_skills', { workflow_prompt: 'test' });
  assert.ok(received.call);
  assert.equal(received.call.callId, 'c1');
  assert.ok(received.lockedDefinition);
  assert.equal(received.lockedDefinition.name, 'execute_skills');
  assert.equal(received.scope.agentId, 'a');
  assert.equal(received.runId, 'r1');
});

// --- space binding (fix #5) ---

test('unbound space_id → rejected before service call', async () => {
  const { tools, serviceCalls } = makeTools();
  const r = await exec(tools, 'list_skills', { space_id: 'evil' });
  assert.equal(r.status, 'error');
  assert.equal(serviceCalls(), 0);
});

test('public space id directly → premade with allowlist', async () => {
  let listCalls = 0, premadeCalls = 0;
  const { tools } = makeTools({
    serviceClient: {
      listSkillsBySpaceId: async () => { listCalls++; return { activeSkills: [] }; },
      listAvailablePremadeSkills: async () => { premadeCalls++; return { activeSkills: [
        { name: 'pub-a', skillId: 's1', versionId: 'v1', version: '1', aliases: [], tags: [], cacheKey: 'k1' },
        { name: 'pub-b', skillId: 's2', versionId: 'v2', version: '1', aliases: [], tags: [], cacheKey: 'k2' },
      ], spaceId: 'public-space' }; },
    },
    publicSpaceIds: ['public-space'], publicAllowlist: ['pub-a'],
  });
  const r = await exec(tools, 'list_skills', { space_id: 'public-space' });
  assert.equal(r.status, 'ok');
  assert.equal(r.content.skills.length, 1);
  assert.equal(r.content.skills[0].name, 'pub-a');
  assert.equal(listCalls, 0);
  assert.equal(premadeCalls, 1);
});

// --- pre-aborted signal ---

test('pre-aborted signal → rejected without authorization', async () => {
  let authCalls = 0;
  const { tools } = makeTools({ authorize: async () => { authCalls++; return 'allow'; } });
  const controller = new AbortController(); controller.abort();
  const r = await tools.forAgent(AGENT, AUTHORITY).tools.execute({
    definition: structuredClone(tools.definitions.find(d => d.name === 'list_skills')), call: { callId: 'c1', name: 'list_skills', arguments: {} }, signal: controller.signal, ...IDENTITY });
  assert.equal(r.status, 'error');
  assert.equal(r.content.code, 'REQUEST_CANCELLED');
  assert.equal(authCalls, 0);
});

// --- schema validation ---

test('toolInputRejection validates schema (max_results out of range)', async () => {
  const { tools } = makeTools();
  const r = await exec(tools, 'search_skills', { query: 'test', max_results: 999 });
  assert.equal(r.status, 'error');
  assert.equal(r.content.code, 'invalid_arguments');
});

// --- provider ---

test('createStudioNativeSkills validates agentId and agentRevision', () => {
  assert.throws(() => createStudioNativeSkills({ authorize: async () => 'allow', agentId: '', agentRevision: 1 }), /agent_id_required/);
  assert.throws(() => createStudioNativeSkills({ authorize: async () => 'allow', agentId: 'a', agentRevision: 0 }), /agent_revision_required/);
});

test('bindingDigest includes backendBindingDigest, not function source', () => {
  const p1 = createStudioNativeSkills({ authorize: async () => 'allow', agentId: 'a', agentRevision: 1, backendBindingDigest: 'x' });
  const p2 = createStudioNativeSkills({ authorize: async () => 'allow', agentId: 'a', agentRevision: 1, backendBindingDigest: 'y' });
  assert.notEqual(p1.bindingDigest, p2.bindingDigest);
  assert.equal(p1.bindingDigest.includes('secret'), false);
});

test('definitions isolated from internal arrays', () => {
  const p1 = createStudioNativeSkills({ authorize: async () => 'allow', agentId: 'a', agentRevision: 1 });
  p1.definitions[0]._mutated = true;
  const p2 = createStudioNativeSkills({ authorize: async () => 'allow', agentId: 'b', agentRevision: 1 });
  assert.equal(p2.definitions[0]._mutated, undefined);
});
