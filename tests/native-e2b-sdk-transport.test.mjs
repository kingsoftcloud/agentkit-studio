import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeE2BSdkTransport, createNativeE2BSdkLifecycle, createNativeE2BSdkFileSession, NATIVE_E2B_SDK_TRANSPORT } from '../src/providers/native-e2b-sdk-transport.mjs';

const connection = () => ({ apiUrl: 'https://api.fixture.invalid', domain: 'fixture.invalid', apiKey: 'test-e2b-secret', headers: { 'x-source': 'studio' } });
function gate() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
class CommandExitError extends Error {
  constructor(exitCode) { super('nonzero command'); this.exitCode = exitCode; this.stdout = 'not a second stream'; this.stderr = 'diagnostic'; }
}
async function setup(t, { exitCode = 0, maxBufferedBytes, connectGate, failedWait, killResult = true, sdkSandboxId } = {}) {
  const calls = [], result = gate(); let stdout, stderr, disconnects = 0, waits = 0;
  const sdk = { CommandExitError, Sandbox: {
    async connect(id, opts) {
      calls.push({ method: 'Sandbox.connect', id, opts });
      if (connectGate) await connectGate.promise;
      return { sandboxId: sdkSandboxId ?? id, commands: {
        async run(command, input) {
          calls.push({ method: 'run', command, input }); stdout = input.onStdout; stderr = input.onStderr; return handle(17);
        },
        async connect(pid, input) {
          calls.push({ method: 'connect', pid, input }); stdout = input.onStdout; stderr = input.onStderr; return handle(pid);
        },
        async kill(pid, input) { calls.push({ method: 'kill', pid, input }); return killResult; },
      } };
    },
    async kill(id, opts) { calls.push({ method: 'Sandbox.kill', id, opts }); return killResult; },
    async create() { throw new Error('transport must never create'); },
  } };
  function handle(pid) {
    return { pid, wait() { waits++; return result.promise.then(() => {
      if (failedWait) throw failedWait;
      if (exitCode) throw new CommandExitError(exitCode);
      return { exitCode, stdout: 'not a second stream' };
    }); }, async disconnect() { disconnects++; result.resolve(); } };
  }
  const transport = await createNativeE2BSdkTransport({ connection: connection(), sandboxId: 'sandbox-A',
    ...(maxBufferedBytes ? { maxBufferedBytes } : {}), loadSdk: async () => sdk });
  return { transport, calls, result, stdout: text => stdout(text), stderr: text => stderr(text),
    get disconnects() { return disconnects; }, get waits() { return waits; } };
}

test('the installed real JS SDK loads with an explicit frozen connection and performs no network call at factory creation', async () => {
  const transport = await createNativeE2BSdkTransport({ connection: connection(), sandboxId: 'sandbox-A' });
  assert.equal(transport.contract, NATIVE_E2B_SDK_TRANSPORT);
  assert.match(transport.bindingDigest, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(transport).includes('test-e2b-secret'), false);
});

test('start maps exact SDK options and streams each stdout/stderr chunk once before a proven exit', async t => {
  const fixture = await setup(t);
  const signal = new AbortController().signal;
  const started = await fixture.transport.start('printf hello', { sandboxId: 'sandbox-A', cwd: '/work', env: { A: 'B' }, timeout: 7, signal });
  assert.equal(started.sandboxId, 'sandbox-A'); assert.equal(started.pid, 17);
  const options = fixture.calls.find(call => call.method === 'run').input;
  assert.equal(options.background, true); assert.equal(options.timeoutMs, 7000); assert.equal(options.cwd, '/work');
  assert.deepEqual(options.envs, { A: 'B' }); assert.equal(options.signal, signal);
  const connection = fixture.calls[0].opts;
  assert.equal(connection.retries, 0); assert.equal(connection.debug, false); assert.equal(connection.apiUrl, 'https://api.fixture.invalid');
  const chunks = []; const reading = (async () => { for await (const chunk of started.handle) chunks.push(chunk); })();
  fixture.stdout('你'); fixture.stderr('warning'); fixture.stdout('好😀'); fixture.result.resolve();
  assert.deepEqual(await started.handle.result, { exitCode: 0 }); await reading;
  assert.deepEqual(chunks, [{ stdout: '你' }, { stderr: 'warning' }, { stdout: '好😀' }]); assert.equal(fixture.waits, 1);
});

