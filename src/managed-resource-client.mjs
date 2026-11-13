/** Resource-only transport for a platform-owned Agent version. No AK/SK. */
import { hostFetch } from './http-fetch.mjs';

const actions = new Set(['RetrieveKnowledge', 'QueryMemorySdk', 'CreateMemorySdk', 'GetMCP']);
const skillActions = new Set(['ListSkillsBySpaceId', 'GetSkillDownloadUrl', 'GetPremadeSkillDownloadUrl']);
// CreateMemorySdk is a mutating AICP submission. It intentionally stays out of
// the transport retry loop until the service exposes a durable idempotency
// contract for ordinary writes. Durable callers still pass their request id,
// but the Host must not infer that the service de-duplicates it.
const nonRetryableActions = new Set(['CreateMemorySdk']);
// A transient resource-server fault is worth two more attempts; 4xx responses
// are deterministic (revoked access, a stale snapshot or a bad request) and
// must never be replayed. The third backoff is available when a caller raises
// maxAttempts for a more tolerant deployment.
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAYS_MS = Object.freeze([200, 600, 1500]);
const SNAPSHOT_MISSING_CODE = 'DSH_RESOURCE_OWNER_UNAVAILABLE';

class ManagedResourceError extends Error {
  constructor(code, status = 0, details = {}) {
    super('托管资源请求未完成，请核对资源权限和部署版本');
    this.name = 'ManagedResourceError';
    this.code = code;
    this.status = status;
    Object.assign(this, details);
  }
}
const fail = (code, status = 0, details = {}) => { throw new ManagedResourceError(code, status, details); };

function retryPolicy(maxAttempts, retryDelaysMs) {
  const attempts = Number(maxAttempts);
  if (!Number.isInteger(attempts) || attempts < 1) throw new TypeError('maxAttempts 必须是正整数');
  if (!Array.isArray(retryDelaysMs) || retryDelaysMs.some(delay => !Number.isFinite(Number(delay)) || Number(delay) < 0)) {
    throw new TypeError('retryDelaysMs 必须是非负毫秒数组');
  }
  return { attempts, delays: retryDelaysMs.map(Number) };
}

async function waitForRetry(ms, signal) {
  if (!ms) return;
  if (signal?.aborted) fail('REQUEST_CANCELLED');
  await new Promise(resolve => {
    let timer;
    const onAbort = () => { clearTimeout(timer); resolve(); };
    signal?.addEventListener?.('abort', onAbort, { once: true });
    if (signal?.aborted) { onAbort(); return; }
    timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, ms);
  });
  if (signal?.aborted) fail('REQUEST_CANCELLED');
}

async function discardBody(response) {
  try { await response.body?.cancel(); } catch { /* the response is already being retired */ }
}

// Only a 409 needs its body inspected: FastAPI renders the resource code as
// `{"detail":"DSH_RESOURCE_OWNER_UNAVAILABLE"}`. Bound the read so a damaged
// error response cannot stall the turn or allocate without limit.
async function readErrorBody(response, limit = 64 * 1024) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) { await reader.cancel().catch(() => {}); break; }
      chunks.push(value);
    }
  } catch { return ''; }
  finally { try { reader.releaseLock(); } catch { /* already released */ } }
  return Buffer.concat(chunks).toString('utf8');
}

async function readEnvelope(response, cancelSignal) {
  let envelope;
  const reader = response.body?.getReader(), chunks = [];
  let bytes = 0;
  try {
    if (!reader) fail('MANAGED_RESOURCE_RESPONSE_INVALID');
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 2 * 1024 * 1024) { await reader.cancel(); fail('MANAGED_RESOURCE_RESPONSE_INVALID'); }
      chunks.push(value);
    }
    envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    if (error instanceof ManagedResourceError) throw error;
    fail(cancelSignal?.aborted ? 'REQUEST_CANCELLED' : 'MANAGED_RESOURCE_RESPONSE_INVALID');
  }
  finally { reader?.releaseLock(); }
  if (envelope?.Code !== 0 || !Object.hasOwn(envelope, 'Data')) fail('MANAGED_RESOURCE_RESPONSE_INVALID');
  return { data: envelope.Data, requestId: String(envelope.RequestId || '') };
}

