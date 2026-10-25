import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createNativeDshTools } from '../src/providers/native-dsh-tools.mjs';
import { scope, fixture, digest } from '../packages/agentkit-harness-core/test/fixtures.mjs';
import { NativeKernel, MemoryRunStore, configure, emptyUsage, BACKGROUND_COMMAND_CONTRACT, BACKGROUND_NOTIFICATION_ADMISSION } from '../packages/agentkit-harness-core/dist/index.mjs';
import { snapshotNativeMcpSchema } from '../src/providers/native-mcp-schema.mjs';
import { snapshotNativeMcpPlanAccess } from '../src/providers/native-mcp-schema.mjs';
import { planModeToolDefinitions } from '../packages/agentkit-harness-core/dist/index.mjs';
import { NATIVE_PYTHON_SYNTAX } from '../packages/agentkit-harness/src/native/python-syntax.mjs';
import { artifactToolDefinitions, canonical, parseNativeJson, directoryProgressQuote } from '../packages/agentkit-harness-core/dist/index.mjs';
import { createNativeArtifactStore } from '../packages/agentkit-harness/src/native/artifact-store.mjs';
import { createAgentStore } from '../src/agent-store.mjs';
import { createSkillDiscovery } from '../src/skill-discovery.mjs';
import { createStudioSkillManagement, SKILL_MANAGEMENT_CONTRACT } from '../src/skill-management.mjs';
import { createGithubArchiveSkillSource } from '../src/skill-github-archive-source.mjs';
import { createZip } from '../src/zip.mjs';
import { createStudioKnowledgeTools, createKnowledgeConnection, knowledgeBindings } from '../src/knowledge-tools.mjs';
import { createLegacyMemoryTools, createLegacyMemoryConnection } from '../src/legacy-memory-tools.mjs';
import { createNativeContextPort } from '../packages/agentkit-harness/src/native/context-counter.mjs';
import { createNativeToolAuthority } from '../src/providers/native-tool-authority.mjs';
import { decodeCapturedSource, CAPTURED_SOURCE_MEDIA_TYPE } from '../packages/agentkit-harness-core/dist/index.mjs';

// Real signed Node HTTP transport and SQLite/Kernel; HTTP peer and model are
// controlled. The registry/Agent in setup below remain explicit test doubles.
async function resourceConnection(t, prefix, factory, onRequest) {
  const http = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    assert.equal(new URL(req.url, 'http://localhost').searchParams.get('Action'), payload.Action);
    assert.equal(payload.Version, '2025-11-14'); assert.equal(payload.Accesskey, 'native-key');
    assert.match(req.headers.authorization, /Credential=native-key\//u);
    assert.equal(req.headers['x-traffic-source'], 'agentkit');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(onRequest(payload.Action, payload)));
  });
  http.listen(0, '127.0.0.1'); await once(http, 'listening');
  t.after(() => { http.closeAllConnections(); http.close(); });
  return factory({ configuration: { resolve: async () => ({ values: {} }) },
    env: { [`${prefix}_ENDPOINT`]: `127.0.0.1:${http.address().port}`, [`${prefix}_SCHEME`]: 'http',
      [`${prefix}_ACCESS_KEY`]: 'native-key', [`${prefix}_SECRET_KEY`]: 'native-secret' } });
}

test('actual Native kernel owns legacy Memory writes, full intent and post-policy views', async t => {
  const name = 'save_memory', root = realpathSync(mkdtempSync(join(tmpdir(), 'native-legacy-memory-'))), workspaceRoot = join(root, 'workspace');
  mkdirSync(workspaceRoot); t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new SqliteRunStore(join(root, 'runs.sqlite')); t.after(() => store.close()); let calls = 0;
  const memory = createLegacyMemoryTools({ agentId: scope.agentId, root: join(root, 'memory'), env: { KSADK_LTM_BACKEND: 'sdk' },
    connection: await resourceConnection(t, 'KSADK_LTM', createLegacyMemoryConnection, (action, payload) => {
      calls++; const current = store.load(scope, 'run'), intent = current.intents.find(item => item.operationKey === current.snapshot.pendingIntent);
      assert.equal(intent.status, 'running'); assert.equal(intent.kind, 'tool'); assert.equal(intent.claimedFence, current.lease.fence);
      assert.equal(payload.AgentUserId, scope.userId);
      return action === 'CreateMemorySdk' ? { Data: {}, RequestId: 'accepted' } : { Memories: ['remembered'] };
    }) });
  t.after(() => memory.close());
  const h = setup(t, [name], [], { workspaceRoot, stateDir: join(root, 'state'), getLegacyMemoryTools: () => memory });
  const original = h.ctx.tools.execute;
  h.ctx.tools.execute = async request => ({ ...await original(request), content: [{ type: 'text', text: 'Host-filtered Memory' }] });
  const tools = h.gateway.definitions(h.agent, [...h.registry.values()]); assert.equal(tools[0].readOnly, false);
  assert.equal(h.gateway.legacyMemoryBinding.backend, 'sdk');
  const data = fixture({ tools, limits: { effectTimeoutMs: 200000 } }); let models = 0;
  const kernel = new NativeKernel({ store, digest, owner: 'memory-worker', ports: { ...h.gateway.forAgent(h.agent, { scope, store }),
    model: { generate: async request => {
      if (++models === 1) return { kind: 'tool_calls', text: '', usage: emptyUsage(), toolCalls: [{ callId: 'memory-call', name, arguments: { content: 'remembered' } }] };
      assert.equal(request.messages.at(-1).content, 'Host-filtered Memory');
      return { kind: 'final_candidate', text: 'Done', toolCalls: [], usage: emptyUsage() };
    } } } });
  kernel.start(data.snapshot, data.config); assert.equal((await kernel.runUntilIdle(scope, 'run')).phase, 'completed');
  const before = store.load(scope, 'run');
  assert.ok(before.receipts.some(receipt => receipt.result.results?.some(item => item.content?.status === 'persisted')));
  await kernel.runUntilIdle(scope, 'run'); assert.deepEqual(store.load(scope, 'run'), before); assert.equal(calls, 2); assert.equal(models, 2);
});

test('actual Native kernel owns the knowledge intent, original read receipt and post-policy model view', async t => {
  const name = 'search_knowledge_base', root = realpathSync(mkdtempSync(join(tmpdir(), 'native-knowledge-'))), workspaceRoot = join(root, 'workspace');
  mkdirSync(workspaceRoot); t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new SqliteRunStore(join(root, 'runs.sqlite')); t.after(() => store.close()); let calls = 0;
  const knowledge = createStudioKnowledgeTools({ agentId: scope.agentId,
    bindings: knowledgeBindings({ bindings: { plugins: [{ config: { binding: { resource: { kind: 'knowledge-base', id: 'kb' } } } }] } }),
    connection: await resourceConnection(t, 'KSADK_KB', createKnowledgeConnection, (action, payload) => {
      calls++; assert.equal(action, 'RetrieveKnowledge'); assert.equal(payload.Query, '完整查询😀');
      const current = store.load(scope, 'run'), intent = current.intents.find(item => item.operationKey === current.snapshot.pendingIntent);
      assert.equal(intent.status, 'running'); assert.equal(intent.kind, 'tool'); assert.equal(intent.claimedFence, current.lease.fence);
      return { Records: [{ Segment: { Content: '原始知识内容', Document: { Name: '来源文档' } } }] };
    }) });
  t.after(() => knowledge.close());
  const h = setup(t, [name], [], { workspaceRoot, stateDir: join(root, 'state'), getKnowledgeTools: () => knowledge });
  const original = h.ctx.tools.execute;
  h.ctx.tools.execute = async request => ({ ...await original(request), content: [{ type: 'text', text: 'Host-filtered knowledge' }] });
  const tools = h.gateway.definitions(h.agent, [...h.registry.values()]); assert.equal(tools[0].readOnly, true);
  assert.equal(h.gateway.knowledgeBinding.datasetIds[0], 'kb');
  const data = fixture({ tools, limits: { effectTimeoutMs: 200000 } }); let models = 0;
  const kernel = new NativeKernel({ store, digest, owner: 'knowledge-worker', ports: { ...h.gateway.forAgent(h.agent, { scope, store }),
    model: { generate: async request => {
      if (++models === 1) return { kind: 'tool_calls', text: '', usage: emptyUsage(), toolCalls: [{ callId: 'knowledge-call', name, arguments: { query: '完整查询😀' } }] };
      assert.equal(request.messages.at(-1).content, 'Host-filtered knowledge');
      return { kind: 'final_candidate', text: 'Done', toolCalls: [], usage: emptyUsage() };
    } } } });
  kernel.start(data.snapshot, data.config); assert.equal((await kernel.runUntilIdle(scope, 'run')).phase, 'completed');
  const before = store.load(scope, 'run');
  assert.ok(before.receipts.some(receipt => receipt.result.results?.some(item => item.content === '[1] (来源: 来源文档) 原始知识内容')));
  await kernel.runUntilIdle(scope, 'run'); assert.deepEqual(store.load(scope, 'run'), before); assert.equal(calls, 1); assert.equal(models, 2);
});
test('only an owned lint builtin pins the workspace syntax engine', t => {
  assert.deepEqual(setup(t, ['lint_workspace_file']).gateway.workspaceSyntax, NATIVE_PYTHON_SYNTAX);
  assert.equal(setup(t).gateway.workspaceSyntax, null);
  assert.equal(setup(t, ['lint_workspace_file'], [{ name: 'lint_workspace_file', executor: 'mcp', resourceId: 'remote' }],
    { executeMcpTool: async () => ({ content: [] }) }).gateway.workspaceSyntax, null);
});

