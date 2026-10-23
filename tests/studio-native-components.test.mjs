import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createAgentStore } from '../src/agent-store.mjs';
import { createModelService } from '../src/model-service.mjs';
import { createStudioNativeHarness } from '../src/host/services/native-harness.mjs';
import { createNativeDshTools } from '../src/providers/native-dsh-tools.mjs';
import { studioNativeComponentStatus } from '../src/providers/native-component-status.mjs';
import { SqliteRunStore } from '../packages/agentkit-harness/src/native/sqlite-store.mjs';
import { nativeOwnershipHost } from './fixtures/native-ownership-host.mjs';
import { createNativeSkillConnection } from '../src/providers/native-skill-host.mjs';

async function setup(t, { intercept = async () => {}, commandEnvironment, e2bLoadSdk, skillConnection, skillSpaceIds } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'studio-component-host-')), workspaceRoot = join(root, 'workspace');
  mkdirSync(workspaceRoot);
  const store = new SqliteRunStore(join(root, 'runs.sqlite'));
  const agents = createAgentStore({ storeDir: root });
  const record = await agents.create({ name: 'Components', runtimeType: 'harness', spec: {
    bindings: { modelProfileIds: ['first', 'second'], tools: ['component_status', 'read_workspace_file', 'sandbox_status', 'run_command'] },
  } });
  const definitions = new Map(), registry = new Map(), events = new Map(), bodies = [], invocations = [];
  const services = { sessions: { flush: async () => true }, llm: {}, sessionProjections: {
    register(definition) { definitions.set(definition.key, definition); return () => definitions.delete(definition.key); },
    stateOf(session, key) { const definition = definitions.get(key); return events.get(session.id).reduce(definition.apply, definition.init()); },
  } };
  const ctx = { get: key => services[key], effect: install => install(), tools: {
    register(definition) { registry.set(definition.name, definition); return () => registry.delete(definition.name); },
    async execute(input) {
      invocations.push(input);
      const definition = registry.get(input.name);
      await intercept(input);
      const value = await definition.execute(input.arguments, input);
      return { isError: false, value, content: definition.output.render(input.arguments, value) };
    },
  } };
  const gateway = createNativeDshTools({ ctx, config: { agentId: record.metadata.id,
    toolBindings: record.spec.bindings.tools, toolContracts: [], ...(skillSpaceIds ? { skillSpaceIds } : {}) }, workspaceRoot, stateDir: join(root, 'state'),
    ...(skillConnection ? { skillConnection } : {}),
    commandEnvironment: commandEnvironment ?? { MODEL_API_KEY: 'never-copy-this-key', KSADK_SKILL_RUNTIME_BACKEND: 'imagined-e2b' },
    ...(e2bLoadSdk ? { e2bLoadSdk } : {}) });
  const nativeRequests = [], originalForAgent = gateway.forAgent.bind(gateway), bound = new Map();
  gateway.forAgent = (agent, authority) => {
    const ports = originalForAgent(agent, authority); bound.set(agent.session.id, ports);
    return { ...ports, tools: { execute: request => { nativeRequests.push(request); return ports.tools.execute(request); } } };
  };
  const models = createModelService({ configuration: { resolve: async () => ({ values: { modelProfiles: ['first', 'second'].map(id => ({
    id, provider: 'openai-compatible', modelName: id + '-model', baseUrl: 'https://model.invalid/v1',
  })) } }) }, credentials: { resolve: async () => ({ value: 'model-secret' }) } });
  const counts = new Map();
  const host = await createStudioNativeHarness({ ctx, storeDir: root, workspaceRoot, agents, models, ledger: store,
    renderPrompt: () => 'Report only the actual admitted components.', fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body); bodies.push(body);
      const count = (counts.get(body.model) ?? 0) + 1; counts.set(body.model, count);
      const delta = count === 1 ? { tool_calls: [{ index: 0, id: 'component-call', type: 'function',
        function: { name: 'component_status', arguments: '{}' } }] } : { content: 'Actual components reported.' };
      return new Response(`data: ${JSON.stringify({ id: body.model + count, choices: [{ index: 0, delta,
        finish_reason: count === 1 ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 3 } })}\n\ndata: [DONE]\n\n`,
      { headers: { 'content-type': 'text/event-stream' } });
    } });
  t.after(async () => { await host.close(); await gateway.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  const scope = { tenantId: 'local', workspaceId: createHash('sha256').update(JSON.stringify(workspaceRoot)).digest('hex'),
    userId: 'local-user', agentId: record.metadata.id };
  const payload = (sessionId, profile = 'first') => {
    const rows = []; events.set(sessionId, rows);
    const session = { id: sessionId, append: (type, data, options) => rows.push({ type, data, ...options, seq: rows.length + 1 }) };
    session.append('turn/start', { turn: 1 });
    const assembly = { tools: [...registry.values()] };
    return { agent: { session, externalTurns: nativeOwnershipHost(session, rows),
      options: { provider: 'agentkit-studio-' + profile, model: profile + '-model' } },
      input: { kind: 'enter', messages: [{ id: 'human-' + sessionId, role: 'user', source: { kind: 'user' },
        content: [{ type: 'text', text: 'Report my admitted components.' }] }], assembly },
      turn: 1, signal: new AbortController().signal, prepareInput: async () => ({ kind: 'enter', messages: [], assembly }),
      binding: { agentId: record.metadata.id, agentRevision: record.metadata.revision, runtime: 'harness', local: true,
        nativeEngineContract: 'agentkit.native-dsh-turn/v1', nativeTools: gateway } };
  };
  const result = sessionId => {
    const snapshot = store.sessionHead(scope, sessionId), saved = store.load(scope, snapshot.runId);
    return { saved, snapshot, result: saved.receipts.flatMap(receipt => receipt.result.results ?? [])
      .find(result => result.content?.summary)?.content };
  };
  return { root, workspaceRoot, record, store, gateway, host, scope, payload, result, bodies, nativeRequests, bound, invocations };
}

test('actual Host + registered gateway + SQLite returns pinned component facts and rejects completed replay', async t => {
  const h = await setup(t);
  await h.host.executeTurn(h.payload('session'));
  const { result, saved, snapshot } = h.result('session');
  assert.equal(snapshot.phase, 'completed');
  assert.equal(snapshot.usage.toolCalls, 1);
  assert.equal(h.bodies.length, 2);
  assert.equal(h.invocations.length, 1);
  assert.equal(result.ok, true);
  assert.equal(result.summary.model, 'first-model');
  assert.equal(result.summary.isolated_execution, 'not_enabled');
  assert.equal(result.summary.sandbox_direct_tools, 'enabled');
  assert.equal(result.sandbox.backend, 'local_process');
  assert.deepEqual(result.sandbox.tools, ['sandbox_status', 'run_command']);
  assert.deepEqual(result.workspace.tools, ['read_workspace_file']);
  assert.equal(result.workspace.root, h.workspaceRoot);
  assert.equal(result.skill_runtime.enabled, false);
  assert.equal(result.summary.long_term_memory_bound, false);
  assert.deepEqual(result.skill_space.tools, []);
  assert.equal(h.bodies[1].messages.some(message => message.role === 'tool' && message.content.includes('first-model')), true);
  for (const secret of ['never-copy-this-key', 'imagined-e2b', 'model-secret']) assert.equal(JSON.stringify(saved).includes(secret), false);
  const count = saved.receipts.length;
  const replay = await h.bound.get('session').tools.execute(h.nativeRequests[0]);
  assert.equal(replay.status, 'error');
  assert.equal(h.store.load(h.scope, snapshot.runId).receipts.length, count);
});

test('Host admits an explicit E2B configuration into its Build pin and component projection without allocating a sandbox', async t => {
  let loads = 0;
  const environment = { KSADK_SANDBOX_BACKEND: 'e2b', KSADK_SANDBOX_TEMPLATE_ID: 'bound-template',
    E2B_API_URL: 'https://original.fixture.invalid', E2B_DOMAIN: 'fixture.invalid', E2B_API_KEY: 'private-e2b-secret' };
  const h = await setup(t, { commandEnvironment: environment, e2bLoadSdk: async () => { loads++; assert.fail('status projection must not load SDK'); } });
  const binding = h.gateway.commandBinding;
  assert.equal(binding.backend, 'e2b');
  environment.KSADK_SANDBOX_BACKEND = 'local'; environment.E2B_API_KEY = 'changed-key';
  await h.host.executeTurn(h.payload('e2b-session'));
  const { result, saved, snapshot } = h.result('e2b-session');
  assert.equal(snapshot.phase, 'completed'); assert.equal(loads, 0);
  assert.equal(result.summary.isolated_execution, 'enabled');
  assert.equal(result.sandbox.backend, 'e2b'); assert.equal(result.sandbox.template_bound, true);
  assert.equal(result.skill_runtime.enabled, false);
  assert.deepEqual(result.sandbox.tools, ['sandbox_status', 'run_command']);
  assert.deepEqual(h.gateway.commandBinding, binding);
  for (const secret of ['private-e2b-secret', 'changed-key']) assert.equal(JSON.stringify(saved).includes(secret), false);
  assert.match(saved.configuration.hostBindingDigest, /^[a-f0-9]{64}$/u);
});

test('Host pins the mounted remote Skill connection and projects actual bound spaces without claiming workflow execution', async t => {
  const skillConnection = await createNativeSkillConnection({ configuration: { resolve: async () => ({ values: {
    cloudAccessKey: 'private-skills-key', cloudSecretKey: 'private-skills-secret', cloudAccountId: 'private-skills-account',
  } }) } });
  const environment = { KSADK_PUBLIC_SKILL_SPACE_IDS: 'public-space' }, spaces = ['bound-space'];
  const h = await setup(t, { commandEnvironment: environment, skillConnection, skillSpaceIds: spaces });
  spaces.push('late-injection'); environment.KSADK_PUBLIC_SKILL_SPACE_IDS = 'late-injection';
  await h.host.executeTurn(h.payload('remote-skills-session'));
  const { result, saved, snapshot } = h.result('remote-skills-session');
  assert.equal(snapshot.phase, 'completed'); assert.equal(result.summary.skill_space_bound, true);
  assert.deepEqual(result.skill_space.space_ids, ['bound-space', 'public-space']);
  assert.deepEqual(result.skill_space.user_space_ids, ['bound-space']);
  assert.deepEqual(result.skill_space.public_space_ids, ['public-space']);
  assert.deepEqual(result.skill_space.tools, ['list_skill_spaces', 'list_skills', 'search_skills', 'preview_skill', 'load_skill', 'execute_skills']);
  assert.equal(result.skill_runtime.enabled, false);
  assert.match(saved.configuration.hostBindingDigest, /^[a-f0-9]{64}$/u);
  for (const privateValue of ['private-skills-key', 'private-skills-secret', 'private-skills-account', 'late-injection'])
    assert.equal(JSON.stringify(saved).includes(privateValue), false);
});

test('Host status pins E2B Skills independently of local command tools and does not allocate or load the SDK', async t => {
  const skillConnection = await createNativeSkillConnection({ configuration: { resolve: async () => ({ values: {} }) } });
  let loads = 0;
  const environment = { KSADK_SKILL_RUNTIME_BACKEND: 'e2b', KSADK_SKILL_RUNTIME_TEMPLATE_ID: 'skills-template',
    E2B_API_URL: 'https://api.fixture.invalid', E2B_DOMAIN: 'fixture.invalid', E2B_API_KEY: 'private-skills-e2b-key' };
  const h = await setup(t, { commandEnvironment: environment, skillConnection, skillSpaceIds: ['bound-space'],
    e2bLoadSdk: async () => { loads++; assert.fail('status cannot import the execution SDK'); } });
  environment.KSADK_SKILL_RUNTIME_TEMPLATE_ID = 'changed-template'; environment.E2B_API_KEY = 'changed-secret';
  await h.host.executeTurn(h.payload('skills-e2b-status'));
  const { result, saved, snapshot } = h.result('skills-e2b-status'); assert.equal(snapshot.phase, 'completed');
  assert.equal(loads, 0); assert.equal(result.skill_runtime.backend, 'e2b'); assert.equal(result.skill_runtime.enabled, true);
  assert.equal(result.skill_runtime.request_protocol, 'agentkit.native-skill-e2b-runtime/v1'); assert.equal(result.skill_runtime.template_bound, true);
  assert.equal(result.summary.isolated_execution, 'enabled'); assert.equal(result.sandbox.backend, 'local_process');
  assert.equal(h.gateway.remoteSkillBinding.runtime.host.template, 'skills-template');
  assert.doesNotMatch(JSON.stringify(saved), /private-skills-e2b-key|changed-template|changed-secret/);
});

test('Host status accepts a mounted local Skill runtime through the existing component contract and reports its Node protocol', async t => {
  const skillConnection = await createNativeSkillConnection({ configuration: { resolve: async () => ({ values: {} }) } });
  const h = await setup(t, { commandEnvironment: { KSADK_SKILL_RUNTIME_BACKEND: 'local_process' }, skillConnection, skillSpaceIds: ['bound-space'] });
  await h.host.executeTurn(h.payload('local-skill-status'));
  const { result, snapshot } = h.result('local-skill-status'); assert.equal(snapshot.phase, 'completed');
  assert.equal(result.skill_runtime.backend, 'local_process'); assert.equal(result.skill_runtime.enabled, true);
  assert.equal(result.skill_runtime.template_bound, false); assert.equal(result.summary.isolated_execution, 'not_enabled');
  assert.equal(result.skill_runtime.request_protocol, 'agentkit.native-skill-runtime/v1');
});

test('overlapping sessions keep their own model/status snapshots through the shared gateway', async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const h = await setup(t, { intercept: async input => {
    if (input.agent.session.id === 'first-session') { entered.resolve(); await release.promise; }
  } });
  const first = h.host.executeTurn(h.payload('first-session', 'first'));
  try {
    await entered.promise;
    await h.host.executeTurn(h.payload('second-session', 'second'));
    assert.equal(h.result('second-session').result.summary.model, 'second-model');
  } finally { release.resolve(); }
  await first;
  assert.equal(h.result('first-session').result.summary.model, 'first-model');
  assert.equal(h.result('first-session').snapshot.usage.toolCalls, 1);
  assert.equal(h.result('second-session').snapshot.usage.toolCalls, 1);
});

