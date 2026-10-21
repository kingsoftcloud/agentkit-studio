import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonical, copy, invariant } from '../../../agentkit-harness-core/dist/index.mjs';
import { NATIVE_MEMORY_CANDIDATE, NATIVE_USER_EXTRACTION_POLICY, nativeMemoryScopeBindings,
  memoryDigest, deriveMemoryProfileSlotKey, evaluateNativeMemoryCandidate, nativeMemorySensitiveLabels } from './memory-candidate.mjs';

export const NATIVE_MEMORY_STORE = 'agentkit.native-memory-store/v1';
const text = value => typeof value === 'string' && !!value.trim();
const sha = value => /^sha256:[a-f0-9]{64}$/u.test(value);
const hash = value => memoryDigest(canonical(value));
const iso = () => new Date().toISOString();

/** Local facts, source-consumption markers and historical effect receipts.
 * Callers own original-user provenance and consent. This database supplies no
 * tool authorization and a past receipt never proves the current fact exists.
 */
export class SqliteNativeMemoryProvider {
  constructor(filename, { principal, scopes = ['user'], busyTimeoutMs = 5000, beforeCommit } = {}) {
    const owner = copy(principal), selected = nativeMemoryScopeBindings(owner, scopes);
    const partition = hash([NATIVE_MEMORY_STORE, owner, selected]);
    const namespace = candidate => {
      invariant(selected.some(binding => binding.scope === candidate.scope && binding.scopeId === candidate.scopeId),
        'native_memory_scope_unbound');
      return hash([owner.tenantId, candidate.scope === 'org' ? null : owner.workspaceId,
        candidate.scope, candidate.scopeId, 'profile']);
    };
    const namespaces = selected.map(binding => namespace(binding));
    invariant(Number.isSafeInteger(busyTimeoutMs) && busyTimeoutMs >= 0, 'invalid_busy_timeout');
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
    const db = new DatabaseSync(filename);
    let closed = false;
    try {
      db.exec(`PRAGMA busy_timeout=${busyTimeoutMs}; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;`);
      db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS memory_schema (version INTEGER PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS memory_records (memory_id TEXT PRIMARY KEY, namespace TEXT NOT NULL, data TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS memory_by_namespace ON memory_records(namespace);
        CREATE TABLE IF NOT EXISTS memory_candidate_sources (
          namespace TEXT NOT NULL, source_event_id TEXT NOT NULL, source_digest TEXT NOT NULL,
          PRIMARY KEY(namespace,source_event_id));
        CREATE TABLE IF NOT EXISTS memory_candidate_observations (
          namespace TEXT NOT NULL, candidate_key TEXT NOT NULL, source_event_id TEXT NOT NULL,
          content_hash TEXT NOT NULL, slot_key TEXT NOT NULL, created_at TEXT NOT NULL,
          PRIMARY KEY(namespace,candidate_key,source_event_id));
        CREATE TABLE IF NOT EXISTS memory_operation_receipts (
          partition TEXT NOT NULL, operation_key TEXT NOT NULL, request_digest TEXT NOT NULL, result TEXT NOT NULL,
          PRIMARY KEY(partition,operation_key));`);
      const versions = db.prepare('SELECT version FROM memory_schema').all();
      if (!versions.length) db.prepare('INSERT INTO memory_schema VALUES (1)').run();
      else invariant(versions.length === 1 && versions[0].version === 1, 'native_memory_schema_unsupported');
      db.exec('COMMIT');
    } catch (error) { try { db.exec('ROLLBACK'); } catch {} db.close(); throw error; }
    const open = () => invariant(!closed, 'native_memory_store_closed');
    const transaction = change => {
      open(); db.exec('BEGIN IMMEDIATE');
      try { const result = change(); beforeCommit?.(); db.exec('COMMIT'); return copy(result); }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    };
    const receipt = (operationKey, requestDigest) => {
      open(); invariant(text(operationKey) && sha(requestDigest), 'native_memory_operation_invalid');
      const prior = db.prepare('SELECT request_digest,result FROM memory_operation_receipts WHERE partition=? AND operation_key=?').get(partition, operationKey);
      if (!prior) return null;
      invariant(prior.request_digest === requestDigest, 'native_memory_operation_conflict');
      return JSON.parse(prior.result);
    };
    const seal = (operationKey, requestDigest, result) => {
      db.prepare('INSERT INTO memory_operation_receipts VALUES (?,?,?,?)').run(partition, operationKey, requestDigest, canonical(result));
      return result;
    };
    const get = memoryId => {
      open(); const row = db.prepare('SELECT namespace,data FROM memory_records WHERE memory_id=?').get(memoryId);
      return row && namespaces.includes(row.namespace) ? JSON.parse(row.data) : null;
    };
    const save = record => {
      db.prepare('INSERT INTO memory_records VALUES (?,?,?) ON CONFLICT(memory_id) DO UPDATE SET data=excluded.data')
        .run(record.memoryId, namespace(record), canonical(record));
    };
    const candidateInput = request => {
      const input = copy(request), candidate = input.candidate;
      invariant(candidate?.contract === NATIVE_MEMORY_CANDIDATE && candidate.extractionPolicy === NATIVE_USER_EXTRACTION_POLICY
        && candidate.memoryType === 'profile' && ['add', 'update'].includes(candidate.operation)
        && /^candidate_[a-f0-9]{64}$/u.test(candidate.candidateId) && text(candidate.content)
        && Number.isFinite(candidate.confidence) && candidate.confidence >= 0 && candidate.confidence <= 1
        && Number.isFinite(candidate.importance) && candidate.importance >= 0 && candidate.importance <= 1
        && Array.isArray(candidate.sourceEventIds) && candidate.sourceEventIds.length === 1 && text(candidate.sourceEventIds[0])
        && Array.isArray(candidate.sensitiveLabels) && candidate.sensitiveLabels.every(label => typeof label === 'string')
        && Array.isArray(candidate.conflictsWith) && candidate.conflictsWith.every(text)
        && typeof candidate.slotKey === 'string' && typeof candidate.reason === 'string'
        && ['none', 'low', 'high'].includes(candidate.sensitivity) && typeof candidate.expiresAt === 'string'
        && text(input.sourceSessionId) && sha(input.sourceDigest) && text(input.operationKey), 'native_memory_candidate_invalid');
      namespace(candidate); return input;
    };
    const source = (candidate, sourceDigest) => {
      const key = namespace(candidate), id = candidate.sourceEventIds[0];
      const previous = db.prepare('SELECT source_digest FROM memory_candidate_sources WHERE namespace=? AND source_event_id=?').get(key, id);
      invariant(!previous || previous.source_digest === sourceDigest, 'native_memory_candidate_source_changed');
      return { key, id, consumed: !!previous };
    };
    const consumeSource = (candidate, sourceDigest) => {
      const { key, id } = source(candidate, sourceDigest);
      db.prepare('INSERT OR IGNORE INTO memory_candidate_sources VALUES (?,?,?)').run(key, id, sourceDigest);
    };
    const discardObservations = record => db.prepare(`DELETE FROM memory_candidate_observations
      WHERE namespace=? AND (content_hash=? OR (slot_key<>'' AND slot_key=?))`)
      .run(namespace(record), record.contentHash, record.metadata.slotKey || deriveMemoryProfileSlotKey(record.content));
    const horizon = (record, original, entries) => {
      const targets = original ? [original, record] : [record];
      const slots = targets.map(target => target.metadata.slotKey || deriveMemoryProfileSlotKey(target.content)).filter(Boolean);
      const hashes = targets.map(target => target.contentHash);
      for (const entry of entries) {
        const { candidate, sourceDigest } = entry;
        invariant(candidate.scope === record.scope && candidate.scopeId === record.scopeId, 'native_memory_horizon_scope_unbound');
        if (!slots.includes(candidate.slotKey) && !hashes.includes(memoryDigest(candidate.content))) continue;
        for (const target of targets) discardObservations(target);
        consumeSource(candidate, sourceDigest);
      }
    };
    this.candidateRequestDigest = request => hash({ contract: NATIVE_MEMORY_STORE, principal: owner, request: candidateInput(request) });
    this.applyCandidate = request => {
      const input = candidateInput(request), { candidate, operationKey, sourceSessionId, sourceDigest } = input;
      const requestDigest = this.candidateRequestDigest(input);
      return transaction(() => {
        const prior = receipt(operationKey, requestDigest); if (prior) return prior;
        const result = (decision, code, observations = 0, record = null, action = null) => seal(operationKey, requestDigest,
          { committed: decision === 'committed', decision, code, observations,
            ...(record ? { memoryId: record.memoryId, version: record.version, status: record.status, contentHash: record.contentHash,
              ...(action ? { action } : {}) } : {}) });
        const early = evaluateNativeMemoryCandidate(candidate);
        if (early.decision === 'reject') return result('rejected', early.reason);
        if ([...candidate.content].length > 8192) return result('rejected', 'candidate_content_over_budget');
        const { key, id, consumed } = source(candidate, sourceDigest), contentHash = memoryDigest(candidate.content);
        const fingerprint = hash([NATIVE_USER_EXTRACTION_POLICY, candidate.slotKey, contentHash]);
        const observed = () => db.prepare(`SELECT source_event_id FROM memory_candidate_observations
          WHERE namespace=? AND candidate_key=? ORDER BY source_event_id`).all(key, fingerprint).map(row => row.source_event_id);
        if (consumed) return result('duplicate_source', 'original_source_already_consumed', observed().length);
        const matches = db.prepare('SELECT data FROM memory_records WHERE namespace=?').all(key).map(row => JSON.parse(row.data))
          .filter(record => record.status === 'active' && (record.contentHash === contentHash
            || !!candidate.slotKey && (record.metadata.slotKey || deriveMemoryProfileSlotKey(record.content)) === candidate.slotKey));
        if (matches.length > 1) return result('rejected', 'candidate_slot_ambiguous');
        const existing = matches[0];
        if (existing?.writePolicy === 'locked') return result('rejected', 'candidate_slot_locked');
        if (candidate.operation !== 'add' && !existing) return result('rejected', 'candidate_correction_target_missing');
        consumeSource(candidate, sourceDigest);
        db.prepare('INSERT INTO memory_candidate_observations VALUES (?,?,?,?,?,?)')
          .run(key, fingerprint, id, contentHash, candidate.slotKey, iso());
        const observations = observed(), evaluated = evaluateNativeMemoryCandidate(candidate, { existing, observations: observations.length });
        if (evaluated.decision !== 'commit') return result(evaluated.decision, evaluated.reason, observations.length);
        if (existing?.contentHash === contentHash) return result('duplicate', 'same_current_fact', observations.length, existing);
        const now = iso(), record = { memoryId: existing?.memoryId ?? 'memory_' + randomUUID(),
          tenantId: owner.tenantId, workspaceId: owner.workspaceId, scope: candidate.scope, scopeId: candidate.scopeId, memoryType: 'profile',
          content: candidate.content, summary: candidate.content, contentHash, status: 'active',
          confidence: candidate.confidence, importance: candidate.importance, sensitivity: candidate.sensitivity,
          sourceSessionId: existing?.sourceSessionId ?? sourceSessionId,
          sourceEventIds: [...new Set([...(existing?.sourceEventIds ?? []), ...observations])],
          version: (existing?.version ?? 0) + 1, validFrom: existing?.validFrom ?? now, validTo: '', expiresAt: candidate.expiresAt,
          createdAt: existing?.createdAt ?? now, updatedAt: now,
          writePolicy: existing?.writePolicy ?? (candidate.reason.startsWith('explicit_user') ? 'user_confirm' : 'auto'),
          metadata: { ...(existing?.metadata ?? {}), slotKey: candidate.slotKey, extractionPolicy: NATIVE_USER_EXTRACTION_POLICY,
            mutationSessionId: sourceSessionId, sourceInputDigest: sourceDigest } };
        save(record); return result('committed', evaluated.reason, observations.length, record, existing ? 'correct' : 'remember');
      });
    };
    this.mutationRequestDigest = request => hash({ contract: NATIVE_MEMORY_STORE, principal: owner, mutation: request });
    this.mutate = request => {
      const input = copy(request), { action, memoryId, expectedVersion, operationKey, content, sourceEventId, sourceSessionId } = input;
      invariant(['correct', 'forget'].includes(action) && text(memoryId) && text(operationKey)
        && Number.isSafeInteger(expectedVersion) && expectedVersion > 0 && text(sourceEventId) && text(sourceSessionId)
        && (action === 'forget' ? content === undefined : text(content)), 'native_memory_mutation_invalid');
      const entries = (input.horizon ?? []).map(entry => candidateInput({ ...entry, sourceSessionId, operationKey }));
      const requestDigest = this.mutationRequestDigest(input);
      return transaction(() => {
        const prior = receipt(operationKey, requestDigest); if (prior) return prior;
        const original = get(memoryId);
        invariant(original && original.status === 'active' && original.version === expectedVersion, 'native_memory_version_or_identity_conflict');
        invariant(original.writePolicy !== 'locked', 'native_memory_slot_locked');
        if (action === 'correct') invariant(!nativeMemorySensitiveLabels(content).length && [...content].length <= 8192,
          'native_memory_content_rejected');
        const record = { ...original, content: action === 'forget' ? '' : content,
          summary: action === 'forget' ? '' : content, contentHash: memoryDigest(action === 'forget' ? '' : content),
          status: action === 'forget' ? 'deleted' : 'active', version: original.version + 1, updatedAt: iso(),
          sourceEventIds: [...new Set([...original.sourceEventIds, sourceEventId])],
          metadata: action === 'forget' ? {} : { ...original.metadata, slotKey: deriveMemoryProfileSlotKey(content), mutationSessionId: sourceSessionId } };
        horizon(record, original, entries);
        if (action === 'forget') discardObservations(original);
        save(record);
        return seal(operationKey, requestDigest, { committed: true, action, memoryId, version: record.version,
          status: record.status, contentHash: record.contentHash, sourceEventIds: record.sourceEventIds });
      });
    };
    this.receipt = (operationKey, requestDigest) => copy(receipt(operationKey, requestDigest));
    this.get = memoryId => copy(get(memoryId));
    this.list = ({ limit = 64, includeDeleted = false } = {}) => {
      open(); invariant(Number.isSafeInteger(limit) && limit > 0 && limit <= 1000, 'native_memory_list_invalid');
      if (!namespaces.length) return [];
      return db.prepare(`SELECT data FROM memory_records WHERE namespace IN (${namespaces.map(() => '?').join(',')})
        ${includeDeleted ? '' : "AND json_extract(data,'$.status')='active'"} ORDER BY rowid LIMIT ?`)
        .all(...namespaces, limit).map(row => JSON.parse(row.data));
    };
    this.close = () => { if (!closed) { closed = true; db.close(); } };
  }
}
