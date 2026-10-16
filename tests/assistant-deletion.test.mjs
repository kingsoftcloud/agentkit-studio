import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access, symlink, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAssistantLifecycle } from '../src/assistant-lifecycle.mjs';
import { createAssistantRetirement } from '../src/assistant-retirement.mjs';
import { createPersonalAssistantRuntime } from '../src/personal-assistant-runtime.mjs';

async function temp(t) { const root = await mkdtemp(join(tmpdir(), 'studio-assistant-delete-')); t.after(() => rm(root, { recursive: true, force: true })); return realpath(root); }
const payload = { agentId: 'ar-owned', confirmAgentId: 'ar-owned', deploymentId: 'deployment-owned', versionId: 'v1' };
function deploymentFixture() {
  const record = { id: payload.deploymentId, cloudAgentId: payload.agentId, agentId: 'local-agent', buildId: 'build-owned', versionId: 'v1', runtime: 'dsh-native', state: 'READY' };
  const calls = [], service = {
    get: async () => ({ ...record }),
    agents: { connect: async () => ({ agent: { deployment: { id: record.id } }, capabilities: ['personal-assistant-delete/v1'], endpoint: 'https://runtime.example.test', token: 'fixture-token' }) },
    remove: async () => { calls.push('remove'); record.state = 'DELETED'; return { ...record }; },
  };
  return { record, calls, service };
}
test('assistant closes only after data erasure, and resumed deletion never repeats cleanup', async t => {
  const directory = await temp(t), f = deploymentFixture(); let fetches = 0;
  f.service.remove = async () => { f.calls.push('remove'); f.record.state = fetches && f.calls.length > 1 ? 'DELETED' : 'DELETING'; return { ...f.record }; };
  const options = { directory, deployments: async () => f.service, fetchImpl: async (_url, init) => {
    fetches++; assert.equal(init.method, 'POST');
    return Response.json({ deleted: true, historyDeleted: true, memoryDeleted: true, agentId: f.record.agentId, buildId: f.record.buildId });
  } };
  assert.equal((await createAssistantLifecycle(options).close(payload)).status, 'deleting');
  assert.equal((await createAssistantLifecycle(options).close(payload)).status, 'closed');
  assert.equal(fetches, 1); assert.equal(f.calls.length, 2);
});
test('wrong ownership, an old image or unconfirmed cleanup cannot delete a deployment', async t => {
  const directory = await temp(t), f = deploymentFixture(); let requests = 0;
  const lifecycle = createAssistantLifecycle({ directory, deployments: async () => f.service, fetchImpl: async () => { requests++; return Response.json({ deleted: false }); } });
  await assert.rejects(lifecycle.close({ ...payload, confirmAgentId: 'wrong' }), { code: 'ASSISTANT_DELETE_CONFIRMATION_REQUIRED' });
  await assert.rejects(lifecycle.close({ ...payload, versionId: 'stale' }), { code: 'ASSISTANT_DELETE_SCOPE_CHANGED' });
  await assert.rejects(lifecycle.close(payload), { code: 'ASSISTANT_DELETE_UNCONFIRMED' });
  assert.equal(f.calls.length, 0); assert.equal(requests, 1);
  f.service.agents.connect = async () => ({ agent: { deployment: { id: payload.deploymentId } }, capabilities: [] });
  await assert.rejects(lifecycle.close(payload), { code: 'ASSISTANT_DELETE_UPGRADE_REQUIRED' });
  assert.equal(f.calls.length, 0);
});
test('retirement erases only receipt-owned runtime files after native writers drain', async t => {
  const root = await temp(t), hash = 'a'.repeat(64), calls = [];
  for (const name of ['agentkit', 'dsh', 'shared']) { await mkdir(join(root, name)); await writeFile(join(root, name, 'data'), name); }
  await writeFile(join(root, '.agentkit-runtime.json'), JSON.stringify({ format: 'agentkit.runtime-state/v1', bundleSha256: hash }));
  const ctx = { get: name => ({
    sessionController: { list: async () => ({ items: [{ sessionId: 'assistant' }] }), cancel: async () => calls.push('cancel') },
    schedule: { catalog: async () => [{ id: 'timer', sessionId: 'assistant' }], delete: async () => calls.push('timer') },
    agents: { list: () => [] }, sessions: { list: () => ['session'], flush: async () => { calls.push('flush'); return true; } },
  })[name] };
  const env = { AGENTKIT_HOME: join(root, 'agentkit'), DSH_HOME: join(root, 'dsh'), AGENTKIT_BUNDLE_SHA256: hash, AGENTKIT_RUNTIME_AGENT_ID: 'agent', AGENTKIT_RUNTIME_BUILD_ID: 'build' };
  const retire = await createAssistantRetirement({ ctx, env }); assert.equal(typeof retire, 'function');
  const result = await retire(async () => { calls.push('memory'); return { count: 2 }; });
  assert.deepEqual(calls, ['timer', 'cancel', 'flush', 'memory']); assert.equal(result.historyDeleted, true);
  await assert.rejects(access(join(root, 'dsh')), { code: 'ENOENT' }); await assert.rejects(access(join(root, 'agentkit')), { code: 'ENOENT' });
  assert.equal(await readFile(join(root, 'shared/data'), 'utf8'), 'shared');
  assert.equal(JSON.parse(await readFile(join(root, '.assistant-closed.json'))).phase, 'closed');
  assert.deepEqual(await retire(() => assert.fail('cleanup repeated')), result);
});
test('unowned or linked runtime directories cannot gain delete capability', async t => {
  const root = await temp(t), hash = 'b'.repeat(64);
  await mkdir(join(root, 'agentkit')); await mkdir(join(root, 'outside')); await symlink(join(root, 'outside'), join(root, 'dsh'));
  await writeFile(join(root, '.agentkit-runtime.json'), JSON.stringify({ format: 'agentkit.runtime-state/v1', bundleSha256: hash }));
  const env = { AGENTKIT_HOME: join(root, 'agentkit'), DSH_HOME: join(root, 'dsh'), AGENTKIT_BUNDLE_SHA256: hash };
  assert.equal(await createAssistantRetirement({ ctx: {}, env }), null);
});
test('closing drains only the bound assistant memory partition and blocks new messages', async () => {
  const memories = Array.from({ length: 205 }, (_, index) => ({ id: `m-${index}` })), calls = [];
  const adapter = { listMemory: async (...args) => { calls.push(args); return { items: memories.slice(0, 100), hasMore: memories.length > 100 }; }, deleteMemory: async (_collection, _user, id, options) => {
    assert.equal(options.agentId, 'owned-agent'); memories.splice(memories.findIndex(item => item.id === id), 1); return { accepted: true };
  } };
  const api = createPersonalAssistantRuntime({ ctx: { get: () => ({}) }, agentId: 'owned-agent', buildId: 'b',
    frozen: { spec: { runtime: { type: 'dsh-native' }, bindings: { plugins: [{ config: { binding: { resource: { kind: 'memory-instance', id: 'shared-collection' } } } }] } } },
    resources: async () => adapter, retirement: async clear => ({ deleted: true, ...(await clear()) }) });
  const result = await api('close'); assert.equal(result.count, 205); assert.equal(memories.length, 0);
  assert.ok(calls.every(([collection, user, options]) => collection === 'shared-collection' && user === 'studio-anonymous' && options.agentId === 'owned-agent'));
  await assert.rejects(api('submit', { requestId: 'later', text: 'run' }), { code: 'ASSISTANT_CLOSED' });
});
