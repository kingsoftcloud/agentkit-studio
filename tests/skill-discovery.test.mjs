import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSkillDiscovery, parseFrontmatter, skillSlug } from '../src/skill-discovery.mjs';

async function makeHome() {
  return mkdtemp(join(tmpdir(), 'agentkit-skills-'));
}

test('parseFrontmatter reads simple scalar fields and ignores non-manifest text', () => {
  const metadata = parseFrontmatter('---\nname: My Skill\ndescription: does things\nversion: 2.1.0\n---\nbody');
  assert.equal(metadata.name, 'My Skill');
  assert.equal(metadata.version, '2.1.0');
  assert.deepEqual(parseFrontmatter('no frontmatter'), {});
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
