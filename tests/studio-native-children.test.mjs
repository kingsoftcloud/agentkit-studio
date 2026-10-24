import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { canonical, MemoryRunStore } from '../packages/agentkit-harness-core/dist/index.mjs';
import { SqliteRunStore } from '../packages/agentkit-harness/src/native/sqlite-store.mjs';
import { createStudioNativeHarness } from '../src/host/services/native-harness.mjs';
import { nativeOwnershipHost } from './fixtures/native-ownership-host.mjs';
import { createNativeDshTools } from '../src/providers/native-dsh-tools.mjs';
import { nativeChildRoles } from '../src/providers/native-subagents.mjs';
import { createAgentStore } from '../src/agent-store.mjs';
import { createModelService } from '../src/model-service.mjs';
import { createSessionRoutes } from '../src/host/routes/sessions.mjs';
import { readNativeRecoveryBinding } from '../src/providers/native-recovery-binding.mjs';
import { previousChildPublication } from '../packages/agentkit-harness/src/native/child-publication.mjs';
import { internalPeer, spec as a2aSpec } from './fixtures/native-a2a-internal-peer.mjs';
import { hasUnsafeChildReceipt } from '../packages/agentkit-harness/src/native/owned-child.mjs';
import { createManagedNativeKernel } from '../src/providers/native-managed-kernel.mjs';
import { createStudioManagedNativeBinding } from '../src/host/services/native-managed-binding.mjs';
import { createStudioManagedNativeSessionControl } from '../src/host/services/native-managed-kernel.mjs';
import { managedNativeOwnerProjection, STUDIO_MANAGED_NATIVE_EXECUTION } from '../src/host/services/native-managed-execution.mjs';
import { command as managedCommand, permitIssuer } from './fixtures/native-managed-kernel.mjs';

