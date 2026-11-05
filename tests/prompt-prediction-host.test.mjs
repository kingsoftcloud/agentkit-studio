import assert from 'node:assert/strict'
import test from 'node:test'
import { createPromptPredictionHost, PROMPT_PREDICTION_FEEDBACK_PATH, PROMPT_PREDICTION_STATE_PATH } from '../src/prompt-prediction/host.mjs'

function message(role, text, source = role === 'assistant' ? { kind: 'model', provider: 'ksyun', model: 'flash' } : { kind: 'user' }) {
  return { role, source, content: [{ type: 'text', text }] }
}

function harness({ response = '{"suggestion":"继续跑测试"}', header = { config: { provider: 'ksyun', model: 'flash' } } } = {}) {
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
  const fetchImpl = async (_url, options) => {
    calls.push(JSON.parse(options.body))
    return Response.json({ choices: [{ message: { content: response } }] })
  }
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
