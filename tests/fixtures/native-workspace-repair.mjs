/** Real gateway/Kernel/SQLite and filesystem; only DSH transport policies/model
 * replies are controlled. Parent SIGKILLs confirmed-live process boundaries. */
import assert from 'node:assert/strict';
import { mkdirSync, existsSync, rmSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { NativeKernel, emptyUsage } from '@kingsoftcloud/agentkit-harness-core';
import { fixture, scope, digest } from './native-core.mjs';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { sessionKeyFor } from '@kingsoftcloud/agentkit-harness-node/native/workspace-state';
import { createNativeDshTools } from '../../src/providers/native-dsh-tools.mjs';

const [root, phase, policy] = process.argv.slice(2), workspaceRoot = join(root, 'workspace'), stateDir = join(root, 'tool-state');
mkdirSync(workspaceRoot, { recursive: true });
const readState = join(stateDir, sessionKeyFor('session'), 'read-state.json');
if (phase === 'write') mkdirSync(readState, { recursive: true }); // Actual first publication then read-state failure.
else rmSync(readState, { recursive: true, force: true });
if (phase === 'repair' && policy === 'external') writeFileSync(join(workspaceRoot, 'first.txt'), 'External user bytes');
const store = new SqliteRunStore(join(root, 'runs.sqlite')), registry = new Map(), agent = { session: { id: 'session' } };
if (policy === 'mid' && phase === 'repair') {
  const load = store.load.bind(store);
  store.load = (...args) => {
    const record = load(...args);
    if (record.snapshot.phase === 'reconciling_tool' && !existsSync(join(workspaceRoot, 'first.txt'))
      && record.intents.find(row => row.operationKey === record.snapshot.pendingIntent)?.kind === 'workspace_repair') {
      process.send({ pid: process.pid, stage: 'inverse-published-before-completion', leaseExpiresAt: record.lease.expiresAt });
      process.kill(process.pid, 'SIGSTOP'); // Parent kills a real half-finished compensation.
    }
    return record;
  };
}
let dispatches = 0, models = 0;
const ctx = { effect: install => install(), sandboxPolicy: { resolve: () => ({ mode: policy === 'denied' && phase !== 'write' ? 'read-only' : 'workspace-write' }) }, tools: {
  register: tool => { registry.set(tool.name, tool); return () => registry.delete(tool.name); },
  execute: async input => {
    dispatches++;
    assert.equal(input.name, phase === 'write' ? 'apply_workspace_patch' : 'native_repair_workspace_operation');
    if (phase === 'repair' && policy === 'session') agent.session = { id: 'foreign-session-after-admission' };
    const output = await registry.get(input.name).execute(input.arguments, input);
    return { isError: false, content: [{ type: 'text', text: phase === 'repair' && policy === 'rejected' ? 'Post-policy rejected compensation' : output.result }] };
  },
} };
const bound = createNativeDshTools({ ctx, config: { toolBindings: ['apply_workspace_patch'] }, workspaceRoot, stateDir });
const admitted = phase === 'write' ? fixture({ tools: bound.definitions(agent, [...registry.values()]), limits: { leaseMs: 1000 } }) : null;
const ports = bound.forAgent(agent, { scope, store });
if (policy === 'lost' && phase === 'repair') {
  const repair = ports.tools.repairWorkspace;
  ports.tools.repairWorkspace = async request => { const result = await repair(request);
    assert.equal(result.result?.content.compensated, true);
    return { ...result, result: null }; // Final product repair receipt persists before delivery loss.
  };
}
const kernel = new NativeKernel({ store, digest, owner: `repair-host-${process.pid}`, ports: { ...ports, model: {
  generate: async request => {
    models++;
    if (phase === 'write') return { kind: 'tool_calls', text: '', usage: emptyUsage(), toolCalls: [{ name: 'apply_workspace_patch', callId: 'partial-write', arguments: {
      patch_text: '*** Begin Patch\n*** Add File: first.txt\n+First publication\n*** Add File: second.txt\n+Never published\n*** End Patch' } }] };
    assert.equal(existsSync(join(workspaceRoot, 'first.txt')), false);
    assert.equal(existsSync(join(workspaceRoot, 'second.txt')), false);
    assert.match(request.messages.filter(message => message.role === 'tool').at(-1).content, /workspace_operation_compensated/);
    return { kind: 'final_candidate', text: 'Original unconfirmed operation was undone', toolCalls: [], usage: emptyUsage() };
  },
} } });
if (admitted) kernel.start(admitted.snapshot, admitted.config);
else {
  if (policy === 'mid' && phase === 'retry') {
    assert.equal((await kernel.runUntilIdle(scope, 'run')).phase, 'awaiting_reconciliation');
    assert.equal(dispatches, 0, 'lost compensation cannot automatically run again');
  }
  const marker = store.load(scope, 'run').snapshot.toolReconciliation;
  kernel.submit(scope, 'run', { commandId: `operator-${phase}`, kind: 'repair_workspace', payload: { originalOperationKey: marker.operationKey } });
}
const snapshot = await kernel.runUntilIdle(scope, 'run'), record = store.load(scope, 'run');
const original = record.intents.find(row => row.kind === 'tool');
process.send({ pid: process.pid, phase: snapshot.phase, configDigest: snapshot.configDigest, toolCalls: snapshot.usage.toolCalls,
  dispatches, models, originalIntent: original, originalReceipt: record.receipts.find(row => row.operationKey === original.operationKey),
  first: existsSync(join(workspaceRoot, 'first.txt')) ? readFileSync(join(workspaceRoot, 'first.txt'), 'utf8') : null,
  firstMtime: existsSync(join(workspaceRoot, 'first.txt')) ? statSync(join(workspaceRoot, 'first.txt')).mtimeMs : null,
  second: existsSync(join(workspaceRoot, 'second.txt')),
  repairReceipts: record.receipts.filter(row => row.result.contract === 'agentkit.workspace-compensation/v1'),
  repairs: record.events.filter(row => row.kind === 'workspace.repair_completed').length });
if (phase === 'write' || phase === 'repair' && policy === 'lost') setInterval(() => {}, 1000);
else { bound.close(); store.close(); process.disconnect(); }
