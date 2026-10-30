import test from 'node:test';
import assert from 'node:assert/strict';
import { startFrozenBuildRuntime } from '../src/frozen-build-runtime.mjs';

/** In-memory controller fixture: tests HTTP request decisions, not disk persistence. */
async function fixture(t, { rejectPermissionOnce = false } = {}) {
  const history = new Map(), selected = new Map(), mutations = [];
  let turns = 0, runtime;
  const controller = {
    promptFingerprintVersion: 1,
    projections: async ({ sessionId }) => history.has(sessionId) ? { asOfSeq: history.get(sessionId).length - 1 } : null,
    create: async ({ sessionId }) => { mutations.push('create'); history.set(sessionId, []); },
    selectModel: async ({ sessionId, model }) => { mutations.push('select'); selected.set(sessionId, model); },
    resolveAgent: async sessionId => ({ agent: { whenIdle: async () => {}, cancel() {}, session: {
      id: sessionId, snapshotEvents: () => history.get(sessionId),
      append: (type, data, options) => { mutations.push('append'); history.get(sessionId).push({ type, data, seq: history.get(sessionId).length, ...options }); },
    } } }),
    prompt: async ({ sessionId, requestId, content, requestFingerprint }) => {
      mutations.push('prompt');
      const events = history.get(sessionId);
      if (events.some(event => event.type === 'user/message' && event.data.source.rpcId === requestId)) return;
      const turn = ++turns;
      for (const event of [
        { type: 'turn/start', data: { turn } },
        { type: 'user/message', data: { content, source: { kind: 'user', rpcId: requestId, ...(requestFingerprint ? { requestFingerprint } : {}) } } },
        { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: selected.get(sessionId) }] } } },
        { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } },
      ]) events.push({ ...event, seq: events.length });
    },
    page: async ({ address }) => ({ records: history.get(address.sessionId).map(event => ({ type: 'event', event })) }),
  };
  const services = { sessionController: controller, sessions: { flush: async () => true }, agents: { withoutInitiator: work => work() },
    permissionPresets: { set: () => { mutations.push('permission'); if (rejectPermissionOnce) { rejectPermissionOnce = false; throw Object.assign(new Error('permission unavailable'), { code: 'AUTOMATION_PERMISSION_UNAVAILABLE' }); } } },
    approval: { setPolicy() { mutations.push('approval'); } } };
  const frozen = { spec: { bindings: { modelProfileId: 'profile-a', modelProfileIds: ['profile-a', 'profile-b'] } } };
  const token = 'replay-fixture-token-at-least-24-characters';
  async function restart() {
    await runtime?.close();
    runtime = await startFrozenBuildRuntime({ ctx: { get: name => services[name], on: () => () => {} },
      build: { resolve: async () => frozen }, modelService: { profile: async id => ({ modelName: id === 'profile-a' ? 'model-a' : 'model-b' }) },
      admit: async (_id, record) => ({ presetId: 'fixture', modelSelection: { provider: 'fixture', model: record.spec.bindings.modelProfileId } }),
      env: { AGENTKIT_RUNTIME_AGENT_ID: 'fixture-agent', AGENTKIT_RUNTIME_BUILD_ID: 'build_0123456789abcdef0123',
        AGENTKIT_RUNTIME_TOKEN: token, AGENTKIT_RUNTIME_PORT: '0' } });
  }
  await restart(); t.after(() => runtime.close());
  return { history, selected, mutations, restart, turns: () => turns,
    post: body => fetch(`http://127.0.0.1:${runtime.address.port}/v1/responses`, { method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }) };
}
const request = { input: 'question', session_id: 'conversation', request_id: 'first', model: 'model-b' };

