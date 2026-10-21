import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExpertCatalog, exportTemplateDefinition } from '../packages/expert-catalog/src/catalog.mjs';
import { seed } from '../packages/expert-catalog/src/seed.mjs';
import { createTemplateAuthoring } from '../src/template-authoring.mjs';
import { createAgentStore } from '../src/agent-store.mjs';
import { createStudioBuild } from '../src/studio-build.mjs';
import { listPlatformResources, platformBinding } from '../src/platform-resource-bindings.mjs';

const platformCatalog = kind => ({ connectionRef: 'reader-connection', pluginRef: 'platform-plugin', componentId: kind, pluginSnapshotDigest: 'snapshot-v1', items: [{ id: `reader-${kind}`, name: kind, region: 'test-region' }] });
const resources = async kind => ({ items: [{ id: `reader-${kind}`, resourceId: `reader-${kind}` }] });
function payload(catalog, id, runtimeType = 'dsh-native') {
  const draft = catalog.prepare(id);
  draft.spec.bindings.modelProfileId = 'reader-model';
  for (const req of draft.requirements) if (req.required && ['knowledge-base', 'memory-instance'].includes(req.kind)) draft.spec.bindings.plugins.push(platformBinding(req.kind, `reader-${req.kind}`, platformCatalog(req.kind)));
  return { ...draft, runtimeType };
}

