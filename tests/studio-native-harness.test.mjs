import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { SqliteNativeMemoryProvider } from '../packages/agentkit-harness/src/native/memory-store.mjs';
import { memoryDigest, nativeMemoryScopeBindings, nativeUserMemoryCandidate } from '../packages/agentkit-harness/src/native/memory-candidate.mjs';
import { MemoryRunStore, NativeKernel, BACKGROUND_COMMAND_CONTRACT, admitBackgroundNotification, backgroundCommandObservation } from '../packages/agentkit-harness-core/dist/index.mjs';
import { digest, tool } from '../packages/agentkit-harness-core/test/fixtures.mjs';
import { nativeDshBackgroundOwnership } from '../packages/agentkit-harness/src/native/dsh-background-ownership.mjs';
import { createSessionRoutes } from '../src/host/routes/sessions.mjs';
import { createBackgroundCommandPort } from '../packages/agentkit-harness/src/native/background-command-port.mjs';
import { createAgentStore } from '../src/agent-store.mjs';
import { createModelService } from '../src/model-service.mjs';
import { createStudioNativeHarness } from '../src/host/services/native-harness.mjs';
import { createStudioManagedNativeBinding } from '../src/host/services/native-managed-binding.mjs';
import { STUDIO_MANAGED_NATIVE_INPUT } from '../src/host/services/native-managed-input.mjs';
import { nativeOwnershipHost } from './fixtures/native-ownership-host.mjs';
import { studioBrowserDefinition } from '../packages/agentkit-harness/src/native/browser-workspace-protocol.mjs';
import { buildExecutionEngine } from '../src/build-engine.mjs';
import { createNativeDshTools } from '../src/providers/native-dsh-tools.mjs';
import { SqliteRunStore } from '../packages/agentkit-harness/src/native/sqlite-store.mjs';
import { createRuntimeBridge } from '../src/host/runtime-bridge.mjs';
import { STUDIO_NATIVE_CONTEXT_SOURCES_CONTRACT } from '../src/providers/native-context-sources.mjs';

