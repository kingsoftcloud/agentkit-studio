/** Actual E2B JS SDK adapter for the durable command supervisor.
 *
 * start/connect/kill always address a sandbox already granted by the Host.
 * This transport never creates or substitutes a sandbox on a missing remote
 * process. The Host owns sandbox creation, durable identity, approval and
 * cleanup; the command store owns per-operation receipts and recovery claims.
 * No command replay, Python process, or environment-selected fallback.
 */
import { canonical, copy, invariant } from '@kingsoftcloud/agentkit-harness-core';
import { createHash } from 'node:crypto';

export const NATIVE_E2B_SDK_TRANSPORT = 'agentkit.native-e2b-sdk-transport/v1';
const validId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id);

function connectionOptions(connection) {
  invariant(connection && typeof connection === 'object', 'e2b_explicit_connection_required');
  const { apiUrl, domain, apiKey } = connection;
  let url;
  try { url = new URL(apiUrl); } catch { invariant(false, 'e2b_explicit_connection_invalid'); }
  invariant(typeof apiUrl === 'string' && !/\s/.test(apiUrl) && url.protocol === 'https:' && url.hostname
    && !url.username && !url.password && !url.search && !url.hash && ['', '/'].includes(url.pathname), 'e2b_explicit_connection_invalid');
  invariant(typeof domain === 'string' && /^[a-zA-Z0-9]+(?:[.-][a-zA-Z0-9-]+)*$/.test(domain), 'e2b_explicit_domain_invalid');
  invariant(typeof apiKey === 'string' && apiKey.trim(), 'e2b_explicit_credential_required');
  invariant(connection.headers == null || typeof connection.headers === 'object' && !Array.isArray(connection.headers)
    && Object.values(connection.headers).every(value => typeof value === 'string'), 'e2b_headers_invalid');
  return Object.freeze({ apiUrl: url.origin, domain, apiKey,
    headers: copy(connection.headers ?? {}), debug: false, retries: 0, httpVersion: '2' });
}

// The SDK uses `opts.sandboxUrl || process.env.E2B_SANDBOX_URL`; an explicit
// false/undefined cannot disable that override. Refuse contamination rather
// than mutate the shared Host environment or silently change a frozen target.
function checkSdkEnvironment() {
  invariant(!process.env.E2B_SANDBOX_URL, 'e2b_ambient_sandbox_url_forbidden');
}

function outputQueue(maxBufferedBytes) {
  const items = []; let bytes = 0, ended = false, failure, wake;
  const notify = () => { wake?.(); wake = undefined; };
  return {
    append(channel, text) {
      if (ended) return;
      invariant(typeof text === 'string', 'e2b_output_invalid');
      if (!text) return;
      const size = Buffer.byteLength(text);
      if (size + bytes > maxBufferedBytes) {
        failure = Object.assign(new Error('E2B output exceeded the transport buffer'), { code: 'e2b_output_buffer_exceeded' });
        ended = true; notify(); throw failure;
      }
      items.push({ value: { [channel]: text }, size }); bytes += size; notify();
    },
    finish(error) { if (error && !failure) failure = error; ended = true; notify(); },
    throwIfFailed() { if (failure) throw failure; },
    async *iterate() {
      for (;;) {
        if (items.length) { const item = items.shift(); bytes -= item.size; yield item.value; continue; }
        if (failure) throw failure;
        if (ended) return;
        await new Promise(resolve => { wake = resolve; });
      }
    },
  };
}

/** Explicit credentials stay inside the transport, never in its public binding.
 * loadSdk is a deterministic test seam; production imports the installed e2b
 * package and calls its actual Sandbox/Commands/CommandHandle methods.
 */