test('ordinary SDK nonzero exit stays a proven exit rather than becoming an unknown transport error', async t => {
  const fixture = await setup(t, { exitCode: 17 });
  const started = await fixture.transport.start('exit 17', { timeout: 2 });
  const chunks = []; const reading = (async () => { for await (const chunk of started.handle) chunks.push(chunk); })();
  fixture.stderr('actual stderr'); fixture.result.resolve();
  assert.deepEqual(await started.handle.result, { exitCode: 17 }); await reading;
  assert.deepEqual(chunks, [{ stderr: 'actual stderr' }]);
});

test('a transport failure cannot be misclassified using a spoofed exitCode field', async t => {
  const failure = Object.assign(new Error('network failure'), { exitCode: 0 });
  const fixture = await setup(t, { failedWait: failure });
  const started = await fixture.transport.start('possibly ran', { timeout: 2 });
  const reading = (async () => { for await (const _ of started.handle) {} })();
  const expectedStream = assert.rejects(reading, error => error === failure);
  fixture.result.resolve(); await assert.rejects(started.handle.result, error => error === failure); await expectedStream;
  assert.equal(fixture.calls.filter(call => call.method === 'run').length, 1);
});

test('reconnect uses the original sandbox and PID, with remaining milliseconds, and never starts a new command', async t => {
  const fixture = await setup(t);
  const handle = await fixture.transport.reconnect(21, { sandboxId: 'sandbox-A', timeout: 3 });
  const chunks = []; const reading = (async () => { for await (const chunk of handle) chunks.push(chunk); })();
  fixture.stdout('reconnected suffix'); fixture.result.resolve(); await handle.result; await reading;
  assert.deepEqual(chunks, [{ stdout: 'reconnected suffix' }]);
  assert.equal(fixture.calls[0].id, 'sandbox-A');
  assert.deepEqual(fixture.calls.map(call => call.method), ['Sandbox.connect', 'connect']);
  assert.equal(fixture.calls[1].pid, 21); assert.equal(fixture.calls[1].input.timeoutMs, 3000);
});

test('an unbound sandbox or wrong SDK response is rejected before command execution', async t => {
  const fixture = await setup(t, { sdkSandboxId: 'sandbox-B' });
  await assert.rejects(fixture.transport.start('must not run', { sandboxId: 'sandbox-B', timeout: 1 }), /e2b_sandbox_identity_mismatch/);
  assert.equal(fixture.calls.length, 0);
  await assert.rejects(fixture.transport.start('must not run', { timeout: 1 }), /e2b_connected_sandbox_mismatch/);
  assert.equal(fixture.calls.filter(call => call.method === 'run').length, 0);
});

test('abort while opening the sandbox prevents the eventual command and retains the original signal', async t => {
  const connected = gate(), fixture = await setup(t, { connectGate: connected });
  const controller = new AbortController(), input = { timeout: 2, signal: controller.signal };
  const pending = fixture.transport.start('must not run', input);
  const expected = assert.rejects(pending, /cancel actual command/);
  input.signal = new AbortController().signal; controller.abort(new Error('cancel actual command')); connected.resolve(); await expected;
  assert.equal(fixture.calls.filter(call => call.method === 'run').length, 0);
});

test('command cwd and environment are snapshotted before the asynchronous connection', async t => {
  const connected = gate(), fixture = await setup(t, { connectGate: connected });
  const input = { timeout: 2, cwd: '/original', env: { TOKEN: 'original' } };
  const pending = fixture.transport.start('exact command', input);
  input.cwd = '/changed'; input.env.TOKEN = 'changed'; connected.resolve();
  const started = await pending; fixture.result.resolve(); await started.handle.result;
  assert.equal(fixture.calls[1].input.cwd, '/original'); assert.deepEqual(fixture.calls[1].input.envs, { TOKEN: 'original' });
});