async function setup(t, { spec = {}, profile = {}, respond, contextSources, sqlite = false, recovery = false, storeAlias = false } = {}) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'studio-native-host-unit-'));
  const storeDir = storeAlias ? join(root, 'configured-home') : root;
  if (storeAlias) await symlink(root, storeDir, 'dir');
  const workspaceRoot = join(root, 'workspace');
  await mkdir(workspaceRoot);
  const agents = createAgentStore({ storeDir: root }), ledger = sqlite ? new SqliteRunStore(join(root, 'runs.sqlite')) : new MemoryRunStore();
  const record = await agents.create({ name: 'Native', runtimeType: 'harness', spec: { ...spec, bindings: { modelProfileIds: ['fixture'], ...spec.bindings } } });
  const bridge = contextSources ? createRuntimeBridge() : null;
  const retireContext = (contextSources?.(record) ?? []).map(source => bridge.nativeContextSources.register(source));
  const events = [], definitions = new Map(), requests = [];
  let apiKey = 'secret-one', unregisters = 0;
  const values = { modelProfiles: [{ id: 'fixture', provider: 'openai-compatible', modelName: 'pinned', baseUrl: 'https://model.invalid/v1', ...profile }] };
  const models = createModelService({ configuration: { resolve: async () => ({ values }) }, credentials: { resolve: async () => ({ value: apiKey }) },
    fetchImpl: async () => new Response('{"data":[]}', { headers: { 'content-type': 'application/json' } }) });
  const session = { id: 'session', append: (type, data, options) => events.push({ type, data, ...options, seq: events.length + 1 }) };
  session.append('turn/start', { turn: 1 });
  const services = { sessions: { flush: async () => true }, llm: {}, sessionProjections: {
    register(definition) { definitions.set(definition.key, definition); return () => { definitions.delete(definition.key); unregisters++; }; },
    stateOf(_session, id) { const definition = definitions.get(id); return definition ? events.reduce(definition.apply, definition.init()) : undefined; },
  } };
  const ctx = { get: id => services[id] };
  const resolutions = [], builds = { resolve: async (agentId, buildId) => {
    resolutions.push({ agentId, buildId }); return { ...structuredClone(record),
      executionEngine: buildExecutionEngine(record.spec, 'agentkit.native-dsh-turn/v1') };
  } };
  const host = await createStudioNativeHarness({ ctx, storeDir, workspaceRoot, agents, builds, models, ledger,
    ...(recovery ? { agentEvents: () => ({ serial: async () => payload.binding }), assembleContextFor: agent => ({ agent }) } : {}),
    contextSourceRegistry: bridge?.nativeContextSources,
    renderPrompt: () => 'Trusted Host instructions', fetchImpl: async (url, options) => {
      requests.push({ url, options });
      const response = respond ? respond(requests.length, JSON.parse(options.body)) : { choices: [{ index: 0, delta: { content: 'Complete' }, finish_reason: 'stop' }] };
      return new Response(`data: ${JSON.stringify({ id: `response-${requests.length}`, ...response,
        usage: { prompt_tokens: 2, completion_tokens: 3 } })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    } });
  t.after(async () => { await host.close(); await bridge?.close(); ledger.close?.(); await rm(root, { recursive: true, force: true }); });
  const payload = { agent: { session, externalTurns: nativeOwnershipHost(session, events), options: { provider: 'agentkit-studio-fixture', model: 'pinned' } },
    input: { kind: 'enter', messages: [{ id: 'input-1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Finish' }] }], assembly: { tools: [] } },
    turn: 1, signal: new AbortController().signal, prepareInput: async () => ({ kind: 'enter', messages: [], assembly: payload.input.assembly }),
    binding: { agentId: record.metadata.id, agentRevision: 1, runtime: 'harness', local: true,
      nativeEngineContract: 'agentkit.native-dsh-turn/v1',
      nativeTools: { definitions: () => [], forAgent: () => ({ tools: { execute: async () => assert.fail('No tool dispatched') } }) } } };
  if (recovery) services.systemPrompt = { assemble: async () => payload.input.assembly };
  const head = () => {
    const scope = { tenantId: 'local', workspaceId: ledgerScope(), userId: 'local-user', agentId: record.metadata.id };
    return ledger.sessionHead(scope, 'session');
  };
  // The workspace identity is public deterministic configuration, not a path
  // read from user input. Keep the hash identical to production's scope key.
  const ledgerScope = () => createHash('sha256').update(JSON.stringify(workspaceRoot)).digest('hex');
  return { root, host, payload, record, agents, builds, resolutions, models, values, requests, ledger, head, events, services,
    bridge, retireContext,
    rotate: key => { apiKey = key; }, unregisters: () => unregisters };
}

for (const deliveryReviewPolicy of [undefined, { pathSuffixes: ['.ts'] }]) test(`managed binding reuses real Studio assembly with its own ledger and trusted principal${deliveryReviewPolicy ? ' and pinned review policy' : ''}`, async t => {
  const f = await setup(t, { recovery: true, ...(deliveryReviewPolicy ? { spec: { execution: { deliveryReviewPolicy } } } : {}) }), store = new MemoryRunStore();
  const target = { tenantId: 'managed-tenant', agentInstanceId: f.record.metadata.id };
  const principal = { userId: 'managed-user' }, runId = 'managed-real-run';
  const args = { store, admission: null, runId, target, principal };
  const bound = await f.host.resolveManagedBinding(f.payload, args);
  const scope = bound.scope;
  assert.equal(bound.configuration.outputRecoveryPolicy, 'task-or-delivery/v1');
  assert.equal(bound.configuration.toolErrorRecoveryPolicy, 'diagnose-before-repeat/v1');
  assert.equal(Object.hasOwn(bound.configuration, 'toolErrorRecoveryModelCalls'), false);
  if (deliveryReviewPolicy) assert.deepEqual(bound.configuration.deliveryReviewPolicy,
    { pathSuffixes: ['.ts'], maxRounds: 2, maxReadRounds: 2, reviewUnknownPaths: true });
  assert.equal(scope.tenantId, target.tenantId); assert.equal(scope.userId, principal.userId);
  assert.equal(scope.agentId, target.agentInstanceId);
  const kernel = new NativeKernel({ store, ports: bound.ports, owner: 'managed-test-owner', digest });
  kernel.start({ scope, runId, sessionId: f.payload.agent.session.id, turnId: 'managed-command',
    buildId: bound.buildId, parentRunId: null, taskChainId: runId }, bound.configuration);
  const done = await kernel.runUntilIdle(scope, runId);
  assert.equal(done.phase, 'completed'); assert.equal(f.requests.length, 1);
  assert.equal(f.head(), null, 'managed effects must not enter the local Native ledger');
  await bound.releaseResources?.({ scope, runId, sessionId: done.sessionId });
  const admission = { scope, buildId: bound.buildId, configuration: bound.configuration };
  const restored = await f.host.resolveManagedBinding(f.payload, { ...args, admission });
  assert.deepEqual(restored.configuration, bound.configuration);
  assert.equal(f.requests.length, 1, 'binding restoration must not invoke the model');
  await restored.releaseResources?.({ scope, runId, sessionId: done.sessionId });
  for (const changes of [{ target: { ...target, tenantId: 'other' } }, { principal: { userId: 'other' } }])
    await assert.rejects(f.host.resolveManagedBinding(f.payload, { ...args, admission, ...changes }),
      { code: 'NATIVE_MANAGED_STUDIO_TARGET_CHANGED' });
});

for (const frozen of [false, true]) test(`shared Native Host ${frozen ? 'Frozen Build' : 'Revision'} delivers after a real model output restart`, async t => {
  const f = await setup(t, { sqlite: true, respond: count => ({ choices: [{ index: 0,
    delta: { content: count <= 4 ? '{"unfinished":' : 'Complete delivered answer.' }, finish_reason: count <= 4 ? 'length' : 'stop' }] }) });
  if (frozen) f.payload.binding.buildId = 'output-recovery-build';
  await f.host.executeTurn(f.payload);
  const record = f.ledger.load(f.head().scope, f.head().runId);
  assert.equal(record.configuration.outputRecoveryPolicy, 'task-or-delivery/v1');
  assert.equal(record.snapshot.phase, 'completed'); assert.equal(record.snapshot.finalText, 'Complete delivered answer.');
  assert.equal(record.snapshot.outputRestarts, 1); assert.equal(f.requests.length, 5);
  assert.match(JSON.stringify(JSON.parse(f.requests[4].options.body).messages), /output limit repeatedly/);
  assert.equal(record.events.filter(event => event.kind === 'output.restarted').length, 1);
  const assistants = f.events.filter(event => event.type === 'assistant/message');
  assert.ok(assistants.some(event => event.data.message.content.some(part => part.type === 'text' && part.text === 'Complete delivered answer.')));
  assert.equal(assistants.filter(event => event.data.message.content.some(part => part.type === 'text' && part.text === 'Complete delivered answer.')).length, 1);
  if (frozen) assert.ok(f.resolutions.some(value => value.buildId === 'output-recovery-build'));
});

for (const frozen of [false, true]) test(`shared Native Host ${frozen ? 'Frozen Build' : 'Revision'} diagnoses real errors before correcting a file`, async t => {
  const f = await setup(t, { sqlite: true, spec: { execution: { toolErrorRecoveryModelCalls: 3 } },
    respond: count => ({ choices: [{ index: 0, delta: count < 9 ? { tool_calls: [{ index: 0, id: `diagnostic-${count}`, type: 'function',
      function: { name: count === 7 ? 'read' : 'write', arguments: JSON.stringify({ text: count === 8 ? 'corrected' : 'wrong' }) } }] }
      : { content: 'Corrected result delivered.' }, finish_reason: count < 9 ? 'tool_calls' : 'stop' }] }) });
  const file = join(f.root, 'workspace/result.txt'), executed = [];
  f.payload.binding.nativeTools = { definitions: () => [tool({ name: 'write', readOnly: false, concurrentSafe: false }),
    tool({ name: 'read', contextRole: 'workspace_read' })], forAgent: () => ({ tools: { execute: async request => {
      executed.push(request.call.name);
      if (request.call.name === 'read') return { status: 'ok', content: { actual: await readFile(file, 'utf8') } };
      if (request.call.arguments.text !== 'corrected') return { status: 'error', content: { code: 'exact_content_mismatch' } };
      await writeFile(file, 'correct'); return { status: 'ok', content: 'written', workspaceChangedPaths: ['result.txt'] };
    } } }) };
  await writeFile(file, 'old');
  if (frozen) f.payload.binding.buildId = 'diagnostic-recovery-build';
  await f.host.executeTurn(f.payload);
  const record = f.ledger.load(f.head().scope, f.head().runId);
  assert.equal(record.configuration.toolErrorRecoveryPolicy, 'diagnose-before-repeat/v1');
  assert.equal(record.configuration.toolErrorRecoveryModelCalls, 3); assert.equal(record.snapshot.toolErrorRecovery, null);
  assert.equal(record.snapshot.finalText, 'Corrected result delivered.'); assert.equal(await readFile(file, 'utf8'), 'correct');
  assert.deepEqual(executed, [...Array(6).fill('write'), 'read', 'write']); assert.equal(f.requests.length, 9);
  assert.equal(record.events.filter(event => event.kind === 'tool.error_recovery_started').length, 1);
  assert.match(JSON.stringify(JSON.parse(f.requests[6].options.body).messages), /diagnosis_is_not_completion/);
  assert.equal(f.events.filter(event => event.type === 'tool/result').length, 8);
  if (frozen) assert.ok(f.resolutions.some(value => value.buildId === 'diagnostic-recovery-build'));
});

test('shared Native Host rejects an invalid diagnostic allowance before inference', async t => {
  const f = await setup(t, { spec: { execution: { toolErrorRecoveryModelCalls: 0 } } });
  await assert.rejects(f.host.executeTurn(f.payload), { code: 'invalid_tool_error_recovery_model_calls' });
  assert.equal(f.requests.length, 0);
});

for (const frozen of [false, true]) test(`shared Native ${frozen ? 'Frozen Build' : 'Revision'} Host keeps model-assisted delivery review private and repairs actual source`, async t => {
  const reviewData = findings => ({ requirements: [{ requirement: 'PRIVATE_REVIEW_BODY', implementation_evidence: 'ledger.ts',
    verification_evidence: 'Semantic acceptance unavailable.' }], findings });
  const f = await setup(t, { sqlite: true, spec: { execution: { deliveryReviewPolicy: { pathSuffixes: ['.ts'] } } }, respond: count => {
    if ([1, 4].includes(count) || [3, 6].includes(count)) return { choices: [{ index: 0, delta: { tool_calls: [{ index: 0,
      id: `review-flow-${count}`, type: 'function', function: { name: [1, 4].includes(count) ? 'write' : 'submit_delivery_review',
        arguments: JSON.stringify([1, 4].includes(count) ? { text: count === 1 ? 'broken' : 'fixed zero case' }
          : reviewData(count === 3 ? [{ issue: 'Missing zero case.', recommended_check: 'Inspect and repair the source.' }] : [])) } }] }, finish_reason: 'tool_calls' }] };
    return { choices: [{ index: 0, delta: { content: count === 2 ? 'Candidate.' : 'Repaired.' }, finish_reason: 'stop' }] };
  } });
  const file = join(f.root, 'workspace', 'ledger.ts');
  f.payload.binding.nativeTools = { definitions: () => [tool({ name: 'write', readOnly: false, concurrentSafe: false })],
    forAgent: () => ({ workspace: { observe: async () => ({ status: 'ok', changedPaths: [],
      revision: createHash('sha256').update(await readFile(file).catch(error => {
        if (error.code === 'ENOENT') return Buffer.alloc(0); throw error;
      })).digest('hex') }) }, tools: { execute: async request => { await writeFile(file, request.call.arguments.text);
      return { status: 'ok', content: 'written', workspaceChangedPaths: ['ledger.ts'] }; } } }) };
  if (frozen) f.payload.binding.buildId = 'review-build';
  await f.host.executeTurn(f.payload);
  const record = f.ledger.load(f.head().scope, f.head().runId);
  assert.equal(record.snapshot.usage.modelCalls, 6, JSON.stringify({ reason: record.snapshot.reason,
    policy: record.configuration.deliveryReviewPolicy, status: record.snapshot.workspaceObservationStatus,
    paths: record.snapshot.workspaceModifiedPaths, mutation: record.snapshot.lastWorkspaceMutationToolCall,
    review: record.snapshot.deliveryReview, limits: record.configuration.limits })); assert.equal(record.snapshot.usage.toolCalls, 2);
  assert.equal(record.snapshot.repairs, 1); assert.equal(record.snapshot.finalText, 'Repaired.'); assert.equal(record.snapshot.outcome, 'unverified');
  assert.equal(record.snapshot.deliveryReview.rounds, 2); assert.equal(await readFile(file, 'utf8'), 'fixed zero case');
  assert.deepEqual(record.configuration.deliveryReviewPolicy, { pathSuffixes: ['.ts'], maxRounds: 2, maxReadRounds: 2, reviewUnknownPaths: true });
  assert.deepEqual(f.requests.map(request => JSON.parse(request.options.body).tools?.map(definition => definition.function.name))
    .filter((_tools, index) => [2, 5].includes(index)), [['submit_delivery_review'], ['submit_delivery_review']]);
  assert.equal(f.events.filter(event => event.type === 'tool/result').length, 2);
  assert.equal(JSON.stringify(f.events).includes('PRIVATE_REVIEW_BODY'), false);
  if (frozen) assert.ok(f.resolutions.some(value => value.buildId === 'review-build'));
});

test('managed discovery releases its Session resources before an ordinary Native turn can bind', async t => {
  const f = await setup(t, { recovery: true }), store = new MemoryRunStore();
  const target = { tenantId: 'managed-tenant', agentInstanceId: f.record.metadata.id };
  const bound = await f.host.resolveManagedBinding(f.payload, { store, admission: null, runId: 'preview-run',
    target, principal: { userId: 'managed-user' } });
  const ordinary = f.host.executeTurn(f.payload);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.requests.length, 0, 'ordinary resources must wait for the discovery lease');
  await bound.releaseResources?.({ scope: bound.scope, sessionId: f.payload.agent.session.id, runId: 'preview-run' });
  await ordinary;
  assert.equal(f.requests.length, 1); assert.equal(f.head().phase, 'completed');
});

test('managed multipart admission persists image bytes and file context; SQLite recovery never reopens expired receipts', async t => {
  const f = await setup(t, { recovery: true, profile: { input: ['text', 'image'] } });
  const store = new SqliteRunStore(join(f.root, 'managed.sqlite'));
  const target = { tenantId: 'managed-tenant', agentInstanceId: f.record.metadata.id };
  const agent = f.payload.agent; agent.whenIdle = async () => {};
  f.services.sessionController = { resolveAgent: async () => ({ agent }) };
  const receiptId = '08719d71-2117-40f9-9a74-b59ca0337194';
  let uploads = 0, admissions = 0, images = 0, files = 0;
  const ref = { attachmentId: 'owned-file', bytes: 10, name: 'source.txt' };
  f.services.fileUploads = { resolve(receiver, id) { uploads++; assert.equal(receiver, agent); assert.equal(id, receiptId); return ref; },
    bindPrompt: () => ({ commit() {}, [Symbol.dispose]() {} }), retirePrompt() {} };
  f.services.attachments = { async admitPromptContent(parts) {
    admissions++; assert.deepEqual(parts[2], { type: 'file', attachment: ref });
    return parts.map(part => part.type === 'image' ? { type: 'image', attachment: { attachmentId: 'owned-image' } } : part);
  }, async readImageRequest(image) { images++; assert.equal(image.attachmentId, 'owned-image'); return { mediaType: 'image/png', data: Uint8Array.of(1, 2, 3) }; } };
  f.services.llm.fileRequestText = file => { files++; assert.deepEqual(file, ref); return 'Original admitted file context'; };
  const resolve = createStudioManagedNativeBinding({ ctx: { get: id => f.services[id] }, target, principal: { userId: 'managed-user' },
    resolveHost: async () => f.host, execution: { run: request => request.execute({ signal: f.payload.signal,
      prepareInput: async () => ({ kind: 'enter', messages: [], assembly: f.payload.input.assembly }) }) } });
  const command = { command_id: 'managed-media-command', tenant_id: target.tenantId, agent_instance_id: target.agentInstanceId,
    session_id: agent.session.id, command_type: 'enqueue', payload: { content: { format: STUDIO_MANAGED_NATIVE_INPUT,
      parts: [{ type: 'text', text: 'Inspect original attachments' },
        { type: 'image', mediaType: 'image/png', data: 'AQID' }, { type: 'file', receiptId }] } } };
  const request = { command, signal: f.payload.signal, store, runId: 'managed-media-run', stage: 'admit', admission: null };
  const initial = await resolve(request), scope = initial.scope;
  const identity = { scope, runId: request.runId, sessionId: agent.session.id, turnId: command.command_id,
    buildId: initial.buildId, parentRunId: null, taskChainId: request.runId };
  new NativeKernel({ store, ports: initial.ports, owner: 'managed-media-owner', digest }).start(identity, initial.configuration);
  const admission = { scope, buildId: initial.buildId, configuration: initial.configuration };
  await initial.release(request); store.close();
  const expired = () => assert.fail('recovery must use the original admitted input');
  f.services.fileUploads.resolve = expired; f.services.attachments.admitPromptContent = expired;
  f.services.attachments.readImageRequest = expired; f.services.llm.fileRequestText = expired;
  const reopened = new SqliteRunStore(join(f.root, 'managed.sqlite')); t.after(() => reopened.close());
  const resumedRequest = { ...request, store: reopened, stage: 'execute', admission };
  const resumed = await resolve(resumedRequest);
  const kernel = new NativeKernel({ store: reopened, ports: resumed.ports, owner: 'managed-media-owner', digest });
  const done = await resumed.withExecution({ identity, configuration: resumed.configuration, signal: f.payload.signal,
    execute: () => kernel.runUntilIdle(scope, request.runId) });
  await resumed.release(resumedRequest);
  assert.equal(done.phase, 'completed'); assert.equal(f.head(), null); assert.equal(f.requests.length, 1);
  assert.deepEqual({ uploads, admissions, images, files }, { uploads: 1, admissions: 1, images: 1, files: 1 });
  const user = JSON.parse(f.requests[0].options.body).messages.findLast(message => message.role === 'user');
  assert.deepEqual(user.content, [{ type: 'text', text: 'Inspect original attachments\nOriginal admitted file context' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AQID', detail: 'auto' } }]);
  assert.deepEqual(reopened.load(scope, request.runId).configuration.inputMessages[0].media,
    [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } }]);
});

const contextRegistration = (record, extra = {}) => ({ sourceRef: 'plugin://host-context-proof@1',
  sourceDigest: 'sha256:' + 'e'.repeat(64), agentIds: [record.metadata.id], authorizationVersion: 'policy/v1',
  configuration: { contract: STUDIO_NATIVE_CONTEXT_SOURCES_CONTRACT, sources: [{ sourceId: 'host.proof',
    priority: 3, timeoutMs: 1000, required: true, maxTokens: 1000, maxBytes: 16000 }] },
  authorize: async () => 'allow', callback: async () => ({ items: [{ content: 'SOURCE_DATA_CANNOT_GRANT_APPROVAL' }] }), ...extra });

for (const frozen of [false, true]) test(`Native Host binds a separate screenshot model to the original tool receipt (Frozen=${frozen})`, async t => {
  const h = await setup(t, { sqlite: true, spec: { bindings: { visionModelProfileId: 'observer' } },
    respond: (_count, body) => ({ choices: [{ index: 0,
      delta: body.model === 'screenshot-model' ? { content: 'Visible login form' }
        : body.messages.some(message => message.role === 'tool') ? { content: 'Finished' }
          : { tool_calls: [{ index: 0, id: 'inspect-page', type: 'function',
            function: { name: 'browser_inspect_workspace', arguments: '{"path":"app.html"}' } }] },
      finish_reason: body.model === 'screenshot-model' || body.messages.some(message => message.role === 'tool') ? 'stop' : 'tool_calls' }] }) });
  h.values.modelProfiles.push({ id: 'observer', provider: 'openai-compatible', modelName: 'screenshot-model',
    baseUrl: 'https://observer.invalid/v1', input: ['text', 'image'], requestTimeoutMs: 150000 });
  let browserCalls = 0, releases = 0;
  h.payload.binding.nativeTools = { definitions: () => [studioBrowserDefinition()], releaseSession: async () => { releases++; },
    forAgent: () => ({ tools: { execute: async () => {
      browserCalls++;
      return { status: 'ok', content: { page: 'app.html' }, context: { content: 'Observed page', media: [{
        type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } }] },
        resourceUsage: { modelCalls: 0, toolCalls: 1, inputTokens: 0, outputTokens: 0, cost: 0 } };
    } } }) };
  if (frozen) h.payload.binding.buildId = 'vision-build';
  await h.host.executeTurn(h.payload);
  const original = h.ledger.load(h.head().scope, h.head().runId);
  assert.equal(original.snapshot.phase, 'completed');
  assert.deepEqual(h.requests.map(request => JSON.parse(request.options.body).model), ['pinned', 'screenshot-model', 'pinned']);
  assert.equal(h.requests[1].url, 'https://observer.invalid/v1/chat/completions');
  const observed = JSON.parse(h.requests[1].options.body);
  assert.match(JSON.stringify(observed.messages), /observation_context/);
  assert.match(JSON.stringify(observed.messages), /Finish/);
  assert.equal(JSON.stringify(observed.tools ?? []).includes('browser_inspect_workspace'), false);
  const receipt = original.receipts.flatMap(receipt => receipt.result?.results ?? []).find(result => result.content?.vision_description);
  assert.equal(receipt.content.vision_description, 'Visible login form');
  assert.equal(receipt.content.vision_description_trust, 'untrusted_model_output');
  assert.equal(receipt.resourceUsage.modelCalls, 1);
  assert.equal(original.snapshot.usage.modelCalls, 2);
  assert.equal(original.snapshot.descendantUsage.modelCalls, 1);
  assert.equal(original.configuration.limits.finalizationReserveModelCalls, 2);
  assert.ok(original.configuration.limits.effectTimeoutMs >= 270000);
  assert.equal(original.configuration.profile.profileId, 'fixture');
  assert.equal(JSON.stringify(original.configuration).includes('secret-one'), false);
  assert.equal(browserCalls, 1); assert.equal(releases, 1);
  if (frozen) assert.equal(h.resolutions[0].buildId, 'vision-build');
});

test('Native Host rejects a missing or non-image observer before starting a Run', async t => {
  const h = await setup(t, { spec: { bindings: { visionModelProfileId: 'observer' } } });
  await assert.rejects(h.host.executeTurn(h.payload), { code: 'MODEL_NOT_FOUND' });
  h.values.modelProfiles.push({ id: 'observer', provider: 'openai-compatible', modelName: 'text-only', baseUrl: 'https://observer.invalid/v1' });
  await assert.rejects(h.host.executeTurn(h.payload), /studio_native_vision_model_image_input_required/);
  assert.equal(h.head(), null); assert.equal(h.requests.length, 0);
});

test('observer configuration drift after browser execution cannot call a replacement endpoint', async t => {
  const h = await setup(t, { sqlite: true, spec: { bindings: { visionModelProfileId: 'observer' } },
    respond: count => ({ choices: [{ index: 0, delta: count === 1
      ? { tool_calls: [{ index: 0, id: 'browser', type: 'function', function: { name: 'browser_inspect_workspace', arguments: '{"path":"app.html"}' } }] }
      : { content: 'Finished' }, finish_reason: count === 1 ? 'tool_calls' : 'stop' }] }) });
  const profile = { id: 'observer', provider: 'openai-compatible', modelName: 'screenshot-model',
    baseUrl: 'https://observer.invalid/v1', input: ['text', 'image'] };
  h.values.modelProfiles.push(profile);
  let browserCalls = 0;
  h.payload.binding.nativeTools = { definitions: () => [studioBrowserDefinition()], forAgent: () => ({ tools: {
    execute: async () => { browserCalls++; profile.baseUrl = 'https://replacement.invalid/v1';
      return { status: 'ok', content: { page: 'app.html' }, context: { content: 'Observed', media: [{
        type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } }] } }; },
  } }) };
  await h.host.executeTurn(h.payload);
  assert.equal(browserCalls, 1); assert.equal(h.requests.length, 2);
  assert.ok(h.requests.every(request => request.url === 'https://model.invalid/v1/chat/completions'));
  const record = h.ledger.load(h.head().scope, h.head().runId);
  const result = record.receipts.flatMap(receipt => receipt.result?.results ?? []).find(result => result.content?.page);
  assert.equal(result.status, 'ok', 'known browser execution remains the authoritative result');
  assert.equal(result.content.vision_description_status, 'unavailable');
  assert.equal(result.resourceUsageReported, false, 'missing model usage is not presented as known zero');
});

for (const reported of [true, false]) test(`Native usage view preserves tool counters and completeness=${reported} after SQLite reopen without execution`, async t => {
  const h = await setup(t, { sqlite: true, respond: count => ({ choices: [{ index: 0,
    delta: count === 1 ? { tool_calls: [{ index: 0, id: 'nested-model', type: 'function',
      function: { name: 'inspect', arguments: '{}' } }] } : { content: 'Finished' },
    finish_reason: count === 1 ? 'tool_calls' : 'stop' }] }) });
  let calls = 0;
  h.payload.binding.nativeTools = { definitions: () => [tool({ name: 'inspect' })],
    forAgent: () => ({ tools: { execute: async () => {
      calls++;
      return { status: 'ok', content: 'PRIVATE_TOOL_CONTENT',
        resourceUsage: { modelCalls: 1, toolCalls: 2, inputTokens: 7, outputTokens: 9, cost: .25,
          cachedInputTokens: 3, reasoningTokens: 4 }, resourceUsageReported: reported };
    } } }) };
  h.services.sessionController = { resolveAgent: async id => {
    assert.equal(id, h.payload.agent.session.id); return { agent: h.payload.agent };
  } };
  await h.host.executeTurn(h.payload);
  h.payload.agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  const request = { agentId: h.record.metadata.id, sessionId: h.payload.agent.session.id };
  const status = await h.host.recoveryStatus(request);
  assert.equal(status.state, 'closed'); assert.equal(status.canResume, false);
  assert.equal(status.runId, h.head().runId, 'status without a Run id still finds the original completed head');
  assert.equal(status.accounting.contract, 'agentkit.studio-native-usage/v1');
  assert.equal(status.accounting.final, true); assert.equal(status.accounting.complete, reported);
  assert.equal(status.accounting.incomplete, !reported);
  assert.equal(status.accounting.own.modelCalls, 2); assert.equal(status.accounting.descendant.modelCalls, 1);
  assert.deepEqual(status.accounting.total, { modelCalls: 3, toolCalls: 3, inputTokens: 11, outputTokens: 15,
    cost: .25, cachedInputTokens: 3, reasoningTokens: 4 });
  assert.equal(JSON.stringify(status).includes('PRIVATE_TOOL_CONTENT'), false);
  assert.equal(JSON.stringify(status).includes('secret-one'), false);
  status.accounting.total.modelCalls = 99;
  const expected = (await h.host.recoveryStatus(request)).accounting;
  assert.equal(expected.total.modelCalls, 3, 'returned accounting is detached from the ledger');
  await h.host.close(); h.ledger.close();
  const reopened = new SqliteRunStore(join(h.root, 'runs.sqlite'));
  const cold = await createStudioNativeHarness({ ctx: { get: id => h.services[id] }, storeDir: h.root,
    workspaceRoot: join(h.root, 'workspace'), agents: h.agents, models: h.models, ledger: reopened,
    renderPrompt: () => assert.fail('reading usage never assembles a replacement prompt'),
    fetchImpl: () => assert.fail('reading usage never calls a model') });
  t.after(async () => { await cold.close(); reopened.close(); });
  const route = createSessionRoutes({ getNativeHost: async () => cold });
  const observed = (await route('sessions/native-recovery-status', request)).value;
  assert.deepEqual(observed.accounting, expected); assert.equal(observed.state, 'closed');
  const foreign = await cold.recoveryStatus({ ...request, agentId: 'other-agent' });
  assert.equal(foreign.accounting, null); assert.equal(foreign.runId, null);
  assert.equal(calls, 1); assert.equal(h.requests.length, 2);
  await cold.close(); reopened.close();
});

// Actual Host, model HTTP codec, NativeKernel, canonical receipts and SQLite;
// command transport and DSH Session lifecycle are explicit test doubles.
async function backgroundHost(t, { frozen = false, nested = false } = {}) {
  const h = await setup(t, { sqlite: true, recovery: true,
    spec: { execution: { nativeLimits: { maxModelCalls: 12, maxToolCalls: 8 } } },
    respond: count => ({ choices: [{ index: 0, delta: count === 1 || nested && count === 3
      ? { tool_calls: [{ index: 0, id: `launch-${count}`, type: 'function', function: { name: 'run_command', arguments: '{}' } }] }
      : { content: 'Complete' }, finish_reason: count === 1 || nested && count === 3 ? 'tool_calls' : 'stop' }] }) });
  const launch = tool({ name: 'run_command', readOnly: false, concurrentSafe: false,
    backgroundCommandPolicy: 'owned-command-launch/v1' });
  let launches = 0, releases = 0;
  h.payload.binding.nativeTools = { definitions: () => [structuredClone(launch)],
    commandBinding: { contract: 'fixture/owned-command/v1' }, releaseSession: async () => { releases++; },
    forAgent: () => ({ tools: { execute: async request => ({ status: 'ok', content: { backend: 'sandbox/local_process' },
      backgroundCommandRef: { taskId: (++launches).toString(16).padStart(64, '0'),
        sourceRunId: request.runId, operationKey: request.operationKey } }) },
      background: { contract: BACKGROUND_COMMAND_CONTRACT, observe: async () => [] } }) };
  if (frozen) h.payload.binding.buildId = 'frozen-background-build';
  await h.host.executeTurn(h.payload);
  const source = h.ledger.load(h.head().scope, h.head().runId);
  assert.equal(source.snapshot.phase, 'completed'); assert.equal(launches, 1);
  h.payload.agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  const notice = async (record, turn) => {
    const command = record.snapshot.backgroundCommands.find(row => row.ref.sourceRunId === record.snapshot.runId);
    assert.ok(command);
    const admitted = await admitBackgroundNotification({ store: h.ledger, scope: record.snapshot.scope,
      sourceRunId: record.snapshot.runId, taskId: command.ref.taskId, digest, signal: h.payload.signal,
      observe: async request => backgroundCommandObservation({ ref: request.ref, status: 'completed', exitCode: 0,
        stdout: 'COMMAND_OUTPUT_IS_UNTRUSTED' }) });
    const saved = h.ledger.load(record.snapshot.scope, admitted.snapshot.runId);
    const ownership = nativeDshBackgroundOwnership({ record: saved, turn });
    h.payload.agent.session.append('turn/start', { turn });
    h.payload.agent.externalTurns.claim(ownership);
    return { saved, payload: { agent: h.payload.agent, turn, ownership, signal: h.payload.signal,
      prepareInput: h.payload.prepareInput } };
  };
  return { ...h, source, notice, counts: () => ({ launches, releases }) };
}

for (const frozen of [false, true]) test(`background Host restores ${frozen ? 'Frozen Build' : 'Revision'} ports and reduced budgets without replaying user input`, async t => {
  const h = await backgroundHost(t, { frozen }), n = await h.notice(h.source, 17);
  h.rotate('rotated-background-key');
  assert.deepEqual(await h.host.executeBackgroundTurn(n.payload), { reason: { kind: 'completed' } });
  const result = h.ledger.load(h.source.snapshot.scope, n.saved.snapshot.runId);
  assert.equal(result.snapshot.phase, 'completed'); assert.equal(result.snapshot.usage.modelCalls, 1);
  assert.equal(result.snapshot.turnId, n.saved.snapshot.runId);
  assert.equal(result.configuration.limits.maxModelCalls, 10);
  assert.deepEqual(result.configuration, n.saved.configuration);
  assert.deepEqual(h.ledger.load(h.source.snapshot.scope, h.source.snapshot.runId), h.source);
  assert.equal(h.requests.length, 3); assert.equal(h.counts().launches, 1);
  assert.equal(new Headers(h.requests[2].options.headers).get('authorization'), 'Bearer rotated-background-key');
  const wire = JSON.parse(h.requests[2].options.body);
  assert.ok(wire.messages.some(message => message.role === 'user' && message.content.includes('COMMAND_OUTPUT_IS_UNTRUSTED')));
  assert.equal(h.events.filter(event => event.type === 'user/message' && event.data.source?.kind === 'agentkit-native-background-notification').length, 1);
  assert.equal(h.events.filter(event => event.type === 'user/message' && event.data.source?.kind === 'user').length, 1);
  await h.host.executeBackgroundTurn(n.payload);
  assert.equal(h.requests.length, 3); assert.equal(h.counts().launches, 1);
  if (frozen) assert.ok(h.resolutions.every(item => item.buildId === 'frozen-background-build'));
});

test('background Host resolves original input across a completed notice ancestor', async t => {
  const h = await backgroundHost(t, { nested: true }), first = await h.notice(h.source, 17);
  await h.host.executeBackgroundTurn(first.payload);
  const firstResult = h.ledger.load(h.source.snapshot.scope, first.saved.snapshot.runId);
  assert.equal(firstResult.snapshot.phase, 'completed'); assert.equal(h.counts().launches, 2);
  h.payload.agent.session.append('turn/end', { turn: 17, reason: { kind: 'completed' } });
  const second = await h.notice(firstResult, 23);
  await h.host.executeBackgroundTurn(second.payload);
  const result = h.ledger.load(h.source.snapshot.scope, second.saved.snapshot.runId);
  assert.equal(result.snapshot.phase, 'completed'); assert.equal(result.configuration.limits.maxModelCalls, 8);
  assert.equal(result.snapshot.parentRunId, firstResult.snapshot.runId);
  assert.deepEqual(h.ledger.load(h.source.snapshot.scope, h.source.snapshot.runId), h.source);
  assert.equal(h.requests.length, 5); assert.equal(h.counts().launches, 2);
});

for (const drift of ['revision', 'model', 'tools']) test(`background Host rejects actual ${drift} binding drift before another model effect`, async t => {
  const h = await backgroundHost(t), n = await h.notice(h.source, 17), before = h.counts().releases;
  if (drift === 'revision') h.payload.binding.agentRevision++;
  if (drift === 'model') h.values.modelProfiles[0].parameters = { temperature: .7 };
  if (drift === 'tools') h.payload.binding.nativeTools.definitions = () => [];
  await assert.rejects(h.host.executeBackgroundTurn(n.payload), /recovery_(preset_changed|configuration_changed)/);
  assert.equal(h.requests.length, 2); assert.equal(h.counts().launches, 1);
  assert.equal(h.ledger.load(h.source.snapshot.scope, n.saved.snapshot.runId).snapshot.phase, 'created');
  if (drift !== 'revision') assert.equal(h.counts().releases, before + 1);
});

test('background Host product recovery keeps the numeric DSH position and original notice across an owner flush failure', async t => {
  const h = await backgroundHost(t), n = await h.notice(h.source, 17);
  h.services.sessionController = { resolveAgent: async id => { assert.equal(id, h.payload.agent.session.id); return { agent: h.payload.agent }; } };
  let running, resumes = 0;
  h.payload.agent.externalTurns.resume = async (engine, execute) => {
    resumes++; assert.equal(engine, n.payload.ownership.engine);
    running = execute({ ownership: h.payload.agent.externalTurns.pending(), turn: 17,
      signal: n.payload.signal, prepareInput: h.payload.prepareInput });
    const ending = await running;
    h.payload.agent.session.append('turn/end', { turn: 17, ...ending });
    return ending;
  };
  const request = { agentId: h.record.metadata.id, sessionId: 'session', runId: n.saved.snapshot.runId };
  const route = createSessionRoutes({ getNativeHost: async () => h.host });
  const status = await h.host.recoveryStatus(request);
  assert.equal(status.turn, 17); assert.equal(status.state, 'available'); assert.equal(status.canResume, true);
  h.services.sessions.flush = async () => false;
  await assert.rejects(route('sessions/native-recovery-resume', request), /ownership_not_durable/);
  assert.equal(h.requests.length, 2);
  assert.equal(h.payload.agent.externalTurns.pending().turn, 17);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await h.host.recoveryStatus(request)).state, 'failed');
  h.services.sessions.flush = async () => true;
  const ack = (await route('sessions/native-recovery-resume', request)).value;
  assert.equal(ack.state, 'recovering'); assert.equal(ack.turn, 17);
  await running; await new Promise(resolve => setImmediate(resolve));
  assert.equal((await h.host.recoveryStatus(request)).state, 'closed');
  assert.equal(h.ledger.load(h.source.snapshot.scope, request.runId).snapshot.phase, 'completed');
  assert.equal(resumes, 2); assert.equal(h.requests.length, 3); assert.equal(h.counts().launches, 1);
  assert.equal(h.events.filter(event => event.type === 'turn/start').length, 2);
  assert.equal(h.events.filter(event => event.type === 'turn/end' && event.data.turn === 17).length, 1);
});

test('background Host close during prompt rebinding cancels the existing notice without executing a model', async t => {
  const h = await backgroundHost(t), n = await h.notice(h.source, 17), entered = Promise.withResolvers(), release = Promise.withResolvers();
  h.services.systemPrompt.assemble = async () => { entered.resolve(); await release.promise; return h.payload.input.assembly; };
  const executing = h.host.executeBackgroundTurn(n.payload), failed = assert.rejects(executing, /Studio Native host closed/);
  await entered.promise; await h.host.close(); await failed;
  release.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.requests.length, 2); assert.equal(h.counts().launches, 1);
  const saved = h.ledger.load(h.source.snapshot.scope, n.saved.snapshot.runId);
  assert.ok(saved.commands.some(row => row.command.commandId === `${saved.snapshot.runId}:dsh-turn-cancel`));
  assert.equal(saved.snapshot.phase, 'created');
});

// SDK start is a fault-controllable lifecycle double here. The maintained SDK
// suite must separately prove its real reservation and JSONL durability.
async function idleBackgroundHost(t, { afterPrepare, read } = {}) {
  const h = await backgroundHost(t), agent = h.payload.agent;
  let starts = 0, reads = 0, status = 'running', nextTurn = 16;
  let sdkSignal = new AbortController();
  agent.status = 'idle';
  agent.externalTurns.idleAdmissionContract = 'dsh.external-turn-start/v1';
  agent.externalTurns.start = async (prepare, execute) => {
    assert.equal(agent.status, 'idle'); agent.status = 'running';
    const turn = ++nextTurn; starts++;
    agent.session.append('turn/start', { turn });
    let owned = false;
    try {
      const ownership = await prepare({ turn, signal: sdkSignal.signal });
      await afterPrepare?.({ ownership, signal: sdkSignal });
      sdkSignal.signal.throwIfAborted();
      agent.externalTurns.claim(ownership); owned = true;
      const ending = await execute({ ownership, turn, signal: sdkSignal.signal, prepareInput: h.payload.prepareInput });
      agent.session.append('turn/end', { turn, ...ending }); return ending;
    } catch (error) {
      if (!owned) agent.session.append('turn/end', { turn, reason: { kind: 'error', error: { message: error.message } } });
      throw error;
    } finally { agent.status = 'idle'; }
  };
  h.payload.binding.nativeTools.backgroundObserver = (_agent, authority) => {
    assert.equal(_agent, agent);
    return createBackgroundCommandPort({ ...authority, readers: { local_process: async request => {
      reads++; if (read) await read(request);
      return status === 'running' ? { status } : { status, exitCode: status === 'completed' ? 0 : null,
        stdout: 'OBSERVED_REAL_COMMAND_RESULT', stderr: '', stdoutCursor: 28, stderrCursor: 0 };
    } } });
  };
  const request = { agent, agentId: h.record.metadata.id, sourceRunId: h.source.snapshot.runId,
    taskId: h.source.snapshot.backgroundCommands[0].ref.taskId };
  return { ...h, request, setStatus: value => { status = value; }, countsIdle: () => ({ starts, reads }),
    resetSignal: () => { sdkSignal = new AbortController(); } };
}

test('idle background Host waits for actual command completion and admits one typed notice without an inbox message', async t => {
  const h = await idleBackgroundHost(t);
  assert.equal((await h.host.notifyBackgroundCompletion(h.request)).status, 'watching');
  assert.deepEqual(h.countsIdle(), { starts: 0, reads: 1 }); assert.equal(h.requests.length, 2);
  assert.equal(h.ledger.list(h.source.snapshot.scope, 'session').length, 1);
  h.setStatus('completed');
  const result = await h.host.notifyBackgroundCompletion(h.request);
  assert.equal(result.status, 'admitted'); assert.equal(h.requests.length, 3);
  assert.equal(h.ledger.load(h.source.snapshot.scope, result.runId).snapshot.phase, 'completed');
  assert.deepEqual(h.countsIdle(), { starts: 1, reads: 3 });
  assert.equal((await h.host.notifyBackgroundCompletion(h.request)).status, 'discarded');
  assert.deepEqual(h.countsIdle(), { starts: 1, reads: 3 }); assert.equal(h.requests.length, 3);
  assert.equal(h.events.filter(row => row.type === 'user/message' && row.data.source?.kind === 'agentkit-native-background-notification').length, 1);
  assert.equal(h.events.filter(row => row.type === 'user/message' && row.data.source?.kind === 'user').length, 1);
  assert.deepEqual(h.ledger.load(h.source.snapshot.scope, h.source.snapshot.runId), h.source);
});

test('idle background Host reuses a persisted admission after prepare succeeded but ownership was not recorded', async t => {
  let fail = true;
  const h = await idleBackgroundHost(t, { afterPrepare: () => { if (fail) throw Error('owner append failed'); } });
  h.setStatus('completed');
  await assert.rejects(h.host.notifyBackgroundCompletion(h.request), /owner append failed/);
  const notice = h.head(); assert.equal(notice.phase, 'created'); assert.equal(h.requests.length, 2);
  assert.equal(h.payload.agent.externalTurns.pending(), null);
  fail = false;
  const result = await h.host.notifyBackgroundCompletion(h.request);
  assert.equal(result.runId, notice.runId); assert.equal(h.requests.length, 3);
  assert.deepEqual(h.countsIdle(), { starts: 2, reads: 2 }, 'the existing admission never re-observes or recreates the command');
  assert.equal(h.counts().launches, 1);
});

test('idle background Host persists cancellation between notice admission and owner recording', async t => {
  let cancel = true;
  const h = await idleBackgroundHost(t, { afterPrepare: ({ signal }) => { if (cancel) signal.abort({ kind: 'user' }); } });
  h.setStatus('completed');
  await assert.rejects(h.host.notifyBackgroundCompletion(h.request), reason => reason.kind === 'user');
  const notice = h.head(), saved = h.ledger.load(notice.scope, notice.runId);
  assert.deepEqual(saved.commands.find(row => row.command.kind === 'cancel').command.payload.dshCancelReason, { kind: 'user' });
  cancel = false; h.resetSignal();
  await h.host.notifyBackgroundCompletion(h.request);
  assert.equal(h.head().phase, 'canceled'); assert.equal(h.requests.length, 2);
  assert.deepEqual(h.countsIdle(), { starts: 2, reads: 2 }); assert.equal(h.counts().launches, 1);
});

test('idle background Host refuses concurrent admissions and close cancels a pending readonly probe', async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const h = await idleBackgroundHost(t, { read: async () => { entered.resolve(); await release.promise; } });
  const pending = h.host.notifyBackgroundCompletion(h.request);
  const rejected = assert.rejects(pending, /Studio Native host closed/);
  await entered.promise;
  await assert.rejects(h.host.notifyBackgroundCompletion(h.request), /background_already_active/);
  await h.host.close(); await rejected;
  release.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.countsIdle(), { starts: 0, reads: 1 }); assert.equal(h.requests.length, 2);
  assert.equal(h.ledger.list(h.source.snapshot.scope, 'session').length, 1);
});

test('idle background Host requires a real advertised idle capability and the original preset before reads or ownership', async t => {
  const h = await idleBackgroundHost(t); h.setStatus('completed');
  const capability = h.payload.agent.externalTurns.idleAdmissionContract;
  delete h.payload.agent.externalTurns.idleAdmissionContract;
  await assert.rejects(h.host.notifyBackgroundCompletion(h.request), /idle_ownership_host_required/);
  h.payload.agent.externalTurns.idleAdmissionContract = capability;
  h.payload.agent.status = 'running';
  await assert.rejects(h.host.notifyBackgroundCompletion(h.request), /background_session_busy/);
  h.payload.agent.status = 'idle'; h.payload.binding.agentRevision++;
  await assert.rejects(h.host.notifyBackgroundCompletion(h.request), /recovery_preset_changed/);
  assert.deepEqual(h.countsIdle(), { starts: 0, reads: 0 }); assert.equal(h.requests.length, 2);
  assert.equal(h.ledger.list(h.source.snapshot.scope, 'session').length, 1);
});

const backgroundWatchRequest = h => ({ scope: structuredClone(h.source.snapshot.scope), sessionId: 'session',
  sourceRunId: h.source.snapshot.runId, taskId: h.request.taskId });

test('background registry accepts a trusted configured home alias', async t => {
  const h = await setup(t, { storeAlias: true });
  const watcher = await h.host.startBackgroundWatcher();
  assert.equal(watcher.status().running, true);
  await access(join(h.root, 'native-harness/background-watches/registry.sqlite'));
  await watcher.close();
});

test('background registry still rejects a symlink inside the configured home', async t => {
  const h = await setup(t, { storeAlias: true });
  const outside = join(h.root, 'other-private-state');
  await mkdir(outside, { mode: 0o700 });
  await symlink(outside, join(h.root, 'native-harness'), 'dir');
  await assert.rejects(h.host.startBackgroundWatcher(), { code: 'background_state_symlink' });
});

test('production watcher discovers a committed SQLite source and automatically delivers its completion once', async t => {
  const h = await idleBackgroundHost(t);
  h.agents.list = () => assert.fail('production recovery must discover committed ledger scopes, not mutable drafts');
  h.services.sessionController = { resolveAgent: async id => {
    assert.equal(id, 'session'); return { agent: h.payload.agent };
  } };
  const watcher = await h.host.startBackgroundWatcher();
  assert.equal(watcher.status().running, true); assert.equal(watcher.status().pendingCount, 1);
  assert.equal(h.requests.length, 2); assert.equal(h.counts().launches, 1);
  h.setStatus('completed');
  const deadline = Date.now() + 5000;
  while (h.head().runId === h.source.snapshot.runId || h.head().phase !== 'completed') {
    assert.ok(Date.now() < deadline, 'automatic completion did not settle');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(h.requests.length, 3); assert.equal(h.counts().launches, 1);
  const notice = h.head();
  assert.equal(notice.backgroundNotification.sourceRunId, h.source.snapshot.runId);
  assert.equal(notice.backgroundNotification.taskId, h.request.taskId);
  assert.deepEqual(h.ledger.load(h.source.snapshot.scope, h.source.snapshot.runId), h.source);
  await watcher.close(); await watcher.close();
  const replacement = await h.host.startBackgroundWatcher();
  assert.equal(h.requests.length, 3); assert.equal(h.head().runId, notice.runId);
  assert.equal(replacement.status().pendingCount, 0, 'terminal delivery is not dispatched again');
  await replacement.close();
});

test('cold Host reopens the registry and original SQLite source before any new user input', async t => {
  const h = await idleBackgroundHost(t);
  h.services.sessionController = { resolveAgent: async id => {
    assert.equal(id, 'session'); return { agent: h.payload.agent };
  } };
  await h.host.startBackgroundWatcher();
  await h.host.close(); h.ledger.close();
  const ledger = new SqliteRunStore(join(h.root, 'runs.sqlite'));
  let modelCalls = 0;
  const cold = await createStudioNativeHarness({ ctx: { get: id => h.services[id] }, storeDir: h.root,
    workspaceRoot: join(h.root, 'workspace'), agents: h.agents, models: h.models, ledger,
    renderPrompt: () => 'Trusted Host instructions',
    agentEvents: () => ({ serial: async () => h.payload.binding }), assembleContextFor: agent => ({ agent }),
    fetchImpl: async () => {
      modelCalls++;
      return new Response('data: ' + JSON.stringify({ choices: [{ index: 0,
        delta: { content: 'Recovered completion' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 2, completion_tokens: 3 } }) + '\n\ndata: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } });
    } });
  t.after(async () => { await cold.close(); ledger.close(); });
  h.setStatus('completed');
  const watcher = await cold.startBackgroundWatcher();
  const notice = ledger.sessionHead(h.source.snapshot.scope, 'session');
  assert.equal(notice.phase, 'completed'); assert.equal(notice.finalText, 'Recovered completion');
  assert.equal(notice.backgroundNotification.sourceRunId, h.source.snapshot.runId);
  assert.equal(modelCalls, 1); assert.equal(h.counts().launches, 1);
  assert.equal(watcher.status().pendingCount, 1, 'admitted watch remains durable until terminal acknowledgement');
  await watcher.close();
  const second = await cold.startBackgroundWatcher();
  assert.equal(second.status().pendingCount, 0); assert.equal(modelCalls, 1);
  assert.equal(h.events.filter(row => row.type === 'user/message' && row.data.source?.kind === 'user').length, 1);
  assert.deepEqual(ledger.load(h.source.snapshot.scope, h.source.snapshot.runId), h.source);
  await cold.close(); ledger.close();
});

test('Host shutdown cancels a watcher cold lookup before closing its registry and ignores late return', async t => {
  const h = await idleBackgroundHost(t), entered = Promise.withResolvers(), released = Promise.withResolvers();
  h.services.sessionController = { resolveAgent: async () => {
    entered.resolve(); await released.promise; return { agent: h.payload.agent };
  } };
  const starting = h.host.startBackgroundWatcher();
  const refused = assert.rejects(starting, /Studio Native host closed/);
  await entered.promise; await h.host.close(); await refused;
  released.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.requests.length, 2); assert.equal(h.counts().launches, 1);
  assert.equal(h.ledger.list(h.source.snapshot.scope, 'session').length, 1);
  assert.deepEqual(h.countsIdle(), { starts: 0, reads: 0 });
  await assert.rejects(h.host.startBackgroundWatcher(), /studio_native_host_closed/);
});

test('persisted background dispatch resolves the original Session and reuses its source and notice', async t => {
  const h = await idleBackgroundHost(t), lookups = [];
  h.services.sessionController = { resolveAgent: async id => { lookups.push(id); return { agent: h.payload.agent }; } };
  const request = backgroundWatchRequest(h);
  assert.equal((await h.host.dispatchBackgroundCompletion(request)).status, 'watching');
  h.setStatus('completed');
  const result = await h.host.dispatchBackgroundCompletion(request);
  assert.equal(result.status, 'admitted');
  assert.equal(h.ledger.load(request.scope, result.runId).snapshot.phase, 'completed');
  assert.equal((await h.host.dispatchBackgroundCompletion(request)).status, 'discarded');
  assert.deepEqual(lookups, ['session', 'session', 'session']);
  assert.equal(h.requests.length, 3); assert.equal(h.counts().launches, 1);
  assert.deepEqual(h.ledger.load(request.scope, request.sourceRunId), h.source);
});

test('persisted background dispatch fences foreign scope, Session and task facts before cold loading', async t => {
  const h = await idleBackgroundHost(t), request = backgroundWatchRequest(h);
  let lookups = 0;
  h.services.sessionController = { resolveAgent: async () => { lookups++; assert.fail('Invalid watch cannot load a Session'); } };
  const variants = [
    { ...request, scope: { ...request.scope, workspaceId: 'foreign' } },
    { ...request, scope: { ...request.scope, userId: 'foreign' } },
    { ...request, scope: { ...request.scope, agentId: 'foreign' } },
    { ...request, scope: { ...request.scope, extra: true } },
    { ...request, sessionId: 'foreign' }, { ...request, taskId: 'f'.repeat(64) },
    { ...request, taskId: 'not-a-task' }, { ...request, agent: h.payload.agent },
    { ...request, signal: {} },
  ];
  for (const invalid of variants) await assert.rejects(h.host.dispatchBackgroundCompletion(invalid));
  assert.equal(lookups, 0); assert.deepEqual(h.countsIdle(), { starts: 0, reads: 0 });
  assert.equal(h.requests.length, 2); assert.equal(h.ledger.list(request.scope, 'session').length, 1);
});

test('persisted background dispatch refuses an unavailable or mismatched controller without new authority', async t => {
  const h = await idleBackgroundHost(t), request = backgroundWatchRequest(h);
  await assert.rejects(h.host.dispatchBackgroundCompletion(request), /background_controller_unavailable/);
  for (const result of [undefined, { agent: { session: { id: 'foreign' } } }]) {
    h.services.sessionController = { resolveAgent: async () => result };
    await assert.rejects(h.host.dispatchBackgroundCompletion(request), /background_session_mismatch/);
  }
  const failure = Object.assign(Error('Session locked'), { code: 'fixture_session_busy' });
  h.services.sessionController = { resolveAgent: async () => ({ error: failure }) };
  await assert.rejects(h.host.dispatchBackgroundCompletion(request), error => error === failure);
  assert.deepEqual(h.countsIdle(), { starts: 0, reads: 0 }); assert.equal(h.requests.length, 2);
});

test('persisted background dispatch captures identity before an asynchronous Session lookup', async t => {
  const h = await idleBackgroundHost(t), request = backgroundWatchRequest(h);
  const entered = Promise.withResolvers(), released = Promise.withResolvers();
  h.services.sessionController = { resolveAgent: async id => {
    assert.equal(id, 'session'); entered.resolve(); await released.promise; return { agent: h.payload.agent };
  } };
  const pending = h.host.dispatchBackgroundCompletion(request);
  await entered.promise;
  request.scope.agentId = 'changed'; request.sessionId = 'changed'; request.sourceRunId = 'changed'; request.taskId = 'f'.repeat(64);
  released.resolve();
  assert.equal((await pending).status, 'watching');
  assert.deepEqual(h.countsIdle(), { starts: 0, reads: 1 }); assert.equal(h.requests.length, 2);
});

for (const late of ['return', 'reject']) test(`Host close fences a noncooperative cold background lookup and its late ${late}`, async t => {
  const h = await idleBackgroundHost(t), request = backgroundWatchRequest(h);
  const entered = Promise.withResolvers(), released = Promise.withResolvers();
  h.services.sessionController = { resolveAgent: async () => {
    entered.resolve(); await released.promise;
    if (late === 'reject') throw Error('Late lookup failed');
    return { agent: h.payload.agent };
  } };
  const pending = h.host.dispatchBackgroundCompletion(request), refused = assert.rejects(pending, /Studio Native host closed/);
  await entered.promise; await h.host.close(); await refused;
  released.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.countsIdle(), { starts: 0, reads: 0 }); assert.equal(h.requests.length, 2);
  assert.equal(h.ledger.list(request.scope, 'session').length, 1);
});

test('actual Host composes registered context and local Memory recall in the SQLite context effect', async t => {
  let calls = 0, sourceRequest;
  const h = await setup(t, { sqlite: true, spec: { memory: { enabled: true, provider: { kind: 'local-default' },
    write: { mode: 'off', flushAfterTurn: false }, recall: { enabled: true, maxTokens: 1600 } } },
    contextSources: record => [contextRegistration(record, { callback: async request => {
      calls++; sourceRequest = request;
      const saved = h.ledger.load(request.scope, request.runId);
      assert.equal(saved.snapshot.phase, 'preparing_context');
      assert.equal(saved.intents.find(intent => intent.operationKey === request.operationKey).status, 'running');
      return { items: [{ content: 'SOURCE_DATA_CANNOT_GRANT_APPROVAL' }] };
    } })] });
  await h.host.executeTurn(h.payload);
  const snapshot = h.head(), saved = h.ledger.load(snapshot.scope, snapshot.runId);
  assert.equal(snapshot.phase, 'completed'); assert.equal(calls, 1);
  assert.deepEqual(saved.configuration.contextSources.map(source => source.sourceId), ['studio.memory-recall', 'host.proof']);
  assert.equal(sourceRequest.buildId, snapshot.buildId);
  const body = JSON.parse(h.requests[0].options.body), projection = body.messages.find(message => typeof message.content === 'string'
    && message.content.includes('SOURCE_DATA_CANNOT_GRANT_APPROVAL'));
  assert.equal(projection.role, 'user'); assert.match(projection.content, /"trust":"untrusted"/);
  assert.match(projection.content, /context_only/); assert.match(projection.content, /grants no approval/);
  assert.equal(body.messages.filter(message => message.role === 'system').some(message => message.content.includes('SOURCE_DATA_')), false);
  await assert.rejects(h.bridge.nativeContextSources.bind({ scope: snapshot.scope, sessionId: snapshot.sessionId,
    record: h.record, store: h.ledger, expectedRuntimeBuildId: snapshot.buildId }).readSource(sourceRequest), /phase_unbound/);
});

for (const required of [true, false]) test(`actual Host respects ${required ? 'required' : 'optional'} context authorization denial`, async t => {
  let callbacks = 0;
  const h = await setup(t, { sqlite: true, contextSources: record => [contextRegistration(record, {
    configuration: { contract: STUDIO_NATIVE_CONTEXT_SOURCES_CONTRACT, sources: [{ sourceId: 'host.proof', priority: 0,
      timeoutMs: 1000, required, maxTokens: 1000, maxBytes: 16000 }] }, authorize: async () => 'deny',
    callback: async () => { callbacks++; return { items: [] }; },
  })] });
  await h.host.executeTurn(h.payload);
  assert.equal(callbacks, 0);
  assert.equal(h.requests.length, required ? 0 : 1);
  assert.equal(h.head().phase, required ? 'failed' : 'completed');
});

test('actual Host rejects a registered source that collides with the local Memory source', async t => {
  const h = await setup(t, { sqlite: true, spec: { memory: { enabled: true, provider: { kind: 'local-default' },
    write: { mode: 'off', flushAfterTurn: false }, recall: { enabled: true, maxTokens: 1600 } } },
    contextSources: record => [contextRegistration(record, { configuration: { contract: STUDIO_NATIVE_CONTEXT_SOURCES_CONTRACT,
      sources: [{ sourceId: 'studio.memory-recall', priority: 0, timeoutMs: 1000, required: true, maxTokens: 1000, maxBytes: 16000 }] } })] });
  await assert.rejects(h.host.executeTurn(h.payload), /studio_native_context_source_collision/);
  assert.equal(h.requests.length, 0);
});
test('Studio Host seals pure inference replay only for its plain HTTP model binding', async t => {
  for (const [parameters, expected] of [[{}, 'pure-inference/v1'], [{ temperature: 0.2 }, 'manual'],
    [{ background: true }, 'manual']]) {
    const h = await setup(t, { profile: { parameters } });
    await h.host.executeTurn(h.payload);
    const snapshot = h.head(), saved = h.ledger.load(snapshot.scope, snapshot.runId);
    assert.equal(snapshot.finalText, 'Complete');
    assert.equal(saved.configuration.modelRecoveryPolicy, expected);
    assert.equal(h.requests.length, 1);
    assert.equal(saved.snapshot.usage.modelCalls, 1);
  }
});
test('Studio Host assembles local Memory PreCompact against original admitted user inputs and actual SQLite facts', async t => {
  const fixture = await setup(t, { spec: { memory: { enabled: true, providerRef: 'local-default', scopes: ['user'],
    write: { mode: 'candidate', flushBeforeCompaction: true, flushAfterTurn: false } },
    context: { maxInputTokens: 2400, reserveOutputTokens: 128, rollout: { memoryWrite: 'enabled' },
      compaction: { targetRatio: .2, summaryMaxTokens: 80 } } }, profile: { contextWindow: 2400, maxOutputTokens: 128 } });
  const original = ' '.repeat(2500) + '我喜欢用Vim', sources = [];
  for (let turn = 1; turn <= 3; turn++) {
    if (turn > 1) fixture.payload.agent.session.append('turn/start', { turn });
    fixture.payload.input.messages = [{ id: 'input-' + turn, role: 'user', source: { kind: 'user' },
      content: [{ type: 'text', text: turn < 3 ? original : 'Vim' }] }];
    await fixture.host.executeTurn({ ...fixture.payload, turn });
    const snapshot = fixture.head(); assert.equal(snapshot.phase, 'completed');
    if (turn < 3) sources.push(`native-message://${snapshot.runId}#message=${turn === 1 ? 1 : 3}`);
  }
  const snapshot = fixture.head(), entries = fixture.ledger.list(snapshot.scope, 'session')
    .map(run => fixture.ledger.load(snapshot.scope, run.runId));
  assert.ok(entries.flatMap(entry => entry.receipts).some(receipt => receipt.result.schemaVersion === 'agentkit.native-hook-result/v1'
    && receipt.result.status === 'ok' && receipt.result.event === 'PreCompact'));
  assert.ok(fixture.requests.some(request => JSON.parse(request.options.body).messages[0].content.startsWith('Summarize the quoted historical data')));
  assert.ok(fixture.requests.some(request => JSON.parse(request.options.body).messages.some(message =>
    message.content.includes('agentkit.native-context-contribution/v1') && JSON.parse(message.content).item.content === '我喜欢用Vim')));
  assert.ok(entries.flatMap(entry => entry.receipts).filter(receipt => receipt.result.contributions)
    .every(receipt => receipt.result.contributions.sources[0].status === 'ok'));
  const provider = new SqliteNativeMemoryProvider(join(fixture.root, 'native-harness', 'memory-v1',
    memoryDigest('local').slice(7), 'memory.sqlite'), { principal: snapshot.scope });
  try {
    const records = provider.list(); assert.equal(records.length, 1); assert.equal(records[0].content, '我喜欢用Vim');
    assert.equal(records[0].version, 1); assert.deepEqual(new Set(records[0].sourceEventIds), new Set(sources));
  } finally { provider.close(); }
});
test('production Host refreshes actual SQLite Memory before each model request and retains untrusted source/version metadata', async t => {
  let writer, memoryId;
  const observed = [];
  const fixture = await setup(t, { spec: { memory: { enabled: true, providerRef: 'local-default', scopes: ['user'],
    write: { mode: 'off' }, recall: { enabled: true, maxTokens: 1600, minScore: 1 } } }, respond: (count, body) => {
    const items = body.messages.filter(message => message.role === 'user' && message.content.includes('agentkit.native-context-contribution/v1'))
      .map(message => JSON.parse(message.content));
    assert.equal(items.length, 1); assert.equal(items[0].trust, 'untrusted');
    assert.equal(items[0].item.currentFactVerification, false);
    assert.equal(items[0].item.version, count); observed.push(items[0].item.content);
    if (count === 1) {
      // An independent connection changes the fact after this request's read.
      writer.mutate({ action: 'correct', memoryId, expectedVersion: 1, content: 'My preferred editor is Emacs',
        operationKey: 'external-correction', sourceEventId: 'independent-user-input', sourceSessionId: 'other-session' });
      return { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'read-1', type: 'function',
        function: { name: 'observe', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] };
    }
    return { choices: [{ index: 0, delta: { content: 'Current preference delivered.' }, finish_reason: 'stop' }] };
  } });
  const scope = { tenantId: 'local', workspaceId: createHash('sha256').update(JSON.stringify(join(fixture.root, 'workspace'))).digest('hex'),
    userId: 'local-user', agentId: fixture.record.metadata.id };
  writer = new SqliteNativeMemoryProvider(join(fixture.root, 'native-harness/memory-v1', memoryDigest('local').slice(7), 'memory.sqlite'),
    { principal: scope });
  t.after(() => writer.close());
  const candidate = nativeUserMemoryCandidate({ text: '记住：My preferred editor is Vim', sourceEventId: 'seed-user',
    ...nativeMemoryScopeBindings(scope)[0] });
  memoryId = writer.applyCandidate({ candidate, operationKey: 'seed', sourceSessionId: 'other-session', sourceDigest: memoryDigest(candidate.content) }).memoryId;
  const definition = { name: 'observe', description: 'Read a fixture', parameters: { type: 'object', properties: {} },
    readOnly: true, concurrentSafe: true, permissions: [], timeoutMs: 1000,
    contextRole: 'none', observationRole: 'none', progressObservation: false, contextRetention: 'normal' };
  fixture.payload.binding.nativeTools.definitions = () => [definition];
  fixture.payload.binding.nativeTools.forAgent = () => ({ tools: { execute: async () => ({ status: 'ok', content: 'Observed' }) } });
  fixture.payload.input.messages[0].content[0].text = 'preferred editor';
  await fixture.host.executeTurn(fixture.payload);
  assert.deepEqual(observed, ['My preferred editor is Vim', 'My preferred editor is Emacs']);
  assert.equal(fixture.head().phase, 'completed');
  const run = fixture.ledger.load(scope, fixture.head().runId);
  assert.equal(run.configuration.contextSources[0].sourceId, 'studio.memory-recall');
  assert.equal(run.snapshot.messages.some(message => message.kind === 'context_contribution'), false);
  assert.ok(run.receipts.filter(receipt => receipt.result.contributions).every(receipt => receipt.result.contributions.sources[0].status === 'ok'));
});
test('Studio Native Host pins revision/input/model while refreshing credentials outside its ledger', async t => {
  const fixture = await setup(t);
  await fixture.host.executeTurn(fixture.payload);
  assert.equal(fixture.requests.length, 1);
  assert.equal(new Headers(fixture.requests[0].options.headers).get('authorization'), 'Bearer secret-one');
  const run = fixture.head();
  assert.equal(run.phase, 'completed');
  assert.equal(run.verification.checks[0].verifierId, 'studio.delivery-evidence-rejection');
  assert.equal(run.verification.checks[0].status, 'not_run');
  assert.match(run.verification.checks[0].evidenceRefs[0], /^artifact:/);
  assert.equal(run.outcome, 'unverified');
  assert.equal(JSON.stringify(fixture.ledger.load(run.scope, run.runId)).includes('secret-one'), false);
  fixture.rotate('secret-two');
  fixture.payload.agent.session.append('turn/start', { turn: 2 });
  await fixture.host.executeTurn({ ...fixture.payload, turn: 2 });
  assert.equal(new Headers(fixture.requests[1].options.headers).get('authorization'), 'Bearer secret-two');
  assert.equal(fixture.head().parentRunId, run.runId);
  assert.equal(JSON.stringify(fixture.ledger.load(run.scope, fixture.head().runId)).includes('secret-two'), false);
});

const approvalTool = { name: 'guarded_write', description: 'A tool requiring a persisted approval',
  parameters: { type: 'object', properties: {} }, readOnly: false, concurrentSafe: false, permissions: [], timeoutMs: 1000,
  contextRole: 'none', observationRole: 'none', progressObservation: false, contextRetention: 'normal' };
const approvalResponse = count => ({ choices: [{ index: 0, delta: count === 1
  ? { tool_calls: [{ index: 0, id: 'guarded-1', type: 'function', function: { name: approvalTool.name, arguments: '{}' } }] }
  : { content: 'Complete' }, finish_reason: count === 1 ? 'tool_calls' : 'stop' }] });
function bindApprovalTool(fixture, dispatch) {
  fixture.payload.binding.nativeTools.definitions = () => [approvalTool];
  fixture.payload.binding.nativeTools.forAgent = () => ({ tools: { execute: async request => {
    if (!request.interaction) return { status: 'approval_required', interactionId: 'guarded-host-id', content: null };
    return dispatch(request);
  } } });
}
for (const outcome of ['allowed-once', 'rejected', 'unavailable', 'unexpected']) {
  test(`Studio Native routes persisted tool approval through the Host: ${outcome}`, async t => {
    const fixture = await setup(t, { respond: approvalResponse });
    let writes = 0, asks = 0;
    bindApprovalTool(fixture, async request => {
      assert.equal(request.interaction.interactionId, 'guarded-host-id');
      if (request.interaction.decision === 'deny') return { status: 'error', content: 'Denied' };
      writes++; return { status: 'ok', content: 'Written' };
    });
    fixture.services.approval = { request: async request => {
      asks++; assert.equal(request.agent, fixture.payload.agent); assert.equal(request.toolName, approvalTool.name);
      const displayed = fixture.events.find(event => event.type === 'tool/call');
      assert.equal(request.callId, displayed.data.callId);
      assert.equal(fixture.head().phase, 'awaiting_interaction');
      return outcome;
    } };
    await fixture.host.executeTurn(fixture.payload);
    assert.equal(asks, 1); assert.equal(writes, outcome === 'allowed-once' ? 1 : 0);
    assert.equal(fixture.head().phase, 'completed');
    const resolved = fixture.ledger.events(fixture.head().scope, fixture.head().runId).filter(event => event.kind === 'approval.resolved');
    assert.equal(resolved.length, 1);
  });
}
test('Studio Native cancellation during a Host approval rejects its late grant', async t => {
  const fixture = await setup(t, { respond: approvalResponse });
  let writes = 0, grant, entered;
  const asked = new Promise(resolve => { entered = resolve; });
  bindApprovalTool(fixture, async () => { writes++; return { status: 'ok', content: 'Written' }; });
  fixture.services.approval = { request: () => { entered(); return new Promise(resolve => { grant = resolve; }); } };
  const controller = new AbortController(); fixture.payload.signal = controller.signal;
  const execution = fixture.host.executeTurn(fixture.payload);
  await asked; controller.abort(new Error('user canceled approval'));
  assert.deepEqual(await execution, { reason: { kind: 'aborted', reason: { kind: 'disposed' } } });
  grant('allowed-once');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(writes, 0); assert.equal(fixture.head().phase, 'canceled');
});
test('Studio Native retains a pending decision when the Host approval service is absent', async t => {
  const fixture = await setup(t, { respond: approvalResponse });
  bindApprovalTool(fixture, async () => assert.fail('No decision was authorized'));
  await assert.rejects(fixture.host.executeTurn(fixture.payload), { code: 'NATIVE_TURN_SUSPENDED' });
  assert.equal(fixture.head().phase, 'awaiting_interaction');
  assert.equal(fixture.requests.length, 1);
});
test('Studio Host releases the revision-bound resources with the settled Run identity', async t => {
  const fixture = await setup(t), releases = [];
  fixture.payload.binding.nativeTools.releaseSession = request => {
    assert.equal(fixture.head().phase, 'completed'); releases.push(request);
  };
  await fixture.host.executeTurn(fixture.payload);
  assert.deepEqual(releases, [{ scope: fixture.head().scope, runId: fixture.head().runId, sessionId: 'session' }]);
});
test('Studio Native executes Web through its ledger, replays its result and rejects a changed provider binding', async t => {
  const fixture = await setup(t, { respond: (count, body) => {
    if (count === 1) return { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'web-query', type: 'function',
      function: { name: 'web_search', arguments: '{"query":"source proof"}' } }] }, finish_reason: 'tool_calls' }] };
    const result = body.messages.find(message => message.role === 'tool' && message.tool_call_id === 'web-query');
    assert.ok(result); assert.match(result.content, /source proof/);
    return { choices: [{ index: 0, delta: { content: 'Search completed.' }, finish_reason: 'stop' }] };
  } });
  const registry = new Map(), calls = [];
  const gateway = createNativeDshTools({ ctx: { effect: install => install(), tools: {
    register(tool) { registry.set(tool.name, tool); return () => registry.delete(tool.name); },
    async execute(input) {
      calls.push(input.name);
      const tool = registry.get(input.name), value = await tool.execute(input.arguments, input);
      return { isError: false, value, content: tool.output.render(input.arguments, value) };
    },
  } }, config: { toolBindings: ['web_search'] }, workspaceRoot: join(fixture.root, 'workspace'),
  stateDir: join(fixture.root, 'web-state'), webEnvironment: { KSADK_WEB_SEARCH_PROVIDER: 'fake' } });
  t.after(() => gateway.close());
  fixture.payload.binding.nativeTools = gateway;
  fixture.payload.input.assembly.tools = [...registry.values()];
  const ending = await fixture.host.executeTurn(fixture.payload);
  const head = fixture.head(), run = fixture.ledger.load(head.scope, head.runId);
  assert.equal(head.phase, 'completed'); assert.equal(fixture.requests.length, 2);
  assert.deepEqual(calls, ['web_search']);
  assert.deepEqual(run.configuration.tools.find(tool => tool.name === 'web_search'),
    gateway.definitions(fixture.payload.agent, [...registry.values()])[0]);
  const intent = run.intents.find(intent => intent.kind === 'tool');
  assert.ok(intent, 'the tool has its own durable intent');
  const receipt = run.receipts.find(receipt => receipt.operationKey === intent.operationKey);
  assert.equal(receipt.result.results.length, 1);
  assert.equal(receipt.result.results[0].status, 'ok');
  assert.equal(receipt.result.results[0].content.provider, 'fake');
  assert.equal(receipt.result.results[0].content.query, 'source proof');
  assert.deepEqual(ending, { reason: { kind: 'completed' } });
  // Re-resolving a preset with different provider settings keeps the same tool
  // schemas but must not adopt an existing Run under a new capability digest.
  fixture.payload.binding.nativeTools = { ...gateway,
    webBinding: { ...gateway.webBinding, bindingDigest: 'changed-provider-binding' } };
  await assert.rejects(fixture.host.executeTurn(fixture.payload), /run_creation_conflict/);
  assert.equal(fixture.requests.length, 2); assert.deepEqual(calls, ['web_search']);
  assert.deepEqual(fixture.ledger.load(head.scope, head.runId), run);
});