test('actual Native kernel owns all three Skill management effects and preserves old Agent revision and post-policy views', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'native-management-'))), workspaceRoot = join(root, 'workspace');
  mkdirSync(workspaceRoot); t.after(() => rmSync(root, { recursive: true, force: true }));
  const agents = createAgentStore({ storeDir: join(root, 'agents') }), first = await agents.create({ name: 'Native managed', runtimeType: 'harness' });
  const skillDiscovery = createSkillDiscovery({ storeDir: join(root, 'skills') }), nativeScope = { ...scope, agentId: first.metadata.id };
  const store = new SqliteRunStore(join(root, 'runs.sqlite')); t.after(() => store.close());
  let network = 0;
  const skillArchive = createZip([{ name: 'repo-commit/SKILL.md', data: '---\nname: kernel-skill\ndescription: Native receipt\n---\nInstructions' }]);
  const management = createStudioSkillManagement({ workspaceRoot, stateDir: join(root, 'state'), agentId: first.metadata.id, agents, skillDiscovery,
    source: createGithubArchiveSkillSource({ fetchImpl: async (url, request) => {
      request.signal.throwIfAborted(); network++;
      const current = store.load(nativeScope, 'run'), intent = current.intents.find(item => item.operationKey === current.snapshot.pendingIntent);
      assert.equal(current.snapshot.phase, 'executing_tools'); assert.equal(intent.kind, 'tool'); assert.equal(intent.status, 'running');
      assert.equal(intent.claimedFence, current.lease.fence, 'live Native execution fence owns network dispatch');
      if (url === 'https://api.github.com/repos/owner/repo/commits/main') return Response.json({ sha: 'a'.repeat(40) });
      assert.equal(url, `https://codeload.github.com/owner/repo/zip/${'a'.repeat(40)}`); return new Response(skillArchive);
    } }) });
  const names = ['skill_discover_github', 'skill_install', 'skill_bind_agent'];
  const host = setup(t, names, [], { workspaceRoot, stateDir: join(root, 'state'), config: { agentId: first.metadata.id, toolBindings: names },
    getSkillManagement: id => { assert.equal(id, first.metadata.id); return management; } });
  assert.equal(host.gateway.skillManagementBinding.contract, SKILL_MANAGEMENT_CONTRACT);
  const ports = host.gateway.forAgent(host.agent, { scope: nativeScope, store }), tools = host.gateway.definitions(host.agent, [...host.registry.values()]);
  assert.deepEqual(tools.map(tool => tool.name).sort(), [...names].sort());
  const { config, snapshot } = fixture({ tools, limits: { effectTimeoutMs: 200000 } }); snapshot.scope = nativeScope;
  let models = 0, inspection, installed;
  const originalExecute = host.ctx.tools.execute;
  host.ctx.tools.execute = async input => {
    const result = await originalExecute(input);
    if (input.name === 'skill_discover_github') inspection = JSON.parse(result.value.result);
    if (input.name === 'skill_install') installed = JSON.parse(result.value.result).installed_resource;
    return { ...result, content: [{ type: 'text', text: `Host post-policy: ${input.name}` }] };
  };
  const kernel = new NativeKernel({ store, digest, owner: 'management-owner', ports: { ...ports, model: { generate: async input => {
    models++;
    if (models === 1) return { kind: 'tool_calls', text: '', usage: emptyUsage(), toolCalls: [{ callId: 'discover', name: names[0], arguments: { source: 'https://github.com/owner/repo' } }] };
    assert.match(input.messages.filter(message => message.role === 'tool').at(-1).content, /Host post-policy:/);
    if (models === 2) return { kind: 'tool_calls', text: '', usage: emptyUsage(), toolCalls: [{ callId: 'install', name: names[1], arguments: { inspection_token: inspection.inspectionToken, candidate_id: inspection.candidates[0].candidateId } }] };
    if (models === 3) return { kind: 'tool_calls', text: '', usage: emptyUsage(), toolCalls: [{ callId: 'bind', name: names[2], arguments: { resource_id: installed.resourceId } }] };
    return { kind: 'final_candidate', text: 'Done', usage: emptyUsage(), toolCalls: [] };
  } } } });
  kernel.start(snapshot, config); const done = await kernel.runUntilIdle(nativeScope, 'run');
  assert.equal(done.phase, 'completed'); assert.equal(models, 4); assert.equal(network, 2); assert.equal(host.calls.length, 3);
  const record = store.load(nativeScope, 'run'), receipts = record.receipts.flatMap(receipt => receipt.result.results ?? []);
  assert.equal(record.intents.filter(intent => intent.kind === 'tool').length, 3);
  assert.equal(receipts.filter(receipt => receipt.status === 'ok').length, 3);
  assert.equal(receipts.find(receipt => receipt.content?.effective_from).content.revision, 2);
  assert.deepEqual(await agents.getRevision(first.metadata.id, 1), first);
  assert.equal((await agents.get(first.metadata.id)).spec.bindings.skills[0].resourceId, installed.resourceId);
  assert.deepEqual(record.configuration.tools, config.tools);
  assert.equal(done.buildId, snapshot.buildId);
  await kernel.runUntilIdle(nativeScope, 'run'); assert.equal(models, 4); assert.equal(network, 2); assert.equal(host.calls.length, 3);
  const forged = host.request({ source: 'https://github.com/owner/repo' }, names[0]); forged.scope = nativeScope;
  await assert.rejects(ports.tools.execute(forged), /authority|unbound|stale/); assert.equal(network, 2);
});
function setup(t, names = ['write_workspace_file'], contracts = [], options = {}) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'studio-native-tools-')), workspaceRoot = join(root, 'workspace');
  mkdirSync(workspaceRoot); t.after(() => rmSync(root, { recursive: true, force: true }));
  const registry = new Map(), calls = [];
  let deny = false, postFailure = false;
  const ctx = { effect: install => install(), sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }) }, tools: {
    register: tool => { registry.set(tool.name, tool); return () => registry.delete(tool.name); },
    execute: async input => {
      calls.push(input);
      if (deny) return { isError: true, content: [{ type: 'text', text: 'Policy denied' }] };
      const registered = registry.get(input.name), value = await registered.execute(input.arguments, input);
      if (postFailure) return { isError: true, content: [{ type: 'text', text: 'Post-execution pipeline failed' }] };
      return { isError: false, value, content: registered.output.render(input.arguments, value) };
    },
  } };
  if (options.argumentEncodings) ctx.tools.argumentEncodings = options.argumentEncodings;
  const gateway = createNativeDshTools({ ctx, config: { agentId: scope.agentId, toolBindings: names, toolContracts: contracts }, workspaceRoot, stateDir: join(root, 'state'), ...options });
  t.after(() => gateway.close());
  const agent = { session: { id: 'session' } };
  const definitions = () => gateway.definitions(agent, [...registry.values()]);
  const request = (arguments_ = { path: 'file.txt', content: 'value' }, name = names[0]) => ({
    scope, runId: 'run', sessionId: 'session', turnId: '1', buildId: 'build', parentRunId: null, taskChainId: 'chain',
    operationKey: 'operation', signal: new AbortController().signal, call: { callId: 'provider-id', name, arguments: arguments_ },
    definition: definitions().find(item => item.name === name), interaction: null,
  });
  return { gateway, agent, request, registry, workspaceRoot, calls, ctx,
    deny: () => { deny = true; }, postFailure: () => { postFailure = true; } };
}

async function sourceRuntime(t, h, artifactFailure = false, protocol = 'openai-chat') {
  const root = join(h.workspaceRoot, '..'), store = new SqliteRunStore(join(root, 'source.sqlite')); t.after(() => store.close());
  const artifacts = await createNativeArtifactStore({ directory: join(root, 'source-artifacts'), scope });
  const context = createNativeContextPort({ protocol, model: 'source-model' });
  const tools = [...h.gateway.definitions(h.agent, [...h.registry.values()], { sourceObservationPolicy: 'workspace-source-model/v1' }), ...artifactToolDefinitions()];
  const data = fixture({ sourceReadPolicy: 'studio-source-read/v1', artifactPolicy: 'runtime-artifacts/v1', tools,
    profile: { ...fixture().config.profile, contextWindow: 64000, maxOutputTokens: 1000 },
    contextPolicy: { tokenizerId: context.tokens.tokenizerId, tokenizerDigest: context.tokens.tokenizerDigest, enabled: true,
      triggerRatio: 0.9, targetRatio: 0.6, summaryMaxTokens: 400, maxCompactions: 10,
      maxCompactionsWithoutProgress: 3, minModelTurnsBetween: 0, maxSummaryRetries: 1 },
    limits: { maxToolResultBytes: 1400, effectTimeoutMs: 200000 } });
  const authority = createNativeToolAuthority({ scope, sessionId: 'session', store });
  const bound = h.gateway.forAgent(h.agent, { scope, store });
  const ports = { ...bound, context, artifacts: artifactFailure ? { ...artifacts, write: async () => { throw Error('archive unavailable'); } } : artifacts,
    tools: { ...bound.tools, execute: async request => {
      assert.equal(authority(request), true);
      if (request.sourceReadBudget) {
        assert.equal(authority({ ...request, sourceReadBudget: { ...request.sourceReadBudget, maxSourceUnits: request.sourceReadBudget.maxSourceUnits + 1 } }), false);
        const missing = { ...request }; delete missing.sourceReadBudget; assert.equal(authority(missing), false);
      }
      return bound.tools.execute(request);
    } } };
  return { ...data, store, artifacts, ports };
}

test('scoped instructions observe committed parent file receipts and can replay without executing tools', async t => {
  const h = setup(t, ['read_workspace_file']);
  mkdirSync(join(h.workspaceRoot, 'pkg'));
  writeFileSync(join(h.workspaceRoot, 'pkg/file.ts'), 'export const value = 1;');
  const { config, snapshot } = fixture({ tools: h.gateway.definitions(h.agent, [...h.registry.values()]) });
  const store = new SqliteRunStore(join(h.workspaceRoot, '..', 'instructions.sqlite'));
  t.after(() => store.close()); store.create(config, snapshot);
  let calls = 0;
  const bound = h.gateway.forAgent(h.agent, { scope, store });
  const kernel = new NativeKernel({ store, digest, owner: 'instruction-observer', ports: { ...bound,
    input: { prepare: async () => {
      const record = store.load(scope, 'run');
      assert.ok(record.events.some(event => event.kind === 'tool.completed' && event.payload.status === 'ok'));
      assert.deepEqual(h.gateway.instructionTouches(h.agent, record), calls === 1 ? [join(h.workspaceRoot, 'pkg/file.ts')] : []);
      const executions = h.calls.length;
      assert.deepEqual(h.gateway.instructionTouches(h.agent, structuredClone(record)), h.gateway.instructionTouches(h.agent, record));
      assert.equal(h.calls.length, executions, 'replay observes receipts without repeating the filesystem operation');
      assert.throws(() => h.gateway.instructionTouches({ session: { id: 'child' } }, record), /session_mismatch/);
      return { status: 'admitted', messages: [] };
    } },
    model: { generate: async () => ++calls === 1
      ? { kind: 'tool_calls', text: '', usage: emptyUsage(), toolCalls: [{ callId: 'file', name: 'read_workspace_file', arguments: { path: 'pkg/file.ts' } }] }
      : { kind: 'final_candidate', text: 'done', toolCalls: [], usage: emptyUsage() } },
  } });
  assert.deepEqual(h.gateway.instructionTouches(h.agent, store.load(scope, 'run')), []);
  assert.equal((await kernel.runUntilIdle(scope, 'run')).phase, 'completed');
  assert.equal(h.calls.length, 1);
});

test('committed structured patch receipts refresh every affected instruction scope without replay', async t => {
  const h = setup(t, ['apply_workspace_patch']);
  mkdirSync(join(h.workspaceRoot, 'old')); writeFileSync(join(h.workspaceRoot, 'old/file.ts'), 'before\n');
  const { config, snapshot } = fixture({ tools: h.gateway.definitions(h.agent, [...h.registry.values()]) });
  const store = new SqliteRunStore(join(h.workspaceRoot, '..', 'patch-instructions.sqlite')); t.after(() => store.close());
  let models = 0, observed = false;
  const kernel = new NativeKernel({ store, digest, owner: 'patch-instructions', ports: {
    ...h.gateway.forAgent(h.agent, { scope, store }),
    input: { prepare: async () => {
      const record = store.load(scope, 'run');
      if (models === 1) {
        observed = true;
        const expected = ['new/file.ts', 'old/file.ts', 'nested/AGENTS.md'].map(path => join(h.workspaceRoot, path));
        assert.deepEqual(new Set(h.gateway.instructionTouches(h.agent, record)), new Set(expected));
        const executions = h.calls.length;
        assert.deepEqual(h.gateway.instructionTouches(h.agent, structuredClone(record)), h.gateway.instructionTouches(h.agent, record));
        assert.equal(h.calls.length, executions);
        const failed = structuredClone(record);
        for (const event of failed.events) if (event.kind === 'tool.completed') event.payload.status = 'error';
        assert.deepEqual(h.gateway.instructionTouches(h.agent, failed), []);
      }
      return { status: 'admitted', messages: [] };
    } },
    model: { generate: async () => ++models === 1
      ? { kind: 'tool_calls', text: '', usage: emptyUsage(), toolCalls: [{ callId: 'patch', name: 'apply_workspace_patch', arguments: {
        patch_text: '*** Begin Patch\n*** Update File: old/file.ts\n*** Move to: new/file.ts\n@@\n-before\n+after\n*** Add File: nested/AGENTS.md\n+Nested instructions\n*** End Patch',
      } }] }
      : { kind: 'final_candidate', text: 'done', toolCalls: [], usage: emptyUsage() } },
  } });
  kernel.start(snapshot, config); assert.equal((await kernel.runUntilIdle(scope, 'run')).phase, 'completed');
  assert.equal(observed, true); assert.equal(h.calls.length, 1);
  assert.equal(readFileSync(join(h.workspaceRoot, 'new/file.ts'), 'utf8'), 'after\n');
  assert.equal(existsSync(join(h.workspaceRoot, 'old/file.ts')), false);
  assert.deepEqual(h.gateway.instructionTouches(h.agent, store.load(scope, 'run')), []);
});