export async function createNativeE2BSdkTransport({ connection, sandboxId = null, requestTimeoutMs = 30000,
  maxBufferedBytes = 1024 * 1024, loadSdk = () => import('e2b') } = {}) {
  const bound = connectionOptions(connection);
  invariant(sandboxId === null || validId(sandboxId), 'e2b_sandbox_identity_invalid');
  invariant(Number.isSafeInteger(requestTimeoutMs) && requestTimeoutMs > 0 && requestTimeoutMs <= 120000, 'e2b_request_timeout_invalid');
  invariant(Number.isSafeInteger(maxBufferedBytes) && maxBufferedBytes >= 4 && maxBufferedBytes <= 16 * 1024 * 1024, 'e2b_buffer_limit_invalid');
  checkSdkEnvironment();
  const sdk = await loadSdk();
  checkSdkEnvironment();
  invariant(typeof sdk.Sandbox?.connect === 'function' && typeof sdk.Sandbox?.kill === 'function'
    && typeof sdk.CommandExitError === 'function', 'e2b_sdk_contract_invalid');
  const fingerprint = value => createHash('sha256').update(value).digest('hex');
  const bindingDigest = fingerprint(canonical({ contract: NATIVE_E2B_SDK_TRANSPORT, apiUrl: bound.apiUrl,
    domain: bound.domain, sandboxId, requestTimeoutMs, maxBufferedBytes,
    headersDigest: fingerprint(canonical(bound.headers)), credentialDigest: fingerprint(bound.apiKey) }));
  const targetId = input => {
    const id = input ?? sandboxId;
    invariant(validId(id) && (sandboxId === null || id === sandboxId), 'e2b_sandbox_identity_mismatch');
    return id;
  };
  const options = signal => {
    checkSdkEnvironment();
    invariant(signal == null || signal instanceof AbortSignal, 'e2b_signal_invalid');
    signal?.throwIfAborted();
    return { ...bound, headers: { ...bound.headers }, requestTimeoutMs, ...(signal ? { signal } : {}) };
  };
  async function connectSandbox(id, signal) {
    const sandbox = await sdk.Sandbox.connect(id, options(signal));
    signal?.throwIfAborted();
    invariant(sandbox.sandboxId === id && sandbox.commands, 'e2b_connected_sandbox_mismatch');
    return sandbox;
  }
  function commandOptions(input, queue) {
    invariant(Number.isSafeInteger(input.timeout) && input.timeout >= 0, 'e2b_command_timeout_invalid');
    invariant(input.signal == null || input.signal instanceof AbortSignal, 'e2b_signal_invalid');
    return { timeoutMs: input.timeout * 1000, requestTimeoutMs,
      ...(input.signal ? { signal: input.signal } : {}),
      onStdout: text => queue.append('stdout', text), onStderr: text => queue.append('stderr', text) };
  }
  function attach(handle, queue, signal) {
    invariant(Number.isSafeInteger(handle?.pid) && handle.pid > 0 && typeof handle.wait === 'function'
      && typeof handle.disconnect === 'function', 'e2b_command_handle_invalid');
    let disconnected = false;
    const disconnect = async () => {
      if (disconnected) return;
      disconnected = true;
      try { await handle.disconnect(); } finally { queue.finish(); signal?.removeEventListener('abort', onAbort); }
    };
    const onAbort = () => { void disconnect().catch(() => {}); };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    // wait() drives SDK output callbacks and throws CommandExitError for an
    // ordinary nonzero process exit. A transport failure has no proven exit.
    const result = Promise.resolve().then(() => handle.wait()).catch(error => {
      if (!(error instanceof sdk.CommandExitError)) throw error;
      return error;
    }).then(value => {
      signal?.throwIfAborted(); queue.throwIfFailed();
      invariant(Number.isSafeInteger(value?.exitCode), 'e2b_command_exit_unknown');
      return { exitCode: value.exitCode };
    }).then(value => { queue.finish(); return value; }, error => { queue.finish(error); throw error; })
      .finally(() => signal?.removeEventListener('abort', onAbort));
    // An attached supervisor subscribes immediately; retain a rejection handler
    // even if its generation was superseded before it reached the subscription.
    void result.catch(() => {});
    return Object.freeze({ pid: handle.pid, result, disconnect,
      [Symbol.asyncIterator]: () => queue.iterate() });
  }
  return Object.freeze({ contract: NATIVE_E2B_SDK_TRANSPORT, bindingDigest,
    async start(command, input = {}) {
      const id = targetId(input.sandboxId);
      invariant(typeof command === 'string' && command.trim(), 'e2b_command_required');
      invariant(input.cwd == null || typeof input.cwd === 'string', 'e2b_cwd_invalid');
      invariant(input.env == null || typeof input.env === 'object' && !Array.isArray(input.env)
        && Object.values(input.env).every(value => typeof value === 'string'), 'e2b_env_invalid');
      const queue = outputQueue(maxBufferedBytes), opts = commandOptions(input, queue);
      const signal = input.signal, cwd = input.cwd, env = input.env == null ? null : copy(input.env);
      const sandbox = await connectSandbox(id, signal);
      signal?.throwIfAborted(); checkSdkEnvironment();
      const handle = await sandbox.commands.run(command, { ...opts, background: true,
        ...(cwd == null ? {} : { cwd }), ...(env == null ? {} : { envs: env }) });
      return { pid: handle.pid, sandboxId: id, handle: attach(handle, queue, signal) };
    },
    async reconnect(pid, input = {}) {
      const id = targetId(input.sandboxId);
      invariant(Number.isSafeInteger(pid) && pid > 0, 'e2b_pid_invalid');
      const queue = outputQueue(maxBufferedBytes), opts = commandOptions(input, queue);
      const signal = input.signal;
      const sandbox = await connectSandbox(id, signal);
      signal?.throwIfAborted(); checkSdkEnvironment();
      const handle = await sandbox.commands.connect(pid, opts);
      invariant(handle.pid === pid, 'e2b_connected_process_mismatch');
      return attach(handle, queue, signal);
    },
    async kill(pid, input = {}) {
      const id = targetId(input.sandboxId);
      invariant(Number.isSafeInteger(pid) && pid > 0, 'e2b_pid_invalid');
      const signal = input.signal;
      const sandbox = await connectSandbox(id, signal);
      signal?.throwIfAborted(); checkSdkEnvironment();
      return await sandbox.commands.kill(pid, { requestTimeoutMs, ...(signal ? { signal } : {}) }) === true;
    },
    async killSandbox(id, { signal } = {}) {
      return await sdk.Sandbox.kill(targetId(id), options(signal)) === true;
    },
  });
}