test('Studio Native pins the snippet registry name contract and rejects a changed transport on an existing Run', async t => {
  const fixture = await setup(t), binding = { contract: 'agentkit.native-e2b-code-tools/v1', backend: 'e2b',
    registryNameContract: 'agentkit.sandbox-code-registry-name/v1', registryName: 'sandbox_run_code',
    host: { bindingDigest: 'a'.repeat(64), template: 'fixed' } };
  fixture.payload.binding.nativeTools.codeBinding = binding;
  await fixture.host.executeTurn(fixture.payload);
  const head = fixture.head(), before = fixture.ledger.load(head.scope, head.runId);
  await fixture.host.executeTurn(fixture.payload);
  assert.deepEqual(fixture.ledger.load(head.scope, head.runId), before, 'unchanged code binding reuses the original Run');
  fixture.payload.binding.nativeTools.codeBinding = { ...binding, registryName: 'foreign_code_transport' };
  await assert.rejects(fixture.host.executeTurn(fixture.payload), /run_creation_conflict/);
  assert.deepEqual(fixture.ledger.load(head.scope, head.runId), before);
});

test('Studio Native pins Skill management capability and rejects adopting an existing Run under another management source', async t => {
  const fixture = await setup(t, { sqlite: true }), binding = { contract: 'agentkit.studio-skill-management/v1',
    agentId: fixture.record.metadata.id, workspace: join(fixture.root, 'workspace'), source: 'public-github-immutable/v1' };
  fixture.payload.binding.nativeTools.skillManagementBinding = binding;
  await fixture.host.executeTurn(fixture.payload);
  const head = fixture.head(), before = fixture.ledger.load(head.scope, head.runId);
  assert.equal(typeof before.configuration.hostBindingDigest, 'string');
  await fixture.host.executeTurn(fixture.payload);
  assert.deepEqual(fixture.ledger.load(head.scope, head.runId), before);
  fixture.payload.binding.nativeTools.skillManagementBinding = { ...binding, source: 'changed-source/v2' };
  await assert.rejects(fixture.host.executeTurn(fixture.payload), /run_creation_conflict/);
  assert.deepEqual(fixture.ledger.load(head.scope, head.runId), before);
});

