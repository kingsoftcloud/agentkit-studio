/** Node AgentCard discovery and managed A2A calls for the Native Host.
 * Native owns scheduling/approval and its durable tool intent. This service
 * additionally checkpoints the original remote task before consuming later
 * stream events. An unfinished send is never sent a second time.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { isIP } from 'node:net';
import aws4 from 'aws4';
import { canonical, copy, invariant, scopeKey, parseNativeJson } from '../../packages/agentkit-harness-core/dist/index.mjs';
import { atomicPrivate, privateDirectory, readAll, tryLock } from '../../packages/agentkit-harness/src/native/local-command-state.mjs';
import { isBlockedAddress } from '../../packages/agentkit-harness/src/native/web-tools.mjs';
import { hostFetch } from '../http-fetch.mjs';
import { createSsrfPinnedFetch } from './native-dsh-web.mjs';
import { a2aSse, a2aTerminal, createA2AProjection, NATIVE_A2A_PROTOCOL } from './native-a2a-protocol.mjs';
import { a2aControlView, createA2ATaskControl } from './native-a2a-controls.mjs';
import { createInternalA2AControlPlane } from './native-a2a-control-plane.mjs';
import { createInternalA2AWire, A2A_INTERNAL_WIRE } from './native-a2a-internal-wire.mjs';
import { createFileWorkloadTokenProvider } from './native-a2a-workload-token.mjs';

export const STUDIO_NATIVE_A2A_HOST = 'agentkit.studio-native-a2a-host/v1';
export const STUDIO_DSH_A2A_HOST = 'agentkit.studio-dsh-a2a-host/v1';
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const sendAdmission = 'agentkit.a2a-send-admission/v1';
const text = (value, code) => { invariant(typeof value === 'string' && value.trim() && value.length <= 4096, code); return value; };
const normalized = value => value.trim().toLowerCase().replace(/^a2a-agent-/u, '');
const read = (env, name, fallback = '') => { const value = env[name] ?? fallback; invariant(typeof value === 'string', 'A2A_ENV_INVALID'); return value.trim(); };
const kopHosts = new Set(['aicp.api.ksyun.com', 'aicp.inner.api.ksyun.com', 'aicp.internal.api.ksyun.com']);
function endpoint(value, allowPrivate = false, allowQuery = false) {
  const url = new URL(value);
  invariant(['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && (allowQuery || !url.search) && !url.hash,
    'A2A_ENDPOINT_INVALID');
  const host = url.hostname.replace(/^\[|\]$/gu, '');
  invariant(allowPrivate || url.protocol === 'https:' && (!isIP(host) || !isBlockedAddress(host)), 'A2A_ENDPOINT_BLOCKED');
  return url;
}
async function jsonBody(response, limit = 8 * 1024 * 1024) {
  invariant(response.ok && response.body?.getReader, 'A2A_HTTP_FAILED');
  const reader = response.body.getReader(), chunks = []; let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      bytes += next.value.byteLength; invariant(bytes <= limit, 'A2A_RESPONSE_LIMIT'); chunks.push(next.value);
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
function strictSpecs(input) {
  invariant(Array.isArray(input) && input.length <= 100, 'A2A_BINDINGS_INVALID');
  const allowed = new Set(['local_name', 'binding_id', 'space_id', 'target_agent_id', 'expected_version_id', 'description', 'exposure', 'timeout_seconds', 'policy_ref']);
  const unique = { local_name: new Set(), binding_id: new Set(), target_agent_id: new Set() };
  return input.map(raw => {
    invariant(raw && typeof raw === 'object' && Object.keys(raw).every(key => allowed.has(key)), 'A2A_BINDING_FIELD_INVALID');
    for (const key of ['local_name', 'binding_id', 'space_id', 'target_agent_id', 'expected_version_id']) text(raw[key], 'A2A_BINDING_ID_REQUIRED');
    const spec = copy(raw);
    invariant(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(spec.local_name), 'A2A_LOCAL_NAME_INVALID');
    invariant(spec.exposure === undefined || ['tool', 'auto'].includes(spec.exposure), 'A2A_NATIVE_EXPOSURE_UNSUPPORTED');
    invariant(spec.policy_ref == null || ['policy://a2a/runtime', 'policy://a2a/strict'].includes(spec.policy_ref), 'A2A_POLICY_REF_UNSUPPORTED');
    invariant(spec.timeout_seconds === undefined || Number.isFinite(spec.timeout_seconds) && spec.timeout_seconds > 0 && spec.timeout_seconds <= 86400,
      'A2A_TIMEOUT_INVALID');
    for (const [key, seen] of Object.entries(unique)) { invariant(!seen.has(spec[key]), 'A2A_EXPOSURE_CONFLICT'); seen.add(spec[key]); }
    return Object.freeze(spec);
  });
}

export function prepareNativeA2AHost(options = {}) { return prepareA2AHost(options, false); }
export function prepareDshA2AHost(options = {}) { return prepareA2AHost(options, true); }
function prepareA2AHost({ env = {}, bindings = [], fetchImpl = hostFetch, workloadTokenProvider } = {}, dsh) {
  const contract = dsh ? STUDIO_DSH_A2A_HOST : STUDIO_NATIVE_A2A_HOST;
  const fixed = { ...env }, specs = strictSpecs(bindings);
  let spaceId = read(fixed, 'KSADK_A2A_SPACE_ID');
  if (!spaceId && read(fixed, 'KSADK_A2A_SPACE_IDS')) {
    const ids = JSON.parse(read(fixed, 'KSADK_A2A_SPACE_IDS'));
    invariant(Array.isArray(ids) && ids.every(id => typeof id === 'string' && id.trim()), 'A2A_SPACES_INVALID');
    spaceId = ids[0] ?? '';
  }
  spaceId ||= specs[0]?.space_id ?? '';
  if (!spaceId) return null;
  text(spaceId, 'A2A_SPACE_REQUIRED');
  const allowPrivate = ['1', 'true'].includes(read(fixed, 'KSADK_A2A_ALLOW_PRIVATE').toLowerCase());
  const controlPlaneUrl = read(fixed, 'KSADK_A2A_CONTROL_PLANE_URL');
  const internal = controlPlaneUrl ? createInternalA2AControlPlane({ baseUrl: controlPlaneUrl, fetchImpl, allowPrivate,
    tokenProvider: workloadTokenProvider ?? createFileWorkloadTokenProvider({
      tokenDirectory: read(fixed, 'KSADK_A2A_TOKEN_DIR', '/var/run/secrets/agentengine/a2a') }) }) : null;
  const publicEgressEnabled = ['1', 'true', 'yes', 'on'].includes(read(fixed, 'KSADK_A2A_ENABLE_PUBLIC_EGRESS').toLowerCase());
  const base = endpoint(internal ? 'https://aicp.api.ksyun.com' : read(fixed, 'KSADK_A2A_SERVICE_URL', 'https://aicp.api.ksyun.com'), true);
  invariant(base.pathname === '/', 'A2A_SERVICE_ORIGIN_REQUIRED');
  const token = read(fixed, 'KSADK_A2A_SERVICE_TOKEN');
  const ak = read(fixed, 'KSADK_A2A_ACCESS_KEY', read(fixed, 'KSYUN_ACCESS_KEY'));
  const sk = read(fixed, 'KSADK_A2A_SECRET_KEY', read(fixed, 'KSYUN_SECRET_KEY'));
  const sessionToken = read(fixed, 'KSYUN_SESSION_TOKEN');
  const logicalRegion = read(fixed, 'KSADK_A2A_SERVICE_REGION', read(fixed, 'KSYUN_REGION', 'cn-beijing-6'));
  const region = logicalRegion === 'pre-online' ? 'cn-beijing-6' : logicalRegion;
  const source = logicalRegion === 'pre-online' ? read(fixed, 'AGENTENGINE_PRE_CUSTOM_SOURCE', 'pre') : '';
  const accountId = read(fixed, 'KSADK_A2A_ACCOUNT_ID', read(fixed, 'KSYUN_ACCOUNT_ID'));
  const isKop = kopHosts.has(base.hostname);
  invariant(base.protocol === 'https:' || isKop || ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname), 'A2A_SERVICE_HTTP_FORBIDDEN');
  const planDigest = hash(specs), sourceDigest = hash({ source: 'ksadk-python', revision: '355059d78e47ed764bbdb3606304cdf34e9838a3' });
  const binding = Object.freeze({ contract, protocol: NATIVE_A2A_PROTOCOL, spaceId,
    bindingDigest: hash(internal ? { spaceId, specs, allowPrivate, publicEgressEnabled, controlPlane: internal.binding }
      : { base: base.href, spaceId, specs, allowPrivate, region, source, accountId,
        credentialFingerprint: hash({ token, ak, sk, sessionToken }) }), planDigest });
  const pinned = createSsrfPinnedFetch({ fetchImpl, ssrfBlockCheck: allowPrivate ? null : isBlockedAddress });
  let closed = false;
  const lifetime = new AbortController();
  const close = async () => { closed = true; lifetime.abort(new Error('A2A_HOST_CLOSED')); internal?.close(); await pinned.close(); };
  async function list({ spaceId: selectedSpace, signal, assertCurrent: authority }) {
    invariant(!closed, 'A2A_HOST_CLOSED'); signal.throwIfAborted();
    if (internal) {
      const agents = [], seen = new Set(), cursors = new Set(); let cursor;
      do {
        invariant(cursors.size < 100 && !cursors.has(cursor), 'A2A_DISCOVERY_LIMIT'); cursors.add(cursor);
        const page = await internal.listSpaceAgents({ spaceId: selectedSpace, signal, assertCurrent: authority, ...(cursor ? { cursor } : {}), pageSize: 100 });
        for (const item of page.agents) {
          invariant(!seen.has(item.agent_id) && agents.length < 10000, 'A2A_DISCOVERY_LIMIT'); seen.add(item.agent_id);
          if (item.callable) agents.push(item);
        }
        cursor = page.nextCursor;
      } while (cursor);
      return agents;
    }
    const name = 'ListAToASpaceAgents', version = '2024-06-12';
    const body = JSON.stringify({ A2ASpaceId: text(selectedSpace, 'A2A_SPACE_REQUIRED'), Status: 'available', PageSize: 100 });
    const url = new URL(isKop ? `/?Action=${name}&Version=${version}` : `/agentengine/api/v1/${name}`, base);
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json',
      ...(accountId ? { 'X-Ksc-Account-Id': accountId } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) };
    if (isKop) {
      Object.assign(headers, { 'X-Ksc-Request-Id': randomUUID(), 'X-Ksc-Region': region, 'X-Ksc-Source': 'agentkit-studio',
        'X-Action': name, 'X-Version': version, ...(source ? { 'X-KSC-CUSTOM-SOURCE': source } : {}) });
      if (!token) {
        invariant(ak && sk, 'A2A_SERVICE_CREDENTIAL_REQUIRED');
        Object.assign(headers, aws4.sign({ host: url.host, path: url.pathname + url.search, method: 'POST', service: 'aicp', region, body, headers },
          { accessKeyId: ak, secretAccessKey: sk, ...(sessionToken ? { sessionToken } : {}) }).headers);
      }
    }
    const result = await jsonBody(await fetchImpl(url, { method: 'POST', body, headers, redirect: 'error',
      signal: AbortSignal.any([signal, lifetime.signal, AbortSignal.timeout(30000)]) }));
    signal.throwIfAborted(); invariant(!closed, 'A2A_HOST_CLOSED');
    invariant(result && [undefined, 0, 200].includes(result.Code) && Array.isArray(result.Data?.Agents), 'A2A_DISCOVERY_RESPONSE_INVALID');
    invariant(result.Data.Agents.length <= 100, 'A2A_DISCOVERY_LIMIT');
    return result.Data.Agents.filter(item => item && (!item.InvocationStatus || item.InvocationStatus === 'available'))
      .map(item => ({ agent_id: String(item.A2AAgentId ?? ''), name: String(item.AgentCard?.name ?? item.Name ?? ''),
        description: String(item.AgentCard?.description ?? item.Description ?? ''),
        version_id: String(item.VersionId ?? item.LatestVersionId ?? ''), card_sha256: String(item.CardSha256 ?? ''),
        source: String(item.Source ?? 'hosted'), url: String(item.AgentCard?.supportedInterfaces?.[0]?.url ?? ''), card: copy(item.AgentCard ?? {}) }));
  }
  function forSession({ scope, agentId, agentRevision, buildId = null, sessionId, stateRoot, workspaceRoot, assertCurrent,
    assertControl, authorizeControl, assertReceipt }) {
    if (dsh) invariant(typeof agentId === 'string' && agentId.trim() && Number.isSafeInteger(agentRevision) && agentRevision > 0
      && (buildId === null || typeof buildId === 'string' && buildId.trim()), 'A2A_DSH_OWNER_REQUIRED');
    else scopeKey(scope);
    const fixedScope = dsh ? null : copy(scope), ownerBinding = dsh ? { agentId, agentRevision, buildId } : { scope: fixedScope };
    text(sessionId, 'A2A_SESSION_REQUIRED'); invariant(typeof assertCurrent === 'function', 'A2A_AUTHORITY_REQUIRED');
    const workspace = realpathSync(workspaceRoot), lexical = resolve(stateRoot);
    invariant(lexical !== workspace && !lexical.startsWith(workspace + sep), 'A2A_STATE_INSIDE_WORKSPACE');
    privateDirectory(dirname(lexical), true); privateDirectory(lexical, true);
    const root = realpathSync(lexical), owner = { ...ownerBinding, sessionId, bindingDigest: binding.bindingDigest };
    const directory = join(root, hash({ ...ownerBinding, sessionId })); privateDirectory(directory, true);
    const pinnedDirectory = lstatSync(directory), sessionLifetime = new AbortController();
    function storageGuard() {
      invariant(realpathSync(lexical) === root && realpathSync(workspaceRoot) === workspace, 'A2A_OWNER_CHANGED');
      privateDirectory(directory);
      const current = lstatSync(directory);
      invariant(current.ino === pinnedDirectory.ino && current.dev === pinnedDirectory.dev, 'A2A_OWNER_CHANGED');
    }
    function checkOwner(signal) {
      invariant(!closed && !sessionLifetime.signal.aborted, 'A2A_OWNER_CLOSED'); storageGuard(); signal.throwIfAborted();
    }
    function check(native, signal) {
      checkOwner(signal);
      invariant(native.sessionId === sessionId && (dsh ? native.agentId === agentId && native.agentRevision === agentRevision
        && native.buildId === buildId && !['scope', 'runId', 'turnId', 'executionFence', 'taskChainId', 'parentRunId'].some(key => Object.hasOwn(native, key))
        : canonical(native.scope) === canonical(fixedScope)), 'A2A_SCOPE_CONFLICT');
      const current = assertCurrent({ ...native, signal });
      if (current && typeof current.then === 'function') Promise.resolve(current).catch(() => {});
      invariant(current === true, 'A2A_AUTHORITY_LOST'); signal.throwIfAborted();
    }
    async function resolveCall({ agent, message, signal, nativeRequest, dshRequest }) {
      const original = dsh ? dshRequest : nativeRequest;
      check(original, signal);
      const native = copy(Object.fromEntries(Object.entries(original).filter(([key]) => key !== 'signal')));
      const spec = specs.find(spec => normalized(spec.target_agent_id) === normalized(agent) || normalized(spec.local_name) === normalized(agent));
      invariant(spec, 'A2A_TARGET_NOT_BOUND');
      const identity = { ...ownerBinding, sessionId, ...(!dsh ? { runId: native.runId } : {}), operationKey: native.operationKey, callId: native.call.callId };
      const previous = readIdentity(identity);
      if (previous) {
        invariant(canonical(previous.request[dsh ? 'dsh' : 'native']) === canonical(native) && canonical(previous.request.spec) === canonical(spec)
          && previous.request.message.parts.length === 1 && previous.request.message.parts[0].text === message, 'A2A_CALL_IDENTITY_CONFLICT');
        check(native, signal); return copy(previous.request);
      }
      const agents = await list({ spaceId: spec.space_id, signal: AbortSignal.any([signal, sessionLifetime.signal]),
        assertCurrent: () => { check(native, signal); return true; } }); check(native, signal);
      const found = agents.find(item => item.agent_id === spec.target_agent_id);
      invariant(found && found.version_id === spec.expected_version_id, 'A2A_VERSION_DRIFT');
      const iface = found.card.supportedInterfaces?.[0];
      invariant(iface?.protocolVersion === '1.0' && ['JSONRPC', 'HTTP+JSON'].includes(iface.protocolBinding), 'A2A_INTERFACE_UNSUPPORTED');
      endpoint(iface.url, allowPrivate, Boolean(internal));
      const scopeId = `a2a-${hash(identity)}`;
      const wireMessage = { messageId: hash({ identity, kind: 'initial-message' }), role: 'ROLE_USER', parts: [{ text: message }] };
      invariant(Buffer.byteLength(canonical(wireMessage)) <= 1024 * 1024, 'A2A_MESSAGE_LIMIT');
      const request = { spec, trigger: { scope_id: dsh ? scopeId : native.runId, item_id: native.call.callId, call_id: native.call.callId },
        [dsh ? 'dsh' : 'native']: native, scopeId, identity, message: wireMessage,
        ...(internal ? { cardSha256: text(found.card_sha256, 'A2A_CARD_DIGEST_REQUIRED') } : {}),
        route: { url: iface.url, protocolBinding: iface.protocolBinding, streaming: found.card.capabilities?.streaming === true,
          source: found.source } };
      const record = newRecord(request, 'prepared');
      check(native, signal); save(request, record, undefined, 'prepare');
      return copy(record.request);
    }
    function newRecord(request, phase) {
      const createdAt = Date.now();
      return { contract, owner, request, requestDigest: hash(request), phase, sendAdmission,
        platformTaskId: `a2a-task-${randomUUID().replaceAll('-', '')}`, createdAt,
        deadlineAt: createdAt + Math.min(90000, Math.ceil((request.spec.timeout_seconds ?? 90) * 1000)),
        projection: createA2AProjection(request.scopeId).snapshot(),
        ...(internal ? { managed: { contract: A2A_INTERNAL_WIRE, operations: {} } } : {}) };
    }
    function file(request) { return join(directory, `${hash(request.identity)}.json`); }
    function readIdentity(identity) {
      storageGuard(); const path = file({ identity }); if (!existsSync(path)) return null;
      invariant(lstatSync(path).size <= 64 * 1024 * 1024, 'A2A_RECORD_LIMIT');
      const record = parseNativeJson(readAll(path));
      invariant(record.contract === contract && canonical(record.owner) === canonical(owner)
        && canonical(record.request.identity) === canonical(identity) && record.requestDigest === hash(record.request)
        && ['prepared', 'sending', 'unknown', 'terminal', 'paused'].includes(record.phase), 'A2A_CALL_IDENTITY_CONFLICT');
      if (record.phase === 'prepared') invariant(record.sendAdmission === sendAdmission
        && record.projection?.state === 'submitted' && record.projection.taskId === null, 'A2A_SEND_ADMISSION_INVALID');
      return record;
    }
    function readRecord(request) {
      const record = readIdentity(request.identity); if (!record) return null;
      invariant(record.requestDigest === hash(request) && canonical(record.request) === canonical(request), 'A2A_CALL_IDENTITY_CONFLICT');
      return record;
    }
    function save(request, record, controlKey, mode) {
      storageGuard();
      // The effect/stream lock is long lived. State publication has a separate,
      // short transaction so an approved cancel can reach a busy remote Task.
      const release = tryLock(join(directory, `${hash(request.identity)}.state.sqlite`), 5000);
      invariant(release, 'A2A_RECORD_BUSY');
      try {
        const current = readRecord(request);
        if (current && (mode === 'prepare' || mode === 'admit' && current.phase !== 'prepared')) {
          Object.assign(record, current); return false;
        }
        if (mode === 'admit') {
          invariant(current?.sendAdmission === sendAdmission && current.phase === 'prepared', 'A2A_SEND_ADMISSION_INVALID');
          invariant(current.deadlineAt > Date.now(), 'A2A_SEND_DEADLINE_EXCEEDED');
          // This marker and local cancellation compete under this SAME lock.
          // Only the winner of prepared -> sending may enter the transport.
          record.phase = 'sending';
        }
        if (current) {
          if (current.managed) { record.managed = copy(current.managed); record.platformTaskId = current.platformTaskId; }
          if (current.localCancel) record.localCancel = copy(current.localCancel);
          const previous = current.projection;
          if (previous.taskId && !record.projection.taskId) record.projection = copy(previous);
          const next = record.projection;
          invariant(previous.scopeId === next.scopeId && (!previous.taskId
            || previous.taskId === next.taskId && previous.contextId === next.contextId), 'A2A_REMOTE_BINDING_CONFLICT');
          if (a2aTerminal.has(previous.state)) {
            invariant(!a2aTerminal.has(next.state) || previous.state === next.state, 'A2A_TERMINAL_STATE_CONFLICT');
            if (!a2aTerminal.has(next.state)) record.projection = copy(previous);
          }
          record.projection.pauseGeneration = Math.max(previous.pauseGeneration ?? 0, record.projection.pauseGeneration ?? 0);
          if (controlKey && current.controls?.[controlKey] && record.controls?.[controlKey]) {
            const oldEntry = current.controls[controlKey], nextEntry = record.controls[controlKey];
            invariant(oldEntry.contract === nextEntry.contract && oldEntry.digest === nextEntry.digest
              && canonical(oldEntry.command) === canonical(nextEntry.command), 'A2A_CONTROL_IDEMPOTENCY_CONFLICT');
          }
          const admission = controlKey && record.controls?.[controlKey];
          const admitting = admission?.phase === 'sending' && current.controls?.[controlKey]?.phase !== 'sending';
          if (admitting) {
            invariant(!a2aTerminal.has(previous.state), 'A2A_CONTROL_TASK_ALREADY_TERMINAL');
          }
          if (admitting && admission.command.kind === 'continue') {
            // This is the effect admission point, under the short state lock.
            // A prior queued/unknown cancellation wins even across processes;
            // a cancel admitted AFTER this marker may cancel an in-flight send.
            invariant(!Object.values(current.controls ?? {}).some(entry => entry.command.kind === 'cancel'
              && entry.phase !== 'resolved'), 'A2A_CANCEL_ALREADY_REQUESTED');
            invariant(['input_required', 'auth_required'].includes(previous.state)
              && admission.command.pauseDigest === hash({ state: previous.state, pause: previous.pause ?? null,
                generation: previous.pauseGeneration ?? 0 }), 'A2A_CONTINUATION_NOT_ALLOWED');
          }
          // A stream never owns control entries. Each control publishes only
          // its own command; stale snapshots cannot erase a concurrent intent.
          record.controls = { ...(current.controls ?? {}), ...(controlKey && Object.hasOwn(record.controls ?? {}, controlKey)
            ? { [controlKey]: record.controls[controlKey] } : {}) };
          if (record.phase === 'prepared' && current.phase !== 'prepared') record.phase = current.phase;
          const queuedCancel = controlKey && record.controls[controlKey];
          if (current.phase === 'prepared' && queuedCancel?.command.kind === 'cancel' && queuedCancel.phase === 'queued') {
            record.projection = { ...copy(current.projection), state: 'cancelled' };
            record.phase = 'terminal';
            record.localCancel = { contract: sendAdmission, commandId: queuedCancel.command.commandId, state: 'local_confirmed' };
            queuedCancel.phase = 'resolved';
            queuedCancel.result = { ...a2aControlView(binding, record), commandId: queuedCancel.command.commandId,
              outcome: 'local_cancelled_before_send' };
          }
          if (a2aTerminal.has(record.projection.state)) {
            record.phase = 'terminal'; delete record.error;
            record.result = { state: record.projection.state, task_id: record.platformTaskId,
              output_refs: record.projection.output_refs, snapshots: record.projection.snapshots, item_kinds: record.projection.item_kinds };
          }
        }
        const bytes = canonical(record) + '\n';
        invariant(Buffer.byteLength(bytes) <= 64 * 1024 * 1024, 'A2A_RECORD_LIMIT');
        atomicPrivate(file(request), bytes);
        return true;
      } finally { release(); }
    }
    function commitManaged(request, mutate) {
      storageGuard();
      const release = tryLock(join(directory, `${hash(request.identity)}.state.sqlite`), 5000);
      invariant(release, 'A2A_RECORD_BUSY');
      try {
        const current = readRecord(request);
        invariant(current?.managed?.contract === A2A_INTERNAL_WIRE, 'A2A_INTERNAL_RECORD_REQUIRED');
        mutate(current.managed);
        if (current.managed.taskId) current.platformTaskId = current.managed.taskId;
        const remote = current.managed.remote;
        if (remote?.phase === 'bound') {
          invariant(!current.projection.taskId || current.projection.taskId === remote.id
            && current.projection.contextId === remote.contextId, 'A2A_REMOTE_BINDING_CONFLICT');
          current.projection.taskId = remote.id; current.projection.contextId = remote.contextId;
        }
        const bytes = canonical(current) + '\n'; invariant(Buffer.byteLength(bytes) <= 64 * 1024 * 1024, 'A2A_RECORD_LIMIT');
        atomicPrivate(file(request), bytes);
      } finally { release(); }
    }
    const internalWire = internal ? createInternalA2AWire({ controlPlane: internal, readRecord, commit: commitManaged,
      validateRoute: url => endpoint(url, allowPrivate, true), publicEgressEnabled }) : null;
    function privateWireError(error) {
      const safe = new Set(['A2A_CANCEL_UNSUPPORTED', 'A2A_REMOTE_BINDING_CONFLICT', 'A2A_INTERNAL_BIND_OUTCOME_UNKNOWN',
        'A2A_CONTROL_PLANE_AUTHORITY_LOST', 'A2A_CONTROL_AUTHORITY_LOST', 'A2A_OWNER_CLOSED', 'A2A_OWNER_CHANGED',
        'A2A_CONTROL_REQUEST_DRIFTED', 'A2A_WORKLOAD_TOKEN_INVALID']);
      invariant(false, safe.has(error?.code) ? error.code : 'A2A_REMOTE_HTTP_FAILED');
    }
    async function wire(...args) {
      if (!internal) return wireUnsafe(...args);
      try { return await wireUnsafe(...args); } catch (error) { privateWireError(error); }
    }
    async function wireUnsafe(request, method, params, signal, streaming = false, authority = () => check(request[dsh ? 'dsh' : 'native'], signal), commandId) {
      authority();
      const prepared = internalWire ? await internalWire.prepare(request, method, params, signal,
        () => { authority(); return true; }, commandId) : null;
      const route = prepared?.route ?? request.route;
      const actualStreaming = streaming && !prepared?.existingInitialTask && (!prepared || route.streaming);
      if (prepared) { method = prepared.method; params = prepared.params; }
      if (method === 'SendStreamingMessage' && !actualStreaming) method = 'SendMessage';
      const url = endpoint(route.url, allowPrivate, Boolean(prepared)), rpc = route.protocolBinding === 'JSONRPC';
      const id = randomUUID();
      const rest = method === 'GetTask' ? { method: 'GET', path: `/tasks/${encodeURIComponent(params.id)}` }
        : method === 'CancelTask' ? { method: 'POST', path: `/tasks/${encodeURIComponent(params.id)}:cancel` }
        : { method: 'POST', path: actualStreaming ? '/message:stream' : '/message:send' };
      const body = rpc ? canonical({ jsonrpc: '2.0', id, method, params }) : rest.method === 'GET' ? undefined : canonical(params);
      const target = new URL(url); if (!rpc) target.pathname = target.pathname.replace(/\/$/u, '') + rest.path;
      prepared?.admit(); authority();
      const response = await pinned.fetch(target, { method: rpc ? 'POST' : rest.method, headers: {
        'Content-Type': 'application/json', Accept: actualStreaming ? 'text/event-stream' : 'application/json',
        // Card-driven Python path uses the configured service token for hosted
        // calls; cloud signing credentials are never sent to a card endpoint.
        ...(prepared ? prepared.headers : token && request.route.source === 'hosted' ? { Authorization: `Bearer ${token}` } : {}) }, body, redirect: 'error',
        signal: AbortSignal.any([signal, lifetime.signal, sessionLifetime.signal]) });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        invariant(false, method === 'CancelTask' && [405, 501].includes(response.status) ? 'A2A_CANCEL_UNSUPPORTED' : 'A2A_REMOTE_HTTP_FAILED');
      }
      const unwrap = payload => {
        if (!rpc) return payload;
        invariant(payload?.jsonrpc === '2.0' && payload.id === id, 'A2A_JSONRPC_FAILED');
        if (payload.error) {
          // Only protocol codes are classified. Remote error messages/data may
          // contain credentials and never become local diagnostics.
          const code = method === 'CancelTask' && [-32601, -32002, -32004].includes(payload.error.code)
            ? 'A2A_CANCEL_UNSUPPORTED' : 'A2A_JSONRPC_FAILED';
          invariant(false, code);
        }
        invariant(payload.result, 'A2A_JSONRPC_FAILED');
        return payload.result;
      };
      if (actualStreaming) {
        const stream = a2aSse(response.body, signal);
        if (!prepared) return { stream, unwrap };
        return { stream: (async function* () { try { for await (const event of stream) {
          const payload = unwrap(event.payload); await prepared.observe(payload); yield { ...event, payload };
        } } catch (error) { privateWireError(error); } })(), unwrap: payload => payload };
      }
      const payload = unwrap(await jsonBody(response)); authority(); await prepared?.observe(payload);
      if (streaming) return { stream: (async function* () {
        yield { id: '', payload: prepared?.existingInitialTask ? { task: payload } : payload };
      })(), unwrap: value => value };
      return payload;
    }
    const control = createA2ATaskControl({ binding, owner, checkOwner, assertControl, authorizeControl,
      signal: AbortSignal.any([lifetime.signal, sessionLifetime.signal]), readIdentity, save, wire,
      lock: (identity, kind) => tryLock(join(directory, `${hash(identity)}${kind === 'cancel' ? '.cancel' : kind === 'get' ? '.read' : ''}.sqlite`)) });
    async function observeReceipt(query) {
      invariant(!dsh && typeof assertReceipt === 'function', 'A2A_RECEIPT_AUTHORITY_REQUIRED');
      const checkReceipt = () => {
        checkOwner(query.signal);
        const current = assertReceipt(query);
        if (current && typeof current.then === 'function') Promise.resolve(current).catch(() => {});
        invariant(current === true, 'A2A_RECEIPT_AUTHORITY_LOST');
      };
      checkReceipt();
      const identity = { scope: fixedScope, sessionId, runId: query.runId,
        operationKey: query.originalOperationKey, callId: query.call.callId };
      const record = readIdentity(identity);
      if (!record) return null;
      const original = record.request.native;
      invariant(original && original.executionFence === query.originalClaimedFence
        && ['sessionId', 'runId', 'turnId', 'buildId', 'parentRunId', 'taskChainId'].every(key => original[key] === query[key])
        && canonical(original.scope) === canonical(query.scope) && canonical(original.call) === canonical(query.call)
        && canonical(original.definition) === canonical(query.definition)
        && original.operationKey === query.originalOperationKey
        && specs.some(spec => canonical(spec) === canonical(record.request.spec)), 'A2A_RECEIPT_SOURCE_CONFLICT');
      if (!record.projection.taskId && !a2aTerminal.has(record.projection.state)) return null;
      const observed = await control.execute({ kind: 'get', commandId: `receipt:${hash(query.operationKey)}`,
        operation_locator: identity, authority: { contract: 'agentkit.native-a2a-receipt-read/v1',
          operationKey: query.operationKey }, signal: query.signal });
      checkReceipt();
      return { ...observed, agent: record.request.spec.target_agent_id };
    }
    async function dispatch({ request, signal }) {
      check(request[dsh ? 'dsh' : 'native'], signal);
      const release = tryLock(join(directory, `${hash(request.identity)}.sqlite`));
      invariant(release, 'A2A_CALL_BUSY');
      let record;
      try {
        check(request[dsh ? 'dsh' : 'native'], signal); record = readRecord(request);
        if (record && record.phase !== 'prepared') return record.result ?? { state: 'unknown', task_id: record.platformTaskId,
          operation_locator: request.identity, error_type: 'A2A_SEND_OUTCOME_UNKNOWN' };
        if (!record) { record = newRecord(request, 'prepared'); save(request, record, undefined, 'prepare'); }
        invariant(record.deadlineAt > Date.now(), 'A2A_SEND_DEADLINE_EXCEEDED');
        check(request[dsh ? 'dsh' : 'native'], signal);
        if (!save(request, record, undefined, 'admit')) return record.result ?? { state: 'unknown', task_id: record.platformTaskId,
          operation_locator: request.identity, error_type: 'A2A_SEND_OUTCOME_UNKNOWN' };
        const projection = createA2AProjection(request.scopeId, record.projection);
        // Once this fsynced marker exists, no replacement may send again,
        // including a crash between intent commit and entering fetch().
        const timeout = record.deadlineAt - Date.now();
        invariant(timeout > 0, 'A2A_SEND_DEADLINE_EXCEEDED');
        const activeSignal = AbortSignal.any([signal, lifetime.signal, sessionLifetime.signal, AbortSignal.timeout(Math.ceil(timeout))]);
        const params = { message: request.message, configuration: { returnImmediately: false } };
        const streaming = request.route.streaming;
        const result = await wire(request, streaming ? 'SendStreamingMessage' : 'SendMessage', params, activeSignal, streaming);
        if (streaming) {
          for await (const event of result.stream) {
            check(request[dsh ? 'dsh' : 'native'], signal); projection.apply(result.unwrap(event.payload), event.id);
            record.projection = projection.snapshot(); save(request, record);
          }
        } else { projection.apply(result); record.projection = projection.snapshot(); save(request, record); }
        // A stream may finish before its remote Task does. Read that original
        // Task; neither a stream reconnect nor a new SendMessage is inferred.
        while (!a2aTerminal.has(record.projection.state) && !['input_required', 'auth_required'].includes(record.projection.state)
          && record.projection.taskId) {
          const task = await wire(request, 'GetTask', { id: record.projection.taskId }, activeSignal);
          check(request[dsh ? 'dsh' : 'native'], signal); projection.task(task); record.projection = projection.snapshot(); save(request, record);
          if (!a2aTerminal.has(record.projection.state)) await new Promise((resolve, reject) => {
            const abort = () => { clearTimeout(timer); reject(activeSignal.reason); };
            const timer = setTimeout(() => { activeSignal.removeEventListener('abort', abort); resolve(); }, 100);
            activeSignal.addEventListener('abort', abort, { once: true }); if (activeSignal.aborted) abort();
          });
        }
        check(request[dsh ? 'dsh' : 'native'], signal);
        const snapshot = record.projection;
        const output = { state: snapshot.state, task_id: record.platformTaskId,
          output_refs: snapshot.output_refs, snapshots: snapshot.snapshots, item_kinds: snapshot.item_kinds };
        record.phase = a2aTerminal.has(snapshot.state) ? 'terminal' : 'paused'; record.result = output;
        save(request, record); return copy(output);
      } catch (error) {
        // Keep the latest checkpoint after abort, timeout, process/service
        // failure. This publication never turns uncertainty into permission
        // to send again. Errors/remote diagnostics cannot expose credentials.
        if (!record || record.phase === 'prepared') throw error;
        if (internal) record = readRecord(request) ?? record;
        record.phase = 'unknown'; record.error = 'A2A_SEND_OUTCOME_UNKNOWN';
        save(request, record);
        if (internal && record.phase === 'terminal') return copy(record.result);
        return { state: 'unknown', task_id: record.platformTaskId,
          operation_locator: request.identity, error_type: 'A2A_SEND_OUTCOME_UNKNOWN' };
      } finally { release(); }
    }
    const exposurePlan = { assertGenericTargetAllowed(target) { invariant(specs.some(spec => spec.target_agent_id === target), 'A2A_TARGET_NOT_BOUND'); } };
    return { discovery: { list: input => list({ ...input, signal: AbortSignal.any([input.signal, sessionLifetime.signal]),
      assertCurrent: () => { checkOwner(input.signal); return true; } }) },
      invocation: { resolve: resolveCall, dispatch }, control, observeReceipt, exposurePlan,
      close: () => sessionLifetime.abort(new Error('A2A_SESSION_CLOSED')),
      bindingDescription: { sourceRef: 'ksadk-python:355059d', sourceDigest: hash({ sourceDigest, hostBinding: binding.bindingDigest }), spaceId, planDigest,
        transport: NATIVE_A2A_PROTOCOL, version: '1.0' } };
  }
  return Object.freeze({ binding, spaceId, forSession, close });
}
