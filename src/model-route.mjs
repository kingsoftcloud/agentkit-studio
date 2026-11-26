export const HARNESS_SERVICE_MODEL_PROVIDER = 'agentkit-studio-harness-service';

/**
 * The DSH route a model belongs to.
 *
 * DSH groups the model selector by route, so a route is a *provider*: every
 * model of one connection must share one route, or the same provider shows up
 * once per model. The connection id is the stable key; a profile without one
 * (legacy single-model configs) falls back to the provider+endpoint identity so
 * two models on the same gateway still land together.
 * @param {object} profile - a Studio model profile.
 * @param {number} [index] - position, for a profile with no identity at all.
 * @returns {string} the route name.
 */
export function dshModelRoute(profile = {}, index = 0) {
  const provider = String(profile?.provider || 'ksyun').trim() || 'ksyun';
  const connection = String(profile?.connectionId || '').trim();
  const identity = connection || `${provider}|${String(profile?.baseUrl || '').trim()}`;
  const id = identity || `${provider}:model-${index + 1}`;
  return `agentkit-studio-${id.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`.slice(0, 64);
}
