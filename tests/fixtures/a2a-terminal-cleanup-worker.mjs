// Kernel/SQLite/journal/HTTP are real. The closed DSH Session/root/preset are
// declared minimal authority doubles; mounted Host startup is tested separately.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { NativeKernel } from '../../packages/agentkit-harness-core/dist/index.mjs';
import { digest } from '../../packages/agentkit-harness-core/test/fixtures.mjs';
import { SqliteRunStore } from '../../packages/agentkit-harness/src/native/sqlite-store.mjs';
import { prepareNativeA2AHost } from '../../src/providers/native-a2a-host.mjs';
import { createNativeA2aQuestionTerminator } from '../../src/providers/native-a2a-receipt.mjs';
import { createStudioNativeRecovery } from '../../src/host/services/native-recovery.mjs';

process.once('message', async ({ root, workspaceRoot, env, bindings, scope, action, guard }) => {
  const store = new SqliteRunStore(join(root, 'runs.sqlite'));
  let a2a;
  try {
    if (action === 'terminal') {
      const kernel = new NativeKernel({ store, digest, owner: `terminal-${process.pid}`, ports: {
        model: { generate: () => assert.fail('terminal commit cannot call a model') },
        tools: { execute: () => assert.fail('terminal commit cannot replay a tool') },
      } });
      kernel.submit(scope, 'run', { commandId: 'owning-run-cancel', kind: 'cancel', payload: {} });
      const snapshot = await kernel.runUntilIdle(scope, 'run'); assert.equal(snapshot.phase, 'canceled');
      process.send({ type: 'terminal-durable', snapshot });
      await new Promise(() => {});
    } else {
      a2a = prepareNativeA2AHost({ env, bindings });
      const session = { id: 'session' }, agent = { id: 'session', session, status: 'idle', externalTurns: { pending: () => null } };
      const fields = { a2a, store, scope, sessionId: 'session', stateRoot: join(root, 'state'), workspaceRoot, isClosed: () => false };
      const binding = { runtime: 'harness', local: true, nativeEngineContract: 'agentkit.native-dsh-turn/v1',
        agentId: scope.agentId, agentRevision: guard === 'preset' ? 2 : 1, nativeTools: {
          settleA2aQuestions() { createNativeA2aQuestionTerminator(fields)(store.load(scope, 'run').snapshot); },
        } };
      const services = { workspaceRegistry: { archivedSessionIds: guard === 'archived' ? ['session'] : [] },
        sessionProjections: { stateOf: () => 'original-preset' },
        agents: { get: () => agent, roots: () => guard === 'delegated' ? [] : [agent] },
        sessionController: { resolveAgent: async () => ({ agent }) } };
      const recovery = createStudioNativeRecovery({ ctx: { get: name => services[name] }, store, workspaceId: scope.workspaceId,
        lifetime: new AbortController(), active: new Set(), controls: new Map(), controlKey: (agentId, sessionId) => `${agentId}:${sessionId}`,
        execute: { resume: () => assert.fail('a closed original DSH turn cannot execute again') },
        agentEvents: () => ({ serial: async () => binding }) });
      try {
        const lease = guard === 'lease' ? store.acquire(scope, 'run', 'another-live-worker', Date.now(), 30000) : null;
        const outcome = await recovery.automatic({ agentId: scope.agentId, sessionId: 'session', runId: 'run' });
        if (lease) store.release(scope, 'run', lease);
        process.send({ type: 'result', outcome, record: store.load(scope, 'run') });
      } catch (error) {
        if (!guard) throw error;
        process.send({ type: 'guarded', code: error.code });
      }
    }
  } catch (error) { process.stderr.write(error.stack + '\n'); process.exitCode = 1; }
  finally { await a2a?.close(); store.close(); process.disconnect(); }
});
