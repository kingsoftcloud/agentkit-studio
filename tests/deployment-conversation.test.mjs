import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeploymentConversation } from '../src/deployment-conversation.mjs';
import { CLOUD_PROVIDER, createDeploymentModelAdapter } from '../src/deployment-agents.mjs';
import { createDshRuntimeAdapter, bindDshAgentRoute, routeDshRuntime, setDshRuntimeAdapter, unbindDshAgentRoutes } from '../src/providers/dsh-runtime.mjs';
import { DshPresetAdmission } from '../src/agent-preset-admission.mjs';
import { apply as applyDshRuntimePlugin } from '../src/providers/dsh-runtime-plugin.mjs';
import { createRuntimeResponsesContract } from '../src/runtime-responses-contract.mjs';
import { createRuntimeResponsesStream } from '../src/runtime-responses-stream.mjs';

const agent = { metadata: { id: 'ar-cloud-test', local: false }, deployment: { agentId: 'ar-local-test', buildId: 'build-test', model: 'frozen-model' } };
const contract = createRuntimeResponsesContract({ agentId: agent.deployment.agentId, buildId: agent.deployment.buildId, model: agent.deployment.model, models: ['frozen-model', 'alternate-model'], token: 'private-runtime-token' });
const agents = async () => ({ connect: async id => { assert.equal(id, 'ar-cloud-test'); return { agent, endpoint: 'https://ar-cloud-test.agent-pre.kspmas.ksyun.com', token: 'private-runtime-token' }; }, list: async () => ({ items: [agent] }) });
const options = { agentId: 'ar-cloud-test', provider: CLOUD_PROVIDER, model: 'frozen-model', input: '你好', userMessage: { id: 'user-1' }, sessionId: 'native-session' };
const collect = async stream => { const frames = []; for await (const frame of stream) frames.push(frame); return frames; };
function response(body, change = event => event) {
  const events = [], request = contract.parse(body), writer = createRuntimeResponsesStream(request, (_type, value) => events.push(change(value)));
  writer.start();
  writer.frame({ kind: 'assistant', value: { type: 'chunk', attemptId: 'first', chunk: { type: 'reasoning-delta', index: 0, text: '分析问题' } } });
  writer.frame({ kind: 'event', value: { type: 'tool/call', data: { callId: 'search-1', name: 'search', arguments: '{"q":"example"}' } } });
  writer.frame({ kind: 'event', value: { type: 'tool/result', data: { message: { source: { callId: 'search-1' }, content: [{ type: 'text', text: 'actual result' }] } } } });
  writer.frame({ kind: 'assistant', value: { type: 'chunk', attemptId: 'first', chunk: { type: 'text-delta', index: 1, text: '真实回答' } } });
  writer.frame({ kind: 'assistant', value: { type: 'end', attemptId: 'first', outcome: { kind: 'committed', eventType: 'assistant/message' } } });
  writer.complete({ output: '真实回答', tokenUsage: { inputTokens: 42, outputTokens: 9 } });
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
}

