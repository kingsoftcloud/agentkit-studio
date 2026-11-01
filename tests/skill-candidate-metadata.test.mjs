/** Tests for skill candidate metadata. Pure, no I/O. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { skillCandidateExcluded, skillCandidateRisk } from '../src/skill-candidate-metadata.mjs';

// ---- skillCandidateExcluded: exact segment match only ---------------------

test('excluded: all 7 EXCLUDED_PARTS as exact segments', () => {
  for (const [p, label] of [
    ['.git/config', '.git'], ['.venv/bin/activate', '.venv'], ['venv/bin/python', 'venv'],
    ['node_modules/pkg/index.js', 'node_modules'], ['dist/bundle.js', 'dist'],
    ['build/output.js', 'build'], ['__pycache__/mod.pyc', '__pycache__'],
  ]) assert.equal(skillCandidateExcluded(p), true, label);
  // nested position
  assert.equal(skillCandidateExcluded('a/.git/b'), true);
  assert.equal(skillCandidateExcluded('src/node_modules/pkg'), true);
  assert.equal(skillCandidateExcluded('x/y/__pycache__/z'), true);
});

test('not excluded: near-miss names (substring ≠ segment)', () => {
  for (const p of [
    '.gitignore', '.github/workflows/ci.yml', '.gitlab-ci.yml',
    '.venv-local/bin', 'venv-setup/script.sh', 'myvenv/script.sh',
    'node_modules_backup/pkg', 'distribution/main.js', 'dist-src/app.js',
    'nodist/file.py', 'building/output.js', 'buildx/output',
    '__pycache__s/cache.pyc', 'mybuild/output.js',
  ]) assert.equal(skillCandidateExcluded(p), false, p);
});

test('not excluded: normal paths and edge', () => {
  for (const p of ['SKILL.md', 'scripts/run.sh', 'src/main.py', 'docs/guide.md', '']) {
    assert.equal(skillCandidateExcluded(p), false, p);
  }
});

// ---- skillCandidateRisk: script suffix via posix.extname (basename only) ---

test('scripts: 5 inspect_candidate suffixes detected (case-insensitive)', () => {
  const result = skillCandidateRisk({ manifestText: '', paths: ['run.py', 'Setup.SH', 'Tool.Js', 'handler.ts', 'cfg.ps1'] });
  assert.deepEqual(result.scripts, ['run.py', 'Setup.SH', 'Tool.Js', 'handler.ts', 'cfg.ps1']);
  assert.equal(result.containsScripts, true);
  assert.equal(result.requiresReview, true);
});

test('scripts: .tsx and .rb NOT detected (inspect_candidate set, not SCRIPT_SUFFIXES)', () => {
  const result = skillCandidateRisk({ manifestText: '', paths: ['component.tsx', 'script.rb'] });
  assert.deepEqual(result.scripts, []);
  assert.equal(result.containsScripts, false);
  assert.equal(result.requiresReview, false);
});

test('scripts: dotfile/path-dot edge cases — extname is basename-only', () => {
  // Python Path(p).suffix for each: '.py'→'', 'nested/.sh'→'', 'dir.py/plain'→'',
  // '.hidden.py'→'.py', '.gitignore'→'' — posix.extname matches exactly.
  const result = skillCandidateRisk({ manifestText: '', paths: [
    '.py',           // dotfile, no suffix → not script
    'nested/.sh',    // dotfile in subdir, no suffix → not script
    'dir.py/plain',  // 'plain' has no ext; 'dir.py' is a dir segment → not script
    '.hidden.py',   // dotfile WITH real ext .py → IS script
    '.gitignore',   // dotfile, no suffix → not script
    'a.b.py',        // multi-dot, ext .py → IS script
  ] });
  assert.deepEqual(result.scripts, ['.hidden.py', 'a.b.py']);
  assert.equal(result.containsScripts, true);
  assert.equal(result.requiresReview, true);
});

test('scripts: non-script extensions and no extension', () => {
  const result = skillCandidateRisk({ manifestText: '', paths: ['SKILL.md', 'guide.md', 'README', 'Makefile', 'data.json'] });
  assert.deepEqual(result.scripts, []);
  assert.equal(result.containsScripts, false);
  assert.equal(result.requiresReview, false);
});

test('scripts: preserves sorted order from paths', () => {
  const result = skillCandidateRisk({ manifestText: '', paths: ['SKILL.md', 'a.py', 'b.sh', 'c.js', 'docs.md'] });
  assert.deepEqual(result.scripts, ['a.py', 'b.sh', 'c.js']);
});

// ---- skillCandidateRisk: networkMarkers (ordered, lowercased) -------------

test('networkMarkers: all 5 markers in order, case-insensitive', () => {
  const text = 'network access via curl http://example.com and https://secure.com and wget http://other.com';
  const result = skillCandidateRisk({ manifestText: text, paths: [] });
  assert.deepEqual(result.networkMarkers, ['http://', 'https://', 'curl ', 'wget ', 'network']);
  assert.equal(result.requiresReview, true);
});

test('networkMarkers: uppercase in manifest matched (lowercased internally)', () => {
  const result = skillCandidateRisk({ manifestText: 'Use CURL and HTTP://x', paths: [] });
  assert.deepEqual(result.networkMarkers, ['http://', 'curl ']);
});

test('networkMarkers: curl/wget without trailing space NOT matched', () => {
  assert.deepEqual(skillCandidateRisk({ manifestText: 'curling iron', paths: [] }).networkMarkers, []);
  assert.deepEqual(skillCandidateRisk({ manifestText: 'wgetting files', paths: [] }).networkMarkers, []);
});

test('networkMarkers: plain text has none', () => {
  const result = skillCandidateRisk({ manifestText: 'A simple skill with no external links.', paths: [] });
  assert.deepEqual(result.networkMarkers, []);
  assert.equal(result.requiresReview, false);
});

// ---- combined + Unicode + edge -------------------------------------------

test('combined: scripts + networkMarkers', () => {
  const result = skillCandidateRisk({ manifestText: 'See http://x\nRun curl to fetch', paths: ['SKILL.md', 'fetch.py'] });
  assert.equal(result.containsScripts, true);
  assert.deepEqual(result.scripts, ['fetch.py']);
  assert.deepEqual(result.networkMarkers, ['http://', 'curl ']);
  assert.equal(result.requiresReview, true);
});

test('combined: no risk', () => {
  const result = skillCandidateRisk({ manifestText: 'A simple skill.', paths: ['SKILL.md', 'docs/guide.md'] });
  assert.equal(result.containsScripts, false);
  assert.deepEqual(result.scripts, []);
  assert.deepEqual(result.networkMarkers, []);
  assert.equal(result.requiresReview, false);
});

test('Unicode in manifest does not crash', () => {
  const result = skillCandidateRisk({ manifestText: '中文技能\nhttp://example.com', paths: ['SKILL.md'] });
  assert.deepEqual(result.networkMarkers, ['http://']);
});

test('edge: empty paths, empty text, bad inputs', () => {
  assert.deepEqual(skillCandidateRisk({ manifestText: 'http://x', paths: [] }).networkMarkers, ['http://']);
  assert.deepEqual(skillCandidateRisk({ manifestText: '', paths: ['s.py'] }).scripts, ['s.py']);
  // safe defaults for bad input
  for (const opts of [{}, { manifestText: null }, { manifestText: 'x', paths: 'no' }, { paths: [] }]) {
    const r = skillCandidateRisk(opts);
    assert.equal(r.containsScripts, false);
    assert.deepEqual(r.scripts, []);
    assert.deepEqual(r.networkMarkers, []);
    assert.equal(r.requiresReview, false);
  }
});
