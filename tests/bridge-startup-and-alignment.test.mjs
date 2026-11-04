import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callStudioOperation, bridgeNotReady, bridgeStartupTelemetry, resetBridgeStartupTelemetry,
  BRIDGE_STARTUP_RETRY_DELAYS_MS } from '../src/contracts/transport.mjs';
import { alignProfileProductPlugin, comparePluginVersions, verifyBundledPlugin } from '../src/host/profile-plugin-alignment.mjs';

const PLUGIN = '@kingsoftcloud/agentkit-studio';
const notReady = () => Object.assign(new Error('transport failure for agentkit/agents/list: HTTP 405'));

test('bridge retries route-not-registered failures and reports readiness', async () => {
  resetBridgeStartupTelemetry();
  let calls = 0;
  const connection = { rpc: { call: async () => { calls += 1; if (calls <= 2) throw notReady(); return { ok: true, value: { items: [] } }; } } };
  const started = Date.now();
  const result = await callStudioOperation(connection, 'agents/list', {});
  const waited = Date.now() - started;
  assert.deepEqual(result, { ok: true, value: { items: [] } });
  assert.equal(calls, 3);
  assert.ok(waited >= BRIDGE_STARTUP_RETRY_DELAYS_MS[0] + BRIDGE_STARTUP_RETRY_DELAYS_MS[1] - 50, `waited ${waited}`);
  const samples = bridgeStartupTelemetry();
  assert.equal(samples.at(-1).outcome, 'ready');
  assert.equal(samples.at(-1).attempts, 2);
});

test('bridge distinguishes business errors from a starting service', async () => {
  resetBridgeStartupTelemetry();
  let calls = 0;
  const business = Object.assign(new Error('部署记录读取失败'), { code: 'DEPLOYMENT_FAILED', status: 400 });
  const connection = { rpc: { call: async () => { calls += 1; throw business; } } };
  await assert.rejects(() => callStudioOperation(connection, 'deployments/list', {}), { message: '部署记录读取失败' });
  assert.equal(calls, 1, 'business errors must not be retried');
  assert.equal(bridgeNotReady(business), false);
  assert.equal(bridgeNotReady(notReady()), true);
});

test('an exhausted bridge reports a readable startup message and telemetry', async () => {
  resetBridgeStartupTelemetry();
  let calls = 0;
  const connection = { rpc: { call: async () => { calls += 1; throw notReady(); } } };
  await assert.rejects(() => callStudioOperation(connection, 'agents/list', {}), { code: 'STUDIO_BRIDGE_STARTING' });
  assert.equal(calls, BRIDGE_STARTUP_RETRY_DELAYS_MS.length + 1);
  assert.equal(bridgeStartupTelemetry().at(-1).outcome, 'exhausted');
});

