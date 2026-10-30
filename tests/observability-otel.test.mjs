import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildOtlpPayload,
  createOtelExporter,
  installManagedObservability,
  parseOtelHeaders,
  parseResourceAttributes,
  resolveObservabilityConfig,
} from '../src/observability-otel.mjs'

const baseEnv = {
  AGENTENGINE_MANAGED_RUNTIME_NAME: 'dsh-native',
  AGENTENGINE_AGENT_ID: 'ar-1',
  OTEL_EXPORTER_OTLP_ENDPOINT: 'https://langfuse.example/api/public/otel',
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'https://langfuse.example/api/public/otel/v1/traces',
  OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Basic%20cGs6c2s=,x-langfuse-ingestion-version=4',
  OTEL_SERVICE_NAME: 'agent-runtime-1',
  OTEL_RESOURCE_ATTRIBUTES: 'agentengine.agent_id=ar-1,agentengine.framework=dsh-native',
  CLOUD_MONITOR_OTLP_TRACES_ENDPOINT: 'https://cloudmonitor.example/v1/traces',
  CLOUD_MONITOR_OTLP_HEADERS: 'Ksc-Appkey=app-1',
}

test('resolves the managed bundle only for a managed runtime', () => {
  assert.equal(resolveObservabilityConfig({}), null)
  assert.ok(resolveObservabilityConfig({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'https://x', AGENTENGINE_AGENT_ID: 'ar-1' }))
  assert.equal(resolveObservabilityConfig({ ...baseEnv, OTEL_EXPORTER_OTLP_ENDPOINT: '', OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: '' }), null)
  // A desktop session with a developer-provided OTEL env must stay a no-op.
  assert.equal(resolveObservabilityConfig({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'https://x' }), null)
})

test('parses the primary route, secondary route and pinned CA', () => {
  const config = resolveObservabilityConfig({ ...baseEnv, DSH_OTEL_CA_PEM_BASE64: 'cGVt' })
  assert.equal(config.primary.url, 'https://langfuse.example/api/public/otel/v1/traces')
  assert.equal(config.primary.headers.Authorization, 'Basic cGs6c2s=')
  assert.equal(config.primary.headers['x-langfuse-ingestion-version'], '4')
  assert.equal(config.secondary.url, 'https://cloudmonitor.example/v1/traces')
  assert.equal(config.secondary.headers['Ksc-Appkey'], 'app-1')
  assert.equal(config.serviceName, 'agent-runtime-1')
  assert.equal(config.resourceAttributes['agentengine.framework'], 'dsh-native')
  assert.equal(config.caPemBase64, 'cGVt')
})

test('derives the traces endpoint and header/resource encodings', () => {
  const config = resolveObservabilityConfig({ ...baseEnv, OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: '' })
  assert.equal(config.primary.url, 'https://langfuse.example/api/public/otel/v1/traces')
  assert.deepEqual(parseOtelHeaders('A=1,B=2%20C'), { A: '1', B: '2 C' })
  assert.deepEqual(parseResourceAttributes('a=1,b=2'), { a: '1', b: '2' })
})

test('builds OTLP/HTTP JSON with numeric integer attributes for Langfuse', () => {
  const payload = buildOtlpPayload([{
    traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), name: 'chat',
    startTimeUnixNano: 1, endTimeUnixNano: 2,
    attributes: { 'gen_ai.usage.input_tokens': 12, 'gen_ai.request.model': 'm' },
  }], { serviceName: 'svc', resourceAttributes: { 'agentengine.agent_id': 'ar-1' } })
  const span = payload.resourceSpans[0].scopeSpans[0].spans[0]
  assert.deepEqual(span.attributes.find(a => a.key === 'gen_ai.usage.input_tokens').value, { intValue: 12 })
  assert.deepEqual(span.attributes.find(a => a.key === 'gen_ai.request.model').value, { stringValue: 'm' })
  assert.equal(payload.resourceSpans[0].resource.attributes.find(a => a.key === 'service.name').value.stringValue, 'svc')
})

const session = { id: 'session-1' }
const emit = (exporter, type, data, time) => exporter.onSessionEvent(session, { type, seq: 0, time, data })

