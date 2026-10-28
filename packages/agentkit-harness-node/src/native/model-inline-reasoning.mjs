// Versioned projection from ksadk.model_proxy.compat. Policy belongs to the
// admitted Run; neither recovery nor individual requests read process.env.
const rules = new Set(['permissive', 'openai', 'strict-openai', 'cerebras', 'groq',
  'deepseek', 'zai', 'kspmas-gateway', 'moonshot', 'mimo']);
const urlHints = [['kspmas', 'kspmas-gateway'], ['cerebras', 'cerebras'], ['groq', 'groq'],
  ['deepseek', 'deepseek'], ['zai', 'zai'], ['bigmodel', 'zai'], ['glm', 'zai'],
  ['moonshot', 'moonshot'], ['api.kimi.com', 'moonshot'], ['openai.com', 'openai']];
const modelHints = [['deepseek', 'deepseek'], ['glm', 'zai'], ['zai', 'zai'],
  ['bigmodel', 'zai'], ['mimo', 'mimo'], ['gpt-', 'openai']];
const normalizeModel = value => String(value ?? '').toLowerCase().replaceAll('_', '-');
// Python str.lstrip includes NEL/information separators and excludes BOM.
const pythonLeftSpace = /^[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]*/u;
const startsThinking = text => text.replace(pythonLeftSpace, '').startsWith('<think>');

export function admitInlineReasoningPolicy(override) {
  const rule = typeof override === 'string' ? override.trim() : '';
  return { contract: 'profiled-content/v1', rule: rule ? (rules.has(rule) ? rule : 'permissive') : 'auto' };
}

export function inlineReasoningMarker(policy, binding = {}) {
  if (!policy) return null; // Preserve existing admitted Runs byte for byte.
  if (policy.contract !== 'profiled-content/v1' || (policy.rule !== 'auto' && !rules.has(policy.rule))) {
    throw new Error('invalid_inline_reasoning_policy');
  }
  const rule = resolveCompatibilityRule(policy.rule, binding);
  if (['kspmas-gateway', 'moonshot'].includes(rule)
    && ['kimi-k2.7-code', 'kimi-k2.7-code-highspeed'].includes(String(binding.model ?? '').trim().toLowerCase())) return null;
  return ['zai', 'kspmas-gateway'].includes(rule) ? '</think>' : null;
}

export function resolveCompatibilityRule(selected, binding = {}) {
  if (selected !== 'auto' && !rules.has(selected)) throw new Error('invalid_provider_compatibility_policy');
  const model = normalizeModel(binding.model), url = String(binding.baseUrl ?? '').toLowerCase();
  return selected === 'auto'
    ? urlHints.find(([hint]) => url.includes(hint))?.[1]
      ?? modelHints.find(([hint]) => model.includes(hint))?.[1] ?? 'permissive'
    : selected;
}

export function projectInlineReasoning(text, marker) {
  if (!marker) return text;
  const index = text.lastIndexOf(marker);
  return index >= 0 ? text.slice(index + marker.length) : startsThinking(text) ? '' : text;
}

export function createInlineReasoningProjector(marker) {
  let pending = '', released = !marker;
  return {
    push(text) {
      if (released) return text;
      pending += text;
      const index = pending.lastIndexOf(marker);
      if (index < 0) return '';
      const visible = pending.slice(index + marker.length);
      pending = ''; released = true;
      return visible;
    },
    seal() {
      if (released) return '';
      const visible = startsThinking(pending) ? '' : pending;
      pending = ''; released = true;
      return visible;
    },
  };
}