for (const protocol of ['openai-chat', 'openai-responses', 'anthropic-messages'])
for (const redact of [false, true]) test(`${protocol}: source capture uses already-read authorized bytes, and real scoped search/read preserve coordinates (redacted: ${redact})`, async t => {
  const h = setup(t, ['read_workspace_file']);
  const lines = Array.from({ length: 80 }, (_, index) => `row-${index + 1} ${'中文😀'.repeat(20)}${index === 59 ? ' state=confirmed' : ''}`);
  writeFileSync(join(h.workspaceRoot, 'source.txt'), lines.join('\n'));
  const original = h.ctx.tools.execute;
  h.ctx.tools.execute = async request => {
    const result = await original(request), raw = parseNativeJson(result.content[0].text);
    if (redact) delete raw.requested_source;
    writeFileSync(join(h.workspaceRoot, 'source.txt'), 'CURRENT FILE WAS REPLACED AFTER THE READ');
    return { ...result, content: [{ type: 'text', text: canonical(raw) }] };
  };
  const { config, snapshot, store, artifacts, ports } = await sourceRuntime(t, h, false, protocol); let turns = 0, visible;
  const kernel = new NativeKernel({ store, digest, owner: 'source-capture', ports: { ...ports, model: { generate: async request => {
    if (++turns === 1) return { kind: 'tool_calls', text: '', usage: emptyUsage(), toolCalls: [{ callId: 'source', name: 'read_workspace_file',
      arguments: { path: 'source.txt', start_line: 31, end_line: 60, include_line_numbers: false, max_chars: 1000 } }] };
    if (turns === 2) {
      visible = parseNativeJson(request.messages.find(message => message.role === 'tool').content);
      assert.equal(visible.status, 'ok'); assert.equal(visible.artifact_state, 'available');
      assert.equal(visible.content.path, 'source.txt'); assert.ok(visible.content.line_count > 0); assert.ok(visible.content.end_line < 60);
      assert.equal(visible.content.requested_source, undefined); assert.equal(visible.content.mtime_ns, undefined);
      return { kind: 'tool_calls', text: '', usage: emptyUsage(), toolCalls: [
        { callId: 'search', name: 'ArtifactSearch', arguments: { uris: [visible.artifact_uri], query: 'state=confirmed' } },
        { callId: 'page', name: 'ArtifactRead', arguments: { uri: visible.artifact_uri, limit_chars: 32000 } }] };
    }
    const search = parseNativeJson(request.messages.find(message => message.name === 'ArtifactSearch').content);
    assert.equal(search.complete, true);
    assert.equal(search.observation_type, 'scoped-artifact-search/v1'); assert.equal(search.results.length, 1);
    assert.equal(search.results[0].uri, visible.artifact_uri);
    if (redact) assert.deepEqual(search.results[0].matches, []);
    else { assert.equal(search.results[0].matches[0].source_line, 60); assert.equal(search.results[0].source_path, 'source.txt'); }
    const page = parseNativeJson(request.messages.find(message => message.name === 'ArtifactRead').content);
    assert.equal(page.uri, visible.artifact_uri); assert.ok(page.returned_chars > 0); assert.ok(page.next_offset > 0);
    return { kind: 'final_candidate', text: 'Done', toolCalls: [], usage: emptyUsage() };
  } } } });
  kernel.start(snapshot, config); const end = await kernel.runUntilIdle(scope, 'run'); assert.equal(end.phase, 'completed',
    canonical({ reason: end.reason, artifacts: end.messages.filter(message => ['ArtifactSearch', 'ArtifactRead'].includes(message.name)) }));
  assert.equal(h.calls.length, 1, 'reserved tools bypass DSH registry and source is not read again');
  assert.equal(end.artifactRefs.length, 1); const ref = end.artifactRefs[0];
  const archived = await artifacts.read({ ...h.request(), ref, offset: 0, limit: 32000 });
  const receipt = store.load(scope, 'run').receipts.find(receipt => receipt.result.results)?.result.results[0];
  assert.equal(receipt.content.requested_source.content, lines.slice(30, 60).join('\n'));
  if (redact) { assert.notEqual(ref.mediaType, CAPTURED_SOURCE_MEDIA_TYPE); assert.ok(!archived.content.includes('state=confirmed')); }
  else {
    assert.equal(ref.mediaType, CAPTURED_SOURCE_MEDIA_TYPE); const captured = decodeCapturedSource(archived.content);
    assert.equal(captured.content, lines.slice(30, 60).join('\n')); assert.deepEqual(captured.read_range, { start: 31, end: 60 });
  }
  assert.equal(readFileSync(join(h.workspaceRoot, 'source.txt'), 'utf8'), 'CURRENT FILE WAS REPLACED AFTER THE READ');
});

for (const artifactFailure of [false, true]) test(`saving an unread source cannot satisfy edit preconditions or create source progress (archive failure: ${artifactFailure})`, async t => {
  const h = setup(t, ['read_workspace_file', 'edit_workspace_file']), original = 'a'.repeat(6000);
  writeFileSync(join(h.workspaceRoot, 'unread.txt'), original);
  const { config, snapshot, store, ports } = await sourceRuntime(t, h, artifactFailure); let turns = 0;
  const kernel = new NativeKernel({ store, digest, owner: 'source-unread', ports: { ...ports, model: { generate: async request => {
    if (++turns === 1) return { kind: 'tool_calls', text: '', usage: emptyUsage(), toolCalls: [{ callId: 'source', name: 'read_workspace_file',
      arguments: { path: 'unread.txt', max_chars: 1000 } }] };
    if (turns === 2) {
      const unread = parseNativeJson(request.messages.find(message => message.role === 'tool').content);
      assert.equal(unread.content.source_state, 'unread'); assert.equal(unread.content.content, undefined);
      assert.equal(unread.artifact_state, artifactFailure ? 'unavailable' : 'available');
      assert.equal(unread.artifact_uri === undefined, artifactFailure);
      return { kind: 'tool_calls', text: '', usage: emptyUsage(), toolCalls: [{ callId: 'edit', name: 'edit_workspace_file',
        arguments: { path: 'unread.txt', old_text: 'aaa', new_text: 'bbb' } }] };
    }
    const edited = parseNativeJson(request.messages.find(message => message.name === 'edit_workspace_file').content);
    assert.equal(edited.ok, false); assert.match(edited.error_message, /read/i);
    return { kind: 'final_candidate', text: 'Done', toolCalls: [], usage: emptyUsage() };
  } } } });
  kernel.start(snapshot, config); const end = await kernel.runUntilIdle(scope, 'run'); assert.equal(end.phase, 'completed');
  assert.equal(readFileSync(join(h.workspaceRoot, 'unread.txt'), 'utf8'), original);
  assert.equal(end.context.observedSourceRevision ?? 0, 0);
  const result = store.load(scope, 'run').receipts.find(receipt => receipt.result.results)?.result.results[0];
  assert.equal(result.sourceObservationState, 'unread'); assert.equal(result.content.requested_source.content, `1 | ${original}`);
});

for (const firstAction of ['read', 'edit']) test(`rewind adopts workspace branch before the first ${firstAction} captures read state`, async t => {
  const h = setup(t, ['read_workspace_file', 'edit_workspace_file']);
  writeFileSync(join(h.workspaceRoot, 'branch.txt'), 'original');
  const store = new MemoryRunStore(), tools = h.gateway.definitions(h.agent, [...h.registry.values()]);
  const { config, snapshot } = fixture({ tools });
  let calls = 0;
  const read = { callId: 'fresh-read', name: 'read_workspace_file', arguments: { path: 'branch.txt' } };
  const edit = { callId: 'fresh-edit', name: 'edit_workspace_file', arguments: { path: 'branch.txt', old_text: 'original', new_text: 'fresh' } };
  const reply = toolCall => ({ kind: 'tool_calls', text: '', usage: emptyUsage(), toolCalls: [toolCall] });
  const final = () => ({ kind: 'final_candidate', text: 'Done', usage: emptyUsage(), toolCalls: [] });
  const kernel = new NativeKernel({ store, digest, owner: 'branch-reader', ports: { ...h.gateway.forAgent(h.agent, { scope, store }),
    model: { generate: async request => {
      ++calls;
      if (calls === 1) return reply(read);
      if (calls === 2) return final();
      if (calls === 3) return reply(firstAction === 'edit' ? { ...edit, callId: 'removed-read-edit' } : read);
      if (calls === 4 && firstAction === 'edit') {
        const blocked = parseNativeJson(request.messages.filter(message => message.role === 'tool').at(-1).content);
        assert.equal(blocked.ok, false); assert.equal(blocked.error_type, 'file_not_read');
        assert.equal(readFileSync(join(h.workspaceRoot, 'branch.txt'), 'utf8'), 'original');
        return reply(read);
      }
      if (calls === (firstAction === 'edit' ? 5 : 4)) return reply(edit);
      const edited = parseNativeJson(request.messages.filter(message => message.role === 'tool').at(-1).content);
      assert.equal(edited.ok, true); assert.equal(edited.replacements, 1);
      return final();
    } } } });
  kernel.start(snapshot, config); assert.equal((await kernel.runUntilIdle(scope, 'run')).phase, 'completed');
  const before = store.load(scope, 'run');
  const rewindConfig = configure({ ...config, conversationSeed: { contract: 'native-conversation-fork/v1', source: {
    parentSessionId: 'session', sessionId: 'session', runId: 'run', turnId: snapshot.turnId, boundarySeq: 0,
    snapshotRevision: before.snapshot.revision, configDigest: before.snapshot.configDigest,
    snapshotDigest: digest(before.snapshot), transcriptDigest: 'before-first-input' }, messages: [] },
  conversationRewind: { contract: 'native-conversation-rewind/v1', commandId: 'rewind', expectedHeadRunId: 'run', generation: 1, markerDigest: 'marker' } });
  kernel.start({ ...snapshot, runId: 'rewound', turnId: '2' }, rewindConfig);
  assert.equal((await kernel.runUntilIdle(scope, 'rewound')).phase, 'completed');
  assert.equal(readFileSync(join(h.workspaceRoot, 'branch.txt'), 'utf8'), 'fresh');
  assert.deepEqual(store.load(scope, 'run'), before);
});

test('deadline tools are pinned only from trusted builtins and never granted by an external name', t => {
  const names = ['read_workspace_file', 'write_workspace_file', 'edit_workspace_file', 'search_workspace_files'];
  const h = setup(t, names), original = h.gateway.definitions(h.agent, []);
  assert.ok(original.every(tool => tool.deliveryWrite === undefined && tool.deliveryArtifactRole === undefined));
  const defs = h.gateway.definitions(h.agent, [], { deadlineDelivery: true });
  assert.equal(defs.find(tool => tool.name === 'read_workspace_file').deliveryArtifactRole, 'read');
  for (const name of ['write_workspace_file', 'edit_workspace_file']) {
    const tool = defs.find(tool => tool.name === name); assert.equal(tool.deliveryArtifactRole, 'write'); assert.equal(tool.deliveryWrite, true);
  }
  assert.equal(defs.find(tool => tool.name === 'search_workspace_files').deliveryArtifactRole, undefined);
  const external = setup(t, ['write_workspace_file'], [{ name: 'write_workspace_file', executor: 'mcp' }]);
  const schema = [{ name: 'write_workspace_file', parameters: { type: 'object', properties: {} } }];
  const untrusted = external.gateway.definitions(external.agent, schema, { deadlineDelivery: true })[0];
  assert.equal(untrusted.deliveryWrite, undefined); assert.equal(untrusted.deliveryArtifactRole, undefined);
});

