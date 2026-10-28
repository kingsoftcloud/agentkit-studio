import { createHash } from 'node:crypto';
import { canonical, invariant } from '@kingsoftcloud/agentkit-harness-core';

// KsADK memory/extraction.py native_user_memory_candidate, reference 355059d.
// Only whole original human statements enter this path. Transcript extraction
// and model/tool assertions intentionally have no candidate authority here.
export const NATIVE_USER_EXTRACTION_POLICY = 'native-original-user-profile/v2';
export const NATIVE_MEMORY_CANDIDATE = 'agentkit.native-memory-candidate/v1';
export const memoryDigest = value => {
  // UTF-8 replacement of a lone UTF-16 surrogate would alias a different
  // original input. Python's strict UTF-8 encoder rejects it as well.
  invariant(typeof value === 'string' && value.isWellFormed(), 'native_memory_text_invalid_unicode');
  return 'sha256:' + createHash('sha256').update(value).digest('hex');
};
const identify = value => memoryDigest(canonical(value)).slice(7);
const explicitPatterns = [/记住[:：]?\s*(.+)/iu, /别忘了[:：]?\s*(.+)/iu,
  /remember\s+(?:that\s+)?(.+)/iu, /请记[:：]?\s*(.+)/iu];
const sessionRetention = /\b(?:for|during|within|in)\s+(?:only\s+)?(?:this|the\s+current)\s+(?:conversation|chat|session|turn)\b|(?:本次|这次|此次|当前|这个|本)(?:会话|对话|聊天)|(?:本轮|这轮)/iu;
const correction = /(?<prefix>(?:我|本人)?喜欢(?<action>吃|喝|用|看|听|玩))(?:的)?(?:是)?\s*(?<new>.+?)\s*(?:，|,)?\s*(?:而)?不是\s*(?<old>.+?)(?:[。.!！]|$)/iu;
const generalCorrection = /(?:以后|今后)?(?<subject>[一-龥A-Za-z0-9]{1,12})?(?:请)?(?:不要|别)(?<old>.{1,20}?)[，,]?(?:请)?(?:改成|改为|换成|改用)(?<new>.+?)(?:[。.!！]|$)/iu;
const hobby = /(?:我|本人)?的?爱好(?<correction>其实|现在|改)?(?:是|改成|变成)\s*(?<value>.+?)(?:[。.!！]|$)/iu;
const implicitPatterns = [/(?:我|本人)?的?偏好(?:是|为)\s*(.+?)(?:[。.!！]|$)/iu,
  /(?:我|本人)?(?:平时)?(?:喜欢|习惯)(吃|喝|用|看|听|玩)\s*(.+?)(?:[。.!！]|$)/iu];
const full = (pattern, text) => { const match = pattern.exec(text); return match?.index === 0 && match[0].length === text.length ? match : null; };
const edgePunctuation = value => value.trim().replace(/^[。.，,]+|[。.，,]+$/gu, '');
const correctedContent = value => value.trim().replace(/^[。.，, ]+|[。.，, ]+$/gu, '');
const sessionOnly = text => sessionRetention.test(text.trim().split(/[。！？!?\r\n]|\.(?=\s|$)/u, 1)[0]);

export function deriveMemoryProfileSlotKey(content) {
  if (hobby.test(content)) return 'profile.preference.hobby';
  const action = /(?:我|本人)?喜欢(?<action>吃|喝|用|看|听|玩)/iu.exec(content)?.groups.action;
  return action ? 'profile.preference.' + ({ 吃: 'food', 喝: 'drink', 用: 'tool', 看: 'viewing', 听: 'listening', 玩: 'activity' })[action] : '';
}

export function isExplicitMemoryInstruction(value) {
  const text = value.trim();
  if (sessionOnly(text)) return false;
  return explicitPatterns.some(pattern => full(pattern, text)) || !!full(correction, text)
    || !!full(generalCorrection, text) || !!full(hobby, text)?.groups.correction;
}

