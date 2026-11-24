import test from 'node:test';
import assert from 'node:assert/strict';
import { assertParity, parseOptions, resolveRemoteRef } from '../scripts/check-ref-parity.mjs';

const commitA = 'a'.repeat(40);
const commitB = 'b'.repeat(40);
const treeA = 'c'.repeat(40);
const treeB = 'd'.repeat(40);

function fakeRun({ commit = commitA, tree = treeA } = {}) {
  return (command, args, options) => {
    if (args[0] === 'ls-remote') return `${commit}\t${args.at(-1)}\n`;
    if (args[0] === 'fetch') return '';
    if (args[0] === 'rev-parse') return `${tree}\n`;
    throw new Error(`unexpected command ${command} ${args.join(' ')}`);
  };
}

test('remote ref parity resolves commit and tree SHAs without invoking a shell', () => {
  const calls = [];
  const ref = resolveRemoteRef('origin', 'refs/heads/master', (command, args, options) => {
    calls.push({ command, args, options });
    return fakeRun() (command, args, options);
  });
  assert.deepEqual(ref, { sha: commitA, tree: treeA });
  assert.deepEqual(calls.map(call => call.args), [
    ['ls-remote', '--refs', '--exit-code', 'origin', 'refs/heads/master'],
    ['fetch', '--no-tags', '--depth=1', 'origin', 'refs/heads/master'],
    ['rev-parse', 'FETCH_HEAD^{tree}'],
  ]);
});

test('remote tree parity rejects divergent trees with a no-force-push instruction', () => {
  assert.throws(() => assertParity(
    { remote: 'origin', ref: 'refs/heads/master', sha: commitA, tree: treeA },
    { remote: 'github', ref: 'refs/heads/main', sha: commitB, tree: treeB },
  ), /remote tree parity failed[\s\S]*do not force-push/);
});

test('remote tree parity allows independent commit histories with the same tree', () => {
  assert.equal(assertParity(
    { remote: 'origin', ref: 'refs/heads/master', sha: commitA, tree: treeA },
    { remote: 'github', ref: 'refs/heads/main', sha: commitB, tree: treeA },
  ), treeA);
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

test('parity refuses absent, ambiguous, wrong-ref and malformed remote answers', () => {
  for (const output of ['', `${commitA}\trefs/heads/main\n`, `${commitA}\trefs/heads/master\n${commitA}\trefs/heads/master\n`, 'invalid\trefs/heads/master\n']) {
    assert.throws(() => resolveRemoteRef('origin', 'refs/heads/master', () => output), /not found or invalid/);
  }
  assert.throws(() => resolveRemoteRef('origin', 'refs/heads/master', () => { throw new Error('transport contains private data'); }),
    { message: 'unable to read branch ref: origin refs/heads/master' });
  assert.throws(() => resolveRemoteRef('origin', 'refs/heads/master', (command, args) => {
    if (args[0] === 'ls-remote') return `${commitA}\trefs/heads/master\n`;
    throw new Error('tree unavailable');
  }), { message: 'unable to read branch tree: origin refs/heads/master' });
  const unsafeRemote = ['https://user:', 'password@example.test'].join('');
  assert.throws(() => resolveRemoteRef(unsafeRemote, 'refs/heads/master'), /named remote/);
  assert.throws(() => resolveRemoteRef('origin', 'refs/heads/*'), /exact branch ref/);
});
