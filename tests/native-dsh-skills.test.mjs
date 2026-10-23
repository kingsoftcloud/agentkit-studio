import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createNativeSkillTools } from '../packages/agentkit-harness/src/native/skill-tools.mjs';
import { createStudioNativeSkills } from '../src/providers/native-dsh-skills.mjs';

const SCOPE = { tenantId: 't', workspaceId: 'w', userId: 'u', agentId: 'a' };
const IDENTITY = { scope: SCOPE, runId: 'r1', sessionId: 's1', turnId: 't1', buildId: 'b1', parentRunId: null, taskChainId: 'c1', operationKey: 'op1', executionFence: 1 };
const AGENT = { session: { id: 's1' } };
const AUTHORITY = { scope: SCOPE, sessionId: 's1', assertCurrent: () => true };

function fakeSkillRef(name, opts = {}) {
  return { name, skillId: opts.skillId || `sk-${name}`, versionId: opts.versionId || `v1-${name}`,
    version: opts.version || '1.0.0', description: opts.description || `Skill ${name}`,
    aliases: opts.aliases || [], tags: opts.tags || [], cacheKey: `key-${name}`,
    contentHash: opts.contentHash || `hash-${name}` };
}

function fakeServiceClient(spaces = {}) {
  const calls = [];
  return {
    calls,
    listSkillSpaces: async () => { calls.push('listSkillSpaces'); return { data: { SkillSpaces: Object.keys(spaces).map(id => ({ SkillSpaceId: id })) } }; },
    listSkillsBySpaceId: async (spaceId) => { calls.push(`list:${spaceId}`); return { activeSkills: spaces[spaceId] || [] }; },
    listAvailablePremadeSkills: async () => {
      calls.push('premade');
      const publicSkills = Object.entries(spaces).filter(([k]) => k === 'public' || k.startsWith('public')).flatMap(([, v]) => v);
      return { activeSkills: publicSkills, spaceId: 'public' };
    },
  };
}

function setup(opts = {}) {
  const client = fakeServiceClient(opts.spaces || {});
  let authCalls = 0;
  const auth = async (toolName) => { authCalls++; return !opts.allowedTools || opts.allowedTools.has(toolName) ? 'allow' : { code: 'SKILL_DENIED', message: 'denied' }; };
  const tools = createNativeSkillTools({
    serviceClient: client, executeWorkflow: opts.executeWorkflow, loadSkillFn: opts.loadSkillFn, authorize: auth,
    skillSpaceIds: opts.skillSpaceIds || ['user-1'], publicSpaceIds: opts.publicSpaceIds || [],
    publicAllowlist: opts.publicAllowlist || [], boundSkillNames: opts.boundSkillNames || [],
  });
  const exec = (name, args = {}, overrides = {}) => tools.forAgent(AGENT, AUTHORITY).tools.execute({
    definition: structuredClone(tools.definitions.find(d => d.name === name)),
    call: { callId: 'c1', name, arguments: args }, signal: new AbortController().signal, ...IDENTITY, ...overrides });
  return { client, tools, exec, authCalls: () => authCalls };
}

// --- review repro: all identity missing → zero service calls ---

test('all identity missing → rejected, zero service calls (review repro #1)', async () => {
  const s = setup({ spaces: { 'user-1': [fakeSkillRef('a')] } });
  const r = await s.tools.forAgent(AGENT, AUTHORITY).tools.execute({ call: { name: 'list_skills', arguments: {} } });
  assert.equal(r.status, 'error');
  assert.equal(s.client.calls.length, 0);
});

// --- review repro: uncertain → status uncertain (review repro #2) ---

test('uncertain backend → status uncertain, not error (review repro #2)', async () => {
  const s = setup({ executeWorkflow: async () => ({ uncertain: true, error_type: 'timeout' }) });
  const r = await s.exec('execute_skills', { workflow_prompt: 'test' });
  assert.equal(r.status, 'uncertain');
  assert.equal(r.content.uncertain, true);
  assert.equal(r.content.executed, undefined);
});

// --- fix #1: forged definition ---

