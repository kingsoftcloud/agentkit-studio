/** A2A 1.0 AgentCard builder with opt-in public tool activity extension.
 *
 * Ported from ksadk/a2a_card.py:build_agent_card (lines 22-93) +
 * ksadk/a2a/card.py:build_agent_card (lines 8-20) @355059d.
 *
 * Produces a JSON-safe, camelCase AgentCard object. No external dependencies.
 */

export const A2A_PROTOCOL_VERSION = '1.0';
export const JSONRPC_PATH = '/a2a/jsonrpc';
export const REST_PATH_PREFIX = '/a2a/v1';
const TOOL_ACTIVITY_EXTENSION_URI = 'urn:ksadk:a2a:tool-activity:v1';
const FAIL = 'A2A_AGENT_CARD_INVALID';
const DEFAULT_IO_MODES = ['text/plain'];

function fail() { const e = new Error(FAIL); e.code = FAIL; return e; }

function isNonEmptyString(value, max = 256) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

/** Deep clone a JSON-safe value (no functions, symbols, circular refs). */
function deepClone(value, parents = new Set(), omitUndefined = false) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (!value || typeof value !== 'object' || parents.has(value) || Object.getOwnPropertySymbols(value).length) throw fail();
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw fail();
  parents.add(value);
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value), entries = [];
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (Array.isArray(value) && key === 'length') continue;
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw fail();
      if (omitUndefined && descriptor.value === undefined) continue;
      entries.push([key, deepClone(descriptor.value, parents)]);
    }
    if (Array.isArray(value)) {
      if (entries.length !== value.length || entries.some(([key], index) => key !== String(index))) throw fail();
      return entries.map(([, item]) => item);
    }
    return Object.fromEntries(entries);
  } finally { parents.delete(value); }
}

/** Python str.title(): uppercase first char of each word, lowercase rest.
 *  "HELLO_WORLD" → "Hello World" (not "HELLO WORLD"). */
function pythonTitle(str) {
  let previousCased = false, result = '';
  for (const character of str.replace(/_/gu, ' ')) {
    const cased = character.toUpperCase() !== character.toLowerCase();
    const upper = character.toUpperCase();
    result += previousCased ? character.toLowerCase() : upper[0] + upper.slice(1).toLowerCase();
    previousCased = cased;
  }
  return result;
}

/** Validate a base URL: must be http(s), no query/hash/credentials. */
function validateBaseUrl(baseUrl) {
  if (typeof baseUrl !== 'string' || !/^https?:\/\//u.test(baseUrl) || /[\s?#]/u.test(baseUrl)) throw fail();
  let url;
  try { url = new URL(baseUrl); }
  catch { throw fail(); }
  if (!['http:', 'https:'].includes(url.protocol)) throw fail();
  if (url.username || url.password) throw fail();
  if (url.search || url.hash) throw fail();
  if (url.pathname.includes('?') || url.pathname.includes('#')) throw fail();
  return url;
}

/** Validate an optional string array field (e.g. tags, examples, inputModes). */
function validateOptionalStringArray(value, maxLen = Infinity) {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw fail();
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim() || item.length > maxLen) throw fail();
  }
  return [...value];
}

/** Build a single AgentSkill from a string or object.
 *  Object skills: deep-clone ALL fields, validate required id/name/description/tags
 *  and optional arrays (examples, inputModes, outputModes). */
