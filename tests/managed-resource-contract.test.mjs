import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { stringify } from 'yaml';
import { parseManagedRuntimeManifest } from '../src/managed-runtime-manifest.mjs';
import { loadManagedRuntimeDefinition } from '../src/managed-runtime-definition.mjs';
import { prepareLocalResourceContext, writeBoundMemory } from '../src/local-runtime.mjs';
import { nativeLocalToolContract } from '../src/native-tool-catalog.mjs';
import { canonical } from '@kingsoftcloud/agentkit-harness-core';
import { managedResourceBindings } from '../src/managed-resource-contract.mjs';

const corpus = JSON.parse(await readFile(new URL('./fixtures/dsh-resources-v1.json', import.meta.url), 'utf8'));
const declaration = (profile, resources) => ({ name: 'resource-fixture', framework: profile,
  artifact_type: 'ManagedRuntime', runtime: { name: profile, version: 'fixture-1' }, model: 'fixture-model', prompt: '', resources });
const toolAdapter = { listTools: async ids => ids.map(nativeLocalToolContract) };

for (const key of ['knowledge_base', 'memory', 'skill_space', 'skill_spaces']) {
  test(`ID-only managed ${key} survives Native configuration freezing`, () => {
    const ref = { id: 'resource-fixture' };
    const bindings = managedResourceBindings({ [key]: key === 'skill_spaces' ? [ref] : ref });
    // Freeze the in-memory projection directly: JSON.stringify would silently
    // hide undefined fields and previously concealed this pre-model failure.
    assert.doesNotThrow(() => canonical({ runtime: { type: 'harness' }, bindings }));
    const resource = bindings.plugins[0].config.binding.resource;
    assert.equal(resource.id, ref.id);
    assert.equal(Object.hasOwn(resource, 'name'), false);
    assert.equal(Object.hasOwn(resource, 'region'), false);
  });
}

