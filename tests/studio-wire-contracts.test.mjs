import test from 'node:test';
import assert from 'node:assert/strict';
import { createStudioHostRemote, StudioHostError } from '../src/host-remote.mjs';
import { createProductClient } from '../src/client/remote/product-client.mjs';
import { callStudioOperation, createOperationClient, validateOperationRequest } from '../src/contracts/wire.mjs';
import { createControlPlaneDispatcher } from '../src/host/routes/dispatcher.mjs';
import { createStudioRoutes } from '../src/host/routes/index.mjs';
import { createHostRouteFixture } from './fixtures/host-route-fixture.mjs';
import { STUDIO_OPERATIONS } from '../src/contracts/definitions.mjs';
import { STUDIO_OPERATION_IDS } from '../src/contracts/operations.mjs';

for (const [name, create] of [
  ['browser', connection => createProductClient(connection, { window: { location: { origin: 'http://localhost', hash: '' } } })],
  ['Node', connection => createStudioHostRemote({ connection })],
]) {
  test(`${name} client uses the shared control implementation and preserves RPC envelopes`, async () => {
    const calls = [];
    const connection = { rpc: { call: async (...args) => { calls.push(args); return { ok: true, value: { resourceId: 'fixture' } }; } } };
    const client = create(connection);
    assert.equal((await client.createMcpResource({ displayName: 'fixture' })).resourceId, 'fixture');
    assert.deepEqual(calls, [['/agentkit', 'mcp/create', { displayName: 'fixture' }]]);
  });
  test(`${name} client rejects malformed successful-looking transport data`, async () => {
    const client = create({ rpc: { call: async () => ({ items: [] }) } });
    await assert.rejects(client.createMcpResource({}), error => error.code === 'STUDIO_RESPONSE_INVALID');
  });
}

test('Node Connection mode retains StudioHostError and the server error code', async () => {
  const client = createStudioHostRemote({ connection: { rpc: { call: async () => ({ ok: false, error: { code: 'FIXTURE_DENIED', message: 'fixture', details: { status: 409 } } }) } } });
  await assert.rejects(client.createMcpResource({}), error => error instanceof StudioHostError && error.code === 'FIXTURE_DENIED' && error.status === 409);
});

test('Node Connection mode keeps caller-owned HTTP authentication and stream cancellation', async () => {
  let received;
  const signal = new AbortController().signal;
  const client = createStudioHostRemote({
    connection: { rpc: { call: async () => ({ ok: true, value: { transport: 'agentengine-action' } }) } },
    baseUrl: 'http://localhost:4321', sessionToken: 'synthetic-session', csrfToken: 'synthetic-csrf',
    fetchImpl: async (...args) => { received = args; return new Response('data: fixture\n\n'); },
  });
  const response = await client.streamAgentConversation('cloud-fixture', 'session-fixture', { idempotencyKey: 'request-fixture' }, signal);
  assert.equal(await response.text(), 'data: fixture\n\n');
  assert.equal(received[0], 'http://localhost:4321/agentkit/cloud-conversation');
  assert.equal(received[1].signal, signal);
  assert.equal(received[1].headers.get('X-CSRF-Token'), 'synthetic-csrf');
  assert.equal(received[1].headers.get('X-AgentKit-Session'), 'synthetic-session');
});

test('shared wire forwards the DSH AbortSignal argument without serializing it', async () => {
  const calls = [];
  const signal = new AbortController().signal;
  const connection = { rpc: { call: async (...args) => { calls.push(args); return { ok: true, value: 'fixture' }; } } };
  assert.equal(await createOperationClient(connection).call('agents/list', {}, signal), 'fixture');
  assert.deepEqual(calls, [['/agentkit', 'agents/list', {}, signal]]);
});

test('derived methods cover every operation and preserve domain status details', async () => {
  const client = createOperationClient({ rpc: { call: async () => ({ ok: false, error: { code: 'FIXTURE_CONFLICT', details: { status: 409 } } }) } });
  assert.deepEqual(Object.keys(client.methods), STUDIO_OPERATION_IDS);
  assert.deepEqual(Object.keys(STUDIO_OPERATIONS), STUDIO_OPERATION_IDS);
  await assert.rejects(client.methods['agents/list']({}), { code: 'FIXTURE_CONFLICT', status: 409 });
});

test('Host contract boundary rejects malformed data before it can become a catalog', async () => {
  let calls = 0;
  const routes = Object.fromEntries(STUDIO_OPERATION_IDS.map(id => [id.split('/')[0], async () => { calls++; return { items: [] }; }]));
  const dispatch = createControlPlaneDispatcher({ bridge: { signal: new AbortController().signal }, serverClientPromise: Promise.resolve({}), routes });
  assert.equal((await dispatch('agents/list', {})).error.code, 'STUDIO_RESPONSE_INVALID');
  const cyclic = {}; cyclic.self = cyclic;
  assert.equal((await dispatch('agents/list', cyclic)).error.code, 'STUDIO_REQUEST_INVALID');
  assert.equal(calls, 1, 'non-serializable payload must not reach the domain');
});

test('wire request validation permits legacy JSON coercions and rejects unserializable values', async () => {
  validateOperationRequest('agents/list', undefined);
  validateOperationRequest('agents/list', null);
  validateOperationRequest('agents/list', { optional: undefined, date: new Date(0) });
  const cyclic = {}; cyclic.self = cyclic;
  assert.throws(() => validateOperationRequest('agents/list', cyclic), { code: 'STUDIO_REQUEST_INVALID' });
  await assert.rejects(callStudioOperation({ rpc: { call: async () => ({ ok: true }) } }, 'unknown/operation', {}), { code: 'agentkit/not-found' });
});

test('delivery-target query has an independent registered read-only contract', async () => {
  const fixture = createHostRouteFixture();
  const dispatch = createControlPlaneDispatcher({ bridge: { signal: new AbortController().signal }, serverClientPromise: fixture.deps.serverClientPromise, routes: createStudioRoutes(fixture.ctx, fixture.deps) });
  const payload = { agentId: 'cloud-fixture' };
  assert.deepEqual(await dispatch('schedules/delivery-targets', payload), { ok: true, value: {} });
  assert.deepEqual(fixture.calls, [['cloudSchedules.execute', ['delivery-targets', payload]]]);
});
