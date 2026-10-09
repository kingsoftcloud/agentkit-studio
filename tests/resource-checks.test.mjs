import test from 'node:test';
import assert from 'node:assert/strict';
import { checkedResource, RESOURCE_CHECK_EVENT, sanitizeResourceCheck } from '../src/resource-checks.mjs';
import { prepareLocalResourceContext, writeBoundMemory } from '../src/local-runtime.mjs';

test('resource evidence distinguishes zero hits, loaded definitions, accepted writes and failed calls without exposing content', async () => {
  const checks = [], events = [];
  const agent = { session: { append: (type, data) => events.push({ type, data }) } };
  const binding = kind => ({ config: { binding: { resource: { kind, id: kind + '-test' } } } });
  const record = { spec: { runtime: { type: 'harness' }, bindings: { plugins: ['skill-space', 'knowledge-base', 'memory-instance'].map(binding) } } };
  const resourceAdapter = { loadSkill: async () => ({ definitions: [{ content: 'private skill content' }] }),
    searchKnowledge: async () => [], searchMemory: async () => [{ content: 'private memory' }], writeMemory: async () => ({ accepted: true, data: 'private result' }) };
  await prepareLocalResourceContext({ record, input: 'question', resourceAdapter, agent, onResource: check => checks.push(check) });
  await writeBoundMemory({ binding: binding('memory-instance'), resourceAdapter, agent, input: 'question', assistantText: 'answer', onResource: check => checks.push(check) });
  assert.equal(checks.find(item => item.kind === 'skill-space').definitionCount, 1);
  assert.equal(checks.find(item => item.kind === 'knowledge-base').hitCount, 0);
  assert.equal(checks.find(item => item.action === 'recall').hitCount, 1);
  assert.equal(checks.find(item => item.action === 'write').accepted, true);
  await assert.rejects(checkedResource({ kind: 'knowledge-base', resourceId: 'kb-test', action: 'search', agent },
    () => { throw Object.assign(new Error('Bearer private credential'), { code: 'KB_ACCESS_DENIED' }); }), { code: 'KB_ACCESS_DENIED' });
  assert.equal(events.at(-1).data.status, 'failed');
  assert.equal(events.at(-1).data.code, 'KB_ACCESS_DENIED');
  assert.ok(events.every(event => event.type === RESOURCE_CHECK_EVENT));
  assert.doesNotMatch(JSON.stringify(events), /private|Bearer|question|answer/);
});

test('remote resource checks admit only content-free evidence fields', () => {
  assert.deepEqual(sanitizeResourceCheck({ kind: 'knowledge-base', resourceId: 'kb-1', action: 'search', status: 'succeeded', hitCount: 0,
    apiKey: 'private', snippet: 'private', durationMs: -2 }), { kind: 'knowledge-base', resourceId: 'kb-1', action: 'search', status: 'succeeded', hitCount: 0 });
  assert.equal(sanitizeResourceCheck({ kind: 'unknown', resourceId: 'kb-1', action: 'search', status: 'succeeded' }), null);
});
