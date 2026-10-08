import test from 'node:test';
import assert from 'node:assert/strict';
import { startFrozenBuildRuntime } from '../src/frozen-build-runtime.mjs';

const buildId = 'build_0123456789abcdef0123';
const token = 'runtime-test-token-with-at-least-24-characters';
test('frozen runtime is opt-in', async () => {
  assert.equal(await startFrozenBuildRuntime({ env: {} }), null);
});

test('frozen runtime preserves build admission, durable replay and request-input conflict', async t => {
  const history = new Map(), admissions = [], selected = [];
  let turns = 0;
  const controller = {
    projections: async ({ sessionId }) => history.has(sessionId) ? { asOfSeq: history.get(sessionId).length - 1 } : null,
    create: async ({ sessionId, agentPreset }) => { assert.equal(agentPreset, 'frozen-preset'); history.set(sessionId, []); },
    selectModel: async model => { selected.push(model); },
    resolveAgent: async () => ({ agent: { whenIdle: async () => {}, cancel() {} } }),
    prompt: async ({ sessionId, requestId, content }) => {
      const events = history.get(sessionId);
      if (events.some(event => event.type === 'user/message' && event.data.source.rpcId === requestId)) return;
      const turn = ++turns;
      for (const event of [
        { type: 'turn/start', data: { turn } },
        { type: 'user/message', data: { content, source: { rpcId: requestId } } },
        { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: `answer-${turn}` }] } } },
        { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } },
      ]) events.push({ ...event, seq: events.length });
    },
    page: async ({ address }) => ({ records: history.get(address.sessionId).map(event => ({ type: 'event', event })) }),
  };
  const services = { sessionController: controller, agents: { withoutInitiator: work => work() }, commands: { execute: async () => ({}) }, approval: { setPolicy: (_agent, policy) => assert.equal(policy, 'never') } };
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
