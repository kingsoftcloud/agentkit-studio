/** Shared managed resource references. Credential resolution stays in the Host. */
import { platformBinding } from './platform-resource-bindings.mjs';

export const MANAGED_RESOURCE_CONTRACT = 'agentengine.resources/v1';
const fields = new Set(['knowledge_base', 'memory', 'skill_space', 'skill_spaces', 'mcp_servers']);
const mapping = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = () => { throw Object.assign(new Error('Invalid managed resource references'), { code: 'MANAGED_RESOURCE_INVALID' }); };
const blockedHeaders = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'accept', 'content-type', 'mcp-protocol-version', 'mcp-session-id', '__proto__', 'constructor', 'prototype']);

function directMcp(item) {
  if (Object.keys(item).some(key => !['id', 'endpoint', 'transport', 'env_refs'].includes(key))) fail();
  if (typeof item.endpoint !== 'string' || item.endpoint.length > 2048 || !/^[\x21-\x7e]+$/.test(item.endpoint)
    || !/^https?:\/\/[^/]/.test(item.endpoint) || /[\\?#]/.test(item.endpoint)) fail();
  let endpoint;
  try { endpoint = new URL(item.endpoint); } catch { fail(); }
  if (!endpoint.hostname || !/^[A-Za-z0-9_.:[\]-]+$/.test(endpoint.hostname) || endpoint.username || endpoint.password || endpoint.port === '0') fail();
  if (Object.hasOwn(item, 'transport') && !['http', 'sse'].includes(item.transport)) fail();
  if (!Object.hasOwn(item, 'env_refs')) return;
  if (!mapping(item.env_refs) || Object.keys(item.env_refs).length > 16) fail();
  const names = new Set();
  for (const [header, name] of Object.entries(item.env_refs)) {
    const key = header.toLowerCase();
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(header) || blockedHeaders.has(key) || names.has(key)) fail();
    // Only caller-supplied MCP credentials; never expose platform/model keys.
    // The existing API also recognizes these names as sensitive variables.
    if (typeof name !== 'string' || !/^MCP_[A-Z0-9_]{1,124}$/.test(name) || !/(KEY|TOKEN|SECRET|PASSWORD)/.test(name)) fail();
    names.add(key);
  }
}

export function validateManagedResources(value) {
  function reference(item) {
    if (!mapping(item) || !Object.hasOwn(item, 'id') || Object.keys(item).some(key => !['id', 'region'].includes(key))) fail();
    if (typeof item.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(item.id)) fail();
    if (Object.hasOwn(item, 'region') && (typeof item.region !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(item.region))) fail();
  }
  if (!mapping(value) || Object.keys(value).some(key => !fields.has(key))) fail();
  if (Object.hasOwn(value, 'skill_space') && Object.hasOwn(value, 'skill_spaces')) fail();
  for (const [key, item] of Object.entries(value)) {
    if (!['mcp_servers', 'skill_spaces'].includes(key)) { reference(item); continue; }
    if (!Array.isArray(item) || item.length > 16) fail();
    const ids = new Set();
    for (const binding of item) {
      if (key === 'mcp_servers' && mapping(binding) && Object.hasOwn(binding, 'endpoint')) {
        reference({ id: binding.id });
        directMcp(binding);
      } else reference(binding);
      if (ids.has(binding.id)) fail();
      ids.add(binding.id);
    }
  }
  return structuredClone(value);
}

export function managedResourceBindings(resources) {
  if (resources === undefined) return {};
  const refs = validateManagedResources(resources);
  const plugins = [];
  const entries = [['knowledge-base', refs.knowledge_base], ['memory-instance', refs.memory],
    ...(refs.skill_space ? [['skill-space', refs.skill_space]] : (refs.skill_spaces || []).map(ref => ['skill-space', ref]))];
  for (const [kind, ref] of entries) {
    if (!ref) continue;
    const binding = platformBinding(kind, ref.id, { items: [ref], connectionRef: 'agentengine-server',
      pluginRef: '@kingsoftcloud/agentkit-studio/platform-resources', componentId: kind, pluginSnapshotDigest: 'platform-resources-v1' });
    if (kind === 'skill-space' && refs.skill_spaces) binding.config.binding.id = `platform-skill-space-${ref.id}`;
    plugins.push(binding);
  }
  return { ...(plugins.length ? { plugins } : {}), ...(refs.mcp_servers?.length ? {
    mcpServers: refs.mcp_servers.map(({ id, endpoint, transport, env_refs, ...metadata }) => endpoint
      ? { resourceId: id, endpointUrl: endpoint, transport: transport || 'http', ...(env_refs ? { envRefs: env_refs } : {}) }
      : { resourceId: id, ...metadata }),
  } : {}) };
}

/** Only explicitly bound caller credentials may cross into a managed Host. */
export function managedResourceCredentialNames(resources) {
  if (resources === undefined) return [];
  const refs = validateManagedResources(resources);
  return [...new Set((refs.mcp_servers || []).flatMap(item => Object.values(item.env_refs || {})))].sort();
}
