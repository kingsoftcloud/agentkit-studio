import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { registerStudioManagedHostResources } from '../src/host/services/native-managed-host-resources.mjs';
import { command, permitIssuer, scope, target } from './fixtures/native-managed-kernel.mjs';

const { createEngineService } = await import(new URL('engine-service.mjs',
  import.meta.resolve('@kingsoftcloud/agentkit-harness-node/native/managed-kernel')));

test('signed managed Runs use only bound Studio MCP and Skill across a service restart', async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'managed-host-resources-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const issuer = permitIssuer(), serviceToken = 'fixture-managed-service-bearer', callbackToken = 'fixture-studio-host-callback-bearer';
  const dispose = [], calls = [];
  const sessionId = 'managed-resources-session';
  const record = { metadata: { id: scope.agentId, revision: 2 }, spec: { bindings: {
    mcpServers: ['bound-mcp'], skills: ['bound-skill'], tools: ['dsh-ignored'],
    plugins: [{ config: { binding: { resource: { kind: 'memory-instance', id: 'not-admitted-by-this-route' } } } }],
    nativeAgentPolicy: { contract: 'agentkit.native-agent-policy/v1', mode: 'custom',
      rules: { bound_lookup: 'ask', blocked_tool: 'deny' } },
  } } };
  let route, skillLoads = 0, requests = 0;
  registerStudioManagedHostResources({
    effect(fn) { dispose.push(fn()); },
    inject(_deps, mount) {
      mount({ effect(fn) { dispose.push(fn()); }, webServer: { register(value) {
        route = value;
        return () => { route = undefined; };
      } } });
    },
  }, { scope, token: callbackToken, resolveBinding: async id => id === sessionId
    ? { agent: { session: { id, append() {} } }, record, agentRevision: 2, buildId: 'studio-build', permissionMode: () => 'danger-full-access' } : null,
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
  const host = createServer(route.handler);
  let engine;
  t.after(async () => {
    await engine?.close();
    for (const close of dispose.reverse()) close();
    await new Promise(resolve => host.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1',
    () => resolve('http://127.0.0.1:' + server.address().port)));
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
      assert(step <= 2);
      assert(body.tools.some(tool => tool.function.name === 'bound_lookup'));
      assert(!body.tools.some(tool => tool.function.name === 'blocked_tool'));
      assert(JSON.stringify(body.messages).includes('Use exact evidence from the selected MCP tool.'));
      if (step === 2) assert(JSON.stringify(body.messages).includes('verified managed MCP result'));
      const delta = step === 1 ? { tool_calls: [{ index: 0, id: 'bound-call', type: 'function',
        function: { name: 'bound_lookup', arguments: '{"query":"managed evidence"}' } }] } : { content: 'Verified.' };
      const frame = { id: 'fixture', choices: [{ index: 0, delta, finish_reason: step === 1 ? 'tool_calls' : 'stop' }],
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
  const receipt = await accepted.json(), approval = await approvalFact();
  assert.equal(approval.run_id, receipt.run_id);
  assert.equal(skillLoads, 1);
  assert.equal(calls.length, 0);
  await engine.close();
  engine = null;
  await start();
  const duplicate = await send(input);
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).run_id, receipt.run_id);
  const decision = await send(command({ session_id: sessionId, command_type: 'submit_interaction',
    payload: { run_id: receipt.run_id, interaction_id: approval.payload.interaction_id, token_ref: 'fixture-consent', response: 'approve' } }));
  assert.equal(decision.status, 202);
  await waitForPhase('completed');
  assert.deepEqual(calls, [{ id: 'bound-mcp', name: 'bound_lookup', args: { query: 'managed evidence' } }]);
  assert.equal(skillLoads, 1);
  assert.equal(requests, 2);
});
