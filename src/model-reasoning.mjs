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
 * Whether an upstream failure is a rejection of a replayed reasoning item.
 *
 * Kspmas validates every assistant turn as `content`-or-`tool_calls` and answers
 * `400 Invalid assistant message: content or tool_calls must be set` when a
 * replayed `reasoning` item reaches it. OpenAI documents replaying reasoning
 * items with tool outputs to keep reasoning continuity, so this must stay a
 * *fallback*: forward reasoning items and only drop them after the gateway
 * actually refuses them.
 *
 * @param {number} status - the upstream HTTP status.
 * @param {string} message - the upstream error text.
 * @returns {boolean} true for a 400 whose detail names the assistant-message rule.
 */
export function isReasoningReplayRejection(status, message) {
  if (Number(status) !== 400) return false;
  const text = String(message || '');
  // A provider that refuses the optional `content` field on a replayed reasoning
  // item names either the field deserialization or the assistant-message rule.
  return /response\s*input\s+deserialization/i.test(text)
    || (/invalid\s+assistant\s+message/i.test(text) && /content\s+or\s+tool_calls/i.test(text));
}

/**
 * Strip the explicit `content: null` Codex serializes for an absent reasoning
 * body.
 *
 * Codex reaches this gateway directly without any such rewrite, so this
 * normalization stays a *fallback*: forward reasoning items unchanged and only
 * retry with the field removed when a provider answers that the optional field
 * is invalid.
 *
 * @param {object} body - the serialized request body to mutate.
 * @returns {number} how many reasoning items were normalized.
 */
export function normalizeReasoningContent(body) {
  if (!body || !Array.isArray(body.input)) return 0;
  let normalized = 0;
  body.input = body.input.map(item => {
    if (item?.type !== 'reasoning' || item.content !== null) return item;
    normalized += 1;
    const { content: _absent, ...reasoning } = item;
    return reasoning;
  });
  return normalized;
}

/**
 * Drop assistant turns that carry neither text nor tool calls.
 *
 * Every OpenAI-compatible gateway validates an assistant turn as
 * `content`-or-`tool_calls` and answers
 * `400 Invalid assistant message: content or tool_calls must be set` when both
 * are empty. The shape is reachable because history is built elsewhere: DSH's
 * Responses projection emits `{ role: 'assistant', content: [] }` for a session
 * turn whose text is gone (a turn that only ever carried reasoning, or one
 * truncated by compaction), and the Responses-to-Chat conversion normalizes
 * every empty form to `content: ''`. Such a turn carries no information, so it
 * is never worth forwarding — and unlike a replayed reasoning item it loses
 * nothing when dropped. Drop it before the request leaves the proxy instead of
 * spending a round-trip to learn what the gateway will say.
 *
 * @param {object} body - the serialized request body to mutate.
 * @returns {number} how many assistant turns were dropped.
 */
export function normalizeEmptyAssistantTurns(body) {
  if (!body || typeof body !== 'object') return 0;
  const emptyContent = content => content == null
    || (typeof content === 'string' && !content.trim())
    || (Array.isArray(content) && !content.length);
  // Both wires are handled: Chat Completions rows carry `tool_calls`, Responses
  // message items carry no calls at all (the calls are separate items), which is
  // exactly why an assistant row with no content is always droppable.
  const emptyTurn = turn => emptyContent(turn.content)
    && !(Array.isArray(turn.tool_calls) && turn.tool_calls.length)
    && !(Array.isArray(turn.toolCalls) && turn.toolCalls.length);
  let dropped = 0;
  const keep = turn => {
    if (!turn || typeof turn !== 'object' || turn.role !== 'assistant') return true;
    // Only message items are turns; a reasoning item is not one and keeps its
    // (possibly empty) content.
    if (turn.type !== undefined && turn.type !== 'message') return true;
    if (!emptyTurn(turn)) return true;
    dropped += 1;
    return false;
  };
  if (Array.isArray(body.input)) body.input = body.input.filter(keep);
  if (Array.isArray(body.messages)) body.messages = body.messages.filter(keep);
  return dropped;
}

