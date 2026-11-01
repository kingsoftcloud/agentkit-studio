/** Full production Host/preset/registry/SessionController/ApprovalService.
 * Controlled HTTP peer and human answerer; deliberately no model/CLI request. */
import assert from 'node:assert/strict';
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createAgentStore } from '../../src/agent-store.mjs';
import { mountStudioHost } from '../../src/host/bootstrap.mjs';
import { createNativeA2aTaskState } from '../../src/client/state/native-a2a.mjs';
export const name = 'studio-dsh-a2a-controls-proof';
export const inject = ['llm', 'sessions', 'sessionProjections', 'agents', 'agentPresets', 'credentials', 'connection', 'webServer', 'sessionController'];
export async function apply(ctx, options) {
  const root = options.directory, workspace = join(root, 'workspace'); await mkdir(workspace, { recursive: true });
  const previous = existsSync(join(root, 'proof.json')) ? JSON.parse(await readFile(join(root, 'proof.json'), 'utf8')) : null;
  const interrupted = !previous && options.crashApproval && existsSync(join(root, 'interrupted-command.json'))
    ? JSON.parse(await readFile(join(root, 'interrupted-command.json'), 'utf8')) : null;
  await appendFile(join(root, 'host-processes.jsonl'), JSON.stringify({ pid: process.pid, node: process.version, path: process.env.PATH }) + '\n');
  await writeFile(join(root, 'config.yaml'), JSON.stringify({ modelProfiles: [{ id: 'fixture', provider: 'openai-compatible', modelName: 'unused',
    baseUrl: 'http://127.0.0.1:9/v1', default: true, credentialName: 'A2A_UNUSED' }], modelProfileKeys: { A2A_UNUSED: 'synthetic-unused' } }), { mode: 0o600 });
  const agents = createAgentStore({ storeDir: join(root, 'studio/agents') }), records = [];
  if (interrupted) records.push(await agents.get(interrupted.agentId));
  else if (previous) for (const row of previous.runtimes) records.push(await agents.get(row.agentId));
  else for (const runtime of ['dsh-native', 'codex']) records.push(await agents.create({ name: `A2A controls ${runtime}`, runtimeType: runtime,
    spec: { bindings: { modelProfileId: 'fixture', tools: ['call_a2a_agent'], a2a: [{ local_name: 'remote', binding_id: 'binding',
      space_id: 'space', target_agent_id: 'remote', expected_version_id: 'version' }] } } }));
  await mountStudioHost(ctx, { configurationHome: root, env: { AGENTKIT_HOME: root, AGENTKIT_STUDIO_WORKSPACE: workspace,
    KSADK_A2A_SERVICE_URL: options.peer, KSADK_A2A_ALLOW_PRIVATE: 'true' } });
  let modelCalls = 0;
  ctx.llm.registerAdapter(['agentkit-studio-dsh-a2a-proof'], { providerInfo: provider => ({ id: provider, name: 'A2A controls proof' }),
    providerRetryPolicy: () => undefined, listModels: async provider => [{ provider, id: 'unused', name: 'unused' }],
    resolveModel: (provider, model) => ({ provider, id: model, name: model }),
    prepareCall: () => { modelCalls++; throw Error('Product controls cannot launch a model turn'); } });
  ctx.on('approval/request', async request => {
    if (!['a2a_continue_task', 'a2a_cancel_task'].includes(request.toolName)) return;
    const response = await fetch(options.peer + '/approval', { method: 'POST', headers: { 'content-type': 'application/json' }, signal: request.signal,
      body: JSON.stringify({ pid: process.pid, sessionId: request.agent.session.id, toolName: request.toolName, callId: request.callId, reason: request.reason }) });
    assert.equal(response.status, 200); return (await response.json()).outcome;
  }, { prepend: true });
  let started = false;
  const timer = setInterval(() => {
    if (started || !existsSync(join(root, 'start-proof'))) return; started = true; clearInterval(timer);
    void prove().then(value => writeFile(join(root, previous ? 'cold-proof.json' : 'proof.json'), JSON.stringify(value, null, 2)),
      error => writeFile(join(root, previous ? 'cold-proof.json' : 'proof.json'), JSON.stringify({ passed: false, code: error.code, message: error.message, stack: error.stack }))).catch(() => {});
  }, 25); ctx.effect(() => () => clearInterval(timer), 'A2A control proof trigger');
  async function ledgerFiles() {
    const base = join(root, 'studio/builtin-workspace/a2a');
    const rows = [];
    for (const path of await readdir(base, { recursive: true })) if (path.endsWith('.json')) {
      rows.push([path, await readFile(join(base, path), 'utf8')]);
    }
    return rows.sort(([a], [b]) => a.localeCompare(b));
  }
  async function prove() {
    const { setSandboxMode } = await import('@deepseek-ai/dsh-sandbox-policy');
    const origin = ctx.webServer.getOrigin(), denied = await fetch(origin + '/agentkit', { method: 'POST',
      headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ method: 'sessions/dsh-a2a-history', payload: {} }) });
    assert.equal(denied.status, 401); await denied.text();
    const login = await fetch(ctx.connection.authenticatedUrl(origin + '/connect'), { redirect: 'manual' }); assert.equal(login.status, 302);
    const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    const rpc = async (method, payload, signal) => {
      const response = await fetch(origin + '/agentkit', { method: 'POST', headers: { origin, cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ method, payload }), signal }); assert.equal(response.status, 200);
      const envelope = (await response.json()).result; assert.equal(envelope?.ok, true, JSON.stringify(envelope)); return envelope.value;
    };
    const remote = { dshA2aTaskHistory: (request, signal) => rpc('sessions/dsh-a2a-history', request, signal),
      controlDshA2aTask: (request, signal) => rpc('sessions/dsh-a2a-control', request, signal) };
    const runtimes = [], beforeCold = previous ? await ledgerFiles() : null;
    for (const record of records) {
      const runtime = record.spec.runtime.type, sessionId = `a2a-controls-${runtime}`;
      const previousRow = previous?.runtimes.find(row => row.runtime === runtime);
      if (!previous && !interrupted) {
        const admitted = await rpc('agents/ensure-preset', { agentId: record.metadata.id });
        await ctx.sessionController.create({ sessionId, cwd: workspace, agentPreset: admitted.presetId });
      }
      const found = await ctx.sessionController.resolveAgent(sessionId); assert.ok(found.agent, JSON.stringify(found.error)); const agent = found.agent;
      setSandboxMode(agent.session, 'workspace-write');
      const identity = { agentId: record.metadata.id, sessionId };
      if (interrupted) {
        const pending = agent.externalTurns.pending();
        assert.equal(pending?.engine, 'agentkit.a2a-human-control/v1'); assert.equal(pending.turn, interrupted.turn);
        assert.equal((await remote.dshA2aTaskHistory(identity)).items.length, 1);
        const result = await remote.controlDshA2aTask(interrupted.input);
        assert.equal(result.outcome, 'submitted'); assert.equal(result.state, 'completed');
        assert.equal(agent.externalTurns.pending(), null);
        assert.equal(ctx.sessionProjections.stateOf(agent.session, 'turnBoundary').lastTurn, interrupted.turn,
          'explicit recovery closes the SAME approval turn');
        assert.deepEqual(await remote.controlDshA2aTask(interrupted.input), result);
        assert.deepEqual((await ledgerFiles()).filter(([name]) => name.endsWith('record.json')), interrupted.receiptBefore);
        const events = agent.session.snapshotEvents(), asked = events.filter(event => event.type === 'approval/asked'),
          decided = events.filter(event => event.type === 'approval/decided');
        assert.equal(decided.length, 1); assert.equal(decided[0].data.outcome, 'allowed-once');
        assert.ok(asked.some(event => event.data.id === decided[0].data.id));
        assert.equal(await ctx.sessions.flush(agent.session), true);
        runtimes.push({ runtime, ...identity, callCount: 1, recoveredTurn: interrupted.turn,
          commands: [{ input: interrupted.input, result }], asked, decided }); continue;
      }
      if (previous) {
        const restored = agent.session.snapshotEvents();
        assert.deepEqual(restored.filter(event => event.type === 'approval/asked'), previousRow.asked);
        assert.deepEqual(restored.filter(event => event.type === 'approval/decided'), previousRow.decided);
        const inventory = await remote.dshA2aTaskHistory(identity); assert.equal(inventory.items.length, previousRow.callCount ?? 2);
        for (const command of previousRow.commands) {
          const result = await remote.controlDshA2aTask(command.input); assert.deepEqual(result, command.result);
        }
        runtimes.push({ runtime, ...identity, unchanged: true }); continue;
      }
      const commands = [];
      try {
        const initial = await remote.dshA2aTaskHistory(identity); assert.equal(initial.items.length, 0);
        const registry = agent.ctx.get('tools');
        const call = async (callId, message) => {
          let result;
          await agent.externalTurns.start(async ({ turn }) => ({ contract: 'dsh.external-turn/v1', turn,
            engine: 'test-original-dsh-tool/v1', binding: callId }), async ({ signal }) => {
            assert.equal(await ctx.sessions.flush(agent.session), true);
            result = await registry.execute({ agent, name: 'call_a2a_agent', callId, arguments: { agent: 'remote', message }, signal });
            return { reason: { kind: 'completed' } };
          });
          assert.equal(await ctx.sessions.flush(agent.session), true);
          return result;
        };
        const paused = await call('paused-call', 'paused'); assert.equal(paused.isError, false, JSON.stringify(paused));
        assert.equal(ctx.sessionProjections.stateOf(agent.session, 'turnBoundary').openTurnStartSeq, null,
          'the original conversation turn is closed before history control');
        const receiptBefore = (await ledgerFiles()).filter(([name]) => name.endsWith('record.json'));
        const inventory = await remote.dshA2aTaskHistory(identity); assert.equal(inventory.items.length, 1);
        const controller = createNativeA2aTaskState({ task: { ...inventory.items[0], ownerKind: 'dsh' }, hostRemote: remote,
          commandId: (() => { let n = 0; return () => `paused-command-${++n}`; })() });
        await controller.refresh(); assert.equal(controller.getSnapshot().task.state, 'input_required');
        const input = { ...inventory.items[0], kind: 'continue', commandId: 'approved-continue',
          pauseDigest: controller.getSnapshot().task.pauseDigest, json: '{"answer":9007199254740993}' };
        if (options.crashApproval) await writeFile(join(root, 'interrupted-command.json'), JSON.stringify({ ...identity,
          turn: ctx.sessionProjections.stateOf(agent.session, 'turnBoundary').lastTurn + 1, input, receiptBefore }));
        const result = await remote.controlDshA2aTask(input); assert.equal(result.outcome, 'submitted'); assert.equal(result.state, 'completed');
        commands.push({ input, result }); controller.dispose();
        assert.deepEqual((await ledgerFiles()).filter(([name]) => name.endsWith('record.json')), receiptBefore);
        const running = call('busy-call', 'busy'); running.catch(() => {});
        let busyTask; const deadline = Date.now() + 10000;
        while (!busyTask) {
          const page = await remote.dshA2aTaskHistory(identity); busyTask = page.items.find(task => task.callId === 'busy-call');
          assert.ok(Date.now() < deadline); if (!busyTask) await new Promise(resolve => setTimeout(resolve, 25));
        }
        const calls = [];
        const busy = createNativeA2aTaskState({ task: { ...busyTask, ownerKind: 'dsh' }, hostRemote: {
          controlDshA2aTask: async (input, signal) => { calls.push(structuredClone(input)); return remote.controlDshA2aTask(input, signal); },
        } });
        // Discovery may still be finishing after the durable DSH intent.
        while (!busy.getSnapshot().task?.remote_task_id) {
          await busy.refresh(); assert.ok(Date.now() < deadline);
          if (!busy.getSnapshot().task?.remote_task_id) await new Promise(resolve => setTimeout(resolve, 25));
        }
        await busy.cancel(); assert.equal(busy.getSnapshot().outcome, 'remote_cancelled');
        const cancelInput = calls.find(call => call.kind === 'cancel'); assert.ok(cancelInput);
        const cancelResult = busy.getSnapshot().task; commands.push({ input: cancelInput, result: cancelResult }); busy.dispose();
        const finished = await fetch(options.peer + '/finish', { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ taskId: cancelResult.remote_task_id }) }); assert.equal(finished.status, 200); await finished.text();
        const completed = await running; assert.equal(completed.isError, false, JSON.stringify(completed));
        assert.equal(JSON.parse(completed.value.result).state, 'cancelled');
        for (const command of commands) assert.deepEqual(await remote.controlDshA2aTask(command.input), command.result);
        const events = agent.session.snapshotEvents(), asked = events.filter(event => event.type === 'approval/asked'), decided = events.filter(event => event.type === 'approval/decided');
        assert.equal(asked.length, 2); assert.equal(decided.length, 2); assert.ok(decided.every(event => event.data.outcome === 'allowed-once'));
        assert.deepEqual(asked.map(event => event.data.id).sort(), decided.map(event => event.data.id).sort());
        assert.equal(events.filter(event => event.type === 'turn/owner' && event.data.engine === 'agentkit.a2a-human-control/v1').length, 1);
        runtimes.push({ runtime, ...identity, commands, asked, decided });
      } finally { assert.equal(await ctx.sessions.flush(agent.session), true); }
    }
    if (previous) assert.deepEqual(await ledgerFiles(), beforeCold, 'cold confirmation leaves original DSH/remote records byte-identical');
    assert.equal(modelCalls, 0);
    return { passed: true, pid: process.pid, node: process.version, path: process.env.PATH, modelCalls, runtimes,
      ...(previous ? { previousPid: previous.pid, unchanged: true } : {}), ledgers: await ledgerFiles(), unauthorizedStatus: denied.status };
  }
}