for (const profile of ['dsh-native', 'harness', 'codex']) {
  for (const sample of corpus.valid) test(`${profile} resource schema: ${sample.name}`, () => {
    const parsed = parseManagedRuntimeManifest(stringify(declaration(profile, sample.value)), { runtimeName: profile, runtimeVersion: 'fixture-1' });
    assert.deepEqual(parsed.resources, sample.value);
  });
  for (const sample of corpus.invalid) test(`${profile} rejects invalid resource: ${sample.name}`, () => {
    assert.throws(() => parseManagedRuntimeManifest(stringify(declaration(profile, sample.value)), { runtimeName: profile, runtimeVersion: 'fixture-1' }),
      error => error.code === 'MANAGED_RESOURCE_INVALID' && !error.message.includes('fixture-secret'));
  });
  test(`${profile} projects the declaration into existing platform plugins and MCP bindings`, async t => {
    const dir = await mkdtemp(join(tmpdir(), 'managed-resource-contract-')); t.after(() => rm(dir, { recursive: true, force: true }));
    const manifest = join(dir, 'agentengine.yaml');
    const resources = corpus.valid.find(sample => sample.name === 'combined').value;
    const raw = stringify(declaration(profile, resources)); await writeFile(manifest, raw);
    const runtime = await loadManagedRuntimeDefinition({ manifest, env: {
      AGENTENGINE_AGENT_ID: 'ar-fixture', AGENTENGINE_AGENT_VERSION_ID: 'v1',
      AGENTENGINE_MANAGED_RUNTIME_NAME: profile, AGENTENGINE_MANAGED_RUNTIME_VERSION: 'fixture-1',
      AGENTENGINE_MANIFEST_PROTOCOL: 'runtime-manifest/v1', AGENTENGINE_MANIFEST_SHA256: createHash('sha256').update(raw).digest('hex'),
      OPENAI_BASE_URL: 'https://model.example.test/v1', AGENTKIT_MODEL_API_KEY: 'fixture-key',
    } });
    const bindings = runtime.agent.spec.bindings;
    assert.doesNotThrow(() => canonical(runtime.agent.spec));
    assert.deepEqual(runtime.agent.spec.memory, { enabled: true, recall: { enabled: true }, write: { mode: 'candidate' } });
    assert.equal(bindings.modelProfileId, 'fixture-model');
    assert.deepEqual(bindings.plugins.map(plugin => plugin.config.binding.resource.kind), ['knowledge-base', 'memory-instance', 'skill-space']);
    assert.deepEqual(bindings.plugins.map(plugin => plugin.config.binding.resource.id), [resources.knowledge_base.id, resources.memory.id, resources.skill_space.id]);
    assert.equal(bindings.plugins[0].config.binding.resource.region, 'cn-beijing-6');
    assert.equal(bindings.plugins[1].config.binding.required, true);
    assert.deepEqual(bindings.mcpServers, [{ resourceId: 'mcp-first' }, { resourceId: 'mcp-second', region: 'cn-beijing-6' }]);
    assert.deepEqual(runtime.agent.bindings, bindings);
    assert.ok(!JSON.stringify(bindings).includes('synthetic-model-key'));
    // Exercise the existing consumer seam, not just the shape of new bindings.
    // Upstreams are controlled adapters; this is not cloud resource acceptance.
    const calls = [], userId = `aeu_${'a'.repeat(64)}`;
    const resourceAdapter = {
      loadSkill: async id => { calls.push(['skill', id]); return { name: id, content: 'CONTROLLED_SKILL_CONTENT' }; },
      searchKnowledge: async (id, query) => { calls.push(['knowledge', id, query]); return [{ content: 'CONTROLLED_KNOWLEDGE_FACT' }]; },
      searchMemory: async (id, query, subject, scope) => { calls.push(['recall', id, query, subject, scope]); return [{ content: 'CONTROLLED_MEMORY_FACT' }]; },
      writeMemory: async (id, subject, messages, scope) => { calls.push(['write', id, subject, messages, scope]); return { accepted: true }; },
      listMcpTools: async ref => { calls.push(['mcp', ref.resourceId]); return [{ name: ref.resourceId, inputSchema: { type: 'object', properties: {} } }]; },
    };
    const prepared = await prepareLocalResourceContext({ record: runtime.agent, resourceAdapter, toolAdapter, input: 'lookup', userId, agentId: 'ar-fixture' });
    assert.match(prepared.resourceContext, /CONTROLLED_KNOWLEDGE_FACT/);
    assert.match(prepared.resourceContext, /CONTROLLED_MEMORY_FACT/);
    assert.match(prepared.resourceContext, /CONTROLLED_SKILL_CONTENT/);
    assert.deepEqual(prepared.tools.filter(item => item._source !== 'dsh').map(item => item._resourceId.resourceId), ['mcp-first', 'mcp-second']);
    assert.deepEqual(prepared.tools.filter(item => item._source === 'dsh').map(item => item.name), (bindings.tools ?? []).map(ref => ref.resourceId));
    assert.deepEqual(calls.find(item => item[0] === 'recall'), ['recall', 'mem-fixture', 'lookup', userId, { agentId: 'ar-fixture' }]);
    await writeBoundMemory({ binding: prepared.memory, resourceAdapter, input: 'lookup', assistantText: 'result', userId, sessionId: 'session-fixture', agentId: 'ar-fixture' });
    assert.deepEqual(calls.find(item => item[0] === 'write').slice(0, 3), ['write', 'mem-fixture', userId]);
  });
  test(`${profile} materializes every Space from the multiple-Space YAML declaration`, async t => {
    const dir = await mkdtemp(join(tmpdir(), 'managed-multiple-spaces-')); t.after(() => rm(dir, { recursive: true, force: true }));
    const manifest = join(dir, 'agentengine.yaml');
    const raw = stringify(declaration(profile, { skill_spaces: [{ id: 'space-first' }, { id: 'space-second', region: 'cn-beijing-6' }] }));
    await writeFile(manifest, raw);
    const runtime = await loadManagedRuntimeDefinition({ manifest, env: {
      AGENTENGINE_AGENT_ID: 'ar-multiple-spaces', AGENTENGINE_AGENT_VERSION_ID: 'v1',
      AGENTENGINE_MANAGED_RUNTIME_NAME: profile, AGENTENGINE_MANAGED_RUNTIME_VERSION: 'fixture-1',
      AGENTENGINE_MANIFEST_PROTOCOL: 'runtime-manifest/v1', AGENTENGINE_MANIFEST_SHA256: createHash('sha256').update(raw).digest('hex'),
      OPENAI_BASE_URL: 'https://model.example.test/v1', AGENTKIT_MODEL_API_KEY: 'fixture-key',
    } });
    const plugins = runtime.agent.spec.bindings.plugins;
    assert.doesNotThrow(() => canonical(runtime.agent.spec));
    assert.deepEqual(plugins.map(item => item.config.binding.resource.id), ['space-first', 'space-second']);
    assert.equal(new Set(plugins.map(item => item.config.binding.id)).size, 2);
    assert.equal(plugins[1].config.binding.resource.region, 'cn-beijing-6');
    const calls = [];
    const context = await prepareLocalResourceContext({ record: runtime.agent, resourceMode: 'context-only', toolAdapter,
      resourceAdapter: { loadSkill: async id => { calls.push(id); return { content: `EXCLUSIVE_${id}` }; } } });
    assert.deepEqual(calls, ['space-first', 'space-second']);
    assert.match(context.resourceContext, /EXCLUSIVE_space-first/);
    assert.match(context.resourceContext, /EXCLUSIVE_space-second/);
  });
}

