import { join } from 'node:path';
import { NativeKernel, emptyUsage } from '@kingsoftcloud/agentkit-harness-core';
import { digest } from './native-core.mjs';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { prepareNativeA2AHost } from '../../src/providers/native-a2a-host.mjs';
import { createNativeA2aReceiptObserver, createNativeA2aReceiptWaiter } from '../../src/providers/native-a2a-receipt.mjs';
import { scope, spec } from './native-a2a-internal-peer.mjs';

process.once('message', async ({ root, workspaceRoot, env, action }) => {
  const store = new SqliteRunStore(join(root, 'runs.sqlite'));
  const a2a = prepareNativeA2AHost({ env, bindings: [spec] });
  const fields = { a2a, scope, sessionId: 'session', store, stateRoot: join(root, 'state'), workspaceRoot, isClosed: () => false };
  let modelCalls = 0;
  try {
    const kernel = new NativeKernel({ store, digest, owner: `cold-${process.pid}`, ports: {
      model: { generate: async () => { modelCalls++; return { kind: 'final_candidate', text: 'Original task completed',
        toolCalls: [], usage: emptyUsage() }; } },
      tools: { execute: () => { throw Error('Original remote tool MUST NOT execute again'); },
        observeReceipt: createNativeA2aReceiptObserver(fields) },
    } });
    let snapshot = store.load(scope, 'run').snapshot, command;
    if (!store.load(scope, 'run').commands.some(row => !row.consumed)) {
      command = await createNativeA2aReceiptWaiter(fields)({ snapshot, signal: new AbortController().signal });
      if (action === 'observed') { process.send({ type: 'boundary', command }); return; }
      kernel.submit(scope, 'run', command);
      if (action === 'queued') { process.send({ type: 'boundary', command }); return; }
    }
    snapshot = await kernel.runUntilIdle(scope, 'run');
    process.send({ type: 'result', snapshot, modelCalls });
  } catch (error) {
    process.stderr.write(error.stack + '\n'); process.exitCode = 1;
  } finally {
    if (action === 'recover' || process.exitCode) { await a2a.close(); store.close(); process.disconnect(); }
  }
});