test('disconnect quiesces callbacks without killing the remote process and is idempotent', async t => {
  const fixture = await setup(t), started = await fixture.transport.start('background', { timeout: 0 });
  const chunks = []; const reading = (async () => { for await (const chunk of started.handle) chunks.push(chunk); })();
  fixture.stdout('before'); await started.handle.disconnect(); await started.handle.disconnect();
  fixture.stdout('late'); await reading;
  assert.deepEqual(chunks, [{ stdout: 'before' }]); assert.equal(fixture.disconnects, 1);
  assert.equal(fixture.calls.some(call => call.method === 'kill' || call.method === 'Sandbox.kill'), false);
});

test('a buffer overflow remains unknown even if the SDK later supplies exit code zero', async t => {
  const fixture = await setup(t, { maxBufferedBytes: 4 });
  const started = await fixture.transport.start('large output', { timeout: 2 });
  assert.throws(() => fixture.stdout('你你好'), /transport buffer/);
  fixture.result.resolve(); await assert.rejects(started.handle.result, error => error.code === 'e2b_output_buffer_exceeded');
  await assert.rejects(async () => { for await (const _ of started.handle) {} }, error => error.code === 'e2b_output_buffer_exceeded');
});

test('kill requires exact remote identity and confirms only an awaited boolean true', async t => {
  for (const result of [true, false, { killed: true }]) {
    const fixture = await setup(t, { killResult: result });
    assert.equal(await fixture.transport.kill(11, { sandboxId: 'sandbox-A' }), result === true);
    assert.equal(await fixture.transport.killSandbox('sandbox-A'), result === true);
    assert.deepEqual(fixture.calls.filter(call => call.method === 'kill').map(call => call.pid), [11]);
    await assert.rejects(fixture.transport.kill(11, { sandboxId: 'sandbox-B' }), /e2b_sandbox_identity_mismatch/);
  }
});

test('invalid explicit targets fail before loading the SDK and ambient sandbox URL is never used', async () => {
  let loads = 0;
  for (const change of [{ apiUrl: 'http://private.invalid' }, { apiUrl: 'https://user:secret@api.fixture.invalid/' },
    { apiUrl: 'https://api.fixture.invalid/path' }, { domain: 'bad/name' }, { apiKey: '' }]) {
    await assert.rejects(createNativeE2BSdkTransport({ connection: { ...connection(), ...change }, loadSdk: async () => { loads++; } }));
  }
  assert.equal(loads, 0);
  const before = process.env.E2B_SANDBOX_URL;
  try {
    process.env.E2B_SANDBOX_URL = 'http://wrong-env.invalid';
    await assert.rejects(createNativeE2BSdkTransport({ connection: connection() }), /e2b_ambient_sandbox_url_forbidden/);
  } finally { if (before === undefined) delete process.env.E2B_SANDBOX_URL; else process.env.E2B_SANDBOX_URL = before; }
});

test('the installed SDK exposes the lifecycle port without creating a sandbox during binding', async () => {
  const lifecycle = await createNativeE2BSdkLifecycle({ connection: connection() });
  assert.match(lifecycle.bindingDigest, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(lifecycle).includes('test-e2b-secret'), false);
});

