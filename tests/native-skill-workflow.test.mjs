import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, existsSync, readFileSync, readdirSync, statSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createNativeSkillWorkflowExecutor } from '../src/providers/native-skill-workflow.mjs';

const tmp = realpathSync(tmpdir());

function realRunCommand({ argv, cwd, env, timeoutSeconds, signal }) {
  return new Promise((resolvePromise) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => stdout += d);
    child.stderr.on('data', d => stderr += d);
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolvePromise({ exit_code: null, stdout, stderr, timed_out: true, timeout_seconds: timeoutSeconds }); }, (timeoutSeconds || 300) * 1000);
    if (signal) signal.addEventListener('abort', () => { child.kill('SIGTERM'); }, { once: true });
    child.on('exit', (code) => { clearTimeout(timer); resolvePromise({ exit_code: code, stdout, stderr }); });
    child.on('error', (err) => { clearTimeout(timer); resolvePromise({ exit_code: 1, stdout, stderr, error: err.message }); });
  });
}

function setupFixture(t, skillName, scripts, opts = {}) {
  const root = mkdtempSync(join(tmp, 'skill-wf-'));
  const skillRoot = join(root, 'skill');
  const scriptsDir = join(skillRoot, 'scripts');
  mkdirSync(scriptsDir, { recursive: true });
  for (const [name, content] of Object.entries(scripts || {})) {
    writeFileSync(join(scriptsDir, name), content, { mode: 0o755 });
  }
  const workDir = join(root, 'work');
  mkdirSync(workDir, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, skillRoot, scriptsDir, workDir, pkg: { name: skillName, body: opts.body || 'Instructions body', rootDir: skillRoot, skillId: 'skill-1', versionId: 'v1', spaceId: 'space-1' } };
}

// ---- Tests -----------------------------------------------------------------

test('generic workflow: run-workflow.sh executes with env and collects artifacts', async t => {
  const { workDir, pkg } = setupFixture(t, 'generic-skill', {
    'run-workflow.sh': `#!/bin/bash\necho "artifact=$KSADK_SKILL_OUTPUT_DIR/result.txt"\necho "Prompt: $KSADK_WORKFLOW_PROMPT" > "$KSADK_SKILL_OUTPUT_DIR/result.txt"\nexit 0\n`,
  });
  const executor = createNativeSkillWorkflowExecutor({ runCommand: realRunCommand, workDir });
  const result = await executor.execute({ workflowPrompt: 'Build something', packages: [pkg], signal: new AbortController().signal, assertCurrent: () => true });
  assert.equal(result.status, 'ok');
  assert.equal(result.executed_skill, 'generic-skill');
  assert.ok(result.artifacts.length > 0);
  assert.ok(result.output_text.includes('Prompt: Build something'));
  assert.deepEqual(result.selected_skills, []);
  assert.deepEqual(result.loaded_skills, ['generic-skill']);
});

test('generic workflow: non-zero exit returns failed', async t => {
  const { workDir, pkg } = setupFixture(t, 'failing-skill', { 'run-workflow.sh': '#!/bin/bash\necho "error" >&2\nexit 3\n' });
  const executor = createNativeSkillWorkflowExecutor({ runCommand: realRunCommand, workDir });
  const result = await executor.execute({ workflowPrompt: 'test', packages: [pkg], signal: new AbortController().signal, assertCurrent: () => true });
  assert.equal(result.status, 'failed');
  assert.equal(result.commands[0].exit_code, 3);
  assert.match(result.error, /exit code 3/);
});

test('instruction-only: no scripts returns instructions', async t => {
  const { workDir, pkg } = setupFixture(t, 'instruction-skill', {}, { body: 'Follow these steps.' });
  rmSync(join(pkg.rootDir, 'scripts'), { recursive: true, force: true });
  const executor = createNativeSkillWorkflowExecutor({ runCommand: realRunCommand, workDir });
  const result = await executor.execute({ workflowPrompt: 'test', packages: [pkg], signal: new AbortController().signal, assertCurrent: () => true });
  assert.equal(result.status, 'instructions');
  assert.equal(result.instructions, 'Follow these steps.');
});

