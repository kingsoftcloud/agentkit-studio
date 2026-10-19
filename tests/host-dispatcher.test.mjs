import test from 'node:test';
import assert from 'node:assert/strict';
import { createControlPlaneDispatcher } from '../src/host/routes/dispatcher.mjs';
import { createAgentRoutes } from '../src/host/routes/agents.mjs';
import { STUDIO_OPERATION_IDS } from '../src/contracts/operations.mjs';

function harness(callback) {
  const owner = new AbortController();
  const routes = Object.fromEntries(STUDIO_OPERATION_IDS.map(id => [id.split('/')[0], callback]));
  return { owner, dispatch: createControlPlaneDispatcher({ bridge: { signal: owner.signal }, routes }) };
}

test('unknown and pre-cancelled operations retain their envelopes without invoking a domain', async () => {
  let calls = 0;
  const host = harness(async () => { calls++; return { ok: true }; });
  assert.deepEqual(await host.dispatch('agents/unknown', {}), { ok: false, error: {
    code: 'agentkit/not-found', message: 'Unknown AgentKit control endpoint', details: { endpoint: 'agents/unknown' },
  } });
  host.owner.abort();
  assert.equal((await host.dispatch('agents/list', {})).error.code, 'gateway/cancelled');
  assert.equal(calls, 0);
});

test('async domain failures preserve error code and upstream status', async () => {
  const host = harness(async () => { await Promise.resolve(); throw Object.assign(new Error('fixture'), { code: 'FIXTURE_FAILED', status: 409 }); });
  assert.deepEqual(await host.dispatch('agents/list', {}), { ok: false, error: {
    code: 'FIXTURE_FAILED', message: 'fixture', details: { status: 409 },
  } });
});

test('two Host dispatchers cannot cancel each other, and request cancellation is preserved', async () => {
  const active = new Map();
  const make = name => harness(async (_endpoint, payload, signal) => {
    active.set(name, { payload, signal });
    return await new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('fixture abort')), { once: true });
      active.get(name).resolve = () => resolve({ ok: true, value: name });
    });
  });
  const left = make('left'), right = make('right');
  const first = left.dispatch('agents/list', { sessionId: 'same-session' });
  const second = right.dispatch('agents/list', { sessionId: 'same-session' });
  await Promise.resolve(); await Promise.resolve();
  left.owner.abort();
  assert.equal((await first).error.code, 'gateway/cancelled');
  assert.equal(active.get('right').signal.aborted, false);
  active.get('right').resolve(); assert.equal((await second).value, 'right');
  const caller = new AbortController();
  const third = right.dispatch('agents/list', {}, caller.signal);
  await Promise.resolve(); await Promise.resolve(); caller.abort();
  assert.equal((await third).error.code, 'gateway/cancelled');
});

test('model operations retain their independence from server-client initialization', async () => {
  const failure = Object.assign(new Error('unavailable'), { code: 'FIXTURE_SERVER_UNAVAILABLE' });
  const rejected = Promise.reject(failure); rejected.catch(() => {});
  const owner = new AbortController();
  const routes = Object.fromEntries(STUDIO_OPERATION_IDS.map(id => [id.split('/')[0], async () => ({ ok: true, value: 'fixture' })]));
  const dispatch = createControlPlaneDispatcher({ bridge: { signal: owner.signal }, serverClientPromise: rejected, routes });
  assert.equal((await dispatch('models/catalog', {})).ok, true);
  assert.equal((await dispatch('settings/get', {})).ok, true);
  assert.equal((await dispatch('agents/list', {})).error.code, 'FIXTURE_SERVER_UNAVAILABLE');
});

test('preset routes resolve the current admission after registry replacement', async () => {
  const agent = { metadata: { id: 'fixture', local: true }, spec: {} };
  let current = { ensure: async () => ({ presetId: 'first' }) };
  const route = createAgentRoutes({ agentStorePromise: Promise.resolve({ get: async () => agent }), getAdmission: () => current });
  assert.equal((await route('agents/ensure-preset', { agentId: 'fixture' })).value.presetId, 'first');
  current = { ensure: async () => ({ presetId: 'replacement' }) };
  assert.equal((await route('agents/ensure-preset', { agentId: 'fixture' })).value.presetId, 'replacement');
});

test('unloading while server initialization is pending cannot start a domain afterwards', async () => {
  let ready, calls = 0;
  const serverClientPromise = new Promise(resolve => { ready = resolve; });
  const owner = new AbortController();
  const routes = Object.fromEntries(STUDIO_OPERATION_IDS.map(id => [id.split('/')[0], async () => { calls++; return { ok: true }; }]));
  const dispatch = createControlPlaneDispatcher({ bridge: { signal: owner.signal }, serverClientPromise, routes });
  const result = dispatch('agents/list', {}); owner.abort(); ready({});
  assert.equal((await result).error?.code, 'gateway/cancelled');
  assert.equal(calls, 0);
});

test('binding the personal assistant configuration admits its verified cloud instance, never its local runtime', async () => {
  const calls = [];
  const route = createAgentRoutes({ serverClientPromise: Promise.resolve({}), agentStorePromise: Promise.resolve({ get: async id => { calls.push(['local', id]); return { metadata: { id, local: true } }; } }),
    assistantSetup: async () => ({ reference: async () => ({ agentId: 'local-assistant', cloudAgentId: 'cloud-assistant' }) }),
    deployments: async () => ({ agents: { connect: async id => { calls.push(['connect', id]); return {}; } } }),
    getAdmission: () => ({ ensure: async (id, options) => { calls.push(['admit', id, options]); return { presetId: 'cloud-preset', agentId: id, local: false }; } }) });
  const result = await route('agents/ensure-preset', { agentId: 'local-assistant' });
  assert.equal(result.value.agentId, 'cloud-assistant');
  assert.ok(calls.some(([kind, id]) => kind === 'connect' && id === 'cloud-assistant'));
  assert.ok(!calls.some(([kind]) => kind === 'local'));
});

test('an unavailable assistant deployment cannot fall back to the editable local agent', async () => {
  let admitted = false;
  const route = createAgentRoutes({ assistantSetup: async () => ({ reference: async () => ({ agentId: 'assistant-config' }) }),
    getAdmission: () => ({ ensure: async () => { admitted = true; } }) });
  const result = await route('agents/ensure-preset', { agentId: 'assistant-config' });
  assert.equal(result.error.code, 'ASSISTANT_DEPLOYMENT_NOT_READY');
  assert.equal(admitted, false);
});

test('a personal assistant configuration from another scope never becomes a local execution fallback', async () => {
  let admitted = false;
  const route = createAgentRoutes({ assistantSetup: async () => ({ reference: async () => null }),
    agentStorePromise: Promise.resolve({ get: async () => ({ metadata: { id: 'assistant-config', purpose: 'personal-assistant' } }) }),
    getAdmission: () => ({ ensure: async () => { admitted = true; } }) });
  const result = await route('agents/ensure-preset', { agentId: 'assistant-config' });
  assert.equal(result.error.code, 'ASSISTANT_DEPLOYMENT_NOT_READY');
  assert.equal(admitted, false);
});
