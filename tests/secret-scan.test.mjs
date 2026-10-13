import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/secret-scan.mjs', import.meta.url));
const bin = process.env.GITLEAKS_BIN && resolve(process.env.GITLEAKS_BIN);

test('real secret gate catches uncommitted files and deleted historical secrets without printing values',
  { skip: !bin && 'GITLEAKS_BIN is required for scanner integration' }, async t => {
    const root = await mkdtemp(resolve(tmpdir(), 'studio-gitleaks-test-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const git = args => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
    git(['init', '-q']);
    git(['config', 'user.email', 'fixture@example.test']);
    git(['config', 'user.name', 'Fixture']);
    await writeFile(resolve(root, 'safe.txt'), 'plain text\n');
    git(['add', 'safe.txt']); git(['commit', '-qm', 'safe']);
    const run = () => spawnSync(process.execPath, [script], { cwd: root,
      env: { ...process.env, GITLEAKS_BIN: bin }, encoding: 'utf8' });
    assert.equal(run().status, 0);
    const secret = ['ghp_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('');
    await writeFile(resolve(root, 'new.txt'), `token=${secret}\n`);
    let result = run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /snapshot: .*github-pat/);
    assert.ok(!result.stdout.includes(secret) && !result.stderr.includes(secret));
    git(['add', 'new.txt']); git(['commit', '-qm', 'add synthetic token']);
    git(['rm', '-q', 'new.txt']); git(['commit', '-qm', 'remove token']);
    result = run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /history: .*github-pat/);
    assert.ok(!result.stdout.includes(secret) && !result.stderr.includes(secret));
  });
