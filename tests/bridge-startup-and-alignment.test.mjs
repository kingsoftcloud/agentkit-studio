import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callStudioOperation, bridgeNotReady, bridgeStartupTelemetry, resetBridgeStartupTelemetry,
  BRIDGE_STARTUP_RETRY_DELAYS_MS } from '../src/contracts/transport.mjs';
import { alignProfileProductPlugin, comparePluginVersions } from '../src/host/profile-plugin-alignment.mjs';

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

test('alignment mirrors a bundled plugin over an older profile copy', async t => {
  const root = await mkdtemp(join(tmpdir(), 'align-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pkg = async (dir, value, extra = {}) => { await mkdir(dir, { recursive: true }); await writeFile(join(dir, 'package.json'), JSON.stringify({ ...value, ...extra }, null, 2)); };
  const dsh = join(root, 'dsh');
  await pkg(dsh, { name: '@deepseek-ai/dsh', version: '0.2.1-rc.2' });
  await pkg(join(dsh, 'node_modules', PLUGIN), { name: PLUGIN, version: '0.0.10' });
  const profile = join(root, 'home', 'profiles', 'desktop-agentkit-studio');
  await pkg(profile, { name: 'profiles', dependencies: { [PLUGIN]: '0.0.7' } });
  await pkg(join(profile, 'node_modules', PLUGIN), { name: PLUGIN, version: '0.0.7' });
  const pnpm = join(root, 'fake-pnpm.mjs');
  await writeFile(pnpm, 'process.exit(0)\n');
  const argv = [process.execPath, '/host/index.js', dsh, profile, join(root, 'runtime'), pnpm, join(root, 'bin')];
  const log = { info: () => {}, warn: () => {} };

  const result = alignProfileProductPlugin({ argv, env: { DSH_HOME: join(root, 'home') }, node: process.execPath, log });
  assert.equal(result.action, 'aligned');
  assert.equal(result.applied, 'next-launch');
  assert.equal(result.previousVersion, '0.0.7');
  assert.equal(result.bundledVersion, '0.0.10');
  const manifest = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'));
  assert.match(manifest.dependencies[PLUGIN], /^file:.*bundled-plugins/);
  assert.equal(JSON.parse(await readFile(join(profile, 'node_modules', PLUGIN, 'package.json'), 'utf8')).version, '0.0.10');

  assert.equal(alignProfileProductPlugin({ argv, env: { DSH_HOME: join(root, 'home') }, node: process.execPath, log }).action, 'skipped-equal');
  assert.equal(comparePluginVersions('0.0.10', '0.0.7'), 1);
  assert.equal(comparePluginVersions('0.0.7', '0.0.10'), -1);
});

test('alignment leaves a newer profile copy and non-desktop hosts untouched', async t => {
  const root = await mkdtemp(join(tmpdir(), 'align-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pkg = async (dir, value, extra = {}) => { await mkdir(dir, { recursive: true }); await writeFile(join(dir, 'package.json'), JSON.stringify({ ...value, ...extra }, null, 2)); };
  const dsh = join(root, 'dsh');
  await pkg(dsh, { name: '@deepseek-ai/dsh', version: '0.2.1-rc.2' });
  await pkg(join(dsh, 'node_modules', PLUGIN), { name: PLUGIN, version: '0.0.10' });
  const profile = join(root, 'home', 'profiles', 'p');
  await pkg(profile, { name: 'p' });
  await pkg(join(profile, 'node_modules', PLUGIN), { name: PLUGIN, version: '9.9.9' });
  const argv = [process.execPath, '/host/index.js', dsh, profile, join(root, 'runtime'), join(root, 'pnpm.mjs'), join(root, 'bin')];
  const log = { info: () => {}, warn: () => {} };
  assert.equal(alignProfileProductPlugin({ argv, env: { DSH_HOME: join(root, 'home') }, log }).action, 'kept-newer');
  assert.equal(alignProfileProductPlugin({ argv: [process.execPath, '/x.js'], log }).action, 'not-desktop-host');
});
