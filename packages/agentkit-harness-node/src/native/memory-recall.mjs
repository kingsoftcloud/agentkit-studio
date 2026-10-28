import { invariant } from '@kingsoftcloud/agentkit-harness-core';
import { memoryDigest, nativeMemoryScopeBindings } from './memory-candidate.mjs';

export const NATIVE_MEMORY_RECALL = 'agentkit.native-memory-recall/v1';

// Python 355059d local_sqlite._keyword_query_terms + retrieval.keyword_coverage.
// This is local lexical retrieval, not semantic similarity or fact confidence.
export function nativeMemoryQueryTerms(query) {
  invariant(typeof query === 'string' && query.isWellFormed(), 'native_memory_query_invalid');
  const normalized = query.toLowerCase();
  const ascii = [...new Set(normalized.match(/[a-z0-9][a-z0-9_.-]+/g) ?? [])].slice(0, 16);
  const cjk = [];
  for (const [run] of normalized.matchAll(/[\u3400-\u4dbf\u4e00-\u9fff]+/gu)) {
    for (let index = 0; index < run.length - 1; index++) cjk.push(run.slice(index, index + 2));
  }
  return [...ascii, ...new Set(cjk)].slice(0, ascii.length + 48);
}

export function nativeMemoryKeywordCoverage(query, content) {
  const terms = nativeMemoryQueryTerms(query), lowered = content.toLowerCase();
  return terms.length ? Math.round(terms.filter(term => lowered.includes(term)).length / terms.length * 10000) / 10000 : 0;
}

function instant(value) {
  if (!value) return null;
  invariant(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})?$/u.test(value),
    'native_memory_timestamp_invalid');
  // Reference treats naive datetimes as UTC, independent of the Host timezone.
  const timestamp = Date.parse(/[Zz]|[+-]\d{2}:\d{2}$/u.test(value) ? value : value + 'Z');
  const date = value.slice(0, 10), midnight = Date.parse(date + 'T00:00:00Z');
  invariant(Number.isFinite(timestamp) && Number.isFinite(midnight) && new Date(midnight).toISOString().startsWith(date),
    'native_memory_timestamp_invalid');
  return timestamp;
}

/** Same admission for automatic recall and future explicit search projections.
 * A storage namespace and a historical write receipt do not prove current data.
 */
export function admitNativeMemoryRecords(records, { principal, scopes, now = Date.now() }) {
  invariant(Array.isArray(records) && Number.isFinite(now), 'native_memory_records_invalid');
  const allowed = nativeMemoryScopeBindings(principal, scopes);
  const admitted = [];
  for (const record of records) {
    invariant(record && record.tenantId === principal.tenantId
      && (record.scope === 'org' || record.workspaceId === principal.workspaceId)
      && allowed.some(binding => binding.scope === record.scope && binding.scopeId === record.scopeId), 'native_memory_record_unbound');
    invariant(typeof record.memoryId === 'string' && !!record.memoryId
      && typeof record.content === 'string' && record.content.isWellFormed()
      && record.contentHash === memoryDigest(record.content)
      && Number.isSafeInteger(record.version) && record.version > 0
      && ['none', 'low', 'high'].includes(record.sensitivity)
      && Number.isFinite(record.importance) && record.importance >= 0 && record.importance <= 1,
    'native_memory_record_invalid');
    const from = instant(record.validFrom), until = instant(record.validTo), expiry = instant(record.expiresAt);
    if (record.status !== 'active' || record.sensitivity === 'high' || from !== null && from > now
      || until !== null && until <= now || expiry !== null && expiry <= now) continue;
    admitted.push(record);
  }
  const unique = new Map();
  for (const record of admitted) {
    const previous = unique.get(record.contentHash);
    if (!previous || record.version > previous.version) unique.set(record.contentHash, record);
  }
  return [...unique.values()];
}
