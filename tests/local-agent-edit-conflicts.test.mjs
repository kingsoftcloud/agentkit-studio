import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createAgentStore } from '../src/agent-store.mjs';
import { createHostRemote } from '../src/client/remote/host-client.mjs';
import { createAgentRoutes } from '../src/host/routes/agents.mjs';
import { createControlPlaneDispatcher } from '../src/host/routes/dispatcher.mjs';
import { STUDIO_OPERATION_IDS } from '../src/contracts/operations.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'studio-agent-editor-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createAgentStore({ storeDir: root }), owner = new AbortController();
  const agentRoutes = createAgentRoutes({ agentStorePromise: Promise.resolve(store),
    templateAuthoring: { create: ({ templateSource, ...input }) => store.create(input) } });
  const routes = Object.fromEntries(STUDIO_OPERATION_IDS.map(id => [id.split('/')[0], async endpoint => {
    throw new Error(`Unexpected operation: ${endpoint}`);
  }]));
  routes.agents = agentRoutes;
  routes.builds = async endpoint => {
    assert.equal(endpoint, 'builds/list');
    return { ok: true, value: { items: [] } };
  };
  const dispatch = createControlPlaneDispatcher({ bridge: { signal: owner.signal }, routes });
  const client = () => createHostRemote({ rpc: { call: async (channel, endpoint, payload, signal) => {
    assert.equal(channel, '/agentkit');
    return dispatch(endpoint, payload, signal);
  } } }, { window: { location: { origin: 'http://localhost', hash: '' } } });
  const left = client(), right = client();
  const first = await left.createAgent({ name: 'Original', runtimeType: 'harness',
    spec: { instructions: { system: 'initial' }, bindings: { skills: ['skill-original'] } } });
  return { root, store, owner, dispatch, left, right, first };
}

test('two Studio editors cannot overwrite a newer local Agent revision or its resource bindings', async t => {
  const { store, left, right, first } = await fixture(t), id = first.metadata.id;
  const [leftView, rightView] = await Promise.all([left.agent(id), right.agent(id)]);
  const saved = await left.updateAgent(id, { instructions: { system: 'new instruction' } }, leftView.metadata.revision, 'Latest');
  assert.equal(saved.metadata.revision, 2);
  const conflict = { code: 'AGENT_EXPECTED_REVISION_CONFLICT',
    details: { agentId: id, expectedRevision: 1, actualRevision: 2 } };
  await assert.rejects(right.updateAgent(id, { instructions: { system: 'stale instruction' } }, rightView.metadata.revision, 'Stale'), conflict);
  await assert.rejects(right.updateAgentBindings(id, { skills: ['stale-skill'] }, rightView.metadata.revision), conflict);
  assert.equal((await store.get(id)).metadata.name, 'Latest');
  assert.equal((await store.get(id)).spec.instructions.system, 'new instruction');
  assert.deepEqual((await store.get(id)).bindings.skills, ['skill-original']);
  assert.deepEqual((await store.listRevisions(id)).map(row => row.metadata.revision), [1, 2]);
  const refreshed = await right.agent(id);
  const bound = await right.updateAgentBindings(id, { skills: ['new-skill'] }, refreshed.metadata.revision);
  assert.equal(bound.metadata.revision, 3);
  assert.deepEqual(bound.bindings.skills, ['new-skill']);
  assert.equal((await store.getRevision(id, 1)).spec.instructions.system, 'initial');
  assert.deepEqual((await store.getRevision(id, 2)).bindings.skills, ['skill-original']);
});

test('simultaneous Studio saves publish exactly one revision and reject invalid expected versions without writing', async t => {
  const { store, dispatch, left, right, first } = await fixture(t), id = first.metadata.id;
  const results = await Promise.allSettled([
    left.updateAgent(id, { instructions: { system: 'left' } }, 1),
    right.updateAgent(id, { instructions: { system: 'right' } }, 1),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'AGENT_EXPECTED_REVISION_CONFLICT');
  const saved = await store.get(id);
  for (const expectedRevision of [0, -1, 1.5, '2', null]) {
    const result = await dispatch('agents/update-local', { agentId: id, name: 'invalid', expectedRevision });
    assert.equal(result.error?.code, 'INVALID_EXPECTED_AGENT_REVISION');
  }
  assert.deepEqual(await store.get(id), saved);
  assert.equal((await store.listRevisions(id)).length, 2);
});

test('Host cancellation while a Studio save waits for the publication lock cannot publish an Agent revision', async t => {
  const { root, store, owner, left, first } = await fixture(t), id = first.metadata.id;
  const original = await store.get(id);
  await mkdir(join(root, '.mutation-locks'), { recursive: true });
  const lock = new DatabaseSync(join(root, '.mutation-locks', `${id}.sqlite`));
  lock.exec('BEGIN IMMEDIATE');
  try {
    const pending = left.updateAgent(id, { instructions: { system: 'forbidden after cancellation' } }, 1);
    // Let admission reach the contended publication lock before unloading Host.
    await new Promise(resolve => setTimeout(resolve, 35));
    owner.abort();
    lock.exec('ROLLBACK');
    await assert.rejects(pending, { code: 'gateway/cancelled' });
    assert.deepEqual(await store.get(id), original);
    assert.deepEqual(await store.listRevisions(id), [original]);
  } finally { lock.close(); }
});
