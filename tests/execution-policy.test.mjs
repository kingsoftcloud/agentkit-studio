import test from 'node:test';
import assert from 'node:assert/strict';
import { readExecutionPolicy, UNATTENDED_EXECUTION_POLICY as policy } from '../src/execution-policy.mjs';
import { startBuildRuntimeHttp } from '../src/build-runtime-http.mjs';
import { createAgentRoutes } from '../src/host/routes/agents.mjs';
import { createPersonalAssistantRuntime } from '../src/personal-assistant-runtime.mjs';

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

test('ordinary runner diagnostics coexist with managed assistant Session permissions without overwriting them', async t => {
  const execution = { profile: 'workspace-managed/v1', managed: true, permission: 'workspace-write', approval: 'ask' };
  const agent = { session: { id: '' } }, created = [], ensured = [];
  const services = {
    sessionController: {
      projections: async () => created.length ? { asOfSeq: -1 } : null,
      create: async input => { created.push(input); agent.session.id = input.sessionId; },
      resolveAgent: async () => ({ agent }), prompt: async input => assert.equal(input.mode, 'queue'),
      page: async () => ({ records: [], hasMore: false }),
    },
    agents: { withoutInitiator: work => work() }, sessions: { flush: async () => true },
    permissionPresets: { set: () => assert.fail('Ordinary runner policy cannot change a managed Session') },
    approval: { setPolicy: () => assert.fail('Managed Session approval must remain ask') },
  };
  const assistant = createPersonalAssistantRuntime({ ctx: { get: name => services[name] }, agentId: 'owned-agent', buildId: 'build_0123456789abcdef0123',
    frozen: { spec: { runtime: { type: 'dsh-native' } } }, admit: async () => ({ presetId: 'managed-assistant' }),
    nativeCarrier: { hasLiveSession: () => false, dispose() {} },
    permissionModel: { enabled: true, newSessionCwd: async () => '/controlled-runtime/assistant-workspaces/owned/files',
      ensure: async (_agent, isNew) => { ensured.push(isNew); return execution; }, snapshot: () => execution, policyOf: () => 'ask', dispose() {} },
  });
  const token = 'private-runtime-test-token-12345678';
  const runtime = await startBuildRuntimeHttp({ agentId: 'owned-agent', buildId: 'build_0123456789abcdef0123', token,
    runner: async () => assert.fail('Diagnostics and assistant operations cannot run the Responses runner'), executionPolicy: policy, assistant, port: 0 });
  t.after(() => runtime.close());
  const base = `http://127.0.0.1:${runtime.address.port}`, headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const identity = async () => (await fetch(`${base}/v1/agentkit/runtime`, { headers })).json();
  const request = async (operation, payload = {}) => {
    const response = await fetch(`${base}/v1/assistant/${operation}`, { method: 'POST', headers, body: JSON.stringify(payload) });
    assert.equal(response.status, operation === 'submit' ? 202 : 200); return response.json();
  };
  assert.deepEqual((await identity()).executionPolicy, policy);
  assert.equal((await request('submit', { requestId: 'managed-task', text: 'write a workspace note' })).accepted, true);
  assert.deepEqual(ensured, [true]); assert.equal(created.length, 1);
  assert.equal(created[0].cwd, '/controlled-runtime/assistant-workspaces/owned/files');
  const snapshot = await request('snapshot');
  for (const [key, value] of Object.entries(execution)) assert.equal(snapshot.capabilities.execution[key], value);
  assert.deepEqual((await identity()).executionPolicy, policy);
  assert.ok((await identity()).capabilities.includes('personal-assistant-workspace-managed/v1'));
});
