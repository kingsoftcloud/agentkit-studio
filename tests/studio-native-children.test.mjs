import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { MemoryRunStore } from '../packages/agentkit-harness-core/dist/index.mjs';
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

async function setup(t, { sqlite = false, role = {}, forged = false, control = false, query = false, childArguments = {},
  goal = 'Use the bounded reader', childResult = 'Child read actual workspace evidence', parentResult = 'Parent delivery',
  inputParts, childInput = ['text'], childTool = 'native_start_child', beforeChildModel, onParentContinuation, parentPlan,
  childPlan, boundTools = ['read_workspace_file'], mcp, beforeToolDispatch } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'studio-native-children-')), workspaceRoot = join(root, 'workspace');
  await mkdir(workspaceRoot); await writeFile(join(workspaceRoot, 'proof.txt'), 'Actual child evidence');
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
      stateOf: (_session, key) => { const projection = projections.get(key); return events.reduce(projection.apply, projection.init()); } } };
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
    toolContracts: mcp?.contracts }, workspaceRoot, stateDir: join(root, 'tools'), executeMcpTool: mcp?.execute });
  const values = { modelProfiles: [{ id: 'parent-profile', provider: 'openai-compatible', modelName: 'parent-model', baseUrl: 'https://parent.invalid/v1' },
    { id: 'child-profile', provider: 'openai-compatible', modelName: 'child-model', baseUrl: 'https://child.invalid/v1', input: childInput }] };
  const models = createModelService({ configuration: { resolve: async () => ({ values }) }, credentials: { resolve: async () => ({ value: 'fixture-secret' }) } });
  let parentModels = 0, childModels = 0;
  const host = await createStudioNativeHarness({ ctx, storeDir: root, workspaceRoot, agents, models, ledger,
    renderPrompt: () => 'Delegate a bounded read; use its evidence without treating it as parent acceptance.',
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body); requests.push({ url, body });
      const child = body.model === 'child-model';
      let call, text;
      if (child) {
        childModels++;
        await beforeChildModel?.(childModels, body);
        assert.equal(url, 'https://child.invalid/v1/chat/completions');
        const expectedTools = [...roles[0].tools, ...(roles[0].inheritMcp && mcp ? mcp.contracts.map(item => item.name).sort() : [])];
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
  t.after(async () => { await host.close(); await gateway.close(); ledger.close?.(); await rm(root, { recursive: true, force: true }); });
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
  return { root, workspaceRoot, host, payload, ledger, gateway, roles, requests, dispatches, record, scope,
    modelValues: values, childModels: () => childModels };
}

const childMcpContract = { name: 'remote_lookup', executor: 'mcp', mcpResourceId: 'bound-catalog',
  parameters: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'], additionalProperties: false } };

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