test('lifecycle uses the fixed template, timeout, environment and owner metadata with actual SDK argument names', async () => {
  const calls = [], env = { LANG: 'original' }, signal = new AbortController().signal;
  const lifecycle = await createNativeE2BSdkLifecycle({ connection: connection(), template: 'owned-template',
    timeoutSeconds: 123, env, allowInternetAccess: false, loadSdk: async () => ({ Sandbox: {
      async create(template, options) { calls.push({ template, options }); return { sandboxId: 'sandbox-A' }; },
      async kill(id, options) { calls.push({ id, options }); return true; },
    } }) });
  env.LANG = 'changed';
  assert.deepEqual(await lifecycle.createSandbox({ signal, metadata: { nativeOwner: 'original-owner' } }), { sandboxId: 'sandbox-A' });
  assert.equal(calls[0].template, 'owned-template'); assert.equal(calls[0].options.timeoutMs, 123000);
  assert.equal(calls[0].options.signal, signal); assert.equal(calls[0].options.retries, 0);
  assert.equal(calls[0].options.allowInternetAccess, false);
  assert.deepEqual(calls[0].options.envs, { LANG: 'original' });
  assert.deepEqual(calls[0].options.metadata, { nativeOwner: 'original-owner' });
  assert.equal(await lifecycle.killSandbox('sandbox-A', { signal }), true); assert.equal(calls[1].id, 'sandbox-A');
});

test('lifecycle internet policy is strict and participates in the frozen binding', async () => {
  const enabled = await createNativeE2BSdkLifecycle({ connection: connection(), allowInternetAccess: true });
  const disabled = await createNativeE2BSdkLifecycle({ connection: connection(), allowInternetAccess: false });
  assert.notEqual(enabled.bindingDigest, disabled.bindingDigest);
  await assert.rejects(createNativeE2BSdkLifecycle({ connection: connection(), allowInternetAccess: 'false' }), /e2b_sandbox_internet_policy_invalid/);
});

test('lifecycle inspection is an exact control-plane getInfo read with only owner metadata returned', async () => {
  const calls = [], signal = new AbortController().signal;
  const lifecycle = await createNativeE2BSdkLifecycle({ connection: connection(), loadSdk: async () => ({ Sandbox: {
    async create() { assert.fail('inspection must not create'); }, async kill() { assert.fail('inspection must not kill'); },
    async getInfo(id, opts) {
      calls.push({ id, opts });
      return { sandboxId: id, state: 'running', metadata: { nativeOwner: 'owner', nativeCreateOperation: 'operation' },
        envdAccessToken: 'never-return-this' };
    },
  } }) });
  const inspected = await lifecycle.inspectSandbox('sandbox-original', { signal });
  assert.deepEqual(inspected, { sandboxId: 'sandbox-original', state: 'running',
    metadata: { nativeOwner: 'owner', nativeCreateOperation: 'operation' } });
  assert.equal(calls.length, 1); assert.equal(calls[0].id, 'sandbox-original');
  assert.equal(calls[0].opts.signal, signal); assert.equal(calls[0].opts.apiUrl, connection().apiUrl);
  assert.equal(calls[0].opts.retries, 0); assert.equal(calls[0].opts.requestTimeoutMs, 30000);
});

test('lifecycle inspection rejects a substituted sandbox or a response after cancellation', async () => {
  const observed = gate(), entered = gate(), controller = new AbortController(); let calls = 0;
  const lifecycle = await createNativeE2BSdkLifecycle({ connection: connection(), loadSdk: async () => ({ Sandbox: {
    async create() {}, async kill() {}, async getInfo(id) {
      calls++; entered.resolve(); await observed.promise; return { sandboxId: 'wrong-sandbox', state: 'running', metadata: {} };
    },
  } }) });
  const pending = lifecycle.inspectSandbox('sandbox-original', { signal: controller.signal });
  const expected = assert.rejects(pending, { name: 'AbortError' });
  await entered.promise; controller.abort(); observed.resolve(); await expected;
  await assert.rejects(lifecycle.inspectSandbox('sandbox-original', { signal: new AbortController().signal }), /e2b_sandbox_inspection_invalid/);
  assert.equal(calls, 2);
});

test('lifecycle returns a proven created identity when a cancellation arrives during creation', async () => {
  const controller = new AbortController();
  const lifecycle = await createNativeE2BSdkLifecycle({ connection: connection(), loadSdk: async () => ({ Sandbox: {
    async create() { controller.abort(); return { sandboxId: 'sandbox-created-before-cancel' }; }, async kill() { throw new Error('must not kill'); },
  } }) });
  assert.deepEqual(await lifecycle.createSandbox({ signal: controller.signal, metadata: { nativeOwner: 'owner' } }),
    { sandboxId: 'sandbox-created-before-cancel' });
});