test('skipped: scripts but no entrypoint', async t => {
  const { workDir, pkg } = setupFixture(t, 'no-entry', { 'other.sh': '#!/bin/bash\nexit 0\n' }, { body: '' });
  const executor = createNativeSkillWorkflowExecutor({ runCommand: realRunCommand, workDir });
  const result = await executor.execute({ workflowPrompt: 'test', packages: [pkg], signal: new AbortController().signal, assertCurrent: () => true });
  assert.equal(result.status, 'skipped');
});

test('no_skills: empty packages', async () => {
  const executor = createNativeSkillWorkflowExecutor({ runCommand: realRunCommand, workDir: '/tmp' });
  const result = await executor.execute({ workflowPrompt: 'test', packages: [], signal: new AbortController().signal, assertCurrent: () => true });
  assert.equal(result.status, 'no_skills');
});

test('web-artifacts-builder: init + bundle produces bundle.html', async t => {
  const { workDir, pkg } = setupFixture(t, 'web-artifacts-builder', {
    'init-artifact.sh': '#!/bin/bash\nmkdir -p "$1"\necho "<h1>Source</h1>" > "$1/source.html"\nexit 0\n',
    'bundle-artifact.sh': '#!/bin/bash\ncat source.html > bundle.html\necho "<p>Done</p>" >> bundle.html\nexit 0\n',
  });
  const executor = createNativeSkillWorkflowExecutor({ runCommand: realRunCommand, workDir });
  const result = await executor.execute({ workflowPrompt: 'build a web artifact', packages: [pkg], signal: new AbortController().signal, assertCurrent: () => true });
  assert.equal(result.status, 'ok');
  assert.equal(result.commands.length, 2);
  assert.ok(result.output_files.some(f => f.endsWith('bundle.html')));
  assert.ok(existsSync(join(workDir, 'ksadk-artifact', 'bundle.html')));
  assert.ok(readFileSync(result.output_files[0], 'utf8').includes('Done'));
  // Python artifacts.py excludes HTML from model-facing text; the actual
  // HTML deliverable must still preserve its exact contents.
  assert.equal(result.output_text, '');
});

test('web-artifacts-builder: init failure returns failed', async t => {
  const { workDir, pkg } = setupFixture(t, 'web-artifacts-builder', { 'init-artifact.sh': '#!/bin/bash\nexit 1\n', 'bundle-artifact.sh': '#!/bin/bash\nexit 0\n' });
  const executor = createNativeSkillWorkflowExecutor({ runCommand: realRunCommand, workDir });
  const result = await executor.execute({ workflowPrompt: 'build artifact', packages: [pkg], signal: new AbortController().signal, assertCurrent: () => true });
  assert.equal(result.status, 'failed');
  assert.equal(result.commands.length, 1);
  assert.equal(result.commands[0].exit_code, 1);
});

test('web-artifacts-builder: not triggered without marker', async t => {
  const { workDir, pkg } = setupFixture(t, 'web-artifacts-builder', { 'init-artifact.sh': '#!/bin/bash\nexit 0\n', 'bundle-artifact.sh': '#!/bin/bash\nexit 0\n' });
  const executor = createNativeSkillWorkflowExecutor({ runCommand: realRunCommand, workDir });
  const result = await executor.execute({ workflowPrompt: 'plain prompt', packages: [pkg], signal: new AbortController().signal, assertCurrent: () => true });
  assert.ok(['instructions', 'skipped'].includes(result.status));
});

// ---- Security tests with real files ----