/** Detached supervisor module factory; config arrives through its stdin. */
export const factory = config => createNativeE2BSdkTransport(config);

/** File connection for a sandbox whose creation intent and identity have already
 * been committed by the Host. connect may resume that SAME sandbox in the SDK;
 * this is an effectful port, never a discovery/reconciliation read. */
export async function createNativeE2BSdkFileSession({ connection, sandboxId, request,
  loadSdk = () => import('e2b') } = {}) {
  const bound = connectionOptions(connection);
  invariant(validId(sandboxId), 'e2b_sandbox_identity_invalid');
  const signal = request?.signal, authority = request?.assertCurrent;
  invariant(signal instanceof AbortSignal && typeof authority === 'function', 'e2b_file_authority_required');
  const body = () => canonical(Object.fromEntries(Object.keys(request)
    .filter(key => !['signal', 'assertCurrent'].includes(key)).map(key => [key, copy(request[key])])));
  const original = body();
  const unchanged = () => invariant(request.signal === signal && request.assertCurrent === authority && body() === original,
    'e2b_file_context_changed');
  const guard = () => {
    signal.throwIfAborted(); checkSdkEnvironment(); unchanged();
    const verdict = authority();
    if (verdict && typeof verdict.then === 'function') Promise.resolve(verdict).catch(() => {});
    invariant(verdict === true, 'e2b_file_authority_lost'); unchanged(); signal.throwIfAborted();
  };
  async function boundary(effect) {
    guard();
    let abort;
    const canceled = new Promise((_, reject) => {
      abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true });
    });
    try {
      signal.throwIfAborted();
      const result = await Promise.race([Promise.resolve().then(() => { guard(); return effect(); }), canceled]);
      guard(); return result;
    } finally { signal.removeEventListener('abort', abort); }
  }
  const sdk = await boundary(loadSdk);
  invariant(typeof sdk.Sandbox?.connect === 'function', 'e2b_sdk_file_contract_invalid');
  const sandbox = await boundary(() => sdk.Sandbox.connect(sandboxId, { ...bound, headers: { ...bound.headers },
    signal, requestTimeoutMs: 30000 }));
  invariant(sandbox?.sandboxId === sandboxId && sandbox.files
    && ['read', 'write', 'list', 'getInfo', 'makeDir'].every(name => typeof sandbox.files[name] === 'function'),
  'e2b_connected_file_sandbox_mismatch');
  guard(); return sandbox;
}

