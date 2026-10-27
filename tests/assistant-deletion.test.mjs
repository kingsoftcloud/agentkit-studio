import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access, symlink, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAssistantRetirement } from '../src/assistant-retirement.mjs';
import { createPersonalAssistantRuntime } from '../src/personal-assistant-runtime.mjs';

async function temp(t) { const root = await mkdtemp(join(tmpdir(), 'studio-assistant-delete-')); t.after(() => rm(root, { recursive: true, force: true })); return realpath(root); }
test('retirement erases only receipt-owned runtime files after native writers drain', async t => {
  const root = await temp(t), hash = 'a'.repeat(64), calls = [];
  const liveAgent = { session: { id: 'assistant' }, status: 'idle' };
  for (const name of ['agentkit', 'dsh', 'shared']) { await mkdir(join(root, name)); await writeFile(join(root, name, 'data'), name); }
  await writeFile(join(root, '.agentkit-runtime.json'), JSON.stringify({ format: 'agentkit.runtime-state/v1', bundleSha256: hash }));
  const ctx = { get: name => ({
    sessionController: { list: async () => ({ items: [{ sessionId: 'assistant' }] }), cancel: async () => calls.push('cancel') },
    schedule: { catalog: async () => [{ id: 'timer', sessionId: 'assistant' }], delete: async () => calls.push('timer') },
    agents: { get: id => id === liveAgent.session.id ? liveAgent : undefined, list: () => [liveAgent] }, sessions: { list: () => ['session'], flush: async () => { calls.push('flush'); return true; } },
    storageDomain: { closeAll: async () => { await access(join(root, 'dsh/data')); calls.push('domains'); } },
    sessionPersistence: { flush: async () => calls.push('persistence') },
  })[name] };
  const env = { AGENTKIT_HOME: join(root, 'agentkit'), DSH_HOME: join(root, 'dsh'), AGENTKIT_BUNDLE_SHA256: hash, AGENTKIT_RUNTIME_AGENT_ID: 'agent', AGENTKIT_RUNTIME_BUILD_ID: 'build' };
  const retire = await createAssistantRetirement({ ctx, env }); assert.equal(typeof retire, 'function');
  const result = await retire(async () => { calls.push('memory'); return { count: 2 }; });
  assert.deepEqual(calls, ['timer', 'cancel', 'flush', 'memory', 'domains', 'persistence']); assert.equal(result.historyDeleted, true);
  await assert.rejects(access(join(root, 'dsh')), { code: 'ENOENT' }); await assert.rejects(access(join(root, 'agentkit')), { code: 'ENOENT' });
  assert.equal(await readFile(join(root, 'shared/data'), 'utf8'), 'shared');
  assert.equal(JSON.parse(await readFile(join(root, '.assistant-closed.json'))).phase, 'closed');
  assert.deepEqual(await retire(() => assert.fail('cleanup repeated')), result);
});

async function retirementFixture(t) {
  const root = await temp(t), hash = 'c'.repeat(64), calls = [];
  for (const name of ['agentkit', 'dsh']) { await mkdir(join(root, name)); await writeFile(join(root, name, 'data'), name); }
  await writeFile(join(root, '.agentkit-runtime.json'), JSON.stringify({ format: 'agentkit.runtime-state/v1', bundleSha256: hash }));
  const live = new Map([['live', { session: { id: 'live' }, status: 'idle' }]]);
  const services = {
    sessionController: {
      list: async () => { calls.push('catalog'); return { items: [{ sessionId: 'cold' }, { sessionId: 'live' }] }; },
      resolveAgent: async () => assert.fail('Retirement must not restore a cold Session'),
      cancel: ({ sessionId }) => {
        assert.ok(live.has(sessionId), 'Only an existing live Agent may be cancelled'); calls.push(`cancel:${sessionId}`); return { accepted: true };
      },
    },
    agents: { get: id => live.get(id), list: () => [...live.values()] },
    sessions: { list: () => [], flush: async () => { calls.push('flush'); return true; } },
    storageDomain: { closeAll: async () => { await access(join(root, 'dsh/data')); calls.push('domains'); } },
    sessionPersistence: { flush: async () => calls.push('persistence') },
  };
  const ctx = { get: name => services[name] }, env = { AGENTKIT_HOME: join(root, 'agentkit'), DSH_HOME: join(root, 'dsh'), AGENTKIT_BUNDLE_SHA256: hash };
  return { root, calls, live, services, ctx, env, clearMemory: async () => { calls.push('memory'); return { count: 0 }; } };
}