test('forged definition → rejected, zero service calls', async () => {
  const s = setup({ spaces: { 'user-1': [fakeSkillRef('a')] } });
  const forgedDef = { ...s.tools.definitions[1], permissions: ['evil'] };
  const r = await s.exec('list_skills', {}, { definition: forgedDef });
  assert.equal(r.status, 'error');
  assert.equal(r.content.code, 'NATIVE_SKILL_DEFINITION_FORGED');
  assert.equal(s.client.calls.length, 0);
});

test('same instance definition mutation → public copy unaffected', () => {
  const s = setup();
  s.tools.definitions[1]._test = true;
  const s2 = setup();
  assert.equal(s2.tools.definitions[1]._test, undefined);
});

// --- fix #2: foreign binding ---

test('foreign scope → rejected, zero service calls', async () => {
  const s = setup({ spaces: { 'user-1': [fakeSkillRef('a')] } });
  const r = await s.exec('list_skills', {}, { scope: { tenantId: 't', workspaceId: 'w', userId: 'u', agentId: 'EVIL' } });
  assert.equal(r.status, 'error');
  assert.equal(r.content.code, 'NATIVE_SKILL_AUTHORITY_SCOPE_MISMATCH');
  assert.equal(s.client.calls.length, 0);
});

// --- fix #3: run drift after authorization ---

test('runId drift after authorization → rejected, zero service calls', async () => {
  let authResolve;
  const s = setup({ spaces: { 'user-1': [fakeSkillRef('a')] }, authorize: undefined });
  // Override authorize with a controllable promise
  let authCalls = 0;
  const tools = createNativeSkillTools({
    serviceClient: s.client, authorize: () => new Promise(resolve => { authResolve = resolve; }),
    skillSpaceIds: ['user-1'],
  });
  const request = { definition: structuredClone(tools.definitions.find(d => d.name === 'list_skills')), call: { callId: 'c1', name: 'list_skills', arguments: {} }, signal: new AbortController().signal, ...IDENTITY };
  const promise = tools.forAgent(AGENT, AUTHORITY).tools.execute(request);
  request.runId = 'drifted-run';
  authResolve('allow');
  const r = await promise;
  assert.equal(r.status, 'error');
  assert.match(r.content.code, /DRIFT|CANCELLED/);
  assert.equal(s.client.calls.length, 0);
});

// --- fix #4: cancel after workflow → uncertain ---

test('backend throw after effectStarted → uncertain', async () => {
  const s = setup({ executeWorkflow: async () => { throw Object.assign(new Error('crash'), { code: 'runtime_crash' }); } });
  const r = await s.exec('execute_skills', { workflow_prompt: 'test' });
  assert.equal(r.status, 'uncertain');
  assert.equal(r.content.uncertain, true);
});

test('dispatched workflow approval result preserves interaction evidence without claiming no execution', async () => {
  let effects = 0;
  const s = setup({ executeWorkflow: async () => { effects++; return { approval_required: true, interactionId: 'appr-1' }; } });
  const r = await s.exec('execute_skills', { workflow_prompt: 'test' });
  assert.equal(effects, 1);
  assert.equal(r.status, 'uncertain');
  assert.equal(r.content.error_type, 'invalid_skill_approval');
  assert.equal(r.content.interactionId, 'appr-1');
  assert.equal(r.content.uncertain, true);
  assert.equal(r.content.executed, undefined);
});

// --- space binding ---

test('unbound space_id → rejected before service call', async () => {
  const s = setup({ spaces: { 'user-1': [fakeSkillRef('a')] } });
  const r = await s.exec('list_skills', { space_id: 'evil' });
  assert.equal(r.status, 'error'); assert.equal(s.client.calls.length, 0);
});

test('public space id → premade with allowlist', async () => {
  const s = setup({ spaces: { 'public-space': [fakeSkillRef('pub-a'), fakeSkillRef('pub-b')] },
    publicSpaceIds: ['public-space'], publicAllowlist: ['pub-a'] });
  const r = await s.exec('list_skills', { space_id: 'public-space' });
  assert.equal(r.status, 'ok');
  assert.equal(r.content.skills.length, 1);
  assert.equal(r.content.skills[0].name, 'pub-a');
  assert.equal(s.client.calls.some(c => c.startsWith('list:')), false);
  assert.equal(s.client.calls.includes('premade'), true);
});

