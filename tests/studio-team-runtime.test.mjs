import test from 'node:test'
import assert from 'node:assert/strict'
import { ensureStudioTeamRuntime } from '../src/studio-team-runtime.mjs'

const MODULE = '@deepseek-ai/dsh-experimental-agent-team'

/** Minimal Cordis-shaped context for the ownership decision. */
function fixture({ entries = [], wait = 50 } = {}) {
  const services = Object.create(null)
  const listeners = new Map()
  const mounted = []
  const effects = []
  const list = [...entries]
  const ctx = {
    root: { loader: { await: async () => {}, entries: () => list } },
    get: name => services[name],
    effect: fn => { const dispose = fn(); effects.push(dispose); return dispose; },
    on: (name, listener) => {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(listener)
      return () => {}
    },
    plugin: plugin => {
      const before = services.agentTeams
      plugin({ get: name => services[name], provide: (name, value) => { services[name] = value } })
      if (services.agentTeams === undefined && before !== undefined) services.agentTeams = before
      const record = { disposed: false, async dispose() { record.disposed = true; delete services.agentTeams } }
      mounted.push(record)
      return record
    },
  }
  const fire = name => { for (const listener of listeners.get(name) || []) listener() }
  return { ctx, services, mounted, list, fire, wait, effects }
}

const noopLoad = async () => ({ default: sub => { sub.provide('agentTeams', { from: 'fallback' }) } })

test('mounts the Studio fallback when no official entry is declared', async () => {
  const { ctx, services, mounted } = fixture()
  await ensureStudioTeamRuntime(ctx, { load: noopLoad })
  assert.equal(mounted.length, 1)
  assert.equal(services.agentTeams?.from, 'fallback')
})

test('lets an enabled declared entry own the service without mounting a fallback', async () => {
  const { ctx, services, mounted, list } = fixture({ entries: [{ options: { name: MODULE }, disabled: false }] })
  const ready = ensureStudioTeamRuntime(ctx, { load: noopLoad })
  setTimeout(() => { services.agentTeams = { from: 'official' } }, 10)
  await ready
  assert.equal(mounted.length, 0)
  assert.equal(services.agentTeams.from, 'official')
  assert.equal(list.length, 1)
})

test('leaves an installed but disabled entry as the owner of the service name', async () => {
  const { ctx, mounted } = fixture({ entries: [{ options: { name: MODULE }, disabled: true }] })
  await ensureStudioTeamRuntime(ctx, { load: noopLoad })
  assert.equal(mounted.length, 0)
})

test('hands the service over when the market creates the official entry after boot', async () => {
  const { ctx, services, mounted, list, fire } = fixture()
  const ready = ensureStudioTeamRuntime(ctx, { load: noopLoad })
  await ready
  assert.equal(mounted.length, 1)
  // The plugin manager composes the official entry and then starts applying it.
  list.push({ options: { name: MODULE }, disabled: false })
  fire('loader/entry-init')
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(mounted[0].disposed, true)
  assert.equal(services.agentTeams, undefined)
})
