import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSkillDiscovery, parseFrontmatter, skillSlug } from '../src/skill-discovery.mjs';

test('strict imported manifests reject malformed YAML while local-display scalar recovery remains available', () => {
  const bad = '---\nname: sample\ndescription: valid\nbroken: [\n---\nbody';
  assert.equal(parseFrontmatter(bad).name, 'sample');
  assert.throws(() => parseFrontmatter(bad, { strict: true }), { code: 'SKILL_MANIFEST_INVALID' });
  for (const source of ['---name: sample\ndescription: test\n---\nbody', '---\nname: sample\ndescription: test\n---'])
    assert.throws(() => parseFrontmatter(source, { strict: true }), { code: 'SKILL_MANIFEST_INVALID' });
});

test('strict import frontmatter preserves universal newlines, bounded aliases and Python duplicate-key selection', () => {
  const metadata = parseFrontmatter('---\r\nname: old\r\nname: imported\r\ndescription: &text Unicode 技能\r\ncopy: *text\r\n---\r\nbody', { strict: true });
  assert.equal(metadata.name, 'imported'); assert.equal(metadata.description, 'Unicode 技能'); assert.equal(metadata.copy, metadata.description);
});
import { DatabaseSync } from 'node:sqlite';
import { statSync } from 'node:fs';

async function makeHome() {
  return mkdtemp(join(tmpdir(), 'agentkit-skills-'));
}

test('local Skill discovery orders supplementary Unicode paths by Python code points', async t => {
  const home = await makeHome(), scan = join(home, 'skills');
  t.after(() => rm(home, { recursive: true, force: true }));
  for (const name of ['\u{10000}', '\ue000']) {
    await mkdir(join(scan, name), { recursive: true });
    await writeFile(join(scan, name, 'SKILL.md'), '---\nname: same\ndescription: valid\n---\nInstructions');
  }
  const result = await createSkillDiscovery({ home }).discover([scan]);
  assert.deepEqual(result.candidates.map(value => value.path), [join(scan, '\ue000'), join(scan, '\u{10000}')]);
});

test('parseFrontmatter reads simple scalar fields and ignores non-manifest text', () => {
  const metadata = parseFrontmatter('---\nname: My Skill\ndescription: does things\nversion: 2.1.0\n---\nbody');
  assert.equal(metadata.name, 'My Skill');
  assert.equal(metadata.version, '2.1.0');
  assert.deepEqual(parseFrontmatter('no frontmatter'), {});
});
test('bundled Skill metadata keeps multiline descriptions and YAML invocation flags', () => {
  const metadata = parseFrontmatter('---\nname: bundled-skill\ndescription: |\n  First line\n  Second line\ndisable-model-invocation: true\n---\nBody');
  assert.equal(metadata.description, 'First line\nSecond line\n');
  assert.equal(metadata['disable-model-invocation'], true);
});

test('skillSlug normalizes names and rejects empty results', () => {
  assert.equal(skillSlug('My Cool Skill!'), 'my-cool-skill');
  assert.throws(() => skillSlug('///'), error => error.code === 'SKILL_NAME_INVALID');
});

