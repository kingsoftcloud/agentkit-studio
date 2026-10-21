import assert from 'node:assert/strict';
import { appendFileSync, writeFileSync, readFileSync, existsSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { configure, canonical, emptyUsage } from '../../packages/agentkit-harness-core/dist/index.mjs';
import { digest, tool } from '../../packages/agentkit-harness-core/test/fixtures.mjs';
import { SqliteRunStore } from '../../packages/agentkit-harness/src/native/sqlite-store.mjs';
import { createNativeDshTurnExecutor } from '../../packages/agentkit-harness/src/native/dsh-turn-runtime.mjs';
import { nativeDeliveryProjection } from '../../packages/agentkit-harness/src/native/session-delivery.mjs';
import { readNativeDshOwnership } from '../../packages/agentkit-harness/src/native/dsh-turn-ownership.mjs';

const final = () => ({ kind: 'final_candidate', text: 'Original Run completed', toolCalls: [], usage: emptyUsage() });
const persisted = (path, value) => { writeFileSync(path, canonical(value)); const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } };
const append = (path, value) => { appendFileSync(path, canonical(value) + '\n'); const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } };

/** Real Agents/JSONL/Native SQLite in a fresh Node process; deterministic ports. */
export async function runOwnedRecoveryWorker(api, { directory, fault, recovering }) {
  const { Context, mountAgentLoopTestDependencies, AgentLoop, JsonlSessionPersistence, SessionId, createUserMessage } = api;
  const ctx = new Context(), store = new SqliteRunStore(join(directory, 'native.sqlite'));
  let agent;
  const scope = { tenantId: 'fixture', workspaceId: 'workspace', userId: 'user', agentId: 'original-agent' };
  const path = name => join(directory, name);
  const lines = name => existsSync(path(name)) ? readFileSync(path(name), 'utf8').trim().split('\n').filter(Boolean) : [];
  const report = () => ({ events: agent.session.snapshotEvents(), owner: agent.externalTurns.pending(),
    records: store.list(scope).map(row => store.load(scope, row.runId)), modelCalls: lines('models.jsonl').length,
    writes: lines('writes.jsonl').length, defaultCalls: lines('default.jsonl').length });
  const crash = async () => {
    persisted(path('crash.json'), report());
    // Deliberately no Context disposal, store close, lease release or turn/end.
    process.exit(37);
  };
  try {
    await mountAgentLoopTestDependencies(ctx);
    await ctx.plugin(JsonlSessionPersistence, { root: path('sessions'), compression: 'none' });
    await ctx.plugin(AgentLoop, { agents: [] });
    ctx.sessionProjections.register(nativeDeliveryProjection());
    ctx.llm.registerAdapter(['fixture'], { providerInfo: id => ({ id, name: id }),
      providerRetryPolicy: () => undefined, resolveModel: (provider, id) => ({ provider, id, name: id }),
      prepareCall: () => { append(path('default.jsonl'), {}); throw Error('Default DSH loop must never execute'); },
    });
    const configuration = configure({
      profile: { profileId: 'fixture', profileVersion: '1', providerFamily: 'fixture', compatibilityDigest: 'owned-recovery/v1' },
      contract: { objective: 'Write exactly once', revision: 'original-compiled-contract' },
      instructions: 'Original immutable instructions', hostBindingDigest: 'original-trusted-preset/v1',
      inputMessages: [{ role: 'user', content: 'Write exactly once' }], limits: { leaseMs: 100, maxModelCalls: 4, maxToolCalls: 2 },
      tools: [tool({ name: 'write', readOnly: false, concurrentSafe: false })],
    });
    const binding = { scope, buildId: 'original-build', configuration, taskChainId: 'original-chain',
      source: { provider: 'fixture', model: 'pinned' }, ports: {
        model: { generate: async request => {
          append(path('models.jsonl'), { messages: request.messages });
          return lines('models.jsonl').length === 1
            ? { ...final(), kind: 'tool_calls', toolCalls: [{ callId: 'original-write', name: 'write', arguments: {} }] } : final();
        } },
        tools: { execute: async request => {
          append(path('writes.jsonl'), { operationKey: request.operationKey });
          if (!recovering && fault === 'unknown-write') await crash();
          return { status: 'ok', content: 'Committed real filesystem write' };
        } },
      } };
    let firstFlush = true;
    const execute = createNativeDshTurnExecutor({ store, durableOwnership: true,
      projections: ctx.sessionProjections, owner: `process-${process.pid}`,
      flush: async session => {
        const durable = await ctx.sessions.flush(session);
        if (!recovering && firstFlush) {
          firstFlush = false; assert.equal(durable, true);
          if (fault === 'admission-only') await crash();
          if (fault === 'cancel-admission') {
            agent.cancel({ kind: 'user' }, { keepInbox: true });
            return new Promise(() => {});
          }
        }
        return durable;
      },
      resolveTurn: async () => binding,
      resolveRecoveryTurn: async (payload, original) => {
        assert.equal(original.identity.scope.agentId, scope.agentId);
        assert.equal(original.identity.buildId, binding.buildId);
        assert.deepEqual(original.messages, payload.input.messages);
        assert.equal(original.configuration.contract.revision, 'original-compiled-contract');
        return binding;
      },
      onCheckpoint: async (_, snapshot) => {
        if (recovering) return;
        const record = store.load(scope, snapshot.runId);
        if (fault === 'model-committed' && record.events.some(event => event.kind === 'model.completed')) await crash();
        if (fault === 'terminal-delivered' && snapshot.phase === 'completed') await crash();
      },
    });
    const setup = scope => { scope.on('agent/execute-turn', payload => execute(payload)); };
    const options = { agentOptions: { provider: 'fixture', model: 'pinned' }, setup };
    const handle = recovering
      ? await ctx.agents.resume({ ...options, resumeSessionId: SessionId('original-session') })
      : await ctx.agents.create({ ...options, sessionId: SessionId('original-session') });
    agent = handle.agent;
    if (recovering) {
      const before = report(), owner = agent.externalTurns.pending();
      assert.ok(owner, 'Real DSH resume must retain the owned original turn');
      const admission = readNativeDshOwnership(owner, { sessionId: 'original-session', turn: 1 });
      assert.equal(admission.configDigest, digest(admission.configuration));
      assert.equal(before.events.filter(event => event.type === 'turn/start').length, 1);
      assert.equal(before.events.filter(event => event.type === 'turn/end').length, 0);
      let ending, failure;
      try { ending = await execute.resume({ agent }); } catch (error) { failure = { code: error.code, message: error.message }; }
      await agent.whenIdle(); assert.equal(await ctx.sessions.flush(agent.session), true);
      persisted(path('recovered.json'), { before, after: report(), ending: ending ?? null, failure: failure ?? null });
    } else {
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Write exactly once' }], source: { kind: 'user' } }));
      await agent.whenIdle();
      if (fault !== 'cancel-admission') throw Error('Fault injection was not reached');
      assert.equal(await ctx.sessions.flush(agent.session), true);
      await crash();
    }
  } finally { await ctx.fiber.dispose(); store.close(); }
}
