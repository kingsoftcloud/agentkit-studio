import { createHash } from 'node:crypto';

/** Shared with context injection: explicit tools must address the same facts. */
export function memorySubjectId(collectionId, userId, agentId = '') {
  const encoded = JSON.stringify(['memory-partition/v1', String(collectionId || ''), String(agentId || ''),
    String(userId || 'studio-anonymous').trim() || 'studio-anonymous']);
  return `mp1-${createHash('sha256').update(encoded).digest('hex').slice(0, 60)}`;
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
  return `${domain === 'local' ? 'lcl_' : 'aeu_'}${createHash('sha256').update(canonical(payload)).digest('hex')}`;
}

export function memoryPartitionV2({ collectionId, agentId, scope, subjectRef } = {}) {
  if (!String(collectionId).trim() || !String(agentId).trim() || !String(scope).trim() || !String(subjectRef).trim()) {
    throw Object.assign(new Error('memory-v2 分区参数不完整'), { code: 'MEMORY_BINDING_INVALID' });
  }
  const encoded = JSON.stringify(['memory-partition/v2', String(scope), String(collectionId), String(agentId), String(subjectRef)]);
  return `mp1-${createHash('sha256').update(encoded).digest('hex').slice(0, 60)}`;
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
  return raw ? createHash('sha256').update(`memory-session/v1|${raw}`).digest('hex') : '';
}
