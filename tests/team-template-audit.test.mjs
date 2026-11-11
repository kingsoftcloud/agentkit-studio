import test from 'node:test';
import assert from 'node:assert/strict';
import { auditTeamTemplateCatalog } from '../src/team-template-audit.mjs';

const team = {
  kind: 'team', id: 'research-team', version: '1.0.0', name: '研究团',
  instructions: '由主理人拆解任务，成员协作后汇总结果。',
  defaultModel: 'deepseek-v4.1-flash-1017',
  roles: [
    { name: 'lead', label: '主理人', agentPreset: 'preset:lead', template: { id: 'lead', digest: 'sha256:lead' } },
    { name: 'reviewer', label: '审查员', template: { id: 'reviewer', digest: 'sha256:reviewer' } },
  ],
};

const role = id => ({
  kind: 'agent', id, teamRoleOnly: true,
  spec: { runtime: { type: 'dsh-native' }, instructions: { system: '审查并汇报' }, bindings: {} },
});

test('Team catalog audit accepts immutable team-only role definitions', () => {
  const report = auditTeamTemplateCatalog({
    items: [team],
    definitions: { 'agent/lead': role('lead'), 'agent/reviewer': role('reviewer') },
    requireRoleDefinitions: true,
  });
  assert.equal(report.ok, true);
  assert.equal(report.teamCount, 1);
  assert.deepEqual(report.errors, []);
});

test('Team catalog audit catches standalone role definitions and placeholders', () => {
  const report = auditTeamTemplateCatalog({
    items: [{ ...team, defaultModel: undefined }],
    definitions: {
      'agent/lead': { ...role('lead'), teamRoleOnly: false },
      'agent/reviewer': { ...role('reviewer'), spec: { ...role('reviewer').spec, bindings: { modelProfileId: 'one-team-model' } } },
    },
    requireRoleDefinitions: true,
  });
  assert.equal(report.ok, false);
  assert.ok(report.errors.some(row => row.code === 'TEAM_ROLE_NOT_TEAM_ONLY'));
  assert.ok(report.errors.some(row => row.code === 'TEAM_TEMPLATE_PLACEHOLDER_MODEL'));
});

test('Team catalog audit reports missing role definitions separately from hard errors', () => {
  const report = auditTeamTemplateCatalog({ items: [team] });
  assert.equal(report.ok, true);
  assert.equal(report.errors.length, 0);
  assert.ok(report.warnings.some(row => row.code === 'TEAM_ROLE_DEFINITION_MISSING'));
});