/** Stable candidate identity is versioned; it need not reproduce Python JSON bytes. */
export function nativeUserMemoryCandidate({ text, sourceEventId, scope, scopeId }) {
  invariant(typeof text === 'string' && text.isWellFormed() && typeof sourceEventId === 'string' && sourceEventId.isWellFormed()
    && ['user', 'agent', 'workspace', 'org'].includes(scope) && typeof scopeId === 'string', 'native_memory_candidate_invalid');
  text = text.trim();
  const explicit = isExplicitMemoryInstruction(text), hobbyMatch = full(hobby, text);
  if (!sourceEventId.trim() || !(explicit || implicitPatterns.some(pattern => full(pattern, text)) || hobbyMatch)) return null;
  let content, operation = 'add', reason, importance;
  const changedHobby = hobby.exec(text), general = generalCorrection.exec(text), preference = correction.exec(text);
  // Preserve the reference's implicit hobby fallback after its legacy extractor
  // declined a session-scoped statement. This is still only an observation.
  if (sessionOnly(text)) {
    if (!hobbyMatch || hobbyMatch.groups.correction) return null;
    content = '我的爱好是' + hobbyMatch.groups.value.trim(); reason = 'implicit_user_preference'; importance = .65;
  } else if (changedHobby?.groups.correction) {
    const value = correctedContent(changedHobby.groups.value);
    if (!value) return null;
    content = '我的爱好是' + value; operation = 'update'; reason = 'explicit_user_correction'; importance = .9;
  } else if (general) {
    const subject = (general.groups.subject ?? '').trim(), value = correctedContent(general.groups.new);
    if (!value) return null;
    content = subject + '改为' + value; operation = 'update'; reason = 'explicit_user_correction'; importance = .8;
  } else if (preference) {
    const value = correctedContent(preference.groups.new);
    if (!value) return null;
    content = preference.groups.prefix.trim() + value; operation = 'update'; reason = 'explicit_user_correction'; importance = .9;
  } else {
    const instruction = explicitPatterns.map(pattern => pattern.exec(text)).find(Boolean);
    if (instruction) {
      content = edgePunctuation(instruction[1] || text);
      if (!content) return null;
      reason = 'explicit_user_request'; importance = .8;
    } else {
      const implicit = implicitPatterns.map(pattern => pattern.exec(text)).find(Boolean);
      if (implicit) content = edgePunctuation(implicit[0]);
      else if (hobbyMatch && !hobbyMatch.groups.correction) content = '我的爱好是' + hobbyMatch.groups.value.trim();
      else return null;
      reason = 'implicit_user_preference'; importance = .65;
    }
  }
  if (!explicit && reason !== 'implicit_user_preference') return null;
  return { contract: NATIVE_MEMORY_CANDIDATE, extractionPolicy: NATIVE_USER_EXTRACTION_POLICY,
    candidateId: 'candidate_' + identify([NATIVE_MEMORY_CANDIDATE, NATIVE_USER_EXTRACTION_POLICY, scope, scopeId, sourceEventId, operation, content]),
    operation, memoryType: 'profile', scope, scopeId, content, confidence: 1, importance,
    sourceEventIds: [sourceEventId], conflictsWith: [], sensitiveLabels: [], reason,
    slotKey: deriveMemoryProfileSlotKey(content), sensitivity: 'none', expiresAt: '' };
}

export function nativeMemoryScopeBindings(principal, scopes = ['user']) {
  invariant(principal && ['tenantId', 'workspaceId', 'agentId', 'userId'].every(key => typeof principal[key] === 'string'
    && principal[key].trim()), 'native_memory_principal_invalid');
  const { tenantId, workspaceId, agentId, userId } = principal;
  const bindings = { tenant: ['org', [tenantId]], workspace: ['workspace', [tenantId, workspaceId]],
    agent: ['agent', [tenantId, workspaceId, agentId]], user: ['user', [tenantId, workspaceId, agentId, userId]] };
  invariant(Array.isArray(scopes) && scopes.every(scope => Object.hasOwn(bindings, scope)), 'native_memory_scope_invalid');
  return [...new Set(scopes)].map(name => ({ scope: bindings[name][0],
    scopeId: 'native-memory-v1:' + identify([name, ...bindings[name][1]]) }));
}

const secretPatterns = [[/api[_-]?key\s*[:=]\s*\S+/iu, 'api_key'], [/secret[_-]?key\s*[:=]\s*\S+/iu, 'secret_key'],
  [/access[_-]?key\s*[:=]\s*\S+|AKIA[0-9A-Z]{16}/iu, 'access_key'], [/cookie\s*[:=]\s*\S+/iu, 'cookie'],
  [/authorization\s*[:=]\s*bearer\s+\S+/iu, 'auth_header'], [/https?:\/\/\S+?(?:X-Amz-Signature|X-Amz-Security-Token|signed)=/iu, 'signed_url'],
  [/(postgres|mysql|mongodb|redis):\/\/\S+:\S+@\S+/iu, 'dsn'], [/sk-[A-Za-z0-9]{20,}/iu, 'token']];
export function nativeMemorySensitiveLabels(content, supplied = []) {
  return [...new Set([...supplied.filter(label => label && label !== 'none'),
    ...secretPatterns.filter(([pattern]) => pattern.test(content)).map(([, label]) => label)])].sort();
}

/** Candidate decisions grant no execution authority; provider commits separately. */
export function evaluateNativeMemoryCandidate(candidate, { existing = null, observations = 1 } = {}) {
  const labels = nativeMemorySensitiveLabels(candidate.content, candidate.sensitiveLabels);
  if (labels.length || candidate.sensitivity === 'high') return { decision: 'reject', operation: 'ignore', reason: 'sensitive_label_rejected:' + (labels.join(',') || 'explicit') };
  if (/model_guess|transient|current_plan/iu.test(candidate.reason)) return { decision: 'reject', operation: 'ignore', reason: 'not_durable' };
  const explicit = /explicit|user_request/iu.test(candidate.reason);
  const threshold = explicit ? .6 : observations < 2 ? Infinity : .85;
  if (candidate.confidence < threshold) return { decision: 'pending', operation: candidate.operation,
    reason: `below_threshold:${candidate.confidence.toFixed(2)}<${Number.isFinite(threshold) ? threshold.toFixed(2) : 'inf'}` };
  return { decision: 'commit', operation: existing ? 'update' : candidate.operation,
    reason: existing ? 'conflict_supersede' : 'threshold_met' };
}