/**
 * Drop replayed reasoning items that belong to a turn carrying nothing else.
 *
 * The Responses wire groups one assistant turn as a run of `reasoning` items
 * followed by `message` items, and a gateway that validates the turn (magpie →
 * 星流 prefill) accepts it only when the turn also carries an assistant
 * `message` with non-null content or a `function_call`. A turn made only of
 * reasoning is answered with
 * `400 Invalid assistant message: content or tool_calls must be set`, and
 * stripping the reasoning item's `content` field — the earlier repair — re-sends
 * a body the gateway refuses identically. Such a turn replays thinking behind a
 * response that produced no text and no tool call, so it is worth nothing:
 * drop its reasoning items.
 *
 * Turns that do carry text or a call keep their reasoning items untouched, so
 * reasoning continuity for tool flows (which OpenAI documents) is preserved.
 *
 * @param {object} body - the serialized request body to mutate.
 * @returns {number} how many reasoning items were dropped.
 */
export function dropCarrierlessReasoningTurns(body) {
  if (!body || !Array.isArray(body.input)) return 0;
  const items = body.input;
  const emptyContent = content => content == null
    || (typeof content === 'string' && !content.trim())
    || (Array.isArray(content) && !content.length);
  const drop = new Set();
  let reasoning = [];
  let carries = false;
  // A turn ends where the wire starts a new one: a user/system/developer
  // message, a tool receipt, or the end of input. `function_call` items belong
  // to the turn they follow and count as its carrier.
  const flush = () => {
    if (!carries) for (const index of reasoning) drop.add(index);
    reasoning = [];
    carries = false;
  };
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!item || typeof item !== 'object') continue;
    const type = item.type;
    if (type === 'reasoning') { reasoning.push(index); continue; }
    if (type === 'function_call' || type === 'custom_tool_call') { carries = true; continue; }
    if (type === 'function_call_output' || type === 'custom_tool_call_output') { flush(); continue; }
    if (type === 'message' || type === undefined) {
      if (item.role === 'assistant') {
        // Parallel tool calls on a message item are carriers just like the
        // separate `function_call` items of the same turn.
        if ((Array.isArray(item.tool_calls) && item.tool_calls.length)
          || (Array.isArray(item.toolCalls) && item.toolCalls.length)
          || !emptyContent(item.content)) carries = true;
        continue;
      }
      flush();
      continue;
    }
    // An item this projection does not know is treated as its own boundary.
    flush();
  }
  flush();
  if (!drop.size) return 0;
  body.input = items.filter((_, index) => !drop.has(index));
  return drop.size;
}

/**
 * Drop tool receipts whose assistant call is no longer in the request.
 *
 * A receipt is only meaningful as the answer to a `function_call`. History
 * built upstream of this proxy can lose the call while keeping the receipt
 * (compaction that keeps a tool result but drops the assistant turn, or a
 * truncated replay), and every OpenAI-compatible gateway then refuses the whole
 * request: `400 Messages with role 'tool' must be a response to a preceding
 * message with 'tool_calls'`. The model cannot interpret a receipt on its own,
 * so drop the orphan instead of forwarding a request no gateway accepts.
 *
 * Receipts are paired in order — one receipt answers one call — which mirrors
 * the pairing the Responses projection itself enforces.
 *
 * @param {object} body - the serialized request body to mutate.
 * @returns {number} how many receipts were dropped.
 */
export function dropOrphanToolReceipts(body) {
  if (!body || typeof body !== 'object') return 0;
  const receipt = (pending, callId) => {
    const id = String(callId ?? '');
    if (!id || !pending.has(id)) return false;
    pending.delete(id);
    return true;
  };
  let dropped = 0;
  if (Array.isArray(body.input)) {
    const pending = new Set();
    body.input = body.input.filter(item => {
      const type = item?.type;
      if (type === 'function_call' || type === 'custom_tool_call') {
        const id = String(item.call_id ?? '');
        if (id) pending.add(id);
        return true;
      }
      if (type === 'function_call_output' || type === 'custom_tool_call_output') {
        if (receipt(pending, item.call_id)) return true;
        dropped += 1;
        return false;
      }
      return true;
    });
  }
  if (Array.isArray(body.messages)) {
    // Chat Completions keeps the calls inside the assistant row, so the pairing
    // has to be tracked per row rather than per item.
    const pending = new Set();
    body.messages = body.messages.filter(message => {
      if (!message || typeof message !== 'object') return true;
      if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
        for (const call of message.tool_calls) {
          const id = String(call?.id ?? '');
          if (id) pending.add(id);
        }
        return true;
      }
      if (message.role === 'tool') {
        if (receipt(pending, message.tool_call_id)) return true;
        dropped += 1;
        return false;
      }
      return true;
    });
  }
  return dropped;
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
