import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createKsxcRuntime } from '../src/providers/ksxc-runtime.mjs';
import { createKsxcAccounts } from '../src/host/services/ksxc-accounts.mjs';
import { ksxcAgentPreference } from '../src/host/services/ksxc.mjs';
import { createManagedKsxcConnectionClient } from '../src/host/services/ksxc-connection-client.mjs';

async function fixture(t, { returnedModel, returnedProvider = 'ksxc', onTurn, beforeExit } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'studio-ksxc-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const companyConfigPath = join(root, 'company.json');
  await writeFile(companyConfigPath, JSON.stringify({
    baseUrl: 'https://company.example', code: 'fixture', installerUrl: 'https://company.example/install',
    token: 'discarded-config-field',
  }));
  const events = [], children = [];
  const runtime = createKsxcRuntime({
    commandFor: async () => ({ executable: '/fixture/ksxc', prefixArgs: [], version: '1.8.0',
      validate: async () => ({ integrityVerified: true, sha256: 'a'.repeat(64) }) }),
    connectionFor: async ({ userId }) => ({ accountId: userId, token: userId }),
    stateRoot: join(root, 'state'), companyConfigPath,
    env: { PATH: '/usr/bin', KSXC_AUTH_TOKEN: 'ambient-key', OTHER_SECRET: 'ambient-key' },
    spawnImpl(executable, args, options) {
      assert.equal(executable, '/fixture/ksxc');
      assert.ok(args.includes('shell_environment_policy.inherit="none"'));
      if (process.platform !== 'win32') assert.ok(args.includes('shell_environment_policy.set.PATH="/usr/bin:/bin:/usr/sbin:/sbin"'));
      assert.equal(options.env.OTHER_SECRET, undefined);
      assert.notEqual(options.env.KSXC_AUTH_TOKEN, 'ambient-key');
      children.push(options.env);
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      const emit = value => child.stdout.write(JSON.stringify(value) + '\n');
      child.stdin = new Writable({
        write(data, _encoding, done) {
          const request = JSON.parse(data);
          events.push(request);
          const respond = result => emit({ id: request.id, result });
          if (request.method === 'initialize') respond({ userAgent: 'fixture' });
          if (request.method === 'model/list') {
            respond(request.params.cursor
              ? { data: [{ model: options.env.KSXC_AUTH_TOKEN + '-other' }], nextCursor: null }
              : { data: [{ model: options.env.KSXC_AUTH_TOKEN }], nextCursor: 'page-2' });
          }
          if (request.method === 'thread/start') respond({ thread: { id: 'thread' },
            model: returnedModel ?? request.params.model, modelProvider: returnedProvider });
          if (request.method === 'turn/start') {
            respond({ turn: { id: 'turn' } });
            setImmediate(() => onTurn?.(emit));
          }
          done();
        },
      });
      child.kill = () => {
        const exit = () => { child.stdout.end(); child.emit('exit', 0); };
        if (beforeExit) void beforeExit(options.env.KSXC_HOME).finally(exit);
        else exit();
      };
      return child;
    },
  });
  return { runtime, events, children, root };
}

for (const wrong of [{ returnedModel: 'other' }, { returnedProvider: 'codex' }, { returnedProvider: null }]) {
  test(`model identity mismatch before user input ${JSON.stringify(wrong)}`, async t => {
    const { runtime, events, children } = await fixture(t, wrong);
    await assert.rejects(Array.fromAsync(runtime.stream({ userId: 'alice', model: 'alice', input: 'private-user-text',
      onRuntimeVerified: () => assert.fail('A mismatched provider or model cannot be attested'),
    })), { code: 'KSXC_MODEL_MISMATCH' });
    assert.equal(events.some(event => event.method === 'turn/start' || JSON.stringify(event).includes('private-user-text')), false);
    assert.equal(children[0].CODEX_HOME, children[0].KSXC_HOME);
    await assert.rejects(readFile(join(children[0].KSXC_HOME, 'config.json')), { code: 'ENOENT' });
  });
}

