import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { connectorDraft, containedPath, convertExpert, markdownDefinition } from '../scripts/workbuddy/convert.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'studio-import-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.codebuddy-plugin'));
  await mkdir(join(root, 'agents'));
  return root;
}
test('conversion retains body verbatim and records malformed source headers', () => {
  const parsed = markdownDefinition('---\nname: analyst\ndescription: Works on: complex evidence\n---\n# Role\nKeep the original body.');
  assert.equal(parsed.system, '# Role\nKeep the original body.');
  assert.equal(parsed.metadata.name, 'analyst');
  assert.equal(parsed.parseWarning, 'invalid-frontmatter-preserved');
});
test('conversion maps the Agent body to existing spec, preserves dependencies without installing', async t => {
  const root = await fixture(t);
  await mkdir(join(root, 'skills', 'analysis'), { recursive: true });
  await writeFile(join(root, 'skills', 'analysis', 'SKILL.md'), '# Skill\nRequires input data.');
  await writeFile(join(root, 'agents', 'analyst.md'), '---\nname: analyst\nmaxTurns: 20\n---\nReview evidence.');
  await writeFile(join(root, '.codebuddy-plugin', 'plugin.json'), JSON.stringify({ name: 'analyst', version: '1.0.0', expertType: 'agent', agentName: 'analyst', agents: ['./agents/analyst.md'], skills: ['./skills/analysis'], quickPrompts: ['Compare these inputs', 'Summarize evidence'] }));
  const result = await convertExpert(root, { id: 'Analyst', categoryId: 'research', profession: { zh: '分析师' }, description: { zh: '分析资料' } }, { plugin: 'analyst', url: 'https://example.com/analyst.tar.gz', sha256: 'locked' });
  assert.equal(result.candidate.spec.instructions.system, 'Review evidence.');
  assert.deepEqual(result.candidate.spec.bindings.skills, []);
  assert.equal(result.candidate.requirements[0].count, 1);
  assert.equal(result.skills[0].installed, false);
  assert.equal(result.candidate.origin.sourceSha256, 'locked');
  assert.equal(result.candidate.spec.memory.enabled, false);
  assert.ok(result.warnings.includes('package-license-unconfirmed'));
  assert.equal(result.checks.runtimeVerified, false);
});
test('missing manifest agents declaration falls back to actual agents directory', async t => {
  const root = await fixture(t);
  await writeFile(join(root, 'agents', 'lead.md'), '---\nname: lead\n---\nLead team.');
  await writeFile(join(root, '.codebuddy-plugin', 'plugin.json'), JSON.stringify({ name: 'team', version: '1.0.0', expertType: 'team', teamInfo: { leadAgent: 'lead', memberAgents: ['worker'] } }));
  const result = await convertExpert(root, { id: 'Team' }, { plugin: 'team' });
  assert.equal(result.agents.length, 1);
  assert.equal(result.candidate, null);
  assert.deepEqual(result.team.memberAgents, ['worker']);
  assert.ok(result.warnings.includes('agent-teams-adapter-required'));
});
test('package references cannot escape via parent segments or symlinks', async t => {
  const root = await fixture(t);
  await symlink(tmpdir(), join(root, 'outside'));
  await assert.rejects(containedPath(root, '../'), /escapes/);
  await assert.rejects(containedPath(root, 'outside'), /escapes/);
  await assert.rejects(containedPath(root, '/etc/passwd'), /relative/);
});
test('connector drafts discard credential values and command arguments, remain disabled', () => {
  const result = connectorDraft({ mcpServers: { demo: { url: 'https://' + 'person' + ':' + 'secret' + '@' + 'example.com/mcp?token=top-secret', command: 'npx', args: ['tool', '--secret', 'command-secret'], headers: { Authorization: 'Bearer header-secret' }, env: { API_KEY: 'env-secret', PUBLIC_TOKEN: '${USER_TOKEN}' } } } });
  const serialized = JSON.stringify(result);
  for (const secret of ['top-secret', 'header-secret', 'env-secret', 'command-secret', 'person:secret']) assert.equal(serialized.includes(secret), false);
  assert.equal(result.config.mcpServers.demo.disabled, true);
  assert.equal(result.authorized, false);
  assert.equal(result.config.mcpServers.demo.env.PUBLIC_TOKEN, '${USER_TOKEN}');
  assert.ok(result.requiredConfiguration.includes('demo.args'));
});
test('archive preflight rejects traversal, links and duplicate entries before extraction', () => {
  const script = `import importlib.util,io,tarfile
spec=importlib.util.spec_from_file_location('download','scripts/workbuddy/download.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
for mode in ('traversal','symlink','duplicate'):
 data=io.BytesIO()
 with tarfile.open(fileobj=data,mode='w:gz') as t:
  entry=tarfile.TarInfo('../escape' if mode=='traversal' else 'file')
  if mode=='symlink': entry.type=tarfile.SYMTYPE;entry.linkname='/tmp'
  t.addfile(entry)
  if mode=='duplicate':t.addfile(entry)
 data.seek(0)
 with tarfile.open(fileobj=data,mode='r:gz') as t:
  try:m.safe_members(t)
  except ValueError:pass
  else:raise AssertionError(mode)
print('ok')`;
  assert.equal(execFileSync('python3', ['-c', script], { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } }).trim(), 'ok');
});

