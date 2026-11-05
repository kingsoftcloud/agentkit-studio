/**
 * Pure helpers shared by the prompt-prediction host plugin and its tests.
 *
 * Nothing here touches cordis, the network, or the filesystem, so every rule
 * that decides *what* gets predicted, *how* the model is asked, and *whether*
 * a completion is acceptable can be exercised without a running host.
 *
 * @module @kingsoftcloud/agentkit-studio/prompt-prediction
 */

/** Bumped whenever {@link predictionInstruction} or the output contract changes. */
export const PROMPT_VERSION = 'pp-3'

/** Characters kept from model output before it is rejected as unusable. */
const DEFAULT_MAX_SUGGESTION_CHARS = 1000

/** Paragraphs kept from a multi-line prediction; the composer stays a short draft. */
const DEFAULT_MAX_SUGGESTED_LINES = 3

/** A missing source is accepted for legacy histories; explicit synthetic sources are not. */
export function isHumanUserMessage(message) {
  return message?.role === 'user' && (message.source == null || message.source.kind === 'user')
}

/** Slice UTF-16 text without leaving a dangling high surrogate. */
function clipText(text, limit) {
  const clipped = text.slice(0, limit)
  return /[\uD800-\uDBFF]$/u.test(clipped) ? clipped.slice(0, -1) : clipped
}

/**
 * Collect the user's own recent messages as style anchors.
 *
 * The model already sees this history, so nothing new is disclosed: the point is
 * to point at *how this user types* — length, vocabulary, shorthand — instead of
 * letting the model drift into assistant-style prose.
 *
 * @param {readonly object[]} messages - `session.deriveMessages()` output.
 * @param {number} [limit] - how many anchors to keep.
 * @param {number} [maxChars] - characters kept per anchor.
 * @returns {string[]} anchor texts, oldest first, deduplicated.
 */
export function styleExemplars(messages, limit = 3, maxChars = 120) {
  if (!Array.isArray(messages) || !(limit > 0)) return []
  const seen = new Set()
  const kept = []
  for (let index = messages.length - 1; index >= 0 && kept.length < limit; index -= 1) {
    const message = messages[index]
    if (!isHumanUserMessage(message)) continue
    const text = messageText(message).replace(/\s+/gu, ' ').trim()
    if (text.length === 0) continue
    // Command payloads and reference dumps say nothing about conversational style.
    if (text.startsWith('/') || text.startsWith('@')) continue
    const clipped = text.length > maxChars ? `${clipText(text, maxChars).trimEnd()}…` : text
    if (seen.has(clipped)) continue
    seen.add(clipped)
    kept.push(clipped)
  }
  return kept.reverse()
}

/**
 * The instruction appended as a request-only user turn after the real history.
 *
 * @param {{exemplars?: readonly string[], maxSuggestionChars?: number}} [options]
 *   style anchors drawn from the user's own messages, plus the length cap the
 *   output contract must state.
 * @returns {string} the instruction text.
 */
