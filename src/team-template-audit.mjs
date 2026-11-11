import { validateTeamRoleSpec, validateTeamTemplate } from './team-template-contract.mjs';

const placeholderModel = value => ['one-team-model'].includes(String(value || '').trim());

function unwrap(value) {
  return value?.item && typeof value.item === 'object' ? value.item : value;
}

function definitionFor(definitions, id) {
  if (!definitions) return undefined;
  const candidates = [`agent/${id}`, id];
  if (definitions instanceof Map) {
    for (const key of candidates) if (definitions.has(key)) return unwrap(definitions.get(key));
    return undefined;
  }
  for (const key of candidates) if (definitions[key]) return unwrap(definitions[key]);
  return undefined;
}

function modelFields(value, path = '$', result = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => modelFields(item, `${path}[${index}]`, result));
    return result;
  }
  if (!value || typeof value !== 'object') return result;
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (/model/i.test(key) && (typeof child === 'string' || Array.isArray(child))) {
      const values = Array.isArray(child) ? child : [child];
      for (const item of values) if (placeholderModel(item)) result.push({ path: childPath, value: item });
    }
    modelFields(child, childPath, result);
  }
  return result;
}

/**
 * Audit a complete Studio Team catalog before it is published to Server/KS3.
 * The function accepts listing items and, when available, the immutable Agent
 * definitions referenced by Team roles. It never mutates the input.
 */
export function auditTeamTemplateCatalog({ items = [], definitions, requireRoleDefinitions = false } = {}) {
  const errors = [];
  const warnings = [];
  const teams = Array.isArray(items) ? items.filter(item => item?.kind === 'team') : [];
  const issue = (severity, code, message, path) => (severity === 'error' ? errors : warnings).push({ code, message, ...(path ? { path } : {}) });

  for (const item of teams) {
    let team;
    try {
      team = validateTeamTemplate(item);
    } catch (error) {
      issue('error', error.code || 'TEAM_TEMPLATE_INVALID', error.message, item.id);
      continue;
    }
    for (const match of modelFields(team, item.id)) issue('error', 'TEAM_TEMPLATE_PLACEHOLDER_MODEL', `模板仍使用占位模型 ${match.value}`, match.path);
    for (const role of team.roles) {
      const roleDefinition = definitionFor(definitions, role.template.id);
      if (!roleDefinition) {
        issue(requireRoleDefinitions ? 'error' : 'warning', 'TEAM_ROLE_DEFINITION_MISSING', `未找到角色模板 ${role.template.id}`, `${item.id}.${role.name}`);
        continue;
      }
      if (roleDefinition.kind !== 'agent') issue('error', 'TEAM_ROLE_DEFINITION_KIND_INVALID', `角色模板 ${role.template.id} 必须是 Agent 定义`, `${item.id}.${role.name}`);
      if (roleDefinition.teamRoleOnly !== true) issue('error', 'TEAM_ROLE_NOT_TEAM_ONLY', `角色模板 ${role.template.id} 必须标记 teamRoleOnly=true`, `${item.id}.${role.name}`);
      try {
        validateTeamRoleSpec(roleDefinition.spec, role.name);
      } catch (error) {
        issue('error', error.code || 'TEAM_TEMPLATE_ROLE_SPEC_INVALID', error.message, `${item.id}.${role.name}`);
      }
      for (const match of modelFields(roleDefinition, `${item.id}.${role.name}`)) issue('error', 'TEAM_TEMPLATE_PLACEHOLDER_MODEL', `角色仍使用占位模型 ${match.value}`, match.path);
    }
  }
  if (!teams.length) warnings.push({ code: 'TEAM_TEMPLATE_NONE', message: '目录中没有 kind=team 的专家团模板' });
  return { ok: errors.length === 0, teamCount: teams.length, errors, warnings };
}

