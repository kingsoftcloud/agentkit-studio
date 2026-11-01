import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
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
