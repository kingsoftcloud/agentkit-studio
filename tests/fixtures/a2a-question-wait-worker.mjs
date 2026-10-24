// Real process fault boundary; presentation/operation-consent are explicit
// deterministic doubles. Kernel, SQLite, private journal and HTTP remain real.
import { join } from 'node:path';
import { NativeKernel, emptyUsage } from '../../packages/agentkit-harness-core/dist/index.mjs';
import { digest } from '../../packages/agentkit-harness-core/test/fixtures.mjs';
import { SqliteRunStore } from '../../packages/agentkit-harness/src/native/sqlite-store.mjs';
import { prepareNativeA2AHost } from '../../src/providers/native-a2a-host.mjs';
import { createNativeA2aReceiptObserver, createNativeA2aReceiptWaiter } from '../../src/providers/native-a2a-receipt.mjs';
import { controlConsent } from './native-a2a-control-consent.mjs';
import { scope } from './native-a2a-internal-peer.mjs';

process.once('message', async ({ root, workspaceRoot, env, bindings, action, approval }) => {
  const store = new SqliteRunStore(join(root, 'runs.sqlite'));
  const a2a = prepareNativeA2AHost({ env, bindings });
  const fields = { a2a, store, scope, sessionId: 'session', stateRoot: join(root, 'state'), workspaceRoot, isClosed: () => false };
  let modelCalls = 0, presentations = 0, permissions = 0;
  try {
    const kernel = new NativeKernel({ store, digest, owner: `question-${process.pid}`, ports: {
      model: { generate: async () => { modelCalls++; return { kind: 'final_candidate', text: 'finished', toolCalls: [], usage: emptyUsage() }; } },
      tools: { execute: () => { throw Error('Original remote tool MUST NOT execute again'); }, observeReceipt: createNativeA2aReceiptObserver(fields) },
    } });
    let snapshot = store.load(scope, 'run').snapshot;
    if (snapshot.phase === 'awaiting_reconciliation') {
      const command = await createNativeA2aReceiptWaiter(fields)({ snapshot, signal: new AbortController().signal, questionHost: {
        present() {
          presentations++;
          if (action !== 'answer') throw Error('Durable original answer MUST NOT be requested again');
          return approval ? { action: 'approve' } : { action: 'submit', parts: [{ data: 'Shanghai' }] };
        },
        authorizeControl(input) {
          if (!input.readOnly) {
            permissions++;
            if (action === 'answer') {
              process.send({ type: 'answer-durable-before-permission', presentations, permissions });
              return new Promise(() => {});
            }
          }
          return controlConsent(input);
        },
      } });
      kernel.submit(scope, 'run', command);
    }
    snapshot = await kernel.runUntilIdle(scope, 'run');
    process.send({ type: 'result', snapshot, presentations, permissions, modelCalls });
  } catch (error) { process.stderr.write(error.stack + '\n'); process.exitCode = 1; }
  finally { await a2a.close(); store.close(); process.disconnect(); }
});
