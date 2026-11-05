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
