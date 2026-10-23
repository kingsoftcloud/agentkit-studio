import test from 'node:test';
import assert from 'node:assert/strict';
import { startFrozenBuildRuntime } from '../src/frozen-build-runtime.mjs';

const buildId = 'build_0123456789abcdef0123';
const token = 'runtime-test-token-with-at-least-24-characters';
test('frozen runtime is opt-in', async () => {
  assert.equal(await startFrozenBuildRuntime({ env: {} }), null);
});

test('Responses selects each bound model on the native session and preserves its selection and resource evidence across replay', async t => {
  const history = new Map(), models = new Map(); let turns = 0;
  const controller = {
    promptFingerprintVersion: 1,
    projections: async ({ sessionId }) => history.has(sessionId) ? { asOfSeq: history.get(sessionId).length - 1 } : null,
    create: async ({ sessionId }) => history.set(sessionId, []),
    selectModel: async ({ sessionId, model }) => models.set(sessionId, model),
    resolveAgent: async sessionId => ({ agent: { whenIdle: async () => {}, cancel() {}, session: { id: sessionId,
      snapshotEvents: () => history.get(sessionId), append: (type, data, options) => {
      assert.equal(options?.ignorable, true, 'extension facts require the public DSH cold-history marker');
      history.get(sessionId).push({ type, data, seq: history.get(sessionId).length });
    } } } }),
    prompt: async ({ sessionId, requestId, content, requestFingerprint }) => {
      const events = history.get(sessionId);
      if (events.some(item => item.type === 'user/message' && item.data.source.rpcId === requestId)) return;
      const turn = ++turns;
      for (const event of [
        { type: 'turn/start', data: { turn } }, { type: 'user/message', data: { content, source: { rpcId: requestId, requestFingerprint } } },
        { type: 'studio/resource-check', data: { kind: 'knowledge-base', resourceId: 'kb-test', action: 'search', status: 'succeeded', hitCount: 0 } },
        { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: models.get(sessionId) }] } } },
        { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } },
      ]) events.push({ ...event, seq: events.length });
    },
    page: async ({ address }) => ({ records: history.get(address.sessionId).map(event => ({ type: 'event', event })) }),
  };
  const services = { sessionController: controller, sessions: { flush: async () => true }, agents: { withoutInitiator: work => work() }, permissionPresets: { set() {} }, approval: { setPolicy() {} } };
  const frozen = { spec: { bindings: { modelProfileId: 'profile-a', modelProfileIds: ['profile-a', 'profile-b'] } } };
  const start = () => startFrozenBuildRuntime({ ctx: { get: name => services[name], on: () => () => {} }, build: { resolve: async () => frozen },
    modelService: { profile: async id => ({ modelName: id === 'profile-a' ? 'model-a' : 'model-b' }) },
    admit: async (_id, record) => ({ presetId: 'preset', modelSelection: { provider: 'bound', model: record.spec.bindings.modelProfileId } }),
    env: { AGENTKIT_RUNTIME_AGENT_ID: 'test-agent', AGENTKIT_RUNTIME_BUILD_ID: buildId, AGENTKIT_RUNTIME_TOKEN: token, AGENTKIT_RUNTIME_PORT: '0' } });
  let runtime = await start(); t.after(() => runtime.close());
  const diagnostic = await (await fetch(`http://127.0.0.1:${runtime.address.port}/v1/agentkit/runtime`, { headers: { authorization: `Bearer ${token}` } })).json();
  assert.deepEqual(diagnostic.executionPolicy, { format: 'agentkit.execution-policy/v1', permissionMode: 'read-only', approvalPolicy: 'never', approvalSource: 'runtime-policy' });
  const post = body => fetch(`http://127.0.0.1:${runtime.address.port}/v1/responses`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const firstRequest = { input: 'question', session_id: 'conversation', request_id: 'first', model: 'model-b' };
  const first = await (await post(firstRequest)).json();
  assert.equal(first.output_text, 'profile-b'); assert.equal(first.model, 'model-b');
  assert.equal(first.metadata.agentkit.resourceChecks[0].hitCount, 0);
  const next = await (await post({ input: 'follow-up', previous_response_id: first.id, request_id: 'second', model: 'model-a' })).json();
  assert.equal(next.output_text, 'profile-a'); assert.equal(history.size, 1);
  await runtime.close(); runtime = await start();
  const replay = await (await post(firstRequest)).json();
  assert.deepEqual(replay, first);
  assert.equal(replay.output_text, first.output_text); assert.equal(replay.id, first.id);
  assert.deepEqual(replay.metadata.agentkit.resourceChecks, first.metadata.agentkit.resourceChecks);
  assert.equal((await post({ ...firstRequest, model: 'model-a' })).status, 409);
  assert.equal((await post({ ...firstRequest, request_id: 'unbound', model: 'desktop-default' })).status, 400);
  assert.equal(turns, 2);
});

