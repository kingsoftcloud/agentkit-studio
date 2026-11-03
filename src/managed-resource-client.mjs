/** Resource-only transport for a platform-owned Agent version. No AK/SK. */
import { hostFetch } from './http-fetch.mjs';

const actions = new Set(['RetrieveKnowledge', 'QueryMemorySdk', 'CreateMemorySdk', 'GetMCP']);
const skillActions = new Set(['ListSkillsBySpaceId', 'GetSkillDownloadUrl', 'GetPremadeSkillDownloadUrl']);
const fail = (code, status = 0) => { throw Object.assign(new Error('托管资源请求未完成，请核对资源权限和部署版本'), { code, status }); };

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

export function createManagedResourceClient({ runtime, env, fetchImpl = hostFetch, timeoutMs = 60000, getResourcePermit, getResourceSignal }) {
  const resources = runtime.declaration?.resources || {};
  const spaces = new Set((resources.skill_spaces || (resources.skill_space ? [resources.skill_space] : [])).map(item => item.id));
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
    } catch { fail(cancelSignal?.aborted ? 'REQUEST_CANCELLED' : 'MANAGED_RESOURCE_SERVER_UNAVAILABLE'); }
    if (!response.ok) {
      await response.body?.cancel();
      fail(response.status === 403 ? 'MANAGED_RESOURCE_ACCESS_REVOKED' : 'MANAGED_RESOURCE_REQUEST_FAILED', response.status);
    }
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
    } catch { fail(cancelSignal?.aborted ? 'REQUEST_CANCELLED' : 'MANAGED_RESOURCE_RESPONSE_INVALID'); }
    finally { reader?.releaseLock(); }
    if (envelope?.Code !== 0 || !Object.hasOwn(envelope, 'Data')) fail('MANAGED_RESOURCE_RESPONSE_INVALID');
    return { data: envelope.Data, requestId: String(envelope.RequestId || '') };
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
      fetchImpl, timeoutMs, getResourcePermit, getResourceSignal });
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