// --- list_skill_spaces ---

test('list_skill_spaces returns configured spaces', async () => {
  const s = setup({ spaces: { 'user-1': [fakeSkillRef('a')] } });
  const r = await s.exec('list_skill_spaces');
  assert.equal(r.status, 'ok'); assert.ok(r.content.spaces.length >= 1);
});

test('list_skill_spaces falls back when service unavailable', async () => {
  const s = setup({ spaces: {}, skillSpaceIds: ['u1', 'u2'] });
  s.client.listSkillSpaces = async () => { throw new Error('unavailable'); };
  const r = await s.exec('list_skill_spaces');
  assert.equal(r.content.ok, true);
  assert.deepEqual(r.content.spaces.map(sp => sp.space_id), ['u1', 'u2']);
});

// --- list_skills ---

test('list_skills returns manifests', async () => {
  const s = setup({ spaces: { 'user-1': [fakeSkillRef('alpha'), fakeSkillRef('beta')] } });
  const r = await s.exec('list_skills');
  assert.equal(r.status, 'ok'); assert.equal(r.content.skills.length, 2);
});

test('list_skills empty space → ok with empty list', async () => {
  const s = setup({ spaces: { 'user-1': [] } });
  const r = await s.exec('list_skills');
  assert.equal(r.content.ok, true); assert.equal(r.content.skills.length, 0);
});

// --- search_skills ---

test('search_skills finds by query', async () => {
  const s = setup({ spaces: { 'user-1': [fakeSkillRef('code-review', { description: 'Review code', tags: ['review'] })] } });
  const r = await s.exec('search_skills', { query: 'review' });
  assert.equal(r.status, 'ok'); assert.equal(r.content.results.length, 1);
  assert.equal(r.content.results[0].space_id, 'user-1');
});

test('search_skills empty query → error', async () => {
  const s = setup({ spaces: { 'user-1': [fakeSkillRef('a')] } });
  const r = await s.exec('search_skills', { query: '' });
  assert.equal(r.status, 'error'); assert.equal(r.content.ok, false);
});

// --- preview_skill ---

test('preview_skill returns manifest without download', async () => {
  const s = setup({ spaces: { 'user-1': [fakeSkillRef('alpha', { description: 'Alpha' })] } });
  const r = await s.exec('preview_skill', { skill_name: 'alpha' });
  assert.equal(r.status, 'ok'); assert.equal(r.content.execution_context, 'manifest_preview');
});

test('preview_skill not found → error with available', async () => {
  const s = setup({ spaces: { 'user-1': [fakeSkillRef('alpha'), fakeSkillRef('beta')] } });
  const r = await s.exec('preview_skill', { skill_name: 'gamma' });
  assert.equal(r.status, 'error');
  assert.deepEqual(r.content.available_skills, ['alpha', 'beta']);
});

// --- load_skill with real filesystem ---

