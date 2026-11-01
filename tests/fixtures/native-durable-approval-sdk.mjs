import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canonical, configure, emptyUsage } from '@kingsoftcloud/agentkit-harness-core';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { nativeDeliveryProjection } from '@kingsoftcloud/agentkit-harness-node/native/session-delivery';
import { createNativeDshTurnExecutor } from '@kingsoftcloud/agentkit-harness-node/native/dsh-turn-runtime';
import { NATIVE_DSH_TURN_CONTRACT } from '@kingsoftcloud/agentkit-harness-node/native/dsh-turn-contract';
import { createNativeDshTools } from '../../src/providers/native-dsh-tools.mjs';
import { installNativeBoundPolicy } from '../../src/providers/native-bound-policy.mjs';
import { createNativeHostInteraction } from '../../src/providers/native-host-interaction.mjs';
import { createStudioNativeCommandProgress } from '../../src/host/services/native-command-progress.mjs';

export const name = 'native-durable-approval-sdk-verification';
export const inject = ['tools', 'approval', 'sandboxPolicy', 'llm', 'sessions', 'sessionProjections'];
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Controlled model decisions; real Loader, Agent, registry, approval service and SQLite. */
export async function apply(ctx, options) {
  const store = new SqliteRunStore(join(options.directory, 'native.sqlite'));
  const policy = { contract: 'agentkit.native-agent-policy/v1', mode: 'strict', rules: {} };
  const gateway = createNativeDshTools({ ctx, config: { agentId: 'approval-fixture', boundToolPolicy: policy,
    nativeEngineContract: NATIVE_DSH_TURN_CONTRACT, toolBindings: ['read_workspace_file', 'write_workspace_file', 'run_command'] },
  workspaceRoot: options.directory, stateDir: options.directory + '-tools' });
  ctx.effect(() => () => store.close(), 'approval fixture ledger');
  ctx.effect(() => () => gateway.close(), 'approval fixture gateway');
  ctx.effect(() => ctx.sessionProjections.register(nativeDeliveryProjection()), 'approval fixture delivery');
  ctx.effect(() => installNativeBoundPolicy(ctx, policy,
    (agent, name) => gateway.policyDefinition(agent, name), gateway.durableApproval), 'approval fixture policy');
  let mode, waiting, guards = 0, dispatches = 0, asks = 0, previewTimer, previews = [];
  const commandProgress = createStudioNativeCommandProgress({ workspaceId: hash(options.directory), project: source =>
    source.stdout.endsWith('\n') ? { kind: 'command_preview', stdout: source.stdout.replaceAll('PRIVATE', '[hidden]'), stderr: source.stderr } : null });
  ctx.effect(() => () => { clearInterval(previewTimer); commandProgress.close(); }, 'command observations');
  const observe = data => appendFile(join(options.directory, 'observations.jsonl'), JSON.stringify(data) + '\n');
  ctx.tools.guard(exec => {
    if (exec.name !== 'write_workspace_file') return;
    guards++;
    return mode === 'guard-denied' ? 'Live guard rejects after permission was granted' : undefined;
  });
  ctx.on('tools/execute', async (exec, next) => {
    if (exec.name === 'write_workspace_file') dispatches++;
    return next();
  });
  ctx.on('tools/post-execute', async (exec, result, next) => {
    if (mode === 'post-blocked' && exec.name === 'write_workspace_file')
      return { kind: 'block', feedback: [{ type: 'text', text: 'Blocked pending projection' }] };
    const decision = await next();
    let commandResult;
    if (!result.isError && typeof result.value?.result === 'string') {
      try { commandResult = JSON.parse(result.value.result); } catch { /* a non-command result */ }
    }
    return mode === 'command-redacted' && exec.name === 'run_command' && decision.kind === 'accept'
      && typeof commandResult?.stdout === 'string'
      ? { kind: 'accept', content: [{ type: 'text', text: result.value.result.replaceAll('PRIVATE', '[hidden]') }] }
      : decision;
  });
  ctx.on('approval/request', async request => {
    assert.equal(request.toolName, mode.startsWith('command-') ? 'run_command' : 'write_workspace_file');
    assert.ok(waiting, 'Only the durable idle path may ask the real Host');
    const { snapshot, started } = waiting;
    const before = store.load(snapshot.scope, snapshot.runId);
    assert.equal(before.snapshot.phase, 'awaiting_interaction');
    assert.equal(before.lease, null, 'Permission waiting must release execution ownership');
    assert.equal(existsSync(join(options.directory, mode + '.txt')), false);
    asks++;
    if (mode === 'allowed') await pause(1500);
    request.signal.throwIfAborted();
    const after = store.load(snapshot.scope, snapshot.runId);
    assert.equal(after.snapshot.phase, 'awaiting_interaction');
    assert.equal(after.lease, null);
    assert.equal(existsSync(join(options.directory, mode + '.txt')), false);
    assert.equal(after.receipts.some(row => row.status === 'uncertain'), false);
    await observe({ kind: 'permission', mode, elapsedMs: Date.now() - started,
      phase: after.snapshot.phase, lease: after.lease, dispatches, guards });
    return mode === 'rejected' ? 'rejected' : 'allowed-once';
  }, { prepend: true });
  ctx.llm.registerAdapter(['native-approval-fixture'], {
    providerInfo: id => ({ id, name: 'Approval fixture' }), providerRetryPolicy: () => undefined,
    resolveModel: (provider, id) => ({ provider, id, name: id }),
    prepareCall: () => { throw Error('Default model loop must not run'); },
  });
  const interaction = createNativeHostInteraction({ ctx, store });
  const execute = createNativeDshTurnExecutor({ store, owner: `approval-sdk-${process.pid}`, durableOwnership: true,
    projections: ctx.sessionProjections, flush: session => ctx.sessions.flush(session),
    onIdle: async (payload, snapshot, controls) => {
      waiting = { snapshot, started: Date.now() };
      try { return await interaction(payload, snapshot, controls); } finally { waiting = null; }
    },
    onCheckpoint: async (_payload, snapshot) => {
      if (!['completed', 'failed', 'canceled', 'interrupted'].includes(snapshot.phase)) return;
      clearInterval(previewTimer);
      const record = store.load(snapshot.scope, snapshot.runId);
      await writeFile(join(options.directory, `${mode}.json`), JSON.stringify({ phase: snapshot.phase,
        reason: snapshot.reason, usage: snapshot.usage, guards, dispatches, asks, previews,
        results: record.receipts.filter(row => row.result.results).map(row => ({ status: row.status, results: row.result.results })),
        events: record.events.map(event => ({ kind: event.kind, payload: event.payload })) }));
    },
    resolveTurn: async ({ agent, input }) => {
      mode = input.messages.flatMap(row => row.content.filter(block => block.type === 'text').map(block => block.text))
        .find(text => ['allowed', 'rejected', 'guard-denied', 'post-blocked', 'read-interrupted', 'after-read', 'command-preview', 'command-redacted'].includes(text));
      assert.ok(mode, 'The SDK fixture requires one explicit case'); guards = dispatches = asks = 0;
      const command = mode.startsWith('command-'); previews = [];
      const scope = { tenantId: command ? 'local' : 'fixture', workspaceId: hash(options.directory), userId: command ? 'local-user' : 'fixture', agentId: String(agent.id) };
      const configuration = configure({ profile: { profileId: 'fixture', profileVersion: '1', providerFamily: 'fixture',
        compatibilityDigest: 'approval-sdk/v1', maxRetries: 0, requestTimeoutMs: 500 },
      instructions: 'Controlled verification.', inputMessages: [{ role: 'user', content: mode }],
      contract: { objective: mode }, hostBindingDigest: hash({ mode, scope }),
      limits: { effectTimeoutMs: command ? 10000 : 1000, maxModelCalls: 3, maxToolCalls: 3 },
      tools: gateway.definitions(agent, input.assembly.tools, { executionTimeoutPolicy: 'dispatch/v2',
        approvalPolicy: gateway.durableApprovalContract }).map(tool => ({ ...tool, timeoutMs: command ? 5000 : 200 })) });
      let calls = 0;
      const nativePorts = gateway.forAgent(agent, { scope, store, commandProgress });
      if (command) {
        clearInterval(previewTimer);
        previewTimer = setInterval(() => {
          const head = store.sessionHead(scope, String(agent.session.id));
          if (!head) return;
          const record = store.load(scope, head.runId), view = commandProgress.read(record);
          if (view) previews.push({ ...view, hasReceipt: record.receipts.some(r => r.operationKey === record.snapshot.pendingIntent) });
        }, 10);
      }
      if (mode === 'read-interrupted') nativePorts.tools = { ...nativePorts.tools, execute: async (_request, lifecycle) => {
        lifecycle.dispatched(); return { status: 'uncertain', content: 'Controlled lost read result' };
      } };
      return { scope, buildId: 'approval-sdk', configuration, taskChainId: String(agent.id),
        source: { provider: 'native-approval-fixture', model: 'controlled' },
        ports: { ...nativePorts, model: { generate: async request => {
          request.signal.throwIfAborted();
          if (mode === 'read-interrupted') return { kind: 'tool_calls', text: '', usage: emptyUsage(), toolCalls: [{
            callId: 'read-id', name: 'read_workspace_file', arguments: { path: 'allowed.txt' },
          }] };
          if (mode === 'after-read') return { kind: 'final_candidate', text: 'after-read settled', toolCalls: [], usage: emptyUsage() };
          if (command) {
            if (++calls === 1) return { kind: 'tool_calls', text: '', usage: emptyUsage(), toolCalls: [{ callId: 'command-id',
              name: 'run_command', arguments: { command: "printf 'PRIVATE\n'; sleep 0.5; printf 'done\n'" } }] };
            if (mode === 'command-redacted') assert.equal(JSON.stringify(request.messages.filter(m => m.role === 'tool')).includes('PRIVATE'), false);
            return { kind: 'final_candidate', text: `${mode} settled`, toolCalls: [], usage: emptyUsage() };
          }
          return ++calls === 1 ? { kind: 'tool_calls', text: '', usage: emptyUsage(), toolCalls: [{
            callId: 'same-provider-id', name: 'write_workspace_file',
            arguments: { path: mode + '.txt', content: `Actual write: ${mode}`, overwrite: false },
          }] } : { kind: 'final_candidate', text: `${mode} settled`, toolCalls: [], usage: emptyUsage() };
        } } } };
    } });
  ctx.on('agent/execute-turn', (payload, next) => execute(payload).then(result => result === undefined ? next() : result));
}
