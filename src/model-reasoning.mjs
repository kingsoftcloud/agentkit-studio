/**
 * Studio's reasoning-effort declaration, shared by the client model bridge,
 * the portable import bridge and the local Harness request path.
 *
 * DSH's composer renders the「推理等级」pane only for models whose declaration
 * carries `reasoningEfforts`; a profile that leaves the field out is reported
 * by pi-ai as a non-reasoning model. Studio therefore materializes one small
 * map per opted-in profile. The levels are *not* the same for every upstream:
 * DeepSeek-style gateways accept low/high/max, OpenAI's enum stops at high,
 * and Codex's App Server has no `max` at all. The table below is the single
 * source of truth for both the selector and the wire value.
 *
 * `off` is deliberately not offered. The official DeepSeek provider exposes it
 * only as a separate switch, and a Studio Agent must keep thinking on: the
 * Harness loop's quality and the product's own trace expectations both assume
 * a reasoning phase. A profile can still be left undeclared ("不启用") when the
 * upstream model does not support `reasoning_effort` at all.
 */

/**
 * Per-provider reasoning capability table.
 *
 * - `levels`: the levels Studio offers for this provider, in selector order.
 * - `wire`: level → upstream value. Keys outside `levels` remain valid
 *   translations when a profile is served through a different runtime (an
 *   OpenAI-backed profile keeps `medium` even though Studio's Codex picker
 *   only exposes low/high/max).
 * - `default`: the level selected for a fresh opt-in, and the level a provider
 *   switch falls back to when the previous level is no longer offered.
 *
 * Every value that can reach an upstream `reasoning_effort` lives here; no
 * other module invents a wire value.
 */
export const REASONING_PROFILES = Object.freeze({
  ksyun: Object.freeze({
    provider: 'ksyun',
    levels: Object.freeze(['low', 'high', 'max']),
    wire: Object.freeze({ low: 'low', high: 'high', max: 'max' }),
    default: 'high',
  }),
  deepseek: Object.freeze({
    provider: 'deepseek',
    levels: Object.freeze(['low', 'high', 'max']),
    wire: Object.freeze({ low: 'low', high: 'high', max: 'max' }),
    default: 'high',
  }),
  openai: Object.freeze({
    provider: 'openai',
    levels: Object.freeze(['low', 'medium', 'high']),
    // OpenAI accepts minimal/low/medium/high; `max` is not part of the enum.
    wire: Object.freeze({ low: 'low', medium: 'medium', high: 'high' }),
    default: 'medium',
  }),
  codex: Object.freeze({
    provider: 'codex',
    levels: Object.freeze(['low', 'high', 'max']),
    // The Codex App Server's `model_reasoning_effort` stops at high, so the
    // top Studio level degrades instead of failing the turn. `medium` stays
    // translatable so an OpenAI-backed profile routed through Codex keeps it.
    wire: Object.freeze({ low: 'low', medium: 'medium', high: 'high', max: 'high' }),
    default: 'high',
  }),
});

/**
 * Safe declaration for a provider Studio does not know (including a custom
 * OpenAI-compatible gateway). Two same-named levels are the least likely to be
 * rejected as an illegal enum value; `max` is deliberately absent.
 */
export const REASONING_FALLBACK_PROFILE = Object.freeze({
  provider: 'custom',
  fallback: true,
  levels: Object.freeze(['low', 'high']),
  wire: Object.freeze({ low: 'low', high: 'high' }),
  default: 'high',
});

/** Every level a Studio declaration may expose, in canonical order. */
export const STUDIO_REASONING_LEVELS = Object.freeze(['low', 'medium', 'high', 'max']);

/** Legacy alias for the DeepSeek-style wire map, kept for importers. */
export const STUDIO_REASONING_WIRE = REASONING_PROFILES.ksyun.wire;

/** Legacy alias for Codex's own effort enum, kept for importers. */
export const STUDIO_CODEX_REASONING_WIRE = REASONING_PROFILES.codex.wire;