test('ancestor symlink artifact rejected: symlink in workDir ancestor does not leak outside files', async t => {
  const outsideFile = join(tmp, 'outside-leak.txt');
  writeFileSync(outsideFile, 'OUTSIDE_SECRET_DATA');
  t.after(() => rmSync(outsideFile, { force: true }));
  const { workDir, pkg } = setupFixture(t, 'ancestor-symlink-skill', {
    'run-workflow.sh': `#!/bin/bash\n# Create a symlink in the workDir pointing outside\nln -s "${outsideFile}" "$KSADK_SKILL_OUTPUT_DIR/leak.txt"\n# Also create a real file\necho "safe" > "$KSADK_SKILL_OUTPUT_DIR/safe.txt"\necho "artifact=$KSADK_SKILL_OUTPUT_DIR/leak.txt"\necho "artifact=$KSADK_SKILL_OUTPUT_DIR/safe.txt"\nexit 0\n`,
  });
  const executor = createNativeSkillWorkflowExecutor({ runCommand: realRunCommand, workDir });
  const result = await executor.execute({ workflowPrompt: 'test', packages: [pkg], signal: new AbortController().signal, assertCurrent: () => true });
  assert.equal(result.status, 'ok');
  assert.ok(result.artifacts.some(f => f.endsWith('safe.txt')), 'safe.txt collected');
  assert.ok(!result.artifacts.some(f => f.endsWith('leak.txt')), 'symlink leak.txt rejected');
  assert.ok(!result.output_text.includes('OUTSIDE_SECRET_DATA'), 'outside content not leaked');
  assert.ok(result.output_text.includes('safe'), 'safe content present');
});

test('path escape artifact rejected: outside file not collected', async t => {
  const outsideFile = join(tmp, 'outside-escape.txt');
  writeFileSync(outsideFile, 'ESCAPE_SECRET');
  t.after(() => rmSync(outsideFile, { force: true }));
  const { workDir, pkg } = setupFixture(t, 'escape-skill', {
    'run-workflow.sh': `#!/bin/bash\necho "artifact=${outsideFile}"\nexit 0\n`,
  });
  const executor = createNativeSkillWorkflowExecutor({ runCommand: realRunCommand, workDir });
  const result = await executor.execute({ workflowPrompt: 'test', packages: [pkg], signal: new AbortController().signal, assertCurrent: () => true });
  assert.equal(result.status, 'ok');
  assert.ok(!result.artifacts.includes(outsideFile));
  assert.ok(!result.output_text.includes('ESCAPE_SECRET'));
});

test('relative artifact path resolved against workDir', async t => {
  const { workDir, pkg } = setupFixture(t, 'relative-artifact-skill', {
    'run-workflow.sh': `#!/bin/bash\necho "safe content" > "$KSADK_SKILL_OUTPUT_DIR/relative.txt"\necho "artifact=artifacts/relative.txt"\nexit 0\n`,
  });
  const executor = createNativeSkillWorkflowExecutor({ runCommand: realRunCommand, workDir });
  const result = await executor.execute({ workflowPrompt: 'test', packages: [pkg], signal: new AbortController().signal, assertCurrent: () => true });
  assert.equal(result.status, 'ok');
  assert.ok(result.artifacts.some(f => f.endsWith('relative.txt')), 'relative artifact resolved');
  assert.ok(result.output_text.includes('safe content'));
});

test('assertCurrent false prevents execution (no FS change)', async t => {
  const { workDir, pkg } = setupFixture(t, 'guard-skill', { 'run-workflow.sh': '#!/bin/bash\necho "should not run" > "$KSADK_SKILL_OUTPUT_DIR/leaked.txt"\nexit 0\n' });
  const executor = createNativeSkillWorkflowExecutor({ runCommand: realRunCommand, workDir });
  let threw = false;
  try { await executor.execute({ workflowPrompt: 'test', packages: [pkg], signal: new AbortController().signal, assertCurrent: () => false }); }
  catch (e) { threw = true; assert.equal(e.code, 'SW_LEASE_LOST'); }
  assert.ok(threw, 'assertCurrent false threw SW_LEASE_LOST');
  assert.ok(!existsSync(join(workDir, 'artifacts', 'leaked.txt')), 'no file created when guard fails');
});

