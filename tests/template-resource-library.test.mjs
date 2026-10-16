import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { seed } from '../packages/expert-catalog/src/seed.mjs';
import { createExpertCatalog } from '../packages/expert-catalog/src/catalog.mjs';
import { createCatalogDependencies } from '../src/catalog-dependencies.mjs';
import { createTemplateResourceLibrary } from '../src/template-resource-library.mjs';
import { createSkillDiscovery } from '../src/skill-discovery.mjs';
import { createLocalMcpStore } from '../src/local-mcp-store.mjs';
import { implicitSkillNames, mcpPreset } from '../scripts/workbuddy/complete-resources.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');

test('implicit Skill checks distinguish real requirements from email, npm scopes, decorators, tools and optional fallbacks', () => {
  assert.deepEqual(implicitSkillNames('Load the `ardot-design-assistant` skill.\n@ardot-design-assistant\nowner@example.com\n调用 `AskUserQuestion`\nimport "@modelcontextprotocol/sdk"\n@keyframes fade\n可联动 `optional-art` 技能\n```swift\n@State var value\n```'), ['ardot-design-assistant']);
  assert.deepEqual(implicitSkillNames('必须先调用 `missing-design` 技能'), ['missing-design']);
  assert.deepEqual(implicitSkillNames('@real-guide', new Set(['real-guide'])), ['real-guide']);
});

test('connector presets preserve public headers and exact argv but replace credential values with Host references', () => {
  const preset = mcpPreset('search', { url: 'https://service.test/mcp?token=DO_NOT_COPY', headers: { Authorization: 'Bearer DO_NOT_COPY', 'x-request-source': 'public-market', 'X-Tenant': '${user_config.TENANT}' } });
  assert.doesNotMatch(JSON.stringify(preset), /DO_NOT_COPY/);
  assert.equal(preset.server.endpointUrl, 'https://service.test/mcp');
  assert.equal(preset.server.headers['x-request-source'], 'public-market');
  assert.equal(preset.server.envRefs['X-Tenant'], 'env://TENANT');
  assert.equal(preset.setupReasons.length, 1);
  const stdio = mcpPreset('local', { command: 'node', args: ['path with spaces/server.js', '--format=json'], env: { MODE: 'public', API_KEY: '${LOCAL_API_KEY}' } });
  assert.deepEqual(stdio.server.args, ['path with spaces/server.js', '--format=json']);
  assert.deepEqual(stdio.server.env, { MODE: 'public' });
  assert.equal(stdio.server.envRefs.API_KEY, 'env://LOCAL_API_KEY');
});

test('resource library installs a root Skill with every file and resolves cross-package dependencies without creating Agents', async t => {
  const root = await mkdtemp(join(tmpdir(), 'studio-library-')); t.after(() => rm(root, { recursive: true, force: true }));
  const files = [];
  for (const [path, content] of [['SKILL.md', '---\nname: root-guide\ndescription: Complete guide\n---\nRead references/context.txt'], ['references/context.txt', 'COMPLETE_ROOT_SKILL_17']]) {
    await mkdir(join(root, 'source', path, '..'), { recursive: true }); await writeFile(join(root, 'source', path), content);
    files.push({ path, size: Buffer.byteLength(content), sha256: hash(content), executable: false });
  }
  const digest = hash(JSON.stringify(files)), bundle = { path: 'source', digest, files }, skill = { path: '.', name: 'root-guide', digest: hash('root-skill'), fileCount: 2 };
  const source = structuredClone(seed); source.packages = { [digest]: bundle };
  source.resources = [{ id: 'catalog-skill-test', kind: 'skill', name: 'root-guide', version: '1.0.0', fileCount: 2, dependencies: { package: { path: 'source', digest }, skills: [skill] } }];
  source.items[0].dependencies = { skills: [], mcp: [], additional: [source.resources[0].dependencies] };
  const catalog = createExpertCatalog(source, { assetRoot: root }), skills = createSkillDiscovery({ storeDir: join(root, 'skills') }), mcps = createLocalMcpStore({ storeDir: join(root, 'mcps') });
  const dependencies = createCatalogDependencies({ catalog, skillDiscovery: skills, mcpStore: mcps, packageStore: join(root, 'installed') });
  const library = createTemplateResourceLibrary({ catalog, dependencies, skills, mcps });
  const initial = (await library.list({ kind: 'skill' })).items[0]; assert.equal(initial.installed, false);
  const result = await library.install({ id: initial.id, digest: initial.digest });
  assert.equal(result.fileCount, 2); assert.equal((await library.list({ kind: 'skill' })).items[0].installed, true);
  const installed = result.items[0]; assert.equal(await readFile(join(await skills.resolveInstalled(installed.resourceId), 'references/context.txt'), 'utf8'), 'COMPLETE_ROOT_SKILL_17');
  assert.equal((await dependencies.materialize(catalog.get(source.items[0].id)))[0].resourceId, installed.resourceId);
  await assert.rejects(() => library.install({ id: initial.id, digest: 'stale' }), { code: 'TEMPLATE_RESOURCE_VERSION_UNAVAILABLE' });
});

test('stdio matching never treats a different command or argv as the required ready MCP', async t => {
  const root = await mkdtemp(join(tmpdir(), 'studio-mcp-match-')); t.after(() => rm(root, { recursive: true, force: true }));
  const server = { transport: 'stdio', command: 'node', args: ['wanted server.js'], name: 'local' }, mcps = createLocalMcpStore({ storeDir: root });
  const wrong = await mcps.create({ name: 'local', server: { ...server, args: ['different server.js'] } }); await mcps.markProbe(wrong.resourceId, { tools: [{ name: 'wrong' }] });
  const dependencies = createCatalogDependencies({ mcpStore: mcps });
  const item = { dependencies: { mcp: [{ key: 'local', server }] } };
  assert.equal((await dependencies.resolveMcp(item)).missing.length, 1);
  const right = await mcps.create({ name: 'local', server }); await mcps.markProbe(right.resourceId, { tools: [{ name: 'correct' }] });
  assert.deepEqual((await dependencies.resolveMcp(item)).ids, [right.resourceId]);
});
