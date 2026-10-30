/**
 * Managed OTLP trace exporter for the AgentKit Studio runtime.
 *
 * The platform injects a managed observability env bundle into managed runtime
 * pods (`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` + `OTEL_EXPORTER_OTLP_HEADERS`, and
 * the CloudMonitor secondary route). Studio's managed Host filters its child
 * environment, so the bundle only reaches this plugin when the launcher
 * forwards it (see `managed-runtime-host.mjs`). Without an endpoint the plugin
 * registers nothing and the Host behaves exactly as before.
 *
 * Spans are generated from the public DSH session event stream:
 *   - one `dsh.turn` span per turn,
 *   - one Langfuse generation span per model step (`step/start`..`step/end`),
 *   - one tool span per `tool/call`..`tool/result`.
 *
 * The exporter speaks OTLP/HTTP JSON directly (no OpenTelemetry SDK
 * dependency). Prompt and completion text is never exported: only model,
 * provider, token usage, tool names and error identity, so enabling
 * observability cannot leak conversation content.
 */
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { randomBytes } from 'node:crypto'

export const name = 'agentkit-studio-observability-otel'

const SCOPE_NAME = 'agentengine.dsh-observability'
const SCOPE_VERSION = '1'
const FLUSH_INTERVAL_MILLIS = 3000
const REQUEST_TIMEOUT_MILLIS = 5000
const MAX_BUFFERED_SPANS = 512
const FAILURE_LOG_INTERVAL_MILLIS = 60000

/** Parses an OTel header list ("k=v,k2=v2", values percent-encoded). */
export function parseOtelHeaders(value) {
  const headers = {}
  if (typeof value !== 'string') return headers
  for (const part of value.split(',')) {
    const index = part.indexOf('=')
    if (index <= 0) continue
    const key = part.slice(0, index).trim()
    const raw = part.slice(index + 1).trim()
    if (!key) continue
    let decoded = raw
    try { decoded = decodeURIComponent(raw) } catch { /* keep the raw value */ }
    headers[key] = decoded
  }
  return headers
}

/** Parses `OTEL_RESOURCE_ATTRIBUTES` ("k=v,k2=v2"). */
export function parseResourceAttributes(value) {
  const attributes = {}
  if (typeof value !== 'string') return attributes
  for (const part of value.split(',')) {
    const index = part.indexOf('=')
    if (index <= 0) continue
    const key = part.slice(0, index).trim()
    if (!key) continue
    attributes[key] = part.slice(index + 1).trim()
  }
  return attributes
}

function resolveTracesEndpoint(env) {
  const explicit = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim()
  const base = env.OTEL_EXPORTER_OTLP_ENDPOINT
  if (typeof base === 'string' && base.trim()) return `${base.trim().replace(/\/+$/, '')}/v1/traces`
  return ''
}

/**
 * Resolves the managed exporter configuration from the process environment.
 * Returns null when the platform did not enable managed tracing, which keeps
 * the plugin a no-op for local/desktop sessions.
 */
export function resolveObservabilityConfig(env = process.env) {
  // Never export from an interactive desktop session: only a managed runtime
  // carries the platform identity and the injected observability bundle.
  if (!env.AGENTENGINE_MANAGED_RUNTIME_NAME && !env.AGENTENGINE_AGENT_ID) return null
  const primaryUrl = resolveTracesEndpoint(env)
  if (!primaryUrl) return null
  const primaryHeaders = {
    ...parseOtelHeaders(env.OTEL_EXPORTER_OTLP_TRACES_HEADERS || env.OTEL_EXPORTER_OTLP_HEADERS),
  }
  const primary = { url: primaryUrl, headers: primaryHeaders }
  const secondaryUrl = typeof env.CLOUD_MONITOR_OTLP_TRACES_ENDPOINT === 'string'
    ? env.CLOUD_MONITOR_OTLP_TRACES_ENDPOINT.trim()
    : ''
  const secondary = secondaryUrl
    ? {
        url: secondaryUrl,
        headers: parseOtelHeaders(env.CLOUD_MONITOR_OTLP_TRACES_HEADERS || env.CLOUD_MONITOR_OTLP_HEADERS),
      }
    : null
  const serviceName = (typeof env.OTEL_SERVICE_NAME === 'string' && env.OTEL_SERVICE_NAME.trim())
    ? env.OTEL_SERVICE_NAME.trim()
    : SCOPE_NAME
  // A private/self-signed Langfuse endpoint trusts exactly one pinned anchor
  // instead of disabling verification. This env is only meaningful when a
  // deployment cannot publish a publicly trusted certificate.
  const caPemBase64 = typeof env.DSH_OTEL_CA_PEM_BASE64 === 'string' ? env.DSH_OTEL_CA_PEM_BASE64.trim() : ''
  return {
    primary,
    secondary,
    serviceName,
    resourceAttributes: parseResourceAttributes(env.OTEL_RESOURCE_ATTRIBUTES),
    caPemBase64,
    captureContent: ['1', 'true', 'yes', 'on'].includes(String(env.DSH_OBSERVABILITY_CAPTURE_CONTENT || '').toLowerCase()),
  }
}

