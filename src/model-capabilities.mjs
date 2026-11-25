/** Studio's implementation of the model-capabilities/v1 wire contract. */
const copy = value => JSON.parse(JSON.stringify(value));
const invariant = condition => {
  if (!condition) throw Object.assign(new Error('invalid_model_capabilities'), { code: 'invalid_model_capabilities' });
};
const positive = (value) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value : {};
/** Pure metadata decoding; no provider call and no inferred output maximum. */
export function modelTokenLimit(value) {
    if (positive(value))
        return value;
    if (typeof value !== 'string')
        return null;
    const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*([km])?$/i);
    if (!match)
        return null;
    const tokens = Number(match[1]) * ({ k: 1024, m: 1048576 }[match[2]?.toLowerCase() ?? ''] ?? 1);
    return positive(tokens) ? tokens : null;
}
export function modelCatalogLimits(value) {
    const raw = object(value), provider = object(raw.top_provider);
    const first = (items) => items.map(modelTokenLimit).find(value => value !== null);
    const context = first([raw.contextWindow, raw.context_window, raw.context_length, raw.max_context_length, raw.max_input_tokens, provider.context_length]);
    const output = first([raw.maxOutputTokens, raw.max_output_tokens, raw.max_completion_tokens, raw.max_output_length, provider.max_completion_tokens]);
    return { ...(context ? { contextWindow: context } : {}), ...(output ? { maxOutputTokens: output } : {}) };
}
/** A configured budget can narrow advertised capacity. Defaults are operating
 * limits, not claims about an unreported model maximum. */
export const DEFAULT_CONTEXT_WINDOW = 128000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 8192;
export function resolveModelBudgets(profile = {}, catalog) {
    const limits = modelCatalogLimits(catalog);
    const context = profile.contextWindow ?? limits.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
    const contextWindow = Math.min(context, limits.contextWindow ?? context);
    const requestedOutput = profile.maxOutputTokens ?? Math.min(limits.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS, Math.floor(contextWindow / 4));
    const capped = Math.min(requestedOutput, limits.maxOutputTokens ?? requestedOutput);
    // Several gateways (Kimi among them) advertise an output maximum equal to
    // the context window, and users can type either value. An output budget
    // cannot occupy the whole window, so clamp instead of rejecting the save.
    const maxOutputTokens = Math.max(1, Math.min(capped, Math.floor(contextWindow / 2)));
    const adjusted = maxOutputTokens !== requestedOutput;
    return { contextWindow, maxOutputTokens, adjusted,
        requestedOutput, advertisedMaxOutputTokens: limits.maxOutputTokens ?? null };
}
export function admitModelCapabilities(profile, catalog, catalogState = catalog ? 'available' : 'unavailable') {
    const limits = modelCatalogLimits(catalog);
    const { contextWindow, maxOutputTokens } = resolveModelBudgets(profile, catalog);
    const source = (configured, advertised, actual) => configured !== undefined && configured === actual ? 'profile' : advertised !== undefined && advertised === actual ? 'catalog' : 'default';
    const knownInput = catalog && catalog.inputKnown !== false && Array.isArray(catalog.input);
    const modalities = knownInput ? catalog.input : profile.input ?? ['text'];
    return validateModelCapabilities({ contract: 'model-capabilities/v1', contextWindow, maxOutputTokens,
        contextSource: source(profile.contextWindow, limits.contextWindow, contextWindow),
        outputSource: source(profile.maxOutputTokens, limits.maxOutputTokens, maxOutputTokens),
        advertisedContextWindow: limits.contextWindow ?? null, advertisedMaxOutputTokens: limits.maxOutputTokens ?? null,
        input: ['text', ...(modalities.includes('image') ? ['image'] : [])],
        inputSource: knownInput ? 'catalog' : profile.input ? 'profile' : 'default', catalogState });
}
export function validateModelCapabilities(value) {
    const fact = object(value);
    invariant(Object.keys(fact).sort().join(',') === ['contract', 'contextWindow', 'maxOutputTokens', 'contextSource', 'outputSource',
        'advertisedContextWindow', 'advertisedMaxOutputTokens', 'input', 'inputSource', 'catalogState'].sort().join(',')
        && fact.contract === 'model-capabilities/v1' && positive(fact.contextWindow) && positive(fact.maxOutputTokens)
        && fact.maxOutputTokens < fact.contextWindow
        && ['profile', 'catalog', 'default'].includes(String(fact.contextSource))
        && ['profile', 'catalog', 'default'].includes(String(fact.outputSource))
        && ['profile', 'catalog', 'default'].includes(String(fact.inputSource))
        && ['available', 'not-listed', 'unavailable'].includes(String(fact.catalogState))
        && Array.isArray(fact.input) && fact.input[0] === 'text'
        && (fact.input.length === 1 || fact.input.length === 2 && fact.input[1] === 'image')
        && (fact.advertisedContextWindow === null || positive(fact.advertisedContextWindow) && fact.contextWindow <= fact.advertisedContextWindow)
        && (fact.advertisedMaxOutputTokens === null || positive(fact.advertisedMaxOutputTokens) && fact.maxOutputTokens <= fact.advertisedMaxOutputTokens));
    return copy(value);
}
