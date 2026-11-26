import test from 'node:test';
import assert from 'node:assert/strict';
import { createKsxcRoute } from '../src/host/routes/ksxc.mjs';
import { STUDIO_OPERATION_IDS } from '../src/contracts/operations.mjs';
import { installProgressText } from '../src/client/pages/ksxc-settings.mjs';
import { createProductClient } from '../src/remote/control-client.mjs';

const accounts = { status: async () => ({ connected: false }) };

test('status only refreshes the release catalog when the caller asks for it', async () => {
  const seen = [], gatewaySeen = [];
  const route = createKsxcRoute({ accounts, releases: { status: async options => { seen.push(options); return { versions: ['1.8.0'] }; } },
    gatewayStatus: { status: async options => { gatewaySeen.push(options); return { reachable: true, checkedAt: 1 }; } } });
  // Release reads stay cached unless requested; gateway reachability has its own
  // short-lived cache and is shared by the settings, form and runtime catalog.
  const cached = await route('ksxc/status', {}, undefined);
  assert.equal(cached.ok, true);
  assert.deepEqual(cached.value.release.versions, ['1.8.0']);
  assert.deepEqual(seen, [undefined]);
  const refreshed = await route('ksxc/status', { refresh: true }, undefined);
  assert.equal(refreshed.ok, true);
  assert.deepEqual(seen, [undefined, { refresh: true }]);
  assert.deepEqual(gatewaySeen, [{ refresh: false }, { refresh: true }]);
  assert.equal(refreshed.value.gateway.reachable, true);
});

test('only the settings page asks the bridge for a refresh', async () => {
  const calls = [];
  const client = createProductClient({ rpc: { call: async (_channel, operation, payload) => {
    calls.push([operation, payload]);
    return { ok: true, value: { supported: true } };
  } } }, { window: {} });
  await client.ksxcStatus();
  await client.ksxcStatus(undefined, { refresh: false });
  await client.ksxcStatus(new AbortController().signal, { refresh: true });
  await client.ksxcStatus(undefined, { gatewayOnly: true });
  assert.deepEqual(calls, [['ksxc/status', {}], ['ksxc/status', {}], ['ksxc/status', { refresh: true }], ['ksxc/status', { gatewayOnly: true }]]);
});

test('gateway-only polling avoids release and credential reads', async () => {
  let releaseReads = 0, accountReads = 0;
  const route = createKsxcRoute({
    accounts: { status: async () => { accountReads++; return { connected: false }; } },
    releases: { status: async () => { releaseReads++; return {}; } },
    gatewayStatus: { status: async () => ({ reachable: true, checkedAt: 1 }) },
  });
  const result = await route('ksxc/status', { gatewayOnly: true });
  assert.deepEqual(result.value, { supported: true, gateway: { reachable: true, checkedAt: 1 } });
  assert.equal(releaseReads, 0);
  assert.equal(accountReads, 0);
});

test('install endpoints hand the version and the request id to the release service', async () => {
  const calls = [];
  const route = createKsxcRoute({ accounts, releases: {
    startInstall: version => { calls.push(['start', version]); return { requestId: 'job-1' }; },
    installStatus: requestId => { calls.push(['status', requestId]); return { status: 'running', phase: 'download' }; },
  } });
  assert.deepEqual(await route('ksxc/install-start', { version: '1.8.0' }), { ok: true, value: { requestId: 'job-1' } });
  assert.deepEqual(await route('ksxc/install-status', { requestId: 'job-1' }), { ok: true, value: { status: 'running', phase: 'download' } });
  assert.deepEqual(calls, [['start', '1.8.0'], ['status', 'job-1']]);
});

test('an older Host answers that it cannot install instead of failing obscurely', async () => {
  const route = createKsxcRoute({ accounts, releases: { status: async () => ({}) } });
  await assert.rejects(route('ksxc/install-start', { version: '1.8.0' }), { code: 'KSXC_HOST_UNAVAILABLE' });
  await assert.rejects(route('ksxc/install-status', { requestId: 'job-1' }), { code: 'KSXC_HOST_UNAVAILABLE' });
});

test('both install operations are declared on the Studio bridge', () => {
  assert.ok(STUDIO_OPERATION_IDS.includes('ksxc/install-start'));
  assert.ok(STUDIO_OPERATION_IDS.includes('ksxc/install-status'));
});

test('progress text names the phase and the bytes received', () => {
  const megabytes = 1024 * 1024;
  assert.equal(installProgressText({ phase: 'prepare' }, '1.8.0'), '正在准备安装…');
  assert.equal(installProgressText({ phase: 'download', receivedBytes: 50 * megabytes, totalBytes: 170 * megabytes }, '1.8.0'), '正在下载 1.8.0（50 / 170 MB）');
  assert.equal(installProgressText({ phase: 'download', receivedBytes: 50 * megabytes, totalBytes: null, retrying: true }, '1.8.0'), '正在下载 1.8.0（50） · 连接中断，正在重试');
  assert.equal(installProgressText({ phase: 'extract' }, '1.8.0'), '正在解包 1.8.0…');
  assert.equal(installProgressText({ phase: 'probe' }, '1.8.0'), '正在校验 1.8.0…');
});
