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
  assert.deepEqual(result, { ok: true, value: { agentId: 'owned', buildId: 'frozen-build', executionPolicy: policy } });
  assert.deepEqual(connected, ['owned']);
  await assert.rejects(route('agents/execution-policy', { agentId: 'foreign' }), { code: 'DEPLOYMENT_AGENT_NOT_FOUND' });
  assert.equal((await route('agents/execution-policy', {})).error.code, 'INVALID_AGENT_ID');
});