export function predictionInstruction(options = {}) {
  const exemplars = Array.isArray(options.exemplars)
    ? options.exemplars.filter((value) => typeof value === 'string' && value.trim().length > 0)
    : []
  const maxChars = options.maxSuggestionChars ?? DEFAULT_MAX_SUGGESTION_CHARS
  const maxLines = options.maxLines ?? DEFAULT_MAX_SUGGESTED_LINES
  const lines = [
    '[Composer prediction - not a task]',
    'Stop working on the task. Do not call tools. Do not answer the request, continue the',
    "assistant's work, or describe what you would do.",
    'Predict the single next message the USER is most likely to type into the composer now.',
    '',
    'How to write it:',
    "- Same language as the user's most recent messages.",
    '- Match how this user actually types. Most follow-ups are ONE short sentence; use two',
    "  clauses only when the user's own messages are that long. Reuse their vocabulary and",
    '  shorthand rather than inventing formal wording.',
    '- Move the work forward: a follow-up request, a correction, a choice among options the',
    '  assistant just offered, or the answer to a question it just asked.',
    '- If the assistant ended with a question or a numbered list of options, answer or pick one.',
    "- Do not restate the user's own previous message; assume it was already sent.",
    '- Never invent file names, numbers, results, or facts that are not in the conversation.',
    '- Never output credentials of any kind: no verification codes, one-time passwords,',
    '  passwords, API keys, or tokens. If the only sensible next step is one of those,',
    '  return null instead of inventing a value.',
    '',
    'Abstaining is expected and cheap. Return null instead of a weak guess when:',
    '- the assistant just asked an open question whose answer depends on facts only the',
    '  user has (a preference, a deadline, a secret, an external result);',
    '- the next step is a decision only the user can make, and the conversation does not',
    '  hint at which way they lean;',
    '- the recent messages are greetings, thanks or acknowledgements with no task left;',
    '- your best guess would be a generic filler such as "continue", "ok" or "thanks" that',
    '  adds nothing the user would not have typed anyway;',
    '- you are not reasonably confident this specific user would type that sentence now.',
    'A shown suggestion the user ignores is worse than no suggestion at all.',
  ]
  if (exemplars.length > 0) {
    lines.push('', "Style anchors - the user's own recent messages. Match their tone and length; do not copy them:")
    for (const exemplar of exemplars) lines.push(`- ${JSON.stringify(exemplar)}`)
  }
  lines.push(
    '',
    'Return only JSON matching this schema: {"suggestion": string | null}',
    `No Markdown and no code fences. At most ${maxLines} short paragraphs and ${maxChars} characters;`,
    'put a newline inside the JSON string to start a new paragraph.',''
  )
  return lines.join('\n')
}

/**
 * Normalize raw plugin configuration into a frozen policy object.
 *
 * Unknown keys are ignored rather than rejected: the profile patch is a
 * composition file, and a stale key must not stop the plugin from loading.
 *
 * @param {unknown} raw - YAML `config:` value handed to `apply`.
 * @returns {object} frozen, validated configuration.
 */
export function normalizeConfig(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  const positive = (value, fallback) =>
    typeof value === 'number' && Number.isFinite(value) && Math.floor(value) >= 1 ? Math.floor(value) : fallback

  const provider = typeof input.provider === 'string' && input.provider.length > 0 ? input.provider : null
  const model = typeof input.model === 'string' && input.model.length > 0 ? input.model : null
  // A route override is all-or-nothing; half a route silently falls back to the
  // session's own route, which keeps prefix caching intact.
  const hasRoute = provider !== null && model !== null

  return Object.freeze({
    enabled: input.enabled !== false,
    provider: hasRoute ? provider : null,
    model: hasRoute ? model : null,
    maxOutputTokens: positive(input.maxOutputTokens, 8192),
    timeoutMs: positive(input.timeoutMs, 20000),
    maxSuggestionChars: positive(input.maxSuggestionChars, DEFAULT_MAX_SUGGESTION_CHARS),
    /** History turns kept when an override route is configured (no prefix reuse then). */
    compactTurns: positive(input.compactTurns, 8),
    /** Turns whose prediction is computed eagerly instead of on first sight. */
    eagerWindowMs: positive(input.eagerWindowMs, 30 * 60 * 1000),
    /** Zero disables the guard. */
    maxHistoryChars: typeof input.maxHistoryChars === 'number' && input.maxHistoryChars >= 0 ? input.maxHistoryChars : 0,
    auditLog: input.auditLog !== false,
    /** `inherit` (default), `min`, or an explicit effort id the model advertises. */
    reasoningEffort: typeof input.reasoningEffort === 'string' && input.reasoningEffort.trim().length > 0
      ? input.reasoningEffort.trim()
      : 'inherit',
    promptVersion: PROMPT_VERSION,
  })
}

/**
 * Whether a logged `turn/end` reason is one the user would follow up on.
 *
 * Codex predicts only after a completed turn; aborted, failed, blocked,
 * max-tokens and interrupted turns are the user's cue to write something
 * deliberate, so a guess there is noise.
 *
 * @param {{kind: string} | undefined} reason - `turn/end` reason payload.
 * @returns {boolean} whether a prediction should be scheduled.
 */