test('all three cloud runtimes reuse native DSH chunks and tool cards without local model credentials or resource execution', async () => {
  for (const runtime of ['harness', 'dsh-native', 'codex']) {
    const sent = [], facts = [], sessionId = `native-${runtime}`;
    const release = bindDshAgentRoute(sessionId, { agentId: 'ar-cloud-test', runtime, local: false, agent: { session: { append: (...args) => facts.push(args) } } });
    try {
      const cloudRuntime = createDeploymentConversation({ agents, fetchImpl: async (_url, init) => {
        assert.equal(init.headers.Authorization, 'Bearer private-runtime-token'); assert.equal(init.redirect, 'error');
        sent.push(JSON.parse(init.body)); return response(sent.at(-1));
      } });
      const adapter = createDshRuntimeAdapter({ cloudRuntime, localHandler: () => assert.fail('must not run locally'), resourceAdapter: new Proxy({}, { get: () => assert.fail('resources execute remotely') }) });
      const chunks = await collect(adapter.stream({ provider: CLOUD_PROVIDER, model: 'frozen-model', sessionId,
        messages: [{ role: 'system', content: 'must not send desktop prompt' }, { role: 'user', id: 'message-1', content: '你好' }, { role: 'user', source: { kind: 'runtime-context' }, content: 'desktop workspace' }], tools: [{ name: 'unrelated tool' }] }));
      assert.deepEqual(Object.keys(sent[0]).sort(), ['input', 'model', 'request_id', 'session_id', 'stream']);
      assert.equal(sent[0].input, '你好');
      assert.equal(chunks.filter(row => row.type === 'text-delta').map(row => row.text).join(''), '真实回答');
      assert.equal(chunks.find(row => row.type === 'reasoning-delta').text, '分析问题');
      assert.deepEqual(chunks.find(row => row.type === 'usage').usage, { inputTokens: 42, outputTokens: 9, totalTokens: 51, cacheReadTokens: 0, cacheWriteTokens: 0 });
      assert.equal(chunks.at(-1).reason.kind, 'stop');
      assert.equal(chunks.some(row => row.blockType === 'tool-call'), false, 'do not ask the local DSH loop to repeat remote tools');
      assert.deepEqual(facts.map(row => row[1].phase), ['started', 'completed']);
      assert.equal(facts.at(-1)[1].content[0].text, 'actual result');
    } finally { release(); }
  }
});

test('session and message identities preserve continuation and retries without collapsing identical new prompts', async () => {
  const requests = [];
  const stream = createDeploymentConversation({ agents, fetchImpl: async (_url, init) => { requests.push(JSON.parse(init.body)); return response(requests.at(-1)); } });
  await collect(stream(options)); await collect(stream(options));
  await collect(stream({ ...options, userMessage: { id: 'user-2' } }));
  await collect(stream({ ...options, sessionId: 'different-session' }));
  assert.deepEqual(requests[0], requests[1]);
  assert.equal(requests[0].session_id, requests[2].session_id);
  assert.notEqual(requests[0].request_id, requests[2].request_id);
  assert.notEqual(requests[0].session_id, requests[3].session_id);
});

test('wrong model, missing native identity, wrong bundle and unverified streams fail closed', async () => {
  const stream = createDeploymentConversation({ agents, fetchImpl: () => assert.fail('request must be rejected before network') });
  await assert.rejects(collect(stream({ ...options, model: 'desktop-default' })), { code: 'DEPLOYMENT_MODEL_FROZEN' });
  await assert.rejects(collect(stream({ ...options, userMessage: {} })), { code: 'DEPLOYMENT_SESSION_REQUIRED' });
  const mismatched = createDeploymentConversation({ agents, fetchImpl: async (_url, init) => response(JSON.parse(init.body), event => event.type === 'response.created' ? { ...event, response: { ...event.response, metadata: { agentkit: { agentId: 'wrong-agent' } } } } : event) });
  await assert.rejects(collect(mismatched(options)), { code: 'DEPLOYMENT_RESPONSE_MISMATCH' });
  const unverified = createDeploymentConversation({ agents, fetchImpl: async () => new Response('data: {"type":"response.output_text.delta","delta":"wrong"}\n\n', { headers: { 'Content-Type': 'text/event-stream' } }) });
  await assert.rejects(collect(unverified(options)), { code: 'DEPLOYMENT_RESPONSE_UNVERIFIED' });
});

