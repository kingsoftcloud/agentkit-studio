/**
 * Synchronous lookup over the bundled models.dev capability catalog.
 *
 * Why a static catalog instead of only asking the gateway: providers such as
 * Kimi and GLM do not return reasoning levels, context windows or modalities
 * from `/models`, so Studio used to fall back to a generic low/high pair and a
 * 128000 window for every model. The catalog supplies the real values.
 *
 * Matching is endpoint → provider id → model family → global model id. The
 * family step is what makes private gateways (e.g. the internal Star gateway,
 * which models.dev does not list) work: `glm-…` is resolved against Zhipu's own
 * entries, `kimi-…` against Moonshot's, and so on. Reseller/aggregate gateways
 * (opencode, openrouter, …) often list the same model id with different, smaller
 * capacities, so entries are never merged across providers — a miss returns
 * null and the caller keeps its existing fallback rather than a wrong answer.
 */
import { MODEL_CATALOG as BUNDLED_CATALOG } from './model-catalog-data/catalog.mjs';
import { STUDIO_REASONING_LEVELS } from './model-reasoning.mjs';

const normalizeEndpoint = value => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    return (url.host + url.pathname).replace(/\/+$/, '').toLowerCase();
  } catch { return raw.replace(/\/+$/, '').toLowerCase(); }
};
const normalizeId = id => String(id || '').trim().toLowerCase()
  .replace(/-latest$/, '')
  // deepseek-v4.1-flash-1017 / gpt-4o-20240806 are build/dated variants of a
  // catalogued model; drop a trailing 4–8 digit build or date suffix.
  .replace(/-\d{4,8}$/, '');

const effortsFor = entry => (entry?.efforts ? STUDIO_REASONING_LEVELS.filter(level => entry.efforts.includes(level)) : []);

// Same-family minor versions: deepseek-v4.1-flash is the v4 line's minor
// release and shares its facts with deepseek-v4-flash. Only ever used as a
// single, unambiguous hit inside one provider, never to collapse distinct models.
const stripPatch = id => normalizeId(id).replace(/(\d+)\.\d+/g, '$1');

const findInGroup = (group, modelName) => {
  const want = normalizeId(modelName);
  if (!want || !group?.models) return undefined;
  for (const [id, entry] of Object.entries(group.models)) {
    if (normalizeId(id) === want) return entry;
  }
  // Same-family minor-version fallback, only when unambiguous within this provider.
  const wantStem = stripPatch(want);
  const hits = Object.entries(group.models).filter(([id]) => stripPatch(id) === wantStem);
  return hits.length === 1 ? hits[0][1] : undefined;
};

/** Model-id prefix → the original vendor's catalog ids, in preference order. */
const MODEL_ORIGINS = [
  [/^glm-/, ['zhipuai', 'zai']],
  [/^kimi-/, ['moonshotai-cn', 'moonshotai']],
  [/^deepseek-/, ['deepseek']],
  [/^gpt-|^o[1-9]|^chatgpt-/, ['openai']],
  [/^claude-/, ['anthropic']],
  [/^gemini-/, ['google']],
  [/^grok-/, ['xai']],
  [/^qwen-|^qwq-/, ['alibaba-cn', 'alibaba']],
  [/^minimax-/, ['minimax-cn', 'minimax']],
];

let catalog = BUNDLED_CATALOG;
let endpointIndex = new Map();
const rebuildEndpointIndex = () => {
  endpointIndex = new Map();
  for (const [providerId, group] of Object.entries(catalog)) {
    if (!group.api) continue;
    const key = normalizeEndpoint(group.api);
    if (key && !endpointIndex.has(key)) endpointIndex.set(key, providerId);
  }
};
rebuildEndpointIndex();

/** Replace the catalog at runtime (after a Host refresh of models.dev). */
export function setModelCapabilityCatalog(next) {
  if (!next || typeof next !== 'object' || Array.isArray(next)) return;
  catalog = next;
  rebuildEndpointIndex();
}
export function currentModelCapabilityCatalog() { return catalog; }

const shape = (providerId, group, entry) => ({
  providerId, providerName: group.name, efforts: effortsFor(entry),
  toggle: entry.toggle === true, context: entry.context, output: entry.output, image: entry.image === true,
});

/**
 * Look up one model's capabilities. Returns null when the catalog does not
 * describe the model, so callers keep their existing fallback behaviour.
 * @param {{baseUrl?: string, provider?: string, modelName?: string}} target
 * @returns {{providerId: string, providerName?: string, efforts: string[], toggle: boolean,
 *   context?: number, output?: number, image: boolean} | null}
 */
export function lookupModelCapabilities({ baseUrl, provider, modelName } = {}) {
  const endpointHit = endpointIndex.get(normalizeEndpoint(baseUrl));
  if (endpointHit) {
    const entry = findInGroup(catalog[endpointHit], modelName);
    if (entry) return shape(endpointHit, catalog[endpointHit], entry);
  }
  const providerKey = String(provider || '').trim();
  if (providerKey && catalog[providerKey]) {
    const entry = findInGroup(catalog[providerKey], modelName);
    if (entry) return shape(providerKey, catalog[providerKey], entry);
  }
  const id = normalizeId(modelName);
  for (const [pattern, origins] of MODEL_ORIGINS) {
    if (!pattern.test(id)) continue;
    for (const originId of origins) {
      const group = catalog[originId];
      if (!group) continue;
      const entry = findInGroup(group, modelName);
      if (entry) return shape(originId, group, entry);
    }
    // The family is known but the vendor does not list this exact model: do
    // not guess from resellers.
    return null;
  }
  // Unknown family: only an unambiguous global hit is trusted.
  const hits = [];
  for (const [groupId, group] of Object.entries(catalog)) {
    const entry = findInGroup(group, modelName);
    if (entry) hits.push({ groupId, group, entry });
  }
  return hits.length === 1 ? shape(hits[0].groupId, hits[0].group, hits[0].entry) : null;
}