const stringAttribute = value => ({ stringValue: String(value) })
// Langfuse's OTLP/JSON decoder rejects the spec's int64-as-string form and
// silently drops those attributes, so emit JSON numbers here (still exact for
// token counts and turn/step numbers, which stay far below 2^53).
const intAttribute = value => ({ intValue: Math.max(0, Math.trunc(Number(value) || 0)) })

function attributesToOtel(attributes) {
  return Object.entries(attributes)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => ({
      key,
      value: typeof value === 'number' ? intAttribute(value) : stringAttribute(value),
    }))
}

/** Builds the OTLP/HTTP JSON body for a batch of finished span records. */
export function buildOtlpPayload(spans, { serviceName, resourceAttributes = {} } = {}) {
  return {
    resourceSpans: [{
      resource: {
        attributes: attributesToOtel({
          'service.name': serviceName || SCOPE_NAME,
          'telemetry.sdk.name': SCOPE_NAME,
          'telemetry.sdk.language': 'nodejs',
          ...resourceAttributes,
        }),
      },
      scopeSpans: [{
        scope: { name: SCOPE_NAME, version: SCOPE_VERSION },
        spans: spans.map(span => ({
          traceId: span.traceId,
          spanId: span.spanId,
          ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
          name: span.name,
          kind: 1,
          startTimeUnixNano: String(span.startTimeUnixNano),
          endTimeUnixNano: String(span.endTimeUnixNano),
          attributes: attributesToOtel(span.attributes || {}),
          status: { code: span.error ? 2 : 1 },
        })),
      }],
    }],
  }
}

function postJson(url, headers, body, caPemBase64) {
  return new Promise(resolve => {
    let parsed
    try { parsed = new URL(url) } catch { resolve({ ok: false, error: 'invalid endpoint url' }); return }
    const transport = parsed.protocol === 'https:' ? httpsRequest : parsed.protocol === 'http:' ? httpRequest : null
    if (!transport) { resolve({ ok: false, error: `unsupported protocol ${parsed.protocol}` }); return }
    const payload = Buffer.from(JSON.stringify(body))
    const options = {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': payload.length, ...headers },
      timeout: REQUEST_TIMEOUT_MILLIS,
    }
    if (parsed.protocol === 'https:' && caPemBase64) {
      try { options.ca = Buffer.from(caPemBase64, 'base64') } catch { /* fall back to the system store */ }
    }
    const req = transport(parsed, options, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => resolve({
        ok: res.statusCode >= 200 && res.statusCode < 300,
        status: res.statusCode,
        body: Buffer.concat(chunks).toString('utf8').slice(0, 300),
      }))
    })
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', error => resolve({ ok: false, error: String(error?.message || error) }))
    req.end(payload)
  })
}

class SessionTraceState {
  constructor(sessionId) {
    this.sessionId = sessionId
    this.traceId = randomBytes(16).toString('hex')
    this.turn = null
    this.step = null
    this.tools = new Map()
    this.model = ''
    this.provider = ''
  }
}

/**
 * Creates the exporter instance. `send` is injectable so tests never open a
 * socket; production uses {@link postJson} with the resolved endpoints.
 */
