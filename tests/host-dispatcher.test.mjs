import test from 'node:test';
import assert from 'node:assert/strict';
import { createControlPlaneDispatcher } from '../src/host/routes/dispatcher.mjs';
import { createAgentRoutes } from '../src/host/routes/agents.mjs';
import { createSessionRoutes } from '../src/host/routes/sessions.mjs';
import { STUDIO_OPERATION_IDS } from '../src/contracts/operations.mjs';

function harness(callback) {
  const owner = new AbortController();
  const routes = Object.fromEntries(STUDIO_OPERATION_IDS.map(id => [id.split('/')[0], callback]));
  return { owner, dispatch: createControlPlaneDispatcher({ bridge: { signal: owner.signal }, routes }) };
}

test('Native child routes reject malformed or canceled requests before loading the Host', async () => {
  let loaded = 0;
  const host = harness(createSessionRoutes({ getNativeHost: async () => { loaded++; throw Error('must not load'); } }));
  for (const payload of [{}, { agentId: 'a', sessionId: 's', childRunId: 'extra' }, { agentId: 'a', sessionId: 's', runId: 42 }])
    assert.equal((await host.dispatch('sessions/native-child-tasks', payload)).error.code, 'STUDIO_NATIVE_CHILD_CONTROL_INVALID');
  assert.equal((await host.dispatch('sessions/native-child-promote', { agentId: 'a', sessionId: 's', childRunId: 'c', commandId: 'p' })).error.code,
    'STUDIO_NATIVE_CHILD_CONTROL_INVALID');
  const child = { agentId: 'a', sessionId: 's', runId: 'r', childRunId: 'c', commandId: 'control' };
  for (const payload of [child, { ...child, text: 'guide', expectedGoalRevision: -1 }, { ...child, text: '', expectedGoalRevision: 0 },
    { ...child, text: 'guide', expectedGoalRevision: 0, scope: {} }])
    assert.equal((await host.dispatch('sessions/native-child-send', payload)).error.code, 'STUDIO_NATIVE_CHILD_CONTROL_INVALID');
  assert.equal((await host.dispatch('sessions/native-child-cancel', { ...child, expectedGoalRevision: 0 })).error.code,
    'STUDIO_NATIVE_CHILD_CONTROL_INVALID');
  host.owner.abort();
  assert.equal((await host.dispatch('sessions/native-child-tasks', { agentId: 'a', sessionId: 's' })).error.code, 'gateway/cancelled');
  assert.equal(loaded, 0);
});

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

test('ManagedRuntime admission does not require a local Studio deployment receipt', async () => {
  const managed = { metadata: { id: 'ar-managed', local: false }, source: 'agentengine-managed-runtime', managedRuntime: true,
    deployment: { DeploymentType: 'ManagedRuntime' }, spec: { runtime: { type: 'dsh-native' }, bindings: {} } };
  let connects = 0;
  const route = createAgentRoutes({
    agentStorePromise: Promise.resolve({ get: async () => null }),
    studioBuildPromise: Promise.resolve({ build: { resolve: async () => managed } }),
    deployments: async () => ({ agents: { connect: async () => { connects++; throw new Error('receipt lookup must not run'); } } }),
    getAdmission: () => ({ ensure: async agentId => ({ presetId: `preset-${agentId}` }) }),
    serverClientPromise: Promise.resolve({ getAgent: async () => managed }),
  });
  assert.deepEqual((await route('agents/ensure-preset', { agentId: managed.metadata.id })).value, { presetId: 'preset-ar-managed' });
  assert.equal(connects, 0);
});

test('ManagedRuntime deletion verifies the cloud identity before calling DeleteAgent', async () => {
  const managed = { metadata: { id: 'ar-managed', local: false }, source: 'agentengine-managed-runtime', managedRuntime: true,
    deployment: { DeploymentType: 'ManagedRuntime' }, spec: { runtime: { type: 'dsh-native' }, bindings: {} } };
  const removed = [];
  const route = createAgentRoutes({
    agentStorePromise: Promise.resolve({ get: async () => null }),
    deploymentClientPromise: Promise.resolve({ forAgent: id => ({ remove: async request => { removed.push({ id, request }); return { data: { Deleted: true } }; } }) }),
    serverClientPromise: Promise.resolve({ getAgent: async () => managed }),
  });
  const signal = new AbortController().signal;
  assert.deepEqual((await route('agents/managed-delete', { agentId: managed.metadata.id }, signal)).value, { agentId: 'ar-managed', deleted: true, result: { Deleted: true } });
  assert.deepEqual(removed, [{ id: 'ar-managed', request: { signal } }]);

  const ordinary = { ...managed, managedRuntime: false, source: 'agentengine-server', deployment: { DeploymentType: 'Container' } };
  const guarded = createAgentRoutes({ serverClientPromise: Promise.resolve({ getAgent: async () => ordinary }), deploymentClientPromise: Promise.resolve({ forAgent: () => ({ remove: async () => { throw new Error('must not delete'); } }) }) });
  const denied = await guarded('agents/managed-delete', { agentId: ordinary.metadata.id });
  assert.equal(denied.error.code, 'MANAGED_RUNTIME_REQUIRED');
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
