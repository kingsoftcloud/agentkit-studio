import { modelReasoningConfig, STUDIO_REASONING_LEVELS } from './model-reasoning.mjs';

export function catalogReasoningMetadata(item) {
  const declared = item.reasoning_efforts ?? item.reasoningEfforts;
  const list = Array.isArray(declared) ? declared : item.effort?.supported_levels
    ?? declared?.valid_efforts ?? item.think_efforts?.valid_efforts ?? item.reasoning?.supported_efforts;
  const disabled = declared === false || declared?.support === false
    || item.supports_reasoning_effort === false || item.think_efforts?.support === false;
  const mapped = STUDIO_REASONING_LEVELS.filter(level => declared?.[level] === true
    || (typeof declared?.[level] === 'string' && declared[level].trim()));
  const levels = disabled ? [] : Array.isArray(list) ? list : mapped.length ? mapped : undefined;
  const preferred = item.default_reasoning_effort ?? item.defaultReasoningEffort ?? item.effort?.default_level
    ?? declared?.default_effort ?? item.think_efforts?.default_effort ?? item.reasoning?.default_effort;
  return {
    ...(levels ? { reasoningLevels: STUDIO_REASONING_LEVELS.filter(level => levels.includes(level)) } : {}),
    ...(STUDIO_REASONING_LEVELS.includes(preferred) ? { defaultReasoningEffort: preferred } : {}),
  };
}

export function importedModelReasoning(item, connection) {
  const { reasoningLevels = [] } = item;
  return modelReasoningConfig({
    provider: connection.provider, reasoningLevels,
    reasoningEfforts: Boolean(reasoningLevels.length),
    defaultReasoningEffort: item.defaultReasoningEffort,
  });
}
