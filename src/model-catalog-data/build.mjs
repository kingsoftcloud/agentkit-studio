/** Shared models.dev → capability-catalog compaction, used by the build script
 * and by the Host's background refresh. */

// models.dev uses 99999999 as an "unlimited / unpublished" sentinel.
const UNLIMITED = 99_999_999;
const capacity = value => (Number.isSafeInteger(value) && value > 0 && value < UNLIMITED ? value : undefined);
const isHttp = value => typeof value === 'string' && /^https?:\/\//.test(value);

/**
 * Compact models.dev's api.json into only the fields Studio needs: per-model
 * reasoning levels, capacities and modalities, plus each provider's display
 * name and fixed endpoint. Models that carry none of those are dropped.
 */
export function buildCapabilityCatalog(api) {
  const catalog = {};
  for (const [key, block] of Object.entries(api ?? {})) {
    const models = block?.models;
    if (!models || typeof models !== 'object') continue;
    const providerId = typeof block.id === 'string' ? block.id : key;
    const group = {
      ...(block.name ? { name: block.name } : {}),
      // A templated endpoint (https://api.{region}…) is not matchable; keep only fixed ones.
      ...(isHttp(block.api) && !block.api.includes('{') ? { api: block.api.replace(/\/$/, '') } : {}),
      models: {},
    };
    for (const [id, m] of Object.entries(models)) {
      if (!m || typeof m !== 'object') continue;
      const efforts = [];
      let toggle = false;
      for (const option of m.reasoning_options || []) {
        if (option?.type === 'toggle') toggle = true;
        if (option?.type === 'effort' && Array.isArray(option.values)) {
          for (const value of option.values) if (typeof value === 'string' && value) efforts.push(value);
        }
      }
      const context = capacity(m.limit?.context);
      const output = capacity(m.limit?.output);
      const image = Array.isArray(m.modalities?.input) && m.modalities.input.includes('image');
      const reasoning = m.reasoning === true && (toggle || efforts.length > 0);
      // Keep only models that tell us something Studio cannot infer on its own.
      if (!reasoning && context === undefined && output === undefined && !image) continue;
      group.models[id] = {
        ...(m.name && m.name !== id ? { name: m.name } : {}),
        ...(context !== undefined ? { context } : {}),
        ...(output !== undefined ? { output } : {}),
        ...(reasoning && efforts.length ? { efforts: [...new Set(efforts)] } : {}),
        ...(reasoning && toggle ? { toggle: true } : {}),
        ...(image ? { image: true } : {}),
      };
    }
    if (Object.keys(group.models).length) catalog[providerId] = group;
  }
  return catalog;
}
