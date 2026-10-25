// Frozen Chat Completions request policy, ported from the pinned Python
// model_proxy.compat and transform.model-effort-map/v2. No IO or retries here.
import { admitInlineReasoningPolicy, resolveCompatibilityRule } from './model-inline-reasoning.mjs';
import { ProtocolError } from './model-normalize.mjs';

const strict = new Set(['openai', 'strict-openai', 'cerebras', 'groq']);
const requiredAuto = new Set(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1', 'claude-mythos-5-1']);
const mandatory = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5']);
const ranks = { none: 0, minimal: 1, low: 2, medium: 3, high: 4, xhigh: 5, max: 5 };
const normalized = model => String(model ?? '').trim().toLowerCase().replaceAll('_', '-');
const object = value => value && typeof value === 'object' && !Array.isArray(value);

export function admitProviderCompatibilityPolicy(override) {
  return { contract: 'provider-compat/v1', rule: admitInlineReasoningPolicy(override).rule };
}

export function resolveProviderCompatibility(policy, binding) {
  if (!policy) return null;
  if (policy.contract !== 'provider-compat/v1') throw new ProtocolError('invalid_provider_compatibility_policy');
  const rule = resolveCompatibilityRule(policy.rule, binding);
  const name = String(binding.model ?? '').trim().toLowerCase();
  const kimi = ['kspmas-gateway', 'moonshot'].includes(rule)
    && ['kimi-k2.7-code', 'kimi-k2.7-code-highspeed'].includes(name);
  const disabledEfforts = mandatory.has(name) ? [] : name === 'claude-haiku-5-5' ? ['low', 'medium', 'high'] : null;
  return { rule, supportsUsage: !strict.has(rule), supportsThinking: !strict.has(rule) && !kimi,
    supportsEffort: !kimi, toolThinkingOff: ['zai', 'kspmas-gateway'].includes(rule) && !kimi,
    thinkingBudget: rule === 'zai' && !kimi && !disabledEfforts ? 32000 : null,
    disabledEfforts, requiredAuto: kimi || requiredAuto.has(name),
    echo: kimi || ['deepseek', 'mimo'].includes(rule) ? 'preserve' : strict.has(rule) ? 'strip' : 'thinking',
    hints: kimi ? ['kimi-k2.7-code'] : { moonshot: ['kimi'], deepseek: ['deepseek'],
      zai: ['glm', 'zai', 'bigmodel'], 'kspmas-gateway': ['glm', 'deepseek'], mimo: ['mimo'] }[rule] ?? [] };
}

export function clampReasoningEffort(model, effort) {
  if (typeof effort !== 'string' || typeof model !== 'string') return effort;
  if (model.startsWith('glm-5.3-flash') && !['low', 'high', 'max'].includes(effort)) {
    const rank = ranks[effort];
    effort = rank === undefined ? 'low' : ['low', 'high', 'max'].find(value => ranks[value] >= rank) ?? 'max';
  }
  if (['qwen3.7', 'qwen3.6', 'qwen3.5'].some(prefix => model.startsWith(prefix)) && ranks[effort] > ranks.high) return 'high';
  return effort;
}

export function projectProviderToolChoice(choice, compat) {
  const named = object(choice) && Object.keys(choice).length === 2 && choice.type === 'function'
    && object(choice.function) && Object.keys(choice.function).length === 1
    && typeof choice.function.name === 'string' && choice.function.name.trim();
  return compat?.requiredAuto && (choice === 'required' || named) ? 'auto' : choice;
}

export function applyProviderChatCompatibility(payload, request, binding) {
  const compat = resolveProviderCompatibility(request.profile.providerCompatibilityPolicy, binding);
  if (!compat) return payload;
  const result = { ...payload }, options = request.profile;
  const model = binding.model, name = normalized(model);
  const requested = options.reasoningEffort ?? result.reasoning_effort ?? null;
  let effort = requested;
  if (requested === null && request.purpose === 'compaction' && compat.rule === 'kspmas-gateway'
    && ['glm-5.2', 'deepseek-v4-flash'].includes(name)) effort = 'none';
  effort = compat.supportsEffort ? clampReasoningEffort(model, effort) : null;
  if (effort !== null) result.reasoning_effort = effort;
  if (result.stream) result.stream_options = { ...(object(result.stream_options) ? result.stream_options : {}), include_usage: true };
  if (!compat.supportsUsage && object(result.stream_options)) {
    result.stream_options = { ...result.stream_options }; delete result.stream_options.include_usage;
    if (!Object.keys(result.stream_options).length) delete result.stream_options;
  }
  const mode = options.thinkingMode ?? result.thinking?.type;
  const mayDisable = compat.supportsThinking && (compat.disabledEfforts === null || compat.disabledEfforts.includes(effort));
  const summaryOff = request.purpose === 'compaction' && requested === null && compat.rule === 'kspmas-gateway' && name === 'glm-5.3-flash';
  const budget = result.max_completion_tokens ?? result.max_tokens;
  if (mode === 'enabled') {
    if (!compat.supportsThinking) throw new ProtocolError('model_thinking_mode_unsupported');
    result.thinking = { type: 'enabled' };
  } else if (mayDisable && (mode === 'disabled' || summaryOff
    || compat.toolThinkingOff && !!result.tools?.length && result.tool_choice !== 'none'
    || compat.thinkingBudget !== null && budget <= compat.thinkingBudget)) result.thinking = { type: 'disabled' };
  if (!compat.supportsThinking) delete result.thinking;
  if (!compat.supportsEffort) delete result.reasoning_effort;
  if (result.tool_choice !== undefined) result.tool_choice = projectProviderToolChoice(result.tool_choice, compat);
  if (compat.echo === 'strip' || compat.echo === 'thinking' && !compat.hints.some(hint => normalized(model).includes(hint))) {
    result.messages = result.messages.map(message => {
      if (message.role !== 'assistant') return message;
      const copy = { ...message }; delete copy.reasoning_content; return copy;
    });
  }
  return result;
}