test('Studio Native pins knowledge datasets, retrieval parameters and connection across an existing Run', async t => {
  const fixture = await setup(t, { sqlite: true }), binding = { contract: 'agentkit.studio-knowledge-tools/v1',
    agentId: fixture.record.metadata.id, datasetIds: ['kb'], retrieval: { SearchMethod: 'intelligence_search', TopK: 5, RerankingEnable: false },
    connectionDigest: 'a'.repeat(64) };
  fixture.payload.binding.nativeTools.knowledgeBinding = binding;
  await fixture.host.executeTurn(fixture.payload);
  const head = fixture.head(), before = fixture.ledger.load(head.scope, head.runId);
  await fixture.host.executeTurn(fixture.payload); assert.deepEqual(fixture.ledger.load(head.scope, head.runId), before);
  for (const change of [{ datasetIds: ['other'] }, { connectionDigest: 'b'.repeat(64) }, { retrieval: { ...binding.retrieval, TopK: 9 } }]) {
    fixture.payload.binding.nativeTools.knowledgeBinding = { ...binding, ...change };
    await assert.rejects(fixture.host.executeTurn(fixture.payload), /run_creation_conflict/);
    assert.deepEqual(fixture.ledger.load(head.scope, head.runId), before);
  }
});

test('Studio Native pins legacy Memory backend, user partition mode, settings and connection across an existing Run', async t => {
  const fixture = await setup(t, { sqlite: true }), binding = { contract: 'agentkit.legacy-memory-tools/v1',
    agentId: fixture.record.metadata.id, backend: 'sdk', bound: true, collectionIds: ['memory'], index: 'default_app', topK: 5,
    sceneId: '_sys_general', volatile: false, connectionDigest: 'a'.repeat(64) };
  fixture.payload.binding.nativeTools.legacyMemoryBinding = binding;
  await fixture.host.executeTurn(fixture.payload);
  const head = fixture.head(), before = fixture.ledger.load(head.scope, head.runId);
  await fixture.host.executeTurn(fixture.payload); assert.deepEqual(fixture.ledger.load(head.scope, head.runId), before);
  for (const change of [{ collectionIds: ['other'] }, { backend: 'http' }, { bound: false }, { topK: 9 }, { connectionDigest: 'b'.repeat(64) }]) {
    fixture.payload.binding.nativeTools.legacyMemoryBinding = { ...binding, ...change };
    await assert.rejects(fixture.host.executeTurn(fixture.payload), /run_creation_conflict/);
    assert.deepEqual(fixture.ledger.load(head.scope, head.runId), before);
  }
});