test('a Host without request fingerprint support cannot start the frozen endpoint', async () => {
  for (const promptFingerprintVersion of [undefined, 0, 2]) {
    await assert.rejects(startFrozenBuildRuntime({ ctx: { get: () => ({ promptFingerprintVersion }) },
      env: { AGENTKIT_RUNTIME_AGENT_ID: 'fixture' } }), { code: 'RUNTIME_HOST_CAPABILITY_UNAVAILABLE' });
  }
});

test('replaying an old request leaves the current session selection and log untouched', async t => {
  const f = await fixture(t);
  const first = await (await f.post(request)).json();
  assert.equal((await f.post({ ...request, request_id: 'second', input: 'follow-up', model: 'model-a' })).status, 200);
  await f.restart();
  const before = structuredClone([...f.history]), writes = f.mutations.length;
  const replay = await f.post(request);
  assert.equal(replay.status, 200); assert.deepEqual(await replay.json(), first);
  assert.equal([...f.selected.values()][0], 'profile-a');
  assert.equal(f.mutations.length, writes);
  assert.deepEqual([...f.history], before);
  assert.equal(f.turns(), 2);
});

test('missing request model authority cannot approve a model-aware legacy replay', async t => {
  const f = await fixture(t);
  assert.equal((await f.post(request)).status, 200);
  // Author a legacy controller history without either model authority field.
  for (const [id, events] of f.history) f.history.set(id, events.filter(event => !['studio/runtime-model', 'studio/runtime-response-projection'].includes(event.type)).map(event => {
    if (event.type !== 'user/message') return event;
    const { requestFingerprint, ...source } = event.data.source;
    return { ...event, data: { ...event.data, source } };
  }));
  await f.restart();
  const writes = f.mutations.length;
  const replay = await f.post({ ...request, model: 'model-a' });
  assert.equal(replay.status, 409);
  assert.equal((await replay.json()).error.code, 'RUNTIME_REQUEST_METADATA_UNAVAILABLE');
  assert.equal(f.mutations.length, writes);
});

test('a failed pre-admission model choice does not become the identity of a later accepted request', async t => {
  const f = await fixture(t, { rejectPermissionOnce: true });
  assert.equal((await f.post({ ...request, model: 'model-a' })).status, 500);
  assert.equal((await f.post(request)).status, 200);
  await f.restart();
  assert.equal((await f.post(request)).status, 200);
  assert.equal((await f.post({ ...request, model: 'model-a' })).status, 409);
  assert.equal(f.turns(), 1);
});

test('legacy replay uses the native request header even when optional model cards disagree or disappear', async t => {
  const f = await fixture(t);
  assert.equal((await f.post(request)).status, 200);
  for (const [id, events] of f.history) {
    const legacy = events.filter(event => event.type !== 'studio/runtime-response-projection').map(event => {
      if (event.type !== 'user/message') return event;
      const { requestFingerprint, ...source } = event.data.source;
      return { ...event, data: { ...event.data, source } };
    });
    legacy.splice(2, 0, { type: 'request/header', data: { header: { config: { provider: 'fixture', model: 'profile-b' } } } });
    legacy.unshift({ type: 'studio/runtime-model', ignorable: true, data: { requestId: legacy.find(event => event.type === 'user/message').data.source.rpcId, model: 'model-a' } });
    f.history.set(id, legacy.map((event, seq) => ({ ...event, seq })));
  }
  await f.restart();
  const writes = f.mutations.length;
  assert.equal((await f.post(request)).status, 200);
  // A legacy request has no delivery snapshot yet. Only its derivative
  // presentation may be appended; the native request/model remains unchanged.
  assert.deepEqual(f.mutations.slice(writes), ['append']);
  assert.equal((await f.post({ ...request, model: 'model-a' })).status, 409);
  for (const [id, events] of f.history) f.history.set(id, events.filter(event => event.type !== 'studio/runtime-model'));
  await f.restart();
  assert.equal((await f.post(request)).status, 200);
  assert.equal(f.mutations.length, writes + 1);
  assert.equal(f.turns(), 1);
});