async function setup(t, { sqlite = false, role = {}, forged = false, control = false, query = false, childArguments = {},
  goal = 'Use the bounded reader', childResult = 'Child read actual workspace evidence', parentResult = 'Parent delivery',
  inputParts, childInput = ['text'], childTool = 'native_start_child', beforeChildModel, onParentContinuation, parentPlan,
  childPlan, boundTools = ['read_workspace_file'], mcp, beforeToolDispatch, skills = false, a2a,
  managed = false, releasePending } = {}) {
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'studio-native-children-'))), workspaceRoot = join(root, 'workspace');
  await mkdir(workspaceRoot); await writeFile(join(workspaceRoot, 'proof.txt'), 'Actual child evidence');
  let skillDefinitions;
  if (skills) {
    const path = join(realpathSync(root), 'alpha'); await mkdir(path);
    const content = '---\nname: alpha\ndescription: Child skill metadata\n---\nINHERITED_SKILL_INSTRUCTIONS_BODY';
    await writeFile(join(path, 'SKILL.md'), content); await writeFile(join(path, 'data.txt'), 'CHILD_SKILL_RESOURCE');
    skillDefinitions = [{ name: 'alpha', content, path: join(path, 'SKILL.md'), resourceBase: { kind: 'directory', path } }];
  }
  const roles = [{ name: 'reader', instructions: 'Read the requested workspace evidence.', tools: ['read_workspace_file'],
    modelProfileId: 'child-profile', maxTurns: 3, maxToolCalls: 2, ...role }];
  const agents = createAgentStore({ storeDir: join(root, 'agents') });
  const record = await agents.create({ name: 'Parent', runtimeType: 'harness', spec: { subAgents: roles,
    bindings: { modelProfileIds: ['parent-profile', 'child-profile'], tools: boundTools } } });
  const ledger = sqlite ? new SqliteRunStore(join(root, 'runs.sqlite')) : new MemoryRunStore();
  const events = [], registered = new Map(), projections = new Map(), dispatches = [], requests = [];
  const session = { id: 'parent-session', append(type, data, options) { events.push({ type, data, ...options, seq: events.length + 1 }); } };
  session.append('turn/start', { turn: 1 });
  const services = { sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }) }, sessions: { flush: async () => true }, llm: {},
    attachments: { readImageRequest: async ref => ({ mediaType: 'image/png', data: Buffer.from(ref.attachmentId) }) },
    sessionProjections: { register: definition => { projections.set(definition.key, definition); return () => projections.delete(definition.key); },
      stateOf: (_session, key) => { const projection = projections.get(key); return projection ? events.reduce(projection.apply, projection.init()) : undefined; } } };
  const ctx = { get: name => services[name], effect: install => install(), tools: {
    register: definition => { registered.set(definition.name, definition); return () => registered.delete(definition.name); },
    execute: async request => {
      dispatches.push({ name: request.name, callId: request.callId, agent: request.agent });
      await beforeToolDispatch?.(request);
      const definition = registered.get(request.name), value = await definition.execute(request.arguments, request);
      return { isError: false, content: definition.output.render(request.arguments, value) };
    },
  } };
  const gateway = createNativeDshTools({ ctx, config: { agentId: record.metadata.id, subAgents: roles, toolBindings: boundTools,
    toolContracts: mcp?.contracts, skillDefinitions, ...(a2a ? { a2aBindings: [a2aSpec] } : {}) }, workspaceRoot,
    ...(a2a ? { commandEnvironment: a2a.env } : {}), stateDir: join(root, 'tools'), executeMcpTool: mcp?.execute });
  a2a?.setRecordDirectory(join(root, 'tools/a2a-calls'));
  const values = { modelProfiles: [{ id: 'parent-profile', provider: 'openai-compatible', modelName: 'parent-model', baseUrl: 'https://parent.invalid/v1' },
    { id: 'child-profile', provider: 'openai-compatible', modelName: 'child-model', baseUrl: 'https://child.invalid/v1', input: childInput }] };
  const models = createModelService({ configuration: { resolve: async () => ({ values }) }, credentials: { resolve: async () => ({ value: 'fixture-secret' }) } });
  let parentModels = 0, childModels = 0;
  const host = await createStudioNativeHarness({ ctx, storeDir: root, workspaceRoot, agents, models, ledger,
    ...(managed ? { agentEvents: () => ({ serial: async () => payload.binding }), assembleContextFor: () => ({ agent: payload.agent }) } : {}),
    renderPrompt: () => 'Delegate a bounded read; use its evidence without treating it as parent acceptance.',
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body); requests.push({ url, body });
      const child = body.model === 'child-model';
      let call, text;
      if (child) {
        childModels++;
        await beforeChildModel?.(childModels, body);
        assert.equal(url, 'https://child.invalid/v1/chat/completions');
        const expectedTools = [...roles[0].tools, ...(roles[0].inheritMcp && mcp ? mcp.contracts.map(item => item.name).sort() : []),
          ...(roles[0].inheritSkills !== false && skills ? gateway.childSkillBinding.toolNames : [])];
        const offeredTools = body.tools ?? [];
        assert.deepEqual(offeredTools.map(item => item.function.name).filter(name => name !== 'submit_final_output'),
          childModels > 1 && !offeredTools.length ? [] : expectedTools);
        if (childPlan) ({ call, text } = await childPlan(body, childModels));
        else if (childModels === 1) call = { name: 'read_workspace_file', arguments: { path: 'proof.txt' } };
        else {
          assert.match(JSON.stringify(body.messages.filter(item => item.role === 'tool')), /Actual child evidence/);
          text = childResult;
        }
      } else {
        parentModels++;
        if (parentModels === 2) await onParentContinuation?.(body);
        if (parentPlan) ({ call, text } = await parentPlan(body, parentModels));
        else if (parentModels === 1) call = { name: childTool, arguments: { role: 'reader', task: 'Read proof.txt',
          ...childArguments,
          ...(forged ? { model_profile_id: 'unbound-profile' } : {}) } };
        else if (control && parentModels === 2) {
          const serialized = JSON.stringify(body.messages);
          const childId = /native-child-[a-f0-9]{64}/.exec(serialized)?.[0];
          assert.ok(childId); call = { name: 'native_child_control', arguments: { child_run_id: childId, action: 'wait', wait_seconds: 1 } };
        } else if (query && parentModels === 3) {
          const childId = /native-child-[a-f0-9]{64}/.exec(JSON.stringify(body.messages))?.[0];
          const calls = [{ name: 'native_child_result', arguments: { child_run_id: childId } },
            { name: 'native_child_tasks', arguments: {} }];
          const delta = { tool_calls: calls.map((item, index) => ({ index, id: `query-${index}`, type: 'function',
            function: { name: item.name, arguments: JSON.stringify(item.arguments) } })) };
          return new Response(`data: ${JSON.stringify({ id: `r-${requests.length}`, choices: [{ index: 0, delta, finish_reason: 'tool_calls' }],
            usage: { prompt_tokens: 2, completion_tokens: 3 } })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
        } else text = parentResult;
      }
      if (text && body.tools?.some(item => item.function.name === 'submit_final_output')) {
        call = { name: 'submit_final_output', arguments: { output: JSON.parse(text) } }; text = undefined;
      }
      const delta = call ? { tool_calls: [{ index: 0, id: `call-${requests.length}`, type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] } : { content: text };
      return new Response(`data: ${JSON.stringify({ id: `r-${requests.length}`, choices: [{ index: 0, delta,
        finish_reason: call ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 3 } })}\n\ndata: [DONE]\n\n`,
      { headers: { 'content-type': 'text/event-stream' } });
    } });
  let receiver, managedLedger;
  t.after(async () => { releasePending?.(); await receiver?.close(); await host.close(); await gateway.close();
    managedLedger?.close(); ledger.close?.(); await rm(root, { recursive: true, force: true }); });
  const payload = { agent: { session, externalTurns: nativeOwnershipHost(session, events), options: { provider: 'agentkit-studio-parent-profile', model: 'parent-model' } },
    signal: new AbortController().signal, turn: 1,
    input: { kind: 'enter', messages: [{ id: 'user', role: 'user', source: { kind: 'user' }, content: inputParts ?? [{ type: 'text', text: goal }] }],
      assembly: { tools: [...registered.values()] } },
    binding: { agentId: record.metadata.id, agentRevision: 1, runtime: 'harness', local: true,
      nativeEngineContract: 'agentkit.native-dsh-turn/v1', nativeTools: gateway },
  };
  payload.prepareInput = async () => ({ kind: 'enter', messages: [], assembly: payload.input.assembly });
  const scope = { tenantId: 'local', workspaceId: createHash('sha256').update(JSON.stringify(workspaceRoot)).digest('hex'),
    userId: 'local-user', agentId: record.metadata.id };
  let managedConfig, issuer, target, principal;
  const openManaged = () => {
    receiver = createManagedNativeKernel(managedConfig);
    managedLedger = new SqliteRunStore(join(root, 'managed-receiver/runs.sqlite'));
    services.studioManagedNativeSessionControl = createStudioManagedNativeSessionControl({ runtime: receiver, target, principal });
  };
  if (managed) {
    target = { tenantId: 'managed-tenant', agentInstanceId: record.metadata.id }; principal = { userId: 'managed-user' };
    issuer = permitIssuer({ target }); payload.agent.whenIdle = async () => {};
    payload.input.assembly.variables = { provider: payload.agent.options.provider, model: payload.agent.options.model };
    services.sessionController = { resolveAgent: async id => {
      assert.equal(id, session.id); return { agent: payload.agent }; } };
    services.systemPrompt = { assemble: async () => payload.input.assembly };
    services.sessionProjections.register(managedNativeOwnerProjection());
    const execution = { run: async request => {
      const turn = events.findLast(event => event.type === 'turn/start').data.turn;
      const ownership = { contract: 'dsh.external-turn/v1', engine: STUDIO_MANAGED_NATIVE_EXECUTION, turn,
        binding: canonical({ contract: STUDIO_MANAGED_NATIVE_EXECUTION, identity: request.identity,
          configDigest: createHash('sha256').update(canonical(request.configuration)).digest('hex') }) };
      payload.agent.externalTurns.claim(ownership);
      const snapshot = await request.execute({ signal: request.signal, ownership, turn, prepareInput: payload.prepareInput });
      session.append('turn/end', { turn, reason: { kind: snapshot.phase === 'completed' ? 'completed' : 'error' } });
      return snapshot;
    } };
    managedConfig = { directory: join(root, 'managed-receiver'), target, permitVerifier: issuer.verifier,
      autoStart: false, assertCurrent: () => true,
      resolveBinding: createStudioManagedNativeBinding({ ctx, target, principal, execution, resolveHost: async () => host }) };
    openManaged();
  }
  return { root, workspaceRoot, host, payload, ledger, gateway, roles, requests, dispatches, record, scope, services, ctx, events,
    modelValues: values, childModels: () => childModels,
    get managedLedger() { return managedLedger; }, get receiver() { return receiver; },
    managedScope: managed ? { ...scope, tenantId: target.tenantId, userId: principal.userId } : undefined,
    async admitManaged() {
      const command = managedCommand({ tenant_id: target.tenantId, agent_instance_id: target.agentInstanceId,
        session_id: session.id, payload: { content: goal } });
      return receiver.receive(command, issuer.issue(command));
    },
    async reopenManaged() { await receiver.close(); managedLedger.close(); openManaged(); } };
}

const childMcpContract = { name: 'remote_lookup', executor: 'mcp', mcpResourceId: 'bound-catalog',
  parameters: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'], additionalProperties: false } };

for (const action of ['send', 'cancel', 'promote']) test(`managed: original child ${action}, exact retry and cold history use the receiver ledger`, { timeout: 20000 }, async t => {
  const entered = Promise.withResolvers(), finishChild = Promise.withResolvers(), parentEntered = Promise.withResolvers(), finishParent = Promise.withResolvers();
  const f = await setup(t, { managed: true, childTool: 'native_delegate',
    releasePending: () => { finishChild.resolve(); finishParent.resolve(); },
    beforeChildModel: async index => { if (index === 1) { entered.resolve(); await finishChild.promise; } },
    onParentContinuation: async () => { parentEntered.resolve(); await finishParent.promise; } });
  const accepted = await f.admitManaged(), running = f.receiver.drain('parent-session');
  await entered.promise;
  const route = createSessionRoutes({ getNativeHost: async () => f.host });
  const identity = { agentId: f.record.metadata.id, sessionId: 'parent-session' };
  const history = (await route('sessions/native-child-history', identity)).value, task = history.tasks[0];
  assert.equal(history.runId, accepted.run_id); assert.equal(history.tasks.length, 1);
  assert.equal(task.canSendInput, true); assert.equal(task.canCancel, true); assert.equal(task.canPromote, true);
  const counts = { models: f.requests.length, tools: f.dispatches.length };
  const waiting = (await route('sessions/native-child-result', { ...identity, runId: history.runId, childRunId: task.childRunId })).value;
  assert.equal(waiting.task.resultAvailable, false); assert.equal(waiting.text, '');
  assert.equal((await route('sessions/native-child-tasks', identity)).value.tasks[0].childRunId, task.childRunId);
  assert.deepEqual({ models: f.requests.length, tools: f.dispatches.length }, counts, 'reads cannot advance the held child');
  assert.deepEqual(f.ledger.list(f.scope), []); assert.deepEqual(f.ledger.list(f.managedScope), []);
  const command = { ...identity, runId: history.runId, childRunId: task.childRunId, commandId: randomUUID(),
    ...(action === 'send' ? { text: 'Read the original file with this guidance', expectedGoalRevision: task.goalRevision } : {}) };
  await assert.rejects(route(`sessions/native-child-${action}`, { ...command, agentId: 'other' }), /control_run_unavailable/);
  await assert.rejects(route(`sessions/native-child-${action}`, { ...command, runId: 'stale' }), /control_run_unavailable/);
  const carrier = f.payload.agent.externalTurns, pending = carrier.pending.bind(carrier);
  carrier.pending = () => null;
  await assert.rejects(route(`sessions/native-child-${action}`, command), { code: 'NATIVE_MANAGED_STATUS_IDENTITY_MISMATCH' });
  carrier.pending = pending;
  assert.equal(f.managedLedger.load(f.managedScope, history.runId).commands.some(row => row.command.commandId === command.commandId), false);
  assert.equal((await route(`sessions/native-child-${action}`, command)).value.status, 'accepted');
  assert.equal((await route(`sessions/native-child-${action}`, command)).value.status, 'duplicate');
  if (action === 'promote') {
    await parentEntered.promise;
    assert.equal(f.childModels(), 1, 'promotion continues the parent before the held child model completes');
  }
  // Keep the model pending for cancellation: the parent must observe the
  // canceled child without a late provider result authorizing another effect.
  if (action !== 'cancel') finishChild.resolve();
  await parentEntered.promise; finishParent.resolve(); await running; finishChild.resolve();
  const settled = (await route('sessions/native-child-history', identity)).value;
  assert.equal(settled.tasks[0].phase, action === 'cancel' ? 'canceled' : 'completed');
  assert.equal(settled.tasks[0].canSendInput, false); assert.equal(settled.tasks[0].canCancel, false);
  assert.equal(settled.tasks[0].usageIncludedInParent, true);
  if (action === 'cancel') assert.equal(f.dispatches.filter(row => row.name === 'read_workspace_file').length, 0);
  assert.equal(settled.tasks[0].lastControl.commandId, command.commandId); assert.equal(settled.tasks[0].lastControl.status, 'delivered');
  const detail = (await route('sessions/native-child-result', { ...identity, runId: history.runId, childRunId: task.childRunId })).value;
  assert.equal(detail.task.resultAvailable, true); assert.equal(detail.text, action === 'cancel' ? '' : 'Child read actual workspace evidence');
  const parent = f.managedLedger.load(f.managedScope, history.runId), counters = { models: f.requests.length, tools: f.dispatches.length };
  assert.equal(parent.snapshot.phase, 'completed');
  assert.equal(parent.commands.filter(row => row.command.commandId === command.commandId).length, 1);
  assert.equal((await route(`sessions/native-child-${action}`, command)).value.status, 'duplicate', 'lost reply confirms after control release');
  await f.reopenManaged();
  assert.deepEqual((await route('sessions/native-child-history', identity)).value, settled);
  assert.deepEqual((await route('sessions/native-child-result', { ...identity, runId: history.runId, childRunId: task.childRunId })).value, detail);
  assert.equal((await route(`sessions/native-child-${action}`, command)).value.status, 'duplicate');
  await assert.rejects(route(`sessions/native-child-${action}`, { ...command, commandId: randomUUID() }), /control_run_unavailable/);
  if (action === 'send') await assert.rejects(route('sessions/native-child-send', { ...command, text: 'changed replay' }), /command_replay_conflict/);
  assert.deepEqual(f.managedLedger.load(f.managedScope, history.runId), parent);
  assert.deepEqual({ models: f.requests.length, tools: f.dispatches.length }, counters);
  await assert.rejects(route('sessions/native-child-tasks', identity), /control_run_unavailable/);
});

// Product assembly + real Kernel/SQLite/HTTP. The live root, question service
// and approval audit emitter below are declared Host-service doubles, not the
// mounted DSH or human/browser acceptance proof.
function installChildQuestionHost(f, answer) {
  const agent = f.payload.agent, handlers = new Set(), oldState = f.services.sessionProjections.stateOf;
  agent.id = 'live-parent';
  f.services.agents = { get: id => id === agent.id ? agent : undefined, roots: () => [agent] };
  f.services.sessionProjections.stateOf = (session, key) => key === 'agentPreset' ? 'parent-preset'
    : key === 'turnBoundary' ? { lastTurn: 1, openTurnStartSeq: 1 } : oldState(session, key);
  f.ctx.on = (event, handler) => { assert.equal(event, 'session/event'); handlers.add(handler); return () => handlers.delete(handler); };
  let asked = 0, approved = 0;
  const publish = (type, data) => {
    agent.session.append(type, data); const event = f.events.at(-1);
    for (const handler of handlers) handler(agent.session, event);
  };
  f.services.userQuestions = { ask: async request => {
    assert.equal(request.agent, agent); asked++;
    return answer(request);
  } };
  f.services.approval = { request: async request => {
    assert.equal(request.agent, agent); approved++;
    publish('approval/asked', { id: 'operation-'+approved, callId: request.callId, toolName: request.toolName, reason: request.reason });
    publish('approval/decided', { id: 'operation-'+approved, outcome: 'allowed-once' });
    return 'allowed-once';
  } };
  return { asked: () => asked, approved: () => approved };
}

for (const foreground of [false, true]) for (const approval of [false, true]) test(`SQLite ${foreground ? 'foreground' : 'background'} child A2A ${approval ? 'approval' : 'input'} waits through its live root and settles the original result`, { timeout: 20000 }, async t => {
  const peer = await internalPeer({ mode: 'pause', ...(approval ? { expectedContinuationParts: [{ data: 'approve' }],
    initialTask: { id: 'original-remote', contextId: 'original-context', status: { state: 'TASK_STATE_INPUT_REQUIRED', message: {
      messageId: 'remote-question', role: 'ROLE_AGENT', parts: [{ text: 'Approve remote operation?' }], metadata: {
        input_schema: { type: 'string', enum: ['approve', 'reject'] },
        ksadk_interaction: { version: 1, kind: 'approval', allowed_decisions: ['approve', 'reject'],
          presentation: { title: 'remote-write', description: '{"arguments":{}}' } },
      },
    } } },
  } : {}) });
  t.after(() => peer.close());
  const candidate = Promise.withResolvers();
  const f = await setup(t, { sqlite: true, a2a: peer, boundTools: [], childTool: foreground ? 'native_delegate' : 'native_start_child',
    role: { tools: ['call_a2a_agent'] },
    onParentContinuation: () => candidate.resolve(),
    childPlan: (_body, index) => index === 1 ? { call: { name: 'call_a2a_agent', arguments: { agent: 'research', message: 'Question in child' } } }
      : { text: 'Child consumed original remote result' } });
  const human = installChildQuestionHost(f, async request => {
    if (!foreground) await candidate.promise;
    return { answers: [{ id: request.questions[0].id, ...(approval ? { selected: ['批准远端操作'] }
      : { selected: [], custom: '{"answer":1}' }) }] };
  });
  const result = await f.host.executeTurn(f.payload);
  assert.equal(result.reason.kind, 'completed');
  assert.equal(human.asked(), 1); assert.equal(human.approved(), 1);
  const parent = f.ledger.list(f.scope, 'parent-session')[0];
  const reservation = parent.childBudgetReservations[0]; assert.ok(reservation.settledUsageDigest);
  const child = f.ledger.load(reservation.childScope, reservation.childRunId);
  assert.equal(child.snapshot.phase, 'completed'); assert.notEqual(child.snapshot.sessionId, 'parent-session');
  assert.equal(child.configuration.tools.length, 1); assert.equal(child.configuration.tools[0].name, 'call_a2a_agent');
  assert.equal(child.events.filter(event => event.kind === 'tool.receipt_reconciled').length, 1);
  const recovered = structuredClone(child), originalIntent = recovered.intents.find(row => row.kind === 'tool');
  recovered.receipts.find(row => row.operationKey === originalIntent.operationKey).status = 'uncertain';
  assert.equal(hasUnsafeChildReceipt(recovered), false, 'confirmed result can settle without rewriting original unknown receipt');
  const read = recovered.intents.find(row => row.kind === 'tool_receipt');
  for (const corrupt of ['fence', 'call', 'missing', 'unknown']) {
    const invalid = structuredClone(recovered), query = invalid.intents.find(row => row.operationKey === read.operationKey);
    if (corrupt === 'fence') query.payload.originalClaimedFence++;
    if (corrupt === 'call') query.payload.callId = 'foreign-call';
    if (corrupt === 'missing') invalid.receipts = invalid.receipts.filter(row => row.operationKey !== read.operationKey);
    if (corrupt === 'unknown') invalid.receipts.find(row => row.operationKey === read.operationKey).result.result = null;
    assert.equal(hasUnsafeChildReceipt(invalid), true, corrupt+' cannot authorize settlement');
  }
  const original = peer.record();
  assert.equal(original.request.native.runId, child.snapshot.runId);
  assert.equal(original.sessionDestination, 'parent-session');
  const control = Object.values(original.controls).find(row => row.command.kind === 'continue');
  assert.equal(control.hostDecision.receipt.sessionId, 'parent-session');
  assert.equal(peer.calls.filter(call => call.wireMethod === 'SendMessage').length, 2, 'initial and separately approved continuation only');
  assert.equal(peer.calls.filter(call => call.wireMethod === 'CancelTask').length, 0);
  assert.equal(f.requests.filter(row => row.body.model === 'child-model').length, 2);
  const parentRequests = f.requests.filter(row => row.body.model === 'parent-model');
  assert.equal(parentRequests.length, foreground ? 2 : 3);
  assert.ok(JSON.stringify(parentRequests.at(-1).body.messages).includes('Child consumed original remote result'));
});

for (const cancel of ['parent', 'child', 'host']) test(`SQLite ${cancel} cancellation retires an active child A2A question and rejects a late answer`, { timeout: 20000 }, async t => {
  const peer = await internalPeer({ mode: 'pause' }); t.after(() => peer.close());
  const f = await setup(t, { sqlite: true, a2a: peer, boundTools: [], childTool: 'native_delegate',
    role: { tools: ['call_a2a_agent'] },
    childPlan: () => ({ call: { name: 'call_a2a_agent', arguments: { agent: 'research', message: 'Canceled child question' } } }) });
  const entered = Promise.withResolvers(), delayed = Promise.withResolvers(), stop = new AbortController();
  f.payload.signal = stop.signal;
  let question;
  const human = installChildQuestionHost(f, request => { question = request; entered.resolve(); return delayed.promise; });
  const running = f.host.executeTurn(f.payload); running.catch(() => {});
  await entered.promise;
  let closing;
  if (cancel === 'parent') stop.abort(Error('user canceled parent'));
  else if (cancel === 'host') closing = f.host.close();
  else {
    const history = f.host.childHistory({ agentId: f.record.metadata.id, sessionId: 'parent-session' });
    assert.equal(history.tasks.length, 1); assert.equal(history.tasks[0].canCancel, true);
    const receipt = f.host.cancelChild({ agentId: f.record.metadata.id, sessionId: 'parent-session', runId: history.runId,
      childRunId: history.tasks[0].childRunId, commandId: 'stop-question-child' });
    assert.equal(receipt.status, 'accepted');
  }
  const ending = await running;
  await closing;
  if (cancel !== 'child') assert.equal(ending.reason.kind, 'aborted');
  const record = peer.record(), child = f.ledger.load(record.request.native.scope, record.request.native.runId);
  assert.equal(child.snapshot.phase, 'canceled'); assert.equal(question.signal.aborted, true);
  delayed.resolve({ answers: [{ id: question.questions[0].id, selected: [], custom: '{"answer":1}' }] });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(human.asked(), 1); assert.equal(human.approved(), 0);
  assert.equal(peer.calls.filter(call => call.wireMethod === 'SendMessage').length, 1);
  assert.equal(peer.calls.filter(call => call.wireMethod === 'CancelTask').length, 0);
  assert.equal(f.childModels(), 1);
  assert.deepEqual(Object.values(peer.record().managed.questions.entries).map(row => row.stage), ['withdrawn']);
});

for (const drift of ['root', 'preset', 'parent']) test(`SQLite child A2A answer cannot authorize an operation after ${drift} authority drift`, { timeout: 20000 }, async t => {
  const peer = await internalPeer({ mode: 'pause' }); t.after(() => peer.close());
  const f = await setup(t, { sqlite: true, a2a: peer, boundTools: [], childTool: 'native_delegate',
    role: { tools: ['call_a2a_agent'] },
    childPlan: () => ({ call: { name: 'call_a2a_agent', arguments: { agent: 'research', message: 'Original owned question' } } }) });
  const bind = f.gateway.forChild.bind(f.gateway);
  f.gateway.forChild = (agent, authority) => {
    assert.throws(() => bind(agent, { ...authority, a2aBinding: { ...authority.a2aBinding, bindingDigest: 'forged' } }), /child_a2a_binding_changed/);
    const missing = { ...authority }; delete missing.a2aBinding;
    assert.throws(() => bind(agent, missing), /child_tools_not_bound/);
    return bind(agent, authority);
  };
  const human = installChildQuestionHost(f, request => {
    if (drift === 'root') f.services.agents.roots = () => [];
    if (drift === 'preset') {
      const oldState = f.services.sessionProjections.stateOf;
      f.services.sessionProjections.stateOf = (session, key) => key === 'agentPreset' ? 'changed-preset' : oldState(session, key);
    }
    if (drift === 'parent') f.payload.agent.externalTurns.pending = () => null;
    return { answers: [{ id: request.questions[0].id, selected: [], custom: '{"answer":1}' }] };
  });
  await assert.rejects(f.host.executeTurn(f.payload), error => error.code === 'NATIVE_TURN_FAILED'
    && error.nativePhase === 'interrupted' && error.nativeReason === 'child_receipt_unavailable');
  assert.equal(human.asked(), 1); assert.equal(human.approved(), 0);
  assert.equal(peer.calls.filter(call => call.wireMethod === 'SendMessage').length, 1);
  assert.equal(peer.calls.filter(call => call.wireMethod === 'CancelTask').length, 0);
  assert.equal(f.childModels(), 1);
  assert.ok(Object.values(peer.record().managed.questions.entries).every(row => row.status === 'pending'));
});

test('SQLite Host borrows formal Skills into a child without inheriting the parent disclosure cursor', async t => {
  const skillId = 'skill://alpha@1.0.0', captured = [];
  const f = await setup(t, { sqlite: true, skills: true, boundTools: [], childTool: 'native_delegate',
    role: { tools: [], inheritSkills: true, maxTurns: 5, maxToolCalls: 3 },
    parentPlan: async (_body, index) => index === 1 ? { call: { name: 'skill_read_instructions', arguments: { skill_id: skillId } } }
      : index === 2 ? { call: { name: 'native_delegate', arguments: { role: 'reader', task: 'Read the bound alpha resource.' } } }
        : { text: 'Parent used the child Skill result.' },
    childPlan: async (body, index) => {
      if (index === 1) {
        assert.match(JSON.stringify(body.messages), /native_bound_skill_metadata/);
        assert.equal(JSON.stringify(body.messages).includes('INHERITED_SKILL_INSTRUCTIONS_BODY'), false);
        return { call: { name: 'skill_read_resource', arguments: { skill_id: skillId, resource_ref: 'data.txt' } } };
      }
      if (index === 2) {
        assert.match(JSON.stringify(body.messages), /skill_disclosure_order_invalid/);
        assert.equal(JSON.stringify(body.messages).includes('CHILD_SKILL_RESOURCE'), false);
        return { call: { name: 'skill_read_instructions', arguments: { skill_id: skillId } } };
      }
      if (index === 3) return { call: { name: 'skill_read_resource', arguments: { skill_id: skillId, resource_ref: 'data.txt' } } };
      assert.match(JSON.stringify(body.messages), /CHILD_SKILL_RESOURCE/);
      return { text: 'Child inspected its own admitted Skill resource.' };
    } });
  const bind = f.gateway.forChild.bind(f.gateway);
  f.gateway.forChild = (agent, authority) => {
    assert.throws(() => bind(agent, { ...authority, childSkills: { ...authority.childSkills,
      role: { ...authority.childSkills.role, maxTurns: 2 } } }), /child_skill_binding_changed/);
    const port = bind(agent, authority), execute = port.tools.execute;
    port.tools.execute = async request => {
      const saved = { ...structuredClone(Object.fromEntries(Object.entries(request).filter(([key]) => key !== 'signal'))), signal: request.signal };
      captured.push({ request: saved, execute });
      await assert.rejects(execute({ ...saved, scope: { ...saved.scope, tenantId: 'foreign' } }), /child_tool_not_bound/);
      const foreignBuild = await execute({ ...saved, buildId: 'foreign-build' });
      assert.notEqual(foreignBuild.status, 'ok');
      return execute(request);
    };
    return port;
  };
  await f.host.executeTurn(f.payload);
  const parent = f.ledger.load(f.scope, f.ledger.sessionHead(f.scope, f.payload.agent.session.id).runId);
  const childScope = { ...f.scope, agentId: `${f.scope.agentId}:child:reader` };
  const [child] = f.ledger.list(childScope), saved = f.ledger.load(childScope, child.runId);
  assert.equal(parent.snapshot.phase, 'completed'); assert.equal(child.phase, 'completed');
  assert.equal(child.buildId, parent.snapshot.buildId);
  assert.notEqual(child.sessionId, parent.snapshot.sessionId);
  assert.equal(saved.configuration.hostRecoveryBinding.childSkills.buildId, child.buildId);
  assert.equal(saved.configuration.hostRecoveryBinding.childSkills.role.maxTurns, 5);
  const results = saved.receipts.filter(receipt => saved.intents.some(intent => intent.kind === 'tool'
    && intent.operationKey === receipt.operationKey)).flatMap(receipt => receipt.result.results ?? []);
  assert.deepEqual(results.map(result => result.status), ['error', 'ok', 'ok']);
  assert.equal(results[2].content.text, 'CHILD_SKILL_RESOURCE');
  assert.ok(captured.length >= 3);
  assert.notEqual((await captured.at(-1).execute(captured.at(-1).request)).status, 'ok', 'completed child cannot replay a disclosure');
});

test('Host inheritSkills false omits formal Skills and discovery metadata from the child', async t => {
  const f = await setup(t, { sqlite: true, skills: true, boundTools: [], childTool: 'native_delegate',
    role: { tools: [], inheritSkills: false, maxToolCalls: 0 }, childPlan: async body => {
      assert.equal(JSON.stringify(body.messages).includes('native_bound_skill_metadata'), false);
      return { text: 'No inherited Skills are available.' };
    } });
  await f.host.executeTurn(f.payload);
  const [child] = f.ledger.list({ ...f.scope, agentId: `${f.scope.agentId}:child:reader` });
  assert.equal(child.phase, 'completed');
  const saved = f.ledger.load(child.scope, child.runId);
  assert.deepEqual(saved.configuration.tools, []);
  assert.equal(saved.configuration.hostRecoveryBinding?.childSkills, undefined);
});

test('SQLite child continuation keeps the borrowed source but requires its own committed Skill disclosure', async t => {
  const skillId = 'skill://alpha@1.0.0';
  const f = await setup(t, { sqlite: true, skills: true, boundTools: [], childTool: 'native_delegate',
    role: { tools: [], inheritSkills: true, maxTurns: 5, maxToolCalls: 3 },
    parentPlan: async (body, index) => {
      if (index === 1) return { call: { name: 'native_delegate', arguments: { role: 'reader', task: 'Inspect alpha.' } } };
      if (index === 2) {
        const id = /native-child-[a-f0-9]{64}/.exec(JSON.stringify(body.messages))?.[0]; assert.ok(id);
        return { call: { name: 'native_delegate', arguments: { role: 'reader', task: 'Continue alpha.', continuation_of: id } } };
      }
      return { text: 'Both child Runs inspected their own admitted resource.' };
    },
    childPlan: async (body, index) => {
      if ([1, 5].includes(index)) return { call: { name: 'skill_read_instructions', arguments: { skill_id: skillId } } };
      if ([2, 4, 6].includes(index)) return { call: { name: 'skill_read_resource', arguments: { skill_id: skillId, resource_ref: 'data.txt' } } };
      if (index === 7) {
        assert.match(JSON.stringify(body.messages), /skill_disclosure_order_invalid/);
        assert.match(JSON.stringify(body.messages), /CHILD_SKILL_RESOURCE/);
      }
      return { text: 'Child has the resource.' };
    } });
  await f.host.executeTurn(f.payload);
  const scope = { ...f.scope, agentId: `${f.scope.agentId}:child:reader` }, children = f.ledger.list(scope);
  assert.equal(children.length, 2); assert.equal(f.childModels(), 7);
  const [first, second] = children.map(child => f.ledger.load(scope, child.runId));
  assert.equal(first.snapshot.phase, 'completed'); assert.equal(second.snapshot.phase, 'completed');
  assert.equal(first.snapshot.sessionId, second.snapshot.sessionId);
  assert.equal(second.snapshot.parentRunId, first.snapshot.runId);
  assert.deepEqual(first.configuration.hostRecoveryBinding.childSkills, second.configuration.hostRecoveryBinding.childSkills);
  const results = second.receipts.filter(receipt => second.intents.some(intent => intent.kind === 'tool'
    && intent.operationKey === receipt.operationKey)).flatMap(receipt => receipt.result.results ?? []);
  assert.deepEqual(results.map(result => result.status), ['error', 'ok', 'ok']);
});

test('SQLite Host grants inherited MCP through each child intent and rejects foreign or completed replay', async t => {
  const effects = [], captured = [];
  const f = await setup(t, { sqlite: true, childTool: 'native_delegate', boundTools: [],
    role: { tools: [], inheritMcp: true, maxToolCalls: null },
    mcp: { contracts: [childMcpContract], execute: async input => {
      assert.equal(typeof input.assertCurrent, 'function'); input.assertCurrent();
      effects.push(input); return { content: [{ type: 'text', text: `Remote evidence ${input.arguments.id}` }] };
    } },
    childPlan: async (body, index) => {
      if (index < 3) return { call: { name: 'remote_lookup', arguments: { id: index } } };
      assert.match(JSON.stringify(body.messages), /Remote evidence 1/);
      assert.match(JSON.stringify(body.messages), /Remote evidence 2/);
      return { text: 'Inherited MCP delivery' };
    } });
  const bind = f.gateway.forChild.bind(f.gateway);
  f.gateway.forChild = (agent, authority) => {
    const ports = bind(agent, authority), execute = ports.tools.execute;
    ports.tools.execute = async request => {
      captured.push({ request: { ...structuredClone(Object.fromEntries(Object.entries(request).filter(([key]) => key !== 'signal'))),
        signal: request.signal }, execute });
      await assert.rejects(execute({ ...request, scope: { ...request.scope, userId: 'foreign' } }), /child_tool_not_bound/);
      await assert.rejects(execute({ ...request, runId: 'foreign-run' }), /child_mcp_authority_stale/);
      return execute(request);
    };
    return ports;
  };
  await f.host.executeTurn(f.payload);
  const childScope = { ...f.scope, agentId: `${f.scope.agentId}:child:reader` };
  const child = f.ledger.list(childScope)[0], saved = f.ledger.load(childScope, child.runId);
  assert.equal(child.phase, 'completed'); assert.equal(effects.length, 2);
  assert.ok(saved.configuration.limits.maxToolCalls >= 2 && saved.configuration.limits.maxToolCalls <= 12);
  assert.deepEqual(saved.configuration.tools.map(tool => tool.name), ['remote_lookup']);
  assert.ok(saved.configuration.tools.every(tool => !tool.readOnly && !tool.concurrentSafe));
  assert.ok(effects.every(input => input.agentId === f.record.metadata.id && input.resourceId === 'bound-catalog'
    && input.agent === f.payload.agent && input.resultFormat === 'mcp-result/v1'));
  assert.equal(f.dispatches.filter(item => item.name === 'remote_lookup').length, 2);
  for (const { request, execute } of captured) await assert.rejects(execute(request), /child_mcp_authority_stale/);
  for (const input of effects) assert.throws(input.assertCurrent, /child_mcp_authority_stale/);
  assert.equal(effects.length, 2);
  const reopened = new SqliteRunStore(join(f.root, 'runs.sqlite'));
  try { assert.deepEqual(reopened.load(childScope, child.runId).configuration, saved.configuration); }
  finally { reopened.close(); }
  assert.throws(() => bind(f.payload.agent, { scope: childScope, store: f.ledger, sessionId: child.sessionId,
    toolNames: ['remote_lookup'] }), /child_tools_not_bound/);
  assert.throws(() => bind(f.payload.agent, { scope: childScope, store: f.ledger, sessionId: child.sessionId,
    toolNames: ['remote_lookup'], mcpBinding: { ...f.gateway.childMcpBinding, bindingDigest: '0'.repeat(64) } }), /mcp_binding_changed/);
});

test('MCP inheritance is opt-in and rejects concurrent-safe roles with unknown remote effects before model work', async t => {
  const mcp = { contracts: [childMcpContract], execute: async () => assert.fail('No MCP dispatch') };
  const f = await setup(t, { sqlite: true, childTool: 'native_delegate', mcp,
    childPlan: async (_body, index) => index === 1
      ? { call: { name: 'read_workspace_file', arguments: { path: 'proof.txt' } } } : { text: 'Read only local evidence' } });
  await f.host.executeTurn(f.payload);
  const childScope = { ...f.scope, agentId: `${f.scope.agentId}:child:reader` };
  assert.deepEqual(f.ledger.load(childScope, f.ledger.list(childScope)[0].runId).configuration.tools.map(tool => tool.name), ['read_workspace_file']);
  const unsafe = await setup(t, { mcp, role: { inheritMcp: true, concurrentSafe: true } });
  await assert.rejects(unsafe.host.executeTurn(unsafe.payload), /child_mcp_role_unsafe/);
  assert.equal(unsafe.requests.length, 0);
});

for (const drift of ['before_dispatch', 'after_effect']) test(`child MCP full request authority loss ${drift} cannot authorize a successful effect`, async t => {
  let request, effects = 0;
  const mutate = () => { request.budget = { ...request.budget, remainingTokens: (request.budget?.remainingTokens ?? 0) + 1 }; };
  const f = await setup(t, { sqlite: true, childTool: 'native_delegate', boundTools: [],
    role: { tools: [], inheritMcp: true, maxToolCalls: null },
    beforeToolDispatch: async input => { if (input.name === 'remote_lookup' && drift === 'before_dispatch') mutate(); },
    mcp: { contracts: [childMcpContract], execute: async () => {
      effects++; if (drift === 'after_effect') mutate();
      return { content: [{ type: 'text', text: 'Remote effect receipt' }] };
    } },
    childPlan: async (_body, index) => index === 1
      ? { call: { name: 'remote_lookup', arguments: { id: 1 } } } : { text: 'Child completion' } });
  const bind = f.gateway.forChild.bind(f.gateway);
  f.gateway.forChild = (agent, authority) => {
    const ports = bind(agent, authority), execute = ports.tools.execute;
    ports.tools.execute = input => { request = input; return execute(input); };
    return ports;
  };
  try { await f.host.executeTurn(f.payload); }
  catch (error) { assert.equal(error.nativeReason, 'child_receipt_unavailable'); }
  assert.equal(effects, drift === 'before_dispatch' ? 0 : 1);
  const childScope = { ...f.scope, agentId: `${f.scope.agentId}:child:reader` };
  const child = f.ledger.list(childScope)[0], saved = f.ledger.load(childScope, child.runId);
  const results = saved.receipts.flatMap(receipt => receipt.result.results ?? []);
  assert.ok(!results.some(result => result.status === 'ok'));
  if (drift === 'after_effect') {
    assert.ok(results.some(result => result.status === 'uncertain'));
    assert.match(JSON.stringify(results), /Remote effect receipt/);
  }
});

test('production Host confines a writing child and its continuation to the original isolated workspace', async t => {
  const boundTools = ['read_workspace_file', 'write_workspace_file'];
  let f, firstId;
  f = await setup(t, { sqlite: true, childTool: 'native_delegate', boundTools,
    role: { tools: boundTools, maxTurns: 3, maxToolCalls: 2 },
    childPlan: async (body, index) => {
      if (index === 1) return { call: { name: 'write_workspace_file', arguments: { path: 'child-only.txt', content: 'isolated child bytes' } } };
      if (index === 3) return { call: { name: 'read_workspace_file', arguments: { path: 'child-only.txt' } } };
      if (index === 4) assert.match(JSON.stringify(body.messages.filter(message => message.role === 'tool')), /isolated child bytes/);
      return { text: 'Child file evidence' };
    },
    parentPlan: async (body, index) => {
      if (index === 1) return { call: { name: 'native_delegate', arguments: { role: 'reader', task: 'Write an isolated child file' } } };
      if (index === 2) {
        firstId = /native-child-[a-f0-9]{64}/.exec(JSON.stringify(body.messages))?.[0]; assert.ok(firstId);
        assert.equal(await readFile(join(f.workspaceRoot, 'proof.txt'), 'utf8'), 'Actual child evidence');
        await assert.rejects(readFile(join(f.workspaceRoot, 'child-only.txt')), { code: 'ENOENT' });
        return { call: { name: 'native_delegate', arguments: { role: 'reader', task: 'Read your original isolated file', continuation_of: firstId } } };
      }
      return { text: 'Parent delivery' };
    } });
  await f.host.executeTurn(f.payload);
  const childScope = { ...f.scope, agentId: `${f.scope.agentId}:child:reader` };
  const children = f.ledger.list(childScope).map(snapshot => f.ledger.load(childScope, snapshot.runId));
  assert.equal(children.length, 2); assert.equal(f.childModels(), 4);
  const first = children.find(record => record.snapshot.runId === firstId), next = children.find(record => record !== first);
  assert.equal(first.snapshot.phase, 'completed'); assert.equal(next.snapshot.phase, 'completed');
  assert.equal(next.snapshot.parentRunId, firstId); assert.equal(next.snapshot.sessionId, first.snapshot.sessionId);
  assert.ok(first.snapshot.workspaceRevision);
  const binding = first.configuration.hostRecoveryBinding.childWorkspace;
  assert.deepEqual(next.configuration.hostRecoveryBinding.childWorkspace, binding);
  assert.equal(binding.contract, 'agentkit.native-child-workspace-binding/v1');
  assert.equal(await readFile(join(f.root, 'native-harness', 'child-workspaces', binding.isolationId, 'work', 'child-only.txt'), 'utf8'), 'isolated child bytes');
  await assert.rejects(readFile(join(f.workspaceRoot, 'child-only.txt')), { code: 'ENOENT' });
  assert.equal(f.dispatches.filter(dispatch => dispatch.name === 'write_workspace_file').length, 1);
  assert.equal(first.receipts.flatMap(receipt => receipt.result.results ?? []).filter(result => result.status === 'ok'
    && result.workspaceChangedPaths?.includes('child-only.txt')).length, 1);
});

test('production Host restores merge grants from a later parent Run for incremental child publication', async t => {
  const boundTools = ['read_workspace_file', 'write_workspace_file'];
  let f, firstChildId, nextChildId;
  f = await setup(t, { sqlite: true, boundTools, role: { tools: boundTools, maxTurns: 3, maxToolCalls: 2 },
    childPlan: async (_body, index) => index === 1 || index === 3
      ? { call: { name: 'write_workspace_file', arguments: { path: 'child-only.txt', content: index === 1 ? 'version one' : 'version two' } } }
      : { text: 'Child file delivery' },
    parentPlan: async (body, index) => {
      if (index === 1) return { call: { name: 'native_delegate', arguments: { role: 'reader', task: 'Write child version one' } } };
      if (index === 2) {
        firstChildId = /native-child-[a-f0-9]{64}/.exec(JSON.stringify(body.messages))?.[0]; assert.ok(firstChildId);
        return { text: 'First parent delivery' };
      }
      if (index === 3) return { call: { name: 'native_child_merge', arguments: { child_run_id: firstChildId } } };
      if (index === 4) {
        assert.equal(await readFile(join(f.workspaceRoot, 'child-only.txt'), 'utf8'), 'version one');
        return { call: { name: 'native_delegate', arguments: { role: 'reader', task: 'Update your isolated file', continuation_of: firstChildId } } };
      }
      if (index === 5) {
        const head = f.ledger.sessionHead(f.scope, 'parent-session'); nextChildId = head.childRunIds.at(-1);
        assert.notEqual(nextChildId, firstChildId);
        return { call: { name: 'native_child_merge', arguments: { child_run_id: nextChildId } } };
      }
      return { text: 'Incremental parent delivery' };
    } });
  await f.host.executeTurn(f.payload);
  const childScope = { ...f.scope, agentId: `${f.scope.agentId}:child:reader` };
  const source = f.ledger.load(childScope, firstChildId);
  const originalParent = f.ledger.sessionHead(f.scope, 'parent-session');
  f.payload.agent.session.append('turn/start', { turn: 2 });
  await f.host.executeTurn({ ...f.payload, turn: 2, input: { ...f.payload.input, messages: [{ id: 'merge-followup', role: 'user',
    source: { kind: 'user' }, content: [{ type: 'text', text: 'Publish and continue the original child files.' }] }] } });
  const later = f.ledger.sessionHead(f.scope, 'parent-session'); assert.equal(later.phase, 'completed');
  assert.equal(later.parentRunId, originalParent.runId); assert.equal(f.childModels(), 4);
  assert.equal(await readFile(join(f.workspaceRoot, 'child-only.txt'), 'utf8'), 'version two');
  assert.deepEqual(f.ledger.load(childScope, firstChildId), source);
  const merges = f.ledger.load(f.scope, later.runId).receipts.flatMap(receipt => receipt.result.results ?? [])
    .filter(result => result.content?.schema_version === 'native.child-file-merge/v2');
  assert.equal(merges.length, 2); assert.ok(merges.every(result => result.status === 'ok'));
  assert.equal(merges[1].content.comparison_revision, source.snapshot.workspaceRevision);
  assert.notEqual(merges[1].content.comparison_revision, source.configuration.hostRecoveryBinding.childWorkspace.baseRevision);
  const reopened = new SqliteRunStore(join(f.root, 'runs.sqlite'));
  try {
    const args = { store: reopened, childScopes: [childScope], parent: reopened.load(f.scope, later.runId).snapshot,
      child: reopened.load(childScope, nextChildId) };
    const grant = previousChildPublication(args);
    assert.equal(grant.revision, source.snapshot.workspaceRevision);
    assert.equal(grant.inventoryDigest, merges[0].content.publication.inventory_digest);
    assert.equal(previousChildPublication({ ...args, parent: { ...args.parent, sessionId: 'foreign-session' } }), null);
    assert.equal(previousChildPublication({ ...args, child: { ...args.child,
      snapshot: { ...args.child.snapshot, workspaceRevision: 'sha256:' + '0'.repeat(64) } } }), null);
    for (const corrupt of ['uncertain', 'failed', 'extra_arguments', 'no_prepared_event']) {
      const store = { load: (scope, runId) => {
        const record = reopened.load(scope, runId);
        if (runId !== later.runId || scope.agentId !== f.scope.agentId) return record;
        const matching = record.intents.filter(intent => intent.payload.calls?.some(call => call.name === 'native_child_merge'));
        for (const intent of matching) {
          if (corrupt === 'extra_arguments') intent.payload.calls.forEach(call => { if (call.name === 'native_child_merge') call.arguments.extra = true; });
          if (corrupt === 'no_prepared_event') record.events = record.events.filter(event => event.payload.operationKey !== intent.operationKey);
          for (const receipt of record.receipts.filter(receipt => receipt.operationKey === intent.operationKey)) {
            if (corrupt === 'uncertain') receipt.status = 'uncertain';
            if (corrupt === 'failed') receipt.result.results.forEach(result => { result.status = 'error'; });
          }
        }
        return record;
      } };
      assert.equal(previousChildPublication({ ...args, store }), null, corrupt);
    }
  } finally { reopened.close(); }
});
for (const sqlite of [false, true]) {
  for (const action of ['send', 'cancel']) test(`${sqlite ? 'sqlite' : 'memory'}: Host control route ${action} targets the original active child`, async t => {
    let entered, release;
    const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
    const f = await setup(t, { sqlite, childTool: 'native_delegate', beforeChildModel: async index => {
      if (index === 1) { entered(); await gate; }
    } });
    t.after(() => release());
    const running = f.host.executeTurn(f.payload); await started;
    const input = { agentId: f.record.metadata.id, sessionId: 'parent-session' }, history = f.host.childHistory(input), task = history.tasks[0];
    assert.equal(task.canSendInput, true); assert.equal(task.canCancel, true); assert.equal(task.goalRevision, 0);
    const route = createSessionRoutes({ getNativeHost: async () => f.host });
    const command = { ...input, runId: history.runId, childRunId: task.childRunId, commandId: `host-${action}`,
      ...(action === 'send' ? { text: 'Check the actual file with this extra guidance', expectedGoalRevision: task.goalRevision } : {}) };
    assert.equal((await route(`sessions/native-child-${action}`, command)).value.status, 'accepted');
    assert.equal((await route(`sessions/native-child-${action}`, command)).value.status, 'duplicate');
    await assert.rejects(route(`sessions/native-child-${action}`, { ...command, runId: 'stale' }), /control_run_unavailable/);
    if (action === 'send') {
      const childScope = { ...f.scope, agentId: `${f.scope.agentId}:child:reader` };
      for (let tries = 0; tries < 500 && !f.ledger.load(childScope, task.childRunId).commands.some(row => row.command.kind === 'guide'); tries++)
        await new Promise(resolve => setTimeout(resolve, 2));
      assert.equal(f.ledger.load(childScope, task.childRunId).commands.filter(row => row.command.kind === 'guide').length, 1);
      release();
    }
    await running;
    const after = f.host.childHistory(input); assert.equal(after.tasks.length, 1); assert.equal(after.tasks[0].childRunId, task.childRunId);
    assert.equal(after.tasks[0].phase, action === 'cancel' ? 'canceled' : 'completed');
    assert.equal(after.tasks[0].usageIncludedInParent, true); assert.equal(after.tasks[0].canCancel, false);
    assert.equal(after.tasks[0].lastControl.commandId, command.commandId); assert.equal(after.tasks[0].lastControl.status, 'delivered');
    const parent = f.ledger.load(f.scope, history.runId); assert.equal(parent.snapshot.phase, 'completed');
    assert.equal(parent.events.filter(event => event.kind === (action === 'send' ? 'child.input_queued' : 'child.cancel_requested')).length, 1);
    if (action === 'send') assert.match(JSON.stringify(f.requests.filter(item => item.body.model === 'child-model').at(-1).body.messages), /this extra guidance/);
    else assert.equal(f.dispatches.filter(item => item.name === 'read_workspace_file').length, 0);
    release();
  });

  test(`${sqlite ? 'sqlite' : 'memory'}: Host child history spans only its parent Session and reads original settled pages without execution`, async t => {
    const text = '首段😀子任务证据';
    const f = await setup(t, { sqlite, childTool: 'native_delegate', childResult: text });
    await f.host.executeTurn(f.payload);
    const input = { agentId: f.record.metadata.id, sessionId: 'parent-session' };
    const first = f.host.childHistory(input), original = f.ledger.load(f.scope, first.runId);
    assert.equal(first.contract, 'agentkit.studio-native-child-history/v1'); assert.equal(first.tasks.length, 1);
    assert.equal(first.tasks[0].resultAvailable, true); assert.equal(first.tasks[0].canPromote, false);
    assert.equal(first.tasks[0].usageIncludedInParent, true); assert.equal(first.tasks[0].usage.modelCalls, 2);
    const childRunId = first.tasks[0].childRunId;
    const page = f.host.childResult({ ...input, childRunId, offset: 2, limit: 3 });
    assert.equal(page.text, [...text].slice(2, 5).join('')); assert.equal(page.parentAcceptance, 'not_evaluated');
    assert.equal(page.nextOffset, 5); assert.equal(page.complete, false);
    const counts = { requests: f.requests.length, tools: f.dispatches.length };
    const repeated = f.host.childResult({ ...input, childRunId }); assert.equal(repeated.text, text);
    assert.deepEqual({ requests: f.requests.length, tools: f.dispatches.length }, counts);
    f.payload.agent.session.append('turn/start', { turn: 2 });
    await f.host.executeTurn({ ...f.payload, turn: 2 });
    const history = f.host.childHistory(input);
    assert.notEqual(history.runId, first.runId); assert.equal(history.tasks.length, 1);
    assert.equal(history.tasks[0].parentRunId, first.runId); assert.equal(history.tasks[0].childRunId, childRunId);
    assert.equal(f.host.childResult({ ...input, childRunId }).text, text);
    assert.equal(f.host.childHistory({ ...input, runId: first.runId }).runId, first.runId);
    assert.throws(() => f.host.childHistory({ ...input, offset: 1, inventoryDigest: first.inventoryDigest }), /inventory_changed/);
    assert.throws(() => f.host.childHistory({ ...input, sessionId: 'other', runId: first.runId }), /run_unavailable/);
    assert.throws(() => f.host.childResult({ ...input, agentId: 'other', childRunId }), /result_unavailable/);
    assert.throws(() => f.host.childResult({ ...input, childRunId: 'guessed-child' }), /result_unavailable/);
    assert.deepEqual(f.ledger.load(f.scope, first.runId), original);
  });

  test(`${sqlite ? 'sqlite' : 'memory'}: Studio Host promotes an admitted foreground child before parent continuation`, { timeout: 15000 }, async t => {
    let entered, release, continued = false;
    const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
    const f = await setup(t, { sqlite, childTool: 'native_delegate', beforeChildModel: async index => {
      if (index === 1) { entered(); await gate; }
    }, onParentContinuation: async () => {
      assert.equal(f.childModels(), 1); continued = true;
      const parent = f.ledger.sessionHead(f.scope, 'parent-session');
      assert.deepEqual(parent.promotedChildRunIds, parent.childRunIds); release();
    } });
    t.after(() => release());
    const running = f.host.executeTurn(f.payload); await started;
    const input = { agentId: f.record.metadata.id, sessionId: 'parent-session' };
    const route = createSessionRoutes({ getNativeHost: async () => f.host });
    const state = (await route('sessions/native-child-tasks', input)).value;
    const live = f.host.childHistory(input);
    assert.equal(live.tasks.length, 1); assert.equal(live.tasks[0].childRunId, state.tasks[0].childRunId);
    assert.equal(live.tasks[0].resultAvailable, false); assert.equal(live.tasks[0].canPromote, true);
    assert.equal(live.tasks[0].usageIncludedInParent, false);
    assert.equal(state.contract, 'agentkit.studio-native-child-control/v1'); assert.equal(state.tasks.length, 1);
    assert.equal(state.tasks[0].canPromote, true);
    assert.throws(() => f.host.childTasks({ ...input, agentId: 'another-agent' }), /control_run_unavailable/);
    assert.throws(() => f.host.promoteChild({ ...input, runId: 'stale-parent', childRunId: state.tasks[0].childRunId, commandId: 'stale' }), /control_run_unavailable/);
    const command = { ...input, runId: state.runId, childRunId: state.tasks[0].childRunId, commandId: 'host-promote' };
    assert.equal((await route('sessions/native-child-promote', command)).value.status, 'accepted');
    assert.equal((await route('sessions/native-child-promote', command)).value.status, 'duplicate');
    await running;
    const parent = f.ledger.sessionHead(f.scope, 'parent-session');
    assert.equal(parent.phase, 'completed'); assert.equal(continued, true); assert.equal(f.childModels(), 2);
    assert.equal(parent.childRunIds.length, 1); assert.ok(parent.childBudgetReservations[0].settledUsageDigest);
    assert.equal(f.ledger.events(f.scope, parent.runId).filter(event => event.kind === 'child.promoted').length, 1);
    assert.throws(() => f.host.childTasks(input), /control_run_unavailable/);
  });
  for (const childTool of ['native_start_child', 'native_delegate']) {
    test(`${sqlite ? 'sqlite' : 'memory'}: Studio ${childTool} delivers the foreground result before the next parent model`, async t => {
      const f = await setup(t, { sqlite, childTool, childArguments: childTool === 'native_start_child' ? { background: false } : {} });
      await f.host.executeTurn(f.payload);
      const parents = f.requests.filter(item => item.body.model === 'parent-model');
      assert.equal(parents.length, 2); assert.equal(f.childModels(), 2);
      const results = parents[1].body.messages.filter(message => message.role === 'tool');
      assert.equal(results.length, 1); assert.match(results[0].content, /Child read actual workspace evidence/);
      const parent = f.ledger.sessionHead(f.scope, 'parent-session');
      assert.equal(parent.phase, 'completed'); assert.equal(parent.childRunIds.length, 1);
      assert.equal(parent.childBudgetReservations[0].deliveryMode, 'foreground');
      assert.ok(parent.childBudgetReservations[0].settledUsageDigest);
      assert.deepEqual([parent.descendantUsage.modelCalls, parent.descendantUsage.toolCalls], [2, 1]);
      assert.equal(parent.messages.filter(message => message.kind === 'background_child_observation').length, 0);
      assert.equal(f.ledger.events(f.scope, parent.runId).filter(event => event.kind === 'usage.reported'
        && event.payload.source === 'descendant_runs').length, 1);
      assert.deepEqual(f.dispatches.map(item => item.name).sort(), [childTool, 'read_workspace_file'].sort());
    });
  }
  test(`${sqlite ? 'sqlite' : 'memory'}: Studio exposes parallel result and task queries through the actual Native tool gateway`, async t => {
    const f = await setup(t, { sqlite, control: true, query: true });
    await f.host.executeTurn(f.payload);
    const request = f.requests.filter(item => item.body.model === 'parent-model').at(-1);
    const results = request.body.messages.filter(message => message.role === 'tool').map(message => message.content).join('\n');
    assert.match(results, /native.child-result\/v1/); assert.match(results, /Child read actual workspace evidence/);
    assert.match(results, /native.child-tasks\/v2/);
    assert.ok(f.dispatches.some(item => item.name === 'native_child_result'));
    assert.ok(f.dispatches.some(item => item.name === 'native_child_tasks'));
    const parent = f.ledger.sessionHead(f.scope, 'parent-session');
    assert.deepEqual([parent.descendantUsage.modelCalls, parent.descendantUsage.toolCalls], [2, 1]);
    assert.equal(f.ledger.events(f.scope, parent.runId).filter(event => event.kind === 'usage.reported'
      && event.payload.source === 'descendant_runs').length, 1);
  });
  test(`${sqlite ? 'sqlite' : 'memory'}: child binds parent JSON output constraints and its own role schema without parent acceptance`, async t => {
    const fixture = await setup(t, { sqlite, goal: '读取 proof.txt。最后只返回 JSON 对象，格式为 {"count":整数}。',
      childArguments: { output_format: 'json_object', output_contract: 'parent' },
      role: { outputSchema: { type: 'object', properties: { count: { minimum: 1 } }, required: ['count'] } },
      childResult: '{"count":2}', parentResult: '{"count":2}' });
    await fixture.host.executeTurn(fixture.payload);
    const parent = fixture.ledger.sessionHead(fixture.scope, 'parent-session');
    assert.equal(parent.phase, 'completed'); assert.equal(parent.childRunIds.length, 1);
    const recovery = readNativeRecoveryBinding(fixture.ledger.load(fixture.scope, parent.runId), {
      agentId: fixture.record.metadata.id, sessionId: 'parent-session', runId: parent.runId });
    assert.equal(recovery.agentRevision, 1); assert.equal(recovery.buildId, null);
    assert.deepEqual(recovery.messages, fixture.payload.input.messages);
    assert.deepEqual(recovery.source, { provider: 'agentkit-studio-parent-profile', model: 'parent-model' });
    assert.equal(recovery.maxTokens, null);
    assert.equal(JSON.stringify(recovery).includes('fixture-secret'), false);
    const reservation = parent.childBudgetReservations[0], child = fixture.ledger.load(reservation.childScope, reservation.childRunId);
    const childContract = child.configuration.contract, parentContract = fixture.ledger.load(fixture.scope, parent.runId).configuration.contract;
    assert.equal(childContract.objective, 'Read proof.txt'); assert.notEqual(childContract.revision, parentContract.revision);
    assert.equal(childContract.finalOutputFormat, 'json_object');
    assert.deepEqual(childContract.finalSubmissionSchema.properties.output.allOf,
      [fixture.roles[0].outputSchema, parentContract.finalSubmissionSchema.properties[parentContract.finalSubmissionPayloadKey]]);
    assert.ok(reservation.settledUsageDigest); assert.equal(child.snapshot.phase, 'completed');
    assert.ok(fixture.requests.some(item => item.body.model === 'child-model' && JSON.stringify(item.body).includes('minimum')));
  });
  test(`${sqlite ? 'sqlite' : 'memory'}: production Studio assembly runs an approved child model and scoped workspace read`, { timeout: 15000 }, async t => {
    const fixture = await setup(t, { sqlite, control: true });
    await fixture.host.executeTurn(fixture.payload);
    assert.equal(fixture.childModels(), 2);
    const parent = fixture.ledger.sessionHead(fixture.scope, 'parent-session');
    assert.equal(parent.phase, 'completed'); assert.equal(parent.childRunIds.length, 1);
    assert.equal(parent.descendantUsage.modelCalls, 2); assert.equal(parent.descendantUsage.toolCalls, 1);
    const reservation = parent.childBudgetReservations[0]; assert.ok(reservation.settledUsageDigest);
    const child = fixture.ledger.load(reservation.childScope, reservation.childRunId);
    assert.equal(child.snapshot.phase, 'completed'); assert.equal(child.configuration.profile.profileId, 'child-profile');
    assert.equal(child.configuration.childOwnerBinding.role, 'reader'); assert.equal(child.snapshot.parentRunId, null);
    assert.equal(child.configuration.limits.maxModelCalls, 3); assert.equal(child.configuration.limits.maxToolCalls, 2);
    assert.equal(fixture.ledger.events(fixture.scope, parent.runId).filter(event => event.kind === 'usage.reported'
      && event.payload.source === 'descendant_runs').length, 1);
    assert.equal(fixture.dispatches.filter(item => item.name === 'read_workspace_file').length, 1);
    const childRequest = fixture.requests.find(item => item.body.model === 'child-model');
    assert.match(childRequest.body.messages[0].content, /Read the requested workspace evidence/);
    assert.equal(JSON.stringify(childRequest.body.messages).includes('Delegate a bounded read'), false);
    assert.equal(JSON.stringify(fixture.gateway.childBinding.roles).includes('fixture-secret'), false);
    assert.ok(fixture.dispatches.some(item => item.name === 'native_child_control'));
  });
}
test('model arguments cannot select an unbound child profile', async t => {
  const fixture = await setup(t, { forged: true });
  await fixture.host.executeTurn(fixture.payload);
  assert.equal(fixture.childModels(), 0); assert.equal(fixture.dispatches.length, 0);
});
for (const childArguments of [{ output_contract: 'parent' }, { output_format: 'json_object', output_contract: 'parent' }]) {
  test(`unavailable or malformed parent output binding cannot launch a child: ${JSON.stringify(childArguments)}`, async t => {
    const fixture = await setup(t, { childArguments });
    await assert.rejects(fixture.host.executeTurn(fixture.payload), { code: 'NATIVE_TURN_FAILED' });
    const parent = fixture.ledger.sessionHead(fixture.scope, 'parent-session');
    assert.equal(fixture.childModels(), 0); assert.equal(parent.childRunIds.length, 0);
    assert.equal(fixture.ledger.list({ ...fixture.scope, agentId: `${fixture.scope.agentId}:child:reader` }).length, 0);
  });
}
for (const role of [{ modelProfileId: 'foreign' }, { tools: ['write_workspace_file'] }, { maxTotalTokens: 1000 }, { maxArtifacts: 1 }]) {
  test(`unsupported or unauthorized role bindings fail before model work: ${JSON.stringify(role)}`, async t => {
    if (role.maxTotalTokens || role.maxArtifacts) { assert.throws(() => nativeChildRoles({ subAgents: [{ name: 'reader', instructions: 'Read', ...role }] }), /child_policy_unavailable/); return; }
    const fixture = await setup(t, { role });
    await assert.rejects(fixture.host.executeTurn(fixture.payload), /child_(model_unbound|write_role_requires_isolation)/);
    assert.equal(fixture.requests.length, 0);
  });
}

const mediaParts = [
  { type: 'text', text: 'Read the scoped current image and proof.txt.' },
  { type: 'image', offloaded: true, attachment: { attachmentId: 'omitted-image' } },
  { type: 'image', attachment: { attachmentId: 'unselected-image' } },
  { type: 'image', attachment: { attachmentId: 'selected-image' } },
];
for (const sqlite of [false, true]) for (const supportsImages of [false, true])
test(`${sqlite ? 'sqlite' : 'memory'}: continuation preserves source image history and checks the current model (${supportsImages})`, async t => {
  let source;
  const f = await setup(t, { sqlite, inputParts: mediaParts, childInput: ['text', 'image'], parentPlan: async (_body, index) => {
    if (index === 1) return { call: { name: 'native_delegate', arguments: { role: 'reader', task: 'Read proof.txt',
      media: [{ source: 'parent_user_input', index: 3 }] } } };
    if (index === 3) return { call: { name: 'native_delegate', arguments: { role: 'reader', task: 'Continue the original evidence', continuation_of: source } } };
    return { text: 'Parent delivery' };
  } });
  await f.host.executeTurn(f.payload);
  const originalParent = f.ledger.sessionHead(f.scope, 'parent-session'), reservation = originalParent.childBudgetReservations[0];
  source = reservation.childRunId;
  const original = f.ledger.load(reservation.childScope, source);
  f.modelValues.modelProfiles[1].input = supportsImages ? ['text', 'image'] : ['text'];
  f.payload.agent.session.append('turn/start', { turn: 2 });
  await f.host.executeTurn({ ...f.payload, turn: 2, input: { ...f.payload.input, messages: [{ id: 'followup-user', role: 'user',
    source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue the previous child evidence.' }] }] } });
  const next = f.ledger.sessionHead(f.scope, 'parent-session');
  assert.notEqual(next.runId, originalParent.runId); assert.equal(next.phase, 'completed');
  assert.deepEqual(f.ledger.load(reservation.childScope, source), original);
  const childRequests = f.requests.filter(item => item.body.model === 'child-model');
  if (supportsImages) {
    assert.equal(next.childRunIds.length, 1); assert.equal(childRequests.length, 3);
    const child = f.ledger.load(reservation.childScope, next.childRunIds[0]);
    assert.equal(child.snapshot.sessionId, original.snapshot.sessionId); assert.equal(child.snapshot.parentRunId, source);
    const history = JSON.stringify(childRequests[2].body.messages);
    assert.ok(history.includes(Buffer.from('selected-image').toString('base64')));
    assert.equal(history.includes(Buffer.from('unselected-image').toString('base64')), false);
    assert.equal(next.descendantUsage.modelCalls, 1); assert.equal(next.descendantUsage.toolCalls, 0);
  } else {
    assert.equal(next.childRunIds.length, 0); assert.equal(childRequests.length, 2);
    assert.match(next.messages.filter(message => message.role === 'tool').at(-1).content, /child_followup_model_image_unavailable/);
    assert.equal(f.ledger.list(reservation.childScope).length, 1);
  }
});
for (const sqlite of [false, true]) test(`${sqlite ? 'sqlite' : 'memory'}: child image references retain original user content indices and grant only selected image bytes`, async t => {
  const fixture = await setup(t, { sqlite, inputParts: mediaParts, childInput: ['text', 'image'],
    childArguments: { media: [{ source: 'parent_user_input', index: 3 }] } });
  await fixture.host.executeTurn(fixture.payload);
  const parent = fixture.ledger.sessionHead(fixture.scope, 'parent-session'), reservation = parent.childBudgetReservations[0];
  const child = fixture.ledger.load(reservation.childScope, reservation.childRunId);
  const media = [{ type: 'image_url', image_url: { url: `data:image/png;base64,${Buffer.from('selected-image').toString('base64')}` } }];
  assert.deepEqual(child.configuration.inputMessages, [{ role: 'user', kind: 'user_input', content: 'Read proof.txt', media }]);
  const requests = fixture.requests.filter(item => item.body.model === 'child-model');
  assert.equal(requests.length, 2);
  assert.ok(JSON.stringify(requests).includes(media[0].image_url.url));
  assert.equal(JSON.stringify(requests).includes(Buffer.from('unselected-image').toString('base64')), false);
  assert.equal(JSON.stringify(requests).includes('omitted-image'), false);
});
for (const [index, childInput] of [[0, ['image']], [1, ['image']], [99, ['image']], [3, ['text']]]) {
  test(`invalid child media reference or image-incapable model cannot launch work: ${index}/${childInput}`, async t => {
    const fixture = await setup(t, { inputParts: mediaParts, childInput,
      childArguments: { media: [{ source: 'parent_user_input', index }] } });
    await assert.rejects(fixture.host.executeTurn(fixture.payload), { code: 'NATIVE_TURN_FAILED' });
    assert.equal(fixture.childModels(), 0);
    assert.equal(fixture.ledger.list({ ...fixture.scope, agentId: `${fixture.scope.agentId}:child:reader` }).length, 0);
  });
}
