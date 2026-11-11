import test from 'node:test';
import assert from 'node:assert/strict';
import { studioTeammateRequest, teamMemberAllowlist } from '../src/studio-team-tools.mjs';

test('Studio native teammate requests freeze the configured allowlist and child agent preset', () => {
  const signal = new AbortController().signal;
  const run = {
    roles: [
      { name: 'lead', label: '主理人' },
      { name: 'reviewer', label: '审查员', agentPresetId: 'preset-reviewer' },
      { name: 'researcher', label: '研究员', agentPreset: 'preset-researcher' },
    ],
  };
  assert.deepEqual(teamMemberAllowlist(run), ['reviewer', 'researcher']);
  const request = studioTeammateRequest({
    role: run.roles[1],
    run,
    prompt: '审查当前变更',
    signal,
  });
  assert.equal(request.name, 'reviewer');
  assert.equal(request.agentPreset, 'preset-reviewer');
  assert.deepEqual(request.allowedMemberNames, ['reviewer', 'researcher']);
  assert.equal(request.signal, signal);
});

test('official Team tools remain available for Lead-created extra members', async () => {
  const { installStudioTeamTools } = await import('../src/studio-team-tools.mjs');
  const sections = [];
  const registered = [];
  installStudioTeamTools({
    ctx: {
      tools: { register: tool => registered.push(tool) },
      systemPrompt: { section: section => sections.push(section) },
    },
  }, { teams: {}, run: { roles: [{ name: 'reviewer' }] }, useOfficialTools: true });
  assert.equal(registered.length, 0);
  assert.match(sections[0].text, /Lead 可按任务需要创建额外成员/);
});

test('Studio adapter applies the configured role allowlist and preset to its own spawn', async () => {
  const { installStudioTeamTools } = await import('../src/studio-team-tools.mjs');
  const registered = new Map();
  const calls = [];
  const agent = { ctx: {
    tools: { register: tool => registered.set(tool.name, tool) },
    systemPrompt: { section: () => {} },
  } };
  const teams = {
    listMembers: () => [],
    spawnTeammate: async (_root, request) => { calls.push(request); return { member: { name: request.name, status: 'provisioning' } }; },
  };
  const run = { roles: [
    { name: 'lead', label: '主理人' },
    { name: 'reviewer', label: '审查员', instructions: '审查', agentPreset: 'preset-reviewer' },
  ] };
  installStudioTeamTools(agent, { teams, run });
  const spawn = registered.get('spawn_teammate');
  const result = await spawn.execute({ name: 'reviewer', prompt: '检查变更' }, { agent, signal: new AbortController().signal });
  assert.equal(JSON.parse(result.result).member.name, 'reviewer');
  assert.equal(calls[0].agentPreset, 'preset-reviewer');
  assert.deepEqual(calls[0].allowedMemberNames, ['reviewer']);
  await assert.rejects(spawn.execute({ name: 'extra', prompt: '扩展任务' }, { agent, signal: new AbortController().signal }), { code: 'TEAM_ROLE_UNAVAILABLE' });
});
