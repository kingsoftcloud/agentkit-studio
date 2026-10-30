import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeE2BHostBinding, nativeCommandBackend, prepareNativeE2BHost } from '../src/providers/native-e2b-host.mjs';

const scope = { tenantId: 'tenant', workspaceId: 'workspace', userId: 'user', agentId: 'agent' };
const environment = () => ({ KSADK_SANDBOX_BACKEND: 'e2b', E2B_API_URL: 'https://original.fixture.invalid',
  E2B_DOMAIN: 'fixture.invalid', E2B_API_KEY: 'private-test-credential', KSADK_SANDBOX_TEMPLATE_ID: 'template-A' });
const request = () => ({ scope, sessionId: 'session', runId: 'run', turnId: 'turn', buildId: 'build',
  parentRunId: null, taskChainId: 'chain', operationKey: 'command', executionFence: 7,
  signal: new AbortController().signal, call: { name: 'run_command', callId: 'call', arguments: { command: 'true' } },
  definition: { name: 'run_command' } });
function fixture(t, extra = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'studio-e2b-host-'))), workspaceRoot = join(root, 'workspace');
  mkdirSync(workspaceRoot); t.after(() => rmSync(root, { recursive: true, force: true }));
  const calls = []; let loads = 0;
  const sdk = { Sandbox: {
    async create(template, options) { calls.push({ method: 'create', template, options }); return { sandboxId: 'remote-A' }; },
    async kill(id, options) { calls.push({ method: 'kill', id, options }); return true; },
    async getInfo(id, options) { calls.push({ method: 'getInfo', id, options });
      return { sandboxId: id, state: 'running', metadata: calls.find(call => call.method === 'create').options.metadata }; },
    async connect() { assert.fail('binding construction must not connect to a remote command'); },
  }, CommandExitError: class extends Error {} };
  const options = { env: environment(), scope, sessionId: 'session', workspaceRoot, stateRoot: join(root, 'state'),
    assertAuthority: value => value.executionFence === 7, loadSdk: async () => { loads++; return sdk; }, ...extra };
  return { options, calls, sdk, get loads() { return loads; }, bind: changes => createNativeE2BHostBinding({ ...options, ...changes }) };
}

test('Studio backend selection preserves local default and rejects unsupported explicit selection', () => {
  for (const raw of [undefined, '', 'local', 'LOCAL_PROCESS'])
    assert.equal(nativeCommandBackend({ KSADK_SANDBOX_BACKEND: raw }), 'local_process');
  assert.equal(nativeCommandBackend({ KSADK_SANDBOX_BACKEND: ' E2B ' }), 'e2b');
  for (const raw of ['pod', 'pod_process', 'not-real', 12]) assert.throws(() => nativeCommandBackend({ KSADK_SANDBOX_BACKEND: raw }));
});

test('preset preparation validates synchronously and pins the same connection before asynchronous Session construction', async t => {
  const f = fixture(t), original = structuredClone(f.options.env);
  const prepared = prepareNativeE2BHost({ env: f.options.env, loadSdk: f.options.loadSdk });
  assert.equal(f.loads, 0); assert.equal(prepared.binding.backend, 'e2b');
  assert.equal(JSON.stringify(prepared).includes(original.E2B_API_KEY), false);
  f.options.env.E2B_API_KEY = 'later-key'; f.options.env.KSADK_SANDBOX_TEMPLATE_ID = 'later-template';
  const host = await prepared.forSession(f.options);
  await host.owner.ensure(request());
  assert.equal(f.calls[0].options.apiKey, original.E2B_API_KEY);
  assert.equal(f.calls[0].template, original.KSADK_SANDBOX_TEMPLATE_ID);
  assert.equal(prepared.binding.bindingDigest,
    prepareNativeE2BHost({ env: original }).binding.bindingDigest);
  assert.notEqual(prepared.binding.bindingDigest,
    prepareNativeE2BHost({ env: f.options.env }).binding.bindingDigest);
  for (const change of [{ E2B_API_KEY: '' }, { KSADK_SANDBOX_ALLOW_INTERNET_ACCESS: 'typo' },
    { E2B_API_URL: 'http://wrong.invalid' }]) assert.throws(() => prepareNativeE2BHost({ env: { ...original, ...change } }));
  assert.equal(f.loads, 1);
});

