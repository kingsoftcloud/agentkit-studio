/**
 * Studio's reasoning-effort declaration, shared by the client model bridge,
 * the portable import bridge and the local Harness request path.
 *
 * DSH's composer renders the「推理等级」pane only for models whose declaration
 * carries `reasoningEfforts`; a profile that leaves the field out is reported
 * by pi-ai as a non-reasoning model. Studio therefore materializes one small
 * map per opted-in profile, mirroring DeepSeek's three thinking levels
 * (Low / High / Max) instead of the five-level OpenAI/Codex shape.
 *
 * `off` is deliberately not offered. The official DeepSeek provider exposes it
 * only as a separate switch, and a Studio Agent must keep thinking on: the
 * Harness loop's quality and the product's own trace expectations both assume
 * a reasoning phase. A profile can still be left undeclared ("不启用") when the
 * upstream model does not support `reasoning_effort` at all.
 */

/** Level to upstream wire value for OpenAI-compatible reasoning gateways. */
export const STUDIO_REASONING_WIRE = Object.freeze({
  low: 'low',
  high: 'high',
  max: 'max',
});

/**
 * Codex's App Server accepts only minimal/low/medium/high, so the top Studio
 * level degrades to `high` there rather than failing the turn.
 */
export const STUDIO_CODEX_REASONING_WIRE = Object.freeze({
  low: 'low',
  high: 'high',
  max: 'high',
});

/** Level selected for a fresh session once reasoning is enabled. */
export const STUDIO_REASONING_DEFAULT = 'high';

/** The levels a Studio profile may expose, in selector order. */
export const STUDIO_REASONING_LEVELS = Object.freeze(['low', 'high', 'max']);

/**
 * Resolve the reasoning declaration a profile publishes.
 * @param {object} profile - a Studio model profile.
 * @returns {{ efforts: Record<string, string>, defaultEffort: string } | null}
 *   the declared map and default level, or null when the profile is not
 *   reasoning-capable.
 */
export function studioReasoning(profile = {}) {
  const declared = profile?.reasoningEfforts;
  if (!declared) return null;
  const source = declared === true ? STUDIO_REASONING_WIRE : declared;
  if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
  const efforts = Object.fromEntries(Object.entries(source)
    .filter(([level, wire]) => STUDIO_REASONING_LEVELS.includes(level) && typeof wire === 'string' && wire.trim())
    .map(([level, wire]) => [level, wire.trim()]));
  // pi-ai refuses a declaration that advertises no usable level; it would add
  // a selector that cannot change any request.
  if (!Object.keys(efforts).length) return null;
  const wanted = String(profile?.defaultReasoningEffort || '');
  const fallback = efforts[STUDIO_REASONING_DEFAULT] ? STUDIO_REASONING_DEFAULT : Object.keys(efforts)[0];
  return { efforts, defaultEffort: efforts[wanted] ? wanted : fallback };
}

/**
 * Translate a DSH level into the wire value this profile declared.
 * @param {object} profile - a Studio model profile.
 * @param {string} level - the level DSH selected.
 * @returns {string | undefined} the upstream value, or undefined when this
 *   profile does not declare the level.
 */
export function studioReasoningWire(profile, level) {
  const reasoning = studioReasoning(profile);
  if (!reasoning || !level) return undefined;
  return reasoning.efforts[level];
}

/**
 * Translate a DSH level for Codex's narrower effort enum.
 * @param {string} level - the level DSH selected.
 * @returns {string | undefined} a Codex `model_reasoning_effort` value.
 */
export function studioCodexReasoningWire(level) {
  return STUDIO_CODEX_REASONING_WIRE[level];
}