test('alignment retires an older profile copy so the sealed runtime supplies the plugin', async t => {
  const root = await mkdtemp(join(tmpdir(), 'align-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pkg = async (dir, value, extra = {}) => { await mkdir(dir, { recursive: true }); await writeFile(join(dir, 'package.json'), JSON.stringify({ ...value, ...extra }, null, 2)); };
  const dsh = join(root, 'dsh');
  await pkg(dsh, { name: '@deepseek-ai/dsh', version: '0.2.2-rc.1' });
  await pkg(join(dsh, 'node_modules', '@deepseek-ai', 'dsh-base'), { name: '@deepseek-ai/dsh-base', version: '0.2.2-rc.1' });
  await pkg(join(dsh, 'node_modules', PLUGIN), { name: PLUGIN, version: '0.0.10' }, { dependencies: { '@deepseek-ai/dsh-base': '0.2.2-rc.1' } });
  const profile = join(root, 'home', 'profiles', 'desktop-agentkit-studio');
  await pkg(profile, { name: 'profiles', dependencies: { [PLUGIN]: '0.0.7' } });
  await pkg(join(profile, 'node_modules', PLUGIN), { name: PLUGIN, version: '0.0.7' });
  const argv = [process.execPath, '/host/index.js', dsh, profile, join(root, 'runtime'), join(root, 'pnpm.mjs'), join(root, 'bin')];
  const log = { info: () => {}, warn: () => {} };

  assert.equal(verifyBundledPlugin(dsh, join(dsh, 'node_modules', PLUGIN)), undefined);
  const result = alignProfileProductPlugin({ argv, env: { DSH_HOME: join(root, 'home') }, log });
  assert.equal(result.action, 'retired');
  assert.equal(result.applied, 'next-launch');
  assert.equal(result.previousVersion, '0.0.7');
  assert.equal(result.bundledVersion, '0.0.10');
  const manifest = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'));
  assert.equal(manifest.dependencies[PLUGIN], undefined);
  await assert.rejects(() => readFile(join(profile, 'node_modules', PLUGIN, 'package.json'), 'utf8'));
  assert.equal(JSON.parse(await readFile(join(result.backupPath, 'package.json'), 'utf8')).version, '0.0.7');

  assert.equal(alignProfileProductPlugin({ argv, env: { DSH_HOME: join(root, 'home') }, log }).action, 'skipped-absent');
  assert.equal(comparePluginVersions('0.0.10', '0.0.7'), 1);
  assert.equal(comparePluginVersions('0.0.7', '0.0.10'), -1);
});

test('alignment keeps the old copy and stops after two failures when the bundled copy is incomplete', async t => {
  const root = await mkdtemp(join(tmpdir(), 'align-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pkg = async (dir, value, extra = {}) => { await mkdir(dir, { recursive: true }); await writeFile(join(dir, 'package.json'), JSON.stringify({ ...value, ...extra }, null, 2)); };
  const dsh = join(root, 'dsh');
  await pkg(dsh, { name: '@deepseek-ai/dsh', version: '0.2.2-rc.1' });
  // The mirror this plugin would need is missing the in-box DSH package.
  await pkg(join(dsh, 'node_modules', PLUGIN), { name: PLUGIN, version: '0.0.10' }, { dependencies: { '@deepseek-ai/dsh-base': '0.2.2-rc.1' } });
  const profile = join(root, 'home', 'profiles', 'desktop-agentkit-studio');
  await pkg(profile, { name: 'profiles', dependencies: { [PLUGIN]: '0.0.7' } });
  await pkg(join(profile, 'node_modules', PLUGIN), { name: PLUGIN, version: '0.0.7' });
  const argv = [process.execPath, '/host/index.js', dsh, profile, join(root, 'runtime'), join(root, 'pnpm.mjs'), join(root, 'bin')];
  const log = { info: () => {}, warn: () => {} };
  const env = { DSH_HOME: join(root, 'home') };

  assert.match(verifyBundledPlugin(dsh, join(dsh, 'node_modules', PLUGIN)), /@deepseek-ai\/dsh-base/);
  const first = alignProfileProductPlugin({ argv, env, log });
  assert.equal(first.action, 'restored');
  assert.match(first.reason, /@deepseek-ai\/dsh-base/);
  const manifest = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'));
  assert.equal(manifest.dependencies[PLUGIN], '0.0.7');
  assert.equal(JSON.parse(await readFile(join(profile, 'node_modules', PLUGIN, 'package.json'), 'utf8')).version, '0.0.7');
  assert.equal(JSON.parse(await readFile(join(profile, '.alignment-attempt-0.0.10'), 'utf8')).failures, 1);

  assert.equal(alignProfileProductPlugin({ argv, env, log }).action, 'restored');
  assert.equal(alignProfileProductPlugin({ argv, env, log }).action, 'skipped-attempt-budget');
  assert.equal(JSON.parse(await readFile(join(profile, 'node_modules', PLUGIN, 'package.json'), 'utf8')).version, '0.0.7');
});

test('alignment leaves a newer profile copy and non-desktop hosts untouched', async t => {
  const root = await mkdtemp(join(tmpdir(), 'align-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pkg = async (dir, value, extra = {}) => { await mkdir(dir, { recursive: true }); await writeFile(join(dir, 'package.json'), JSON.stringify({ ...value, ...extra }, null, 2)); };
  const dsh = join(root, 'dsh');
  await pkg(dsh, { name: '@deepseek-ai/dsh', version: '0.2.2-rc.1' });
  await pkg(join(dsh, 'node_modules', PLUGIN), { name: PLUGIN, version: '0.0.10' });
  const profile = join(root, 'home', 'profiles', 'p');
  await pkg(profile, { name: 'p', dependencies: { [PLUGIN]: '9.9.9' } });
  await pkg(join(profile, 'node_modules', PLUGIN), { name: PLUGIN, version: '9.9.9' });
  const argv = [process.execPath, '/host/index.js', dsh, profile, join(root, 'runtime'), join(root, 'pnpm.mjs'), join(root, 'bin')];
  const log = { info: () => {}, warn: () => {} };
  assert.equal(alignProfileProductPlugin({ argv, env: { DSH_HOME: join(root, 'home') }, log }).action, 'kept-newer');
  assert.equal(alignProfileProductPlugin({ argv: [process.execPath, '/x.js'], log }).action, 'not-desktop-host');
});
