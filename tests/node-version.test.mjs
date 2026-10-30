import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { NODE_VERSION_GUIDANCE, nodeVersionSupported, parseNodeVersion } from '../scripts/node-version.mjs';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

for (const version of ['22.23.4', '22.23.5', '22.24.0', 'v22.30.1', '24.22.1', '24.25.0', '26.12.1', '26.12.2', '27.0.0']) {
  test(`accepts fixed Node.js ${version}`, () => assert.equal(nodeVersionSupported(version), true));
}

for (const version of ['20.19.0', '22.19.0', '22.23.3', '24.0.0', '24.21.0', '24.22.0', '25.9.0', '26.3.0', '26.12.0']) {
  test(`rejects vulnerable Node.js ${version}`, () => assert.equal(nodeVersionSupported(version), false));
}

test('parses v-prefixed release versions', () => assert.deepEqual(parseNodeVersion('v22.23.4'), [22, 23, 4]));
test('rejects unparseable versions', () => assert.throws(() => parseNodeVersion('twenty-two'), /无法解析/));
test('documents the fixed release lines', () => assert.match(NODE_VERSION_GUIDANCE, /22\.23\.4.*24\.22\.1.*26\.12\.1/u));

test('the CLI accepts the security baseline', () => {
  const output = execFileSync(process.execPath, ['scripts/check-node-version.mjs', '22.23.4'], { cwd: repositoryRoot, encoding: 'utf8' });
  assert.match(output, /22\.23\.4/u);
});

test('the CLI fails on a vulnerable runtime', () => {
  assert.throws(
    () => execFileSync(process.execPath, ['scripts/check-node-version.mjs', '22.19.0'], { cwd: repositoryRoot, stdio: 'pipe' }),
    error => error.status === 1,
  );
});
