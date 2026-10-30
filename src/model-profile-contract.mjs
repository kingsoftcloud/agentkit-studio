/** Shared model-profile fields across authoring and runtime projections. */
export const MODEL_RUNTIME_OPTION_KEYS = Object.freeze(['protocol', 'contextWindow', 'maxOutputTokens', 'requestTimeoutMs', 'parameters']);
export function modelRuntimeOptions(profile) {
  return Object.fromEntries(MODEL_RUNTIME_OPTION_KEYS.filter(key => profile[key] !== undefined)
    .map(key => [key, structuredClone(profile[key])]));
}