test('service turns keep resource ownership without re-registering the Harness workspace or command tools', async () => {
  const { createCodexResourceContext } = await import('../src/providers/codex-resource-context.mjs');
  const record = { spec: { runtime: { type: 'harness' }, bindings: {
    tools: [{ resourceId: 'read_workspace_file' }, 'run_command', 'component_status'],
    skills: ['skill-fixture'],
    mcpServers: [{ resourceId: 'mcp-fixture' }],
    plugins: managedResourceBindings({ knowledge_base: { id: 'kb-fixture' }, memory: { id: 'mem-fixture' } }).plugins,
  } } };
  const calls = [];
  const context = createCodexResourceContext({ agentStore: { get: async () => record }, builds: {}, resources: {
    loadSkill: async id => ({ name: id, content: 'BOUND_SKILL' }),
    searchKnowledge: async () => [{ content: 'BOUND_KNOWLEDGE' }],
    searchMemory: async () => [{ content: 'BOUND_MEMORY' }],
    listMcpTools: async ref => { assert.equal(ref.resourceId, 'mcp-fixture'); return [{ name: 'read_workspace_file' }]; },
    callMcpTool: async (ref, tool) => { calls.push([ref.resourceId, tool]); return { ok: true }; },
  } });
  const prepared = await context({ agentId: 'test', input: 'Read the approved resource.', userId: 'owner', runtime: 'native-engine',
    toolAdapter: { listTools: async ids => {
      assert.deepEqual(ids, ['component_status']);
      return [{ name: 'component_status' }];
    } } });
  assert.deepEqual(prepared.dynamicTools.map(tool => tool.name), ['read_workspace_file', 'component_status']);
  assert.match(prepared.systemPrompt, /BOUND_SKILL/);
  assert.match(prepared.systemPrompt, /BOUND_KNOWLEDGE/);
  assert.match(prepared.systemPrompt, /BOUND_MEMORY/);
  await prepared.toolHandler({ name: 'read_workspace_file' });
  assert.deepEqual(calls, [['mcp-fixture', 'read_workspace_file']]);
  assert.equal(record.spec.bindings.tools.length, 3);
});
