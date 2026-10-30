import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { canonical, MemoryRunStore, artifactToolDefinitions, todoToolDefinitions, coordinatorResponseDefinition } from '@kingsoftcloud/agentkit-harness-core';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { createStudioNativeHarness } from '../src/host/services/native-harness.mjs';
import { nativeOwnershipHost } from './fixtures/native-ownership-host.mjs';
import { createNativeDshTools } from '../src/providers/native-dsh-tools.mjs';
import { nativeChildRoles } from '../src/providers/native-subagents.mjs';
import { createAgentStore } from '../src/agent-store.mjs';
import { createModelService } from '../src/model-service.mjs';
import { createSessionRoutes } from '../src/host/routes/sessions.mjs';
import { readNativeRecoveryBinding } from '../src/providers/native-recovery-binding.mjs';
import { previousChildPublication } from '@kingsoftcloud/agentkit-harness-node/native/child-publication';
import { internalPeer, spec as a2aSpec } from './fixtures/native-a2a-internal-peer.mjs';
import { hasUnsafeChildReceipt } from '@kingsoftcloud/agentkit-harness-node/native/owned-child';
import { createNativeChildHistory } from '@kingsoftcloud/agentkit-harness-node/native/child-history';
import { createManagedNativeKernel } from '../src/providers/native-managed-kernel.mjs';
import { createStudioManagedNativeBinding } from '../src/host/services/native-managed-binding.mjs';
import { createStudioManagedNativeSessionControl } from '../src/host/services/native-managed-kernel.mjs';
import { managedNativeOwnerProjection, STUDIO_MANAGED_NATIVE_EXECUTION } from '../src/host/services/native-managed-execution.mjs';
import { command as managedCommand, permitIssuer } from './fixtures/native-managed-kernel.mjs';

async function setup(t, { sqlite = false, role = {}, forged = false, control = false, query = false, childArguments = {},
  goal = 'Use the bounded reader', childResult = 'Child read actual workspace evidence', parentResult = 'Parent delivery',
  inputParts, childInput = ['text'], childTool = 'native_start_child', beforeChildModel, onParentContinuation, parentPlan,
  childPlan, boundTools = ['read_workspace_file'], mcp, beforeToolDispatch, skills = false, a2a,
  managed = false, releasePending, toolSearch = false, filePreview = false, additionalRoles = [], governed = false, instructionOwnership = false } = {}) {
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
    modelProfileId: 'child-profile', maxTurns: 3, maxToolCalls: 2, ...role }, ...additionalRoles];
  const agents = createAgentStore({ storeDir: join(root, 'agents') });
  const record = await agents.create({ name: 'Parent', runtimeType: 'harness', spec: { subAgents: roles,
    ...(mcp && !toolSearch ? { execution: { nativeToolSearchMode: 'off' } } : {}),
    bindings: { modelProfileIds: ['parent-profile', 'child-profile', ...additionalRoles.map(role => role.modelProfileId)], tools: boundTools } } });
  const ledger = sqlite ? new SqliteRunStore(join(root, 'runs.sqlite')) : new MemoryRunStore();
  const events = [], registered = new Map(), projections = new Map(), dispatches = [], dispatchErrors = [], requests = [], guards = new Set(), dispatchGuards = new Set();
  const session = { id: 'parent-session', append(type, data, options) { events.push({ type, data, ...options, seq: events.length + 1 }); } };
  session.append('turn/start', { turn: 1 });
  const services = { sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }) }, sessions: { flush: async () => true }, llm: {},
    attachments: { readImageRequest: async ref => ({ mediaType: 'image/png', data: Buffer.from(ref.attachmentId) }) },
    sessionProjections: { register: definition => { projections.set(definition.key, definition); return () => projections.delete(definition.key); },
      stateOf: (_session, key) => { const projection = projections.get(key); return projection ? events.reduce(projection.apply, projection.init()) : undefined; } } };
  const ctx = { get: name => services[name], effect: install => install(), tools: {
    resultRetentions: ['caller/v1'],
    ...(governed ? {
      guard: callback => { guards.add(callback); return () => guards.delete(callback); },
      dispatchGuard: callback => { dispatchGuards.add(callback); return () => dispatchGuards.delete(callback); },
    } : {}),
    register: definition => { registered.set(definition.name, definition); return () => registered.delete(definition.name); },
    execute: async request => {
      dispatches.push({ name: request.name, callId: request.callId, agent: request.agent });
      for (const guard of guards) { const reason = guard(request); if (reason) throw Error(reason); }
      await beforeToolDispatch?.(request);
      for (const guard of dispatchGuards) { const reason = guard(request); if (reason) throw Error(reason); }
      const definition = registered.get(request.name); let value;
      try { value = await definition.execute(request.arguments, request); }
      catch (error) { dispatchErrors.push(error); throw error; }
      return { isError: false, content: definition.output.render(request.arguments, value) };
    },
  } };
  if (instructionOwnership) {
    let directory = realpathSync(workspaceRoot);
    services.workingDirectory = { get: () => directory, set: async (_agent, value) => { directory = value; }, ensure: async () => directory };
  }
  const gateway = createNativeDshTools({ ctx, config: { agentId: record.metadata.id, subAgents: roles, toolBindings: boundTools,
    ...(governed ? { nativeEngineContract: 'agentkit.native-dsh-turn/v1' } : {}),
    toolContracts: mcp?.contracts, skillDefinitions, ...(a2a ? { a2aBindings: [a2aSpec] } : {}) }, workspaceRoot,
    ...(instructionOwnership ? { instructionRoots: [] } : {}),
    ...(a2a ? { commandEnvironment: a2a.env } : {}), stateDir: join(root, 'tools'), executeMcpTool: mcp?.execute });
  a2a?.setRecordDirectory(join(root, 'tools/a2a-calls'));
  const values = { modelProfiles: [{ id: 'parent-profile', provider: 'openai-compatible', modelName: 'parent-model', baseUrl: 'https://parent.invalid/v1' },
    { id: 'child-profile', provider: 'openai-compatible', modelName: 'child-model', baseUrl: 'https://child.invalid/v1', input: childInput },
    ...additionalRoles.map(role => ({ id: role.modelProfileId, provider: 'openai-compatible', modelName: `${role.modelProfileId}-model`,
      baseUrl: `https://${role.modelProfileId}.invalid/v1`, input: childInput }))] };
  const models = createModelService({ configuration: { resolve: async () => ({ values }) }, credentials: { resolve: async () => ({ value: 'fixture-secret' }) } });
  let parentModels = 0, childModels = 0;
  const hostOptions = { ctx, storeDir: root, workspaceRoot, agents, models, ledger,
    ...((managed || a2a || filePreview) ? { agentEvents: () => ({ serial: async () => payload.binding }) } : {}),
    ...(managed ? { assembleContextFor: () => ({ agent: payload.agent }) } : {}),
    renderPrompt: () => 'Delegate a bounded read; use its evidence without treating it as parent acceptance.',
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body); requests.push({ url, body });
      const child = body.model !== 'parent-model';
      let call, text;
      if (child) {
        childModels++;
        await beforeChildModel?.(childModels, body);
        const childProfile = values.modelProfiles.find(profile => profile.modelName === body.model);
        assert.equal(url, childProfile.baseUrl + '/chat/completions');
        const childRole = roles.find(role => role.modelProfileId === childProfile.id);
        const expectedTools = [...childRole.tools, ...(childRole.inheritMcp && mcp ? toolSearch
          && !mcp.contracts.some(tool => ['ToolSearch', 'DeferredToolCall'].includes(tool.name))
          ? ['ToolSearch', 'DeferredToolCall'] : mcp.contracts.map(item => item.name).sort() : []),
          ...(childRole.inheritSkills !== false && skills ? gateway.childSkillBinding.toolNames : []),
          ...(childRole.inheritMcp && mcp && toolSearch && !mcp.contracts.some(tool => ['ToolSearch', 'DeferredToolCall'].includes(tool.name))
            ? [] : [...todoToolDefinitions().map(tool => tool.name), coordinatorResponseDefinition().name]),
          ...artifactToolDefinitions().map(tool => tool.name)];
        // A successful search can now expose loaded schemas directly. Derive
        // the additional names from committed search results, not the offer itself.
        const loaded = body.messages.filter(message => message.role === 'tool').flatMap(message => {
          try { return (JSON.parse(message.content).definitions ?? []).filter(item => item.call === 'direct').map(item => item.name); }
          catch { return []; }
        });
        const offeredTools = body.tools ?? [];
        assert.deepEqual(offeredTools.map(item => item.function.name).filter(name => name !== 'submit_final_output').sort(),
          childModels > 1 && !offeredTools.length ? [] : [...new Set([...expectedTools, ...loaded])].sort());
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
        const definition = body.tools.find(item => item.function.name === 'submit_final_output').function.parameters;
        // The fake provider must answer the actual advertised final protocol.
        // Plain parent text is not JSON merely because final delivery is a tool.
        const answer = definition.properties?.answer;
        call = { name: 'submit_final_output', arguments: answer
          ? { answer: answer.type === 'object' ? answer.properties?.output ? { output: JSON.parse(text) } : JSON.parse(text) : text,
            artifacts: [] } : { output: JSON.parse(text) } }; text = undefined;
      }
      if (call && ['native_start_child', 'native_delegate'].includes(call.name)
        && body.tools?.some(item => item.function.name === call.name && item.function.parameters.properties.required_tools))
        call.arguments = { required_tools: [], ...call.arguments };
      const delta = call ? { tool_calls: [{ index: 0, id: `call-${requests.length}`, type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] } : { content: text };
      return new Response(`data: ${JSON.stringify({ id: `r-${requests.length}`, choices: [{ index: 0, delta,
        finish_reason: call ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 3 } })}\n\ndata: [DONE]\n\n`,
      { headers: { 'content-type': 'text/event-stream' } });
    } };
  let host = await createStudioNativeHarness(hostOptions);
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
  if (filePreview) services.sessionController = { resolveAgent: async id => {
    assert.equal(id, session.id); return { agent: payload.agent };
  } };
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
  return { root, workspaceRoot, get host() { return host; }, payload, ledger, gateway, roles, requests, dispatches, dispatchErrors, record, scope, services, ctx, events,
    async reopenHost() { await host.close(); host = await createStudioNativeHarness(hostOptions); },
    modelValues: values, childModels: () => childModels,
    get managedLedger() { return managedLedger; }, get receiver() { return receiver; },
    managedScope: managed ? { ...scope, tenantId: target.tenantId, userId: principal.userId } : undefined,
    async admitManaged() {
      const command = managedCommand({ tenant_id: target.tenantId, agent_instance_id: target.agentInstanceId,
        session_id: session.id, payload: { content: goal } });
      return receiver.receive(command, issuer.issue(command));
    },
    async controlManaged(kind, runId) {
      const command = managedCommand({ tenant_id: target.tenantId, agent_instance_id: target.agentInstanceId,
        session_id: session.id, command_type: kind,
        payload: kind === 'resume' ? { target: { kind: 'run', id: runId } } : { run_id: runId } });
      return receiver.receive(command, issuer.issue(command));
    },
    async reopenManaged() { await receiver.close(); managedLedger.close(); openManaged(); } };
}