test('bound Host enters the actual SDK lifecycle only after current owner authority and preserves metadata', async t => {
  const f = fixture(t), host = await f.bind();
  assert.deepEqual(f.calls, []); assert.equal(f.loads, 1);
  assert.deepEqual(await host.owner.ensure(request()), { sandboxId: 'remote-A', created: true });
  const created = f.calls[0];
  assert.equal(created.template, 'template-A'); assert.equal(created.options.apiUrl, f.options.env.E2B_API_URL);
  assert.equal(created.options.apiKey, 'private-test-credential');
  assert.equal(created.options.headers['X-Traffic-Source'], 'agentkit');
  assert.equal(created.options.timeoutMs, 900000); assert.equal(created.options.allowInternetAccess, true);
  assert.deepEqual(created.options.envs, {}, 'Host environment and credentials never become sandbox environment');
  assert.equal(created.options.metadata.runtime, 'agentkit'); assert.equal(created.options.metadata.sandbox_type, 'aio');
  assert.equal(created.options.metadata.session_id, 'session');
  assert.match(created.options.metadata.nativeOwner, /^[a-f0-9]{64}$/u);
  assert.match(created.options.metadata.nativeCreateOperation, /^[a-f0-9]{64}$/u);
  assert.equal(JSON.stringify(host).includes('private-test-credential'), false);
  assert.deepEqual(await (await f.bind()).owner.ensure(request()), { sandboxId: 'remote-A', created: false });
  assert.equal(f.calls.length, 1);
});

test('settings are frozen before asynchronous SDK loading and trusted transport options are isolated copies', async t => {
  const f = fixture(t); let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const loading = new Promise(resolve => { release = resolve; });
  const sandboxEnvironment = { TASK: 'fixed' };
  const pending = f.bind({ sandboxEnvironment, loadSdk: async () => { entered(); await loading; return f.sdk; } });
  await started;
  f.options.env.E2B_API_URL = 'https://changed.fixture.invalid';
  f.options.env.E2B_API_KEY = 'changed-private-key'; f.options.env.KSADK_SANDBOX_TEMPLATE_ID = 'changed';
  sandboxEnvironment.TASK = 'changed'; release();
  const host = await pending;
  const opts = host.transportOptions(); opts.connection.apiKey = 'mutated'; opts.connection.headers['X-Traffic-Source'] = 'mutated';
  await host.owner.ensure(request());
  assert.equal(f.calls[0].template, 'template-A'); assert.equal(f.calls[0].options.apiKey, 'private-test-credential');
  assert.equal(f.calls[0].options.apiUrl, 'https://original.fixture.invalid'); assert.equal(f.calls[0].options.envs.TASK, 'fixed');
  assert.equal(host.transportOptions().connection.apiKey, 'private-test-credential');
  assert.equal(host.transportOptions().connection.headers['X-Traffic-Source'], 'agentkit');
});

test('legacy skill runtime fallback settings and sandbox type aliases reach SDK unchanged', async t => {
  const f = fixture(t); delete f.options.env.KSADK_SANDBOX_TEMPLATE_ID;
  Object.assign(f.options.env, { KSADK_SKILL_RUNTIME_TEMPLATE_ID: 'fallback-template', KSADK_SKILL_RUNTIME_TIMEOUT: '42',
    KSADK_SKILL_RUNTIME_ALLOW_INTERNET_ACCESS: 'off', KSADK_SANDBOX_TYPE: ' Code-Interpreter ', KSADK_TRAFFIC_SOURCE: ' studio-test ' });
  const host = await f.bind(); await host.owner.ensure(request());
  assert.equal(f.calls[0].template, 'fallback-template'); assert.equal(f.calls[0].options.timeoutMs, 42000);
  assert.equal(f.calls[0].options.allowInternetAccess, false); assert.equal(f.calls[0].options.metadata.sandbox_type, 'code');
  assert.equal(f.calls[0].options.headers['X-Traffic-Source'], 'studio-test');
});

