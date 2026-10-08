import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeploymentConversation } from '../src/deployment-conversation.mjs';
import { CLOUD_PROVIDER, createDeploymentModelAdapter } from '../src/deployment-agents.mjs';
import { createDshRuntimeAdapter, bindDshAgentRoute } from '../src/providers/dsh-runtime.mjs';
import { createRuntimeResponsesContract } from '../src/runtime-responses-contract.mjs';
import { createRuntimeResponsesStream } from '../src/runtime-responses-stream.mjs';

const agent = { metadata: { id: 'ar-cloud-test', local: false }, deployment: { agentId: 'ar-local-test', buildId: 'build-test', model: 'frozen-model' } };
const contract = createRuntimeResponsesContract({ agentId: agent.deployment.agentId, buildId: agent.deployment.buildId, model: agent.deployment.model, token: 'private-runtime-token' });
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
