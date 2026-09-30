import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalResourceAdapters, LocalResourceError } from '../src/local-resource-adapters.mjs';

test('cloud Skill Space with no Skills is a valid empty binding', async () => {
  const calls = [];
  const adapters = createLocalResourceAdapters({
    serverClient: { skillAction: async (name, params) => { calls.push({ name, params }); return { data: { Skills: [] } }; } },
  });
  const result = await adapters.loadSkill('bcb4df65-2448-4c8a-99ca-62a12d26bce9');
  assert.deepEqual(result, { name: 'bcb4df65-2448-4c8a-99ca-62a12d26bce9', content: '' });
  assert.deepEqual(calls, [{ name: 'ListSkillsBySpaceId', params: { SpaceId: 'bcb4df65-2448-4c8a-99ca-62a12d26bce9', PageNumber: 1, PageSize: 100 } }]);
});

test('missing non-cloud Skill remains an explicit local import error', async () => {
  const adapters = createLocalResourceAdapters({
    skillDiscovery: { listInstalled: async () => ({ items: [] }) },
    serverClient: { skillAction: async () => { throw new Error('must not call cloud Skill Service'); } },
  });
  await assert.rejects(() => adapters.loadSkill('local-skill-not-installed'), error => error instanceof LocalResourceError && error.code === 'SKILL_NOT_INSTALLED');
});

test('memory adapter uses QueryMemorySdk and normalizes the returned memories', async () => {
  let call;
  const adapters = createLocalResourceAdapters({
    serverClient: { action: async (...args) => { call = args; return { data: [{ Memories: [{ content: '历史偏好' }] }] }; } },
  });
  const result = await adapters.searchMemory('mem-1', '偏好', 'user-1');
  assert.deepEqual(result, [{ content: '历史偏好' }]);
  assert.equal(call[0], 'QueryMemorySdk');
  assert.deepEqual(call[1], { MemoryCollectionId: 'mem-1', AgentUserId: 'user-1', Query: '偏好', Limit: 5, SceneId: '_sys_general' });
  assert.deepEqual(call[2], { apiVersion: '2025-11-14' });
});
