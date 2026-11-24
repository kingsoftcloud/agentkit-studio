import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startInstalledStarHarness } from '../src/installed-star-harness.mjs';

async function fixture(t, methods = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'studio-release-selection-')));
  t.after(() => rm(root, { force: true, recursive: true }));
  const stateDir = join(root, 'state'), directory = join(root, 'star-harness-releases'), calls = [];
  const releases = {
    async latest() { calls.push(['latest']); return '0.0.31'; },
    async install(version) { calls.push(['install', version]); return join(directory, version); },
    async entry() { assert.fail('Only preinstalled releases may be opened'); },
    ...methods,
  };
  const launch = (options, start = async worker => worker) => startInstalledStarHarness({ stateDir, ...options }, {
    createReleases(config) { assert.equal(config.directory, directory); return releases; }, start,
  });
  return { launch, directory, calls, selection: () => readFile(join(directory, 'selected-release.json'), 'utf8').then(JSON.parse) };
}

test('first launch records the verified release and restart keeps it without refreshing the registry', async t => {
  const f = await fixture(t);
  assert.equal((await f.launch()).version, '0.0.31');
  assert.deepEqual(await f.selection(), { version: '0.0.31' });
  assert.equal((await f.launch()).version, '0.0.31');
  assert.deepEqual(f.calls, [['latest'], ['install', '0.0.31'], ['install', '0.0.31']]);
});

test('offline migration adopts the newest verifiable preinstalled release', async t => {
  const checked = [];
  const f = await fixture(t, {
    async latest() { assert.fail('Offline startup must not refresh the registry'); },
    async entry(version) {
      checked.push(version);
      if (version === '0.0.32') throw Object.assign(Error('invalid release'), { code: 'STAR_HARNESS_RELEASE_INVALID' });
      return '/signed-release/' + version;
    },
  });
  for (const version of ['0.0.9', '0.0.31', '0.0.32']) await mkdir(join(f.directory, version), { recursive: true, mode: 0o700 });
  assert.equal((await f.launch()).packageDirectory, '/signed-release/0.0.31');
  assert.deepEqual(await f.selection(), { version: '0.0.31' });
  assert.deepEqual(checked, ['0.0.32', '0.0.31']);
  assert.deepEqual(f.calls, []);
});

test('a failed explicit release switch leaves the prior selection available', async t => {
  const f = await fixture(t);
  await f.launch({ releaseVersion: '0.0.31' });
  await assert.rejects(f.launch({ releaseVersion: '0.0.32' }, async () => { throw Error('handshake failed'); }), /handshake failed/);
  assert.equal((await f.launch()).version, '0.0.31');
  assert.deepEqual(await f.selection(), { version: '0.0.31' });
});

test('an empty offline deployment reports that a signed release must be provisioned', async t => {
  const f = await fixture(t, { async latest() { throw Error('registry offline'); } });
  await assert.rejects(f.launch(), { code: 'STAR_HARNESS_RELEASE_UNAVAILABLE' });
  await assert.rejects(f.selection(), { code: 'ENOENT' });
  assert.deepEqual(f.calls, []);
});