test('discover scans SKILL.md manifests, previews files, commits into the store, and lists them', async () => {
  const home = await makeHome();
  const scanRoot = join(home, '.claude', 'skills', 'demo-skill');
  await mkdir(join(scanRoot, 'scripts'), { recursive: true });
  await writeFile(join(scanRoot, 'SKILL.md'), '---\nname: demo-skill\ndescription: demo skill for tests\nversion: 1.2.0\n---\ncurl https://example.com');
  await writeFile(join(scanRoot, 'scripts', 'run.py'), 'print("hi")');
  const discovery = createSkillDiscovery({ home });
  try {
    const report = await discovery.discover(null);
    assert.equal(report.candidates.length, 1);
    const candidate = report.candidates[0];
    assert.equal(candidate.name, 'demo-skill');
    assert.equal(candidate.version, '1.2.0');
    assert.equal(candidate.status, 'ready');
    assert.equal(candidate.risk.containsScripts, true);
    assert.ok(candidate.risk.networkMarkers.includes('https://'));
    assert.equal(candidate.risk.requiresReview, true);

    const files = await discovery.previewDiscovered(report.inspectionToken, candidate.candidateId, '');
    assert.deepEqual(files.files.map(file => file.path).sort(), ['SKILL.md', 'scripts/run.py']);
    const preview = await discovery.previewDiscovered(report.inspectionToken, candidate.candidateId, 'scripts/run.py');
    assert.match(preview.content, /print\("hi"\)/);

    const imported = await discovery.commitDiscovered(report.inspectionToken, candidate.candidateId, false);
    assert.equal(imported.status, 'ready');
    assert.equal(imported.name, 'demo-skill');

    const listed = await discovery.listInstalled();
    assert.equal(listed.items.length, 1);
    assert.equal(listed.items[0].name, 'demo-skill');

    const installedPreview = await discovery.previewInstalled(listed.items[0].resourceId, 'SKILL.md');
    assert.match(installedPreview.content, /description: demo skill for tests/);

    // Second import without overwrite is rejected as a conflict.
    const report2 = await discovery.discover(null);
    await assert.rejects(
      () => discovery.commitDiscovered(report2.inspectionToken, report2.candidates[0].candidateId, false),
      error => error.code === 'SKILL_ALREADY_EXISTS',
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('preview and commit reject path escapes outside the scanned directory', async () => {
  const home = await makeHome();
  const scanRoot = join(home, '.claude', 'skills', 'safe');
  await mkdir(scanRoot, { recursive: true });
  await writeFile(join(scanRoot, 'SKILL.md'), '---\nname: safe\ndescription: safe\nversion: 1.0.0\n---\nbody');
  const discovery = createSkillDiscovery({ home });
  try {
    const report = await discovery.discover(null);
    const candidate = report.candidates[0];
    await assert.rejects(
      () => discovery.previewDiscovered(report.inspectionToken, candidate.candidateId, '../outside.txt'),
      error => error.code === 'SKILL_PREVIEW_PATH_INVALID',
    );
    await assert.rejects(
      () => discovery.previewDiscovered('skd_missing', candidate.candidateId, ''),
      error => error.code === 'SKILL_DISCOVERY_TOKEN_INVALID',
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('explicit scan directories outside home can be previewed and imported, including a Skill root', async () => {
  const home = await makeHome(), outside = await makeHome();
  try {
    await writeFile(join(outside, 'SKILL.md'), '---\nname: external-e2e\ndescription: test\n---\nbody');
    const discovery = createSkillDiscovery({ home });
    const report = await discovery.discover([outside]);
    assert.equal(report.candidates.length, 1);
    assert.match((await discovery.previewDiscovered(report.inspectionToken, report.candidates[0].candidateId, 'SKILL.md')).content, /external-e2e/);
    const imported = await discovery.commitDiscovered(report.inspectionToken, report.candidates[0].candidateId);
    assert.equal(imported.name, 'external-e2e');
    await assert.rejects(discovery.previewDiscovered(report.inspectionToken, report.candidates[0].candidateId, '../outside'), { code: 'SKILL_PREVIEW_PATH_INVALID' });
  } finally { await rm(home, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test('equal Skill directory names in different explicit roots remain distinct candidates', async () => {
  const home = await makeHome();
  try {
    const roots = [join(home, 'one'), join(home, 'two')];
    for (const root of roots) { await mkdir(join(root, 'same'), { recursive: true }); await writeFile(join(root, 'same', 'SKILL.md'), '---\nname: same\n---\nbody'); }
    const result = await createSkillDiscovery({ home }).discover(roots);
    assert.equal(result.candidates.length, 2);
    assert.equal(new Set(result.candidates.map(item => item.candidateId)).size, 2);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('catalog publication preserves an existing readable store and rejects lost authority after cross-Host lock wait', async t => {
  const root = await makeHome(); t.after(() => rm(root, { recursive: true, force: true }));
  const storeDir = join(root, 'readable-store'); await mkdir(storeDir, { mode: 0o755 });
  const before = statSync(storeDir).mode, discovery = createSkillDiscovery({ storeDir });
  const first = { resourceId: `skill-catalog-${'a'.repeat(24)}`, directory: root, digest: 'a', name: 'first', kind: 'skill', status: 'ready' };
  await discovery.registerBundleSkills([first]); assert.equal(statSync(storeDir).mode, before);
  const db = new DatabaseSync(join(storeDir, '.catalog-publication/lock.sqlite')); db.exec('BEGIN IMMEDIATE');
  let current = true;
  const pending = discovery.registerBundleSkills([{ ...first, resourceId: `skill-catalog-${'b'.repeat(24)}`, name: 'second' }], { assertCurrent: () => current });
  await new Promise(resolve => setTimeout(resolve, 35)); current = false; db.exec('ROLLBACK'); db.close();
  await assert.rejects(pending, { code: 'SKILL_PUBLICATION_AUTHORITY_LOST' });
  assert.deepEqual((await discovery.listInstalled()).items.map(item => item.name), ['first']);
  await assert.rejects(discovery.registerBundleSkills([first], { assertCurrent: async () => true }), { code: 'SKILL_PUBLICATION_AUTHORITY_LOST' });
});