export function createOtelExporter(config, { now = () => Date.now(), send = postJson, logger = console } = {}) {
  const pending = []
  let timer = null
  let lastFailureAt = 0
  const sessions = new Map()
  const targets = [config.primary, config.secondary].filter(Boolean)

  const warn = (message, error) => {
    const timestamp = now()
    if (timestamp - lastFailureAt < FAILURE_LOG_INTERVAL_MILLIS) return
    lastFailureAt = timestamp
    try { (logger.warn || logger.error || console.warn).call(logger, `[observability-otel] ${message}`, error || '') } catch { /* logging must never fail the Host */ }
  }

  const flush = async () => {
    if (timer) { clearTimeout(timer); timer = null }
    if (pending.length === 0) return
    const spans = pending.splice(0, pending.length)
    const payload = buildOtlpPayload(spans, config)
    await Promise.all(targets.map(async target => {
      try {
        const result = await send(target.url, target.headers, payload, config.caPemBase64)
        if (!result.ok) warn(`trace export rejected by ${target.url}`, result.status ? `status ${result.status} ${result.body || ''}` : result.error)
      } catch (error) {
        warn(`trace export failed for ${target.url}`, error)
      }
    }))
  }

  const schedule = () => {
    if (timer || pending.length === 0) return
    timer = setTimeout(() => { timer = null; void flush() }, FLUSH_INTERVAL_MILLIS)
    if (typeof timer.unref === 'function') timer.unref()
  }

  const push = span => {
    if (pending.length >= MAX_BUFFERED_SPANS) pending.shift()
    pending.push(span)
    schedule()
  }

  const nanos = milliseconds => milliseconds * 1e6

  const startSpan = (state, spanName, startMs, parentSpanId, attributes) => ({
    traceId: state.traceId,
    spanId: randomBytes(8).toString('hex'),
    parentSpanId,
    name: spanName,
    startTimeUnixNano: nanos(startMs),
    endTimeUnixNano: 0,
    attributes,
  })

  const finishSpan = (span, endMs, extraAttributes = {}, error = false) => {
    span.endTimeUnixNano = nanos(Math.max(endMs, span.startTimeUnixNano / 1e6))
    Object.assign(span.attributes, extraAttributes)
    if (error) span.error = true
    push(span)
  }

  const stateFor = sessionId => {
    let state = sessions.get(sessionId)
    if (!state) {
      state = new SessionTraceState(sessionId)
      sessions.set(sessionId, state)
      // A long-lived Host must not accumulate one entry per session forever.
      if (sessions.size > 256) sessions.delete(sessions.keys().next().value)
    }
    return state
  }

  const onSessionEvent = (session, event) => {
    const sessionId = session?.id
    if (typeof sessionId !== 'string' || !sessionId) return
    const data = event?.data || {}
    const state = stateFor(sessionId)
    const eventTime = typeof event.time === 'number' ? event.time : now()
    switch (event.type) {
      case 'request/context':
        if (typeof data.model === 'string') state.model = data.model
        if (typeof data.provider === 'string') state.provider = data.provider
        return
      case 'turn/start': {
        if (state.turn) finishSpan(state.turn.span, eventTime)
        state.turn = { span: startSpan(state, 'dsh.turn', eventTime, '', { 'langfuse.observation.type': 'span', 'langfuse.session.id': sessionId, 'dsh.turn.number': data.turn }), startMs: eventTime }
        return
      }
      case 'step/start': {
        const parentSpanId = state.turn?.span.spanId || ''
        state.step = {
          span: startSpan(state, 'chat', eventTime, parentSpanId, {
            'langfuse.observation.type': 'generation',
            'gen_ai.operation.name': 'chat',
            'dsh.turn.number': data.turn,
            'dsh.step.number': data.step,
          }),
          startMs: eventTime,
          usage: undefined,
        }
        return
      }
      case 'assistant/message': {
        if (state.step && state.step.span.attributes['dsh.step.number'] === data.step) state.step.usage = data.usage
        return
      }
      case 'tool/call': {
        const parentSpanId = state.step?.span.spanId || ''
        state.tools.set(data.callId, {
          span: startSpan(state, `execute_tool ${data.name || 'tool'}`, eventTime, parentSpanId, {
            'langfuse.observation.type': 'tool',
            'gen_ai.operation.name': 'execute_tool',
            'gen_ai.tool.name': data.name || '',
            'dsh.tool.call_id': data.callId,
          }),
          startMs: eventTime,
        })
        return
      }
      case 'tool/result': {
        const callId = data.message?.toolCallId || data.callId
        const call = state.tools.get(callId)
        if (!call) return
        state.tools.delete(callId)
        const failed = Boolean(data.error) || data.message?.isError === true
        finishSpan(call.span, eventTime, failed && data.error?.code ? { 'error.type': data.error.code } : {}, failed)
        return
      }
      case 'step/end': {
        if (!state.step) return
        const step = state.step
        state.step = null
        const attributes = {
          'gen_ai.request.model': state.model,
          'gen_ai.system': state.provider,
        }
        if (step.usage) {
          attributes['gen_ai.usage.input_tokens'] = Number(step.usage.inputTokens) || 0
          attributes['gen_ai.usage.output_tokens'] = Number(step.usage.outputTokens) || 0
          if (step.usage.totalTokens !== undefined) attributes['gen_ai.usage.total_tokens'] = Number(step.usage.totalTokens) || 0
          if (step.usage.cacheReadTokens !== undefined) attributes['gen_ai.usage.cache_read_tokens'] = Number(step.usage.cacheReadTokens) || 0
        }
        if (state.model) attributes['langfuse.observation.model.name'] = state.model
        finishSpan(step.span, eventTime, attributes)
        void flush()
        return
      }
      case 'turn/end': {
        if (state.turn) {
          finishSpan(state.turn.span, eventTime, { 'dsh.turn.reason': data.reason || '' })
          state.turn = null
        }
        state.step = null
        state.tools.clear()
        void flush()
        return
      }
      default:
        return
    }
  }

  return {
    onSessionEvent,
    flush,
    stop() { if (timer) { clearTimeout(timer); timer = null } },
    get pendingCount() { return pending.length },
  }
}

/**
 * Mounts managed tracing on a Cordis context. Returns null when the platform
 * did not inject a managed observability bundle, so callers can stay silent.
 */
export function installManagedObservability(ctx) {
  const config = resolveObservabilityConfig(process.env)
  if (!config) return null
  const exporter = createOtelExporter(config, { logger: ctx?.logger || console })
  ctx.on('session/event', (session, event) => {
    try { exporter.onSessionEvent(session, event) } catch (error) { console.warn('[observability-otel] session event failed', error) }
  })
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => async () => { await exporter.flush(); exporter.stop() })
  }
  return exporter
}

/** Cordis plugin entry used when this module is mounted as its own row. */
export function apply(ctx) {
  installManagedObservability(ctx)
}