test('cold Studio child continuation refreshes inherited scoped rule addresses without importing old file bodies', async t => {
  let source;
  const f = await setup(t, { sqlite: true, governed: true, instructionOwnership: true, childTool: 'native_delegate',
    parentPlan: async (_body, index) => index === 1 || index === 3 ? { call: { name: 'native_delegate', arguments: {
      role: 'reader', task: index === 1 ? 'Read pkg/file.ts' : 'Report current workspace guidance',
      ...(index === 3 ? { continuation_of: source } : {}) } } } : { text: 'Child findings collected.' },
    childPlan: async (body, index) => {
      const wire = JSON.stringify(body.messages);
      assert.match(wire, /CHILD_ROOT_CURRENT_c124/);
      if (index === 1) {
        assert.doesNotMatch(wire, /CHILD_NESTED_OLD_c124|CHILD_NESTED_NEW_c124/);
        return { call: { name: 'read_workspace_file', arguments: { path: 'pkg/file.ts' } } };
      }
      assert.match(wire, index === 2 ? /CHILD_NESTED_OLD_c124/ : /CHILD_NESTED_NEW_c124/);
      if (index === 3) assert.doesNotMatch(wire, /CHILD_NESTED_OLD_c124/);
      return { text: 'Current rule snapshot observed.' };
    } });
  await mkdir(join(f.workspaceRoot, 'pkg'));
  await writeFile(join(f.workspaceRoot, 'AGENTS.md'), 'CHILD_ROOT_CURRENT_c124');
  await writeFile(join(f.workspaceRoot, 'pkg/AGENTS.md'), 'CHILD_NESTED_OLD_c124');
  await writeFile(join(f.workspaceRoot, 'pkg/file.ts'), 'export const value = 1;');
  await f.host.executeTurn(f.payload);
  const first = f.ledger.sessionHead(f.scope, 'parent-session'), reservation = first.childBudgetReservations[0];
  source = reservation.childRunId;
  const original = f.ledger.load(reservation.childScope, source);
  assert.equal(original.snapshot.phase, 'completed'); assert.equal(f.childModels(), 2);
  assert.deepEqual(original.snapshot.context.instructionScopes.directories, ['', 'pkg']);
  assert.doesNotMatch(canonical(original.snapshot.messages), /CHILD_NESTED_OLD_c124|CHILD_ROOT_CURRENT_c124/);
  await f.reopenHost();
  await writeFile(join(f.workspaceRoot, 'pkg/AGENTS.md'), 'CHILD_NESTED_NEW_c124');
  f.payload.agent.session.append('turn/start', { turn: 2 });
  await f.host.executeTurn({ ...f.payload, turn: 2, input: { ...f.payload.input, messages: [{ id: 'continue-rules', role: 'user',
    source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue the original child.' }] }] } });
  assert.equal(f.childModels(), 3);
  const nextParent = f.ledger.sessionHead(f.scope, 'parent-session');
  const next = f.ledger.load(reservation.childScope, nextParent.childRunIds[0]);
  assert.equal(next.snapshot.phase, 'completed'); assert.equal(next.snapshot.parentRunId, source);
  assert.deepEqual(next.configuration.hostRecoveryBinding.workspaceContext, original.configuration.hostRecoveryBinding.workspaceContext);
  assert.deepEqual(f.ledger.load(reservation.childScope, source), original);
});

test('a real reader child does not acquire its command-enabled parent resource capability', async t => {
  const f = await setup(t, { sqlite: true, boundTools: ['read_workspace_file', 'run_command'],
    childArguments: { background: false } });
  let bound;
  const original = f.gateway.forChild;
  f.gateway.forChild = function(agent, authority) { bound = authority.localExecution; return original.call(this, agent, authority); };
  await f.host.executeTurn(f.payload);
  assert.ok(bound, 'the child tool owner receives the frozen Host policy without granting extra tools');
  assert.equal(bound.resourceProfile, 'local-development/v1');
  // The child owner stores a narrower scope; use its parent-owned lineage ref.
  const parent = f.ledger.load(f.scope, f.ledger.sessionHead(f.scope, f.payload.agent.session.id).runId);
  const reservation = parent.snapshot.childBudgetReservations[0]; assert.ok(reservation);
  const stored = f.ledger.load(reservation.childScope, reservation.childRunId);
  assert.equal(parent.configuration.modelSurface.environment.commandResources.requestedLimits.maxFileBytes, bound.settings.maxFileBytes);
  assert.equal(stored.configuration.modelSurface.environment.commandResources, undefined);
  assert.equal(stored.configuration.modelSurface.environment.commandBackend, 'none');
  assert.equal(stored.configuration.tools.some(tool => tool.name === 'run_command'), false);
  const result = stored.events.find(event => event.kind === 'tool.completed' && event.payload.name === 'read_workspace_file');
  assert.ok(result); assert.equal(result.payload.status, 'ok');
  assert.match(canonical(result.payload.content), /Actual child evidence/);
});

test('an explicitly granted child command uses its own workspace, change capture and frozen execution resource', { timeout: 30000 }, async t => {
  const f = await setup(t, { sqlite: true, childTool: 'native_delegate', governed: true,
    boundTools: ['read_workspace_file', 'run_command'],
    role: { tools: ['run_command'], maxTurns: 3, maxToolCalls: 2, timeoutSeconds: 120 },
    childPlan: async (body, index) => {
      if (index === 1) return { call: { name: 'run_command', arguments: {
        command: "printf 'Child command bytes' > proof.txt; printf 'Created by child' > child-created.txt; pwd" } } };
      const result = JSON.parse(body.messages.findLast(message => message.role === 'tool').content);
      assert.equal(result.exit_code, 0);
      assert.match(result.stdout, /child-workspaces\/.+\/work/);
      return { text: 'The child command changed its own copy.' };
    } });
  let bindingFailure;
  const bind = f.gateway.forChild.bind(f.gateway);
  f.gateway.forChild = (agent, authority) => {
    assert.throws(() => bind(agent, { ...authority, workspaceRoot: f.workspaceRoot }), /child_workspace_binding_changed/);
    assert.throws(() => bind(agent, { ...authority, executionResource: { ...authority.executionResource, bindingDigest: '0'.repeat(64) } }), /child_command_resource_changed/);
    try { return bind(agent, authority); } catch (error) { bindingFailure = error; throw error; }
  };
  try { await f.host.executeTurn(f.payload); } catch (error) { throw bindingFailure ?? f.dispatchErrors.at(-1) ?? error; }
  const parent = f.ledger.sessionHead(f.scope, 'parent-session'), reservation = parent.childBudgetReservations[0];
  assert.ok(reservation);
  const child = f.ledger.load(reservation.childScope, reservation.childRunId);
  assert.equal(child.snapshot.phase, 'completed');
  const binding = child.configuration.hostRecoveryBinding.childWorkspace;
  const resource = child.configuration.hostRecoveryBinding.childExecutionResource;
  assert.equal(resource.contract, 'agentkit.child-local-command-resource/v1');
  assert.equal(resource.workspaceBindingDigest, createHash('sha256').update(canonical(binding)).digest('hex'));
  assert.equal(child.configuration.backgroundNotificationPolicy, 'completed-before-model/v1');
  assert.ok(child.configuration.limits.effectTimeoutMs > child.configuration.tools.find(tool => tool.name === 'run_command').timeoutMs);
  assert.equal(child.configuration.limits.maxWallMs, 120000, 'tool admission does not enlarge the role wall budget');
  const root = join(f.root, 'native-harness', 'child-workspaces', binding.isolationId, 'work');
  assert.equal(child.configuration.modelSurface.environment.cwd, root);
  assert.equal(child.configuration.modelSurface.environment.commandCwd, root);
  assert.equal(child.configuration.modelSurface.environment.commandBackend, 'local_process');
  assert.equal(await readFile(join(root, 'proof.txt'), 'utf8'), 'Child command bytes');
  assert.equal(await readFile(join(root, 'child-created.txt'), 'utf8'), 'Created by child');
  assert.equal(await readFile(join(f.workspaceRoot, 'proof.txt'), 'utf8'), 'Actual child evidence');
  await assert.rejects(readFile(join(f.workspaceRoot, 'child-created.txt')), { code: 'ENOENT' });
  assert.deepEqual(child.snapshot.workspaceModifiedPaths.sort(), ['child-created.txt', 'proof.txt']);
  assert.equal(f.dispatches.filter(row => row.name === 'run_command').length, 1);
});

test('child background commands retain child-owned handles and collect output through the same resource', { timeout: 30000 }, async t => {
  const f = await setup(t, { sqlite: true, childTool: 'native_delegate', governed: true,
    boundTools: ['run_command', 'read_command_output'],
    role: { tools: ['run_command', 'read_command_output'], maxTurns: 4, maxToolCalls: 3 },
    childPlan: async (body, index) => {
      if (index === 1) return { call: { name: 'run_command', arguments: {
        command: "sleep 0.05; printf 'Child background output'", background: true } } };
      const launches = body.messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content));
      const launch = launches.find(result => result.task_id);
      assert.ok(launch?.task_id);
      if (index === 2) return { call: { name: 'read_command_output', arguments: { task_id: launch.task_id, wait_seconds: 1 } } };
      assert.ok(launches.some(result => result.stdout?.includes('Child background output')));
      return { text: 'Collected the existing child command output.' };
    } });
  await f.host.executeTurn(f.payload);
  const reservation = f.ledger.sessionHead(f.scope, 'parent-session').childBudgetReservations[0];
  const child = f.ledger.load(reservation.childScope, reservation.childRunId);
  assert.equal(child.snapshot.phase, 'completed'); assert.equal(child.snapshot.backgroundCommands.length, 1);
  assert.equal(child.snapshot.backgroundCommands[0].ref.sourceRunId, child.snapshot.runId);
  assert.equal(child.snapshot.backgroundCommands[0].notified, true);
  assert.equal(f.dispatches.filter(row => row.name === 'run_command').length, 1, 'collecting never relaunches a job');
});

test('parallel-safe roles cannot acquire a mutable command resource', async t => {
  const f = await setup(t, { boundTools: ['run_command'], role: { tools: ['run_command'], concurrentSafe: true } });
  await assert.rejects(f.host.executeTurn(f.payload), /child_command_resource_unavailable/);
  assert.equal(f.requests.length, 0); assert.equal(f.dispatches.length, 0);
});

test('a child command reader cannot borrow its parent command handle', { timeout: 30000 }, async t => {
  let parentTask;
  const f = await setup(t, { sqlite: true, governed: true, childTool: 'native_delegate',
    boundTools: ['run_command', 'read_command_output'], role: { tools: ['read_command_output'] },
    parentPlan: async (body, index) => {
      if (index === 1) return { call: { name: 'run_command', arguments: { command: "printf 'Parent private output'", background: true } } };
      if (index === 2) {
        parentTask = JSON.parse(body.messages.findLast(message => message.role === 'tool').content).task_id;
        assert.ok(parentTask);
        return { call: { name: 'native_delegate', arguments: { role: 'reader', task: 'Inspect your own command inventory' } } };
      }
      return { text: 'Child cannot read the parent-owned handle.' };
    },
    childPlan: async (body, index) => {
      if (index === 1) return { call: { name: 'read_command_output', arguments: { task_id: parentTask } } };
      const result = body.messages.findLast(message => message.role === 'tool').content;
      assert.match(result, /background_command_not_owned/); assert.doesNotMatch(result, /Parent private output/);
      return { text: 'No child-owned command output exists.' };
    } });
  await f.host.executeTurn(f.payload);
  assert.equal(f.dispatches.filter(row => row.name === 'run_command').length, 1);
  const parent = f.ledger.sessionHead(f.scope, 'parent-session');
  assert.equal(parent.phase, 'completed');
  const reservation = parent.childBudgetReservations[0], child = f.ledger.load(reservation.childScope, reservation.childRunId);
  assert.equal(child.snapshot.backgroundCommands.length, 0);
});

test('a cold Native Host owner continues child commands in the original workspace without replaying committed commands', { timeout: 30000 }, async t => {
  let source;
  const f = await setup(t, { sqlite: true, governed: true, childTool: 'native_delegate',
    boundTools: ['run_command'], role: { tools: ['run_command'], maxTurns: 3, maxToolCalls: 2 },
    parentPlan: async (_body, index) => index === 1 || index === 3 ? { call: { name: 'native_delegate', arguments: {
      role: 'reader', task: index === 1 ? 'Create a child-owned file' : 'Read your original file',
      ...(index === 3 ? { continuation_of: source } : {}) } } } : { text: 'Child command collected.' },
    childPlan: async (body, index) => {
      if (index === 1) return { call: { name: 'run_command', arguments: { command: "printf 'once\\n' >> child-command.txt" } } };
      if (index === 3) return { call: { name: 'run_command', arguments: { command: 'cat child-command.txt' } } };
      if (index === 4) assert.match(body.messages.findLast(message => message.role === 'tool').content, /once/);
      return { text: 'Child command evidence.' };
    } });
  await f.host.executeTurn(f.payload);
  const firstParent = f.ledger.sessionHead(f.scope, 'parent-session'), reservation = firstParent.childBudgetReservations[0];
  source = reservation.childRunId;
  const original = f.ledger.load(reservation.childScope, source);
  await f.reopenHost();
  f.payload.agent.session.append('turn/start', { turn: 2 });
  await f.host.executeTurn({ ...f.payload, turn: 2, input: { ...f.payload.input, messages: [{ id: 'continue-command', role: 'user',
    source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue the original child command evidence.' }] }] } });
  const nextParent = f.ledger.sessionHead(f.scope, 'parent-session');
  const next = f.ledger.load(reservation.childScope, nextParent.childRunIds[0]);
  assert.equal(next.snapshot.parentRunId, source); assert.equal(next.snapshot.sessionId, original.snapshot.sessionId);
  assert.deepEqual(next.configuration.hostRecoveryBinding, original.configuration.hostRecoveryBinding);
  assert.deepEqual(f.ledger.load(reservation.childScope, source), original);
  const binding = original.configuration.hostRecoveryBinding.childWorkspace;
  assert.equal(await readFile(join(f.root, 'native-harness', 'child-workspaces', binding.isolationId, 'work', 'child-command.txt'), 'utf8'), 'once\n');
  await assert.rejects(readFile(join(f.workspaceRoot, 'child-command.txt')), { code: 'ENOENT' });
  assert.equal(f.dispatches.filter(row => row.name === 'run_command').length, 2);
});

const childMcpContract = { name: 'remote_lookup', executor: 'mcp', mcpResourceId: 'bound-catalog',
  parameters: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'], additionalProperties: false } };

test('actual Studio gateway refuses a child capability mismatch before creating a child Run', async t => {
  const f = await setup(t, { sqlite: true, childArguments: { required_tools: ['web_search'] } });
  await f.host.executeTurn(f.payload);
  const parent = f.ledger.list(f.scope, 'parent-session')[0];
  assert.equal(parent.phase, 'completed'); assert.equal(f.childModels(), 0);
  assert.deepEqual(parent.childBudgetReservations, []); assert.deepEqual(parent.childRunIds, []);
  const record = f.ledger.load(f.scope, parent.runId);
  assert.equal(record.configuration.childCapabilityPolicy, 'required-tools/v1');
  const definition = record.configuration.tools.find(tool => tool.name === 'native_start_child');
  assert.ok(definition.parameters.required.includes('required_tools'));
  assert.match(definition.description, /read_workspace_file/);
  assert.ok(record.receipts.some(receipt => receipt.result.results?.some(result =>
    result.status === 'error' && result.content?.code === 'child_capability_unavailable' && result.content.executed === false)));
});

function enableParentPlan(f) {
  f.payload.input.assembly.sections = [];
  f.services.sessionProjections.register({ key: 'plan', init: () => ({ active: true }),
    apply: (state, event) => event.type === 'plan/mode' ? { active: event.data.active } : state });
  f.services.planMode = { get: () => ({ active: true }) };
}

for (const childTool of ['native_start_child', 'native_delegate']) test(`Studio Plan ${childTool}: inherited child permissions block isolated writes and retain reporting`, async t => {
  const f = await setup(t, { sqlite: true, childTool, boundTools: ['read_workspace_file', 'write_workspace_file'],
    role: { tools: ['read_workspace_file', 'write_workspace_file'], maxTurns: 5, maxToolCalls: 4 },
    childPlan: (body, index) => {
      assert.match(JSON.stringify(body.messages), /inherited active Plan mode/);
      if (index === 1) return { call: { name: 'write_workspace_file', arguments: { path: 'forbidden.txt', content: 'Must not write' } } };
      if (index === 2) {
        assert.match(body.messages.filter(message => message.role === 'tool').at(-1).content, /plan_mode_write_denied/);
        return { call: { name: 'read_workspace_file', arguments: { path: 'proof.txt' } } };
      }
      if (index === 3) return { call: { name: 'RespondToCoordinator', arguments: { summary: 'Explored', message: 'Write stayed forbidden in the child.' } } };
      return { text: 'Read-only child findings' };
    } });
  enableParentPlan(f);
  const execution = await f.host.executeTurn(f.payload); assert.equal(execution.reason.kind, 'completed', JSON.stringify(execution));
  const parent = f.ledger.list(f.scope, 'parent-session')[0], reservation = parent.childBudgetReservations[0];
  const child = f.ledger.load(reservation.childScope, reservation.childRunId);
  assert.equal(parent.planMode.active, true); assert.equal(child.snapshot.planMode.active, true);
  assert.equal(child.configuration.childOwnerBinding.planMode, true);
  assert.equal(f.ledger.load(f.scope, parent.runId).configuration.childPlanPolicy, 'inherit-plan/v1');
  assert.equal(child.configuration.planModePolicy, 'inherited-child-plan/v1');
  assert.deepEqual(child.snapshot.workspaceModifiedPaths, []);
  assert.equal(f.dispatches.some(item => item.name === 'write_workspace_file'), false);
  assert.equal(f.dispatches.filter(item => item.name === 'read_workspace_file').length, 1);
  assert.equal(parent.messages.filter(message => message.kind === 'child_response').length, 1);
  assert.equal(child.configuration.tools.some(tool => ['EnterPlanMode', 'ExitPlanMode'].includes(tool.name)), false);
});

for (const destructive of [false, true]) test(`Studio child Plan keeps frozen MCP destructive=${destructive} permission distinct from replay`, async t => {
  let effects = 0;
  const f = await setup(t, { sqlite: true, childTool: 'native_delegate', boundTools: [], role: { tools: [], inheritMcp: true },
    mcp: { contracts: [{ ...childMcpContract, nativeMcpPlanAccess: { contract: 'zcode-mcp-plan/v1', destructive } }],
      execute: async input => { input.assertCurrent(); effects++; return { content: [{ type: 'text', text: 'Actual child MCP reply' }] }; } },
    childPlan: (body, index) => {
      if (index === 1) return { call: { name: 'remote_lookup', arguments: { id: 1 } } };
      assert.match(body.messages.filter(message => message.role === 'tool').at(-1).content,
        destructive ? /plan_mode_write_denied/ : /Actual child MCP reply/);
      return { text: 'Child permission result' };
    } });
  enableParentPlan(f); assert.equal((await f.host.executeTurn(f.payload)).reason.kind, 'completed');
  assert.equal(effects, destructive ? 0 : 1);
  const parent = f.ledger.list(f.scope, 'parent-session')[0], reservation = parent.childBudgetReservations[0];
  const definition = f.ledger.load(reservation.childScope, reservation.childRunId).configuration.tools.find(tool => tool.name === 'remote_lookup');
  assert.deepEqual(definition.planModeAccess, { contract: 'zcode-mcp-plan/v1', destructive });
  assert.equal(definition.readOnly, false); assert.equal(definition.concurrentSafe, false);
});

for (const childTool of ['native_start_child', 'native_delegate']) test(`Studio ${childTool}: child Todo and coordinator reply stay on the owned execution chain`, async t => {
  const f = await setup(t, { sqlite: true, childTool, role: { maxTurns: 5, maxToolCalls: 4 },
    childPlan: (_body, index) => {
      if (index === 1) return { call: { name: 'TodoWrite', arguments: { todos: [{ content: 'Child-local inspection', status: 'in_progress', priority: 'high' }] } } };
      if (index === 2) return { call: { name: 'RespondToCoordinator', arguments: { summary: 'Inspecting', message: 'Child work continues after this progress report.' } } };
      if (index === 3) return { call: { name: 'read_workspace_file', arguments: { path: 'proof.txt' } } };
      return { text: 'Final inspected workspace evidence' };
    } });
  const bind = f.gateway.forChild.bind(f.gateway);
  f.gateway.forChild = (agent, authority) => {
    assert.deepEqual(authority.toolNames, ['read_workspace_file']); return bind(agent, authority);
  };
  const execution = await f.host.executeTurn(f.payload);
  assert.equal(execution.reason.kind, 'completed', JSON.stringify({ execution, parents: f.ledger.list(f.scope, 'parent-session') }));
  const parent = f.ledger.list(f.scope, 'parent-session')[0], reservation = parent.childBudgetReservations[0];
  const child = f.ledger.load(reservation.childScope, reservation.childRunId);
  assert.equal(f.ledger.load(f.scope, parent.runId).configuration.childTaskPolicy, 'session-controls/v1');
  assert.equal(child.configuration.coordinatorResponsePolicy, 'owned-parent-response/v1');
  assert.equal(child.snapshot.todos.items[0].content, 'Child-local inspection'); assert.deepEqual(parent.todos?.items ?? [], []);
  assert.equal(child.snapshot.phase, 'completed'); assert.equal(f.childModels(), 4);
  assert.equal(child.configuration.tools.some(tool => ['EnterPlanMode', 'ExitPlanMode'].includes(tool.name)), false);
  assert.equal(child.events.filter(event => event.kind === 'coordinator.response_queued').length, 1);
  assert.equal(parent.messages.filter(message => message.kind === 'child_response').length, 1);
  assert.match(parent.messages.find(message => message.kind === 'child_response').content, /continues after/);
  assert.equal(f.dispatches.some(item => ['TodoRead', 'TodoWrite', 'RespondToCoordinator'].includes(item.name)), false);
  const reopened = new SqliteRunStore(join(f.root, 'runs.sqlite'));
  try { assert.deepEqual(reopened.load(f.scope, parent.runId).snapshot.childResponseCursors, parent.childResponseCursors); }
  finally { reopened.close(); }
});

test('Studio deferred child controls resolve to its own Todo and durable parent response, without gateway authority', async t => {
  const f = await setup(t, { sqlite: true, toolSearch: true, childTool: 'native_delegate', boundTools: [],
    role: { tools: [], inheritMcp: true, maxTurns: 5, maxToolCalls: 4 },
    mcp: { contracts: [childMcpContract], execute: async () => assert.fail('MCP not needed for child-local controls') },
    childPlan: (_body, index) => {
      if (index === 1) return { call: { name: 'ToolSearch', arguments: { query: 'select:TodoWrite,RespondToCoordinator' } } };
      if (index === 2) return { call: { name: 'DeferredToolCall', arguments: { name: 'TodoWrite', input: { todos: [] } } } };
      if (index === 3) return { call: { name: 'DeferredToolCall', arguments: { name: 'RespondToCoordinator', input: { summary: 'Ready', message: 'Progress report via deferred control' } } } };
      return { text: 'Final deferred-control delivery' };
    } });
  assert.equal((await f.host.executeTurn(f.payload)).reason.kind, 'completed');
  const parent = f.ledger.list(f.scope, 'parent-session')[0], reservation = parent.childBudgetReservations[0];
  const child = f.ledger.load(reservation.childScope, reservation.childRunId);
  assert.equal(child.snapshot.todos.revision, 1); assert.equal(parent.messages.filter(message => message.kind === 'child_response').length, 1);
  assert.equal(child.events.filter(event => event.kind === 'coordinator.response_queued').length, 1);
  assert.equal(f.dispatches.some(item => ['TodoRead', 'TodoWrite', 'RespondToCoordinator', 'ToolSearch', 'DeferredToolCall', 'remote_lookup'].includes(item.name)), false);
});

test('shared Host child captures its complete source with an independently bound page budget and scoped reference', async t => {
  let childUri;
  const f = await setup(t, { sqlite: true, childTool: 'native_delegate', childPlan: (body, index) => {
    if (index === 1) return { call: { name: 'read_workspace_file', arguments: { path: 'proof.txt', max_chars: 1000 } } };
    const view = JSON.parse(body.messages.filter(message => message.role === 'tool').at(-1).content);
    assert.equal(view.artifact_state, 'available'); assert.ok(view.content.line_count > 0);
    assert.ok(view.content.end_line < 50); assert.equal(view.content.requested_source, undefined);
    childUri = view.artifact_uri; return { text: 'Child inspected its bounded source page.' };
  } });
  const text = Array.from({ length: 50 }, (_, i) => `row-${i + 1} ${'中文😀'.repeat(20)}`).join('\n');
  await writeFile(join(f.workspaceRoot, 'proof.txt'), text);
  await f.host.executeTurn(f.payload);
  const childScope = { ...f.scope, agentId: `${f.scope.agentId}:child:reader` }, child = f.ledger.list(childScope)[0];
  const record = f.ledger.load(childScope, child.runId);
  assert.equal(child.phase, 'completed'); assert.equal(record.configuration.sourceReadPolicy, 'studio-source-read/v1');
  const readTool = record.configuration.tools.find(tool => tool.name === 'read_workspace_file');
  assert.equal(readTool.sourceObservationPolicy, 'workspace-source-model/v1'); assert.equal(readTool.resultArchivePolicy, 'archived-model-view/v5');
  const receipt = record.receipts.find(receipt => receipt.result.results?.some(result => result.content.requested_source));
  assert.ok(receipt); const captured = receipt.result.results.find(result => result.content.requested_source);
  assert.equal(captured.content.requested_source.content, text.split('\n').map((line, i) => `${i + 1} | ${line}`).join('\n'));
  assert.equal(captured.artifactRefs[0].uri, childUri);
  const parent = f.ledger.load(f.scope, f.ledger.sessionHead(f.scope, 'parent-session').runId);
  assert.ok(!parent.snapshot.artifactRefs.some(ref => ref.uri === childUri));
  const reopened = new SqliteRunStore(join(f.root, 'runs.sqlite'));
  try { assert.deepEqual(reopened.load(childScope, child.runId).configuration, record.configuration); }
  finally { reopened.close(); }
});

for (const firstManaged of [false, true]) test(`mixed history: alternating ${firstManaged ? 'managed' : 'ordinary'} first roots preserve both owners, paging and cold results`, { timeout: 30000 }, async t => {
  const f = await setup(t, { sqlite: true, managed: true,
    parentPlan: (_body, index) => index % 2 ? { call: { name: 'native_delegate', arguments: { role: 'reader', task: `Read ${index}` } } }
      : { text: `Parent ${index}` },
    childPlan: (_body, index) => index % 2 ? { call: { name: 'read_workspace_file', arguments: { path: 'proof.txt' } } }
      : { text: `子任务😀 evidence ${index}` } });
  const route = createSessionRoutes({ getNativeHost: async () => f.host });
  const identity = { agentId: f.record.metadata.id, sessionId: 'parent-session' }, expected = [], records = [];
  let previous;
  for (let turn = 1; turn <= 5; turn++) {
    const managed = (turn % 2 === 1) === firstManaged;
    if (turn > 1) f.payload.agent.session.append('turn/start', { turn });
    if (managed) { await f.admitManaged(); await f.receiver.drain(identity.sessionId); }
    else await f.host.executeTurn({ ...f.payload, turn });
    const store = managed ? f.managedLedger : f.ledger, scope = managed ? f.managedScope : f.scope;
    const parent = store.load(scope, store.sessionHead(scope, identity.sessionId).runId);
    const childRunId = parent.snapshot.childRunIds[0]; assert.ok(childRunId);
    expected.push({ parentRunId: parent.snapshot.runId, childRunId, text: `子任务😀 evidence ${turn * 2}` });
    records.push({ managed, parent });
    const counts = { models: f.requests.length, tools: f.dispatches.length };
    const history = (await route('sessions/native-child-history', { ...identity, limit: 2 })).value;
    assert.equal(history.runId, parent.snapshot.runId); assert.equal(history.totalTasks, turn);
    const tasks = [...history.tasks]; let page = history;
    while (!page.complete) { page = (await route('sessions/native-child-history', { ...identity, offset: page.nextOffset,
      limit: 2, inventoryDigest: history.inventoryDigest })).value; tasks.push(...page.tasks); }
    assert.deepEqual(tasks.map(task => task.childRunId).sort(), expected.map(task => task.childRunId).sort());
    assert.ok(tasks.every(task => !task.canCancel && !task.canSendInput && !task.canPromote && task.usageIncludedInParent));
    for (const task of expected) {
      const explicit = (await route('sessions/native-child-result', { ...identity, runId: task.parentRunId, childRunId: task.childRunId })).value;
      assert.equal(explicit.runId, task.parentRunId); assert.equal(explicit.text, task.text);
      const current = (await route('sessions/native-child-result', { ...identity, childRunId: task.childRunId, offset: 2, limit: 3 })).value;
      assert.equal(current.runId, history.runId); assert.equal(current.task.parentRunId, task.parentRunId);
      assert.equal(current.text, [...task.text].slice(2, 5).join(''));
    }
    if (previous) await assert.rejects(route('sessions/native-child-history', { ...identity, offset: 1,
      inventoryDigest: previous.inventoryDigest }), /inventory_changed/);
    previous = history;
    assert.deepEqual({ models: f.requests.length, tools: f.dispatches.length }, counts);
  }
  const before = (await route('sessions/native-child-history', identity)).value;
  const counts = { models: f.requests.length, tools: f.dispatches.length };
  await f.reopenManaged();
  assert.deepEqual((await route('sessions/native-child-history', identity)).value, before);
  for (const task of expected) assert.equal((await route('sessions/native-child-result', { ...identity,
    runId: task.parentRunId, childRunId: task.childRunId })).value.text, task.text);
  for (const { managed, parent } of records) assert.deepEqual((managed ? f.managedLedger : f.ledger)
    .load(parent.snapshot.scope, parent.snapshot.runId), parent);
  await assert.rejects(route('sessions/native-child-result', { ...identity, childRunId: 'foreign' }), /result_unavailable/);
  await assert.rejects(route('sessions/native-child-history', { ...identity, sessionId: 'other', runId: expected[0].parentRunId }), /IDENTITY_MISMATCH|run_unavailable/);
  assert.deepEqual({ models: f.requests.length, tools: f.dispatches.length }, counts);
});

for (const firstManaged of [false, true]) test(`mixed history: ${firstManaged ? 'ordinary' : 'managed'} live owner alone exposes controls while historical results remain readable`, { timeout: 20000 }, async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const f = await setup(t, { sqlite: true, managed: true, releasePending: () => release.resolve(),
    beforeChildModel: async index => { if (index === 3) { entered.resolve(); await release.promise; } },
    parentPlan: (_body, index) => index % 2 ? { call: { name: 'native_delegate', arguments: { role: 'reader', task: `Read ${index}` } } }
      : { text: `Parent ${index}` },
    childPlan: (_body, index) => [1, 3].includes(index) ? { call: { name: 'read_workspace_file', arguments: { path: 'proof.txt' } } }
      : { text: index < 3 ? 'Child 2' : 'Child 4' } });
  const route = createSessionRoutes({ getNativeHost: async () => f.host }), identity = { agentId: f.record.metadata.id, sessionId: 'parent-session' };
  if (firstManaged) { await f.admitManaged(); await f.receiver.drain(identity.sessionId); }
  else { await f.host.executeTurn(f.payload); f.payload.agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } }); }
  const old = (await route('sessions/native-child-history', identity)).value;
  f.payload.agent.session.append('turn/start', { turn: 2 });
  if (!firstManaged) await f.admitManaged();
  const running = firstManaged ? f.host.executeTurn({ ...f.payload, turn: 2 }) : f.receiver.drain(identity.sessionId);
  await entered.promise;
  const current = (await route('sessions/native-child-history', identity)).value;
  assert.notEqual(current.runId, old.runId); assert.equal(current.tasks.length, 2);
  const active = current.tasks[0], historic = current.tasks[1];
  assert.equal(active.parentRunId, current.runId); assert.equal(active.canCancel, true); assert.equal(active.canSendInput, true);
  assert.equal(historic.parentRunId, old.runId); assert.equal(historic.canCancel, false); assert.equal(historic.canSendInput, false);
  const counts = { models: f.requests.length, tools: f.dispatches.length };
  const detail = (await route('sessions/native-child-result', { ...identity, runId: old.runId, childRunId: historic.childRunId })).value;
  assert.equal(detail.runId, old.runId); assert.equal(detail.text, 'Child 2');
  await assert.rejects(route('sessions/native-child-send', { ...identity, runId: current.runId, childRunId: historic.childRunId,
    commandId: 'foreign-child-send', expectedGoalRevision: historic.goalRevision, text: 'wrong owner' }), { code: 'child_control_not_owned' });
  assert.deepEqual({ models: f.requests.length, tools: f.dispatches.length }, counts);
  const command = { ...identity, runId: current.runId, childRunId: active.childRunId,
    commandId: 'current-child-send', expectedGoalRevision: active.goalRevision, text: 'Read original evidence with guidance' };
  assert.equal((await route('sessions/native-child-send', command)).value.status, 'accepted');
  assert.equal((await route('sessions/native-child-send', command)).value.status, 'duplicate');
  assert.equal((await route('sessions/native-child-history', identity)).value.inventoryDigest, current.inventoryDigest);
  release.resolve(); await running;
  const settled = (await route('sessions/native-child-result', { ...identity, runId: current.runId, childRunId: active.childRunId })).value;
  assert.equal(settled.task.phase, 'completed'); assert.equal(settled.task.resultAvailable, true); assert.equal(settled.text, 'Child 4');
  assert.match(JSON.stringify(f.requests.filter(row => row.body.model === 'child-model').at(-1).body.messages), /Read original evidence with guidance/);
});

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
  f.services.sessionController = { resolveAgent: async id => { assert.equal(id, agent.session.id); return { agent }; } };
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

for (const managed of [false, true]) for (const foreground of [false, true]) for (const approval of [false, true]) test(`${managed ? 'managed' : 'SQLite'} ${foreground ? 'foreground' : 'background'} child A2A ${approval ? 'approval' : 'input'} waits through its live root and settles the original result`, { timeout: 20000 }, async t => {
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
  const f = await setup(t, { managed, sqlite: true, a2a: peer, boundTools: [], childTool: foreground ? 'native_delegate' : 'native_start_child',
    role: { tools: ['call_a2a_agent'] },
    onParentContinuation: () => candidate.resolve(),
    childPlan: (_body, index) => index === 1 ? { call: { name: 'call_a2a_agent', arguments: { agent: 'research', message: 'Question in child' } } }
      : { text: 'Child consumed original remote result' } });
  const human = installChildQuestionHost(f, async request => {
    if (!foreground) await candidate.promise;
    return { answers: [{ id: request.questions[0].id, ...(approval ? { selected: ['批准远端操作'] }
      : { selected: [], custom: '{"answer":1}' }) }] };
  });
  if (managed) { await f.admitManaged(); await f.receiver.drain('parent-session'); }
  else { const result = await f.host.executeTurn(f.payload); assert.equal(result.reason.kind, 'completed'); }
  assert.equal(human.asked(), 1); assert.equal(human.approved(), 1);
  const selectedStore = managed ? f.managedLedger : f.ledger, selectedScope = managed ? f.managedScope : f.scope;
  const parent = selectedStore.list(selectedScope, 'parent-session')[0]; assert.equal(parent.phase, 'completed');
  if (managed) assert.deepEqual(f.ledger.list(f.scope), []);
  const reservation = parent.childBudgetReservations[0]; assert.ok(reservation.settledUsageDigest);
  const child = selectedStore.load(reservation.childScope, reservation.childRunId);
  assert.equal(child.snapshot.phase, 'completed'); assert.notEqual(child.snapshot.sessionId, 'parent-session');
  assert.deepEqual(child.configuration.tools.map(tool => tool.name),
    ['call_a2a_agent', ...todoToolDefinitions().map(tool => tool.name), coordinatorResponseDefinition().name, ...artifactToolDefinitions().map(tool => tool.name)]);
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
  const intent = child.intents.find(row => row.kind === 'tool'), call = intent.payload.calls[0];
  const route = createSessionRoutes({ getNativeHost: async () => f.host });
  const query = { agentId: f.record.metadata.id, sessionId: 'parent-session', runId: parent.runId,
    childRunId: child.snapshot.runId, operationKey: intent.operationKey, callId: call.callId, kind: 'get', commandId: 'inspect-original-child-remote' };
  const counts = { remote: peer.calls.length, models: f.requests.length, approvals: human.approved() };
  const rootRecord = selectedStore.load(selectedScope, parent.runId);
  const view = (await route('sessions/native-a2a-control', query)).value;
  assert.equal(view.state, 'completed'); assert.equal(view.outcome, 'observed');
  assert.equal(view.operation_locator.runId, child.snapshot.runId); assert.equal(view.operation_locator.sessionId, child.snapshot.sessionId);
  assert.deepEqual(view.operation_locator.scope, child.snapshot.scope);
  for (const changed of [{ childRunId: 'foreign-child' }, { callId: 'foreign-call' }, { sessionId: 'foreign-session' }])
    await assert.rejects(route('sessions/native-a2a-control', { ...query, ...changed }));
  assert.deepEqual(selectedStore.load(selectedScope, parent.runId), rootRecord);
  assert.deepEqual(selectedStore.load(reservation.childScope, child.snapshot.runId), child);
  assert.deepEqual({ remote: peer.calls.length, models: f.requests.length, approvals: human.approved() }, counts);
  const lookup = { sessionId: 'parent-session', runId: parent.runId, childRunId: child.snapshot.runId };
  const history = createNativeChildHistory({ scope: selectedScope, store: selectedStore });
  const independent = history.record(lookup); assert.deepEqual(independent, child);
  independent.snapshot.finalText = 'caller replacement';
  assert.deepEqual(selectedStore.load(reservation.childScope, child.snapshot.runId), child);
  await assert.rejects(route('sessions/native-a2a-control', { ...query, childRunId: '' }));
  for (const field of ['configuration', 'binding', 'scope']) {
    const altered = structuredClone(child);
    if (field === 'configuration') altered.configuration.contract.objective = 'replacement task';
    if (field === 'binding') altered.configuration.childOwnerBinding.parent.runId = 'foreign-parent';
    if (field === 'scope') altered.snapshot.scope.userId = 'foreign-user';
    const readOnlyCorruption = { sessionHead: (...args) => selectedStore.sessionHead(...args),
      load: (scope, id) => id === child.snapshot.runId ? structuredClone(altered) : selectedStore.load(scope, id) };
    assert.throws(() => createNativeChildHistory({ scope: selectedScope, store: readOnlyCorruption }).record(lookup),
      /child_history|stored_configuration/);
  }
  if (managed) {
    await f.reopenManaged();
    assert.equal((await route('sessions/native-a2a-control', query)).value.state, 'completed');
    assert.deepEqual(f.managedLedger.load(selectedScope, parent.runId), rootRecord);
    assert.deepEqual(f.managedLedger.load(reservation.childScope, child.snapshot.runId), child);
    assert.deepEqual({ remote: peer.calls.length, models: f.requests.length, approvals: human.approved() }, counts);
  }
});

for (const approval of [false, true]) test(`managed root A2A ${approval ? 'approval' : 'input'} uses original Host question and separately fenced receipt read`, { timeout: 20000 }, async t => {
  const peer = await internalPeer({ mode: 'pause', ...(approval ? { expectedContinuationParts: [{ data: 'approve' }],
    initialTask: { id: 'original-remote', contextId: 'original-context', status: { state: 'TASK_STATE_INPUT_REQUIRED', message: {
      messageId: 'root-approval', role: 'ROLE_AGENT', parts: [{ text: 'Approve remote operation?' }], metadata: {
        input_schema: { type: 'string', enum: ['approve', 'reject'] },
        ksadk_interaction: { version: 1, kind: 'approval', allowed_decisions: ['approve', 'reject'],
          presentation: { title: 'remote-write', description: '{"arguments":{}}' } },
      },
    } } },
  } : {}) }); t.after(() => peer.close());
  const f = await setup(t, { managed: true, sqlite: true, a2a: peer, boundTools: ['call_a2a_agent'], role: { tools: [] },
    parentPlan: (_body, index) => index === 1 ? { call: { name: 'call_a2a_agent', arguments: { agent: 'research', message: 'Original root question' } } }
      : { text: 'Root consumed original remote result' } });
  const human = installChildQuestionHost(f, async request => ({ answers: [{ id: request.questions[0].id,
    ...(approval ? { selected: ['批准远端操作'] } : { selected: [], custom: '{"answer":1}' }) }] }));
  const receipt = await f.admitManaged(); await f.receiver.drain('parent-session');
  const parent = f.managedLedger.load(f.managedScope, receipt.run_id);
  assert.equal(parent.snapshot.phase, 'completed'); assert.equal(parent.snapshot.finalText, 'Root consumed original remote result');
  assert.equal(human.asked(), 1); assert.equal(human.approved(), 1);
  assert.equal(parent.intents.filter(row => row.kind === 'tool').length, 1);
  assert.equal(parent.intents.filter(row => row.kind === 'tool_receipt').length, 1);
  assert.equal(parent.events.filter(row => row.kind === 'tool.receipt_reconciled').length, 1);
  assert.equal(parent.commands.filter(row => row.command.kind === 'reconcile_tool').length, 1);
  assert.equal(f.requests.length, 2); assert.equal(peer.calls.filter(row => row.wireMethod === 'SendMessage').length, 2);
  assert.equal(peer.calls.filter(row => row.wireMethod === 'CancelTask').length, 0);
  assert.deepEqual(f.ledger.list(f.scope), []);
  const before = { record: parent, calls: peer.calls.length, models: f.requests.length };
  await f.reopenManaged();
  const route = createSessionRoutes({ getNativeHost: async () => f.host });
  const status = (await route('sessions/native-recovery-status', { agentId: f.record.metadata.id, sessionId: 'parent-session', runId: receipt.run_id })).value;
  assert.equal(status.phase, 'completed'); assert.deepEqual(f.managedLedger.load(f.managedScope, receipt.run_id), before.record);
  assert.equal(peer.calls.length, before.calls); assert.equal(f.requests.length, before.models);
});

for (const child of [false, true]) test(`managed ${child ? 'child' : 'root'} A2A question rejects a late answer after signed Server interruption`, { timeout: 20000 }, async t => {
  const peer = await internalPeer({ mode: 'pause' }); t.after(() => peer.close());
  const entered = Promise.withResolvers(), delayed = Promise.withResolvers(); let question;
  const call = { name: 'call_a2a_agent', arguments: { agent: 'research', message: 'Original interrupted question' } };
  const f = await setup(t, { managed: true, sqlite: true, a2a: peer, boundTools: child ? [] : ['call_a2a_agent'],
    role: { tools: child ? ['call_a2a_agent'] : [] }, childTool: 'native_delegate',
    ...(child ? { childPlan: () => ({ call }) } : { parentPlan: () => ({ call }) }),
    releasePending: () => delayed.resolve({ answers: [] }) });
  const human = installChildQuestionHost(f, request => { question = request; entered.resolve(); return delayed.promise; });
  const receipt = await f.admitManaged(), running = f.receiver.drain('parent-session'); await entered.promise;
  assert.equal((await f.controlManaged('interrupt', receipt.run_id)).status, 'accepted'); await running;
  const record = f.managedLedger.load(f.managedScope, receipt.run_id);
  assert.equal(record.snapshot.phase, 'canceled'); assert.equal(question.signal.aborted, true);
  delayed.resolve({ answers: [{ id: question.questions[0].id, selected: [], custom: '{"answer":1}' }] });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(human.asked(), 1); assert.equal(human.approved(), 0);
  assert.equal(peer.calls.filter(call => call.wireMethod === 'SendMessage').length, 1);
  assert.equal(peer.calls.filter(call => call.wireMethod === 'CancelTask').length, 0);
  assert.equal(record.commands.filter(row => row.command.kind === 'reconcile_tool').length, 0);
  assert.deepEqual(Object.values(peer.record().managed.questions.entries).map(row => row.stage), ['withdrawn']);
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
      await assert.rejects(execute({ ...saved, buildId: 'foreign-build' }), /tool_authority_stale/);
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
  await assert.rejects(captured.at(-1).execute(captured.at(-1).request), /tool_authority_stale/, 'completed child cannot replay a disclosure');
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
  assert.deepEqual(saved.configuration.tools, [...todoToolDefinitions(), coordinatorResponseDefinition(), ...artifactToolDefinitions()]);
  assert.equal(saved.configuration.limits.maxToolCalls, 0);
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
  assert.deepEqual(saved.configuration.tools.map(tool => tool.name), ['remote_lookup', ...todoToolDefinitions().map(tool => tool.name),
    coordinatorResponseDefinition().name, ...artifactToolDefinitions().map(tool => tool.name)]);
  assert.ok(saved.configuration.tools.filter(tool => tool.name === 'remote_lookup').every(tool => !tool.readOnly && !tool.concurrentSafe));
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

test('shared Host child reads its own large MCP archive while the parent earns no child-scoped reference', async t => {
  let remoteCalls = 0, childUri;
  const f = await setup(t, { sqlite: true, childTool: 'native_delegate', boundTools: [],
    role: { tools: [], inheritMcp: true }, mcp: { contracts: [childMcpContract], execute: async input => {
      input.assertCurrent(); remoteCalls++;
      return { content: [{ type: 'text', text: 'CHILD_SOURCE_BEGIN_' + 'x'.repeat(100000) + '_CHILD_SOURCE_END' }] };
    } }, childPlan: async (body, index) => {
      if (index === 1) return { call: { name: 'remote_lookup', arguments: { id: 1 } } };
      const message = body.messages.filter(message => message.role === 'tool').at(-1);
      if (index === 2) {
        assert.ok(!message.content.includes('x'.repeat(100000)));
        childUri = JSON.parse(message.content).artifact_uri; assert.ok(childUri);
        return { call: { name: 'ArtifactRead', arguments: { uri: childUri, limit_chars: 128 } } };
      }
      assert.match(message.content, /CHILD_SOURCE_BEGIN_/);
      return { text: 'Child read its scoped archive.' };
    } });
  await f.host.executeTurn(f.payload);
  const parent = f.ledger.load(f.scope, f.ledger.sessionHead(f.scope, 'parent-session').runId);
  const childScope = { ...f.scope, agentId: `${f.scope.agentId}:child:reader` }, child = f.ledger.list(childScope)[0];
  assert.equal(child.phase, 'completed'); assert.equal(parent.snapshot.phase, 'completed'); assert.equal(remoteCalls, 1);
  assert.equal(f.childModels(), 3); assert.equal(typeof childUri, 'string');
  assert.deepEqual(child.artifactRefs.map(ref => ref.uri), [childUri]);
  assert.ok(!parent.snapshot.artifactRefs.some(ref => ref.uri === childUri));
  const parentArtifacts = await f.gateway.artifactsFor(f.scope);
  await assert.rejects(parentArtifacts.read({ ...parent.snapshot, signal: new AbortController().signal,
    operationKey: 'parent-probe', ref: child.artifactRefs[0], offset: 0, limit: 30 }));
  const reopened = new SqliteRunStore(join(f.root, 'runs.sqlite'));
  try { assert.deepEqual(reopened.load(childScope, child.runId).snapshot.artifactRefs, child.artifactRefs); }
  finally { reopened.close(); }
  assert.equal(f.dispatches.some(call => call.name === 'ArtifactRead'), false, 'reserved reads bypass the external registry');
});

test('MCP inheritance is opt-in and rejects concurrent-safe roles with unknown remote effects before model work', async t => {
  const mcp = { contracts: [childMcpContract], execute: async () => assert.fail('No MCP dispatch') };
  const f = await setup(t, { sqlite: true, childTool: 'native_delegate', mcp,
    childPlan: async (_body, index) => index === 1
      ? { call: { name: 'read_workspace_file', arguments: { path: 'proof.txt' } } } : { text: 'Read only local evidence' } });
  await f.host.executeTurn(f.payload);
  const childScope = { ...f.scope, agentId: `${f.scope.agentId}:child:reader` };
  assert.deepEqual(f.ledger.load(childScope, f.ledger.list(childScope)[0].runId).configuration.tools.map(tool => tool.name),
    ['read_workspace_file', ...todoToolDefinitions().map(tool => tool.name), coordinatorResponseDefinition().name, ...artifactToolDefinitions().map(tool => tool.name)]);
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
  f = await setup(t, { sqlite: true, childTool: 'native_delegate', boundTools, filePreview: true,
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
  await writeFile(join(f.workspaceRoot, 'child-only.txt'), 'Different parent bytes');
  const parent = f.ledger.load(f.scope, f.ledger.sessionHead(f.scope, f.payload.agent.session.id).runId);
  const request = { agentId: f.record.metadata.id, sessionId: f.payload.agent.session.id,
    runId: parent.snapshot.runId, childRunId: firstId, path: 'child-only.txt' };
  const calls = f.requests.length, effects = f.dispatches.length, before = structuredClone(parent);
  const route = createSessionRoutes({ ctx: f.ctx, getNativeHost: async () => f.host });
  const page = (await route('sessions/native-child-file', request)).value;
  assert.equal(page.text, 'isolated child bytes'); assert.equal(page.readOnly, true);
  assert.equal(page.workspace, 'child'); assert.equal(page.nextOffset, null);
  assert.equal(JSON.stringify(page).includes(f.root), false);
  for (const changed of [{ childRunId: 'foreign' }, { sessionId: 'foreign' }, { agentId: 'foreign' },
    { runId: 'foreign' }, { path: '../inputs.json' }, { root: f.workspaceRoot }])
    await assert.rejects(route('sessions/native-child-file', { ...request, ...changed }));
  assert.equal(f.requests.length, calls); assert.equal(f.dispatches.length, effects);
  assert.deepEqual(f.ledger.load(f.scope, parent.snapshot.runId), before);
  assert.equal(await readFile(join(f.workspaceRoot, 'child-only.txt'), 'utf8'), 'Different parent bytes');
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
    assert.equal(parent.phase, 'completed', parent.reason);
    assert.equal(parent.childRunIds.length, 1);
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
test('C4: Studio runs two differently bound child models concurrently with tool sets no broader than the parent', { timeout: 10000 }, async t => {
  const both = Promise.withResolvers(), release = Promise.withResolvers(), entered = new Set(), counts = new Map();
  const f = await setup(t, { sqlite: true, releasePending: () => release.resolve(),
    additionalRoles: [{ name: 'reflector', instructions: 'Review evidence.', tools: ['read_workspace_file'],
      modelProfileId: 'strong-profile', maxTurns: 3, maxToolCalls: 2 }],
    beforeChildModel: async (_index, body) => {
      if (entered.has(body.model)) return;
      entered.add(body.model); if (entered.size === 2) both.resolve(); await release.promise;
    },
    parentPlan: async (_body, index) => index <= 2 ? { call: { name: 'native_start_child',
      arguments: { role: index === 1 ? 'reader' : 'reflector', task: 'Read proof.txt', background: true } } }
      : { text: 'Both role results received.' },
    childPlan: async body => {
      const count = (counts.get(body.model) ?? 0) + 1; counts.set(body.model, count);
      return count === 1 ? { call: { name: 'read_workspace_file', arguments: { path: 'proof.txt' } } } : { text: 'Read-only evidence verified.' };
    } });
  const running = f.host.executeTurn(f.payload);
  try {
    await both.promise;
    assert.deepEqual([...entered].sort(), ['child-model', 'strong-profile-model']);
    const histories = f.ledger.list({ ...f.scope, agentId: `${f.scope.agentId}:child:reader` })
      .concat(f.ledger.list({ ...f.scope, agentId: `${f.scope.agentId}:child:reflector` }));
    assert.equal(histories.length, 2); assert.ok(histories.every(snapshot => snapshot.phase === 'requesting_model'));
    for (const request of f.requests.filter(item => item.body.model !== 'parent-model')) {
      const tools = request.body.tools.map(tool => tool.function.name);
      assert.ok(tools.includes('read_workspace_file')); assert.equal(tools.includes('write_workspace_file'), false);
      assert.equal(tools.includes('run_command'), false);
    }
  } finally { release.resolve(); }
  await running;
  assert.equal(f.ledger.sessionHead(f.scope, 'parent-session').childRunIds.length, 2);
  assert.equal(f.dispatches.filter(call => call.name === 'read_workspace_file').length, 2);
});

test('C3: main conversation accepts inline user input while its background child remains active', { timeout: 10000 }, async t => {
  const started = Promise.withResolvers(), release = Promise.withResolvers(); let injected = false;
  const f = await setup(t, { sqlite: true, releasePending: () => release.resolve(),
    beforeChildModel: async index => { if (index === 1) { started.resolve(); await release.promise; } },
    parentPlan: async (body, index) => {
      if (index === 1) return { call: { name: 'native_start_child', arguments: { role: 'reader', task: 'Read proof.txt', background: true } } };
      assert.match(JSON.stringify(body.messages), /Reply to my additional question while the child works/);
      release.resolve(); return { text: 'Main input handled and child evidence collected.' };
    } });
  f.payload.prepareInput = async () => {
    if (injected) return { kind: 'enter', messages: [], assembly: f.payload.input.assembly };
    await started.promise; injected = true;
    return { kind: 'enter', assembly: f.payload.input.assembly, messages: [{ id: 'main-interjection', role: 'user',
      source: { kind: 'user' }, content: [{ type: 'text', text: 'Reply to my additional question while the child works' }] }] };
  };
  await f.host.executeTurn(f.payload);
  const root = f.ledger.sessionHead(f.scope, 'parent-session');
  assert.equal(root.phase, 'completed'); assert.equal(injected, true);
  assert.equal(root.childBudgetReservations.length, 1);
  assert.ok(root.childBudgetReservations[0].settledUsageDigest);
});

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
    assert.ok(next.messages.some(message => message.role === 'tool' && /child_followup_model_image_unavailable/.test(message.content)));
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

test('default discovery follows inherited child MCP without granting control tools to the external gateway', async t => {
  const effects = [];
  const f = await setup(t, { sqlite: true, toolSearch: true, childTool: 'native_delegate', boundTools: [],
    role: { tools: [], inheritMcp: true, maxToolCalls: null },
    mcp: { contracts: [childMcpContract], execute: async input => {
      input.assertCurrent(); effects.push(input); return { content: [{ type: 'text', text: 'Deferred child evidence' }] };
    } },
    childPlan: async (body, index) => {
      if (index === 1) return { call: { name: 'ToolSearch', arguments: { query: 'select:remote_lookup' } } };
      if (index === 2) {
        const output = JSON.parse(body.messages.filter(message => message.role === 'tool').at(-1).content);
        assert.deepEqual(output.tool_names, ['remote_lookup']);
        return { call: { name: 'DeferredToolCall', arguments: { name: 'remote_lookup', input: { id: 7 } } } };
      }
      assert.match(JSON.stringify(body.messages), /Deferred child evidence/);
      return { text: 'Discovered child MCP delivery' };
    } });
  const bind = f.gateway.forChild.bind(f.gateway);
  f.gateway.forChild = (agent, authority) => {
    assert.deepEqual(authority.toolNames, ['remote_lookup']); return bind(agent, authority);
  };
  await f.host.executeTurn(f.payload);
  const childScope = { ...f.scope, agentId: `${f.scope.agentId}:child:reader` };
  const child = f.ledger.list(childScope)[0], saved = f.ledger.load(childScope, child.runId);
  assert.equal(child.phase, 'completed'); assert.equal(effects.length, 1);
  assert.equal(saved.configuration.toolDiscoveryPolicy, 'local-tool-search/v1');
  assert.deepEqual(saved.snapshot.toolDiscovery.discovered, ['remote_lookup']);
  const actual = saved.intents.filter(intent => intent.kind === 'tool').flatMap(intent => intent.payload.calls);
  assert.deepEqual(actual.map(call => call.name), ['ToolSearch', 'remote_lookup']);
  assert.equal(actual[1].modelCallWrapper, 'DeferredToolCall');
  assert.equal(saved.configuration.tools.find(tool => tool.name === 'remote_lookup').readOnly, false);
  assert.equal(f.dispatches.filter(item => item.name === 'remote_lookup').length, 1);
  assert.equal(f.dispatches.some(item => ['ToolSearch', 'DeferredToolCall'].includes(item.name)), false);
});

test('auto discovery preserves an MCP tool whose actual name collides with a control name', async t => {
  let effects = 0;
  const f = await setup(t, { sqlite: true, toolSearch: true, childTool: 'native_delegate', boundTools: [],
    role: { tools: [], inheritMcp: true },
    mcp: { contracts: [{ ...childMcpContract, name: 'ToolSearch' }], execute: async input => {
      input.assertCurrent(); effects++; return { content: [{ type: 'text', text: 'Actual external ToolSearch' }] };
    } },
    childPlan: async (_body, index) => index === 1 ? { call: { name: 'ToolSearch', arguments: { id: 1 } } }
      : { text: 'Legacy named MCP completed' } });
  await f.host.executeTurn(f.payload);
  const childScope = { ...f.scope, agentId: `${f.scope.agentId}:child:reader` };
  const child = f.ledger.list(childScope)[0], saved = f.ledger.load(childScope, child.runId);
  assert.equal(child.phase, 'completed'); assert.equal(effects, 1);
  assert.equal(Object.hasOwn(saved.configuration, 'toolDiscoveryPolicy'), false);
  assert.equal(f.dispatches.filter(item => item.name === 'ToolSearch').length, 1);
});