test('assertCurrent thenable observed and rejected', async t => {
  const { workDir, pkg } = setupFixture(t, 'thenable-skill', { 'run-workflow.sh': '#!/bin/bash\nexit 0\n' });
  let observed = false;
  const thenableAssert = () => { const p = Promise.resolve(true); p.then(() => {}, () => {}); observed = true; return p; };
  const executor = createNativeSkillWorkflowExecutor({ runCommand: realRunCommand, workDir });
  let threw = false;
  try { await executor.execute({ workflowPrompt: 'test', packages: [pkg], signal: new AbortController().signal, assertCurrent: thenableAssert }); }
  catch (e) { threw = true; assert.equal(e.code, 'SW_LEASE_LOST'); }
  assert.ok(threw, 'thenable rejected');
  assert.ok(observed, 'thenable was observed');
});

test('signal abort prevents FS change', async t => {
  const { workDir, pkg } = setupFixture(t, 'abort-skill', { 'run-workflow.sh': '#!/bin/bash\nsleep 10\nexit 0\n' });
  const controller = new AbortController();
  const executor = createNativeSkillWorkflowExecutor({ runCommand: realRunCommand, workDir });
  const promise = executor.execute({ workflowPrompt: 'test', packages: [pkg], signal: controller.signal, assertCurrent: () => true });
  setTimeout(() => controller.abort(), 100);
  let threw = false;
  try { await promise; } catch (e) { threw = true; }
  assert.ok(threw, 'abort threw (not swallowed)');
});

test('output text truncation: large file truncated within budget', async t => {
  const { workDir, pkg } = setupFixture(t, 'trunc-skill', {
    'run-workflow.sh': '#!/bin/bash\ndd if=/dev/zero bs=1024 count=512 2>/dev/null | tr "\\0" "A" > "$KSADK_SKILL_OUTPUT_DIR/big.txt"\necho "artifact=$KSADK_SKILL_OUTPUT_DIR/big.txt"\nexit 0\n',
  });
  const executor = createNativeSkillWorkflowExecutor({ runCommand: realRunCommand, workDir });
  const result = await executor.execute({ workflowPrompt: 'test', packages: [pkg], signal: new AbortController().signal, assertCurrent: () => true });
  assert.equal(result.status, 'ok');
  assert.ok(result.output_text_truncated);
  assert.ok(Buffer.byteLength(result.output_text, 'utf8') <= 256 * 1024);
});

test('deep directory tree limited by MAX_OUTPUT_DEPTH', async t => {
  const { workDir, pkg } = setupFixture(t, 'deep-skill', {
    'run-workflow.sh': `#!/bin/bash\n# Create 15 levels deep\nd="$KSADK_SKILL_OUTPUT_DIR"\nfor i in $(seq 1 15); do d="$d/level$i"; mkdir -p "$d"; done\necho "deep" > "$d/deep.txt"\nexit 0\n`,
  });
  const executor = createNativeSkillWorkflowExecutor({ runCommand: realRunCommand, workDir });
  const result = await executor.execute({ workflowPrompt: 'test', packages: [pkg], signal: new AbortController().signal, assertCurrent: () => true });
  assert.equal(result.status, 'ok');
  // Deep files beyond MAX_OUTPUT_DEPTH should not be collected.
  assert.ok(!result.artifacts.some(f => f.includes('level15')), 'deep file not collected');
});

test('factory requires runCommand and workDir', () => {
  assert.throws(() => createNativeSkillWorkflowExecutor({}), /runCommand required/);
  assert.throws(() => createNativeSkillWorkflowExecutor({ runCommand: () => {} }), /workDir required/);
});

test('selected_skills filters by name', async t => {
  const { workDir, pkg: genericPkg } = setupFixture(t, 'generic-skill', { 'run-workflow.sh': '#!/bin/bash\necho "ran"\nexit 0\n' });
  const otherPkg = { name: 'other-skill', body: '', rootDir: '/nonexistent', skillId: 's2', versionId: 'v1', spaceId: 'sp1' };
  const executor = createNativeSkillWorkflowExecutor({ runCommand: realRunCommand, workDir });
  const result = await executor.execute({ workflowPrompt: 'test', skillNames: ['generic-skill'], packages: [genericPkg, otherPkg], signal: new AbortController().signal, assertCurrent: () => true });
  assert.equal(result.executed_skill, 'generic-skill');
  assert.deepEqual(result.selected_skills, ['generic-skill']);
  assert.equal(result.loaded_skills.length, 2);
});