export function turnIsPredictable(reason) {
  return reason !== undefined && reason !== null && reason.kind === 'completed'
}

/**
 * Whether a session is a subagent child or a fork seed rather than the user's
 * own conversation.
 *
 * @param {{origin?: string, delegationDepth?: number, parentSession?: unknown} | undefined} header
 *   the session header.
 * @returns {boolean} true when the session must not receive predictions.
 */
export function isDerivedSession(header) {
  if (header === undefined || header === null) return false
  if (header.origin === 'subagent') return true
  if (typeof header.delegationDepth === 'number' && header.delegationDepth > 0) return true
  // Fork seeds keep the parent's prefix; the parent is a better prediction target.
  if (header.parentSession !== undefined && header.parentSession !== null) return true
  return false
}

/** Concatenate the text blocks of one model-visible message. */
export function messageText(message) {
  if (message === undefined || message === null) return ''
  const content = message.content
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      text += block.text
    }
  }
  return text
}

/** Total characters across the given messages (a cheap proxy for request size). */
export function historyChars(messages) {
  let total = 0
  for (const message of messages) total += messageText(message).length
  return total
}

/**
 * Rebuild a short, dependency-free history for an override route, where the
 * main request prefix cannot be reused anyway.
 *
 * Only user and assistant text survives: tool calls, tool results and reasoning
 * add cost without helping predict what the human types next.
 *
 * @param {readonly object[]} messages - `session.deriveMessages()` output.
 * @param {number} turns - user turns to keep.
 * @returns {object[]} request-only messages, oldest first.
 */
export function compactHistory(messages, turns) {
  const kept = []
  let seen = 0
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message === undefined || message === null) continue
    const role = message.role
    if (role !== 'user' && role !== 'assistant') continue
    const text = messageText(message).trim()
    if (text.length === 0) continue
    if (role === 'user') {
      seen += 1
      if (seen > turns) break
    }
    // DSH requires message identity/provenance even on compact history. Drop
    // opaque replay state because it describes blocks that were removed here.
    const source = role === 'assistant' && message.source != null
      ? { kind: 'model', provider: message.source.provider, model: message.source.model }
      : message.source
    kept.push({ ...message, role, content: [{ type: 'text', text }], ...(source == null ? {} : { source }) })
  }
  kept.reverse()
  // Drop an assistant reply whose own user message fell outside the window: a
  // dangling answer reads as if the user had already spoken.
  while (kept.length > 0 && kept[0].role === 'assistant') kept.shift()
  return kept
}

/**
 * The most recent assistant *speech*, not simply the most recent assistant
 * message.
 *
 * A step that calls tools produces an assistant message carrying reasoning and
 * tool-call blocks with no text at all, so stopping at the newest assistant row
 * would report "the assistant never spoke" for a perfectly normal conversation.
 *
 * @param {readonly object[]} messages - `session.deriveMessages()` output.
 * @returns {string} trimmed text of the last assistant message that has some,
 *   or an empty string when the assistant never produced visible text.
 */
export function lastAssistantText(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message === undefined || message === null || message.role !== 'assistant') continue
    const text = messageText(message).trim()
    if (text.length > 0) return text
  }
  return ''
}

/** Remove ```json fences a model may wrap the JSON payload in. */
export function stripFences(text) {
  const trimmed = text.trim()
  if (!trimmed.startsWith('```')) return trimmed
  const firstNewline = trimmed.indexOf('\n')
  if (firstNewline === -1) return trimmed.replace(/^`+|`+$/g, '').trim()
  const withoutOpening = trimmed.slice(firstNewline + 1)
  const closing = withoutOpening.lastIndexOf('```')
  return (closing === -1 ? withoutOpening : withoutOpening.slice(0, closing)).trim()
}

/**
 * Extract the JSON object from model output.
 *
 * Models occasionally prepend a sentence before the payload; the first `{` and
 * the last `}` bracket it well enough that a strict parse then decides.
 */