test('stopping a live stream cancels the exact verified remote response', async () => {
  const controller = new AbortController(), requests = [];
  let remoteId;
  const stream = createDeploymentConversation({ agents, fetchImpl: async (url, init) => {
    requests.push(url);
    if (url.endsWith('/cancel')) return Response.json({ cancelled: true });
    const request = contract.parse(JSON.parse(init.body)); remoteId = request.responseId;
    return new Response(new ReadableStream({ start(writer) {
      const projector = createRuntimeResponsesStream(request, (_type, value) => writer.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`)));
      projector.start(); projector.frame({ kind: 'assistant', value: { type: 'chunk', attemptId: 'one', chunk: { type: 'text-delta', index: 0, text: 'partial' } } });
    } }), { headers: { 'Content-Type': 'text/event-stream' } });
  } });
  await assert.rejects((async () => { for await (const chunk of stream({ ...options, signal: controller.signal })) if (chunk.type === 'text-delta') controller.abort(); })(), { code: 'CLOUD_RUN_CANCELLED' });
  assert.equal(requests.at(-1), `https://ar-cloud-test.agent-pre.kspmas.ksyun.com/v1/responses/${remoteId}/cancel`);
});

test('frozen cloud model directory is independent of local gateway and Codex catalogs', async () => {
  const adapter = createDeploymentModelAdapter({ agents, runtime: {} });
  assert.deepEqual((await adapter.listModels(CLOUD_PROVIDER)).map(item => item.id), ['frozen-model']);
});

test('cloud model directory includes every frozen bound model', async () => {
  const adapter = createDeploymentModelAdapter({ agents: async () => ({ list: async () => ({ items: [{ ...agent,
    deployment: { ...agent.deployment, models: ['frozen-model', 'alternate-model'] } }] }) }), runtime: {} });
  assert.deepEqual((await adapter.listModels(CLOUD_PROVIDER)).map(item => item.id), ['frozen-model', 'alternate-model']);
});

test('a verified cloud conversation records its remote execution receipt separately from local execution', async () => {
  const traces = [];
  const stream = createDeploymentConversation({ agents, observability: { syncTrace: async trace => traces.push(trace) },
    fetchImpl: async (_url, init) => response(JSON.parse(init.body)) });
  await collect(stream(options));
  assert.equal(traces.length, 1);
  assert.equal(traces[0].executionLocation, 'cloud');
  assert.equal(traces[0].agentId, 'ar-cloud-test');
  assert.equal(traces[0].provenance.buildId, 'build-test');
  assert.match(traces[0].provenance.responseId, /^resp_/);
});

test('cloud model switching verifies the requested model and records sanitized resource evidence', async () => {
  const traces = [], requests = [];
  const boundAgent = { ...agent, deployment: { ...agent.deployment, models: ['frozen-model', 'alternate-model'] } };
  const stream = createDeploymentConversation({ agents: async () => ({ connect: async () => ({ agent: boundAgent, capabilities: ['bound-model-selection'], endpoint: 'https://runtime.test', token: 'private-runtime-token' }) }),
    observability: { syncTrace: async trace => traces.push(trace) }, fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body); requests.push(body);
      return response(body, event => event.type === 'response.completed' ? { ...event, response: { ...event.response,
        metadata: { agentkit: { ...event.response.metadata.agentkit, resourceChecks: [{ kind: 'knowledge-base', resourceId: 'kb-test', action: 'search', status: 'succeeded', hitCount: 0, snippet: 'private', apiKey: 'private' }] } } } } : event);
    } });
  await collect(stream({ ...options, model: 'alternate-model' }));
  assert.equal(requests[0].model, 'alternate-model'); assert.equal(traces[0].provenance.model, 'alternate-model');
  assert.equal(traces[0].provenance.resourceChecks[0].hitCount, 0);
  assert.doesNotMatch(JSON.stringify(traces), /private/);
  const legacy = createDeploymentConversation({ agents: async () => ({ connect: async () => ({ agent: boundAgent, capabilities: [] }) }), fetchImpl: () => assert.fail('old image must fail before a model call') });
  await assert.rejects(collect(legacy({ ...options, model: 'alternate-model' })), { code: 'DEPLOYMENT_MODEL_SWITCH_UNAVAILABLE' });
});

test('old native conversations cannot silently adopt an upgraded or rolled-back cloud version', async () => {
  const stream = createDeploymentConversation({ agents: async () => ({ connect: async () => ({ agent: { ...agent, deployment: { ...agent.deployment, versionId: 'upd_new' } } }) }),
    fetchImpl: () => assert.fail('mismatch must stop before a model request') });
  await assert.rejects(collect(stream(options)), { code: 'DEPLOYMENT_SESSION_VERSION_CHANGED' });
  await assert.rejects(collect(stream({ ...options, cloudVersionId: 'upd_previous' })), { code: 'DEPLOYMENT_SESSION_VERSION_CHANGED' });
});

test('new native presets carry each deployment version through the scoped request and Host waterfall', async t => {
  let versionId = 'initial', requests = 0;
  const current = () => ({ ...agent, source: 'studio-deployment', spec: { runtime: { type: 'harness' } },
    deployment: { ...agent.deployment, id: 'dep_' + 'a'.repeat(32), versionId } });
  const definitions = new Map();
  const admission = new DshPresetAdmission({ getAgent: async () => current(),
    registry: { register: async definition => { definitions.set(definition.id, definition); return () => {}; } } });
  const cloudRuntime = createDeploymentConversation({ agents: async () => ({ connect: async () => ({ agent: current(),
    endpoint: 'https://ar-cloud-test.agent-pre.kspmas.ksyun.com', token: 'private-runtime-token' }) }),
    fetchImpl: async (_url, init) => { requests++; return response(JSON.parse(init.body)); } });
  t.after(setDshRuntimeAdapter(createDshRuntimeAdapter({ cloudRuntime })));
  t.after(() => unbindDshAgentRoutes(agent.metadata.id));
  t.after(() => admission.dispose());
  const request = sessionId => ({ sessionId, provider: CLOUD_PROVIDER, model: 'frozen-model',
    messages: [{ role: 'user', id: 'message-1', content: '你好' }] });
  const stream = sessionId => routeDshRuntime(request(sessionId), () => assert.fail('must use the selected cloud preset'));
  for (const selected of ['initial', 'upd_upgrade', 'upd_rollback']) {
    versionId = selected;
    const { presetId } = await admission.ensure(agent.metadata.id);
    const config = definitions.get(presetId).plugins.find(plugin => plugin.id === 'studio-runtime').config;
    const listeners = new Map();
    applyDshRuntimePlugin({ tools: { schemas: () => [], execute: () => assert.fail('no local tools') },
      on: (name, callback) => listeners.set(name, callback) }, config);
    await listeners.get('agent/request')({ agent: { id: selected } }, async () => request(selected));
    assert.equal((await collect(stream(selected))).find(chunk => chunk.type === 'text-delta').text, '真实回答');
    if (selected !== 'initial') await assert.rejects(collect(stream('initial')), { code: 'DEPLOYMENT_SESSION_VERSION_CHANGED' });
  }
  assert.equal(requests, 3, 'stale sessions must fail before a cloud request');
  assert.equal(definitions.size, 3, 'each rollout preserves the prior preset even if Agent revision is unchanged');
});

test('a switching cloud image receives exactly one clamped conversation execution mode', async () => {
  const headers = [];
  const switching = mode => async () => ({ connect: async () => ({ agent, endpoint: 'https://ar-cloud-test.agent-pre.kspmas.ksyun.com', token: 'private-runtime-token',
    executionPolicy: { format: 'agentkit.execution-policy/v1', permissionMode: 'workspace-write', approvalPolicy: 'never', approvalSource: 'runtime-policy' },
    capabilities: ['cloud-execution-policy/v1'], allowedPermissionModes: ['read-only', 'workspace-write'], executionModeSwitching: true }) });
  const run = async permissionModeFor => {
    const stream = createDeploymentConversation({ agents: switching(), permissionModeFor, fetchImpl: async (_url, init) => { headers.push(init.headers); return response(JSON.parse(init.body)); } });
    await collect(stream(options));
    return headers.at(-1);
  };
  assert.equal((await run(async () => 'workspace-write'))['x-agentkit-permission-mode'], 'workspace-write');
  assert.equal((await run(async () => 'danger-full-access'))['x-agentkit-permission-mode'], 'workspace-write');
  assert.equal((await run(async () => null))['x-agentkit-permission-mode'], undefined);
  const legacy = createDeploymentConversation({ agents: async () => ({ connect: async () => ({ agent, endpoint: 'https://ar-cloud-test.agent-pre.kspmas.ksyun.com', token: 'private-runtime-token' }) }),
    permissionModeFor: async () => 'workspace-write',
    fetchImpl: async (_url, init) => { headers.push(init.headers); return response(JSON.parse(init.body)); } });
  await collect(legacy(options));
  assert.equal(headers.at(-1)['x-agentkit-permission-mode'], undefined);
});