test('product deadline tool versions preserve editor and self-read admission independently of numeric time', t => {
  const names = ['read_workspace_file', 'write_workspace_file', 'edit_workspace_file'];
  const h = setup(t, names);
  for (let version = 1; version <= 7; version++) {
    const defs = h.gateway.definitions(h.agent, [], { deadlineDelivery: true, wallDeliveryPolicy: `deadline-delivery/v${version}`, exactContentPolicy: true });
    assert.equal(defs.find(tool => tool.name === names[1]).deliveryWrite, true);
    assert.equal(!!defs.find(tool => tool.name === names[2]).deliveryWrite, version >= 5);
    for (const tool of defs) assert.equal(!!tool.deliveryArtifactRole, version >= 6);
    assert.equal(defs.find(tool => tool.name === names[1]).exactContentPolicy, 'current-goal-utf8/v1');
    assert.equal(defs.find(tool => tool.name === names[2]).exactContentPolicy, version >= 5 ? 'complete-write-only/v1' : undefined);
    assert.equal(defs.find(tool => tool.name === names[1]).description.includes('incomplete calls wrote nothing'), version >= 5);
  }
  const noEditor = setup(t, names.slice(0, 2));
  const limited = noEditor.gateway.definitions(noEditor.agent, [], { deadlineDelivery: true, wallDeliveryPolicy: 'deadline-delivery/v7' });
  assert.ok(limited.every(tool => tool.deliveryArtifactRole === undefined), 'self-read requires a trusted bound editor');
  assert.throws(() => h.gateway.definitions(h.agent, [], { wallDeliveryPolicy: 'deadline-delivery/v8' }), /deadline_policy_invalid/);
});

test('actual Native gateway rejects wrong exact UTF-8 writes and delivery edits before any filesystem effect', async t => {
  const h = setup(t, ['read_workspace_file', 'write_workspace_file', 'edit_workspace_file']);
  const tools = h.gateway.definitions(h.agent, [], { deadlineDelivery: true, wallDeliveryPolicy: 'deadline-delivery/v7', exactContentPolicy: true });
  const store = new MemoryRunStore(), task = '在工作区创建 report.txt，内容恰好是 hello😀。完成后回复路径。';
  const data = fixture({ tools, wallDeliveryPolicy: 'deadline-delivery/v7', contract: { objective: task } }); let models = 0;
  const observations = [];
  const kernel = new NativeKernel({ store, digest, owner: 'exact-content', ports: { ...h.gateway.forAgent(h.agent, { scope, store }),
    model: { generate: async request => {
      models++;
      if (models === 2 || models === 3) observations.push({ message: request.messages.at(-1), calls: h.calls.length });
      return models <= 3 ? { kind: 'tool_calls', text: '', usage: emptyUsage(), toolCalls: [{ callId: `exact-${models}`,
        name: models === 2 ? 'edit_workspace_file' : 'write_workspace_file', arguments: models === 2
          ? { path: 'report.txt', old_text: 'hello', new_text: 'hello😀' }
          : { path: 'report.txt', content: models === 1 ? 'hello😃' : 'hello😀' } }] }
        : { kind: 'final_candidate', text: 'report.txt', toolCalls: [], usage: emptyUsage() };
    } } } });
  kernel.start(data.snapshot, data.config); const result = await kernel.runUntilIdle(scope, 'run');
  assert.equal(result.phase, 'completed'); assert.equal(models, 4);
  assert.equal(JSON.parse(observations[0].message.content).code, 'workspace_content_contract_mismatch');
  assert.equal(JSON.parse(observations[0].message.content).difference.firstMismatchByte, 8);
  assert.equal(JSON.parse(observations[1].message.content).code, 'workspace_exact_content_requires_write');
  assert.deepEqual(observations.map(item => item.calls), [0, 0]);
  const last = store.load(scope, 'run').receipts.filter(receipt => receipt.result.results).at(-1).result.results[0];
  assert.equal(last.status, 'ok', JSON.stringify(last)); assert.equal(h.calls.length, 1);
  assert.equal(readFileSync(join(h.workspaceRoot, 'report.txt'), 'utf8'), 'hello😀');
  await kernel.runUntilIdle(scope, 'run'); assert.equal(h.calls.length, 1);
});

test('separate vision deadlines are Session-owned formal definitions and dispose independently', async t => {
  const h = setup(t, ['browser_inspect_workspace']);
  const before = h.gateway.definitions(h.agent, []);
  const dispose = h.gateway.bindVision({ sessionId: 'session', requestTimeoutMs: 150000 });
  assert.equal(h.gateway.definitions(h.agent, [])[0].timeoutMs, 261000);
  assert.equal(h.gateway.definitions({ session: { id: 'other' } }, [])[0].timeoutMs, 110000);
  assert.throws(() => h.gateway.bindVision({ sessionId: 'session', requestTimeoutMs: 1 }), /already_bound/);
  const otherDispose = h.gateway.bindVision({ sessionId: 'other', requestTimeoutMs: 200000 });
  dispose(); dispose();
  assert.deepEqual(h.gateway.definitions(h.agent, []), before);
  assert.equal(h.gateway.definitions({ session: { id: 'other' } }, [])[0].timeoutMs, 311000);
  otherDispose();
});

test('readonly completion gateway reconnects to a real local command using the original SQLite launch receipt', async t => {
  const h = setup(t, ['run_command', 'read_command_output']), store = new SqliteRunStore(join(h.workspaceRoot, '..', 'runs.sqlite'));
  t.after(() => store.close());
  const data = fixture({ tools: h.gateway.definitions(h.agent, [...h.registry.values()]),
    backgroundNotificationPolicy: 'completed-before-model/v1', limits: { effectTimeoutMs: 1000000 } });
  let models = 0;
  const bound = h.gateway.forAgent(h.agent, { scope, store });
  const kernel = new NativeKernel({ store, digest, owner: 'real-command-launch', ports: { tools: bound.tools,
    // Isolate the new idle reader: the ordinary turn leaves this command for
    // idle observation, while the launch and backend receipt are real.
    background: { contract: BACKGROUND_COMMAND_CONTRACT, observe: async () => [] },
    model: { generate: async () => ++models === 1 ? { kind: 'tool_calls', text: '', usage: emptyUsage(),
      toolCalls: [{ callId: 'launch-command', name: 'run_command', arguments: { command: 'printf observer-proof', background: true } }] }
      : { kind: 'final_candidate', text: 'Started', toolCalls: [], usage: emptyUsage() } } } });
  kernel.start(data.snapshot, data.config);
  const source = await kernel.runUntilIdle(scope, 'run');
  assert.equal(source.phase, 'completed'); assert.equal(source.backgroundCommands.length, 1);
  const ref = source.backgroundCommands[0].ref;
  const observer = h.gateway.backgroundObserver(h.agent, { scope, store });
  assert.deepEqual(Object.keys(observer), ['contract', 'observeCompletion']); assert.equal(observer.execute, undefined);
  assert.equal(observer.contract, BACKGROUND_COMMAND_CONTRACT);
  const request = { contract: BACKGROUND_NOTIFICATION_ADMISSION, scope, sourceRunId: 'run', sessionId: 'session',
    sourceConfigDigest: source.configDigest, sourceRevision: source.revision, headRunId: 'run', ref,
    signal: AbortSignal.timeout(5000) };
  let observed;
  do {
    request.signal.throwIfAborted();
    observed = await observer.observeCompletion(request);
    if (!observed || observed.status === 'unavailable') await new Promise(resolve => setTimeout(resolve, 10));
  } while (!observed || observed.status === 'unavailable');
  assert.equal(observed.status, 'completed'); assert.equal(observed.stdout, 'observer-proof');
  assert.equal(h.calls.filter(call => call.name === 'run_command').length, 1);
  assert.throws(() => observer.observeCompletion({ ...request, sessionId: 'foreign' }), /observer_unbound/);
  assert.throws(() => h.gateway.backgroundObserver(h.agent, { scope: { ...scope, agentId: 'foreign' }, store }), /observer_unbound/);
  h.gateway.close();
  assert.throws(() => observer.observeCompletion(request), /observer_unbound/);
});

test('child reads use independent workspace state and cannot grant writes to either child or parent', async t => {
  const host = setup(t, ['read_workspace_file', 'write_workspace_file']);
  writeFileSync(join(host.workspaceRoot, 'proof.txt'), 'Original');
  const childScope = { ...scope, agentId: 'child' }, store = new MemoryRunStore();
  const child = host.gateway.forChild(host.agent, { scope: childScope, store,
    sessionId: 'child-session', toolNames: ['read_workspace_file'] });
  assert.deepEqual(Object.keys(child).sort(), ['tools', 'workspace']);
  const request = { ...host.request({ path: 'proof.txt' }, 'read_workspace_file'), scope: childScope, sessionId: 'child-session' };
  const { config, snapshot } = fixture({ tools: host.gateway.definitions(host.agent, [...host.registry.values()])
    .filter(tool => tool.name === 'read_workspace_file') });
  let calls = 0;
  const kernel = new NativeKernel({ store, digest, owner: 'child-reader', ports: { ...child, model: { generate: async input => {
    if (++calls === 1) return { kind: 'tool_calls', text: '', usage: emptyUsage(), toolCalls: [{ callId: 'read-child',
      name: 'read_workspace_file', arguments: { path: 'proof.txt' } }] };
    assert.equal(parseNativeJson(input.messages.filter(message => message.role === 'tool').at(-1).content).ok, true);
    return { kind: 'final_candidate', text: 'Done', usage: emptyUsage(), toolCalls: [] };
  } } } });
  kernel.start({ ...snapshot, scope: childScope, sessionId: 'child-session' }, config);
  assert.equal((await kernel.runUntilIdle(childScope, 'run')).phase, 'completed');
  const before = host.calls.length;
  await assert.rejects(child.tools.execute({ ...request, scope: { ...childScope, workspaceId: 'foreign' } }), /child_tool_not_bound/);
  await assert.rejects(child.tools.execute({ ...request, call: { ...request.call, name: 'write_workspace_file', arguments: { path: 'proof.txt', content: 'Forged' } } }), /child_tool_not_bound/);
  assert.equal(host.calls.length, before);
  assert.throws(() => host.gateway.forChild(host.agent, { scope: childScope, store: new MemoryRunStore(), sessionId: 'child-session',
    toolNames: ['write_workspace_file'] }), /child_tools_not_bound/);
  const parent = host.gateway.forAgent(host.agent).tools;
  assert.equal((await parent.execute(host.request({ path: 'proof.txt', content: 'Replacement' }, 'write_workspace_file'))).status, 'error');
  assert.equal(readFileSync(join(host.workspaceRoot, 'proof.txt'), 'utf8'), 'Original');
  await parent.execute(host.request({ path: 'proof.txt' }, 'read_workspace_file'));
  assert.equal((await parent.execute(host.request({ path: 'proof.txt', content: 'Replacement' }, 'write_workspace_file'))).status, 'ok');
});

test('an allowed registry pipeline cannot bypass read-only Native writes or reuse a one-shot approval', async t => {
  const host = setup(t), requests = [];
  host.ctx.sandboxPolicy.resolve = () => ({ mode: 'read-only' });
  let outcome = 'rejected';
  host.ctx.approval = { request: async request => { requests.push(request); return outcome; } };
  const tool = host.gateway.forAgent(host.agent).tools;
  await assert.rejects(tool.execute(host.request()), { code: 'STUDIO_NATIVE_PERMISSION_DENIED' });
  assert.equal(existsSync(join(host.workspaceRoot, 'file.txt')), false);
  outcome = 'allowed-once';
  assert.equal((await tool.execute(host.request())).status, 'ok');
  assert.equal(readFileSync(join(host.workspaceRoot, 'file.txt'), 'utf8'), 'value');
  outcome = 'rejected';
  await assert.rejects(tool.execute(host.request({ path: 'second.txt', content: 'forbidden' })), { code: 'STUDIO_NATIVE_PERMISSION_DENIED' });
  assert.equal(existsSync(join(host.workspaceRoot, 'second.txt')), false);
  assert.equal(requests.length, 3); assert.ok(requests.every(request => request.agent === host.agent && request.toolName === 'write_workspace_file'));
});

