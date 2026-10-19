import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentCatalog } from '../src/agent-catalog.mjs';
const row = (id, type = 'dsh-native', createdAt = '') => ({ metadata: { id, name: id, createdAt }, spec: { runtime: { type } } });
const store = items => async () => ({ list: async () => items });
const unexpectedCloud = async () => { throw Error('Historical cloud catalog must not be queried'); };

test('catalog excludes historical frameworks before counting, sorting, searching and paging', async () => {
  const newest = row('newest', 'codex', '2026-10-08T00:00:00Z');
  const old = row('old', 'harness', '2026-10-07T00:00:00Z');
  const catalog = createAgentCatalog({ store: store([old, ...['adk', 'langchain', 'langgraph', 'openclaw', 'hermes'].map(type => row(type, type)), newest]), server: unexpectedCloud });
  const result = await catalog.list({ source: 'local', limit: 1 });
  assert.deepEqual(result.items, [newest]);
  assert.equal(result.total, 2);
  assert.deepEqual((await catalog.list({ page: 2, limit: 1 })).items, [old]);
  assert.equal((await catalog.list({ query: 'openclaw' })).total, 0);
  assert.equal((await catalog.list({ query: 'NEWEST' })).total, 1);
});

test('cloud tab stays empty until Studio deployment provenance is available', async () => {
  const catalog = createAgentCatalog({ store: unexpectedCloud, server: unexpectedCloud });
  const result = await catalog.list({ source: 'cloud' });
  assert.deepEqual(result.items, []);
  assert.equal(result.total, 0);
  await assert.rejects(catalog.list({ source: 'invalid' }), { code: 'INVALID_QUERY' });
});

test('selector can page past 100 local Agents without including legacy cloud Codex rows', async () => {
  const local = Array.from({ length: 121 }, (_, i) => row(`local-${String(i).padStart(3, '0')}`));
  const catalog = createAgentCatalog({ store: store(local), server: unexpectedCloud });
  const first = await catalog.list({ limit: 100 });
  const second = await catalog.list({ page: 2, limit: 100 });
  assert.equal(first.total, 121);
  assert.deepEqual([...first.items, ...second.items], local);
});

test('catalog preserves real build history on supported local Agents', async () => {
  const built = { id: 'build-a', revision: 1, status: 'SUCCEEDED' };
  const catalog = createAgentCatalog({ store: store([row('local-a')]), builds: async id => {
    assert.equal(id, 'local-a'); return [built];
  } });
  assert.deepEqual((await catalog.list()).items[0].builds, [built]);
});

test('cloud rows come only from deployment receipts, share sorting and never load local build history by cloud ID', async () => {
  const deployed = { ...row('cloud-new', 'codex', '2026-10-08T00:00:00Z'), source: 'studio-deployment', deployment: { id: 'deployment' } };
  const local = row('local-old', 'harness', '2026-10-07T00:00:00Z');
  const catalog = createAgentCatalog({ store: store([local]), deployments: async () => ({ items: [deployed, row('legacy', 'codex')], warnings: ['unreadable build'] }),
    builds: async id => { assert.equal(id, 'local-old'); return []; } });
  assert.equal((await catalog.list({ source: 'cloud' })).total, 1);
  assert.deepEqual((await catalog.list()).items.map(item => item.metadata.id), ['cloud-new', 'local-old']);
  assert.equal((await catalog.list({ source: 'cloud', query: 'legacy' })).total, 0);
  assert.deepEqual((await catalog.list({ source: 'local' })).warnings, []);
});

test('assistant identity comes from the current setup receipt, without hiding editable local configuration', async () => {
  const local = row('local-assistant'), expert = row('ordinary-expert');
  const cloud = { ...row('cloud-assistant'), source: 'studio-deployment', metadata: { id: 'cloud-assistant', local: false }, deployment: { id: 'dep-assistant' } };
  const catalog = createAgentCatalog({ store: store([local, expert]), deployments: async () => ({ items: [cloud] }),
    assistant: async () => ({ agentId: 'local-assistant', cloudAgentId: 'cloud-assistant', deploymentId: 'dep-assistant' }) });
  const result = await catalog.list();
  const config = result.items.find(item => item.metadata.id === 'local-assistant');
  assert.equal(config.metadata.purpose, 'personal-assistant');
  assert.equal(config.assistant.configuration, true);
  assert.equal(config.assistant.cloudAgentId, 'cloud-assistant');
  assert.equal(result.items.find(item => item.metadata.id === 'cloud-assistant').assistant.configuration, false);
  assert.equal(result.items.find(item => item.metadata.id === 'ordinary-expert').assistant, undefined);
});
