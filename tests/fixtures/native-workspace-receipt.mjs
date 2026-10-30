/** Controlled transport loss around the actual Native Host gateway. The final
 * DSH display policy is controlled; workspace, Kernel, authority and SQLite are real. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createNativeDshTools } from '../../src/providers/native-dsh-tools.mjs';
import { NativeKernel, emptyUsage } from '@kingsoftcloud/agentkit-harness-core';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { fixture, scope, digest } from './native-core.mjs';

const [root, phase, policy] = process.argv.slice(2), rejected = policy === 'reject';
const workspaceRoot = join(root, 'workspace'); mkdirSync(workspaceRoot, { recursive: true });
const store = new SqliteRunStore(join(root, 'runs.sqlite')), registry = new Map(), agent = { session: { id: 'session' } };
let effects = 0, models = 0;
const ctx = { effect: install => install(), sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }) }, tools: {
  register: tool => { registry.set(tool.name, tool); return () => registry.delete(tool.name); },
  execute: async input => {
    assert.equal(phase, 'write', 'receipt inspection cannot invoke the DSH tool dispatcher'); effects++;
    await registry.get(input.name).execute(input.arguments, input);
    return { isError: rejected, content: [{ type: 'text', text: rejected ? 'Post-policy blocked' : 'Host-filtered write receipt' }] };
  },
} };
const bound = createNativeDshTools({ ctx, config: { toolBindings: ['write_workspace_file'] }, workspaceRoot,
  stateDir: join(root, 'tool-state') });
const admitted = phase === 'write' ? fixture({ tools: bound.definitions(agent, [...registry.values()]) }) : null;
const before = phase === 'read' ? store.load(scope, 'run') : null;
const ports = bound.forAgent(agent, { scope, store });
const dispatch = ports.tools.execute;
if (phase === 'write') ports.tools.execute = async request => {
  const result = await dispatch(request);
  assert.equal(result.status, rejected ? 'uncertain' : 'ok');
  return { status: 'uncertain', content: { code: 'controlled_final_delivery_loss' } };
};
const kernel = new NativeKernel({ store, digest, owner: `host-${process.pid}`, ports: { ...ports, model: {
  generate: async request => {
    models++;
    if (phase === 'write') {
      assert.equal(models, 1);
      return { kind: 'tool_calls', text: '', usage: emptyUsage(), toolCalls: [{ name: 'write_workspace_file', callId: 'write-once',
        arguments: { path: 'once.txt', content: 'Original Host publication' } }] };
    }
    assert.equal(rejected, false, 'unknown post-policy result must block the model');
    assert.equal(request.messages.filter(message => message.role === 'tool').at(-1).content, 'Host-filtered write receipt');
    return { kind: 'final_candidate', text: 'Done', toolCalls: [], usage: emptyUsage() };
  },
} } });
if (admitted) kernel.start(admitted.snapshot, admitted.config);
else kernel.reconcileTool(scope, 'run', before.snapshot.toolReconciliation.operationKey, 'operator-original-receipt');
const snapshot = await kernel.runUntilIdle(scope, 'run'), record = store.load(scope, 'run');
const original = record.intents.find(row => row.kind === 'tool');
const report = { pid: process.pid, phase: snapshot.phase, effects, models, toolCalls: snapshot.usage.toolCalls,
  configDigest: snapshot.configDigest, originalOperationKey: original.operationKey, originalClaimedFence: original.claimedFence,
  originalReceipt: record.receipts.find(row => row.operationKey === original.operationKey),
  queryReceipt: record.receipts.find(row => row.result.contract === 'agentkit.tool-receipt-observation/v1') ?? null,
  reconciled: record.events.filter(row => row.kind === 'tool.receipt_reconciled').length };
process.send(report);
if (phase === 'write') setInterval(() => {}, 1000); // Parent kills this confirmed-live Host process.
else { bound.close(); store.close(); process.disconnect(); }
