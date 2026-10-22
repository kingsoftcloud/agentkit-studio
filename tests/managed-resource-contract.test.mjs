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

const corpus = JSON.parse(await readFile(new URL('./fixtures/dsh-resources-v1.json', import.meta.url), 'utf8'));
const declaration = (profile, resources) => ({ name: 'resource-fixture', framework: profile,
  artifact_type: 'ManagedRuntime', runtime: { name: profile, version: 'fixture-1' }, model: 'fixture-model', prompt: '', resources });

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
    const prepared = await prepareLocalResourceContext({ record: runtime.agent, resourceAdapter, input: 'lookup', userId, agentId: 'ar-fixture' });
    assert.match(prepared.resourceContext, /CONTROLLED_KNOWLEDGE_FACT/);
    assert.match(prepared.resourceContext, /CONTROLLED_MEMORY_FACT/);
    assert.match(prepared.resourceContext, /CONTROLLED_SKILL_CONTENT/);
    assert.deepEqual(prepared.tools.map(item => item._resourceId.resourceId), ['mcp-first', 'mcp-second']);
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
    assert.deepEqual(plugins.map(item => item.config.binding.resource.id), ['space-first', 'space-second']);
    assert.equal(new Set(plugins.map(item => item.config.binding.id)).size, 2);
    assert.equal(plugins[1].config.binding.resource.region, 'cn-beijing-6');
    const calls = [];
    const context = await prepareLocalResourceContext({ record: runtime.agent, resourceMode: 'context-only',
      resourceAdapter: { loadSkill: async id => { calls.push(id); return { content: `EXCLUSIVE_${id}` }; } } });
    assert.deepEqual(calls, ['space-first', 'space-second']);
    assert.match(context.resourceContext, /EXCLUSIVE_space-first/);
    assert.match(context.resourceContext, /EXCLUSIVE_space-second/);
  });
}
