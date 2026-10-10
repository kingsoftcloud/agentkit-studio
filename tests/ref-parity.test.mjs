import test from 'node:test';
import assert from 'node:assert/strict';
import { assertParity, parseOptions, resolveRemoteRef } from '../scripts/check-ref-parity.mjs';

test('remote ref parity resolves a full SHA without invoking a shell', () => {
  const calls = [];
  const sha = resolveRemoteRef('origin', 'refs/heads/master', (command, args, options) => {
    calls.push({ command, args, options });
    return `${'a'.repeat(40)}\trefs/heads/master\n`;
  });
  assert.equal(sha, 'a'.repeat(40));
  assert.deepEqual(calls[0].args, ['ls-remote', '--refs', '--exit-code', 'origin', 'refs/heads/master']);
});

test('remote ref parity rejects divergent refs with a no-force-push instruction', () => {
  assert.throws(() => assertParity(
    { remote: 'origin', ref: 'refs/heads/master', sha: 'a'.repeat(40) },
    { remote: 'github', ref: 'refs/heads/main', sha: 'b'.repeat(40) },
  ), /do not force-push/);
});

test('remote ref parity supports explicit forge and branch names', () => {
  assert.deepEqual(parseOptions([
    '--left-remote', 'ezone', '--left-ref', 'refs/heads/master',
    '--right-remote', 'github', '--right-ref', 'refs/heads/main',
  ]), {
    help: false,
    leftRemote: 'ezone',
    leftRef: 'refs/heads/master',
    rightRemote: 'github',
    rightRef: 'refs/heads/main',
  });
});
