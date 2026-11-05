import test from 'node:test';
import assert from 'node:assert/strict';
import * as nodeFs from 'node:fs/promises';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDeploymentStore, unsyncableDirectory } from '../src/deployment-store.mjs';

const plan = { agentId: 'ar-local-0123456789abcdef', buildId: 'build-20261105', bundleId: 'bundle-1', runtime: 'dsh-native',
  environment: 'online', region: 'cn-beijing-6', image: { id: 'release-1' }, resources: { cpu: 2, memoryGiB: 4 } };
const key = 'studio-deploy-11111111-2222-3333-4444-555555555555';
const failure = (code, path) => Object.assign(new Error(`${code}: operation not permitted, fsync`), { code, syscall: 'fsync', path });
// FileHandle methods need their receiver, so wrap the handle rather than faking
// the whole store: only `sync` is selected per path.
function withSync(fs, decide) {
  return { ...fs, async open(target, flags, mode) {
    const handle = await fs.open(target, flags, mode);
    return new Proxy(handle, { get(object, key) {
      const value = Reflect.get(object, key);
      if (key !== 'sync') return typeof value === 'function' ? value.bind(object) : value;
      return async () => { const error = decide(target); if (error) throw error; return value.call(object); };
    } });
  } };
}

test('deployment intent is durable, idempotent and readable after restart', async t => {
  const storeDir = await mkdtemp(join(tmpdir(), 'deployment-store-'));
  t.after(() => rm(storeDir, { recursive: true, force: true }));
  const store = createDeploymentStore({ storeDir });
  const first = await store.create(plan, key);
  assert.equal(first.created, true);
  assert.equal(first.record.state, 'PREPARED');
  const replay = await store.create(plan, key);
  assert.equal(replay.created, false);
  assert.equal(replay.record.id, first.record.id);
  await assert.rejects(store.create({ ...plan, buildId: 'other' }, key), { code: 'DEPLOYMENT_IDEMPOTENCY_CONFLICT' });
  const restarted = createDeploymentStore({ storeDir });
  assert.deepEqual((await restarted.get(first.record.id)).plan, plan);
  assert.equal((await restarted.list()).length, 1);
  assert.equal((await restarted.claim(first.record.id, 'create')), true);
  assert.equal((await restarted.claim(first.record.id, 'create')), false);
});

test('a filesystem that refuses directory fsync still records the deployment', async t => {
  const storeDir = await mkdtemp(join(tmpdir(), 'deployment-store-'));
  t.after(() => rm(storeDir, { recursive: true, force: true }));
  const store = createDeploymentStore({ storeDir, fs: withSync(nodeFs, target => target === storeDir ? failure('EPERM', storeDir) : null) });
  const { record, created } = await store.create(plan, key);
  assert.equal(created, true);
  assert.equal((await store.get(record.id)).state, 'PREPARED');
  const updated = await store.update(record.id, { state: 'UPLOADING' });
  assert.equal(updated.state, 'UPLOADING');
  assert.deepEqual(JSON.parse(await readFile(join(storeDir, `${record.id}.json`), 'utf8')).events.map(item => item.state), ['PREPARED', 'UPLOADING']);
});

test('a filesystem that refuses the record fsync reports an actionable local storage error', async t => {
  const storeDir = await mkdtemp(join(tmpdir(), 'deployment-store-'));
  t.after(() => rm(storeDir, { recursive: true, force: true }));
  const store = createDeploymentStore({ storeDir, fs: withSync(nodeFs, target => failure('EPERM', target)) });
  await assert.rejects(store.create(plan, key), error => error.code === 'DEPLOYMENT_STORE_IO_FAILED'
    && /fsync EPERM/.test(error.message) && /AGENTKIT_HOME/.test(error.message) && error.message.includes(storeDir));
});

test('an unwritable record directory names the local path instead of leaking a raw errno', async t => {
  const storeDir = await mkdtemp(join(tmpdir(), 'deployment-store-'));
  t.after(() => rm(storeDir, { recursive: true, force: true }));
  const fs = { ...nodeFs, async open() { throw Object.assign(new Error('EACCES: permission denied, open'), { code: 'EACCES', syscall: 'open', path: join(storeDir, 'dep_x.json') }); } };
  const store = createDeploymentStore({ storeDir, fs });
  await assert.rejects(store.create(plan, key), error => error.code === 'DEPLOYMENT_STORE_IO_FAILED' && /open EACCES/.test(error.message));
});

test('the read-only preview preflights the receipt disk before the user commits', async t => {
  const storeDir = await mkdtemp(join(tmpdir(), 'deployment-store-'));
  t.after(() => rm(storeDir, { recursive: true, force: true }));
  await createDeploymentStore({ storeDir }).preflight();
  // A filesystem without directory fsync is still usable: the preview passes.
  await createDeploymentStore({ storeDir, fs: withSync(nodeFs, target => target === storeDir ? failure('EPERM', storeDir) : null) }).preflight();
  // A filesystem that cannot flush the record is reported at 检查部署, not at 确认.
  await assert.rejects(createDeploymentStore({ storeDir, fs: withSync(nodeFs, target => failure('EINVAL', target)) }).preflight(),
    { code: 'DEPLOYMENT_STORE_IO_FAILED' });
  assert.deepEqual((await nodeFs.readdir(storeDir)).filter(name => name.startsWith('.preflight-')), []);
});

test('a corrupt record stays a corrupt record and unsupported sync codes are classified', async t => {
  const storeDir = await mkdtemp(join(tmpdir(), 'deployment-store-'));
  t.after(() => rm(storeDir, { recursive: true, force: true }));
  const store = createDeploymentStore({ storeDir });
  const { record } = await store.create(plan, key);
  await writeFile(join(storeDir, `${record.id}.json`), '{"format":"other"}');
  await assert.rejects(store.get(record.id), { code: 'DEPLOYMENT_RECORD_CORRUPT' });
  for (const code of ['EPERM', 'EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS']) assert.equal(unsyncableDirectory({ code }), true);
  for (const code of ['EACCES', 'EROFS', 'ENOSPC', 'EBADF', 'EIO', undefined]) assert.equal(unsyncableDirectory({ code }), false);
});
