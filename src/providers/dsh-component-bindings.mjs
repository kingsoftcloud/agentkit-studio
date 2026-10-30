/** Public, revision-pinned resource facts. No credentials or endpoint settings. */
import { copy, invariant } from '@kingsoftcloud/agentkit-harness-core';
export const DSH_COMPONENT_BINDINGS = 'agentkit.dsh-component-bindings/v1';

export function dshComponentBindings(spec = {}) {
  const resources = (spec.bindings?.plugins ?? []).filter(plugin => plugin.enabled !== false)
    .map(plugin => plugin.config?.binding?.resource).filter(Boolean);
  return { contract: DSH_COMPONENT_BINDINGS,
    knowledgeBaseBound: resources.some(resource => resource.kind === 'knowledge-base'),
    longTermMemoryBound: spec.memory?.enabled !== false && resources.some(resource => resource.kind === 'memory-instance'),
    skillSpaceIds: [...new Set(resources.filter(resource => resource.kind === 'skill-space')
      .map(resource => resource.id || resource.resourceId).filter(id => typeof id === 'string' && id))].sort() };
}

export function readDshComponentBindings(value = dshComponentBindings()) {
  invariant(value && value.contract === DSH_COMPONENT_BINDINGS
    && Object.keys(value).every(key => ['contract', 'knowledgeBaseBound', 'longTermMemoryBound', 'skillSpaceIds'].includes(key))
    && typeof value.knowledgeBaseBound === 'boolean' && typeof value.longTermMemoryBound === 'boolean'
    && Array.isArray(value.skillSpaceIds) && value.skillSpaceIds.length <= 4096
    && value.skillSpaceIds.every(id => typeof id === 'string' && id.length > 0 && id.length <= 8192),
  'dsh_component_bindings_invalid');
  return copy(value);
}
