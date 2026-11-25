import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKsxcHost } from '../src/host/services/ksxc.mjs';
import { createKsxcRoute } from '../src/host/routes/ksxc.mjs';

const shipped = JSON.parse(await readFile(new URL('../src/host/services/ksxc-company.json', import.meta.url), 'utf8'));
const managedRuntime = { identity: { runtimeName: 'ksxc' } };

test('the shipped company config names the public gateway, the company and a public installer', () => {
  assert.deepEqual(Object.keys(shipped).sort(), ['baseUrl', 'code', 'installerUrl']);
  assert.match(shipped.baseUrl, /^https?:\/\/[a-z0-9.-]+\.ksyun\.com$/);
  assert.match(shipped.installerUrl, /^https:\/\/ks3-cn-beijing\.ksyuncs\.com\//);
});

test('a desktop Host with no environment still gets KSXC from the shipped config', async t => {
  const storeDir = await realpath(await mkdtemp(join(tmpdir(), 'ksxc-company-')));
  t.after(() => rm(storeDir, { force: true, recursive: true }));
  const ksxc = await createKsxcHost({ storeDir, env: {}, credentials: {} });
  assert.ok(ksxc, 'the desktop Host must be configured without any export');
  const status = await ksxc.releases.status();
  assert.equal(status.installable, true);
  assert.ok(ksxc.accounts, 'the desktop account service must be available');
  assert.equal(ksxc.managedConnection, undefined, 'the shipped config must not leak into the managed connection');
});

test('the settings status is served for a desktop Host with no environment', async t => {
  const storeDir = await realpath(await mkdtemp(join(tmpdir(), 'ksxc-company-')));
  t.after(() => rm(storeDir, { force: true, recursive: true }));
  const ksxc = await createKsxcHost({ storeDir, env: {}, credentials: { readRecord: async () => null } });
  const result = await createKsxcRoute(ksxc)('ksxc/status', {});
  assert.equal(result.value.supported, true);
  assert.equal(result.value.release.installable, true);
  // The bundled account is not connected until the user signs in.
  assert.equal(result.value.connection.connected, false);
  await ksxc.accounts.close();
});

test('an explicit company config path wins over the shipped one', async t => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'ksxc-company-')));
  t.after(() => rm(dir, { force: true, recursive: true }));
  // A missing explicit path must fail instead of silently falling back.
  assert.equal(await createKsxcHost({ storeDir: dir, env: { AGENTKIT_KSXC_COMPANY_CONFIG_PATH: join(dir, 'missing.json') }, credentials: {} }), null);
});

test('the shipped config is only a desktop default', async t => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'ksxc-company-')));
  t.after(() => rm(dir, { force: true, recursive: true }));
  assert.equal(await createKsxcHost({ storeDir: dir, env: {}, credentials: {}, portableRuntime: {} }), null);
  await assert.rejects(createKsxcHost({ storeDir: dir, env: {}, credentials: {}, managedRuntime, managedResourceContext: {} }),
    { code: 'KSXC_HOST_UNAVAILABLE' });
  assert.equal(await createKsxcHost({ storeDir: dir, env: {}, credentials: {}, defaultCompanyConfig: '' }), null);
});

test('a plain HTTP gateway chosen by the operator still needs the explicit opt-in', async t => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'ksxc-company-')));
  t.after(() => rm(dir, { force: true, recursive: true }));
  const companyConfigPath = join(dir, 'company.json');
  await writeFile(companyConfigPath, JSON.stringify({ ...shipped, baseUrl: 'http://gateway.example.test' }));
  const env = { AGENTKIT_KSXC_COMPANY_CONFIG_PATH: companyConfigPath };
  assert.equal(await createKsxcHost({ storeDir: dir, env, credentials: {} }), null);
  assert.ok(await createKsxcHost({ storeDir: dir, env: { ...env, AGENTKIT_KSXC_ALLOW_HTTP: '1' }, credentials: {} }));
});
