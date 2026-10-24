import test from 'node:test';
import assert from 'node:assert/strict';
import { createStudioManagedNativeBinding } from '../src/host/services/native-managed-binding.mjs';
import { MemoryRunStore } from '../packages/agentkit-harness-core/dist/index.mjs';
import { command, target } from './fixtures/native-managed-kernel.mjs';

// Unit-only lifecycle boundary. Actual SDK/preset/Node tools are verified by
// the packed mounted Host proof; this fixture makes races observable.
function fixture({ change, abortAfterLookup } = {}) {
  const signal = new AbortController(), cmd = command(), store = new MemoryRunStore();
  const scope = { tenantId: target.tenantId, agentId: target.agentInstanceId, workspaceId: 'workspace', userId: 'user' };
  let leases = 0, lookups = 0, releases = 0, effects = 0, owner = false;
  const host = { async resolveManagedBinding() {
    const index = ++lookups; leases++;
    if (abortAfterLookup) signal.abort(new Error('retired'));
    let released = false;
    return { scope, buildId: 'build', configuration: { revision: change && index > 1 ? 2 : 1 },
      ports: { model: Object.freeze({ async generate() { assert.equal(owner, true); assert.equal(released, false); effects++; return 'answer'; } }) },
      async releaseResources() { assert.equal(released, false); released = true; releases++; leases--; } };
  } };
  const ctx = { get: () => ({ resolveAgent: async id => ({ agent: { session: { id }, whenIdle: async () => {} } }) }) };
  const execution = { async run(request) {
    assert.equal(leases, 0, 'preview resources must be released before waiting for SDK ownership');
    owner = true;
    try { return await request.execute({ signal: signal.signal, prepareInput: async () => ({ kind: 'enter', messages: [] }) }); }
    finally { owner = false; }
  } };
  const resolve = createStudioManagedNativeBinding({ ctx, target, principal: { userId: 'user' }, resolveHost: async () => host, execution });
  const request = { command: cmd, stage: 'execute', runId: 'run', signal: signal.signal, store, admission: null };
  return { resolve, request, scope, counts: () => ({ leases, lookups, releases, effects }),
    async drive(binding, execute) { return binding.withExecution({ identity: { scope }, configuration: binding.configuration,
      signal: signal.signal, execute: execute ?? (async () => { assert.equal(await binding.ports.model.generate(), 'answer'); return { phase: 'completed' }; }) }); } };
}

test('preview ports cannot execute; live resources are reconstructed exclusively inside the Session owner', async () => {
  const f = fixture(), binding = await f.resolve(f.request);
  assert.deepEqual(f.resolve.enqueueContentFormats, ['text/plain', 'agentkit.managed-studio-input/v1']);
  assert.equal(Object.isFrozen(f.resolve.enqueueContentFormats), true);
  assert.throws(() => binding.ports.model.generate(), { code: 'NATIVE_MANAGED_OWNER_PORT_UNAVAILABLE' });
  assert.deepEqual(await f.drive(binding), { phase: 'completed' });
  await binding.release(f.request); await binding.release(f.request);
  assert.deepEqual(f.counts(), { leases: 0, lookups: 2, releases: 2, effects: 1 });
});

test('a binding change while waiting for Session ownership fails before Native effects and releases both owners', async () => {
  const f = fixture({ change: true }), binding = await f.resolve(f.request);
  await assert.rejects(f.drive(binding), { code: 'native_dsh_recovery_configuration_changed' });
  assert.deepEqual(f.counts(), { leases: 0, lookups: 2, releases: 2, effects: 0 });
});

test('execution failure releases the live owner and cannot leave usable ports behind', async () => {
  const f = fixture(), binding = await f.resolve(f.request);
  await assert.rejects(f.drive(binding, async () => { throw new Error('failure'); }), /failure/u);
  assert.throws(() => binding.ports.model.generate(), { code: 'NATIVE_MANAGED_OWNER_PORT_UNAVAILABLE' });
  assert.deepEqual(f.counts(), { leases: 0, lookups: 2, releases: 2, effects: 0 });
});

test('Host retirement after resource discovery releases a late binding without execution', async () => {
  const f = fixture({ abortAfterLookup: true });
  await assert.rejects(f.resolve(f.request), /retired/u);
  assert.deepEqual(f.counts(), { leases: 0, lookups: 1, releases: 1, effects: 0 });
});

for (const admitted of [false, true]) test(`staged file receipts retire only after durable managed admission (admitted=${admitted})`, async () => {
  const cmd = command(), agent = { session: { id: cmd.session_id }, whenIdle: async () => {} };
  const receiptId = '08719d71-2117-40f9-9a74-b59ca0337194';
  cmd.payload.content = { format: 'agentkit.managed-studio-input/v1', parts: [{ type: 'file', receiptId }] };
  const calls = [], scope = { tenantId: target.tenantId, agentId: target.agentInstanceId, userId: 'user', workspaceId: 'workspace' };
  const services = { sessionController: { resolveAgent: async () => ({ agent }) },
    attachments: { admitPromptContent: async parts => parts }, fileUploads: {
      resolve: () => ({ attachmentId: 'file' }),
      bindPrompt(receiver, ids, requestId) {
        assert.equal(receiver, agent); assert.deepEqual(ids, [receiptId]); assert.equal(requestId, cmd.command_id);
        calls.push('bind'); return { commit: () => calls.push('commit'), [Symbol.dispose]: () => calls.push('dispose') };
      }, retirePrompt(receiver, requestId) { assert.equal(receiver, agent); assert.equal(requestId, cmd.command_id); calls.push('retire'); },
    } };
  const resolve = createStudioManagedNativeBinding({ ctx: { get: key => services[key] }, target, principal: { userId: 'user' },
    resolveHost: async () => ({ resolveManagedBinding: async () => ({ scope, buildId: 'build', configuration: {}, ports: {},
      releaseResources: async () => calls.push('release') }) }), execution: { run() {} } });
  const request = { command: cmd, stage: 'admit', runId: 'run', signal: new AbortController().signal, store: new MemoryRunStore() };
  const binding = await resolve(request);
  await binding.release({ ...request, admitted }); await binding.release({ ...request, admitted });
  assert.deepEqual(calls, ['bind', 'release', ...(admitted ? ['commit', 'retire'] : []), 'dispose']);
});