test('lifecycle never retries an unknown create and a rejected or truthy kill cannot confirm cleanup', async () => {
  let creates = 0, kills = 0;
  const lifecycle = await createNativeE2BSdkLifecycle({ connection: connection(), loadSdk: async () => ({ Sandbox: {
    async create() { creates++; throw new Error('create response lost'); },
    async kill() { kills++; return 'true'; },
  } }) });
  await assert.rejects(lifecycle.createSandbox({ signal: new AbortController().signal, metadata: { nativeOwner: 'owner' } }), /create response lost/);
  assert.equal(creates, 1); assert.equal(await lifecycle.killSandbox('sandbox-A', { signal: new AbortController().signal }), false);
  assert.equal(kills, 1);
});

test('file connection binds the original sandbox and full exact Native context before/after SDK boundaries', async () => {
  const calls = [], files = Object.fromEntries(['read', 'write', 'list', 'getInfo', 'makeDir'].map(key => [key, () => {}]));
  const request = { scope: { user: 'one' }, future: { integer: 9007199254740993n },
    signal: new AbortController().signal, assertCurrent: () => true };
  const sandbox = { sandboxId: 'original', files };
  const result = await createNativeE2BSdkFileSession({ connection: connection(), sandboxId: 'original', request,
    loadSdk: async () => ({ Sandbox: { connect(id, options) { calls.push({ id, options }); return sandbox; } } }) });
  assert.equal(result, sandbox); assert.equal(calls.length, 1); assert.equal(calls[0].id, 'original');
  assert.equal(calls[0].options.signal, request.signal); assert.equal(calls[0].options.retries, 0);
  assert.equal(calls[0].options.requestTimeoutMs, 30000);
  assert.equal(calls[0].options.apiUrl, 'https://api.fixture.invalid');
  const bad = { ...request, assertCurrent: () => { bad.future = { integer: 9007199254740992n }; return true; } };
  await assert.rejects(createNativeE2BSdkFileSession({ connection: connection(), sandboxId: 'original', request: bad,
    loadSdk: () => assert.fail('reentrant mutation must fail before import') }), /e2b_file_context_changed/);
});

test('file connection rejects substituted IDs and authority functions; cancellation never waits for an uncooperative SDK', async () => {
  const controller = new AbortController(), entered = gate(), returned = gate();
  const request = { signal: controller.signal, assertCurrent: () => true, future: 'fixed' };
  const pending = createNativeE2BSdkFileSession({ connection: connection(), sandboxId: 'original', request,
    loadSdk: async () => ({ Sandbox: { connect() { entered.resolve(); return returned.promise; } } }) });
  await entered.promise; controller.abort(new Error('cancel noncooperative connect'));
  await assert.rejects(Promise.race([pending, new Promise((_, reject) => setTimeout(() => reject(new Error('cancel hung')), 1000))]),
    /cancel noncooperative connect/);
  returned.reject(new Error('late SDK rejection must be observed')); await new Promise(resolve => setImmediate(resolve));
  const wrong = { signal: new AbortController().signal, assertCurrent: () => true };
  await assert.rejects(createNativeE2BSdkFileSession({ connection: connection(), sandboxId: 'original', request: wrong,
    loadSdk: async () => ({ Sandbox: { connect() { return { sandboxId: 'foreign', files: {} }; } } }) }), /e2b_connected_file_sandbox_mismatch/);
  wrong.assertCurrent = () => Promise.reject(new Error('invalid asynchronous authority'));
  await assert.rejects(createNativeE2BSdkFileSession({ connection: connection(), sandboxId: 'original', request: wrong,
    loadSdk: () => assert.fail('invalid authority cannot import SDK') }), /e2b_file_authority_lost/);
});