export function managedResourceServerRoot(env) {
  let base;
  try { base = new URL(env.AGENTENGINE_RESOURCE_SERVER_URL); } catch { /* rejected below */ }
  if (!base || !['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || base.pathname !== '/') {
    fail('MANAGED_RESOURCE_SERVER_UNAVAILABLE');
  }
  return base;
}

export function managedResourcesNeedServer(resources = {}) {
  return Boolean(resources.knowledge_base || resources.memory || resources.skill_space || resources.skill_spaces?.length
    || resources.mcp_servers?.some(item => !item.endpoint));
}

export function createManagedResourceClient({
  runtime, env, fetchImpl = hostFetch, timeoutMs = 60000,
  getResourcePermit, getResourceSignal,
  maxAttempts = DEFAULT_MAX_ATTEMPTS, retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
}) {
  const resources = runtime.declaration?.resources || {};
  const spaces = new Set((resources.skill_spaces || (resources.skill_space ? [resources.skill_space] : [])).map(item => item.id));
  const policy = retryPolicy(maxAttempts, retryDelaysMs);
  async function call(allowed, action, payload = {}, { signal, requestId } = {}) {
    if (!allowed.has(action)) fail('MANAGED_RESOURCE_ACTION_NOT_ALLOWED');
    if (requestId !== undefined && (typeof requestId !== 'string'
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(requestId))) fail('INVALID_REQUEST_ID');
    const base = managedResourceServerRoot(env);
    const { agentId, versionId, manifestSha256 } = runtime.identity;
    const token = env.AGENTKIT_RUNTIME_TOKEN;
    if (!token || !agentId || !versionId || !/^[a-f0-9]{64}$/.test(manifestSha256)) fail('MANAGED_RESOURCE_IDENTITY_INVALID');
    const url = new URL(`/agentengine/internal/v1/dsh/agents/${encodeURIComponent(agentId)}/resources/${action}`, base);
    const resourcePermit = ['QueryMemorySdk', 'CreateMemorySdk'].includes(action) ? getResourcePermit?.() : '';
    if (['QueryMemorySdk', 'CreateMemorySdk'].includes(action) && !resourcePermit) fail('MANAGED_RESOURCE_PERMIT_REQUIRED');
    const scopedSignal = resourcePermit ? getResourceSignal?.() : undefined;
    const cancelSignal = signal && scopedSignal ? AbortSignal.any([signal, scopedSignal]) : signal || scopedSignal;
    const retryable = !nonRetryableActions.has(action);
    for (let attempt = 1; attempt <= policy.attempts; attempt++) {
      let response;
      try {
        response = await fetchImpl(url, { method: 'POST', redirect: 'error',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json',
            Authorization: `Bearer ${token}`, 'X-AgentEngine-Target-Version-Id': versionId,
            'X-AgentEngine-Manifest-Sha256': manifestSha256,
            ...(requestId ? { 'X-Ksc-Request-Id': requestId } : {}),
            ...(resourcePermit ? { 'X-AgentEngine-Resource-Permit': resourcePermit } : {}) },
          body: JSON.stringify(payload),
          signal: cancelSignal ? AbortSignal.any([cancelSignal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
        });
      } catch {
        if (cancelSignal?.aborted) fail('REQUEST_CANCELLED');
        // Timeouts and socket/connection errors surface as a fetch rejection.
        if (!retryable || attempt === policy.attempts) fail('MANAGED_RESOURCE_SERVER_UNAVAILABLE', 0, { attempts: attempt });
        await waitForRetry(policy.delays[attempt - 1] ?? 0, cancelSignal);
        continue;
      }
      if (response.ok) return readEnvelope(response, cancelSignal);
      if (response.status === 409) {
        const body = await readErrorBody(response);
        fail(body.toUpperCase().includes(SNAPSHOT_MISSING_CODE)
          ? 'MANAGED_RESOURCE_SNAPSHOT_MISSING' : 'MANAGED_RESOURCE_REQUEST_FAILED', 409, { attempts: attempt });
      }
      await discardBody(response);
      // Once access is revoked only an operator can restore it; replaying the
      // request neither fixes the grant nor the frozen snapshot.
      if (response.status === 403) fail('MANAGED_RESOURCE_ACCESS_REVOKED', 403, { attempts: attempt });
      if (response.status !== 429 && response.status < 500) {
        fail('MANAGED_RESOURCE_REQUEST_FAILED', response.status, { attempts: attempt });
      }
      if (!retryable || attempt === policy.attempts) {
        fail('MANAGED_RESOURCE_SERVER_UNAVAILABLE', response.status, { attempts: attempt });
      }
      await waitForRetry(policy.delays[attempt - 1] ?? 0, cancelSignal);
    }
    // The loop always returns or throws; retain a typed fallback for defense in depth.
    fail('MANAGED_RESOURCE_SERVER_UNAVAILABLE', 0, { attempts: policy.attempts });
  }
  async function bindMemoryWriter() {
    const memoryId = runtime.declaration?.resources?.memory?.id;
    if (!memoryId) fail('MANAGED_RESOURCE_MEMORY_UNBOUND');
    // Match the durable writer interface used by Native's post-turn journal.
    // Freeze the deployment endpoint/identity, never a user's live permit.
    // Every dispatch still obtains that permit from its active request scope.
    const fixedRuntime = structuredClone(runtime), fixedEnv = { ...env };
    const origin = managedResourceServerRoot(fixedEnv).origin;
    const client = createManagedResourceClient({ runtime: fixedRuntime, env: fixedEnv,
      fetchImpl, timeoutMs, getResourcePermit, getResourceSignal, maxAttempts, retryDelaysMs });
    return { binding: { contract: 'agentkit.cloud-memory-transport/v1',
      transport: 'agentengine.managed-resource/v1', origin,
      agentId: fixedRuntime.identity.agentId, versionId: fixedRuntime.identity.versionId,
      manifestSha256: fixedRuntime.identity.manifestSha256, memoryId },
      async write(payload, options) {
        if (payload?.MemoryCollectionId !== memoryId) fail('MANAGED_RESOURCE_MEMORY_UNBOUND');
        return client.action('CreateMemorySdk', payload, options);
      } };
  }
  return { action: (name, payload, options) => call(actions, name, payload, options), bindMemoryWriter,
    isBoundSkillSpace: id => spaces.has(id),
    authorizeSkillSpace: id => call(skillActions, 'ListSkillsBySpaceId', { SpaceId: id, PageNumber: 1, PageSize: 1 }),
    skillAction: (name, payload, options) => call(skillActions, name, payload, options) };
}