test('localized lists and URL placeholders remain convertible without invented examples or auth', async t => {
  const root = await fixture(t);
  await writeFile(join(root, 'agents', 'lead.md'), 'Review evidence.');
  await writeFile(join(root, '.codebuddy-plugin', 'plugin.json'), JSON.stringify({ name: 'lead', version: '1.0.0', agents: ['agents/lead.md'], quickPrompts: { zh: ['任务一', '任务二'] }, tags: { zh: ['标签'] } }));
  const result = await convertExpert(root, { id: 'Lead' }, { plugin: 'lead' });
  assert.deepEqual(result.candidate.examples, ['任务一', '任务二']);
  assert.deepEqual(result.candidate.tags, ['标签']);
  const connector = connectorDraft({ mcpServers: { demo: { url: '${USER_ENDPOINT}' } } });
  assert.equal(connector.config.mcpServers.demo.url, '${MCP_URL}');
  assert.ok(connector.requiredConfiguration.includes('demo.url'));
});
test('local release requires reviewed source digest and license; a downloaded draft cannot load', async t => {
  const { seed } = await import('../packages/expert-catalog/src/seed.mjs');
  const { prepareRelease } = await import('../scripts/workbuddy/release.mjs');
  const { loadExpertCatalog } = await import('../packages/expert-catalog/src/release.mjs');
  const root = await fixture(t), item = structuredClone(seed.items[0]);
  item.id = 'imported-demo'; item.categoryId = 'imported-engineering';
  item.origin = { type: 'imported', source: 'https://example.com/demo.tar.gz', sourceSha256: 'locked', license: 'MIT' };
  const source = { schemaVersion: 1, revision: 'test.1', categories: [{ ...seed.categories[0], id: 'imported-engineering' }], items: [item] };
  const downloads = { bundles: [{ plugin: 'demo', status: 'downloaded', sha256: 'locked', url: item.origin.source }] };
  assert.throws(() => prepareRelease(source, downloads), /内容评审/);
  item.validation = { state: 'definition-reviewed', notes: 'Fixture source reviewed', verifiedRuntimes: [], reviewedSourceSha256: 'locked' };
  const release = prepareRelease(source, downloads);
  item.origin.sourceSha256 = 'changed';
  assert.throws(() => prepareRelease(source, downloads), /来源或许可/);
  await writeFile(join(root, 'release.json'), JSON.stringify(release));
  const catalog = await loadExpertCatalog(join(root, 'release.json'));
  assert.equal(catalog.list().items.length, seed.items.length + 1);
  assert.equal(catalog.prepare('imported-demo').spec.instructions.system, item.spec.instructions.system);
});