export function extractJsonObject(text) {
  const body = stripFences(text)
  if (body.length === 0) return undefined
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return undefined
  try {
    const parsed = JSON.parse(body.slice(start, end + 1))
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * Turn one completion into a displayable suggestion.
 *
 * Rejects everything the composer cannot safely show: empty output, an explicit
 * `null` (the model's "no confident guess"), too many paragraphs, and text that
 * would start a command (`/`) or a reference (`@`) instead of prose.
 *
 * @param {string} raw - assembled model text.
 * @param {{maxSuggestionChars?: number, maxLines?: number, previousAssistantText?: string, lastUserText?: string}} [options]
 * @returns {{ok: true, text: string} | {ok: false, reason: string}}
 */
export function parseSuggestion(raw, options = {}) {
  const maxChars = options.maxSuggestionChars ?? DEFAULT_MAX_SUGGESTION_CHARS
  if (typeof raw !== 'string' || raw.trim().length === 0) return { ok: false, reason: 'empty-output' }
  const payload = extractJsonObject(raw)
  if (payload === undefined) return { ok: false, reason: 'invalid-json' }
  const suggestion = payload.suggestion
  if (suggestion === null) return { ok: false, reason: 'declined' }
  if (typeof suggestion !== 'string') return { ok: false, reason: 'invalid-shape' }

  let text = normalizeSuggestionText(suggestion)
  if (text.length === 0) return { ok: false, reason: 'blank-suggestion' }
  // Keep the composer's first character meaningful: `/` claims a command and
  // `@` claims a reference, and a prediction must stay editable prose.
  if (text.startsWith('/') || text.startsWith('@')) return { ok: false, reason: 'reserved-lead' }
  const maxLines = options.maxLines ?? DEFAULT_MAX_SUGGESTED_LINES
  if (text.split('\n').length > maxLines) return { ok: false, reason: 'too-many-paragraphs' }
  // A guess must never put an invented credential in front of the user.
  if (looksLikeCredential(text)) return { ok: false, reason: 'credential-shaped' }
  if (text.length > maxChars) {
    text = clipText(text, maxChars).trimEnd()
  }
  if (text.length === 0) return { ok: false, reason: 'blank-suggestion' }

  const previous = options.previousAssistantText
  if (typeof previous === 'string' && previous.length > 0 && previous.trim() === text) {
    // Repeating the assistant verbatim is not a user message.
    return { ok: false, reason: 'echoed-assistant' }
  }
  // Restating what the user just sent adds nothing over an empty composer.
  const lastUser = options.lastUserText
  if (typeof lastUser === 'string' && lastUser.trim().length > 0 && normalizeForCompare(lastUser) === normalizeForCompare(text)) {
    return { ok: false, reason: 'repeated-user' }
  }
  return { ok: true, text }
}

/**
 * Normalize whitespace and unambiguous whole-message decoration only.
 * Keep identifiers, operators and inline code intact; paragraph limits are
 * checked by the caller so an incomplete draft is never silently accepted.
 */
function normalizeSuggestionText(text) {
  let cleaned = text.trim()
  // Permit nested whole-message wrappers, such as **“run tests”**.
  for (let depth = 0; depth < 4; depth += 1) {
    let next = unwrapQuotes(cleaned)
    if (next.startsWith('**') && next.endsWith('**') && next.length > 4) {
      const inner = next.slice(2, -2).trim()
      if (inner && !inner.includes('**')) next = inner
    }
    if (next === cleaned) break
    cleaned = next
  }
  return cleaned.split(/\r\n?|\n/u)
    .map(line => line.replace(/[^\S\r\n]+/gu, ' ').trim())
    .filter(Boolean).join('\n')
}

/** Ignore sentence-ending punctuation, but retain code/math symbols and case. */
function normalizeForCompare(text) {
  return text.trim().replace(/\s+/gu, ' ').replace(/[。！？.!?]+$/u, '').trimEnd()
}

/** Strip one layer of wrapping quotes or guillemets around the whole line. */
function unwrapQuotes(text) {
  const pairs = [['"', '"'], ["'", "'"], ['“', '”'], ['「', '」'], ['『', '』'], ['《', '》'], ['`', '`']]
  for (const [open, close] of pairs) {
    if (text.length > 2 && text.startsWith(open) && text.endsWith(close)) {
      const inner = text.slice(open.length, text.length - close.length).trim()
      if (inner.length > 0 && !inner.includes(close)) return inner
    }
  }
  return text
}

/**
 * Whether a line reads like a secret the plugin must not invent.
 *
 * Grounded in a real failure: with an npm 2FA prompt in context the model
 * produced `验证码：123456`. A plausible-looking code is worse than no guess.
 */
function looksLikeCredential(text) {
  // A numeric-only suggestion is too ambiguous to invent: it may be an OTP.
  if (/^\d{4,8}$/u.test(text.trim())) return true
  // Labels must be adjacent to a value, not merely somewhere in a message
  // containing an unrelated budget or port number. Word boundaries exclude
  // identifiers such as maxOutputTokens and descriptive phrases like token budget.
  if (/\b(?:password|passcode|otp|api[ -]?key|secret|token)\b\s*(?:[:：=]|is\b)\s*\S+/iu.test(text)) return true
  if (/(?:验证码|校验码|动态码|一次性密码|密码|口令)\s*(?:[:：=]|是|为)\s*\S+/u.test(text)) return true
  if (/(?:验证码|校验码|动态码|一次性密码|密码|口令)\s*\d{4,8}(?!\d)/u.test(text)) return true
  const compact = text.trim()
  if (/^[A-Za-z0-9_-]{24,}$/u.test(compact) && /[0-9]/u.test(compact) && /[A-Za-z]/u.test(compact)) return true
  // Recognizable provider tokens are refused even when embedded in prose.
  if (/(?:^|[^A-Za-z0-9_])(?:sk|pk|ghp|gho|ghs|npm|xox[baprs])[-_][A-Za-z0-9_-]{12,}/u.test(text)) return true
  return false
}

/**
 * The lowest reasoning effort a model advertises, as a `ConfigureCall`.
 *
 * A prediction is a short guess: paying for the route's top effort would make
 * the feature slower and more expensive than the turn it follows.
 */
export function leastReasoningEffort(controls, model) {
  const effort = model?.reasoning?.efforts?.[0]?.id
  return effort === undefined ? controls : { ...controls, reasoningEffort: effort }
}

/**
 * Build the `ConfigureCall` for a configured reasoning-effort policy.
 *
 * Codex inherits the parent turn's reasoning effort (`configuredReasoningEffort:
 * 'inherit'`) instead of forcing the cheapest tier, because a guess written by an
 * under-powered pass tends to be vague. Inheritance stays the default here; the
 * old "cheapest" behaviour is still available as `min`.
 *
 * @param {string} [setting] - `inherit`, `min`, or an explicit effort id.
 * @returns {(controls: object, model?: object) => object} a configure callback.
 */
export function reasoningEffortPolicy(setting) {
  const mode = typeof setting === 'string' && setting.trim().length > 0 ? setting.trim() : 'inherit'
  if (mode === 'inherit') return (controls) => controls
  if (mode === 'min') return leastReasoningEffort
  return (controls, model) => {
    const efforts = model?.reasoning?.efforts
    if (!Array.isArray(efforts) || !efforts.some((entry) => entry?.id === mode)) return controls
    return { ...controls, reasoningEffort: mode }
  }
}

/** Assemble `text-delta` chunks and the terminal finish reason from one stream. */
export function assembleChunks(chunks) {
  let text = ''
  let finish
  let usage
  for (const chunk of chunks) {
    switch (chunk.type) {
      case 'text-delta':
        text += chunk.text
        break
      case 'usage':
        usage = chunk.usage ?? usage
        break
      case 'finish':
        finish = chunk.reason
        break
      case 'tool-call-delta':
      case 'block-end':
        if (chunk.type === 'block-end' && chunk.block?.type === 'tool-call') {
          return { text, finish, usage, toolCall: true }
        }
        break
      default:
        break
    }
  }
  return { text, finish, usage, toolCall: false }
}
