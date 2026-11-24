import assert from 'node:assert/strict';
import { chmodSync, linkSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { atomicPrivate, lockUntil, privateDirectory, readAll, tryLock } from '../src/host/private-state.mjs';

test('Studio preserves private file and lock semantics outside the Harness package', { skip: process.platform === 'win32' }, async t => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'studio-private-state-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, 'nested', 'state');
  privateDirectory(directory, true);
  const file = join(directory, 'data');
  writeFileSync(file, 'earlier host data', { mode: 0o600 });
  assert.equal(readAll(file), 'earlier host data');
  atomicPrivate(file, 'updated host data');
  assert.equal(readAll(file), 'updated host data');

  const hardlink = join(directory, 'hardlink');
  linkSync(file, hardlink);
  assert.throws(() => readAll(file), { code: 'background_state_not_private' });
  rmSync(hardlink);
  chmodSync(file, 0o640);
  assert.throws(() => atomicPrivate(file, 'unsafe replacement'), { code: 'background_state_not_private' });
  chmodSync(file, 0o600);
  const alias = join(root, 'alias');
  symlinkSync(directory, alias);
  assert.throws(() => readAll(join(alias, 'data')), { code: 'background_state_symlink' });

  const lock = join(directory, 'lock.sqlite');
  const release = tryLock(lock);
  assert.equal(typeof release, 'function');
  try {
    assert.equal(tryLock(lock), null);
    await assert.rejects(lockUntil(lock, performance.now()), { code: 'background_command_lock_timeout' });
  } finally {
    release();
  }
  const reacquired = await lockUntil(lock, performance.now() + 1000);
  reacquired();
  assert.equal(readAll(file), 'updated host data');
});
