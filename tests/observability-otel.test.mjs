import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  buildOtlpPayload,
  caCertificateChain,
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
  assert.equal(config.certificatePath, '')
  assert.equal(config.caPem, 'pem')
})

test('pins the mounted OTel CA file and appends it to the platform roots', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'otel-ca-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const bundle = join(dir, 'ca-bundle.pem')
  const pem = '-----BEGIN CERTIFICATE-----\nfixture-langfuse-ca\n-----END CERTIFICATE-----\n'
  await writeFile(bundle, pem)

  const config = resolveObservabilityConfig({ ...baseEnv, OTEL_EXPORTER_OTLP_TRACES_CERTIFICATE: bundle })
  assert.equal(config.certificatePath, bundle)
  assert.equal(config.caPem, pem.trim())
  // Node replaces the default store when `ca` is set: the platform roots must
  // stay in front so the CloudMonitor secondary route keeps validating.
  const chain = caCertificateChain(config.caPem)
  assert.ok(chain.length > 1, 'platform roots must be preserved')
  assert.equal(chain.at(-1), pem.trim())
  assert.equal(caCertificateChain(''), undefined)

  // The generic OTel path is the fallback; both sources concatenate.
  const both = resolveObservabilityConfig({ ...baseEnv,
    OTEL_EXPORTER_OTLP_CERTIFICATE: bundle, DSH_OTEL_CA_PEM_BASE64: 'cGVt' })
  assert.match(both.caPem, /fixture-langfuse-ca/)
  assert.match(both.caPem, /^pem\n/)
  // An unreadable path must not disable export: the platform store still works.
  const missing = resolveObservabilityConfig({ ...baseEnv, OTEL_EXPORTER_OTLP_TRACES_CERTIFICATE: join(dir, 'missing.pem') })
  assert.equal(missing.caPem, '')
  assert.equal(caCertificateChain(missing.caPem), undefined)
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
const emitOn = (exporter, sessionId, type, data, time) => exporter.onSessionEvent({ id: sessionId }, { type, seq: 0, time, data })
const allSpans = sent => sent.flatMap(item => item.payload.resourceSpans[0].scopeSpans[0].spans)
const attributesOf = span => Object.fromEntries(span.attributes.map(item => [item.key, item.value]))

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

test('projects Codex tool lifecycles into step-scoped tool spans', async () => {
  const config = resolveObservabilityConfig(baseEnv)
  const sent = []
  const exporter = createOtelExporter(config, {
    now: () => 1000,
    send: async (url, headers, payload) => { sent.push({ url, payload }); return { ok: true, status: 200 } },
    logger: { warn() {} },
  })
  emit(exporter, 'turn/start', { turn: 1 }, 100)
  emit(exporter, 'step/start', { turn: 1, step: 1 }, 110)
  emit(exporter, 'agentkit/codex-tool', { callId: 'run:call-1', name: 'codex/command', phase: 'started', arguments: '{"command":"cat private-argument"}' }, 120)
  emit(exporter, 'agentkit/codex-tool', { callId: 'run:call-1', name: 'codex/command', phase: 'completed', arguments: '{"command":"cat private-argument"}', content: [{ type: 'text', text: 'private-result' }] }, 130)
  emit(exporter, 'step/end', { turn: 1, step: 1 }, 140)
  emit(exporter, 'turn/end', { turn: 1, reason: 'success' }, 150)
  await exporter.flush()
  exporter.stop()

  const spans = allSpans(sent)
  const generation = spans.find(span => span.name === 'chat')
  const tool = spans.find(span => span.name === 'execute_tool codex/command')
  assert.ok(tool, 'a Codex tool event produces a tool span')
  assert.equal(tool.parentSpanId, generation.spanId)
  const attributes = attributesOf(tool)
  assert.equal(attributes['langfuse.observation.type'].stringValue, 'tool')
  assert.equal(attributes['gen_ai.operation.name'].stringValue, 'execute_tool')
  assert.equal(attributes['gen_ai.tool.name'].stringValue, 'codex/command')
  assert.equal(attributes['dsh.tool.call_id'].stringValue, 'run:call-1')
  assert.equal(attributes['dsh.tool.phase'].stringValue, 'completed')
  assert.deepEqual(tool.status, { code: 1 })
  const serialized = JSON.stringify(sent.map(item => item.payload))
  assert.ok(!serialized.includes('private-argument'), 'tool arguments are never exported')
  assert.ok(!serialized.includes('private-result'), 'tool results are never exported')
})

test('marks a failed Codex tool span with its error identity and no content', async () => {
  const config = resolveObservabilityConfig(baseEnv)
  const sent = []
  const exporter = createOtelExporter(config, {
    now: () => 1000,
    send: async (url, headers, payload) => { sent.push({ url, payload }); return { ok: true, status: 200 } },
    logger: { warn() {} },
  })
  emit(exporter, 'turn/start', { turn: 1 }, 100)
  emit(exporter, 'step/start', { turn: 1, step: 1 }, 110)
  emit(exporter, 'agentkit/codex-tool', { callId: 'c1', name: 'codex/command', phase: 'started', arguments: 'private-argument' }, 120)
  emit(exporter, 'agentkit/codex-tool', { callId: 'c1', name: 'codex/command', phase: 'failed', arguments: 'private-argument',
    content: [{ type: 'text', text: 'private-result' }], error: { name: 'ToolError', code: 'CODEX_TOOL_FAILED', reason: 'private-reason' } }, 130)
  emit(exporter, 'agentkit/codex-tool', { callId: 'c2', name: 'codex/command', phase: 'started' }, 140)
  emit(exporter, 'agentkit/codex-tool', { callId: 'c2', name: 'codex/command', phase: 'failed', error: { name: 'Interrupted' } }, 150)
  await exporter.flush()
  exporter.stop()

  const spans = allSpans(sent)
  const coded = spans.find(span => span.attributes.some(item => item.key === 'dsh.tool.call_id' && item.value.stringValue === 'c1'))
  assert.deepEqual(coded.status, { code: 2 })
  const codedAttributes = attributesOf(coded)
  assert.equal(codedAttributes['dsh.tool.phase'].stringValue, 'failed')
  assert.equal(codedAttributes['error.type'].stringValue, 'CODEX_TOOL_FAILED')
  const named = spans.find(span => span.attributes.some(item => item.key === 'dsh.tool.call_id' && item.value.stringValue === 'c2'))
  assert.equal(attributesOf(named)['error.type'].stringValue, 'Interrupted', 'falls back to the error name')
  const serialized = JSON.stringify(sent.map(item => item.payload))
  for (const leaked of ['private-argument', 'private-result', 'private-reason']) assert.ok(!serialized.includes(leaked))
})

const invocationId = 'hh-0123456789abcdef0123456789abcdef'
const invocationTraceId = '0123456789abcdef0123456789abcdef'

test('associates spans with the run identity and uses the InvocationId hex as the trace id', async () => {
  const config = resolveObservabilityConfig(baseEnv)
  const sent = []
  const exporter = createOtelExporter(config, {
    now: () => 1000,
    send: async (url, headers, payload) => { sent.push({ url, payload }); return { ok: true, status: 200 } },
    logger: { warn() {} },
  })
  exporter.setRunIdentity({ nativeSessionId: 'runtime-native-1', platformSessionId: 'platform-session-1', invocationId,
    runId: 'run_identity_1', agentId: 'ar-1', versionId: 'version-1', runtimeName: 'codex' })
  emitOn(exporter, 'runtime-native-1', 'turn/start', { turn: 1 }, 100)
  emitOn(exporter, 'runtime-native-1', 'step/start', { turn: 1, step: 1 }, 110)
  emitOn(exporter, 'runtime-native-1', 'agentkit/codex-tool', { callId: 'c1', name: 'codex/command', phase: 'started' }, 120)
  emitOn(exporter, 'runtime-native-1', 'agentkit/codex-tool', { callId: 'c1', name: 'codex/command', phase: 'completed' }, 130)
  emitOn(exporter, 'runtime-native-1', 'step/end', { turn: 1, step: 1 }, 140)
  emitOn(exporter, 'runtime-native-1', 'turn/end', { turn: 1, reason: 'success' }, 150)
  await exporter.flush()
  exporter.stop()

  const spans = [...new Map(allSpans(sent).map(span => [span.spanId, span])).values()]
  assert.equal(spans.length, 3, 'turn, generation and tool spans')
  for (const span of spans) {
    assert.equal(span.traceId, invocationTraceId, 'every run span shares the InvocationId hex trace id')
    const attributes = attributesOf(span)
    assert.equal(attributes['agentengine.invocation_id'].stringValue, invocationId)
    assert.equal(attributes['agentengine.run_id'].stringValue, 'run_identity_1')
    assert.equal(attributes['agentengine.platform_session_id'].stringValue, 'platform-session-1')
    assert.equal(attributes['agentengine.agent_id'].stringValue, 'ar-1')
    assert.equal(attributes['agentengine.version_id'].stringValue, 'version-1')
    assert.equal(attributes['agentengine.runtime_name'].stringValue, 'codex')
  }
  const turn = spans.find(span => span.name === 'dsh.turn')
  assert.equal(turn.parentSpanId, undefined)
  const turnAttributes = attributesOf(turn)
  assert.equal(turnAttributes['langfuse.session.id'].stringValue, 'platform-session-1')
  assert.equal(turnAttributes['langfuse.trace.name'].stringValue, `run ${invocationId}`)
})

test('keeps the per-session trace id when the invocation is not a hex addressable id', async () => {
  const config = resolveObservabilityConfig(baseEnv)
  const sent = []
  const exporter = createOtelExporter(config, {
    now: () => 1000,
    send: async (url, headers, payload) => { sent.push({ url, payload }); return { ok: true, status: 200 } },
    logger: { warn() {} },
  })
  exporter.setRunIdentity({ nativeSessionId: 'runtime-native-2', platformSessionId: 'platform-session-2',
    invocationId: 'invocation-log', runId: 'run_identity_2', agentId: 'ar-1' })
  emitOn(exporter, 'runtime-native-2', 'turn/start', { turn: 1 }, 100)
  emitOn(exporter, 'runtime-native-2', 'turn/end', { turn: 1, reason: 'success' }, 110)
  await exporter.flush()
  exporter.stop()

  const turn = allSpans(sent).find(span => span.name === 'dsh.turn')
  assert.match(turn.traceId, /^[0-9a-f]{32}$/)
  assert.notEqual(turn.traceId, invocationTraceId)
  const attributes = attributesOf(turn)
  assert.equal(attributes['langfuse.session.id'].stringValue, 'platform-session-2')
  assert.equal(attributes['langfuse.trace.name'].stringValue, 'run invocation-log')
  assert.equal(attributes['agentengine.invocation_id'].stringValue, 'invocation-log')
})

test('a new run rebinds the session trace id and clear restores the session fallback', async () => {
  const config = resolveObservabilityConfig({ ...baseEnv, CLOUD_MONITOR_OTLP_TRACES_ENDPOINT: '' })
  const sent = []
  const exporter = createOtelExporter(config, {
    now: () => 1000,
    send: async (url, headers, payload) => { sent.push({ url, payload }); return { ok: true, status: 200 } },
    logger: { warn() {} },
  })
  const firstTraceId = 'a'.repeat(32), secondTraceId = 'b'.repeat(32)
  exporter.setRunIdentity({ nativeSessionId: 'runtime-multi', platformSessionId: 'platform-a',
    invocationId: `hh-${firstTraceId}`, runId: 'run-1' })
  emitOn(exporter, 'runtime-multi', 'turn/start', { turn: 1 }, 100)
  emitOn(exporter, 'runtime-multi', 'turn/end', { turn: 1, reason: 'success' }, 110)
  await exporter.flush()
  assert.equal(allSpans(sent).find(span => span.name === 'dsh.turn').traceId, firstTraceId)

  exporter.setRunIdentity({ nativeSessionId: 'runtime-multi', platformSessionId: 'platform-b',
    invocationId: `hh-${secondTraceId}`, runId: 'run-2' })
  emitOn(exporter, 'runtime-multi', 'turn/start', { turn: 2 }, 200)
  emitOn(exporter, 'runtime-multi', 'turn/end', { turn: 2, reason: 'success' }, 210)
  await exporter.flush()
  const secondTurn = allSpans(sent).filter(span => span.name === 'dsh.turn').at(-1)
  assert.equal(secondTurn.traceId, secondTraceId)
  assert.equal(attributesOf(secondTurn)['langfuse.session.id'].stringValue, 'platform-b')

  exporter.clearRunIdentity('runtime-multi')
  emitOn(exporter, 'runtime-multi', 'turn/start', { turn: 3 }, 300)
  emitOn(exporter, 'runtime-multi', 'turn/end', { turn: 3, reason: 'success' }, 310)
  await exporter.flush()
  exporter.stop()
  const lastTurn = allSpans(sent).filter(span => span.name === 'dsh.turn').at(-1)
  assert.match(lastTurn.traceId, /^[0-9a-f]{32}$/)
  assert.ok(![firstTraceId, secondTraceId].includes(lastTurn.traceId))
  const attributes = attributesOf(lastTurn)
  assert.equal(attributes['langfuse.session.id'].stringValue, 'runtime-multi')
  assert.equal(attributes['agentengine.invocation_id'], undefined)
  assert.equal(attributes['langfuse.trace.name'], undefined)
})

test('keeps the session trace id and exports no identity attributes without a run identity', async () => {
  const config = resolveObservabilityConfig(baseEnv)
  const sent = []
  const exporter = createOtelExporter(config, {
    now: () => 1000,
    send: async (url, headers, payload) => { sent.push({ url, payload }); return { ok: true, status: 200 } },
    logger: { warn() {} },
  })
  emit(exporter, 'turn/start', { turn: 1 }, 100)
  emit(exporter, 'turn/end', { turn: 1, reason: 'success' }, 110)
  await exporter.flush()
  exporter.stop()

  const turn = allSpans(sent).find(span => span.name === 'dsh.turn')
  assert.match(turn.traceId, /^[0-9a-f]{32}$/)
  const keys = turn.attributes.map(item => item.key)
  assert.ok(!keys.some(key => key.startsWith('agentengine.')))
  assert.ok(!keys.includes('langfuse.trace.name'))
  assert.equal(attributesOf(turn)['langfuse.session.id'].stringValue, 'session-1')
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
