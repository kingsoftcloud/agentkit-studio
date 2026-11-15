import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const script = fileURLToPath(new URL('../ci/ezone-native-gate.sh', import.meta.url));
test('Ezone rejects absent, malformed and mismatched commits before running installation commands',
  { skip: process.platform === 'win32' ? 'The Ezone runner requires POSIX Bash.' : false }, t => {
    const root = mkdtempSync(join(tmpdir(), 'ezone-checkout-guard-')), bin = join(root, 'bin'), marker = join(root, 'effects');
    t.after(() => rmSync(root, { recursive: true, force: true })); mkdirSync(bin);
    const executable = (name, body) => writeFileSync(join(bin, name), '#!/bin/sh\n' + body + '\n', { mode: 0o755 });
    executable('git', 'printf "%s\\n" "$EZONE_GUARD_HEAD"'); executable('id', 'printf "0\\n"');
    for (const name of ['node', 'apk', 'apt-get', 'useradd', 'chown', 'install', 'su-exec', 'runuser'])
      executable(name, 'printf "%s\\n" invoked >> "$EZONE_GUARD_MARKER"; exit 99');
    for (const [commit, status, message] of [[undefined, 1, /immutable build commit/], ['main', 2, /Invalid build commit/],
      ['b'.repeat(40), 2, /Wrong checkout: expected b{40}, got a{40}/]]) {
      const env = { PATH: bin, GITLEAKS_BIN: '/unused-scanner',
        EZONE_GUARD_HEAD: 'a'.repeat(40), EZONE_GUARD_MARKER: marker };
      delete env.SYS_BUILD_COMMIT; if (commit !== undefined) env.SYS_BUILD_COMMIT = commit;
      const result = spawnSync('/bin/bash', [script], { env, encoding: 'utf8', timeout: 5000 });
      assert.ifError(result.error); assert.equal(result.status, status); assert.match(result.stderr, message);
      assert.equal(existsSync(marker), false, 'an unverified checkout must not reach a build or installation command');
    }
  });

