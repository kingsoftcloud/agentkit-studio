/** Shared contract for catalog Team templates before they become a TeamDefinition. */

const fail = (code, message) => Object.assign(new Error(message), { code, status: 400 });
const supportedRuntimes = new Set(['dsh-native', 'harness']);
const roleName = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const semver = /^\d+\.\d+\.\d+$/;

export const TEAM_TEMPLATE_CONTRACT = 'agentkit.studio.team-template/v1';
export const TEAM_TEMPLATE_RUNTIMES = Object.freeze([...supportedRuntimes]);

function requiredText(value, label, max) {
  const text = String(value ?? '').trim();
  if (!text || text.length > max) throw fail('TEAM_TEMPLATE_INVALID', `${label}不能为空且不能超过 ${max} 字`);
  return text;
}

function sourceRef(role, team) {
  const source = role?.template;
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw fail('TEAM_TEMPLATE_ROLE_SOURCE_INVALID', `角色「${role?.name || 'unknown'}」缺少模板来源`);
  if (!source.id || !source.digest) throw fail('TEAM_TEMPLATE_ROLE_SOURCE_INVALID', `角色「${role?.name || 'unknown'}」模板必须锁定 id、version 和 digest`);
  const id = requiredText(source.id, '角色模板 ID', 256);
  // The current public Team catalog pins each role with its own id/digest and
  // pins the containing Team with a version, but older imported rows omitted
  // the redundant per-role version.  Normalize that compatible shape to the
  // immutable Team version; the role digest remains the content lock.
  const version = requiredText(source.version || team.version, '角色模板版本', 64);
  const digest = requiredText(source.digest, '角色模板摘要', 256);
  if (!semver.test(version)) throw fail('TEAM_TEMPLATE_ROLE_SOURCE_INVALID', `角色「${role?.name || id}」模板版本无效`);
  return { id, version, digest, ...(source.catalogId || team.catalogId ? { catalogId: source.catalogId || team.catalogId } : {}) };
}

export function validateTeamTemplate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || input.kind !== 'team') throw fail('TEAM_TEMPLATE_INVALID', '专家团模板类型无效');
  const id = requiredText(input.id, '专家团模板 ID', 128);
  if (!/^[a-z][a-z0-9-]*$/.test(id) || !semver.test(String(input.version || ''))) throw fail('TEAM_TEMPLATE_INVALID', '专家团模板 ID 或版本无效');
  requiredText(input.name, '专家团模板名称', 120);
  requiredText(input.instructions, '专家团模板协作指令', 16000);
  const roles = Array.isArray(input.roles) ? input.roles : [];
  if (roles.length < 2 || roles.length > 9 || roles[0]?.name !== 'lead') throw fail('TEAM_TEMPLATE_ROLE_INVALID', '专家团模板必须包含 lead 和至少一位成员');
  const names = new Set();
  const normalizedRoles = roles.map((role, index) => {
    const name = requiredText(role?.name, '团队角色标识', 64);
    if ((index > 0 && (name === 'lead' || !roleName.test(name))) || names.has(name)) throw fail('TEAM_TEMPLATE_ROLE_INVALID', `团队角色标识无效或重复：${name}`);
    names.add(name);
    const label = requiredText(role?.label || name, '团队角色名称', 80);
    const instructions = String(role?.instructions || '').trim();
    if (instructions.length > 8000) throw fail('TEAM_TEMPLATE_ROLE_INVALID', `角色「${name}」职责过长`);
    return { ...role, name, label, instructions, template: sourceRef(role, input) };
  });
  return {
    ...input,
    contract: input.contract || TEAM_TEMPLATE_CONTRACT,
    id,
    version: String(input.version),
    roles: normalizedRoles,
  };
}

export function validateTeamRoleSpec(spec, roleNameValue) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw fail('TEAM_TEMPLATE_ROLE_SPEC_INVALID', `角色「${roleNameValue}」蓝图无效`);
  const runtime = String(spec.runtime?.type || '').trim();
  if (!supportedRuntimes.has(runtime)) throw fail('TEAM_TEMPLATE_RUNTIME_UNSUPPORTED', `角色「${roleNameValue}」必须使用 DSH Native 或 Harness`);
  if (spec.subAgents || spec.sub_agents) throw fail('TEAM_TEMPLATE_NESTED_TEAM_UNSUPPORTED', `角色「${roleNameValue}」不能再声明普通 subagent`);
  if (!spec.instructions || typeof spec.instructions.system !== 'string' || !spec.instructions.system.trim()) {
    throw fail('TEAM_TEMPLATE_ROLE_SPEC_INVALID', `角色「${roleNameValue}」缺少系统指令`);
  }
  if (!spec.bindings || typeof spec.bindings !== 'object' || Array.isArray(spec.bindings)) throw fail('TEAM_TEMPLATE_ROLE_SPEC_INVALID', `角色「${roleNameValue}」资源绑定无效`);
  return spec;
}