function buildSkill(skill) {
  if (skill && typeof skill === 'object' && !Array.isArray(skill)) {
    if (!isNonEmptyString(skill.id, 256)) throw fail();
    if (!isNonEmptyString(skill.name, 256)) throw fail();
    if (skill.description !== undefined && typeof skill.description !== 'string') throw fail();
    if (skill.tags !== undefined && skill.tags !== null) validateOptionalStringArray(skill.tags);
    if (skill.examples !== undefined && skill.examples !== null) validateOptionalStringArray(skill.examples);
    if (skill.inputModes !== undefined && skill.inputModes !== null) validateOptionalStringArray(skill.inputModes);
    if (skill.outputModes !== undefined && skill.outputModes !== null) validateOptionalStringArray(skill.outputModes);
    // Deep clone ALL provided fields to preserve unknown extensions and isolate mutation
    const result = deepClone(skill);
    result.id = skill.id.trim();
    result.name = skill.name.trim();
    return result;
  }
  if (typeof skill !== 'string' || !skill.trim()) throw fail();
  const skillId = skill.trim();
  return {
    id: skillId,
    name: pythonTitle(skillId),
    description: `Skill: ${skillId}`,
    tags: [skillId],
  };
}

/** Build the skills array: default general skill if empty. */
function buildSkills(skills) {
  if (!skills || (Array.isArray(skills) && skills.length === 0)) {
    return [{ id: 'general', name: 'General', description: 'General purpose agent powered by ksadk', tags: ['general'] }];
  }
  if (!Array.isArray(skills)) throw fail();
  const result = [];
  const seen = new Set();
  for (const skill of skills) {
    const built = buildSkill(skill);
    if (seen.has(built.id)) throw fail();
    seen.add(built.id);
    result.push(built);
  }
  return result;
}

/**
 * buildA2aAgentCard({ name, baseUrl, description, version, skills, streaming, provider, publicToolNames })
 *
 * Returns a JSON-safe, camelCase A2A 1.0 AgentCard object.
 */
export function buildA2aAgentCard(options) {
  try { return buildCard(deepClone(options, new Set(), true)); } catch { throw fail(); }
}
function buildCard(options) {
  // Reject non-object input (including null, undefined, primitives)
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw fail();

  const { name, baseUrl, description = '', version = '1.0.0', skills = [], streaming = true, provider, publicToolNames = [] } = options;

  if (!isNonEmptyString(name, 256)) throw fail();
  const url = validateBaseUrl(baseUrl);
  const base = url.href.replace(/\/+$/u, '');
  if (typeof description !== 'string') throw fail();
  const desc = description.trim() || `${name} agent powered by ksadk`;
  if (!isNonEmptyString(version, 128)) throw fail();
  if (typeof streaming !== 'boolean') throw fail();

  let providerObj = undefined;
  if (provider !== undefined && provider !== null) {
    if (typeof provider !== 'object' || Array.isArray(provider)) throw fail();
    const org = typeof provider.organization === 'string' ? provider.organization : '';
    const purl = typeof provider.url === 'string' ? provider.url : '';
    if (org.length > 256 || purl.length > 256) throw fail();
    providerObj = { organization: org, url: purl };
  }

  if (!Array.isArray(publicToolNames)) throw fail();
  for (const tn of publicToolNames) {
    if (typeof tn !== 'string' || !tn.trim() || tn.length > 256) throw fail();
  }

  const supportedInterfaces = [
    { url: `${base}${JSONRPC_PATH}`, protocolBinding: 'JSONRPC', protocolVersion: A2A_PROTOCOL_VERSION },
    { url: `${base}${REST_PATH_PREFIX}`, protocolBinding: 'HTTP+JSON', protocolVersion: A2A_PROTOCOL_VERSION },
  ];

  const capabilities = { streaming, pushNotifications: false };
  if (publicToolNames.length > 0) {
    capabilities.extensions = [
      { uri: TOOL_ACTIVITY_EXTENSION_URI, description: 'Explicitly allowlisted public tool observations', required: false },
    ];
  }

  const card = {
    name: name.trim(),
    description: desc,
    version: version.trim(),
    supportedInterfaces,
    capabilities,
    defaultInputModes: [...DEFAULT_IO_MODES],
    defaultOutputModes: [...DEFAULT_IO_MODES],
    skills: buildSkills(skills),
  };

  if (providerObj) card.provider = providerObj;
  return Object.freeze(card);
}