test('projects real session events into a turn, generation and tool span', async () => {
  const config = resolveObservabilityConfig(baseEnv)
  const sent = []
  const exporter = createOtelExporter(config, {
    now: () => 1000,
    send: async (url, headers, payload, ca) => { sent.push({ url, headers, payload, ca }); return { ok: true, status: 200 } },
    logger: { warn() {} },
  })
  emit(exporter, 'request/context', { provider: 'ksyun', model: 'deepseek-v4.1-flash' }, 100)
  emit(exporter, 'turn/start', { turn: 1 }, 110)
  emit(exporter, 'step/start', { turn: 1, step: 1 }, 120)
  emit(exporter, 'tool/call', { turn: 1, step: 1, callId: 'call-1', name: 'read_file', arguments: '{}' }, 130)
  emit(exporter, 'tool/result', { turn: 1, step: 1, message: { toolCallId: 'call-1', isError: false } }, 140)
  emit(exporter, 'assistant/message', {
    turn: 1, step: 1, message: { role: 'assistant' }, stream: [],
    usage: { inputTokens: 1234, outputTokens: 56, totalTokens: 1290, cacheReadTokens: 100 },
  }, 150)
  emit(exporter, 'step/end', { turn: 1, step: 1 }, 160)
  await exporter.flush()
  exporter.stop()

  assert.equal(sent.length, 2, 'dual-writes Langfuse and CloudMonitor')
  assert.deepEqual(sent.map(item => item.url).sort(), [
    'https://cloudmonitor.example/v1/traces', 'https://langfuse.example/api/public/otel/v1/traces',
  ])
  const spans = sent[0].payload.resourceSpans[0].scopeSpans[0].spans
  assert.equal(spans.length, 2, 'tool span and generation span (turn still open)')
  const generation = spans.find(span => span.name === 'chat')
  assert.equal(generation.parentSpanId.length, 16)
  const attributes = Object.fromEntries(generation.attributes.map(item => [item.key, item.value]))
  assert.equal(attributes['gen_ai.usage.input_tokens'].intValue, 1234)
  assert.equal(attributes['gen_ai.usage.output_tokens'].intValue, 56)
  assert.equal(attributes['gen_ai.usage.total_tokens'].intValue, 1290)
  assert.equal(attributes['gen_ai.request.model'].stringValue, 'deepseek-v4.1-flash')
  assert.equal(attributes['langfuse.observation.type'].stringValue, 'generation')
  const tool = spans.find(span => span.name === 'execute_tool read_file')
  assert.equal(tool.parentSpanId, generation.spanId)
  assert.deepEqual(tool.status, { code: 1 })

  emit(exporter, 'turn/end', { turn: 1, reason: 'success' }, 170)
  await exporter.flush()
  exporter.stop()
  const turn = sent.at(-1).payload.resourceSpans[0].scopeSpans[0].spans[0]
  assert.equal(turn.name, 'dsh.turn')
  assert.equal(turn.parentSpanId, undefined)
})

test('keeps failed tool results and never emits content attributes', async () => {
  const config = resolveObservabilityConfig(baseEnv)
  const sent = []
  const exporter = createOtelExporter(config, {
    now: () => 1000,
    send: async (url, headers, payload) => { sent.push({ url, payload }); return { ok: true, status: 200 } },
    logger: { warn() {} },
  })
  emit(exporter, 'turn/start', { turn: 1 }, 100)
  emit(exporter, 'step/start', { turn: 1, step: 1 }, 110)
  emit(exporter, 'tool/call', { turn: 1, step: 1, callId: 'c2', name: 'shell', arguments: '{"secret":"x"}' }, 120)
  emit(exporter, 'tool/result', { turn: 1, step: 1, message: { toolCallId: 'c2', isError: true }, error: { name: 'ToolError', code: 'TOOL_FAILED' } }, 130)
  await exporter.flush()
  exporter.stop()
  const spans = sent[0].payload.resourceSpans[0].scopeSpans[0].spans
  const tool = spans.find(span => span.name === 'execute_tool shell')
  assert.deepEqual(tool.status, { code: 2 })
  const serialized = JSON.stringify(sent[0].payload)
  assert.ok(!serialized.includes('secret'), 'arguments are never exported')
  assert.ok(!serialized.includes('messages'), 'message content is never exported')
})

test('installManagedObservability self-gates and registers a session listener', () => {
  const saved = { ...process.env }
  try {
    for (const key of Object.keys(process.env)) if (key.startsWith('OTEL_') || key.startsWith('CLOUD_MONITOR_') || key.startsWith('AGENTENGINE_') || key.startsWith('DSH_')) delete process.env[key]
    const handlers = new Map()
    const ctx = { on: (event, handler) => { handlers.set(event, handler) }, effect: fn => fn() }
    assert.equal(installManagedObservability(ctx), null)
    assert.equal(handlers.size, 0)

    Object.assign(process.env, baseEnv)
    const exporter = installManagedObservability(ctx)
    assert.ok(exporter)
    assert.equal(handlers.has('session/event'), true)
    handlers.get('session/event')({ id: 's' }, { type: 'turn/start', time: 1, data: { turn: 1 } })
    assert.equal(exporter.pendingCount, 0, 'an open span is not exported yet')
    exporter.stop()
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
    Object.assign(process.env, saved)
  }
})
