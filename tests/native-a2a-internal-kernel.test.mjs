// Actual NativeKernel/SQLite + Studio gateway + projected token files + real
// control-plane/peer HTTP. DSH registry and consent are explicit test ports;
// this is not a mounted production Host/browser/model acceptance claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { NativeKernel, emptyUsage, canonical } from '@kingsoftcloud/agentkit-harness-core';
import { fixture, digest } from './fixtures/native-core.mjs';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { createNativeDshTools } from '../src/providers/native-dsh-tools.mjs';
import { internalPeer, spec, scope, taskId } from './fixtures/native-a2a-internal-peer.mjs';
for (const lost of [false, true]) test(`actual Native turn ${lost ? 'retains unknown effect after lost Bind' : 'completes through the internal managed A2A transport'}`, async t => {
  const f = await internalPeer({ streaming: true, mode: lost ? 'bind-lost' : 'complete' }), stateDir = join(f.root, 'state');
  f.setRecordDirectory(join(stateDir, 'a2a-calls'));
  const store = new SqliteRunStore(join(f.root, 'runs.sqlite')), registry = new Map(); let models = 0, approvals = 0;
  const ctx = { effect: work => work(), sandboxPolicy: { resolve: () => ({ mode: 'read-only' }) },
    approval: { request: async () => { approvals++; return 'allowed-once'; } }, tools: {
      register(value) { registry.set(value.name, value); return () => registry.delete(value.name); },
      async execute(input) {
        const tool = registry.get(input.name);
        try { const value = await tool.execute(input.arguments, input);
          return { isError: false, value, content: tool.output.render(input.arguments, value) }; }
        catch (error) { return { isError: true, content: [{ type: 'text', text: error.code ?? error.message }] }; }
      },
    } };
  const gateway = createNativeDshTools({ ctx, config: { agentId: scope.agentId, a2aBindings: [spec] },
    workspaceRoot: f.workspaceRoot, stateDir, commandEnvironment: f.env });
  t.after(async () => { await gateway.close(); store.close(); await f.close(); });
  const agent = { session: { id: 'session' } }, definitions = gateway.definitions(agent, [...registry.values()]);
  const data = fixture({ tools: definitions }), bound = gateway.forAgent(agent, { scope, store });
  const kernel = new NativeKernel({ store, digest, owner: 'internal-a2a-kernel', ports: { ...bound, model: { generate: async request => {
    models++;
    if (models === 1) return { kind: 'tool_calls', text: '', usage: emptyUsage(), toolCalls: [
      { callId: 'call', name: 'call_a2a_agent', arguments: { agent: 'research', message: 'Hello😀' } }] };
    const output = JSON.parse(request.messages.filter(value => value.role === 'tool').at(-1).content);
    assert.equal(output.ok, true, canonical(output)); assert.equal(output.task_id, taskId); assert.equal(output.state, 'completed');
    return { kind: 'final_candidate', text: 'Done.', toolCalls: [], usage: emptyUsage() };
  } } } });
  kernel.start({ ...data.snapshot, scope, runId: 'run', turnId: 'turn' }, data.config);
  const result = await kernel.runUntilIdle(scope, 'run');
  assert.equal(result.phase, lost ? 'awaiting_reconciliation' : 'completed');
  assert.equal(models, lost ? 1 : 2); assert.equal(approvals, 1);
  assert.equal(f.calls.filter(value => value.wireMethod?.startsWith('Send')).length, 1);
  assert.equal(f.record().request.native.runId, 'run');
  // A cold executor replaces the original owner, including its asynchronous
  // event delivery. Settle that owner before measuring any recovery traffic.
  await gateway.close();
  const ledger = canonical(store.load(scope, 'run')), count = f.calls.length;
  const replacement = new NativeKernel({ store, digest, owner: 'cold', ports: { tools: { execute: () => assert.fail('cold tool replay') },
    model: { generate: () => assert.fail('cold model replay') } } });
  await replacement.runUntilIdle(scope, 'run'); assert.equal(f.calls.length, count);
  const after = store.load(scope, 'run'); const before = JSON.parse(ledger);
  if (lost) before.fence = after.fence;
  assert.equal(canonical(after), canonical(before));
  assert.doesNotMatch(canonical(after), /private-permit|external-key|public-token-must-not-leak/u);
});
