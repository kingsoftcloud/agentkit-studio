import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('atomic command publication retries replaced read inodes without admitting writes, hardlinks or public files', t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'native-publication-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // Fault injection models lstat observing a zero-link inode at the atomic
  // rename boundary. The replacement and all bytes/permissions are real.
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    import assert from 'node:assert/strict';
    import { join } from 'node:path';
    import { syncBuiltinESMExports } from 'node:module';
    const root = process.argv[1], moduleUrl = process.argv[2], original = fs.lstatSync;
    let selected, visits = 0;
    fs.lstatSync = (path, ...args) => {
      const stat = original(path, ...args);
      if (path === selected && ++visits === 2) {
        fs.renameSync(selected + '.next', selected);
        stat.nlink = 0;
      }
      return stat;
    };
    syncBuiltinESMExports();
    const { openPrivate } = await import(moduleUrl);
    for (const [mode, flags] of [['read', fs.constants.O_RDONLY], ['write', fs.constants.O_WRONLY]]) {
      const path = join(root, mode);
      fs.writeFileSync(path, 'old', { mode: 0o600 });
      fs.writeFileSync(path + '.next', 'new', { mode: 0o600 });
      selected = path; visits = 0;
      if (mode === 'write') assert.throws(() => openPrivate(path, flags), { code: 'background_state_changed' });
      else {
        const fd = openPrivate(path, flags);
        try { assert.equal(fs.readFileSync(fd, 'utf8'), 'new'); } finally { fs.closeSync(fd); }
        assert.ok(visits >= 4, 'the replacement must be checked again');
      }
      assert.equal(fs.readFileSync(path, 'utf8'), 'new');
    }
    selected = undefined;
    const path = join(root, 'read'), alias = join(root, 'alias');
    fs.linkSync(path, alias);
    assert.throws(() => openPrivate(path, fs.constants.O_RDONLY), { code: 'background_state_not_private' });
    fs.unlinkSync(alias); fs.chmodSync(path, 0o644);
    assert.throws(() => openPrivate(path, fs.constants.O_RDONLY), { code: 'background_state_not_private' });
  `, root, new URL('../src/native/local-command-state.mjs', import.meta.url).href],
  { encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 0, child.stderr);
});
