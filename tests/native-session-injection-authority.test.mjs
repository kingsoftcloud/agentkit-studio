import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryRunStore } from '@kingsoftcloud/agentkit-harness-core';
import { createStudioNativeSessionInjection } from '../src/host/services/native-session-injection.mjs';

function setup(options = {}) {
  const lifetime = new AbortController(), store = new MemoryRunStore(); let writes = 0, reads = 0;
  const inject = store.inject.bind(store); store.inject = (...args) => { writes++; return inject(...args); };
  const agent = { session: { id: 'session' }, externalTurns: { pending: () => options.owner ?? null } };
  const binding = { agentId: 'agent', agentRevision: 1, local: true, runtime: 'harness', nativeEngineContract: 'agentkit.native-dsh-turn/v1' };
  const service = createStudioNativeSessionInjection({ store, lifetime, workspaceId: 'workspace',
    agents: { getRevision: async () => { await options.beforeRevision?.(); return {
      metadata: { id: 'agent', revision: 1, local: true }, spec: { runtime: { type: 'harness' } },
    }; } },
    ctx: { get: name => name === 'sessionController' ? { resolveAgent: async () => {
      await options.beforeSession?.(); return { agent };
    } } : undefined },
    agentEvents: () => ({ serial: async () => { reads++; return options.readBinding?.(reads, binding) ?? binding; } }),
  });
  const request = { agentId: 'agent', sessionId: 'session', injectionId: 'record', text: 'External data', source: { kind: 'channel', ref: 'event' } };
  return { service, lifetime, request, writes: () => writes };
}

test('caller mutation while ownership is resolving cannot retarget an injection', async () => {
  const ready = Promise.withResolvers(), release = Promise.withResolvers();
  const f = setup({ beforeSession: async () => { ready.resolve(); await release.promise; } });
  const pending = f.service.inject(f.request); await ready.promise;
  f.request.agentId = 'foreign'; f.request.sessionId = 'foreign'; f.request.text = 'Changed'; release.resolve();
  const receipt = await pending;
  assert.equal(receipt.agentId, 'agent'); assert.equal(receipt.sessionId, 'session'); assert.equal(f.writes(), 1);
});

test('Host shutdown releases a noncooperative lookup and a late result cannot persist data', async () => {
  const ready = Promise.withResolvers(), release = Promise.withResolvers();
  const f = setup({ beforeSession: async () => { ready.resolve(); await release.promise; } });
  const pending = f.service.inject(f.request); await ready.promise;
  f.lifetime.abort(new Error('Host closed')); await assert.rejects(pending, /Host closed/);
  release.resolve(); await new Promise(resolve => setImmediate(resolve)); assert.equal(f.writes(), 0);
});

test('preset drift during asynchronous ownership checks denies injection before a store write', async () => {
  const f = setup({ readBinding: (index, binding) => index > 1 ? { ...binding, agentRevision: 2 } : binding });
  await assert.rejects(f.service.inject(f.request), { code: 'STUDIO_NATIVE_INJECTION_BINDING_CHANGED' });
  assert.equal(f.writes(), 0);
});

test('a local control cannot silently write into an active Server-owned session, while trusted scope lookup remains available', async () => {
  const f = setup({ owner: { engine: 'agentkit.native-managed-dsh-turn/v1' } });
  await assert.rejects(f.service.inject(f.request), { code: 'NATIVE_MANAGED_SERVER_CONTROL_REQUIRED' });
  assert.equal(f.writes(), 0);
  assert.equal((await f.service.resolveScope(f.request)).agentId, 'agent');
});
