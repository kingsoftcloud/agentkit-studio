import test from 'node:test';
import assert from 'node:assert/strict';
import { validateTeamRoleSpec, validateTeamTemplate } from '../src/team-template-contract.mjs';

const valid = {
  kind: 'team', id: 'research-team', version: '1.0.0', name: '研究团',
  instructions: '由主理人拆解任务，成员协作后汇总结果。',
  roles: [
    { name: 'lead', label: '主理人', template: { id: 'lead', version: '1.0.0', digest: 'sha256:lead' } },
    { name: 'reviewer', label: '审查员', instructions: '审查并汇报', template: { id: 'reviewer', version: '1.0.0', digest: 'sha256:reviewer' } },
  ],
};

test('Team template contract requires immutable role sources and stable role names', () => {
  const result = validateTeamTemplate(valid);
  assert.equal(result.contract, 'agentkit.studio.team-template/v1');
  assert.equal(result.roles[1].template.version, '1.0.0');
  const inheritedVersion = validateTeamTemplate({ ...valid, roles: [{ ...valid.roles[0], template: { id: 'lead', digest: 'sha256:lead' } }, valid.roles[1]] });
  assert.equal(inheritedVersion.roles[0].template.version, valid.version);
  assert.throws(() => validateTeamTemplate({ ...valid, roles: [valid.roles[0], { ...valid.roles[1], name: 'lead' }] }), { code: 'TEAM_TEMPLATE_ROLE_INVALID' });
});

test('Team templates preserve role preset and default model metadata', () => {
  const result = validateTeamTemplate({
    ...valid,
    defaultModel: 'deepseek-v4.1-flash-1017',
    roles: [
      { ...valid.roles[0], agentPreset: 'preset:lead' },
      { ...valid.roles[1], agentPresetId: 'preset:reviewer', model: 'deepseek-v4.1-flash-1017' },
    ],
  });
  assert.equal(result.defaultModel, 'deepseek-v4.1-flash-1017');
  assert.equal(result.roles[0].agentPreset, 'preset:lead');
  assert.equal(result.roles[1].agentPreset, 'preset:reviewer');
  assert.equal(result.roles[1].model, 'deepseek-v4.1-flash-1017');
});

test('Team templates reject the old one-team-model placeholder', () => {
  assert.throws(() => validateTeamTemplate({ ...valid, defaultModel: 'one-team-model' }), { code: 'TEAM_TEMPLATE_MODEL_INVALID' });
  assert.throws(() => validateTeamTemplate({
    ...valid,
    roles: [{ ...valid.roles[0], modelProfileId: 'one-team-model' }, valid.roles[1]],
  }), { code: 'TEAM_TEMPLATE_MODEL_INVALID' });
  assert.throws(() => validateTeamRoleSpec({
    runtime: { type: 'dsh-native' },
    instructions: { system: '审查' },
    bindings: { modelProfileId: 'one-team-model' },
  }, 'reviewer'), { code: 'TEAM_TEMPLATE_MODEL_INVALID' });
});

test('published Team templates cannot embed ordinary Agent identities', () => {
  assert.throws(() => validateTeamTemplate({
    ...valid,
    roles: [{ ...valid.roles[0], agentId: 'ar-local-123' }, valid.roles[1]],
  }), { code: 'TEAM_TEMPLATE_ROLE_INVALID' });
});

test('Team role specs reject Codex and nested ordinary subagents', () => {
  const spec = { runtime: { type: 'harness' }, instructions: { system: '审查' }, bindings: {} };
  assert.equal(validateTeamRoleSpec(spec, 'reviewer'), spec);
  assert.throws(() => validateTeamRoleSpec({ ...spec, runtime: { type: 'codex' } }, 'reviewer'), { code: 'TEAM_TEMPLATE_RUNTIME_UNSUPPORTED' });
  assert.throws(() => validateTeamRoleSpec({ ...spec, subAgents: [] }, 'reviewer'), { code: 'TEAM_TEMPLATE_NESTED_TEAM_UNSUPPORTED' });
});