function lifecycleConfiguration({ connection, template = 'base', timeoutSeconds = 300,
  env = {}, allowInternetAccess = true } = {}) {
  const bound = connectionOptions(connection);
  invariant(typeof template === 'string' && template.trim() && template.length <= 256, 'e2b_template_invalid');
  invariant(Number.isSafeInteger(timeoutSeconds) && timeoutSeconds > 0 && timeoutSeconds <= 86400, 'e2b_sandbox_timeout_invalid');
  invariant(env && typeof env === 'object' && !Array.isArray(env)
    && Object.values(env).every(value => typeof value === 'string'), 'e2b_sandbox_env_invalid');
  invariant(typeof allowInternetAccess === 'boolean', 'e2b_sandbox_internet_policy_invalid');
  const environment = copy(env);
  checkSdkEnvironment();
  const bindingDigest = createHash('sha256').update(canonical({ contract: NATIVE_E2B_SDK_TRANSPORT,
    connection: bound, template, timeoutSeconds, env: environment, allowInternetAccess })).digest('hex');
  return { bound, template, timeoutSeconds, environment, allowInternetAccess, bindingDigest };
}

/** Validate and pin a Build before asynchronous SDK loading. Secrets do not
 * leave this description; the lifecycle uses the identical digest algorithm. */
export function describeNativeE2BSdkLifecycle(options) {
  return Object.freeze({ bindingDigest: lifecycleConfiguration(options).bindingDigest });
}

/** Trusted lifecycle port for createNativeE2BSandboxOwner, never a model tool. */
export async function createNativeE2BSdkLifecycle({ loadSdk = () => import('e2b'), ...options } = {}) {
  const { bound, template, timeoutSeconds, environment, allowInternetAccess, bindingDigest } = lifecycleConfiguration(options);
  const sdk = await loadSdk(); checkSdkEnvironment();
  invariant(typeof sdk.Sandbox?.create === 'function' && typeof sdk.Sandbox?.kill === 'function', 'e2b_sdk_lifecycle_contract_invalid');
  return Object.freeze({ bindingDigest,
    async createSandbox({ signal, metadata } = {}) {
      invariant(signal instanceof AbortSignal, 'e2b_signal_invalid'); signal.throwIfAborted(); checkSdkEnvironment();
      invariant(metadata && typeof metadata === 'object' && !Array.isArray(metadata)
        && Object.values(metadata).every(value => typeof value === 'string'), 'e2b_sandbox_metadata_invalid');
      const sandbox = await sdk.Sandbox.create(template, { ...bound, headers: { ...bound.headers },
        signal, metadata: copy(metadata), envs: { ...environment }, allowInternetAccess,
        timeoutMs: timeoutSeconds * 1000, requestTimeoutMs: 30000 });
      // Return a proven created identity even if cancellation arrived during the
      // API call. The durable owner records that fact before refusing readiness.
      invariant(validId(sandbox?.sandboxId), 'e2b_created_identity_invalid');
      return { sandboxId: sandbox.sandboxId };
    },
    async inspectSandbox(id, { signal } = {}) {
      invariant(validId(id) && signal instanceof AbortSignal, 'e2b_sandbox_identity_invalid');
      signal.throwIfAborted(); checkSdkEnvironment();
      invariant(typeof sdk.Sandbox.getInfo === 'function', 'e2b_sdk_inspection_contract_invalid');
      // A read of the original control plane, without connect/resume/create.
      // Only the owner metadata needed for reconciliation crosses this port.
      const info = await sdk.Sandbox.getInfo(id, { ...bound, headers: { ...bound.headers }, signal, requestTimeoutMs: 30000 });
      signal.throwIfAborted(); checkSdkEnvironment();
      invariant(info?.sandboxId === id && ['running', 'paused'].includes(info.state)
        && info.metadata && typeof info.metadata === 'object' && !Array.isArray(info.metadata)
        && Object.values(info.metadata).every(value => typeof value === 'string'), 'e2b_sandbox_inspection_invalid');
      return { sandboxId: id, state: info.state, metadata: copy(info.metadata) };
    },
    async killSandbox(id, { signal } = {}) {
      invariant(validId(id) && signal instanceof AbortSignal, 'e2b_sandbox_identity_invalid');
      signal.throwIfAborted(); checkSdkEnvironment();
      return await sdk.Sandbox.kill(id, { ...bound, headers: { ...bound.headers }, signal, requestTimeoutMs: 30000 }) === true;
    },
  });
}
