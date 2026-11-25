import { modelReasoningConfig, STUDIO_REASONING_LEVELS } from './model-reasoning.mjs';
import { lookupModelCapabilities } from './model-capability-catalog.mjs';

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
  const declared = catalogReasoningMetadata(item);
  const catalog = lookupModelCapabilities({ baseUrl: connection.baseUrl, provider: connection.provider, modelName: item.id });
  // The gateway's own declaration wins; otherwise the models.dev catalog
  // supplies the levels. A catalog model that only toggles thinking gets no
  // selectable levels, instead of the old low/high fallback.
  const reasoningLevels = declared.reasoningLevels?.length ? declared.reasoningLevels
    : catalog?.efforts?.length ? catalog.efforts
    : catalog?.toggle ? []
    : item.reasoningLevels || [];
  const reasoningEfforts = reasoningLevels.length > 0;
  const defaultReasoningEffort = declared.defaultReasoningEffort
    || (reasoningLevels.includes('high') ? 'high' : reasoningLevels[reasoningLevels.length - 1]);
  return modelReasoningConfig({ provider: connection.provider, reasoningLevels, reasoningEfforts, defaultReasoningEffort });
}
