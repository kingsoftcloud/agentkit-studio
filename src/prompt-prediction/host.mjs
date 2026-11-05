/** Host-owned prompt prediction for the native DSH composer. */
import { hostFetch } from '../http-fetch.mjs'
import {
  compactHistory,
  isDerivedSession,
  lastAssistantText,
  messageText,
  normalizeConfig,
  parseSuggestion,
  predictionInstruction,
  styleExemplars,
} from './prediction.mjs'

export const PROMPT_PREDICTION_STATE_PATH = '/api/agentkit/prompt-prediction/state'
export const PROMPT_PREDICTION_FEEDBACK_PATH = '/api/agentkit/prompt-prediction/feedback'
export const PROMPT_PREDICTION_CONFIG_PATH = '/api/agentkit/prompt-prediction/config'

const MAX_BODY_BYTES = 16 * 1024
const MAX_CONCURRENT = 2

function envBoolean(value, fallback) {
  if (value === undefined) return fallback
  return value !== '0' && value !== 'false'
}

function studioConfig(env = process.env, raw = {}) {
  return normalizeConfig({
    ...raw,
    enabled: envBoolean(env.AGENTKIT_PROMPT_PREDICTION_ENABLED, raw.enabled !== false),
    auditLog: envBoolean(env.AGENTKIT_PROMPT_PREDICTION_AUDIT, raw.auditLog === true),
    maxOutputTokens: 256,
    maxSuggestionChars: 600,
    timeoutMs: 12000,
    compactTurns: 8,
    maxHistoryChars: 120000,
  })
}

function predictionRouteAllowed(session) {
  let provider = ''
  try { provider = String(session?.requestHeader?.()?.config?.provider ?? '').toLowerCase() } catch { /* legacy sessions have no request header */ }
  return provider === '' || !/(?:codex|cloud|a2a|openclaw|managed|native-harness)/u.test(provider)
}

function sessionEligible(session) {
  if (!session || typeof session.deriveMessages !== 'function') return { ok: false, reason: 'unknown-session' }
  if (isDerivedSession(session.header)) return { ok: false, reason: 'derived-session' }
  if (!predictionRouteAllowed(session)) return { ok: false, reason: 'unsupported-route' }
  const messages = session.deriveMessages()
  if (lastAssistantText(messages).length === 0) return { ok: false, reason: 'no-assistant-reply' }
  return { ok: true, messages }
}

function json(value, status = 200) {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store' } })
}

function stateSnapshot(state) {
  return {
    rev: state.rev,
    status: state.status,
    turnSeq: state.turnSeq,
    text: state.text,
    reason: state.reason,
    trigger: state.trigger,
    latencyMs: state.latencyMs,
    promptVersion: state.promptVersion,
  }
}

/**
 * Register prediction state and feedback routes on DSH's authenticated Connection.
 * The model request stays on the Host; the browser only receives a bounded suggestion.
 */
