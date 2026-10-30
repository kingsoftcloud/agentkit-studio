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

export function admitInlineReasoningPolicy(override, { contract = 'profiled-content/v2' } = {}) {
  if (!['profiled-content/v1', 'profiled-content/v2'].includes(contract)) throw new Error('invalid_inline_reasoning_policy');
  const rule = typeof override === 'string' ? override.trim() : '';
  return { contract, rule: rule ? (rules.has(rule) ? rule : 'permissive') : 'auto' };
}

export function inlineReasoningMarker(policy, binding = {}) {
  if (!policy) return null; // Preserve existing admitted Runs byte for byte.
  if (!['profiled-content/v1', 'profiled-content/v2'].includes(policy.contract) || (policy.rule !== 'auto' && !rules.has(policy.rule))) {
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

export function projectInlineReasoning(text, marker, policy) {
  if (!marker) return text;
  if (policy?.contract === 'profiled-content/v2') {
    const projector = createInlineReasoningProjector(marker, policy);
    return projector.push(text) + projector.seal();
  }
  const index = text.lastIndexOf(marker);
  return index >= 0 ? text.slice(index + marker.length) : startsThinking(text) ? '' : text;
}

export function createInlineReasoningProjector(marker, policy) {
  if (marker && policy?.contract === 'profiled-content/v2') return taggedPrefixProjector(marker);
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

/** Content and reasoning_content are separate wire channels. Only an explicit
 * leading reasoning tag changes the content channel's framing. Ordinary prose
 * is released as soon as its prefix is unambiguous; a closing tag quoted later
 * in prose is text, not permission to retract already-published content.
 * Once inside reasoning, retain at most a possible closing-tag suffix. */
function taggedPrefixProjector(marker) {
  const opening = '<think>';
  let phase = 'prefix', pending = '';
  return {
    push(text) {
      if (phase === 'text') return text;
      pending += text;
      if (phase === 'prefix') {
        const prefix = pending.replace(pythonLeftSpace, '');
        if (!prefix || opening.startsWith(prefix) || marker.startsWith(prefix)) return '';
        if (prefix.startsWith(opening)) {
          pending = prefix.slice(opening.length);phase = 'reasoning';
        } else if (prefix.startsWith(marker)) {
          const visible = prefix.slice(marker.length);pending = '';phase = 'text';return visible;
        } else {
          const visible = pending;pending = '';phase = 'text';return visible;
        }
      }
      const end = pending.indexOf(marker);
      if (end >= 0) {
        const visible = pending.slice(end + marker.length);pending = '';phase = 'text';return visible;
      }
      let suffix = Math.min(pending.length, marker.length - 1);
      while (suffix && !marker.startsWith(pending.slice(-suffix))) suffix--;
      pending = suffix ? pending.slice(-suffix) : '';
      return '';
    },
    seal() {
      // Incomplete tag prefixes and unfinished reasoning cannot become prose.
      const visible = phase === 'prefix' && !pending.replace(pythonLeftSpace, '') ? pending : '';
      pending = '';phase = 'text';return visible;
    },
  };
}
