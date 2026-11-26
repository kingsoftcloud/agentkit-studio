import test from 'node:test';
import assert from 'node:assert/strict';
import { createKsxcGatewayStatus } from '../src/host/services/ksxc-gateway.mjs';
import { installKsxcVisibility } from '../src/client/dsh/ksxc-visibility.mjs';

const companyConfig = { baseUrl: 'http://mgw.proxy.ksyun.com', code: 'kc' };
const response = status => ({ status, body: null });
const flush = async () => { for (let index = 0; index < 10; index++) await Promise.resolve(); };

test('gateway probing uses an unauthenticated model-catalog HEAD and accepts HTTP auth responses', async () => {
  const calls = [];
  const gateway = createKsxcGatewayStatus({ companyConfig, now: () => 123, fetchImpl: async (url, options) => {
    calls.push({ url: String(url), options });
    return response(401);
  } });
  assert.deepEqual(await gateway.status(), { reachable: true, checkedAt: 123 });
  assert.deepEqual(await gateway.status(), { reachable: true, checkedAt: 123 });
  assert.equal(calls.length, 1, 'the immediate second read uses the cached probe');
  assert.equal(calls[0].url, 'http://mgw.proxy.ksyun.com/cli/models');
  assert.equal(calls[0].options.method, 'HEAD');
  assert.equal(calls[0].options.redirect, 'manual');
  assert.equal(calls[0].options.headers['X-KSC-COMPANY-CODE'], 'kc');
  assert.equal(calls[0].options.headers.Authorization, undefined);
});

test('gateway probing reports network failures and refreshes after the cache expires', async () => {
  let now = 100;
  let calls = 0;
  const gateway = createKsxcGatewayStatus({ companyConfig, now: () => now, cacheMs: 10, fetchImpl: async () => {
    calls++;
    if (calls === 1) throw new Error('connect ETIMEDOUT');
    return response(405);
  } });
  assert.deepEqual(await gateway.status(), { reachable: false, checkedAt: 100 });
  now += 11;
  assert.deepEqual(await gateway.status(), { reachable: true, checkedAt: 111 });
  assert.equal(calls, 2);
});

test('settings stay hidden during the first probe and register or unregister as reachability changes', async () => {
  let current = { supported: true, gateway: { reachable: false } };
  let poll;
  const statusOptions = [];
  const registered = [], removed = [], events = [];
  const ctx = { slots: {
    inject(_name, register) { const entry = register(); registered.push(entry.id); return () => removed.push(entry.id); },
    register(options) { return options; },
  } };
  const window = {
    setInterval(callback) { poll = callback; return 1; },
    clearInterval() {},
    dispatchEvent(event) { events.push(event.type); },
  };
  const dispose = installKsxcVisibility({ ctx, window, CustomEvent: class { constructor(type) { this.type = type; } },
    hostRemote: { ksxcStatus: async (_signal, options) => { statusOptions.push(options); return current; } }, render: () => null });
  assert.deepEqual(registered, [], 'KSXC must not flash before the first result');
  await flush();
  assert.deepEqual(registered, []);

  current = { supported: true, gateway: { reachable: true } };
  poll(); await flush();
  assert.deepEqual(registered, ['agentkit-ksxc']);
  assert.deepEqual(events, ['agentkit-studio:ksxc-changed']);

  current = { supported: true, gateway: { reachable: false } };
  poll(); await flush();
  assert.deepEqual(removed, ['agentkit-ksxc']);
  assert.deepEqual(events, ['agentkit-studio:ksxc-changed', 'agentkit-studio:ksxc-changed']);
  assert.ok(statusOptions.every(options => options?.gatewayOnly === true));
  dispose();
});
