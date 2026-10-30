import { join } from 'node:path';
import { NativeKernel, emptyUsage, canonical } from '../../dist/index.mjs';
import { fixture, tool, scope, digest } from '../fixtures.mjs';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
const [mode, root, origin, checkpoint] = process.argv.slice(2);
const store = new SqliteRunStore(join(root, 'runs.sqlite'));
const contract = 'agentkit.tool-receipt-observation/v1';
const definition = tool({ name: 'remote', readOnly: false, concurrentSafe: false,
  recoveryPolicy: 'receipt-observation/v1', timeoutMs: 5000 });
const data = fixture({ tools: [definition], limits: { leaseMs: 3000, effectTimeoutMs: 10000 }, profile: { ...fixture().config.profile, requestTimeoutMs: 9000 } });
const kernel = new NativeKernel({ store, digest, owner: `worker-${process.pid}`, ports: {
  model: { generate: async request => request.messages.some(message => message.role === 'tool')
    ? { kind: 'final_candidate', text: 'Completed original remote operation', toolCalls: [], usage: emptyUsage() }
    : { kind: 'tool_calls', text: '', toolCalls: [{ callId: 'original', name: 'remote', arguments: { input: 'original' } }], usage: emptyUsage() } },
  tools: {
    execute: async request => {
      await fetch(origin + '/execute', { method: 'POST', signal: request.signal,
        body: canonical({ operationKey: request.operationKey, callId: request.call.callId, arguments: request.call.arguments }) });
      return { status: 'uncertain', content: { code: 'remote_wait' } };
    },
    observeReceipt: async request => {
      const response = await fetch(origin + '/receipt', { method: 'POST', signal: request.signal,
        body: canonical({ operationKey: request.operationKey, originalOperationKey: request.originalOperationKey,
          callId: request.call.callId, originalClaimedFence: request.originalClaimedFence, executionFence: request.executionFence }) });
      const result = await response.json();
      return { contract, originalOperationKey: request.originalOperationKey, callId: request.call.callId, result };
    },
  },
} });
if (mode === 'run') {
  kernel.start(data.snapshot, data.config);
  const waiting = await kernel.runUntilIdle(scope, 'run');
  if (checkpoint === 'query-entered') {
    kernel.reconcileTool(scope, 'run', waiting.toolReconciliation.operationKey, 'lost-read');
    await kernel.runUntilIdle(scope, 'run');
  }
  process.send({ ready: true, pid: process.pid, phase: waiting.phase });
  setInterval(() => {}, 1000);
} else {
  const before = await kernel.runUntilIdle(scope, 'run');
  process.send({ observed: true, pid: process.pid, phase: before.phase });
  await new Promise(resolve => process.once('message', resolve));
  kernel.reconcileTool(scope, 'run', before.toolReconciliation.operationKey, 'confirmed-read');
  const result = await kernel.runUntilIdle(scope, 'run'), ledger = store.load(scope, 'run');
  process.send({ done: true, pid: process.pid, node: process.version, snapshot: result, intents: ledger.intents, receipts: ledger.receipts,
    events: ledger.events.filter(event => ['tool.receipt_reconciled', 'tool.receipt_unavailable'].includes(event.kind)) });
  store.close(); process.disconnect();
}