for (const invalidOutput of [false, true]) test(`Native MCP pins exact input/output schemas through the ledger (invalid output: ${invalidOutput})`, async t => {
  const integer = 9007199254740993n;
  const parameters = { type: 'object', required: ['id'], properties: { id: { type: 'integer', minimum: integer, maximum: integer } } };
  const nativeMcpSchema = JSON.parse(JSON.stringify(snapshotNativeMcpSchema({ inputSchema: parameters, outputSchema: parameters })));
  let effects = 0, models = 0;
  const reply = { content: [], structuredContent: { id: invalidOutput ? integer - 1n : integer }, _meta: { private: 'do-not-send' } };
  const contract = { name: 'exact', executor: 'mcp', resourceId: 'remote', nativeMcpSchema };
  const host = setup(t, ['exact'], [contract], {
    argumentEncodings: ['dsh.raw-json-number/v1'], executeMcpTool: async request => {
      effects++; assert.equal(request.resourceId, 'remote');
      assert.equal(JSON.stringify(request.arguments), '{"id":9007199254740993}'); return reply;
    },
  });
  contract.resourceId = 'changed-after-binding';
  contract.nativeMcpSchema.outputJson = '{"not":{}}';
  const request = host.request({ id: integer }, 'exact');
  assert.deepEqual(request.definition.parameters, parameters);
  const { config, snapshot } = fixture({ tools: [request.definition] }), store = new MemoryRunStore();
  const kernel = new NativeKernel({ store, digest, owner: 'worker', ports: { ...host.gateway.forAgent(host.agent), model: {
    generate: async input => {
      models++;
      if (models <= 2) return { kind: 'tool_calls', text: '', usage: emptyUsage(), toolCalls: [{ ...request.call,
        callId: `schema-${models}`, arguments: { id: models === 1 ? integer - 1n : integer } }] };
      const results = input.messages.filter(message => message.role === 'tool');
      assert.match(results[0].content, /invalid_arguments/);
      assert.equal(results[1].content.includes('mcp_output_schema_invalid'), invalidOutput);
      assert.equal(results[1].content.includes('do-not-send'), false);
      return { kind: 'final_candidate', text: 'Done', usage: emptyUsage(), toolCalls: [] };
    },
  } } });
  kernel.start(snapshot, config);
  const done = await kernel.runUntilIdle(scope, 'run');
  assert.equal(done.phase, 'completed'); assert.equal(effects, 1); assert.equal(host.calls.length, 1);
  const receipts = store.load(scope, 'run').receipts.flatMap(receipt => receipt.result.results ?? []);
  const receipt = receipts.find(result => result.content?.structuredContent);
  assert.deepEqual(receipt.content, reply);
  assert.equal(receipt.status, invalidOutput ? 'error' : 'ok');
  await kernel.runUntilIdle(scope, 'run'); assert.equal(effects, 1); assert.equal(models, 3);
  assert.throws(() => host.gateway.definitions(host.agent, [{ name: 'exact', parameters: { type: 'object' } }]), /studio_native_mcp_schema_binding_changed/);
});

test('Plan MCP admission binds actual MCP identity, preserves Host denials and freezes restored selections', async t => {
  const contracts = ['allowed', 'destructive', 'blocked_by_host', 'legacy'].map(name => ({ name, executor: 'mcp', resourceId: 'catalog',
    ...(name === 'legacy' ? {} : { nativeMcpPlanAccess: snapshotNativeMcpPlanAccess({ annotations: { destructiveHint: name === 'destructive' } }) }) }));
  let effects = 0;
  const host = setup(t, contracts.map(row => row.name), contracts, { executeMcpTool: async request => {
    effects++; assert.equal(request.name, 'allowed'); return { content: [{ type: 'text', text: 'Exploration result' }] };
  } });
  const schemas = [...host.registry.values()];
  assert.ok(host.gateway.definitions(host.agent, schemas).every(tool => !tool.planModeAccess), 'Old Runs keep absence');
  const tools = host.gateway.definitions(host.agent, schemas, { planModeMcpAccess: true });
  assert.equal(tools.find(tool => tool.name === 'legacy').planModeAccess, undefined);
  assert.ok(tools.every(tool => !tool.readOnly && !tool.concurrentSafe && tool.recoveryPolicy !== 'safe-read/v1'));
  contracts[0].nativeMcpPlanAccess.destructive = true;
  tools[0].planModeAccess.destructive = true;
  const frozen = host.gateway.definitions(host.agent, schemas, { planModeMcpAccess: ['allowed'] });
  assert.deepEqual(frozen.filter(tool => tool.planModeAccess).map(tool => tool.name), ['allowed']);
  assert.equal(frozen[0].planModeAccess.destructive, false, 'Caller mutations cannot change the binding');
  const execute = host.ctx.tools.execute;
  host.ctx.tools.execute = request => request.name === 'blocked_by_host'
    ? { isError: true, content: [{ type: 'text', text: 'Host policy denied' }] } : execute(request);
  const data = fixture({ planModePolicy: 'session-plan/v1', planModeInitialActive: true,
    tools: [...host.gateway.definitions(host.agent, schemas, { planModeMcpAccess: true }), ...planModeToolDefinitions()],
    limits: { effectTimeoutMs: 200000 } });
  const store = new MemoryRunStore(); let models = 0;
  const kernel = new NativeKernel({ store, digest, owner: 'mcp-plan', ports: { ...host.gateway.forAgent(host.agent, { scope, store }),
    model: { generate: async request => {
      if (++models === 1) return { kind: 'tool_calls', text: '', usage: emptyUsage(),
        toolCalls: contracts.map(({ name }) => ({ callId: name, name, arguments: {} })) };
      const messages = request.messages.filter(message => message.role === 'tool');
      assert.equal(messages.filter(message => message.content.includes('plan_mode_write_denied')).length, 2);
      assert.ok(messages.some(message => message.content.includes('Host policy denied')));
      return { kind: 'final_candidate', text: 'Done', usage: emptyUsage(), toolCalls: [] };
    } } } });
  kernel.start(data.snapshot, data.config); const done = await kernel.runUntilIdle(scope, 'run');
  assert.equal(done.phase, 'completed'); assert.equal(done.planMode.active, true); assert.equal(effects, 1);
  assert.equal(host.calls.length, 1);
});

test('Plan command permissions reach real Node execution and recheck runtime after Host policy', async t => {
  const host = setup(t, ['run_command']); mkdirSync(join(host.workspaceRoot, 'sub'));
  const store = new SqliteRunStore(join(host.workspaceRoot, '..', 'plan-command.sqlite')); t.after(() => store.close());
  const schemas = [...host.registry.values()];
  assert.equal(host.gateway.definitions(host.agent, schemas)[0].planModeCommandPolicy, undefined);
  const tools = host.gateway.definitions(host.agent, schemas, { planModeCommandPolicy: 'zcode-posix-readonly/v1' });
  assert.equal(tools[0].readOnly, false); assert.equal(tools[0].concurrentSafe, false);
  const execute = host.ctx.tools.execute;
  host.ctx.tools.execute = async request => {
    if (request.arguments.command === 'git status --short') writeFileSync(join(host.workspaceRoot, 'HEAD'), 'ref: refs/heads/main\n');
    if (request.arguments.command === 'printf host-denied') return { isError: true, content: [{ type: 'text', text: 'Host policy denied command' }] };
    return execute(request);
  };
  const data = fixture({ planModePolicy: 'session-plan/v1', planModeInitialActive: true,
    tools: [...tools, ...planModeToolDefinitions()], limits: { effectTimeoutMs: 1000000 } });
  const ports = host.gateway.forAgent(host.agent, { scope, store });
  const authority = createNativeToolAuthority({ scope, sessionId: 'session', store });
  const check = ports.tools.checkPlanMode; let models = 0, checks = 0;
  ports.tools.checkPlanMode = async request => {
    checks++; assert.equal(authority(request), true);
    const missing = { ...request }; delete missing.planMode; assert.equal(authority(missing), false);
    assert.equal(authority({ ...request, planMode: 'other' }), false);
    return check(request);
  };
  const kernel = new NativeKernel({ store, digest, owner: 'actual-plan-command', ports: { ...ports, model: {
    generate: async request => {
      if (++models === 1) return { kind: 'tool_calls', text: '', usage: emptyUsage(), toolCalls: [
        { command: 'printf planning-observed' }, { command: 'printf forbidden > forbidden.txt' },
        { command: 'git status --short' }, { command: 'printf host-denied' }, { command: 'pwd', env: { KSADK_COMMAND_CWD: 'sub' } },
      ].map((arguments_, index) => ({ callId: `plan-command-${index}`, name: 'run_command', arguments: arguments_ })) };
      const results = request.messages.filter(message => message.role === 'tool');
      assert.equal(results.filter(message => message.content.includes('plan_mode_write_denied')).length, 2);
      assert.ok(results.some(message => message.content.includes('planning-observed')));
      assert.ok(results.some(message => message.content.includes('/sub')));
      assert.ok(results.some(message => message.content.includes('Host policy denied command')));
      return { kind: 'final_candidate', text: 'Done', usage: emptyUsage(), toolCalls: [] };
    } } } });
  kernel.start(data.snapshot, data.config); const done = await kernel.runUntilIdle(scope, 'run');
  assert.equal(done.phase, 'completed'); assert.equal(done.planMode.active, true); assert.equal(checks, 5);
  assert.equal(existsSync(join(host.workspaceRoot, 'forbidden.txt')), false);
  assert.equal(host.calls.length, 3, 'Only admitted calls reach the actual command adapter');
});

test('Native owns revision-bound MCP receipts while post-policy output controls the model view', async t => {
  const invoked = [], reply = { content: [{ type: 'text', text: 'known answer' }], structuredContent: { count: 7 }, isError: false };
  const host = setup(t, ['lookup'], [{ name: 'lookup', executor: 'mcp', mcpResourceId: 'catalog' }], {
    executeMcpTool: async input => { invoked.push(input); return reply; },
  });
  const port = host.gateway.forAgent(host.agent).tools;
  const output = await port.execute(host.request({}, 'lookup'));
  assert.equal(output.status, 'ok'); assert.deepEqual(output.content, reply);
  assert.match(output.context.content, /"structuredContent":\{"count":7\}/);
  assert.equal(invoked[0].resultFormat, 'mcp-result/v1'); assert.equal(invoked[0].resourceId, 'catalog');
  const execute = host.ctx.tools.execute;
  host.ctx.tools.execute = async input => ({ ...await execute(input), content: [{ type: 'text', text: 'Host redacted result' }] });
  const redacted = await port.execute(host.request({}, 'lookup'));
  assert.equal(redacted.context.content, 'Host redacted result'); assert.deepEqual(redacted.content, reply);
  host.deny(); const denied = await port.execute(host.request({}, 'lookup'));
  assert.equal(denied.status, 'error'); assert.equal(invoked.length, 2);
});
test('a known MCP error is an error receipt while a transport failure requires reconciliation', async t => {
  let failed = false;
  const host = setup(t, ['lookup'], [{ name: 'lookup', executor: 'mcp', resourceId: 'catalog' }], {
    executeMcpTool: async () => {
      if (failed) throw new Error('transport lost');
      return { content: [{ type: 'text', text: 'remote refused' }], isError: true };
    },
  });
  const execute = host.ctx.tools.execute;
  host.ctx.tools.execute = async input => {
    try { return await execute(input); } catch { return { isError: true, content: [{ type: 'text', text: 'transport lost' }] }; }
  };
  const port = host.gateway.forAgent(host.agent).tools;
  assert.equal((await port.execute(host.request({}, 'lookup'))).status, 'error');
  failed = true;
  assert.equal((await port.execute(host.request({}, 'lookup'))).status, 'uncertain');
});
test('MCP images enter the attachment policy while its public omission cannot expose raw receipt media', async t => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=';
  const host = setup(t, ['lookup'], [{ name: 'lookup', executor: 'mcp', resourceId: 'catalog' }], {
    executeMcpTool: async () => ({ content: [{ type: 'image', data: png, mimeType: 'image/png' }], structuredContent: { screenshot: png } }),
  });
  let saves = 0;
  const ref = { attachmentId: 'fixture', mediaType: 'image/png', width: 1, height: 1, bytes: Buffer.from(png, 'base64').length };
  host.ctx.get = name => name === 'attachments' ? {
    imageLimits: { mediaTypes: ['image/png'], maxImageBytes: 1024, maxMessageImageBytes: 1024, maxImagesPerMessage: 1 },
    saveImages: async images => { saves++; assert.equal(images[0].data.toString('base64'), png); return [ref]; },
  } : undefined;
  const execute = host.ctx.tools.execute;
  host.ctx.tools.execute = async input => {
    const result = await execute(input);
    assert.equal(result.content.some(block => block.type === 'image'), true);
    return { ...result, content: [{ type: 'text', text: 'Host omitted MCP image' }] };
  };
  const output = await host.gateway.forAgent(host.agent).tools.execute(host.request({}, 'lookup'));
  assert.equal(output.status, 'ok'); assert.equal(saves, 1);
  assert.equal(output.context.content, 'Host omitted MCP image'); assert.equal(output.context.media, undefined);
  assert.equal(output.content.content[0].data, png);
});
test('a bound MCP name cannot acquire a same-named workspace builtin schema or safe-read authority', async t => {
  const parameters = { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] };
  let calls = 0;
  const host = setup(t, ['read_workspace_file'], [{ name: 'read_workspace_file', executor: 'mcp', resourceId: 'catalog', parameters }], {
    executeMcpTool: async () => { calls++; return { content: [{ type: 'text', text: 'external result' }] }; },
  });
  const definition = host.gateway.definitions(host.agent, [...host.registry.values()])[0];
  assert.deepEqual(definition.parameters, parameters); assert.equal(definition.readOnly, false);
  assert.equal(definition.observationRole, 'none');
  host.postFailure();
  const result = await host.gateway.forAgent(host.agent).tools.execute(host.request({ query: 'hello' }));
  assert.equal(calls, 1); assert.equal(result.status, 'uncertain');
});