/** Legacy alias for the historical default level, kept for importers. */
export const STUDIO_REASONING_DEFAULT = REASONING_PROFILES.ksyun.default;

/**
 * Resolve the capability row for a profile provider.
 * @param {string} [provider] - a Studio model profile's provider id.
 * @returns {{provider: string, levels: readonly string[], wire: Record<string, string>, default: string, fallback?: true}}
 *   the frozen table row, or {@link REASONING_FALLBACK_PROFILE}.
 */
export function reasoningProfileFor(provider) {
  const key = String(provider ?? '').trim().toLowerCase();
  return Object.hasOwn(REASONING_PROFILES, key) ? REASONING_PROFILES[key] : REASONING_FALLBACK_PROFILE;
}

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
  const capability = reasoningProfileFor(profile?.provider);
  // `true` is the persisted opt-in marker: the provider table supplies both
  // the selector levels and the wire map. An explicit object is a
  // caller-declared override and stays authoritative, in canonical order.
  const levels = declared === true ? capability.levels : STUDIO_REASONING_LEVELS;
  const source = declared === true ? capability.wire : declared;
  if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
  const efforts = Object.fromEntries(levels
    .filter(level => typeof source[level] === 'string' && source[level].trim())
    .map(level => [level, source[level].trim()]));
  // pi-ai refuses a declaration that advertises no usable level; it would add
  // a selector that cannot change any request.
  if (!Object.keys(efforts).length) return null;
  const wanted = String(profile?.defaultReasoningEffort || '');
  const fallback = efforts[capability.default] ? capability.default : Object.keys(efforts)[0];
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
  return REASONING_PROFILES.codex.wire[level];
}

/**
 * The highest wire value a provider accepts. Used when an upstream rejects a
 * reasoning value we believed it supported: the retry must still be legal.
 * @param {object} profile - a Studio model profile.
 * @returns {string} the provider's highest legal wire value.
 */
export function studioReasoningFallbackWire(profile) {
  const capability = reasoningProfileFor(profile?.provider);
  const level = capability.levels[capability.levels.length - 1];
  return capability.wire[level];
}

/**
 * Whether an upstream failure is a rejection of the reasoning effort value.
 * @param {number} status - the upstream HTTP status.
 * @param {string} message - the upstream error text.
 * @returns {boolean} true for a 400 whose detail names the reasoning effort.
 */
export function isReasoningEffortRejection(status, message) {
  return Number(status) === 400 && /reasoning[._ -]?effort/i.test(String(message || ''));
}

/**
 * Rewrite a request body's reasoning value in place. Handles both wire shapes:
 * Chat Completions' `reasoning_effort` and Responses' `reasoning.effort`.
 * @param {object} body - the serialized request body to mutate.
 * @param {string} wire - the replacement wire value.
 * @returns {string | undefined} the value that was replaced, or undefined when
 *   the body carried no different value and no retry is warranted.
 */
export function applyReasoningFallback(body, wire) {
  if (!body || typeof body !== 'object' || !wire) return undefined;
  let previous;
  if (typeof body.reasoning_effort === 'string' && body.reasoning_effort !== wire) {
    previous = body.reasoning_effort;
    body.reasoning_effort = wire;
  }
  if (body.reasoning && typeof body.reasoning === 'object'
    && typeof body.reasoning.effort === 'string' && body.reasoning.effort !== wire) {
    if (previous === undefined) previous = body.reasoning.effort;
    body.reasoning.effort = wire;
  }
  return previous;
}

/**
 * Observable record of a reasoning downgrade. Credential-free by construction:
 * only the provider id, model id, both wire values and the status are logged.
 * @param {{provider?: string, model?: string, from?: string, to?: string, status?: number}} event
 */
export function logReasoningFallback(event = {}) {
  console.warn('[agentkit-studio] reasoning_effort fallback:', JSON.stringify({
    provider: String(event.provider || ''),
    model: String(event.model || ''),
    from: String(event.from || ''),
    to: String(event.to || ''),
    status: Number(event.status) || 400,
  }));
}