test('frozen runtime preserves build admission, durable replay and request-input conflict', async t => {
  const history = new Map(), admissions = [], selected = [];
  let turns = 0;
  const controller = {
    promptFingerprintVersion: 1,
    projections: async ({ sessionId }) => history.has(sessionId) ? { asOfSeq: history.get(sessionId).length - 1 } : null,
    create: async ({ sessionId, agentPreset }) => { assert.equal(agentPreset, 'frozen-preset'); history.set(sessionId, []); },
    selectModel: async model => { selected.push(model); },
    resolveAgent: async () => ({ agent: { whenIdle: async () => {}, cancel() {} } }),
    prompt: async ({ sessionId, requestId, content, requestFingerprint }) => {
      const events = history.get(sessionId);
      if (events.some(event => event.type === 'user/message' && event.data.source.rpcId === requestId)) return;
      const turn = ++turns;
      for (const event of [
        { type: 'turn/start', data: { turn } },
        { type: 'user/message', data: { content, source: { rpcId: requestId, requestFingerprint } } },
        { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: `answer-${turn}` }] } } },
        { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } },
      ]) events.push({ ...event, seq: events.length });
    },
    page: async ({ address }) => ({ records: history.get(address.sessionId).map(event => ({ type: 'event', event })) }),
  };
  const services = { sessionController: controller, agents: { withoutInitiator: work => work() }, permissionPresets: { set() {} }, approval: { setPolicy: (_agent, policy) => assert.equal(policy, 'never') } };
  const frozen = { metadata: { id: 'test-agent', revision: 1 }, buildId, spec: { instructions: { system: 'frozen' } } };
  const runtime = await startFrozenBuildRuntime({ ctx: { get: name => services[name] },
    build: { resolve: async (id, build) => { assert.equal(id, 'test-agent'); assert.equal(build, buildId); return frozen; } },
    admit: async (id, record) => { assert.equal(record, frozen); admissions.push(id); return { presetId: 'frozen-preset', modelSelection: { provider: 'bound', model: 'chosen' } }; },
    env: { AGENTKIT_RUNTIME_AGENT_ID: 'test-agent', AGENTKIT_RUNTIME_BUILD_ID: buildId, AGENTKIT_RUNTIME_TOKEN: token, AGENTKIT_RUNTIME_PORT: '0' },
  });
  t.after(() => runtime.close());
  const post = body => fetch(`http://127.0.0.1:${runtime.address.port}/runs`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const request = { input: 'ordinary question', sessionId: 'conversation', requestId: 'first' };
  const first = await (await post(request)).json();
  const second = await (await post({ ...request, requestId: 'second', input: 'follow-up' })).json();
  const replay = await (await post(request)).json();
  assert.equal(first.output, 'answer-1');
  assert.equal(second.output, 'answer-2');
  assert.equal(replay.runId, first.runId);
  assert.equal(replay.output, first.output);
  const conflict = await post({ ...request, input: 'different input' });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error.code, 'RUNTIME_REQUEST_CONFLICT');
  assert.equal(turns, 2);
  assert.equal(selected.length, 1);
  assert.equal(admissions.length, 2); // Startup preflight and first native session.
});