test('cancellation while the DSH pipeline waits cannot deliver a late component result to the model', async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const h = await setup(t, { intercept: async () => { entered.resolve(); await release.promise; } });
  const payload = h.payload('cancel-session'), controller = new AbortController();
  payload.signal = controller.signal;
  const outcome = h.host.executeTurn(payload).then(value => ({ value }), error => ({ error }));
  await entered.promise;
  controller.abort(Object.assign(new Error('cancel component status'), { kind: 'user' }));
  release.resolve();
  const ending = await outcome;
  assert.equal(ending.error, undefined);
  assert.deepEqual(ending.value.reason, { kind: 'aborted', reason: { kind: 'user' } });
  const head = h.store.sessionHead(h.scope, 'cancel-session');
  assert.equal(head.phase, 'canceled');
  assert.equal(h.bodies.length, 1);
  const saved = h.store.load(h.scope, head.runId);
  assert.equal(saved.receipts.flatMap(receipt => receipt.result.results ?? []).some(result => result.status === 'ok'), false);
});

test('Host status describes enabled binding metadata but only actually mounted tools', () => {
  const record = { spec: { memory: { enabled: false }, bindings: { plugins: [
    { enabled: true, config: { binding: { resource: { kind: 'knowledge-base', id: 'kb' } } } },
    { enabled: false, config: { binding: { resource: { kind: 'skill-space', id: 'disabled' } } } },
    { config: { binding: { resource: { kind: 'skill-space', id: 'space' } } } },
    { config: { binding: { resource: { kind: 'memory-instance', id: 'memory' } } } },
  ] } } };
  const { status } = studioNativeComponentStatus({ record, modelName: 'bound-model', workspaceRoot: '/workspace',
    tools: [{ name: 'component_status' }, { name: 'multi_edit_workspace_file' }], commandBinding: null });
  assert.equal(status.summary.knowledge_base_bound, true);
  assert.equal(status.summary.long_term_memory_bound, false);
  assert.equal(status.summary.skill_space_bound, true);
  assert.deepEqual(status.skill_space.space_ids, ['space']);
  assert.deepEqual(status.workspace.tools, ['multi_edit_workspace_file']);
  assert.deepEqual(status.sandbox.tools, []);
  assert.equal(status.sandbox.enabled, false);
  const unboundMemory = studioNativeComponentStatus({ record: { spec: { memory: { enabled: true, providerRef: 'unbound' } } },
    modelName: 'bound-model', workspaceRoot: '/workspace', tools: [], commandBinding: null });
  assert.equal(unboundMemory.status.summary.long_term_memory_bound, false, 'an enabled draft without an actual provider is not a binding');
});