test('load_skill reads actual SKILL.md via loadSkillFn', async () => {
  const root = mkdtempSync(join(tmpdir(), 'skills-load-'));
  try {
    const skillDir = join(root, 'alpha');
    mkdirSync(join(skillDir, 'scripts'), { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: alpha\ndescription: Alpha desc\n---\n# Alpha\nReal instructions.');
    writeFileSync(join(skillDir, 'scripts', 'run.sh'), '#!/bin/sh\necho hi');
    const s = setup({ spaces: { 'user-1': [fakeSkillRef('alpha', { description: 'Alpha desc' })] },
      loadSkillFn: async ({ skillId, versionId, name, contentHash }) => {
        assert.equal(skillId, 'sk-alpha'); assert.equal(versionId, 'v1-alpha'); assert.equal(contentHash, 'hash-alpha');
        return { skillId, versionId, spaceId: 'user-1', contentHash, content: '---\nname: alpha\n---\n# Alpha\nReal instructions.', rootDir: skillDir };
      } });
    const r = await s.exec('load_skill', { skill_name: 'alpha' });
    assert.equal(r.status, 'ok');
    assert.match(r.content.instructions, /Real instructions/);
    assert.ok(r.content.root_dir);
    assert.equal(r.content.has_scripts_dir, true);
    assert.ok(r.content.script_files.length > 0);
    assert.match(r.content.script_files[0], /run\.sh/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('load_skill without loadSkillFn → error', async () => {
  const s = setup({ spaces: { 'user-1': [fakeSkillRef('alpha')] } });
  const r = await s.exec('load_skill', { skill_name: 'alpha' });
  assert.equal(r.status, 'error');
  assert.equal(r.content.error_type, 'SKILL_LOADER_UNAVAILABLE');
});

test('load_skill with null content → error', async () => {
  const s = setup({ spaces: { 'user-1': [fakeSkillRef('alpha')] }, loadSkillFn: async () => ({ content: null }) });
  const r = await s.exec('load_skill', { skill_name: 'alpha' });
  assert.equal(r.status, 'error');
  assert.equal(r.content.error_type, 'SKILL_MANIFEST_MISSING');
});

test('load_skill case-insensitive match', async () => {
  const root = mkdtempSync(join(tmpdir(), 'skills-ci-'));
  try {
    mkdirSync(join(root, 'alphaskill'), { recursive: true });
    writeFileSync(join(root, 'alphaskill', 'SKILL.md'), '---\nname: AlphaSkill\n---\nInstructions.');
    const s = setup({ spaces: { 'user-1': [fakeSkillRef('AlphaSkill')] },
      loadSkillFn: async () => ({ ...fakeSkillRef('AlphaSkill'), spaceId: 'user-1', content: 'Instructions.', rootDir: join(root, 'alphaskill') }) });
    const r = await s.exec('load_skill', { skill_name: 'alPHAskIll' });
    assert.equal(r.status, 'ok'); assert.equal(r.content.name, 'AlphaSkill');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('scanScripts rejects symlink scripts directory', async () => {
  const root = mkdtempSync(join(tmpdir(), 'skills-sym-'));
  try {
    const skillDir = join(root, 'alpha');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: alpha\n---\nBody.');
    mkdirSync(join(root, 'real-scripts'), { recursive: true });
    writeFileSync(join(root, 'real-scripts', 'evil.sh'), 'evil');
    symlinkSync(join(root, 'real-scripts'), join(skillDir, 'scripts'));
    const s = setup({ spaces: { 'user-1': [fakeSkillRef('alpha')] },
      loadSkillFn: async () => ({ ...fakeSkillRef('alpha'), spaceId: 'user-1', content: 'Body.', rootDir: skillDir }) });
    const r = await s.exec('load_skill', { skill_name: 'alpha' });
    assert.equal(r.status, 'ok');
    assert.equal(r.content.has_scripts_dir, false);
    assert.equal(r.content.script_files.length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// --- authorization ---

test('authorization denial → error without service call', async () => {
  const s = setup({ spaces: { 'user-1': [fakeSkillRef('a')] }, allowedTools: new Set() });
  const r = await s.exec('list_skills');
  assert.equal(r.status, 'error'); assert.equal(r.content.code, 'SKILL_DENIED');
  assert.equal(s.client.calls.length, 0);
});

// --- execute_skills ---

test('execute_skills without backend → unavailable', async () => {
  const s = setup();
  const r = await s.exec('execute_skills', { workflow_prompt: 'test' });
  assert.equal(r.status, 'error'); assert.equal(r.content.error_type, 'skill_runtime_unavailable');
});

test('execute_skills with backend → result', async () => {
  let received;
  const s = setup({ executeWorkflow: async (req) => { received = req; return { ok: true, exit_code: 0, workflow_status: 'completed' }; } });
  const r = await s.exec('execute_skills', { workflow_prompt: 'test', skill_names: ['alpha'] });
  assert.equal(r.status, 'ok');
  assert.equal(received.runId, 'r1');
  assert.equal(received.call.callId, 'c1');
  assert.ok(received.lockedDefinition);
});

test('execute_skills uncertain throw → status uncertain, not retried', async () => {
  let calls = 0;
  const s = setup({ executeWorkflow: async () => { calls++; throw Object.assign(new Error('timeout'), { code: 'uncertain' }); } });
  const r = await s.exec('execute_skills', { workflow_prompt: 'test' });
  assert.equal(r.status, 'uncertain'); assert.equal(r.content.uncertain, true);
  assert.equal(calls, 1);
});

test('execute_skills passes original signal to backend', async () => {
  let receivedSignal;
  const s = setup({ executeWorkflow: async (req) => { receivedSignal = req.signal; return { ok: true, exit_code: 0 }; } });
  const controller = new AbortController();
  await s.tools.forAgent(AGENT, AUTHORITY).tools.execute({
    definition: structuredClone(s.tools.definitions.find(d => d.name === 'execute_skills')), call: { callId: 'c1', name: 'execute_skills', arguments: { workflow_prompt: 'test' } }, signal: controller.signal, ...IDENTITY });
  assert.equal(receivedSignal, controller.signal);
});

test('execute_skills unbound skill names → rejected before backend', async () => {
  let backendCalls = 0;
  const s = setup({ boundSkillNames: ['alpha'], executeWorkflow: async () => { backendCalls++; return { ok: true, exit_code: 0 }; } });
  const r = await s.exec('execute_skills', { workflow_prompt: 'test', skill_names: ['gamma'] });
  assert.equal(r.status, 'error'); assert.equal(r.content.error_type, 'SKILL_NAME_NOT_BOUND');
  assert.equal(backendCalls, 0);
});

// --- pre-aborted signal ---

test('pre-aborted signal → rejected without authorization', async () => {
  const s = setup();
  const controller = new AbortController(); controller.abort();
  const r = await s.tools.forAgent(AGENT, AUTHORITY).tools.execute({
    definition: structuredClone(s.tools.definitions.find(d => d.name === 'list_skills')), call: { callId: 'c1', name: 'list_skills', arguments: {} }, signal: controller.signal, ...IDENTITY });
  assert.equal(r.status, 'error'); assert.equal(r.content.code, 'REQUEST_CANCELLED');
});

// --- service client signal propagation ---

test('readOnly service calls receive the signal', async () => {
  let receivedSignal;
  const s = setup({ spaces: { 'user-1': [fakeSkillRef('a')] } });
  s.client.listSkillsBySpaceId = async (spaceId, { signal } = {}) => { receivedSignal = signal; return { activeSkills: [fakeSkillRef('a')] }; };
  const controller = new AbortController();
  await s.tools.forAgent(AGENT, AUTHORITY).tools.execute({
    definition: structuredClone(s.tools.definitions.find(d => d.name === 'list_skills')), call: { callId: 'c1', name: 'list_skills', arguments: {} }, signal: controller.signal, ...IDENTITY });
  assert.equal(receivedSignal, controller.signal);
});

// --- provider ---

test('definitions isolated from internal arrays', () => {
  const p1 = createStudioNativeSkills({ authorize: async () => 'allow', agentId: 'a', agentRevision: 1 });
  p1.definitions[0]._mutated = true;
  const p2 = createStudioNativeSkills({ authorize: async () => 'allow', agentId: 'b', agentRevision: 1 });
  assert.equal(p2.definitions[0]._mutated, undefined);
});

test('bindingDigest changes with backendBindingDigest', () => {
  const p1 = createStudioNativeSkills({ authorize: async () => 'allow', agentId: 'a', agentRevision: 1, backendBindingDigest: 'x' });
  const p2 = createStudioNativeSkills({ authorize: async () => 'allow', agentId: 'a', agentRevision: 1, backendBindingDigest: 'y' });
  assert.notEqual(p1.bindingDigest, p2.bindingDigest);
});

test('no service client → list_skills error', async () => {
  const tools = createNativeSkillTools({ authorize: async () => 'allow', skillSpaceIds: ['user-1'] });
  const r = await tools.forAgent(AGENT, AUTHORITY).tools.execute({
    call: { callId: 'c1', name: 'list_skills', arguments: {} }, signal: new AbortController().signal, ...IDENTITY });
  assert.equal(r.status, 'error');
});
