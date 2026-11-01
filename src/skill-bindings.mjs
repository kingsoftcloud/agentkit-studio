import { checkedResource } from './resource-checks.mjs';

const invalid = () => Object.assign(new Error('Invalid bound Skill resource'), { code: 'SKILL_BINDING_INVALID' });

/** Preserve every explicit binding in order, loading repeated IDs only once.
 * This is admission, never discovery of unbound Skills. */
export function boundSkillResources(bindings = {}) {
  const resources = [], seen = new Set();
  const add = (kind, id) => {
    if (typeof id !== 'string' || !id.trim() || id !== id.trim()) throw invalid();
    if (!seen.has(id)) { seen.add(id); resources.push({ kind, resourceId: id }); }
  };
  for (const key of ['skills', 'plugins']) {
    if (bindings[key] !== undefined && !Array.isArray(bindings[key])) throw invalid();
  }
  for (const item of bindings.skills || []) {
    if (item?.enabled === false) continue;
    add('skill', typeof item === 'string' ? item : item?.resourceId || item?.id);
  }
  for (const plugin of bindings.plugins || []) {
    if (plugin?.enabled === false) continue;
    const resource = plugin?.config?.binding?.resource;
    if (resource?.kind === 'skill-space') add('skill-space', resource.id || resource.resourceId);
  }
  return resources;
}

export async function loadBoundSkills(bindings, adapter, { agent, onResource } = {}) {
  const resources = boundSkillResources(bindings);
  if (resources.length && typeof adapter?.loadSkill !== 'function')
    throw Object.assign(new Error('Bound Skill adapter is unavailable'), { code: 'RESOURCE_ADAPTER_MISSING' });
  return Promise.all(resources.map(async resource => ({ ...resource,
    value: await checkedResource({ ...resource, action: 'load', agent, onResource }, () => adapter.loadSkill(resource.resourceId)),
  })));
}

export async function loadBoundSkillDefinitions(bindings, adapter) {
  return (await loadBoundSkills(bindings, adapter)).flatMap(({ value }) => value?.definitions || []);
}