test('an unsupported exact integer is rejected before the DSH pipeline can execute an effect', async t => {
  const host = setup(t), port = host.gateway.forAgent(host.agent).tools;
  for (const numeric of [9007199254740993n, -0, 1000000000000000100.0]) {
    const result = await port.execute(host.request({ path: 'integer.txt', content: 'unsafe', numeric }));
    assert.equal(result.status, 'error'); assert.equal(result.content.code, 'STUDIO_NATIVE_EXACT_NUMBER_UNSUPPORTED');
    assert.equal(result.content.executed, false); assert.equal(host.calls.length, 0);
  }
  assert.equal(existsSync(join(host.workspaceRoot, 'integer.txt')), false);
});
test('negotiated numeric arguments cross the external tool boundary without rounding or wrapper authority', async t => {
  const name = 'mcp__fixture__echo', host = setup(t, [name], [{ name, executor: 'mcp' }],
    { argumentEncodings: ['dsh.raw-json-number/v1'] });
  let effects = 0;
  host.registry.set(name, { name, parameters: { type: 'object' }, execute: async args => { effects++; return JSON.stringify(args); },
    output: { render: (_args, value) => [{ type: 'text', text: value }] } });
  const input = { id: 9007199254740993n, zero: -0, float: 1000000000000000100.0, ordinary: 7, record: { rawJSON: '9007199254740993' } };
  const result = await host.gateway.forAgent(host.agent).tools.execute(host.request(input, name));
  assert.equal(host.gateway.argumentEncoding, 'dsh.raw-json-number/v1');
  assert.equal(host.calls[0].argumentEncoding, 'dsh.raw-json-number/v1');
  assert.equal(JSON.isRawJSON(host.calls[0].arguments.id), true);
  assert.equal(JSON.isRawJSON(host.calls[0].arguments.record), false);
  assert.equal(host.calls[0].arguments.ordinary, 7);
  assert.equal(result.status, 'ok');
  assert.equal(result.content[0].text, '{"id":9007199254740993,"zero":-0.0,"float":1.0000000000000001e+18,"ordinary":7,"record":{"rawJSON":"9007199254740993"}}');
  host.deny();
  assert.equal((await host.gateway.forAgent(host.agent).tools.execute(host.request(input, name))).status, 'uncertain');
  assert.equal(effects, 1);
});
test('owned builtins compare the decoded negotiated arguments against the original Native authority', async t => {
  const host = setup(t, ['write_workspace_file'], [], { argumentEncodings: ['dsh.raw-json-number/v1'] });
  const result = await host.gateway.forAgent(host.agent).tools.execute(host.request({ path: 'exact.txt', content: 'written', id: 9007199254740993n }));
  assert.equal(result.status, 'ok');
  assert.equal(readFileSync(join(host.workspaceRoot, 'exact.txt'), 'utf8'), 'written');
});
test('workspace browser metadata is pinned and DSH denial cannot start its backend', async t => {
  let created = 0;
  const host = setup(t, ['browser_inspect_workspace'], [], { createBrowser: () => { created++; throw new Error('must not start'); } });
  const request = host.request({ path: 'app', wait_ms: 0 });
  assert.equal(request.definition.observationRole, 'browser');
  assert.equal(request.definition.readOnly, false);
  assert.equal(request.definition.timeoutMs, 110000);
  assert.equal(typeof host.gateway.forAgent(host.agent).browser.recoverSessions, 'function');
  const registered = host.registry.get('browser_inspect_workspace');
  await assert.rejects(registered.execute(request.call.arguments, { agent: host.agent,
    callId: 'invented', signal: request.signal }), /studio_native_tool_authority_missing/);
  host.deny();
  const result = await host.gateway.forAgent(host.agent).tools.execute(request);
  assert.equal(result.status, 'error'); assert.equal(result.browserSessionRef, undefined);
  assert.equal(created, 0);
});
test('an MCP tool with the browser name receives no owned browser role or recovery authority', t => {
  const host = setup(t, ['browser_inspect_workspace'], [{ name: 'browser_inspect_workspace', executor: 'mcp' }]);
  assert.equal(host.registry.has('browser_inspect_workspace'), false);
  const [definition] = host.gateway.definitions(host.agent, [{ name: 'browser_inspect_workspace', parameters: { type: 'object' } }]);
  assert.equal(definition.observationRole, 'none');
  assert.equal(host.gateway.forAgent(host.agent).browser, undefined);
});
test('a registry disposal failure still closes all browser resources', async t => {
  const host = setup(t, ['browser_inspect_workspace']); let disposed = 0;
  host.ctx.tools.register = () => () => { throw new Error('registry disposal failed'); };
  const gateway = createNativeDshTools({ ctx: host.ctx, config: { toolBindings: ['browser_inspect_workspace'] },
    workspaceRoot: host.workspaceRoot, stateDir: join(host.workspaceRoot, '..', 'state-disposal'), createBrowser: () => ({
      open() {}, act() {}, recover() {}, restart() {}, close() {}, async dispose() { disposed++; },
    }) });
  await gateway.forAgent(host.agent).browser.recoverSessions({ ...host.request({ path: 'app' }), refs: [] });
  const closing = gateway.close();
  assert.equal(gateway.close(), closing);
  await assert.rejects(closing, /registry disposal failed/);
  assert.equal(disposed, 1);
});
test('Native builtin effects require ledger authority and pass through the registry before real writes', async t => {
  const host = setup(t), registered = host.registry.get('write_workspace_file');
  await assert.rejects(registered.execute({ path: 'escape.txt', content: 'not authorized' },
    { agent: host.agent, callId: 'invented', signal: new AbortController().signal }), /studio_native_tool_authority_missing/);
  assert.equal(existsSync(join(host.workspaceRoot, 'escape.txt')), false);
  const result = await host.gateway.forAgent(host.agent).tools.execute(host.request());
  assert.equal(result.status, 'ok'); assert.deepEqual(result.workspaceChangedPaths, ['file.txt']);
  assert.equal(result.content.ok, true); assert.equal(result.content.path, 'file.txt');
  assert.equal(result.content.size, 5);
  assert.equal(readFileSync(join(host.workspaceRoot, 'file.txt'), 'utf8'), 'value');
  assert.match(host.calls[0].callId, /^ak-native-/);
});
test('registry denial prevents a Node write and post-write failure becomes uncertain', async t => {
  const denied = setup(t); denied.deny();
  assert.equal((await denied.gateway.forAgent(denied.agent).tools.execute(denied.request())).status, 'error');
  assert.equal(existsSync(join(denied.workspaceRoot, 'file.txt')), false);
  const failed = setup(t); failed.postFailure();
  const result = await failed.gateway.forAgent(failed.agent).tools.execute(failed.request());
  assert.equal(result.status, 'uncertain'); assert.deepEqual(result.workspaceChangedPaths, ['file.txt']);
  assert.equal(readFileSync(join(failed.workspaceRoot, 'file.txt'), 'utf8'), 'value');
});
test('one admitted registry invocation cannot execute the same Native builtin body twice', async t => {
  const host = setup(t), registered = host.registry.get('write_workspace_file');
  host.ctx.tools.execute = async input => {
    const value = await registered.execute(input.arguments, input);
    await assert.rejects(registered.execute(input.arguments, input), /studio_native_tool_already_dispatched/);
    return { isError: false, value, content: registered.output.render(input.arguments, value) };
  };
  const result = await host.gateway.forAgent(host.agent).tools.execute(host.request());
  assert.equal(result.status, 'ok');
  assert.equal(readFileSync(join(host.workspaceRoot, 'file.txt'), 'utf8'), 'value');
});
test('session identity and run identity constrain Native registry calls', async t => {
  const host = setup(t), port = host.gateway.forAgent(host.agent).tools;
  await assert.rejects(port.execute({ ...host.request(), sessionId: 'other' }), /studio_native_tool_not_bound/);
  assert.equal(host.calls.length, 0);
  await port.execute(host.request());
  await port.execute({ ...host.request({ path: 'second.txt', content: 'two' }), runId: 'second-run' });
  assert.notEqual(host.calls[0].callId, host.calls[1].callId);
});
test('unimplemented Node builtins fail explicitly without invoking a Python bridge', async t => {
  const host = setup(t, ['not_yet_ported'], [{ name: 'not_yet_ported', executor: 'builtin', parameters: { type: 'object' } }]);
  const result = await host.gateway.forAgent(host.agent).tools.execute(host.request({}, 'not_yet_ported'));
  assert.equal(result.status, 'error'); assert.match(JSON.stringify(result.content), /STUDIO_NATIVE_BUILTIN_UNAVAILABLE/);
});
test('catalog resource identities resolve to tool names and disabled contracts cannot regain builtin authority', async t => {
  const host = setup(t, ['catalog-file-write', 'workspace_status'], [
    { name: 'write_workspace_file', resourceId: 'catalog-file-write', executor: 'builtin', parameters: { type: 'object' } },
    { name: 'workspace_status', resourceId: 'workspace_status', executor: 'builtin', enabled: false, parameters: { type: 'object' } },
  ]);
  assert.deepEqual([...host.registry.keys()], ['write_workspace_file', 'native_repair_workspace_operation']);
  assert.deepEqual(host.gateway.definitions(host.agent, [...host.registry.values()]).map(tool => tool.name), ['write_workspace_file'],
    'operator-only compensation must not appear in the model catalog');
  await assert.rejects(host.registry.get('native_repair_workspace_operation').execute({ original_operation_key: 'invented' },
    { agent: host.agent, name: 'native_repair_workspace_operation', callId: 'invented', signal: new AbortController().signal }), /repair_authority_missing/);
  assert.equal((await host.gateway.forAgent(host.agent).tools.execute(host.request({ path: 'file.txt', content: 'bound' }, 'write_workspace_file'))).status, 'ok');
  await assert.rejects(host.gateway.forAgent(host.agent).tools.execute(host.request({}, 'workspace_status')), /studio_native_tool_not_bound/);
});
test('MCP names are not replaced by workspace builtins; external failure requires reconciliation', async t => {
  const host = setup(t, ['workspace_status'], [{ name: 'workspace_status', executor: 'mcp', parameters: { type: 'object' } }]);
  assert.equal(host.registry.has('workspace_status'), false);
  host.registry.set('workspace_status', { name: 'workspace_status', parameters: { type: 'object' } });
  host.ctx.tools.execute = async () => ({ isError: true, content: [{ type: 'text', text: 'Acknowledgment lost' }] });
  assert.equal((await host.gateway.forAgent(host.agent).tools.execute(host.request({}, 'workspace_status'))).status, 'uncertain');
});
test('external tool additional contexts are retained in the Native receipt', async t => {
  const host = setup(t, ['external']);
  host.registry.set('external', { name: 'external', parameters: { type: 'object' } });
  const contexts = [{ role: 'user', source: { kind: 'tool' }, content: [{ type: 'text', text: 'Skill body' }] }];
  host.ctx.tools.execute = async () => ({ isError: false, content: [{ type: 'text', text: 'Loaded' }], additionalContexts: contexts });
  const result = await host.gateway.forAgent(host.agent).tools.execute(host.request({}, 'external'));
  assert.equal(result.status, 'ok'); assert.deepEqual(result.content.additionalContexts, contexts);
  assert.equal(result.context.content, 'Loaded');
  assert.equal(result.additionalContexts[0].content, 'Skill body');
  assert.deepEqual(result.context.presentation.content, [{ type: 'text', text: 'Loaded' }]);
  assert.deepEqual(result.additionalContexts[0].presentation.source, { kind: 'tool', callId: 'provider-id' });
});
test('Native model and display views use the authoritative post-policy receipt', async t => {
  const host = setup(t);
  host.ctx.tools.execute = async input => {
    await host.registry.get(input.name).execute(input.arguments, input);
    return { isError: false, content: [{ type: 'text', text: 'Policy-redacted result' }] };
  };
  const result = await host.gateway.forAgent(host.agent).tools.execute(host.request());
  assert.equal(result.context.content, 'Policy-redacted result');
  assert.equal(result.content.ok, true); assert.equal(result.content.path, 'file.txt');
  assert.equal(result.context.content.includes(host.workspaceRoot), false);
  assert.deepEqual(result.context.presentation.content, [{ type: 'text', text: 'Policy-redacted result' }]);
  assert.deepEqual(result.workspaceChangedPaths, ['file.txt']);
});

