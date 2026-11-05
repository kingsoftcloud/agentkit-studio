import assert from 'node:assert/strict'
import test from 'node:test'
import { installPromptPrediction } from '../src/client/dsh/prompt-prediction.mjs'

test('registers the native session-scoped composer overlay', () => {
  const registrations = []
  const ctx = { slots: {
    inject(name, factory) { assert.equal(name, 'conversation.input.overlay'); factory() },
    register(descriptor, component) { registrations.push({ descriptor, component }); return () => {} },
  } }
  installPromptPrediction(ctx, { React: {}, h: () => null, window: {} })
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].descriptor.id, 'agentkit-studio-prompt-prediction')
  assert.equal(typeof registrations[0].component, 'function')
})

test('the overlay stays inert without a Session input source', () => {
  const registrations = []
  const ctx = { slots: {
    inject(_name, factory) { factory() },
    register(descriptor, component) { registrations.push({ descriptor, component }); return () => {} },
  } }
  const h = () => null
  installPromptPrediction(ctx, { React: {}, h, window: {} })
  assert.equal(registrations[0].component({ React: {}, h, window: {}, sessionId: undefined }), null)
})

function overlayRuntime(responses) {
  const urls = []
  const timers = []
  const state = []
  const refs = []
  const effects = []
  let cursor = 0
  const React = {
    useState(initial) {
      const index = cursor++
      if (!(index in state)) state[index] = typeof initial === 'function' ? initial() : initial
      return [state[index], next => { state[index] = next }]
    },
    useRef(initial) {
      const index = cursor++
      if (!(index in refs)) refs[index] = { current: initial }
      return refs[index]
    },
    useEffect(effect) { effects.push(effect); return undefined },
    useCallback(callback) { return callback },
  }
  const window = {
    localStorage: { getItem: () => null },
    addEventListener() {},
    removeEventListener() {},
    setTimeout(callback, ms) { timers.push({ id: timers.length + 1, callback, ms }); return timers.length },
    clearTimeout(id) { const entry = timers.find(timer => timer.id === id); if (entry !== undefined) entry.cancelled = true },
    async fetch(url) {
      urls.push(String(url))
      return { ok: true, json: async () => responses[Math.min(urls.length - 1, responses.length - 1)] }
    },
  }
  const registrations = []
  const ctx = { slots: {
    inject(_name, factory) { factory() },
    register(descriptor, component) { registrations.push({ descriptor, component }); return () => {} },
  } }
  installPromptPrediction(ctx, { React, h: (tag, props, ...children) => ({ tag, props, children }), window })
  const settle = async () => { for (let i = 0; i < 8; i += 1) await new Promise(resolve => setImmediate(resolve)) }
  const render = async () => {
    cursor = 0
    effects.length = 0
    const input = { draft: '', phase: 'plain', queue: [], attachmentIds: [], occurrences: [] }
    const element = registrations[0].component({
      useInput: select => select(input),
      inputActions: { captureInsertion() {}, insertText() { return true } },
      useSession: select => select({ running: false, removed: false, openState: 'open' }),
      useProjection: () => false,
      sessionId: 'session-1',
    })
    // `register` stores a wrapper that calls `h(Component, props)`; run the real component.
    const rendered = typeof element?.tag === 'function' ? element.tag(element.props) : element
    for (const effect of effects) effect()
    await settle()
    return rendered
  }
  const tick = async () => {
    // The poll effect arms an abort timer (POLL_TIMEOUT_MS) and a poll timer (POLL_MS).
    const index = timers.findIndex(timer => timer.ms === 700 && timer.cancelled !== true)
    if (index === -1) return
    const [next] = timers.splice(index, 1)
    next.callback()
    await settle()
  }
  const revision = index => Number(new URL(urls[index], 'http://localhost').searchParams.get('rev'))
  return { render, tick, urls, revision }
}

test('the poll loop asks for a full snapshot again when the host reports unchanged', async () => {
  const runtime = overlayRuntime([
    { rev: 4, status: 'pending', turnSeq: 3, sessionId: 'session-1' },
    { rev: 4, unchanged: true },
    { rev: 4, status: 'pending', turnSeq: 3, sessionId: 'session-1' },
    { rev: 5, status: 'ready', turnSeq: 3, text: '继续跑测试', sessionId: 'session-1' },
  ])
  await runtime.render()
  assert.equal(runtime.revision(0), -1)
  await runtime.tick()
  assert.equal(runtime.revision(1), 4)
  await runtime.tick()
  assert.equal(runtime.revision(2), -1, 'an unchanged pending snapshot must not stop the poll loop')
})