test('changing endpoint, credentials, template, policy or sandbox environment cannot borrow the old sandbox', async t => {
  const f = fixture(t), original = await f.bind(); await original.owner.ensure(request());
  for (const change of [{ E2B_API_URL: 'https://another.fixture.invalid' }, { E2B_API_KEY: 'another-key' },
    { KSADK_SANDBOX_TEMPLATE_ID: 'another-template' }, { KSADK_SANDBOX_ALLOW_INTERNET_ACCESS: 'false' },
    { KSADK_SANDBOX_TYPE: 'browser' }, { KSADK_TRAFFIC_SOURCE: 'another-source' }]) {
    const changed = await f.bind({ env: { ...f.options.env, ...change } });
    assert.notEqual(changed.binding.bindingDigest, original.binding.bindingDigest);
    await assert.rejects(changed.owner.ensure(request()), { code: 'e2b_owner_binding_changed' });
  }
  const changed = await f.bind({ sandboxEnvironment: { EXTRA: 'different' } });
  await assert.rejects(changed.owner.ensure(request()), { code: 'e2b_owner_binding_changed' });
  assert.equal(f.calls.length, 1);
});

test('stale or asynchronous authority rejects before the SDK has any remote side effect', async t => {
  const f = fixture(t);
  for (const assertAuthority of [() => false, async () => true]) {
    const host = await f.bind({ assertAuthority });
    await assert.rejects(host.owner.ensure(request()), { code: 'e2b_owner_authority_unproven' });
  }
  assert.deepEqual(f.calls, []);
});

test('invalid settings fail before loading SDK or allocating a remote sandbox', async t => {
  const f = fixture(t);
  for (const change of [{ KSADK_SANDBOX_BACKEND: 'local' }, { KSADK_SANDBOX_TEMPLATE_ID: '' },
    { KSADK_SANDBOX_TIMEOUT: '1.5' }, { KSADK_SANDBOX_TIMEOUT: '0' }, { KSADK_SANDBOX_TIMEOUT: '86401' },
    { KSADK_SANDBOX_TYPE: 'unsupported' }, { KSADK_TRAFFIC_SOURCE: 'source\r\nInjected: header' },
    { E2B_API_URL: 'http://wrong.invalid' }, { E2B_API_URL: ['https://user:', 'secret@wrong.invalid'].join('') },
    { E2B_DOMAIN: 'bad/path' }, { E2B_API_KEY: '' }])
    await assert.rejects(f.bind({ env: { ...f.options.env, ...change } }));
  assert.equal(f.loads, 0); assert.deepEqual(f.calls, []);
});

test('late authority loss through the composed lifecycle preserves known sandbox as unknown', async t => {
  const f = fixture(t); let current = true;
  f.sdk.Sandbox.create = async () => { current = false; return { sandboxId: 'late-created' }; };
  const host = await f.bind({ assertAuthority: () => current });
  await assert.rejects(host.owner.ensure(request()), { code: 'e2b_sandbox_outcome_unknown', uncertain: true });
  assert.equal(host.owner.inspect().phase, 'unknown'); assert.equal(host.owner.inspect().sandboxId, 'late-created');
  await assert.rejects(host.owner.ensure(request()), { code: 'e2b_owner_authority_unproven' });
});

test('SDK transport creation shares the same connection without connecting or creating another sandbox', async t => {
  const f = fixture(t), host = await f.bind(), transport = await host.createTransport();
  assert.equal(transport.contract, host.binding.transportContract); assert.match(transport.bindingDigest, /^[a-f0-9]{64}$/u);
  assert.equal(JSON.stringify(transport).includes('private-test-credential'), false); assert.deepEqual(f.calls, []);
});
