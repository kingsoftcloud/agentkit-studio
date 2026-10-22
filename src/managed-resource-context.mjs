/** Per-request memory permits stay in Host memory, outside provider input and durable state. */
import { AsyncLocalStorage } from 'node:async_hooks';

const denied = () => Object.assign(new Error('托管记忆请求缺少可信业务授权'), { code: 'MANAGED_RESOURCE_PERMIT_REQUIRED', status: 403 });

export function createManagedResourceContext(runtime) {
  const storage = new AsyncLocalStorage();
  const memoryId = runtime.declaration?.resources?.memory?.id;
  return {
    async run({ headers, subjectDigest, signal } = {}, invoke) {
      if (!memoryId) return invoke();
      const permit = headers?.['x-agentengine-resource-permit'];
      let claims;
      try {
        if (typeof permit !== 'string' || permit.length > 4096 || !/^drp1\.[A-Za-z0-9_-]+\.[a-f0-9]{64}$/.test(permit)) throw denied();
        claims = JSON.parse(Buffer.from(permit.split('.')[1], 'base64url').toString('utf8'));
      } catch { throw denied(); }
      // This is consistency checking, not signature verification. Only the
      // control-plane resource endpoint verifies the signature and grants access.
      if (claims.format !== 'agentengine.dsh-memory-permit/v1' || claims.agent_id !== runtime.identity.agentId
        || claims.version_id !== runtime.identity.versionId || claims.manifest_sha256 !== runtime.identity.manifestSha256
        || claims.memory_id !== memoryId || claims.subject_digest !== subjectDigest
        || !Number.isSafeInteger(claims.expires_at) || claims.expires_at <= Date.now() / 1000 || signal?.aborted) throw denied();
      const context = { permit, active: true, signal };
      try { return await storage.run(context, invoke); }
      finally { context.active = false; }
    },
    permit() {
      const context = storage.getStore();
      if (!context?.active || context.signal?.aborted) throw denied();
      return context.permit;
    },
    signal() {
      const context = storage.getStore();
      if (!context?.active) throw denied();
      return context.signal;
    },
  };
}