test('retirement keeps cold catalog reads but never cancels or resumes their absent Agents', async t => {
  const f = await retirementFixture(t), retire = await createAssistantRetirement(f);
  assert.equal((await retire(f.clearMemory)).deleted, true);
  assert.deepEqual(f.calls, ['catalog', 'cancel:live', 'memory', 'domains', 'persistence']);
  await assert.rejects(access(join(f.root, 'dsh')), { code: 'ENOENT' });
});

test('an all-cold deployment retires without creating or cancelling any Agent', async t => {
  const f = await retirementFixture(t); f.live.clear();
  const retire = await createAssistantRetirement(f);
  assert.equal((await retire(f.clearMemory)).deleted, true);
  assert.deepEqual(f.calls, ['catalog', 'memory', 'domains', 'persistence']);
});

test('native live lookup and cancel dispatch share one synchronous boundary', async t => {
  const f = await retirementFixture(t);
  f.services.agents.get = id => {
    const current = f.live.get(id);
    if (current) queueMicrotask(() => f.live.delete(id));
    return current;
  };
  const retire = await createAssistantRetirement(f);
  assert.equal((await retire(f.clearMemory)).deleted, true);
  assert.ok(f.calls.includes('cancel:live'));
});

test('a live cancellation failure remains visible and prevents memory or filesystem deletion', async t => {
  const f = await retirementFixture(t), failure = Object.assign(new Error('live cancellation failed'), { code: 'session/not-found' });
  f.services.sessionController.cancel = () => { f.calls.push('cancel-failed'); throw failure; };
  const retire = await createAssistantRetirement(f);
  await assert.rejects(retire(f.clearMemory), error => error === failure);
  assert.deepEqual(f.calls, ['catalog', 'cancel-failed']);
  await access(join(f.root, 'agentkit/data')); await access(join(f.root, 'dsh/data'));
  assert.equal(JSON.parse(await readFile(join(f.root, '.assistant-closed.json'))).phase, 'closing');
  // A subsequent attempt can observe that the Agent has genuinely gone away.
  f.live.clear();
  assert.equal((await retire(f.clearMemory)).deleted, true);
  assert.equal(f.calls.filter(call => call === 'cancel-failed').length, 1);
});

test('a Host without live-Agent lookup does not advertise safe retirement', async t => {
  const f = await retirementFixture(t); delete f.services.agents.get;
  assert.equal(await createAssistantRetirement(f), null);
  assert.deepEqual(f.calls, []); await access(join(f.root, 'dsh/data'));
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

test('retirement includes managed workspace files while leaving unrelated siblings untouched', async t => {
  const f = await retirementFixture(t), workspace = join(f.root, 'assistant-workspaces');
  await mkdir(join(workspace,'owned','files'),{recursive:true}); await writeFile(join(workspace,'owned','files','note.txt'),'private workspace note');
  await mkdir(join(f.root,'unrelated')); await writeFile(join(f.root,'unrelated','keep.txt'),'keep');
  const retire = await createAssistantRetirement(f), result = await retire(f.clearMemory);
  assert.equal(result.workspaceDeleted,true); await assert.rejects(access(workspace),{code:'ENOENT'});
  assert.equal(await readFile(join(f.root,'unrelated','keep.txt'),'utf8'),'keep');
});

test('a substituted workspace root blocks cleanup before memory or unrelated files are touched', async t => {
  const f = await retirementFixture(t), outside = join(f.root,'outside');
  await mkdir(outside); await writeFile(join(outside,'keep.txt'),'outside');
  await symlink(outside,join(f.root,'assistant-workspaces'));
  const retire = await createAssistantRetirement(f);
  await assert.rejects(retire(f.clearMemory),{code:'ASSISTANT_DELETE_SCOPE_INVALID'});
  assert.equal(f.calls.includes('memory'),false); assert.equal(await readFile(join(outside,'keep.txt'),'utf8'),'outside');
  await access(join(f.root,'agentkit','data')); await access(join(f.root,'dsh','data'));
});


