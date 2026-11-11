import test from 'node:test';
import assert from 'node:assert/strict';
import { readExecutionPolicy, UNATTENDED_EXECUTION_POLICY as policy } from '../src/execution-policy.mjs';
import { startBuildRuntimeHttp } from '../src/build-runtime-http.mjs';
import { createAgentRoutes } from '../src/host/routes/agents.mjs';

test('only known response diagnostics are shown; future or missing values remain unknown', () => {
  for (const value of [null, {}, { ...policy, format: 'future' }, { ...policy, permissionMode: 'unconfined' }, { ...policy, approvalPolicy: 'automatic' }, { ...policy, approvalSource: 'user' }]) assert.equal(readExecutionPolicy(value), null);
  assert.deepEqual(readExecutionPolicy({ ...policy, token: 'must-not-leak' }), policy);
});

test('runtime diagnostic requires authentication and never invents an absent runner policy', async t => {
  const token = 'private-runtime-test-token-12345678';
  for (const declared of [undefined, policy, { ...policy, format: 'future' }]) {
    let calls = 0;
    const server = await startBuildRuntimeHttp({ agentId: 'owned-agent', buildId: 'build_0123456789abcdef0123', token,
      runner: async () => { calls++; return {}; }, executionPolicy: declared, port: 0 });
    t.after(() => server.close());
    const url = `http://127.0.0.1:${server.address.port}/v1/agentkit/runtime`;
    assert.equal((await fetch(url)).status, 401);
    const result = await (await fetch(url, { headers: { authorization: `Bearer ${token}` } })).json();
    assert.deepEqual(result.executionPolicy, declared === policy ? policy : undefined);
    assert.equal(calls, 0); assert(!JSON.stringify(result).includes(token));
    await server.close();
  }
});

test('policy operation verifies the owned deployment and returns no connection credentials', async () => {
  const connected = [];
  const route = createAgentRoutes({ serverClientPromise: Promise.resolve({}), deployments: async () => ({ agents: {
    connect: async id => { connected.push(id); if (id !== 'owned') throw Object.assign(new Error('not owned'), { code: 'DEPLOYMENT_AGENT_NOT_FOUND' });
      return { agent: { deployment: { buildId: 'frozen-build' } }, endpoint: 'private-endpoint', token: 'private-token', executionPolicy: policy }; },
  } }) });
  const result = await route('agents/execution-policy', { agentId: 'owned', permissionMode: 'danger-full-access' });
  assert.deepEqual(result, { ok: true, value: { agentId: 'owned', buildId: 'frozen-build', executionPolicy: policy,
    allowedPermissionModes: [], executionModeSwitching: false, selectedPermissionMode: null } });
  assert.deepEqual(connected, ['owned']);
  assert.equal(JSON.stringify(result).includes('private-token'), false);
  assert.equal(JSON.stringify(result).includes('private-endpoint'), false);
  await assert.rejects(route('agents/execution-policy', { agentId: 'foreign' }), { code: 'DEPLOYMENT_AGENT_NOT_FOUND' });
  assert.equal((await route('agents/execution-policy', {})).error.code, 'INVALID_AGENT_ID');
});

test('conversation execution mode is only persisted inside the modes declared by the frozen image', async () => {
  const stored = new Map(), connected = [];
  const modes = ['read-only', 'workspace-write'];
  const route = createAgentRoutes({ serverClientPromise: Promise.resolve({}), deployments: async () => ({ agents: {
    connect: async id => { connected.push(id); if (id !== 'owned') throw Object.assign(new Error('not owned'), { code: 'DEPLOYMENT_AGENT_NOT_FOUND' });
      return { agent: { deployment: { buildId: 'frozen-build' } }, executionPolicy: { ...policy, permissionMode: 'workspace-write' },
        capabilities: ['cloud-execution-policy/v1'], allowedPermissionModes: modes, executionModeSwitching: true }; },
  } }), cloudExecutionModes: { get: async id => stored.get(id) || null, set: async (id, mode) => { stored.set(id, mode); return mode; } } });
  const applied = await route('agents/execution-policy-set', { agentId: 'owned', permissionMode: 'danger-full-access' });
  assert.deepEqual(applied.value, { agentId: 'owned', selectedPermissionMode: 'workspace-write', allowedPermissionModes: modes,
    executionPolicy: { ...policy, permissionMode: 'workspace-write' } });
  assert.equal(stored.get('owned'), 'workspace-write');
  assert.equal((await route('agents/execution-policy-set', { agentId: 'owned', permissionMode: 'unconfined' })).error.code, 'CLOUD_EXECUTION_MODE_INVALID');
  await assert.rejects(route('agents/execution-policy-set', { agentId: 'foreign', permissionMode: 'read-only' }), { code: 'DEPLOYMENT_AGENT_NOT_FOUND' });
  assert.equal((await route('agents/execution-policy', { agentId: 'owned' })).value.selectedPermissionMode, 'workspace-write');
  assert.deepEqual(connected, ['owned', 'foreign', 'owned']);
});

test('an image without the switching capability rejects execution mode changes', async () => {
  const route = createAgentRoutes({ serverClientPromise: Promise.resolve({}), deployments: async () => ({ agents: {
    connect: async id => ({ agent: { deployment: { buildId: 'frozen-build' } }, executionPolicy: policy,
      capabilities: [], allowedPermissionModes: [], executionModeSwitching: false }),
  } }), cloudExecutionModes: { get: async () => null, set: async () => assert.fail('must not persist') } });
  const result = await route('agents/execution-policy-set', { agentId: 'owned', permissionMode: 'workspace-write' });
  assert.equal(result.error.code, 'CLOUD_EXECUTION_MODE_UNSUPPORTED');
});