test('all three runtimes use ordinary Agent revisions, editing and frozen Builds without losing bindings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'studio-templates-'));
  try {
    const store = createAgentStore({ storeDir: join(root, 'agents') }), catalog = createExpertCatalog(), build = createStudioBuild({ storeDir: root });
    const service = createTemplateAuthoring({ catalog, store, resources, platformResources: async kind => platformCatalog(kind) });
    for (const runtimeType of ['dsh-native', 'harness', 'codex']) for (const id of ['fullstack-engineer', 'knowledge-assistant', 'personal-writer']) {
      const input = payload(catalog, id, runtimeType), created = await service.create(input);
      assert.equal(created.spec.runtime.type, runtimeType);
      assert.deepEqual(created.metadata.templateSource, input.templateSource);
      const spec = { ...created.spec, instructions: { system: 'User edited role', task: 'User edited method' } };
      spec.memory.write.mode = 'candidate';
      const updated = await store.update(created.metadata.id, { name: 'My expert', spec, expectedRevision: 1 });
      assert.equal(updated.metadata.revision, 2);
      assert.equal((await store.getRevision(created.metadata.id, 1)).spec.instructions.system, input.spec.instructions.system);
      const artifact = await build.build({ agentId: updated.metadata.id, agentName: updated.metadata.name, revision: 2, spec: updated.spec, bindings: updated.spec.bindings, metadata: updated.metadata });
      const frozen = await build.resolve(updated.metadata.id, artifact.id);
      assert.equal(frozen.spec.instructions.task, 'User edited method');
      assert.equal(frozen.spec.memory.write.mode, 'candidate');
      assert.deepEqual(frozen.spec.bindings.plugins, updated.spec.bindings.plugins);
      assert.deepEqual(frozen.metadata.templateSource, created.metadata.templateSource);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('missing, stale or unsupported bindings and a changed template version never create an Agent', async () => {
  const catalog = createExpertCatalog(); let writes = 0;
  const service = createTemplateAuthoring({ catalog, store: { create: () => { writes++; } }, resources, platformResources: async kind => platformCatalog(kind) });
  const cases = [
    ['knowledge-assistant', draft => { draft.spec.bindings.plugins = []; }, 'TEMPLATE_BINDING_REQUIRED'],
    ['personal-writer', draft => { draft.spec.bindings.plugins[0].config.binding.resource.id = 'deleted'; }, 'PLATFORM_RESOURCE_UNAVAILABLE'],
    ['fullstack-engineer', draft => { draft.spec.bindings.modelProfileId = 'deleted'; }, 'TEMPLATE_RESOURCE_UNAVAILABLE'],
    ['fullstack-engineer', draft => { draft.spec.memory.enabled = true; }, 'TEMPLATE_MEMORY_REQUIRED'],
    ['personal-writer', draft => { draft.spec.memory.write.mode = 'unknown'; }, 'TEMPLATE_MEMORY_POLICY_INVALID'],
    ['fullstack-engineer', draft => { draft.templateSource.digest = 'tampered'; }, 'TEMPLATE_VERSION_UNAVAILABLE'],
    ['fullstack-engineer', draft => { draft.runtimeType = 'unknown'; }, 'TEMPLATE_RUNTIME_UNSUPPORTED'],
    ['fullstack-engineer', draft => { draft.spec.bindings.tools = [{ resourceId: 'reader-tool' }]; }, 'TEMPLATE_RESOURCE_UNSUPPORTED'],
  ];
  for (const [id, mutate, code] of cases) { const draft = payload(catalog, id); mutate(draft); await assert.rejects(() => service.create(draft), { code }); }
  assert.equal(writes, 0);
});

test('Server catalog identity survives ordinary Agent creation and cannot be supplied by the caller', async () => {
  const seedCatalog = createExpertCatalog(), catalog = { ...seedCatalog, prepare(ref) { const draft = seedCatalog.prepare(ref); draft.templateSource.catalogId = 'server-frozen-version'; return draft; } };
  let written;
  const service = createTemplateAuthoring({ catalog, store: { create: value => { written = value; return value; } }, resources, platformResources: async kind => platformCatalog(kind) });
  const draft = payload(catalog, 'fullstack-engineer'); draft.templateSource.catalogId = 'untrusted-caller-version';
  await service.create(draft);
  assert.equal(written.templateSource.catalogId, 'server-frozen-version');
});

test('export then instantiate replaces author resources while preserving instructions and memory policy', async () => {
  const catalog = createExpertCatalog();
  const author = payload(catalog, 'personal-writer');
  author.spec.bindings.plugins[0].config.binding.connectionRef = 'author-connection';
  author.spec.bindings.plugins[0].config.binding.resource.id = 'author-memory';
  const exported = exportTemplateDefinition({ metadata: { id: 'author-agent', name: 'Reusable writer' }, spec: author.spec });
  const source = structuredClone(seed); Object.assign(source.items.find(item => item.id === 'personal-writer'), exported);
  const imported = createExpertCatalog(source), service = createTemplateAuthoring({ catalog: imported, store: { create: value => value }, resources, platformResources: async kind => platformCatalog(kind) });
  const created = await service.create(payload(imported, 'personal-writer'));
  assert.equal(created.spec.instructions.system, author.spec.instructions.system);
  assert.equal(created.spec.memory.write.mode, 'explicit_only');
  assert.equal(created.spec.bindings.plugins[0].config.binding.connectionRef, 'reader-connection');
  assert.doesNotMatch(JSON.stringify(created), /author-connection|author-memory|author-agent/);
});

test('platform catalog uses paged Server data and exposes selectable metadata only', async () => {
  const pages = [];
  const result = await listPlatformResources({ listResource: async (kind, query) => { pages.push(query.Page); return { total: 2, items: [{ id: `kb-${query.Page}`, name: 'Knowledge', apiKey: 'private-key', raw: { token: 'private-token' } }] }; } }, 'knowledge-base');
  assert.deepEqual(pages, [1, 2]); assert.equal(result.items.length, 2);
  assert.doesNotMatch(JSON.stringify(result), /private-|apiKey|token/);
  assert.equal(platformBinding('knowledge-base', 'kb-1', result).config.retrieval.mode, 'tool');
  await assert.rejects(() => listPlatformResources({}, 'unsupported'), { code: 'INVALID_RESOURCE_KIND' });
});

test('a harness template seed supports local-default Native memory without a cloud binding and preserves write.mode off, recall independence, scopes and rollout', async () => {
  const catalog = createExpertCatalog();
  let created;
  const service = createTemplateAuthoring({ catalog, store: { create: value => { created = value; return value; } }, resources, platformResources: async kind => platformCatalog(kind) });
  const draft = payload(catalog, 'personal-writer', 'harness');
  // Drop the auto-bound memory-instance and switch to local-default memory.
  draft.spec.bindings.plugins = [];
  draft.spec.memory = { enabled: true, providerRef: 'local-default', scopes: [],
    recall: { enabled: false, maxTokens: 500, topK: 4, minScore: 0.3 }, write: { mode: 'off', flushBeforeCompaction: true, flushAfterTurn: false } };
  draft.spec.context = { rollout: { memoryWrite: 'enabled' } };
  const record = await service.create(draft);
  assert.equal(record.spec.memory.enabled, true);
  assert.equal(record.spec.memory.providerRef, 'local-default');
  assert.deepEqual(record.spec.memory.scopes, [], 'empty scopes preserved');
  assert.equal(record.spec.memory.write.mode, 'off');
  assert.equal(record.spec.memory.write.flushBeforeCompaction, true);
  assert.equal(record.spec.memory.write.flushAfterTurn, false);
  assert.equal(record.spec.memory.recall.enabled, false, 'recall.enabled independent of memory.enabled');
  assert.equal(record.spec.context.rollout.memoryWrite, 'enabled');
  assert.equal((record.spec.bindings.plugins || []).some(b => b?.config?.binding?.resource?.kind === 'memory-instance'), false, 'no cloud binding required');
  assert.equal(created.runtimeType, 'harness');
});

test('non-harness runtimes and cloud-bound harness seeds keep the original memory requirements', async () => {
  const catalog = createExpertCatalog();
  const service = createTemplateAuthoring({ catalog, store: { create: () => { throw new Error('should not create'); } }, resources, platformResources: async kind => platformCatalog(kind) });
  // dsh-native + local-default + enabled + no binding: the memory-instance
  // requirement is NOT waived (local stays harness-only), so creation is rejected.
  const dsh = payload(catalog, 'personal-writer', 'dsh-native');
  dsh.spec.bindings.plugins = [];
  dsh.spec.memory = { ...dsh.spec.memory, providerRef: 'local-default' };
  await assert.rejects(() => service.create(dsh), { code: 'TEMPLATE_BINDING_REQUIRED' });
  // harness + cloud binding still rejects write.mode 'off' (cloud path keeps candidate/explicit_only).
  const harnessCloud = payload(catalog, 'personal-writer', 'harness');
  harnessCloud.spec.memory.write.mode = 'off';
  await assert.rejects(() => service.create(harnessCloud), { code: 'TEMPLATE_MEMORY_POLICY_INVALID' });
});

test('disabled local-default memory with write.mode off is valid for a no-requirement harness seed and survives a real store roundtrip', async () => {
  const root = await mkdtemp(join(tmpdir(), 'studio-templates-disabled-'));
  try {
    const store = createAgentStore({ storeDir: join(root, 'agents') }), catalog = createExpertCatalog();
    const service = createTemplateAuthoring({ catalog, store, resources, platformResources: async kind => platformCatalog(kind) });
    // fullstack-engineer has no template requirements, so no memory-instance
    // binding is needed; a harness Agent may keep disabled local-default memory.
    const draft = payload(catalog, 'fullstack-engineer', 'harness');
    draft.spec.memory = { enabled: false, providerRef: 'local-default', scopes: [],
      recall: { enabled: false, maxTokens: 500, topK: 4, minScore: 0.3 }, write: { mode: 'off', flushBeforeCompaction: true, flushAfterTurn: false } };
    draft.spec.context = { rollout: { memoryWrite: 'enabled' } };
    const created = await service.create(draft);
    const assertPreserved = spec => {
      assert.equal(spec.memory.enabled, false);
      assert.equal(spec.memory.providerRef, 'local-default', 'disabled preserves the local provider');
      assert.deepEqual(spec.memory.scopes, [], 'empty scopes preserved');
      assert.equal(spec.memory.write.mode, 'off', 'write.mode off preserved while disabled');
      assert.equal(spec.memory.write.flushBeforeCompaction, true);
      assert.equal(spec.memory.write.flushAfterTurn, false);
      assert.equal(spec.memory.recall.enabled, false, 'recall.enabled independent of memory.enabled');
      assert.equal(spec.memory.recall.maxTokens, 500);
      assert.equal(spec.context.rollout.memoryWrite, 'enabled', 'rollout preserved');
    };
    assertPreserved(created.spec);
    // Reread from the real store, then save a new revision and reread again.
    const reread = await store.get(created.metadata.id);
    assertPreserved(reread.spec);
    const updated = await store.update(created.metadata.id, { name: 'Disabled local Agent', spec: reread.spec, expectedRevision: 1 });
    assert.equal(updated.metadata.revision, 2);
    const reread2 = await store.get(created.metadata.id);
    assertPreserved(reread2.spec);
    const revision1 = await store.getRevision(created.metadata.id, 1);
    assertPreserved(revision1.spec);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('disabled local memory does not bypass a required memory-instance binding, even with write.mode off', async () => {
  const root = await mkdtemp(join(tmpdir(), 'studio-templates-binding-'));
  try {
    const store = createAgentStore({ storeDir: join(root, 'agents') }), catalog = createExpertCatalog();
    const service = createTemplateAuthoring({ catalog, store, resources, platformResources: async kind => platformCatalog(kind) });
    // personal-writer requires memory-instance; disabled local memory must NOT
    // satisfy that requirement, regardless of write.mode.
    const draft = payload(catalog, 'personal-writer', 'harness');
    draft.spec.bindings.plugins = [];   // drop the auto-bound memory-instance
    draft.spec.memory = { enabled: false, providerRef: 'local-default', scopes: [],
      recall: { enabled: false }, write: { mode: 'off' } };
    await assert.rejects(() => service.create(draft), { code: 'TEMPLATE_BINDING_REQUIRED' });
    // A disabled memory with write.mode 'candidate' is also rejected for the
    // same reason: disabled local never waives the binding requirement.
    const candidate = payload(catalog, 'personal-writer', 'harness');
    candidate.spec.bindings.plugins = [];
    candidate.spec.memory = { enabled: false, providerRef: 'local-default', write: { mode: 'candidate' } };
    await assert.rejects(() => service.create(candidate), { code: 'TEMPLATE_BINDING_REQUIRED' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