test('post-policy display cannot replace the canonical builtin error diagnostics', async t => {
  const host = setup(t);
  host.ctx.tools.execute = async input => {
    await host.registry.get(input.name).execute(input.arguments, input);
    return { isError: false, content: [{ type: 'text', text: 'Host display replaced' }],
      additionalContexts: [{ role: 'user', content: [{ type: 'text', text: 'Host follow-up' }] }] };
  };
  const result = await host.gateway.forAgent(host.agent).tools.execute(host.request({ path: '../outside', content: 'no write' }));
  assert.equal(result.status, 'error'); assert.equal(result.content.error_type, 'path_escape');
  assert.equal(result.context.content, 'Host display replaced');
  assert.equal(result.additionalContexts[0].content, 'Host follow-up');
  assert.equal(existsSync(join(host.workspaceRoot, '..', 'outside')), false);
});

test('Native ledger keeps the typed builtin receipt while the next model sees only post-policy context', async t => {
  const host = setup(t), request = host.request(), ports = host.gateway.forAgent(host.agent);
  host.ctx.tools.execute = async input => {
    await host.registry.get(input.name).execute(input.arguments, input);
    return { isError: false, content: [{ type: 'text', text: 'Policy-approved view' }] };
  };
  const { config, snapshot } = fixture({ tools: [request.definition] }), store = new MemoryRunStore();
  let models = 0;
  const kernel = new NativeKernel({ store, digest, owner: 'worker', ports: { ...ports, model: { generate: async input => {
    models++;
    if (models === 1) return { kind: 'tool_calls', text: '', usage: emptyUsage(), toolCalls: [request.call] };
    assert.equal(input.messages.find(message => message.role === 'tool').content, 'Policy-approved view');
    return { kind: 'final_candidate', text: 'Done', usage: emptyUsage(), toolCalls: [] };
  } } } });
  kernel.start(snapshot, config);
  const done = await kernel.runUntilIdle(scope, 'run');
  assert.equal(done.phase, 'completed'); assert.equal(done.outcome, 'unverified');
  const record = store.load(scope, 'run'), intent = record.intents.find(intent => intent.kind === 'tool');
  const receipt = record.receipts.find(receipt => receipt.operationKey === intent.operationKey);
  assert.equal(receipt.result.results[0].content.ok, true);
  assert.equal(receipt.result.results[0].content.path, 'file.txt');
  assert.equal(done.messages.find(message => message.role === 'tool').content, 'Policy-approved view');
});
test('tool image observations use Host-owned bytes and retain their structured display receipts', async t => {
  const host = setup(t, ['external']), ref = { attachmentId: 'owned-image', name: 'observation.png' };
  host.registry.set('external', { name: 'external', parameters: { type: 'object' } });
  const blocks = [{ type: 'text', text: 'Image observation' }, { type: 'image', attachment: ref }];
  let reads = 0;
  host.ctx.get = name => name === 'attachments' ? { readImageRequest: async receipt => {
    assert.deepEqual(receipt, ref); reads++; return { mediaType: 'image/png', data: new Uint8Array([1, 2, 3]) };
  } } : undefined;
  host.ctx.tools.execute = async () => ({ isError: false, content: blocks });
  const result = await host.gateway.forAgent(host.agent).tools.execute(host.request({}, 'external'));
  assert.equal(reads, 1); assert.equal(result.context.content, 'Image observation');
  assert.equal(result.context.media[0].image_url.url, 'data:image/png;base64,AQID');
  assert.deepEqual(result.context.presentation.content, blocks);
  assert.notEqual(result.context.presentation.content, blocks);
});

// Memory tools enter the production DSH pipeline through the trusted bindMemory
// entry. These tests isolate the gateway-level binding: registration, the
// memory:write standing-policy skip (a Memory write is not a workspace write),
// the real approval consent, and the child-scope leak rejection.
import { SqliteRunStore } from '../packages/agentkit-harness/src/native/sqlite-store.mjs';
import { SqliteNativeMemoryProvider } from '../packages/agentkit-harness/src/native/memory-store.mjs';
import { bindStudioNativeMemoryHost } from '../src/providers/native-memory-host.mjs';
import { bindNativeContext } from '../src/providers/native-context.mjs';
import { authorizeNativeBuiltin } from '../src/providers/native-tool-policy.mjs';

function memorySetup(t, { mode = 'workspace-write', approvalOutcome = 'allowed-once' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'studio-native-memory-gateway-'));
  const workspaceRoot = join(root, 'workspace'); mkdirSync(workspaceRoot);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const toolRegistry = new Map();
  const approvalService = { request: async () => approvalOutcome };
  const ctx = { effect: install => install(),
    sandboxPolicy: { resolve: () => ({ mode }) },
    approval: approvalService,
    tools: { register: tool => { toolRegistry.set(tool.name, tool); return () => toolRegistry.delete(tool.name); },
      execute: async input => { const registered = toolRegistry.get(input.name);
        const value = await registered.execute(input.arguments, input);
        return { isError: false, value, content: registered.output.render(input.arguments, value) }; } },
    get: id => id === 'approval' ? approvalService : id === 'sandboxPolicy' ? ctx.sandboxPolicy : undefined };
  const gateway = createNativeDshTools({ ctx, config: { toolBindings: [], toolContracts: [] },
    workspaceRoot, stateDir: join(root, 'state') });
  t.after(() => gateway.close());
  const record = { metadata: { id: scope.agentId, local: true, revision: 1 },
    spec: { runtime: { type: 'harness' }, memory: { enabled: true, providerRef: 'local-default', scopes: ['user'],
      write: { mode: 'candidate', flushAfterTurn: false }, recall: { enabled: true, maxTokens: 1600 } },
      context: { rollout: { memoryWrite: 'enabled' } } } };
  const store = new SqliteRunStore(join(root, 'runs.sqlite'));
  t.after(() => store.close());
  const context = bindNativeContext({ description: { protocol: 'openai-chat', modelName: 'pinned',
    parameters: {}, contextWindow: 16000, maxOutputTokens: 1024 }, context: record.spec.context });
  const memoryHost = bindStudioNativeMemoryHost({ record, scope, sessionId: 'session', store,
    storeDir: root, buildId: null, context, ctx });
  return { root, gateway, memoryHost, store, toolRegistry, ctx, record };
}

test('bindMemory registers the locked Memory tools into the DSH pipeline and definitions', t => {
  const h = memorySetup(t);
  assert.ok(h.memoryHost.port.definitions.some(d => d.name === 'manage_memory'));
  const dispose = h.gateway.bindMemory(h.memoryHost);
  t.after(dispose);
  const definitions = h.gateway.definitions(h.agent = { session: { id: 'session' } }, []);
  const names = definitions.map(d => d.name);
  assert.ok(names.includes('read_memory'));
  assert.ok(names.includes('search_memory'));
  assert.ok(names.includes('manage_memory'));
  // The locked formal definition (with executionPolicyDigest) is pinned, not a
  // borrowed assembly schema.
  const manage = definitions.find(d => d.name === 'manage_memory');
  assert.equal(manage.readOnly, false);
  assert.ok(/^sha256:[a-f0-9]{64}$/.test(manage.executionPolicyDigest));
});

test('a memory:write tool is not gated by the read-only workspace standing policy', async t => {
  // A memory:write builtin skips the workspace standing policy entirely. A
  // plain workspace write (permissions: []) under read-only must be denied by
  // the standing policy unless the real approval service grants an escalation.
  const h = memorySetup(t, { mode: 'read-only', approvalOutcome: 'rejected' });
  const dispose = h.gateway.bindMemory(h.memoryHost);
  t.after(dispose);
  const agent = { session: { id: 'session' } };
  const definitions = h.gateway.definitions(agent, []);
  const manage = definitions.find(d => d.name === 'manage_memory');
  // memory:write builtin: the standing policy does not gate it, so it passes
  // authorizeNativeBuiltin regardless of the read-only workspace mode.
  await assert.doesNotReject(authorizeNativeBuiltin(h.ctx,
    { signal: new AbortController().signal, agent, name: 'manage_memory' }, manage));
  // A plain workspace write (permissions: []) IS gated by read-only: with a
  // denied approval it is rejected, proving the memory skip is memory-only.
  const workspaceWrite = { name: 'write_workspace_file', readOnly: false, permissions: [] };
  await assert.rejects(authorizeNativeBuiltin(h.ctx,
    { signal: new AbortController().signal, agent, name: 'write_workspace_file' }, workspaceWrite),
    { code: 'STUDIO_NATIVE_PERMISSION_DENIED' });
});

test('Memory tools never leak to a child tool binding', t => {
  const h = memorySetup(t);
  const dispose = h.gateway.bindMemory(h.memoryHost);
  t.after(dispose);
  const childScope = { ...scope, agentId: 'child' };
  // read_memory is readOnly, but it is a Memory tool and must not bind to a child.
  assert.throws(() => h.gateway.forChild({ session: { id: 'session' } },
    { scope: childScope, store: new MemoryRunStore(), sessionId: 'child-session', toolNames: ['read_memory'] }),
    /child_tools_not_bound/);
});

test('rebinding a Memory owner disposes only the prior owner registrations', t => {
  // bindMemory scopes each disposer to the names IT registered. A prior owner's
  // dispose must not delete a newer owner's Memory tools, and rebinding must
  // not throw 'studio_native_memory_tool_collision' because the prior names are freed.
  const h = memorySetup(t);
  const first = h.gateway.bindMemory(h.memoryHost);
  const agent = { session: { id: 'session' } };
  assert.ok(h.gateway.definitions(agent, []).some(d => d.name === 'manage_memory'));
  // A second owner (same tool names) binds after the first is disposed.
  first();
  const context2 = bindNativeContext({ description: { protocol: 'openai-chat', modelName: 'pinned',
    parameters: {}, contextWindow: 16000, maxOutputTokens: 1024 }, context: h.record.spec.context });
  const memoryHost2 = bindStudioNativeMemoryHost({ record: h.record, scope, sessionId: 'session',
    store: h.store, storeDir: h.root, buildId: null, context: context2, ctx: h.ctx });
  const second = h.gateway.bindMemory(memoryHost2);
  t.after(second);
  assert.ok(h.gateway.definitions(agent, []).some(d => d.name === 'manage_memory'));
  // Disposing the FIRST owner again (already disposed) must not remove the
  // second owner's tools: each disposer owns only its registrations.
  first();
  assert.ok(h.gateway.definitions(agent, []).some(d => d.name === 'manage_memory'),
    'first owner dispose did not remove the second owner tools');
});

