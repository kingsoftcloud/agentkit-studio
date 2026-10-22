import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareLocalResourceContext } from '../src/local-runtime.mjs';
import { createCodexResourceContext } from '../src/providers/codex-resource-context.mjs';

const plugin = (id, enabled = true) => ({ enabled, config: { binding: { resource: { kind: 'skill-space', id } } } });
const bindings = () => ({ skills: ['local-skill', 'space-first'], plugins: [
  plugin('space-first'), plugin('space-second'), plugin('space-second'), plugin('disabled-space', false),
] });

for (const profile of ['dsh-native', 'harness', 'codex']) {
  test(`${profile} consumes every bound Skill Space once and excludes disabled bindings`, async () => {
    const loaded = [];
    const result = await prepareLocalResourceContext({ record: { spec: { runtime: { type: profile }, bindings: bindings() } },
      resourceAdapter: { loadSkill: async id => { loaded.push(id); return { name: id, content: `EXCLUSIVE_${id}` }; } },
      input: 'use both spaces', resourceMode: 'context-only' });
    assert.deepEqual(loaded, ['local-skill', 'space-first', 'space-second']);
    for (const id of loaded) assert.ok(result.resourceContext.includes(`EXCLUSIVE_${id}`));
    assert.ok(!result.resourceContext.includes('disabled-space'));
  });
  test(`${profile} reports failure in the second bound Space instead of silently omitting it`, async () => {
    await assert.rejects(prepareLocalResourceContext({ record: { spec: { runtime: { type: profile }, bindings: {
      plugins: [plugin('space-first'), plugin('space-second')],
    } } }, resourceAdapter: { loadSkill: async id => {
      if (id === 'space-second') throw Object.assign(new Error('controlled missing space'), { code: 'SKILL_SPACE_UNAVAILABLE' });
      return { content: 'first-space' };
    } }, resourceMode: 'context-only' }), { code: 'SKILL_SPACE_UNAVAILABLE' });
  });
}

test('Codex resource preparation retains both bound Space contexts', async () => {
  const record = { spec: { runtime: { type: 'codex' }, bindings: { plugins: [plugin('space-first'), plugin('space-second')] } } };
  const context = createCodexResourceContext({ agentStore: { get: async () => record }, builds: {}, resources: {
    loadSkill: async id => ({ name: id, content: `EXCLUSIVE_${id}` }),
  } });
  const result = await context({ agentId: 'managed-agent', userId: 'trusted-user' });
  assert.match(result.systemPrompt, /EXCLUSIVE_space-first/);
  assert.match(result.systemPrompt, /EXCLUSIVE_space-second/);
});
