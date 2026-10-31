import { copy, invariant } from './values.mjs';

type Source = 'profile' | 'catalog' | 'default';
export interface ModelCapabilities {
  contract: 'model-capabilities/v1';
  contextWindow: number; maxOutputTokens: number;
  contextSource: Source; outputSource: Source;
  advertisedContextWindow: number | null; advertisedMaxOutputTokens: number | null;
  input: ('text' | 'image')[]; inputSource: Source;
  catalogState: 'available' | 'not-listed' | 'unavailable';
}
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {};

/** Pure metadata decoding; no provider call and no inferred output maximum. */
export function modelTokenLimit(value: unknown): number | null {
  if (positive(value)) return value;
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*([km])?$/i);
  if (!match) return null;
  const tokens = Number(match[1]) * ({ k: 1024, m: 1048576 }[match[2]?.toLowerCase() ?? ''] ?? 1);
  return positive(tokens) ? tokens : null;
}
export function modelCatalogLimits(value: unknown): { contextWindow?: number; maxOutputTokens?: number } {
  const raw = object(value), provider = object(raw.top_provider);
  const first = (items: unknown[]) => items.map(modelTokenLimit).find(value => value !== null);
  const context = first([raw.contextWindow, raw.context_window, raw.context_length, raw.max_context_length, raw.max_input_tokens, provider.context_length]);
  const output = first([raw.maxOutputTokens, raw.max_output_tokens, raw.max_completion_tokens, raw.max_output_length, provider.max_completion_tokens]);
  return { ...(context ? { contextWindow: context } : {}), ...(output ? { maxOutputTokens: output } : {}) };
}

/** A configured budget can narrow advertised capacity. Defaults are operating
 * limits, not claims about an unreported model maximum. */
export function admitModelCapabilities(profile: { contextWindow?: number; maxOutputTokens?: number; input?: string[] },
  catalog?: { contextWindow?: number; maxOutputTokens?: number; input?: string[]; inputKnown?: boolean } | null,
  catalogState: ModelCapabilities['catalogState'] = catalog ? 'available' : 'unavailable'): ModelCapabilities {
  const limits = modelCatalogLimits(catalog);
  const context = profile.contextWindow ?? limits.contextWindow ?? 128000;
  const contextWindow = Math.min(context, limits.contextWindow ?? context);
  const requestedOutput = profile.maxOutputTokens ?? Math.min(limits.maxOutputTokens ?? 8192, Math.floor(contextWindow / 4));
  const maxOutputTokens = Math.min(requestedOutput, limits.maxOutputTokens ?? requestedOutput);
  const source = (configured: number | undefined, advertised: number | undefined, actual: number): Source =>
    configured !== undefined && configured === actual ? 'profile' : advertised !== undefined && advertised === actual ? 'catalog' : 'default';
  const knownInput = catalog && catalog.inputKnown !== false && Array.isArray(catalog.input);
  const modalities = knownInput ? catalog.input! : profile.input ?? ['text'];
  return validateModelCapabilities({ contract: 'model-capabilities/v1', contextWindow, maxOutputTokens,
    contextSource: source(profile.contextWindow, limits.contextWindow, contextWindow),
    outputSource: source(profile.maxOutputTokens, limits.maxOutputTokens, maxOutputTokens),
    advertisedContextWindow: limits.contextWindow ?? null, advertisedMaxOutputTokens: limits.maxOutputTokens ?? null,
    input: ['text', ...(modalities.includes('image') ? ['image' as const] : [])],
    inputSource: knownInput ? 'catalog' : profile.input ? 'profile' : 'default', catalogState });
}

export function validateModelCapabilities(value: unknown): ModelCapabilities {
  const fact = object(value);
  invariant(Object.keys(fact).sort().join(',') === ['contract','contextWindow','maxOutputTokens','contextSource','outputSource',
    'advertisedContextWindow','advertisedMaxOutputTokens','input','inputSource','catalogState'].sort().join(',')
    && fact.contract === 'model-capabilities/v1' && positive(fact.contextWindow) && positive(fact.maxOutputTokens)
    && fact.maxOutputTokens < fact.contextWindow
    && ['profile','catalog','default'].includes(String(fact.contextSource))
    && ['profile','catalog','default'].includes(String(fact.outputSource))
    && ['profile','catalog','default'].includes(String(fact.inputSource))
    && ['available','not-listed','unavailable'].includes(String(fact.catalogState))
    && Array.isArray(fact.input) && fact.input[0] === 'text'
    && (fact.input.length === 1 || fact.input.length === 2 && fact.input[1] === 'image')
    && (fact.advertisedContextWindow === null || positive(fact.advertisedContextWindow) && fact.contextWindow <= fact.advertisedContextWindow)
    && (fact.advertisedMaxOutputTokens === null || positive(fact.advertisedMaxOutputTokens) && fact.maxOutputTokens <= fact.advertisedMaxOutputTokens),
  'invalid_model_capabilities');
  return copy(value) as ModelCapabilities;
}
