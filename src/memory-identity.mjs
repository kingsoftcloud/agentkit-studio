import { createHash } from 'node:crypto';

/**
 * AICP accepts `AgentUserId` only as `[A-Za-z0-9_-]{1,64}` and forwards the
 * value verbatim. Every identifier this module produces is handed to that field,
 * so the digest width is a wire contract, not a style choice:
 *
 * - 64 is the *maximum*. Filling it exactly leaves nothing for the next person
 *   who needs a prefix; `resource_runtime/memory_provider.py` in ksadk already
 *   records a SessionId submission that grew to 73 characters and was refused.
 * - 32 hex characters are 128 bits, which is collision-safe for any realistic
 *   population of collections, agents and users, and keeps the value at 36.
 *
 * `mp1-` stays: it marks the partition scheme, independent of digest width.
 */
export const MEMORY_PARTITION_PREFIX = 'mp1-';
export const MEMORY_DIGEST_CHARS = 32;
/** AICP's published limit for `AgentUserId` and `SessionId`. */
export const AICP_ID_MAX_LENGTH = 64;
const AICP_SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Keep a caller-provided id when AICP would accept it, otherwise use `replacement`.
 *
 * The unbound legacy memory path has always forwarded the trusted subject id
 * verbatim, and for the common case (an account or subaccount UUID) that is a
 * perfectly good partition name — rewriting it would move existing memories to a
 * different namespace. Anything AICP would refuse (a colon, an ARN, a display
 * name, an over-long value) is replaced instead of being sent to fail remotely.
 */
export function aicpCompatibleId(value, replacement) {
  const raw = String(value ?? '').trim();
  return AICP_SAFE_ID.test(raw) ? raw : String(replacement ?? '');
}

const digest = input => createHash('sha256').update(input).digest('hex').slice(0, MEMORY_DIGEST_CHARS);

/** Shared with context injection: explicit tools must address the same facts. */
export function memorySubjectId(collectionId, userId, agentId = '') {
  const encoded = JSON.stringify(['memory-partition/v1', String(collectionId || ''), String(agentId || ''),
    String(userId || 'studio-anonymous').trim() || 'studio-anonymous']);
  return `${MEMORY_PARTITION_PREFIX}${digest(encoded)}`;
}

function canonical(value) {
  return JSON.stringify(value, Object.keys(value).sort());
}

export function memorySubjectRefV2({ domain = 'cloud', profileId = '', identityNamespace = 'kscloud-iam',
  tenantId = '', resourceAccountId = '', subjectType = 'user', subjectId = '' } = {}) {
  let payload;
  if (domain === 'local') {
    if (!String(profileId).trim()) throw Object.assign(new Error('本机 profile 缺少稳定身份'), { code: 'MEMORY_SUBJECT_REQUIRED' });
    payload = { kind: 'local-profile', profile_id: String(profileId).trim() };
  } else {
    if (!String(resourceAccountId).trim() || !String(subjectId).trim()) {
      throw Object.assign(new Error('托管记忆缺少可信主体'), { code: 'MEMORY_SUBJECT_REQUIRED', status: 403 });
    }
    payload = { identity_namespace: String(identityNamespace), resource_account_id: String(resourceAccountId),
      subject_id: String(subjectId), subject_type: String(subjectType), tenant_id: String(tenantId) };
  }
  // The full 64-character digest is kept on purpose: this is a *pseudonym* of the
  // verified identity and is never sent as an id. It only ever appears inside the
  // partition hash below, so AICP's length limit does not apply to it.
  return `${domain === 'local' ? 'lcl_' : 'aeu_'}${createHash('sha256').update(canonical(payload)).digest('hex')}`;
}

export function memoryPartitionV2({ collectionId, agentId, scope, subjectRef } = {}) {
  if (!String(collectionId).trim() || !String(agentId).trim() || !String(scope).trim() || !String(subjectRef).trim()) {
    throw Object.assign(new Error('memory-v2 分区参数不完整'), { code: 'MEMORY_BINDING_INVALID' });
  }
  const encoded = JSON.stringify(['memory-partition/v2', String(scope), String(collectionId), String(agentId), String(subjectRef)]);
  return `${MEMORY_PARTITION_PREFIX}${digest(encoded)}`;
}

export function resolveMemorySubject({ contract, domain = 'cloud', profileId = '', identityNamespace = 'kscloud-iam',
  tenantId = '', resourceAccountId = '', subjectType = 'user', subjectId = '' } = {}) {
  const version = contract?.partition_version || 'v1';
  if (version === 'v1') return { version, subjectRef: String(subjectId || 'studio-anonymous'), scope: domain === 'cloud' ? String(resourceAccountId || '') : 'local' };
  if (version !== 'v2') throw Object.assign(new Error('不支持的记忆分区版本'), { code: 'MEMORY_PARTITION_VERSION_UNSUPPORTED', status: 409 });
  if (domain === 'local' && contract?.subject_policy === 'agent') {
    throw Object.assign(new Error('本地 v2 不支持 Agent 共享主体'), { code: 'MEMORY_BINDING_INVALID', status: 400 });
  }
  const subjectRef = memorySubjectRefV2({ domain, profileId, identityNamespace, tenantId, resourceAccountId, subjectType, subjectId });
  return { version, subjectRef, scope: domain === 'cloud' ? String(resourceAccountId) : 'local' };
}

export function memorySessionId(sessionId) {
  const raw = String(sessionId || '').trim();
  return raw ? digest(`memory-session/v1|${raw}`) : '';
}
