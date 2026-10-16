import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { seed } from '../packages/expert-catalog/src/seed.mjs';
import { createExpertCatalog } from '../packages/expert-catalog/src/catalog.mjs';
import { createAgentStore } from '../src/agent-store.mjs';
import { createTemplateAuthoring } from '../src/template-authoring.mjs';
import { createTemplateSummon } from '../src/template-summon.mjs';
import { createCatalogDependencies } from '../src/catalog-dependencies.mjs';
import { createSkillDiscovery } from '../src/skill-discovery.mjs';
import { createLocalResourceAdapters } from '../src/local-resource-adapters.mjs';
import { createLocalMcpStore } from '../src/local-mcp-store.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');
async function fixture(t, { mcp = [], blocked = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'studio-summon-')); t.after(() => rm(root, { recursive: true, force: true }));
  const files = [];
  for (const [path, text, executable] of [['skills/guide/SKILL.md', '---\nname: guide\ndescription: Guide\n---\nRead references/nested/reference.txt and run scripts/check.sh.', false],
    ['skills/guide/scripts/check.sh', '#!/bin/sh\nprintf complete-assets', true], ['skills/guide/references/nested/reference.txt', 'FULL_REFERENCE_7319', false], ['shared/context.txt', 'SIBLING_ASSET_2547', false]]) {
    await mkdir(join(root, 'source', path, '..'), { recursive: true }); await writeFile(join(root, 'source', path), text, { mode: executable ? 0o700 : 0o600 });
    files.push({ path, size: Buffer.byteLength(text), sha256: hash(text), executable });
  }
  const source = structuredClone(seed), item = source.items[0];
  if (blocked) item.availability = { state: 'blocked', reasons: ['缺少必需 Skill：design-engine'] };
  item.dependencies = { package: { path: 'source', files, digest: hash(JSON.stringify(files)) }, skills: [{ path: 'skills/guide', name: 'guide', version: '1.0.0', digest: hash('guide'), fileCount: 3 }], mcp };
  item.requirements = [{ kind: 'skill', required: true, count: 1 }];
  const catalog = createExpertCatalog(source, { assetRoot: root }), store = createAgentStore({ storeDir: join(root, 'agents') });
  const skills = createSkillDiscovery({ storeDir: join(root, 'skills') }), mcps = createLocalMcpStore({ storeDir: join(root, 'mcp') });
  const dependencies = createCatalogDependencies({ catalog, packageStore: join(root, 'packages'), skillDiscovery: skills, mcpStore: mcps, probeMcp: id => mcps.markProbe(id, { tools: [{ name: 'read_public_data' }] }) });
  const resources = async kind => kind === 'model' ? { items: [{ resourceId: 'configured-model', name: 'Configured Model' }] } : kind === 'skill' ? skills.listInstalled() : { items: await mcps.list() };
  const platformResources = async kind => ({ items: [{ id: `my-${kind}`, name: kind }], connectionRef: 'server', pluginRef: 'platform', componentId: kind, pluginSnapshotDigest: 'v1' });
  const authoring = createTemplateAuthoring({ catalog, store, resources, platformResources, dependencies });
  const options = { catalog, authoring, store, dependencies, resources, platformResources, models: { profile: async () => ({ id: 'configured-model' }) }, operationDir: join(root, 'operations') };
  return { root, catalog, store, skills, dependencies, options, service: createTemplateSummon(options), ref: catalog.prepare(item.id).templateSource };
}
test('card summon creates one ordinary editable Agent with the configured model and every Skill asset, including sibling files', async t => {
  const f = await fixture(t), input = { ref: f.ref, requestId: randomUUID() };
  const [one, two] = await Promise.all([f.service.summon(input), f.service.summon(input)]);
  assert.equal(one.status, 'created'); assert.equal(one.agent.metadata.id, two.agent.metadata.id); assert.equal((await f.store.list()).length, 1);
  assert.equal(one.agent.spec.bindings.modelProfileId, 'configured-model');
  const adapter = createLocalResourceAdapters({ skillDiscovery: f.skills }), skill = await adapter.loadSkill(one.agent.spec.bindings.skills[0]);
  assert.equal(skill.definitions[0].name, 'guide');
  const directory = skill.definitions[0].resourceBase.path;
  assert.equal(await readFile(join(directory, 'references/nested/reference.txt'), 'utf8'), 'FULL_REFERENCE_7319');
  assert.equal(await readFile(join(directory, '../../shared/context.txt'), 'utf8'), 'SIBLING_ASSET_2547');
  assert.ok((await stat(join(directory, 'scripts/check.sh'))).mode & 0o100);
  const edited = await f.store.update(one.agent.metadata.id, { name: 'My editable expert', expectedRevision: 1, spec: { ...one.agent.spec, instructions: { system: 'User edited', task: '' } } });
  assert.equal(edited.metadata.revision, 2); assert.deepEqual(edited.metadata.templateSource, one.agent.metadata.templateSource);
  const restarted = createTemplateSummon(f.options), restored = await restarted.summon(input);
  assert.equal(restored.agent.metadata.id, one.agent.metadata.id); assert.equal(restored.reused, true);
  assert.equal((await f.store.list()).length, 1);
  const reopened = await restarted.summon({ ref: f.ref, requestId: randomUUID() });
  assert.equal(reopened.agent.metadata.id, one.agent.metadata.id); assert.equal(reopened.agent.metadata.name, 'My editable expert');
  assert.equal((await restarted.list()).items[0].instantiated.agentId, one.agent.metadata.id);
  await assert.rejects(() => restarted.summon({ ...input, task: 'different' }), { code: 'SUMMON_REQUEST_CONFLICT' });
});
test('required knowledge/memory are selected in place; validated live snapshots and explicit-only memory enter the same Agent spec', async t => {
  const f = await fixture(t), ref = f.catalog.prepare('personal-writer').templateSource;
  const missing = await f.service.summon({ ref, requestId: randomUUID() });
  assert.equal(missing.status, 'needs-input'); assert.equal(missing.plan.missing[0].kind, 'memory-instance'); assert.equal((await f.store.list()).length, 0);
  const result = await f.service.summon({ ref, requestId: randomUUID(), bindings: { 'knowledge-base': 'my-knowledge-base', 'memory-instance': 'my-memory-instance' } });
  const spec = result.agent.spec;
  assert.equal(spec.memory.enabled, true); assert.equal(spec.memory.write.mode, 'explicit_only'); assert.equal(spec.bindings.plugins.length, 2);
  assert.equal(spec.bindings.plugins[0].config.binding.connectionRef, 'server');
  assert.equal(spec.bindings.plugins[1].config.binding.resource.id, 'my-memory-instance');
  const stale = await f.service.summon({ ref, requestId: randomUUID(), bindings: { 'memory-instance': 'deleted' } });
  assert.equal(stale.status, 'needs-input'); assert.equal((await f.store.list()).length, 1);
});
test('dependency identity and file integrity reject forged or changed Skill bindings before creating an Agent', async t => {
  const f = await fixture(t), draft = f.catalog.prepare(f.ref);
  draft.spec.bindings.modelProfileId = 'configured-model'; draft.spec.bindings.skills = ['arbitrary-skill'];
  await assert.rejects(() => f.options.authoring.create(draft), { code: 'TEMPLATE_SKILL_DEPENDENCY_MISSING' });
  const installed = await f.skills.listInstalled(), dir = await f.skills.resolveInstalled(installed.items[0].resourceId);
  await writeFile(join(dir, 'SKILL.md'), 'modified');
  await assert.rejects(() => f.service.summon({ ref: f.ref, requestId: randomUUID() }), { code: 'TEMPLATE_PACKAGE_CHANGED' });
  assert.equal((await f.store.list()).length, 0);
});
test('unconfigured model never creates an Agent, even when gateway metadata lists models', async t => {
  const f = await fixture(t), service = createTemplateSummon({ ...f.options, models: { profile: async () => { throw new Error('no credential'); } } });
  const result = await service.summon({ ref: f.ref, requestId: randomUUID() });
  assert.equal(result.status, 'needs-input'); assert.ok(result.plan.missing.some(row => row.kind === 'model')); assert.equal((await f.store.list()).length, 0);
});
test('public MCP dependency is installed, probed and reused; authenticated dependencies require prior connection', async t => {
  const server = { name: 'public', transport: 'http', endpointUrl: 'https://example.invalid/mcp', version: '1.0.0' };
  const f = await fixture(t, { mcp: [{ key: 'public', name: 'Public MCP', autoInstall: true, server }] });
  const result = await f.service.summon({ ref: f.ref, requestId: randomUUID() });
  assert.equal(result.agent.spec.bindings.mcpServers.length, 1);
  const again = await f.service.summon({ ref: f.ref, requestId: randomUUID() });
  assert.deepEqual(again.agent.spec.bindings.mcpServers, result.agent.spec.bindings.mcpServers);
  const g = await fixture(t, { mcp: [{ key: 'private', name: 'Private MCP', autoInstall: false, server }] });
  const blocked = await g.service.summon({ ref: g.ref, requestId: randomUUID() });
  assert.equal(blocked.status, 'needs-input'); assert.equal(blocked.plan.missing[0].kind, 'mcp'); assert.equal((await g.store.list()).length, 0);
});
test('missing implicit dependencies reject both card summon and original create before writing an empty Agent', async t => {
  const f = await fixture(t, { blocked: true });
  await assert.rejects(() => f.service.summon({ ref: f.ref, requestId: randomUUID() }), { code: 'TEMPLATE_DEPENDENCIES_INCOMPLETE' });
  const draft = f.catalog.prepare(f.ref); draft.spec.bindings.modelProfileId = 'configured-model';
  await assert.rejects(() => f.options.authoring.create(draft), { code: 'TEMPLATE_DEPENDENCIES_INCOMPLETE' });
  assert.equal((await f.store.list()).length, 0);
});