test('Ezone public wrapper rejects an unverified checkout before tool bootstrap or preinstall',
  { skip: process.platform === 'win32' ? 'The Ezone runner requires POSIX Bash.' : false }, t => {
    const root = mkdtempSync(join(tmpdir(), 'ezone-wrapper-guard-')), bin = join(root, 'bin');
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(bin); mkdirSync(join(root, 'ci'));
    copyFileSync(new URL('../ci/ezone-public-gate.sh', import.meta.url), join(root, 'ci/ezone-public-gate.sh'));
    copyFileSync(new URL('../ci/run-with-deadline.mjs', import.meta.url), join(root, 'ci/run-with-deadline.mjs'));
    const git = spawnSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
    assert.ok(git);
    const gitRun = args => {
      const result = spawnSync(git, ['-C', root, ...args], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
    };
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { preinstall: 'node preinstall.cjs' } }));
    writeFileSync(join(root, 'preinstall.cjs'), "require('node:fs').writeFileSync(process.env.EZONE_GUARD_MARKER, 'preinstall ran');\n");
    gitRun(['init', '--quiet']); gitRun(['add', '.']);
    gitRun(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'fixture']);
    const head = gitRun(['rev-parse', 'HEAD']), marker = join(root, 'preinstall-effect'), probe = join(root, 'tool-effect');
    const executable = (name, body) => writeFileSync(join(bin, name), '#!/bin/sh\n' + body + '\n', { mode: 0o755 });
    executable('git', 'case " $* " in *" cat-file -e "*) exit 0;; esac\nexec "$EZONE_GUARD_GIT" "$@"');
    executable('node', `
      printf 'node\\n' >> "$EZONE_GUARD_PROBE"
      if [ "$1" = --version ]; then printf 'v26.12.1\\n'; exit 0; fi
      if [ "$1" = ci/run-with-deadline.mjs ]; then
        printf '%s\\n' "$*" >> "$EZONE_GUARD_PROBE.deadline"
        if [ ! -f "$EZONE_GUARD_PROBE.timeout" ]; then
          touch "$EZONE_GUARD_PROBE.timeout"
          exit "$EZONE_GUARD_FIRST_STATUS"
        fi
      fi
      exec "$EZONE_GUARD_NODE" "$@"
    `);
    executable('pnpm', 'printf "pnpm\\n" >> "$EZONE_GUARD_PROBE"\nif [ "$1" = --version ]; then printf "10.33.2\\n"; else [ "$PWD" = "$EZONE_GUARD_CHECKOUT" ] || exit 74; "$EZONE_GUARD_NODE" "$EZONE_GUARD_CHECKOUT/preinstall.cjs"; exit 73; fi');
    executable('timeout', 'echo "The worker timeout must not own package-manager descendants" >&2; exit 75');
    // Make the pre-fix wrapper reach installation without network or real tools.
    for (const archive of ['gitleaks-v8.30.1/gitleaks.tar.gz', 'node-v22.23.4/node.tar.xz',
      'node-v22.23.4/node-libs.tar.gz', 'pnpm-v10.33.2/pnpm.tgz']) {
      const path = join(root, '.ci-tools', archive); mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, 'unused');
    }
    const env = { PATH: bin + ':/usr/bin:/bin', GITLEAKS_BIN: '/unused-scanner', EZONE_GUARD_GIT: git,
      EZONE_GUARD_NODE: process.execPath, EZONE_GUARD_CHECKOUT: root, EZONE_GUARD_MARKER: marker, EZONE_GUARD_PROBE: probe,
      EZONE_GUARD_FIRST_STATUS: '124' };
    for (const [commit, message] of [[undefined, /immutable build commit/], ['', /immutable build commit/],
      ['main', /Invalid build commit/], ['b'.repeat(40), /Wrong checkout/]]) {
      const result = spawnSync('/bin/bash', [join(root, 'ci/ezone-public-gate.sh')],
        { cwd: root, env: commit === undefined ? env : { ...env, SYS_BUILD_COMMIT: commit }, encoding: 'utf8', timeout: 5000 });
      assert.ifError(result.error); assert.notEqual(result.status, 0); assert.match(result.stderr, message);
      assert.equal(existsSync(probe), false, 'unverified checkout must not even probe or install tools');
      assert.equal(existsSync(marker), false, 'unverified checkout must not execute preinstall');
    }
    // A matching checkout must reach the controlled installation and its real
    // Node preinstall marker, proving the negative cases have an active trap.
    const caller = join(root, 'unverified-caller'); mkdirSync(caller);
    const accepted = spawnSync('/bin/bash', [join(root, 'ci/ezone-public-gate.sh')],
      { cwd: caller, env: { ...env, SYS_BUILD_COMMIT: head }, encoding: 'utf8', timeout: 5000 });
    assert.ifError(accepted.error); assert.equal(accepted.status, 73, accepted.stderr);
    assert.match(accepted.stderr, /dependency install timed out; retrying with the same frozen lockfile and store/);
    assert.equal(existsSync(probe), true); assert.equal(existsSync(marker), true);
    const attempts = readFileSync(probe + '.deadline', 'utf8').trim().split('\n');
    assert.equal(attempts.length, 2);
    assert.match(attempts[0], /--registry=https:\/\/registry.npmjs.org/);
    assert.match(attempts[1], /--registry=https:\/\/registry.npmmirror.com/);
    assert.ok(attempts.every(line => line.includes('install --frozen-lockfile')));
    const cancelledProbe = probe + '.cancelled', cancelledMarker = marker + '.cancelled';
    const cancelled = spawnSync('/bin/bash', [join(root, 'ci/ezone-public-gate.sh')], {
      cwd: caller, env: { ...env, SYS_BUILD_COMMIT: head, EZONE_GUARD_FIRST_STATUS: '143',
        EZONE_GUARD_PROBE: cancelledProbe, EZONE_GUARD_MARKER: cancelledMarker }, encoding: 'utf8', timeout: 5000,
    });
    assert.ifError(cancelled.error); assert.equal(cancelled.status, 143);
    assert.equal(readFileSync(cancelledProbe + '.deadline', 'utf8').trim().split('\n').length, 1);
    assert.equal(existsSync(cancelledMarker), false, 'a cancelled installer must not start a mirror retry');
  });
