/** Per-request resource permits stay outside provider input and durable state. */
import { AsyncLocalStorage } from 'node:async_hooks';

const denied = () => Object.assign(new Error('托管记忆请求缺少可信业务授权'), { code: 'MANAGED_RESOURCE_PERMIT_REQUIRED', status: 403 });
const ksxcDenied = () => Object.assign(new Error('KSXC 需要当前用户的托管调用许可。'), { code: 'KSXC_CALLER_PERMIT_REQUIRED', status: 403 });

export function createManagedResourceContext(runtime) {
  const storage = new AsyncLocalStorage();
  const memoryId = runtime.declaration?.resources?.memory?.id;
  const ksxc = runtime.identity.runtimeName === 'ksxc';
  const invalid = ksxc ? ksxcDenied : denied;
  return {
    async run({ headers, subjectDigest, signal } = {}, invoke) {
      if (!memoryId && !ksxc) return invoke();
      if (ksxc && !/^[a-f0-9]{64}$/.test(subjectDigest || '')) throw ksxcDenied();
      const permit = headers?.['x-agentengine-resource-permit'];
      let claims;
      try {
        if (typeof permit !== 'string' || permit.length > 4096 || !/^drp1\.[A-Za-z0-9_-]+\.[a-f0-9]{64}$/.test(permit)) throw invalid();
        claims = JSON.parse(Buffer.from(permit.split('.')[1], 'base64url').toString('utf8'));
      } catch { throw invalid(); }
      // This is consistency checking, not signature verification. Only the
      // control-plane resource endpoint verifies the signature and grants access.
      if (!(ksxc ? claims?.format === 'agentengine.ksxc-caller/v1'
        : ['agentengine.dsh-memory-permit/v1', 'agentengine.dsh-memory-permit/v2'].includes(claims?.format))
        || claims.agent_id !== runtime.identity.agentId
        || claims.version_id !== runtime.identity.versionId || claims.manifest_sha256 !== runtime.identity.manifestSha256
        || (claims.memory_id ?? undefined) !== memoryId || claims.subject_digest !== subjectDigest
        || !Number.isSafeInteger(claims.expires_at) || claims.expires_at <= Date.now() / 1000 || signal?.aborted) throw invalid();
      if (claims.format.endsWith('/v2') && (claims.partition_version !== 'v2'
        || typeof claims.subject_ref !== 'string' || !/^aeu_[a-f0-9]{64}$/.test(claims.subject_ref)
        || typeof claims.resource_account_id !== 'string' || !claims.resource_account_id.trim())) throw denied();
      const context = { permit, subjectDigest, active: true, signal };
      try { return await storage.run(context, invoke); }
      finally { context.active = false; }
    },
    permit() {
      const context = storage.getStore();
      if (!memoryId || !context?.active || context.signal?.aborted) throw denied();
      return context.permit;
    },
    ksxcPermit(userId) {
      const context = storage.getStore();
      if (!ksxc || !context?.active || context.signal?.aborted || userId !== `aeu_${context.subjectDigest}`) throw ksxcDenied();
      return context.permit;
    },
    signal() {
      const context = storage.getStore();
      if (!context?.active) throw denied();
      return context.signal;
    },
  };
}