test('concurrent model lists use separate connections and paginate each catalog', async t => {
  const { runtime, events, children } = await fixture(t);
  const [a, b] = await Promise.all(['a', 'b'].map(userId => runtime.listModels({ userId })));
  assert.deepEqual([a.map(model => model.id), b.map(model => model.id)], [['a', 'a-other'], ['b', 'b-other']]);
  assert.notEqual(children[0].KSXC_HOME, children[1].KSXC_HOME);
  await assert.rejects(Array.fromAsync(runtime.stream({ model: 'a', userId: 'b', input: 'hello' })), { code: 'KSXC_MODEL_FORBIDDEN' });
  assert.equal(events.some(event => event.method === 'thread/start'), false);
  await assert.rejects(Array.fromAsync(runtime.stream({ model: 'a', userId: 'a', modelProvider: {}, input: 'hello' })), { code: 'KSXC_MODEL_INVALID' });
});

test('KSXC attests its verified binary and effective model before sending the user turn', async t => {
  const { runtime, events } = await fixture(t, { onTurn(emit) {
    emit({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn', status: 'completed' } } });
  } });
  const identities = [];
  await Array.fromAsync(runtime.stream({ userId: 'a', model: 'a', input: 'hello', onRuntimeVerified(identity) {
    assert.equal(events.some(event => event.method === 'turn/start'), false);
    identities.push(identity);
  } }));
  assert.deepEqual(identities, [{ runtime: 'ksxc', provider: 'ksxc', model: 'a', binarySha256: 'a'.repeat(64), version: '1.8.0' }]);
  assert.match(events.find(event => event.method === 'thread/start').params.developerInstructions, /实际工具结果/);
});

test('KSXC keeps its isolated home until the app server has exited', async t => {
  let config;
  const { runtime, children } = await fixture(t, { beforeExit: async home => {
    await delay(40);
    config = await readFile(join(home, 'config.json'), 'utf8').catch(() => undefined);
  } });
  await runtime.listModels({ userId: 'a' });
  assert.equal(JSON.parse(config).code, 'fixture');
  await assert.rejects(readFile(join(children[0].KSXC_HOME, 'config.json')), { code: 'ENOENT' });
});

test('duplicate bound-tool protocol requests execute once and cancellation interrupts the turn', async t => {
  const controller = new AbortController();
  const { runtime, events } = await fixture(t, {
    onTurn(emit) {
      const params = { threadId: 'thread', turnId: 'turn', callId: 'same-tool', tool: 'studio_mcp_test', arguments: {} };
      emit({ id: 91, method: 'item/tool/call', params });
      emit({ id: 92, method: 'item/tool/call', params });
    },
  });
  let invocations = 0;
  const stream = runtime.stream({ userId: 'a', model: 'a', input: 'hello', signal: controller.signal,
    toolHandler: async () => { invocations++; return 'done'; },
  });
  const started = await stream.next();
  assert.equal(started.value.phase, 'started');
  const completed = await stream.next();
  assert.equal(completed.value.phase, 'completed');
  assert.equal(invocations, 1);
  controller.abort();
  await assert.rejects(stream.next(), { code: 'KSXC_CANCELED' });
  assert.ok(events.some(event => event.method === 'turn/interrupt'));
});

test('WPS poll completion is scoped to the user and disconnect cannot be undone by a late result', async () => {
  const records = new Map();
  let nextAttempt = 0, finish;
  const accounts = createKsxcAccounts({
    credentials: {
      readRecord: async key => records.get(key),
      modifyRecord: async (key, modify) => records.set(key, await modify(records.get(key))),
      deleteRecord: async key => records.delete(key),
    },
    companyConfig: { code: 'c', baseUrl: 'https://company.example' },
    gateway: new URL('https://company.example'),
    fetchImpl: async url => {
      if (url.pathname.endsWith('/url')) {
        assert.equal(url.searchParams.get('companyCode'), 'c');
        return Response.json({ code: 200, data: { loginUrl: 'https://openapi.wps.cn/oauth2/auth', loginUUID: `private-${++nextAttempt}` } });
      }
      const uuid = url.searchParams.get('loginUUID');
      if (uuid === 'private-1') return Response.json({ code: 200, data: { status: 'pending' } });
      const grant = Response.json({ code: 200, data: { status: 'success', sk: 'fixture-secret',
        userInfo: { id: 7, userName: 'Fixture', companyCode: 'c', source: 'wps', status: 'active', baseApi: 'https://untrusted.example' } } });
      if (uuid === 'private-3') return new Promise(resolve => { finish = () => resolve(grant); });
      return grant;
    },
  });
  try {
    const a = await accounts.begin({ userId: 'a' });
    const b = await accounts.begin({ userId: 'b' });
    assert.equal(JSON.stringify(a).includes('private-1'), false);
    assert.deepEqual(await accounts.poll({ userId: 'a', id: a.id }), { status: 'pending' });
    await assert.rejects(accounts.poll({ userId: 'a', id: b.id }), { code: 'KSXC_LOGIN_EXPIRED' });
    const success = await accounts.poll({ userId: 'b', id: b.id });
    assert.deepEqual(success, { status: 'connected', connection: { connected: true, companyCode: 'c', account: 'Fixture' } });
    assert.equal(await accounts.connection({ userId: 'a' }), null);
    const replacement = await accounts.begin({ userId: 'b' });
    const inFlight = accounts.poll({ userId: 'b', id: replacement.id });
    await accounts.disconnect({ userId: 'b' });
    finish();
    await assert.rejects(inFlight, { code: 'KSXC_LOGIN_EXPIRED' });
    assert.equal(await accounts.connection({ userId: 'b' }), null);
  } finally { accounts.close(); }
});

test('KSXC Agent configuration holds only a catalog preference', () => {
  const spec = { runtime: { type: 'ksxc' }, bindings: { modelProfileId: 'allowed' } };
  assert.equal(ksxcAgentPreference(spec), 'allowed');
  for (const forged of [{ ...spec, runtime: { type: 'ksxc', endpoint: 'https://example.test' } },
    { ...spec, apiKey: 'fixture-key' }, { ...spec, bindings: { ...spec.bindings, modelProfileIds: ['other'] } }]) {
    assert.throws(() => ksxcAgentPreference(forged), { code: 'KSXC_MODEL_INVALID' });
  }
});

test('managed credential hop binds the request and response to the authenticated caller', async () => {
  const cacheRoot = await mkdtemp(join(tmpdir(), 'studio-ksxc-managed-cache-'));
  try {
  const userId = 'aeu_' + 'a'.repeat(64);
  const token = 'a'.repeat(32);
  const env = { AGENTENGINE_RESOURCE_SERVER_URL: 'https://private.example', AGENTKIT_RUNTIME_TOKEN: token };
  let company = 'fixture', stale = false, calls = 0;
  const getConnection = createManagedKsxcConnectionClient({
    identity: { agentId: 'ar-test', versionId: 'v-test', manifestSha256: 'd'.repeat(64) },
    companyConfig: { code: 'fixture' }, env, stateRoot: cacheRoot,
    getCallerPermit: caller => caller === userId ? 'fixture-signed-permit' : undefined,
    fetchImpl: async (url, init) => {
      calls++;
      assert.equal(url.origin, 'https://private.example');
      assert.equal(url.pathname, '/agentengine/internal/v1/dsh/agents/ar-test/ksxc/connection');
      assert.equal(init.method, 'POST');
      assert.equal(init.redirect, 'error');
      assert.equal(init.body, undefined);
      assert.deepEqual(init.headers, { authorization: 'Bearer ' + token, 'x-agentengine-target-version-id': 'v-test',
        'x-agentengine-manifest-sha256': 'd'.repeat(64), 'x-agentengine-resource-permit': 'fixture-signed-permit' });
      if (stale) return Response.json({ detail: 'KSXC_CALLER_PERMIT_STALE' }, { status: 403 });
      return Response.json({ Code: 0, Data: { CompanyCode: company, Environment: 'pre',
        ConnectionRef: 'b'.repeat(64), AuthToken: 'c'.repeat(32) } });
    },
  });
  await assert.rejects(getConnection({ userId: 'claimed-by-client' }), { code: 'KSXC_CALLER_REQUIRED' });
  await assert.rejects(getConnection({ userId: 'aeu_' + 'e'.repeat(64) }), { code: 'KSXC_CALLER_PERMIT_REQUIRED' });
  assert.equal(calls, 0);
  assert.equal((await getConnection({ userId })).accountId, 'pre:' + 'b'.repeat(64));
  assert.equal((await getConnection({ userId })).accountId, 'pre:' + 'b'.repeat(64));
  assert.equal(calls, 1, 'a valid managed connection is reused from the PVC cache');
  const cacheFiles = await readdir(join(cacheRoot, 'connections'));
  assert.equal(cacheFiles.length, 1);
  assert.equal((await readFile(join(cacheRoot, 'connections', cacheFiles[0]), 'utf8')).includes('c'.repeat(32)), false,
    'the persisted managed credential is encrypted at rest');
  await getConnection.clear(userId);
  company = 'foreign';
  await assert.rejects(getConnection({ userId }), { code: 'KSXC_CONNECTION_SERVICE_UNAVAILABLE' });
  stale = true;
  await assert.rejects(getConnection({ userId }), { code: 'KSXC_CALLER_PERMIT_STALE' });
  } finally {
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test('a KSXC business tool namespace uses the bound MCP target and requires approval', async () => {
  const { createCodexResourceContext } = await import('../src/providers/codex-resource-context.mjs');
  const record = { spec: { runtime: { type: 'ksxc' }, bindings: { mcpServers: ['resource'] } } };
  const effects = [];
  const build = createCodexResourceContext({
    agentStore: { get: async () => record },
    builds: {},
    resources: {
      listMcpTools: async () => [{ name: 'exec_command' }],
      callMcpTool: async (...args) => { effects.push(args); return 'applied'; },
    },
  });
  let decision = 'rejected';
  const context = await build({ runtime: 'ksxc', agentId: 'agent', userId: 'authoritative-user', sessionId: 'session',
    authorizeTool: async () => decision,
  });
  assert.equal(context.dynamicTools[0].name, 'studio_mcp_exec_command');
  await assert.rejects(context.toolHandler({ name: 'find_files', arguments: {} }), {
    code: 'BOUND_TOOL_NOT_FOUND', message: /^KSXC .*未绑定，未执行/,
  });
  const call = { name: context.dynamicTools[0].name, arguments: { hello: 'world' }, callId: 'call' };
  await assert.rejects(context.toolHandler(call), { code: 'KSXC_TOOL_NOT_APPROVED' });
  assert.equal(effects.length, 0);
  decision = 'allowed-once';
  assert.equal(await context.toolHandler(call), 'applied');
  assert.equal(effects.length, 1);
  const [binding, tool, , { invocation }] = effects[0];
  assert.equal(binding, 'resource');
  assert.equal(tool, 'exec_command');
  assert.equal(invocation.userId, 'authoritative-user');
});

test('DSH model adapters preserve the base contract and scope managed selection to one verified request', async t => {
  const { createKsxcModelAdapter } = await import('../src/providers/ksxc-runtime.mjs');
  const { runtime } = await fixture(t);
  class DshAdapter {
    providerRetryPolicy() { return 'dsh-retry-policy'; }
  }
  const adapter = createKsxcModelAdapter({ adapter: new DshAdapter(), runtime });
  assert.equal(adapter.providerRetryPolicy(), 'dsh-retry-policy');
  assert.deepEqual(await adapter.listModels(), []);
  const catalogs = await Promise.all(['a', 'b'].map(model =>
    runtime.withVerifiedModel(model, async () => {
      await new Promise(resolve => setImmediate(resolve));
      return adapter.listModels();
    })));
  assert.deepEqual(catalogs.map(list => list.map(model => model.id)), [['a'], ['b']]);
  assert.deepEqual(await adapter.listModels(), []);
});