test('parent counterexample: a directory symlink in an artifact ancestor cannot publish outside text', async t => {
  const h = setupFixture(t, 'alpha', { 'run-workflow.sh': 'exit 0' });
  const outside = join(h.root, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'secret.md'), 'PRIVATE_OUTSIDE_WORKDIR');
  const executor = createNativeSkillWorkflowExecutor({ workDir: h.workDir, runCommand: async () => {
    symlinkSync(outside, join(h.workDir, 'artifacts', 'link'));
    return { exit_code: 0, stdout: 'artifact=artifacts/link/secret.md', stderr: '' };
  } });
  const result = await executor.execute({ workflowPrompt: 'alpha', packages: [h.pkg], signal: new AbortController().signal, assertCurrent: () => true });
  assert.deepEqual(result.artifacts, []); assert.deepEqual(result.output_files, []);
  assert.doesNotMatch(result.output_text, /PRIVATE_OUTSIDE_WORKDIR/);
});

test('bounded UTF-8 reads retain a complete 200 KiB artifact and mark a larger artifact truncated', async t => {
  const h = setupFixture(t, 'alpha', { 'run-workflow.sh': 'exit 0' });
  let content = '中'.repeat(70000);
  const executor = createNativeSkillWorkflowExecutor({ workDir: h.workDir, runCommand: async () => {
    writeFileSync(join(h.workDir, 'artifacts/output.md'), content);
    return { exit_code: 0, stdout: 'artifact=artifacts/output.md', stderr: '' };
  } });
  const input = { workflowPrompt: 'alpha', packages: [h.pkg], signal: new AbortController().signal, assertCurrent: () => true };
  const complete = await executor.execute(input); assert.equal(complete.output_text, content); assert.equal(complete.output_text_truncated, false);
  content = '中'.repeat(100000); const limited = await executor.execute(input);
  assert.ok(Buffer.byteLength(limited.output_text) <= 256 * 1024); assert.equal(limited.output_text_truncated, true);
  assert.doesNotMatch(limited.output_text, /\uFFFD/);
});

test('an existing web project is preserved byte for byte without dispatch', async t => {
  const h = setupFixture(t, 'web-artifacts-builder', { 'init-artifact.sh': 'exit 0', 'bundle-artifact.sh': 'exit 0' });
  mkdirSync(join(h.workDir, 'ksadk-artifact')); const saved = join(h.workDir, 'ksadk-artifact', 'keep.txt'); writeFileSync(saved, 'existing work');
  const executor = createNativeSkillWorkflowExecutor({ workDir: h.workDir, runCommand: () => assert.fail('existing project cannot be deleted or rerun') });
  const result = await executor.execute({ workflowPrompt: 'build artifact', packages: [h.pkg], signal: new AbortController().signal, assertCurrent: () => true });
  assert.equal(result.error_type, 'SW_PROJECT_EXISTS'); assert.equal(readFileSync(saved, 'utf8'), 'existing work');
});

test('a reentrant authority callback cannot replace an instruction-only request or leave an unhandled rejection', async t => {
  const h = setupFixture(t, 'alpha', {}, { body: 'instructions' }); rmSync(h.scriptsDir, { recursive: true });
  const executor = createNativeSkillWorkflowExecutor({ workDir: h.workDir, runCommand: () => assert.fail() });
  const input = { workflowPrompt: 'alpha', packages: [h.pkg], signal: new AbortController().signal };
  input.assertCurrent = () => { input.signal = new AbortController().signal; return true; };
  await assert.rejects(executor.execute(input), /SW_REQUEST_CHANGED/);
  const rejected = { ...input, assertCurrent: () => Promise.reject(new Error('observe me')) };
  await assert.rejects(executor.execute(rejected), /SW_LEASE_LOST/); await new Promise(resolve => setImmediate(resolve));
});
