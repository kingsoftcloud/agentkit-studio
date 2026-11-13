import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { registerStudioManagedHostResources } from '../src/host/services/native-managed-host-resources.mjs';
import { createStudioDshA2aControls } from '../src/host/services/dsh-a2a-control.mjs';
import { createDshNodeA2aTools } from '../src/providers/dsh-node-a2a-tools.mjs';
import { command, permitIssuer, scope, target } from './fixtures/native-managed-kernel.mjs';

const { createEngineService } = await import(new URL('engine-service.mjs',
  import.meta.resolve('@kingsoftcloud/agentkit-harness-node/native/managed-kernel')));

const a2aSpec = { local_name: 'research', binding_id: 'fixture-binding', space_id: 'fixture-space',
  target_agent_id: 'a2a-agent-research', expected_version_id: 'fixture-version', exposure: 'tool' };
const a2aInput = { agent: 'research', message: 'Find the evidence.' };

for (const scenario of ['mcp', 'a2a', 'lost-host-reply', 'known-remote-task', 'unknown-remote-task', 'no-delegation']) test(`signed managed Run across restart: ${scenario}`, async t => {
  const delegated = scenario !== 'no-delegation';
  const useA2a = delegated && scenario !== 'mcp';
  const interrupted = useA2a && scenario !== 'a2a';
  let receiptAvailable = !interrupted, receiptReads = 0, droppedHostReply = false;
  let recoveredPeerReads = 0;
  const root = await mkdtemp(join(await realpath(tmpdir()), 'managed-host-resources-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const issuer = permitIssuer(), serviceToken = 'fixture-managed-service-bearer', callbackToken = 'fixture-studio-host-callback-bearer';
  const dispose = [], calls = [], sends = [], requestsToPeer = [];
  const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1',
    () => resolve('http://127.0.0.1:' + server.address().port)));
  const close = server => new Promise(resolve => server.close(resolve));
  let peerOrigin;
  if (useA2a) {
    const peer = createServer(async (request, response) => {
      let raw = '';
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw);
      response.setHeader('content-type', 'application/json');
      if (request.url === '/agentengine/api/v1/ListAToASpaceAgents') {
        assert.equal(body.A2ASpaceId, a2aSpec.space_id);
        assert.equal(request.headers.authorization, 'Bearer fixture-a2a-token');
        requestsToPeer.push('list');
        response.end(JSON.stringify({ Code: 0, Data: { Agents: [{
          A2AAgentId: a2aSpec.target_agent_id, VersionId: a2aSpec.expected_version_id, Source: 'hosted',
          AgentCard: { name: a2aSpec.local_name, description: 'Find evidence', capabilities: { streaming: false },
            supportedInterfaces: [{ url: peerOrigin + '/rpc', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }] },
        }] } }));
        return;
      }
      const task = { id: 'original-remote-task', contextId: 'original-remote-context', status: { state: 'TASK_STATE_COMPLETED' },
        artifacts: [{ artifactId: 'result', parts: [{ text: 'verified managed A2A result' }] }] };
      assert.equal(request.url, '/rpc');
      if (body.method === 'SendMessage') sends.push(body.params.message.parts);
      else {
        assert.equal(body.method, 'GetTask');
        assert.equal(body.params.id, task.id);
      }
      requestsToPeer.push(body.method);
      if (scenario === 'unknown-remote-task' && body.method === 'SendMessage') return response.destroy();
      if (scenario === 'known-remote-task' && !receiptAvailable) {
        if (body.method === 'GetTask') { response.writeHead(503); return response.end('{}'); }
        task.status.state = 'TASK_STATE_WORKING';
        delete task.artifacts;
      }
      if (scenario === 'known-remote-task' && receiptAvailable && body.method === 'GetTask' && ++recoveredPeerReads === 1) {
        task.status.state = 'TASK_STATE_WORKING';
        delete task.artifacts;
      }
      response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: body.method === 'SendMessage' ? { task } : task }));
    });
    peerOrigin = await listen(peer);
    t.after(() => close(peer));
  }
  const sessionId = 'managed-resources-session';
  const record = { metadata: { id: scope.agentId, revision: 2 }, spec: { bindings: {
    mcpServers: ['bound-mcp'], skills: ['bound-skill'], tools: ['dsh-ignored'],
    ...(useA2a ? { a2a: [a2aSpec] } : {}),
    plugins: [{ config: { binding: { resource: { kind: 'memory-instance', id: 'not-admitted-by-this-route' } } } }],
    nativeAgentPolicy: { contract: 'agentkit.native-agent-policy/v1', mode: 'custom',
      rules: { bound_lookup: 'ask', blocked_tool: 'deny', ...(useA2a ? { call_a2a_agent: 'ask' } : {}) } },
  } } };
  const agent = { session: { id: sessionId, append() {} } };
  let route, skillLoads = 0, requests = 0;
  const mountResources = () => registerStudioManagedHostResources({
    effect(fn) { dispose.push(fn()); },
    inject(_deps, mount) {
      mount({ effect(fn) { dispose.push(fn()); }, webServer: { register(value) {
        route = value;
        return () => { route = undefined; };
      } } });
    },
  }, { scope, token: callbackToken,
    ...(delegated ? { approvalAuthority: 'trusted-engine' } : {}), resolveBinding: async id => id === sessionId
    ? { agent, record, agentRevision: 2, buildId: 'studio-build', permissionMode: () => useA2a ? 'read-only' : 'danger-full-access' } : null,
  ...(useA2a ? { createA2aPort: config => createDshNodeA2aTools({ ...config, workspaceRoot: workspace, stateDir: join(root, 'studio-state'),
    env: { KSADK_A2A_SPACE_ID: a2aSpec.space_id, KSADK_A2A_SERVICE_URL: peerOrigin,
      KSADK_A2A_SERVICE_TOKEN: 'fixture-a2a-token', KSADK_A2A_ALLOW_PRIVATE: 'true' } }) } : {}),
  resourceAdapters: {
    async loadSkill(id) {
      assert.equal(id, 'bound-skill');
      skillLoads++;
      return { name: 'Bound guide', description: 'Managed skill fixture', content: 'Use exact evidence from the selected MCP tool.' };
    },
    async listMcpTools(id) {
      assert.equal(id, 'bound-mcp');
      return ['bound_lookup', 'blocked_tool'].map(name => ({
        name, description: 'Fixture tool', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      }));
    },
    async callMcpTool(id, name, args) {
      calls.push({ id, name, args });
      return { evidence: 'verified managed MCP result' };
    },
  } });
  const closeResources = async () => {
    for (const retire of dispose.splice(0).reverse()) await retire();
  };
  let resources = mountResources();
  const host = createServer((request, response) => {
    if (request.url.endsWith('/receipt')) {
      receiptReads++;
      if (!receiptAvailable) { response.writeHead(503); response.end(); return; }
    }
    if (scenario === 'lost-host-reply' && !droppedHostReply && request.url.endsWith('/tool')) {
      const end = response.end;
      response.end = function (body, ...rest) {
        if (body && JSON.parse(body).content?.reply === 'verified managed A2A result') {
          droppedHostReply = true;
          return response.destroy();
        }
        return end.call(this, body, ...rest);
      };
    }
    void route.handler(request, response);
  });
  let engine;
  t.after(async () => {
    await engine?.close();
    await closeResources();
    await close(host);
    await rm(root, { recursive: true, force: true });
  });
  const endpoint = await listen(host);
  const setup = {
    token: serviceToken,
    startup: { workspace, stateDir: join(root, 'engine-state'), scope,
      model: { name: 'fixture', baseUrl: 'https://example.test/v1', apiKeyEnv: 'FIXTURE_MODEL_KEY' } },
    env: { FIXTURE_MODEL_KEY: 'fixture-model-key', STUDIO_CALLBACK_KEY: callbackToken },
    managed: { buildId: 'fixture-managed', controlPublicKeys: { server: issuer.publicKeyPem },
      host: { endpoint, tokenEnv: 'STUDIO_CALLBACK_KEY' },
      authorizeInteraction: async ({ command }) => command.payload.token_ref === 'fixture-consent' },
    fetchImpl: async (_url, request) => {
      const body = JSON.parse(request.body), step = ++requests;
      const steps = useA2a ? [
        ['list_a2a_agents', {}], ['call_a2a_agent', a2aInput],
      ] : [['bound_lookup', { query: 'managed evidence' }]];
      const next = steps[step - 1];
      assert(step <= steps.length + 1);
      assert(body.tools.some(tool => tool.function.name === 'bound_lookup'));
      assert(!body.tools.some(tool => tool.function.name === 'blocked_tool'));
      assert.equal(body.tools.some(tool => tool.function.name === 'call_a2a_agent'), useA2a);
      assert(JSON.stringify(body.messages).includes('Use exact evidence from the selected MCP tool.'));
      if (useA2a && step === 2) assert(JSON.stringify(body.messages).includes(a2aSpec.target_agent_id));
      if (!next) {
        const expected = !delegated ? 'policy_denied' : useA2a ? 'verified managed A2A result' : 'verified managed MCP result';
        assert(JSON.stringify(body.messages).includes(expected));
      }
      const delta = next ? { tool_calls: [{ index: 0, id: 'bound-call-' + step, type: 'function',
        function: { name: next[0], arguments: JSON.stringify(next[1]) } }] } : { content: 'Verified.' };
      const frame = { id: 'fixture', choices: [{ index: 0, delta, finish_reason: next ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 2 } };
      return new Response('data: ' + JSON.stringify(frame) + '\n\ndata: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } });
    },
  };
  let origin;
  async function start() {
    engine = createEngineService(setup);
    origin = await listen(engine.server);
  }
  const headers = { authorization: 'Bearer ' + serviceToken, 'content-type': 'application/json' };
  const post = (path, body) => fetch(origin + '/_agentkit/native-kernel/v1/' + path, {
    method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
  });
  const send = input => post('commands', { command: input, permit: issuer.issue(input) });
  const input = command({ session_id: sessionId, payload: { content: 'Use the bound guide and look up evidence.' } });
  const query = { tenant_id: target.tenantId, agent_instance_id: target.agentInstanceId, session_id: sessionId,
    authorization_ref: 'fixture-status' };
  async function waitForPhase(phase) {
    const deadline = Date.now() + 6000;
    let last;
    while (Date.now() < deadline) {
      const response = await post('status', { query, permit: issuer.issue(query, 'get_status') });
      assert.equal(response.status, 200);
      last = (await response.json()).runs[0]?.phase;
      if (last === phase) return;
      await delay(30);
    }
    assert.fail('Expected ' + phase + ', observed ' + last);
  }
  async function approvalFact() {
    const subscription = { ...query, after_seq: 0 };
    const response = await post('events', { subscription, permit: issuer.issue(subscription, 'subscribe_events') });
    assert.equal(response.status, 200);
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let pending = '';
    try {
      for (;;) {
        const next = await reader.read();
        assert(!next.done);
        pending += decoder.decode(next.value, { stream: true });
        const frames = pending.split('\n\n');
        pending = frames.pop();
        for (const frame of frames) {
          const data = frame.split('\n').find(line => line.startsWith('data: '));
          const event = data && JSON.parse(data.slice(6));
          if (event?.event_type === 'interaction.requested') return event;
        }
      }
    } finally { await reader.cancel(); }
  }

  await start();
  const unauthenticated = await fetch(endpoint + '/_agentkit/managed-host/v1/admit', { method: 'POST', headers, body: '{}' });
  assert.equal(unauthenticated.status, 401);
  assert.equal((await send(command({ session_id: 'other-session' }))).status, 503);
  assert.equal(requests, 0);
  const accepted = await send(input);
  assert.equal(accepted.status, 202, await accepted.clone().text());
  const receipt = await accepted.json();
  if (!delegated) {
    await waitForPhase('completed');
    assert.equal(calls.length, 0);
    return;
  }
  const approval = await approvalFact();
  assert.equal(approval.run_id, receipt.run_id);
  assert.equal(skillLoads, 1);
  assert.equal(calls.length, 0);
  assert.equal(sends.length, 0);
  if (useA2a) assert.deepEqual(requestsToPeer, ['list']);
  await engine.close();
  engine = null;
  await closeResources();
  resources = mountResources();
  await start();
  const duplicate = await send(input);
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).run_id, receipt.run_id);
  const decision = await send(command({ session_id: sessionId, command_type: 'submit_interaction',
    payload: { run_id: receipt.run_id, interaction_id: approval.payload.interaction_id, token_ref: 'fixture-consent', response: 'approve' } }));
  assert.equal(decision.status, 202);
  if (interrupted) {
    await waitForPhase('awaiting_reconciliation');
    assert.equal(sends.length, 1);
    assert.equal(requests, 2);
    assert.equal(droppedHostReply, scenario === 'lost-host-reply');
    await engine.close();
    engine = null;
    await closeResources();
    resources = mountResources();
    receiptAvailable = true;
    await start();
    assert.equal((await (await send(input)).json()).run_id, receipt.run_id);
    if (scenario === 'unknown-remote-task') {
      const before = receiptReads, deadline = Date.now() + 5000;
      while (receiptReads < before + 2 && Date.now() < deadline) await delay(30);
      assert(receiptReads >= before + 2);
      await waitForPhase('awaiting_reconciliation');
      assert.equal(sends.length, 1);
      assert.equal(requests, 2);
      assert(!requestsToPeer.includes('GetTask'));
      return;
    }
  }
  await waitForPhase('completed');
  assert.deepEqual(calls, useA2a ? [] : [{ id: 'bound-mcp', name: 'bound_lookup', args: { query: 'managed evidence' } }]);
  assert.equal(skillLoads, 1);
  assert.equal(requests, useA2a ? 3 : 2);
  if (useA2a) {
    assert.deepEqual(sends, [[{ text: a2aInput.message }]]);
    if (scenario === 'lost-host-reply') assert(!requestsToPeer.includes('GetTask'));
    if (scenario === 'known-remote-task') assert.equal(requestsToPeer.filter(method => method === 'GetTask').length, 3);
    const services = { sessionController: { resolveAgent: async () => ({ agent }) },
      sessionProjections: { stateOf: () => 'studio-preset' } };
    const controls = createStudioDshA2aControls({ ctx: { get: name => services[name] },
      agentEvents: () => ({ serial() { assert.fail('should use managed A2A port'); } }),
      resolveManagedBinding: resources.resolveA2aBinding });
    t.after(() => controls.close());
    const history = await controls.history({ agentId: scope.agentId, sessionId });
    assert.equal(history.total, 1);
    assert.equal(history.items[0].sessionId, sessionId);
    assert.match(history.items[0].callId, /^harness-[a-f0-9]{64}$/);
    const original = await controls.control({ ...history.items[0], kind: 'get', commandId: 'inspect-original-task' });
    assert.equal(original.state, 'completed');
    assert.equal(original.remote_task_id, 'original-remote-task');
    assert.equal(sends.length, 1);
  }
});