test('gateway close disposes a bound Memory owner registration without leaking', async t => {
  const h = memorySetup(t);
  h.gateway.bindMemory(h.memoryHost);
  assert.ok(h.gateway.definitions({ session: { id: 'session' } }, []).some(d => d.name === 'read_memory'));
  await h.gateway.close();
  // After close the Memory registration is gone; a fresh gateway can bind again.
  const toolRegistry2 = new Map();
  const ctx2 = { effect: install => install(), sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }) },
    approval: { request: async () => 'allowed-once' }, tools: { register: tool => { toolRegistry2.set(tool.name, tool); return () => toolRegistry2.delete(tool.name); },
      execute: async input => { const r = toolRegistry2.get(input.name); return { isError: false, value: await r.execute(input.arguments, input), content: r.output.render(input.arguments, undefined) }; } },
    get: id => id === 'approval' ? ctx2.approval : undefined };
  const gateway2 = createNativeDshTools({ ctx: ctx2, config: { toolBindings: [], toolContracts: [] },
    workspaceRoot: join(h.root, 'workspace'), stateDir: join(h.root, 'state2') });
  const memoryHost2 = bindStudioNativeMemoryHost({ record: h.record, scope, sessionId: 'session', store: h.store,
    storeDir: h.root, buildId: null, context: bindNativeContext({ description: { protocol: 'openai-chat',
      modelName: 'pinned', parameters: {}, contextWindow: 16000, maxOutputTokens: 1024 }, context: h.record.spec.context }), ctx: ctx2 });
  gateway2.bindMemory(memoryHost2);
  assert.ok(gateway2.definitions({ session: { id: 'session' } }, []).some(d => d.name === 'read_memory'));
  await gateway2.close();
  memoryHost2.close();
});


for (const version of [1, 2, 3]) test(`directory v${version}: actual Node listing and DSH pipeline keep full canonical/authorized archive while bounding the model view`, async t => {
  const h = setup(t, ['list_workspace_files']), root = join(h.workspaceRoot, '..');
  mkdirSync(join(h.workspaceRoot, 'aaa')); mkdirSync(join(h.workspaceRoot, 'late'));
  for (let i = 0; i < 240; i++) writeFileSync(join(h.workspaceRoot, 'aaa', `file-${String(i).padStart(3, '0')}.txt`), String(i));
  const store = new SqliteRunStore(join(root, 'directory.sqlite')); t.after(() => store.close());
  const artifacts = await createNativeArtifactStore({ directory: join(root, 'result-artifacts'), scope });
  const directoryObservationPolicy = `studio-directory-observation/v${version}`;
  const tools = [...h.gateway.definitions(h.agent, [...h.registry.values()], { directoryObservationPolicy }), ...artifactToolDefinitions()];
  const { config, snapshot } = fixture({ artifactPolicy: 'runtime-artifacts/v1', tools, limits: { effectTimeoutMs: 200000, maxToolResultBytes: 8192 } });
  const ports = h.gateway.forAgent(h.agent, { scope, store }); let turns = 0, observed, firstPage;
  const kernel = new NativeKernel({ store, owner: 'directory-node', digest, ports: { ...ports, artifacts,
    model: { generate: async request => {
      if (++turns === 1) return { kind: 'tool_calls', text: '', toolCalls: [{ callId: 'directory', name: 'list_workspace_files',
        arguments: { path: '.', recursive: true, max_results: 5000, sort_by: version === 3 ? 'mtime' : 'name' } }], usage: emptyUsage() };
      if (turns === 2) {
        const wrapper = parseNativeJson(request.messages.at(-1).content); observed = wrapper;
        if (typeof wrapper.artifact_uri === 'string') return { kind: 'tool_calls', text: '', toolCalls: [{ callId: 'page', name: 'ArtifactRead',
          arguments: { uri: wrapper.artifact_uri, limit_chars: 64 } }], usage: emptyUsage() };
      } else firstPage = parseNativeJson(request.messages.at(-1).content);
      return { kind: 'final_candidate', text: 'Done', toolCalls: [], usage: emptyUsage() };
    } } } });
  kernel.start(snapshot, config); const end = await kernel.runUntilIdle(scope, 'run'), record = store.load(scope, 'run');
  assert.equal(end.phase, 'completed'); assert.equal(turns, 3); assert.equal(firstPage.returned_chars, 64);
  const view = parseNativeJson(observed.observed_content).content;
  assert.equal(view.returned_entries, 242); assert.ok(view.paths.length > 0 && view.paths.length <= 100);
  assert.equal(view.shown_entries + view.omitted_entries, 242);
  const original = record.receipts.find(receipt => receipt.result.results).result.results[0];
  assert.equal(original.content.entries.length, 242); assert.ok(original.archiveContext.content.length > 10000);
  if (version === 3) { assert.equal(view.listing_scope.path, '.'); assert.equal(view.listing_scope.recursive, true);
    assert.ok(view.paths.every(item => typeof item.mtime_ns === 'bigint')); }
  const ref = end.artifactRefs[0]; let offset = 0, full = '';
  do { const page = await artifacts.read({ ...h.request(), ref, offset, limit: 32000 }); full += page.content; offset = page.nextOffset; } while (offset !== null);
  const archived = parseNativeJson(parseNativeJson(full).content.model_content);
  assert.equal(archived.entries.length, 242); assert.deepEqual(archived.entries.map(entry => entry.path), original.content.entries.map(entry => entry.path));
  const progress = directoryProgressQuote(end); assert.deepEqual(new Set(progress.entries[0].child_directories), new Set(['aaa', 'late']));
  assert.equal(h.calls.length, 1, 'reserved artifact tools execute in Kernel, not the DSH tool loop');
});

test('directory post-policy redaction is respected by both full archives and receipt navigation', async t => {
  const h = setup(t, ['list_workspace_files']), root = join(h.workspaceRoot, '..');
  mkdirSync(join(h.workspaceRoot, 'private')); mkdirSync(join(h.workspaceRoot, 'public'));
  const execute = h.ctx.tools.execute;
  h.ctx.tools.execute = async input => {
    const result = await execute(input), raw = parseNativeJson(result.content[0].text);
    raw.entries = raw.entries.filter(entry => entry.path !== 'private');
    return { ...result, content: [{ type: 'text', text: canonical(raw) }] };
  };
  const store = new SqliteRunStore(join(root, 'directory.sqlite')); t.after(() => store.close());
  const artifacts = await createNativeArtifactStore({ directory: join(root, 'result-artifacts'), scope });
  const tools = [...h.gateway.definitions(h.agent, [...h.registry.values()], { directoryObservationPolicy: 'studio-directory-observation/v3' }), ...artifactToolDefinitions()];
  const { config, snapshot } = fixture({ artifactPolicy: 'runtime-artifacts/v1', tools, limits: { effectTimeoutMs: 200000 } }); let turns = 0;
  const kernel = new NativeKernel({ store, owner: 'post-policy', digest, ports: { ...h.gateway.forAgent(h.agent, { scope, store }), artifacts,
    model: { generate: async () => ++turns === 1 ? { kind: 'tool_calls', text: '', toolCalls: [{ callId: 'listing', name: 'list_workspace_files', arguments: { path: '.' } }], usage: emptyUsage() }
      : { kind: 'final_candidate', text: 'Done', toolCalls: [], usage: emptyUsage() } } } });
  kernel.start(snapshot, config); const end = await kernel.runUntilIdle(scope, 'run');
  assert.equal(end.phase, 'completed'); assert.deepEqual(directoryProgressQuote(end).entries[0].child_directories, ['public']);
  const page = await artifacts.read({ ...h.request(), ref: end.artifactRefs[0], offset: 0, limit: 32000 });
  assert.ok(!page.content.includes('private')); assert.ok(page.content.includes('public'));
  assert.ok(store.load(scope, 'run').receipts.find(receipt => receipt.result.results).result.results[0].content.entries.some(entry => entry.path === 'private'));
});

for (const governed of [false, true]) test(`real local command keeps full retained output through ${governed ? 'Kernel governance' : 'legacy archive fallback'}`, async t => {
  const h = setup(t, ['run_command']), store = new SqliteRunStore(join(h.workspaceRoot, '..', 'command-runs.sqlite'));
  t.after(() => store.close());
  const definitions = h.gateway.definitions(h.agent, [...h.registry.values()]);
  const { config, snapshot } = fixture({ tools: [...definitions, ...(governed ? artifactToolDefinitions() : [])],
    ...(governed ? { artifactPolicy: 'runtime-artifacts/v1' } : {}),
    limits: { maxModelCalls: 3, maxToolCalls: 3, maxToolResultBytes: 4096, effectTimeoutMs: 1000000 } });
  const artifacts = await h.gateway.artifactsFor(scope); let models = 0, archive, modelFailure;
  const kernel = new NativeKernel({ store, digest, owner: 'full-command', ports: { ...h.gateway.forAgent(h.agent, { scope, store }), artifacts,
    model: { generate: async request => {
      try {
      models++;
      if (models === 1) return { kind: 'tool_calls', text: '', usage: emptyUsage(), toolCalls: [{ callId: 'command', name: 'run_command',
        arguments: { command: `"${process.execPath}" -e "process.stdout.write('x'.repeat(40000)+'TAIL_完整😀')"` } }] };
      const saved = store.load(scope, snapshot.runId), result = saved.receipts.flatMap(row => row.result.results ?? [])[0];
      assert.equal(result.status, 'ok'); assert.equal(saved.snapshot.artifactRefs.length, 1);
      archive = { content: '' }; let offset = 0;
      for (;;) {
        const page = await artifacts.read({ ...h.request(), ref: saved.snapshot.artifactRefs[0], offset, limit: 32000 });
        archive.content += page.content;
        if (page.nextOffset === null) break;
        offset = page.nextOffset;
      }
      assert.match(archive.content, /TAIL_完整😀/);
      if (governed && models === 2) {
        assert.match(result.content.stdout, /TAIL_完整😀$/);
        assert.ok(Buffer.byteLength(result.context.content) <= 4096);
        assert.equal(result.content.output_budget, undefined);
        assert.ok(!JSON.stringify(request.messages).includes('x'.repeat(40000)));
        const tailOffset = [...archive.content.slice(0, archive.content.indexOf('TAIL_完整😀'))].length;
        return { kind: 'tool_calls', text: '', usage: emptyUsage(), toolCalls: [{ callId: 'read-archive', name: 'ArtifactRead',
          arguments: { uri: saved.snapshot.artifactRefs[0].uri, offset_chars: tailOffset, limit_chars: 30 } }] };
      }
      if (governed) assert.match(request.messages.filter(message => message.role === 'tool').at(-1).content, /TAIL_完整😀/);
      else { assert.ok(result.content.stdout.length < 40000); assert.ok(result.content.output_budget.artifact_uri); }
      return { kind: 'final_candidate', text: 'Retained output read.', toolCalls: [], usage: emptyUsage() };
      } catch (error) { modelFailure = error; throw error; }
    } } } });
  kernel.start(snapshot, config); const end = await kernel.runUntilIdle(scope, snapshot.runId);
  if (modelFailure) throw modelFailure;
  assert.equal(end.phase, 'completed'); assert.equal(h.calls.filter(call => call.name === 'run_command').length, 1);
  assert.equal(models, governed ? 3 : 2);
  const otherScope = { ...scope, userId: 'other-user' }, otherArtifacts = await h.gateway.artifactsFor(otherScope);
  await assert.rejects(otherArtifacts.read({ ...h.request(), scope: otherScope, ref: end.artifactRefs[0], offset: 0, limit: 10 }));
});