test('Studio Native pins its browser task policy and explicit execution limits in the Run configuration', async t => {
  const fixture = await setup(t, { spec: { execution: { nativeLimits: { maxModelCalls: 20, maxToolCalls: 0 } } } });
  fixture.payload.binding.nativeTools.definitions = () => [studioBrowserDefinition()];
  await fixture.host.executeTurn(fixture.payload);
  const run = fixture.head(), config = fixture.ledger.load(run.scope, run.runId).configuration;
  assert.equal(config.workspaceObservationPolicy.role, 'browser');
  assert.ok(config.workspaceObservationPolicy.pathSuffixes.includes('.tsx'));
  assert.equal(config.limits.maxModelCalls, 20); assert.equal(config.limits.maxToolCalls, 0);
  assert.equal(config.limits.verificationReserveModelCalls, 4);
  assert.equal(config.limits.browserObservationIntervalToolCalls, 12);
});
test('Studio Native rejects missing public turn capability and unbound models before creating a run', async t => {
  const fixture = await setup(t);
  await assert.rejects(fixture.host.executeTurn({ ...fixture.payload, prepareInput: undefined }), /studio_native_whole_turn_host_required/);
  fixture.payload.agent.options.model = 'unbound';
  fixture.models.catalog = async () => ({ items: [] });
  await assert.rejects(fixture.host.executeTurn(fixture.payload), /studio_native_bound_model_unavailable/);
  assert.equal(fixture.requests.length, 0); assert.equal(fixture.head(), null);
});
test('Studio Native uses the admitted SessionController model selection instead of stale creation options', async t => {
  const fixture = await setup(t);
  fixture.payload.agent.options = { provider: 'old-default', model: 'old-default' };
  fixture.payload.input.assembly.variables = { provider: 'agentkit-studio-fixture', model: 'pinned' };
  await fixture.host.executeTurn(fixture.payload);
  assert.equal(fixture.requests.length, 1);
  assert.equal(JSON.parse(fixture.requests[0].options.body).model, 'pinned');
  assert.equal(fixture.ledger.load(fixture.head().scope, fixture.head().runId).configuration.profile.profileId, 'fixture');
});
test('an unbound or malformed admitted model cannot fall back to the creation default', async t => {
  const fixture = await setup(t); fixture.models.catalog = async () => ({ items: [] });
  for (const variables of [{ provider: 'unbound', model: 'pinned' }, { provider: 'agentkit-studio-fixture', model: 'unbound' }, { model: null }]) {
    fixture.payload.input.assembly.variables = variables;
    await assert.rejects(fixture.host.executeTurn(fixture.payload), /studio_native_(bound_model_unavailable|model_selection_invalid)/);
  }
  assert.equal(fixture.requests.length, 0); assert.equal(fixture.head(), null);
});
test('Studio Native resolves Frozen Build authority instead of reading a mutable agent draft', async t => {
  const fixture = await setup(t);
  fixture.payload.binding.buildId = 'frozen-build';
  fixture.agents.getRevision = async () => assert.fail('Frozen execution cannot read a draft');
  await fixture.host.executeTurn(fixture.payload);
  assert.deepEqual(fixture.resolutions, [{ agentId: fixture.record.metadata.id, buildId: 'frozen-build' }]);
  assert.equal(fixture.head().buildId, 'frozen-build');
});
test('Studio Native refuses a legacy Frozen Build before creating a run or contacting a model', async t => {
  const fixture = await setup(t); fixture.payload.binding.buildId = 'legacy-build';
  fixture.builds.resolve = async () => structuredClone(fixture.record);
  await assert.rejects(fixture.host.executeTurn(fixture.payload), /studio_native_build_engine_mismatch/);
  assert.equal(fixture.requests.length, 0); assert.equal(fixture.head(), null);
});
test('a changed Frozen revision and a mid-run model binding cannot dispatch an HTTP request', async t => {
  const frozen = await setup(t);
  frozen.payload.binding.buildId = 'build';
  frozen.builds.resolve = async () => ({ ...frozen.record, metadata: { ...frozen.record.metadata, revision: 2 } });
  await assert.rejects(frozen.host.executeTurn(frozen.payload), /studio_native_revision_binding_changed/);
  assert.equal(frozen.requests.length, 0); assert.equal(frozen.head(), null);
  const changed = await setup(t), original = changed.models.profile;
  let lookups = 0;
  changed.models.profile = async id => {
    const profile = await original(id); return ++lookups > 1 ? { ...profile, baseUrl: 'https://changed.invalid/v1' } : profile;
  };
  assert.deepEqual(await changed.host.executeTurn(changed.payload), { reason: { kind: 'error',
    error: { code: 'NATIVE_TURN_FAILED', message: 'provider_terminal_error' } } });
  assert.equal(changed.head().phase, 'failed');
  assert.equal(changed.requests.length, 0);
  const snapshot = changed.head(), record = changed.ledger.load(snapshot.scope, snapshot.runId);
  const receipts = record.receipts.filter(receipt => record.intents.find(intent => intent.operationKey === receipt.operationKey)?.kind === 'model');
  assert.equal(receipts.length, 1); assert.equal(receipts[0].result.failureKind, 'host_error');
});
test('Studio Native close is idempotent and retires its projection exactly once', async t => {
  const fixture = await setup(t);
  const first = fixture.host.close(), second = fixture.host.close();
  assert.equal(first, second); await first;
  assert.equal(fixture.unregisters(), 1);
  assert.throws(() => fixture.host.executeTurn(fixture.payload), /studio_native_host_closed/);
});
test('Studio Native admits live typed input through Host policy and trusted attachment resolution', async t => {
  const fixture = await setup(t), steps = [], reads = [];
  fixture.services.attachments = { readImageRequest: async ref => {
    reads.push(ref); return { mediaType: 'image/png', data: Uint8Array.of(1, 2) };
  } };
  const content = [{ type: 'text', text: 'Use the new image' }, { type: 'image', attachment: { attachmentId: 'host-admitted-image' } }];
  fixture.payload.prepareInput = async step => {
    steps.push(step);
    const run = fixture.head(), record = fixture.ledger.load(run.scope, run.runId);
    assert.equal(record.intents.find(intent => intent.operationKey === run.pendingIntent)?.kind, 'input');
    assert.equal(record.intents.find(intent => intent.operationKey === run.pendingIntent)?.status, 'running');
    return { kind: 'enter', assembly: fixture.payload.input.assembly, messages: step === 2
      ? [{ id: 'steering-image', role: 'user', source: { kind: 'user' }, content },
        { id: 'host-context', role: 'user', source: { kind: 'tool', callId: 'already-host-owned' }, content: [{ type: 'text', text: 'Host-owned context' }] }] : [] };
  };
  await fixture.host.executeTurn(fixture.payload);
  assert.deepEqual(steps, [2, 3]); assert.equal(fixture.requests.length, 2); assert.equal(reads.length, 1);
  const messages = JSON.parse(fixture.requests[1].options.body).messages;
  assert.deepEqual(messages.at(-2).content, [{ type: 'text', text: 'Use the new image' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AQI=', detail: 'auto' } }]);
  const delivered = fixture.events.filter(event => event.type === 'user/message' && event.data.content[0]?.text === 'Use the new image');
  assert.equal(delivered.length, 1); assert.deepEqual(delivered[0].data.content, content);
  const context = fixture.events.find(event => event.type === 'user/message' && event.data.content[0]?.text === 'Host-owned context');
  assert.deepEqual(context.data.source, { kind: 'tool', callId: 'already-host-owned' });
  assert.equal(fixture.head().goal, 'Finish');
});
test('SDK clock and runtime refreshers do not discard a final candidate when no new work arrived', async t => {
  const fixture = await setup(t);
  fixture.payload.prepareInput = async () => ({ kind: 'enter', assembly: fixture.payload.input.assembly,
    messages: ['runtime-context', 'time-context'].map((kind, index) => ({ id: `ambient-${index}`, role: 'user',
      source: { kind }, content: [{ type: 'text', text: `Fresh ${kind}` }] })) });
  await fixture.host.executeTurn(fixture.payload);
  assert.equal(fixture.requests.length, 1); assert.equal(fixture.head().phase, 'completed');
  assert.equal(fixture.head().finalText, 'Complete');
});

test('Studio Native respects a pre-step rejection without reporting the stale candidate as completion', async t => {
  const fixture = await setup(t);
  fixture.payload.prepareInput = async () => ({ kind: 'reject' });
  assert.deepEqual(await fixture.host.executeTurn(fixture.payload), { reason: { kind: 'blocked' } });
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.head().outcome, 'blocked'); assert.equal(fixture.head().reason, 'host_input_rejected');
  assert.equal(fixture.head().finalText, '');
});
for (const changed of ['tool binding', 'request series', 'model selection']) test(`Studio Native refuses a changed ${changed} during input admission`, async t => {
  const fixture = await setup(t);
  fixture.payload.binding.nativeTools.definitions = (_agent, tools) => tools;
  fixture.payload.prepareInput = async () => ({ kind: 'enter', messages: [],
    ...(changed === 'request series' ? { startsRequestSeries: true } : {}), assembly: {
      tools: changed === 'tool binding' ? [{ name: 'unexpected' }] : [],
      ...(changed === 'model selection' ? { variables: { provider: 'agentkit-studio-fixture', model: 'changed-after-admission' } } : {}),
    } });
  await assert.rejects(fixture.host.executeTurn(fixture.payload), { code: 'NATIVE_TURN_FAILED', nativeReason: 'effect_outcome_unknown' });
  assert.equal(fixture.requests.length, 1); assert.equal(fixture.head().phase, 'interrupted');
  const run = fixture.head();
  assert.equal(fixture.ledger.load(run.scope, run.runId).receipts.at(-1).result.code,
    changed === 'request series' ? 'studio_native_request_series_rebind_required'
      : changed === 'model selection' ? 'studio_native_input_model_binding_changed' : 'studio_native_input_tool_binding_changed');
});
test('Studio Native close during a stalled input claim fences late admission', async t => {
  const fixture = await setup(t);
  let enter, finish;
  const entered = new Promise(resolve => { enter = resolve; }), late = new Promise(resolve => { finish = resolve; });
  fixture.payload.prepareInput = async () => { enter(); await late; return { kind: 'enter', messages: [], assembly: fixture.payload.input.assembly }; };
  const running = fixture.host.executeTurn(fixture.payload);
  await entered; await fixture.host.close();
  assert.deepEqual(await running, { reason: { kind: 'aborted', reason: { kind: 'disposed' } } });
  assert.equal(fixture.head().phase, 'canceled'); assert.equal(fixture.requests.length, 1);
  const run = fixture.head(), before = fixture.ledger.load(run.scope, run.runId);
  assert.ok(before.receipts.some(receipt => receipt.status === 'uncertain'));
  finish(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(fixture.ledger.load(run.scope, run.runId), before);
});
test('Studio Native binds context/output budgets and the production counter from the Frozen Build', async t => {
  const fixture = await setup(t, { spec: { context: { maxInputTokens: 5000, reserveOutputTokens: 1000,
    compaction: { enabled: false, thresholdRatio: .6 } } }, profile: { contextWindow: 4000, maxOutputTokens: 2000 } });
  fixture.payload.binding.buildId = 'fixed-context-build';
  fixture.agents.getRevision = async () => assert.fail('Read the Frozen Build, not the mutable draft');
  await fixture.host.executeTurn(fixture.payload);
  const run = fixture.head(), configuration = fixture.ledger.load(run.scope, run.runId).configuration;
  assert.equal(configuration.profile.contextWindow, 4000); assert.equal(configuration.profile.maxOutputTokens, 1000);
  assert.equal(configuration.contextPolicy.enabled, false); assert.equal(configuration.contextPolicy.triggerRatio, .6);
  assert.match(configuration.contextPolicy.tokenizerId, /cjk-ascii-estimate-125-wire-image/);
  assert.equal(JSON.parse(fixture.requests[0].options.body).max_tokens, 1000);
  assert.ok(fixture.ledger.load(run.scope, run.runId).receipts.some(receipt => receipt.result.admission?.countedInputTokens > 0));
});
test('Studio Native refuses an over-budget request before HTTP when compaction is disabled', async t => {
  const fixture = await setup(t, { spec: { context: { maxInputTokens: 3000, reserveOutputTokens: 128, compaction: { enabled: false } } } });
  fixture.payload.input.messages[0].content[0].text = '中文上下文'.repeat(1000);
  assert.deepEqual(await fixture.host.executeTurn(fixture.payload), { reason: { kind: 'error',
    error: { code: 'NATIVE_TURN_FAILED', message: 'context_compaction_disabled' } } });
  assert.equal(fixture.head().phase, 'failed');
  assert.equal(fixture.requests.length, 0);
  assert.equal(fixture.head().usage.modelCalls, 0);
});
test('Studio Native keeps an image-only admission with its independent objective through context planning', async t => {
  const fixture = await setup(t, { spec: { context: { compaction: { thresholdRatio: .001 } } } });
  fixture.services.attachments = { readImageRequest: async () => ({ mediaType: 'image/png', data: Uint8Array.of(1) }) };
  fixture.payload.input.messages[0].content = [{ type: 'image', attachment: { attachmentId: 'image-only' } }];
  await fixture.host.executeTurn(fixture.payload);
  assert.equal(fixture.requests.length, 1);
  assert.ok(JSON.parse(fixture.requests[0].options.body).messages.some(message => Array.isArray(message.content)
    && message.content.some(block => block.type === 'image_url')));
  assert.equal(fixture.head().goal, 'Inspect the attached input and respond to the user.');
});
for (const [context, code] of [
  [{ maxInputTokens: 1000, reserveOutputTokens: 1000 }, 'studio_native_context_budget_conflict'],
  [{ maxInputTokens: '4000' }, 'studio_native_context_budget_invalid'],
  [{ compaction: { thresholdRatio: 0 } }, 'invalid_context_policy'],
  [{ compaction: { pruneToolResults: true } }, 'studio_native_compaction_option_unsupported'],
]) test(`Studio Native rejects an invalid or unsupported context contract: ${JSON.stringify(context)}`, async t => {
  const fixture = await setup(t, { spec: { context } });
  await assert.rejects(fixture.host.executeTurn(fixture.payload), { code });
  assert.equal(fixture.requests.length, 0); assert.equal(fixture.head(), null);
});