export function createPromptPredictionHost(ctx, {
  models,
  env = process.env,
  fetchImpl = hostFetch,
  config: rawConfig,
} = {}) {
  const config = studioConfig(env, rawConfig)
  const states = new Map()
  let running = 0
  let disposed = false

  const stateOf = (sessionId) => {
    let state = states.get(sessionId)
    if (state !== undefined) return state
    state = {
      session: undefined,
      rev: 0,
      status: 'idle',
      turnSeq: null,
      candidateTurnSeq: null,
      text: null,
      reason: null,
      trigger: null,
      latencyMs: null,
      promptVersion: config.promptVersion,
      turnOpen: false,
      inflight: null,
    }
    states.set(sessionId, state)
    return state
  }

  const publish = (state, patch) => {
    Object.assign(state, patch)
    state.rev += 1
  }

  const abort = (state) => {
    state.inflight?.abort()
    state.inflight = null
  }

  const schedule = (session, state, turnSeq) => {
    if (disposed || !config.enabled || state.turnOpen || running >= MAX_CONCURRENT) return
    if (state.inflight !== null || state.candidateTurnSeq !== turnSeq) return
    const eligibility = sessionEligible(session)
    if (!eligibility.ok) {
      publish(state, { status: 'ineligible', reason: eligibility.reason, text: null, turnSeq, candidateTurnSeq: null })
      return
    }
    const controller = new AbortController()
    state.inflight = controller
    state.turnSeq = turnSeq
    state.text = null
    state.reason = null
    state.status = 'pending'
    state.trigger = 'live'
    state.rev += 1
    running += 1
    const startedAt = Date.now()
    void predict(session, eligibility.messages, controller.signal, config, models, fetchImpl)
      .then((result) => {
        if (controller.signal.aborted || state.inflight !== controller || state.turnOpen || state.candidateTurnSeq !== turnSeq) return
        publish(state, {
          status: result.ok ? 'ready' : result.status,
          text: result.ok ? result.text : null,
          reason: result.ok ? null : result.reason,
          latencyMs: Date.now() - startedAt,
          candidateTurnSeq: null,
        })
      })
      .catch((error) => {
        if (controller.signal.aborted || state.inflight !== controller) return
        publish(state, { status: 'failed', text: null, reason: error?.code || 'exception', latencyMs: Date.now() - startedAt, candidateTurnSeq: null })
      })
      .finally(() => {
        running -= 1
        if (state.inflight === controller) state.inflight = null
      })
  }

  const onSessionEvent = (session, event) => {
    const sessionId = String(session?.id ?? '')
    if (!sessionId) return
    const state = stateOf(sessionId)
    state.session = session
    if (event?.type === 'turn/start') {
      state.turnOpen = true
      state.candidateTurnSeq = null
      abort(state)
      publish(state, { status: 'idle', text: null, turnSeq: null, reason: 'turn-open', trigger: null, latencyMs: null })
      return
    }
    if (event?.type !== 'turn/end') return
    state.turnOpen = false
    const reason = event.data?.reason?.kind
    const turnSeq = Number(event.seq)
    if (reason !== 'completed' || !Number.isSafeInteger(turnSeq)) {
      state.candidateTurnSeq = null
      publish(state, { status: 'none', text: null, turnSeq: Number.isSafeInteger(turnSeq) ? turnSeq : null, reason: reason || 'turn-not-completed' })
      return
    }
    state.candidateTurnSeq = turnSeq
    publish(state, { status: 'idle', text: null, turnSeq, reason: null, trigger: 'live', latencyMs: null })
  }

  const handleState = async (request) => {
    const url = new URL(request.url)
    const sessionId = url.searchParams.get('sessionId')?.trim() || ''
    if (!sessionId || sessionId.length > 256) return json({ error: { code: 'SESSION_ID_INVALID' } }, 400)
    const state = stateOf(sessionId)
    if (state.session === undefined) return json({ ...stateSnapshot(state), status: 'unknown-session', reason: 'unknown-session' })
    const revision = Number(url.searchParams.get('rev'))
    if (Number.isSafeInteger(revision) && revision >= state.rev) return json({ rev: state.rev, unchanged: true })
    if (state.candidateTurnSeq !== null && !state.turnOpen) schedule(state.session, state, state.candidateTurnSeq)
    return json(stateSnapshot(state))
  }

  const handleFeedback = async (request) => {
    const length = Number(request.headers.get('content-length'))
    if (Number.isFinite(length) && length > MAX_BODY_BYTES) return json({ error: { code: 'REQUEST_TOO_LARGE' } }, 413)
    const body = await request.text()
    if (Buffer.byteLength(body) > MAX_BODY_BYTES) return json({ error: { code: 'REQUEST_TOO_LARGE' } }, 413)
    let value
    try { value = JSON.parse(body) } catch { return json({ error: { code: 'INVALID_JSON' } }, 400) }
    const action = typeof value?.action === 'string' ? value.action : ''
    if (!['mounted', 'shown', 'accepted', 'dismissed', 'blocked', 'inactive', 'conflict'].includes(action)) {
      return json({ error: { code: 'INVALID_FEEDBACK' } }, 400)
    }
    return json({ ok: true })
  }

  const routeOwner = ctx.connection?.fetch
  if (routeOwner === undefined) throw new Error('prompt prediction requires DSH Connection fetch routes')
  const disposers = [
    routeOwner.register({ path: PROMPT_PREDICTION_STATE_PATH, methods: ['GET'], requestBody: 'buffered', fetch: handleState }),
    routeOwner.register({ path: PROMPT_PREDICTION_FEEDBACK_PATH, methods: ['POST'], requestBody: 'buffered', fetch: handleFeedback }),
    routeOwner.register({ path: PROMPT_PREDICTION_CONFIG_PATH, methods: ['GET'], requestBody: 'buffered', fetch: () => json({ enabled: config.enabled, promptVersion: config.promptVersion }) }),
  ]
  const offEvent = ctx.on('session/event', onSessionEvent)
  const offDisposed = ctx.on('session/disposed', session => {
    const id = String(session?.id ?? '')
    const state = states.get(id)
    if (state !== undefined) abort(state)
    states.delete(id)
  })
  return async () => {
    disposed = true
    offEvent?.()
    offDisposed?.()
    for (const dispose of disposers) await dispose()
    for (const state of states.values()) abort(state)
    states.clear()
  }
}

async function predict(session, messages, signal, config, models, fetchImpl) {
  if (!models?.profile) return { ok: false, status: 'ineligible', reason: 'model-service-unavailable' }
  const assistant = lastAssistantText(messages)
  const lastUser = [...messages].reverse().find(message => message?.role === 'user')
  const history = compactHistory(messages, config.compactTurns)
  if (history.length === 0 || assistant.length === 0) return { ok: false, status: 'ineligible', reason: 'no-history' }
  if (config.maxHistoryChars > 0 && history.reduce((sum, item) => sum + messageText(item).length, 0) > config.maxHistoryChars) {
    return { ok: false, status: 'ineligible', reason: 'history-too-large' }
  }
  const profile = await models.profile('')
  signal.throwIfAborted()
  const instruction = predictionInstruction({ exemplars: styleExemplars(messages), maxSuggestionChars: config.maxSuggestionChars, maxLines: 3 })
  const requestMessages = history.map(item => ({ role: item.role, content: messageText(item) }))
  const response = await fetchImpl(`${profile.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${profile.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: profile.modelName,
      messages: [...requestMessages, { role: 'user', content: instruction }],
      max_tokens: config.maxOutputTokens,
      temperature: 0.2,
      stream: false,
    }),
    signal,
    redirect: 'error',
  })
  if (!response.ok) return { ok: false, status: 'failed', reason: `model-${response.status}` }
  const body = await response.json()
  const raw = body?.choices?.[0]?.message?.content
  const parsed = parseSuggestion(typeof raw === 'string' ? raw : '', { maxSuggestionChars: config.maxSuggestionChars, previousAssistantText: assistant, lastUserText: messageText(lastUser) })
  return parsed.ok ? parsed : { ok: false, status: 'none', reason: parsed.reason }
}
