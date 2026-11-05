import assert from 'node:assert/strict'
import test from 'node:test'
import { createPromptPredictionHost, PROMPT_PREDICTION_FEEDBACK_PATH, PROMPT_PREDICTION_STATE_PATH } from '../src/prompt-prediction/host.mjs'

function message(role, text, source = role === 'assistant' ? { kind: 'model', provider: 'ksyun', model: 'flash' } : { kind: 'user' }) {
  return { role, source, content: [{ type: 'text', text }] }
}

function harness({ response = '{"suggestion":"继续跑测试"}', header = { config: { provider: 'ksyun', model: 'flash' } }, fetch: customFetch } = {}) {
  const routes = new Map()
  const listeners = new Map()
  const calls = []
  const session = {
    id: 'session-1', header: {}, requestHeader: () => header,
    deriveMessages: () => [message('user', '请分析代码'), message('assistant', '我已经列出修改步骤。')],
  }
  const ctx = {
    connection: { fetch: { register(route) { routes.set(route.path, route); return async () => routes.delete(route.path) } } },
    on(name, handler) { const list = listeners.get(name) ?? []; list.push(handler); listeners.set(name, list); return () => list.splice(list.indexOf(handler), 1) },
    emit(name, ...args) { for (const handler of listeners.get(name) ?? []) handler(...args) },
  }
  const models = { profile: async () => ({ baseUrl: 'https://model.invalid/v1', apiKey: 'secret', modelName: 'flash' }) }
  const fetchImpl = customFetch ?? (async (_url, options) => {
    calls.push(JSON.parse(options.body))
    return Response.json({ choices: [{ message: { content: response } }] })
  })
  const dispose = createPromptPredictionHost(ctx, { models, fetchImpl, env: { AGENTKIT_PROMPT_PREDICTION_AUDIT: '0' } })
  return { ctx, routes, calls, session, dispose }
}

async function readState(h, rev = -1) {
  const route = h.routes.get(PROMPT_PREDICTION_STATE_PATH)
  return (await route.fetch(new Request(`http://localhost${PROMPT_PREDICTION_STATE_PATH}?sessionId=session-1&rev=${rev}`))).json()
}

test('schedules only after a completed native turn and serves a bounded suggestion', async () => {
  const h = harness()
  h.ctx.emit('session/event', h.session, { type: 'turn/end', seq: 9, data: { reason: { kind: 'completed' } } })
  let state
  for (let attempt = 0; attempt < 20; attempt += 1) {
    state = await readState(h)
    if (state.status === 'ready') break
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.equal(state.status, 'ready')
  assert.equal(state.text, '继续跑测试')
  assert.equal(h.calls.length, 1)
  assert.match(h.calls[0].messages.at(-1).content, /Composer prediction/u)
  await h.dispose()
})

test('turn start invalidates an in-flight prediction and derived routes stay ineligible', async () => {
  const h = harness({ header: { config: { provider: 'agentkit-studio-cloud', model: 'cloud' } } })
  h.ctx.emit('session/event', h.session, { type: 'turn/end', seq: 9, data: { reason: { kind: 'completed' } } })
  const before = await readState(h)
  assert.equal(before.status, 'ineligible')
  assert.equal(before.reason, 'unsupported-route')
  assert.equal(h.calls.length, 0)
  await h.dispose()

  const slow = harness()
  slow.routes.get(PROMPT_PREDICTION_STATE_PATH)
  slow.ctx.emit('session/event', slow.session, { type: 'turn/end', seq: 9, data: { reason: { kind: 'completed' } } })
  const pending = await readState(slow)
  assert.ok(['pending', 'ready'].includes(pending.status))
  slow.ctx.emit('session/event', slow.session, { type: 'turn/start', seq: 10, data: { turn: 2 } })
  const cleared = await readState(slow)
  assert.equal(cleared.status, 'idle')
  await slow.dispose()
})

test('feedback rejects oversized or unknown payloads without echoing text', async () => {
  const h = harness()
  const route = h.routes.get(PROMPT_PREDICTION_FEEDBACK_PATH)
  const invalid = await route.fetch(new Request('http://localhost' + PROMPT_PREDICTION_FEEDBACK_PATH, {
    method: 'POST', body: JSON.stringify({ action: 'unknown' }),
  }))
  assert.equal(invalid.status, 400)
  const oversized = await route.fetch(new Request('http://localhost' + PROMPT_PREDICTION_FEEDBACK_PATH, {
    method: 'POST', body: JSON.stringify({ action: 'shown', text: 'x'.repeat(20000) }),
  }))
  assert.equal(oversized.status, 413)
  await h.dispose()
})

function multiSessionHarness(fetchImpl) {
  const routes = new Map()
  const listeners = new Map()
  const sessions = new Map()
  const ctx = {
    connection: { fetch: { register(route) { routes.set(route.path, route); return async () => routes.delete(route.path) } } },
    on(name, handler) {
      const list = listeners.get(name) ?? []
      list.push(handler)
      listeners.set(name, list)
      return () => list.splice(list.indexOf(handler), 1)
    },
    emit(name, ...args) { for (const handler of listeners.get(name) ?? []) handler(...args) },
  }
  const models = { profile: async () => ({ baseUrl: 'https://model.invalid/v1', apiKey: 'secret', modelName: 'flash' }) }
  const dispose = createPromptPredictionHost(ctx, { models, fetchImpl, env: { AGENTKIT_PROMPT_PREDICTION_AUDIT: '0' } })
  const session = (id) => {
    if (!sessions.has(id)) {
      sessions.set(id, {
        id,
        header: {},
        requestHeader: () => ({ config: { provider: 'ksyun', model: 'flash' } }),
        deriveMessages: () => [message('user', '请分析代码'), message('assistant', '我已经列出修改步骤。')],
      })
    }
    return sessions.get(id)
  }
  const read = async (id, rev = -1) => (await routes.get(PROMPT_PREDICTION_STATE_PATH).fetch(
    new Request(`http://localhost${PROMPT_PREDICTION_STATE_PATH}?sessionId=${id}&rev=${rev}`),
  )).json()
  return { ctx, session, read, dispose }
}

const settle = async () => { for (let i = 0; i < 8; i += 1) await new Promise(resolve => setImmediate(resolve)) }

test('a poll holding the current revision still starts a prediction blocked by MAX_CONCURRENT', async () => {
  const gates = []
  const calls = []
  const fetchImpl = async (_url, options) => {
    calls.push(JSON.parse(options.body))
    if (calls.length <= 2) await new Promise(resolve => gates.push(resolve))
    return Response.json({ choices: [{ message: { content: '{"suggestion":"继续跑测试"}' } }] })
  }
  const h = multiSessionHarness(fetchImpl)
  for (const id of ['session-a', 'session-b']) {
    h.ctx.emit('session/event', h.session(id), { type: 'turn/end', seq: 9, data: { reason: { kind: 'completed' } } })
    assert.equal((await h.read(id)).status, 'pending')
  }
  await settle()
  assert.equal(calls.length, 2)

  // Both slots are saturated, so the third session receives an idle snapshot and stores
  // that revision — the state a polling client is in right before this bug froze it.
  const sessionC = h.session('session-c')
  h.ctx.emit('session/event', sessionC, { type: 'turn/end', seq: 9, data: { reason: { kind: 'completed' } } })
  const blocked = await h.read('session-c')
  assert.equal(blocked.status, 'idle')
  assert.equal(calls.length, 2)

  for (const gate of gates) gate()
  await settle()

  const retried = await h.read('session-c', blocked.rev)
  assert.ok(['pending', 'ready'].includes(retried.status), `expected the poll to schedule, got ${retried.status}`)
  assert.equal(calls.length, 3)
  await settle()
  const settled = await h.read('session-c', retried.rev)
  assert.equal(settled.status, 'ready')
  assert.equal(settled.text, '继续跑测试')
  await h.dispose()
})

test('a gateway that never answers releases its slot instead of pinning the host', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const calls = []
  const fetchImpl = (_url, options) => {
    calls.push(1)
    if (calls.length > 1) return Promise.resolve(Response.json({ choices: [{ message: { content: '{"suggestion":"继续跑测试"}' } }] }))
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { code: 'ABORT_ERR' })))
    })
  }
  const h = multiSessionHarness(fetchImpl)
  h.ctx.emit('session/event', h.session('session-a'), { type: 'turn/end', seq: 9, data: { reason: { kind: 'completed' } } })
  assert.equal((await h.read('session-a')).status, 'pending')
  t.mock.timers.tick(20000)
  await settle()
  const timedOut = await h.read('session-a')
  assert.equal(timedOut.status, 'failed')
  assert.equal(timedOut.reason, 'timeout')

  // The slot is free again: a different session still gets its prediction.
  h.ctx.emit('session/event', h.session('session-b'), { type: 'turn/end', seq: 9, data: { reason: { kind: 'completed' } } })
  const next = await h.read('session-b')
  assert.ok(['pending', 'ready'].includes(next.status), `expected the freed slot to predict, got ${next.status}`)
  await h.dispose()
})

test('the model request leaves room for a reasoning model to think before it answers', async () => {
  const h = harness()
  h.ctx.emit('session/event', h.session, { type: 'turn/end', seq: 9, data: { reason: { kind: 'completed' } } })
  let state
  for (let attempt = 0; attempt < 20; attempt += 1) {
    state = await readState(h)
    if (state.status === 'ready') break
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.equal(state.status, 'ready')
  assert.ok(h.calls[0].max_tokens >= 1024, `max_tokens ${h.calls[0].max_tokens} is smaller than the reasoning preamble`)
  await h.dispose()
})

test('a transient gateway 5xx is retried once instead of ending the turn', async () => {
  const bodies = []
  const fetchImpl = async (_url, options) => {
    bodies.push(JSON.parse(options.body))
    if (bodies.length === 1) return new Response('upstream unavailable', { status: 503 })
    return Response.json({ choices: [{ message: { content: '{"suggestion":"重试之后有了"}' } }] })
  }
  const h = harness({ fetch: fetchImpl })
  h.ctx.emit('session/event', h.session, { type: 'turn/end', seq: 9, data: { reason: { kind: 'completed' } } })
  let state
  for (let attempt = 0; attempt < 40; attempt += 1) {
    state = await readState(h)
    if (state.status === 'ready') break
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.equal(bodies.length, 2)
  assert.equal(state.status, 'ready')
  assert.equal(state.text, '重试之后有了')
  await h.dispose()
})

test('two consecutive 5xx answers fail the turn without a retry storm', async () => {
  const bodies = []
  const fetchImpl = async (_url, options) => {
    bodies.push(JSON.parse(options.body))
    return new Response('upstream unavailable', { status: 500 })
  }
  const h = harness({ fetch: fetchImpl })
  h.ctx.emit('session/event', h.session, { type: 'turn/end', seq: 9, data: { reason: { kind: 'completed' } } })
  let state
  for (let attempt = 0; attempt < 200; attempt += 1) {
    state = await readState(h)
    if (state.status === 'failed') break
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.equal(state.status, 'failed')
  assert.equal(state.reason, 'model-500')
  assert.equal(bodies.length, 2)
  await h.dispose()
})
