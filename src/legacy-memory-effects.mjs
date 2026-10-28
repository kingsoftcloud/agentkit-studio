/** Host-neutral Memory effects. The caller supplies actual Native or DSH identity
 * and current authority; this store creates neither Runs nor leases. A pending
 * intent is never automatically dispatched again, including after process death.
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { canonical, copy, invariant, parseNativeJson } from '@kingsoftcloud/agentkit-harness-core';
import { createPrivate, privateDirectory, privateFile } from '@kingsoftcloud/agentkit-harness-node/native/local-command-state';

export const LEGACY_MEMORY_EFFECTS = 'agentkit.legacy-memory-effects/v1';
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
const identityOf = path => { const stat = lstatSync(path); return `${stat.dev}:${stat.ino}`; };
const object = value => value && typeof value === 'object' && !Array.isArray(value);

/** Inspect an existing original intent. Never create a journal or dispatch work. */
export function readLegacyMemoryEffect(root, owner) {
  invariant(object(owner) && ['native', 'dsh'].includes(owner.kind) && object(owner.identity), 'legacy_memory_effect_unbound');
  try { privateDirectory(root); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const file = join(root, 'effects.sqlite');
  if (!privateFile(file, true)) return null;
  const directoryIdentity = identityOf(root), fileIdentity = identityOf(file);
  const guard = () => {
    privateDirectory(root); privateFile(file);
    invariant(identityOf(root) === directoryIdentity && identityOf(file) === fileIdentity, 'legacy_memory_effect_store_changed');
    for (const suffix of ['-journal', '-wal', '-shm']) privateFile(file + suffix, true);
  };
  guard(); const db = new DatabaseSync(file, { readOnly: true });
  try {
    guard(); db.exec('PRAGMA busy_timeout=5000; PRAGMA query_only=ON;');
    const versions = db.prepare('SELECT version FROM legacy_memory_schema').all();
    invariant(versions.length === 1 && versions[0].version === 1, 'legacy_memory_effect_schema_unsupported');
    const identity = digest({ kind: owner.kind, identity: owner.identity });
    const row = db.prepare('SELECT * FROM legacy_memory_effects WHERE identity=?').get(identity);
    guard(); if (!row) return null;
    const sealed = parseNativeJson(row.request);
    invariant(sealed.contract === LEGACY_MEMORY_EFFECTS && canonical(sealed.owner) === canonical(owner)
      && ['prepared', 'finished'].includes(row.phase), 'legacy_memory_effect_identity_conflict');
    return { identity, request: sealed.request, binding: sealed.binding, phase: row.phase,
      prepared: parseNativeJson(row.prepared), result: row.phase === 'finished' ? parseNativeJson(row.result) : null,
      createdAt: row.created_at, completedAt: row.completed_at };
  } finally { db.close(); }
}

export class LegacyMemoryEffects {
  constructor(root) {
    privateDirectory(root, true);
    const directoryIdentity = identityOf(root), file = join(root, 'effects.sqlite');
    if (!existsSync(file)) { try { createPrivate(file); } catch (error) { if (error.code !== 'EEXIST') throw error; } }
    privateFile(file); const fileIdentity = identityOf(file);
    let closed = false;
    const guard = () => {
      invariant(!closed, 'legacy_memory_effect_store_closed'); privateDirectory(root); privateFile(file);
      invariant(identityOf(root) === directoryIdentity && identityOf(file) === fileIdentity, 'legacy_memory_effect_store_changed');
      for (const suffix of ['-journal', '-wal', '-shm']) privateFile(file + suffix, true);
    };
    guard(); const db = new DatabaseSync(file);
    try {
      guard(); db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS legacy_memory_effects (
          identity TEXT PRIMARY KEY, request TEXT NOT NULL, phase TEXT NOT NULL,
          prepared TEXT NOT NULL, result TEXT, created_at INTEGER NOT NULL, completed_at INTEGER);
        CREATE TABLE IF NOT EXISTS legacy_memory_schema (version INTEGER PRIMARY KEY);
        INSERT OR IGNORE INTO legacy_memory_schema VALUES(1);`);
      const versions = db.prepare('SELECT version FROM legacy_memory_schema').all();
      invariant(versions.length === 1 && versions[0].version === 1, 'legacy_memory_effect_schema_unsupported');
    } catch (error) { db.close(); throw error; }
    const transaction = work => {
      guard(); db.exec('BEGIN IMMEDIATE');
      try { const result = work(); guard(); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    };
    const unknown = () => ({ status: 'uncertain', content: { ok: false, status: 'outcome_unknown',
      error_type: 'legacy_memory_outcome_unknown', evidence_incomplete: true,
      message: '记忆调用结果尚未确认，请核对原调用；不会自动重复提交。' } });
    this.guard = guard;
    this.close = () => { if (!closed) { closed = true; db.close(); } };
    this.execute = async ({ owner, request, binding, signal, assertCurrent, prepare, dispatch }) => {
      invariant(signal instanceof AbortSignal && typeof assertCurrent === 'function' && typeof prepare === 'function'
        && typeof dispatch === 'function' && object(owner) && ['native', 'dsh'].includes(owner.kind)
        && object(owner.identity) && Object.keys(owner.identity).length > 0 && object(request) && object(binding),
      'legacy_memory_effect_unbound');
      const sealedOwner = canonical(owner), sealed = canonical({ contract: LEGACY_MEMORY_EFFECTS, owner, request, binding }),
        key = digest({ kind: owner.kind, identity: owner.identity });
      const authority = () => {
        guard(); signal.throwIfAborted(); const current = assertCurrent();
        if (current && typeof current.then === 'function') Promise.resolve(current).catch(() => {});
        invariant(current === true && canonical(owner) === sealedOwner
          && canonical({ contract: LEGACY_MEMORY_EFFECTS, owner, request, binding }) === sealed, 'legacy_memory_effect_authority_lost');
        signal.throwIfAborted();
      };
      authority();
      const admitted = transaction(() => {
        authority(); const old = db.prepare('SELECT * FROM legacy_memory_effects WHERE identity=?').get(key);
        if (old) {
          invariant(old.request === sealed && ['prepared', 'finished'].includes(old.phase), 'legacy_memory_effect_identity_conflict');
          return { previous: true, result: old.phase === 'finished' ? parseNativeJson(old.result) : unknown() };
        }
        // prepare is synchronous and side-effect free. Store exact random IDs,
        // timestamps and external DTOs, not a recipe that creates them later.
        const prepared = prepare();
        invariant(object(prepared) && typeof prepared.then !== 'function', 'legacy_memory_effect_preparation_invalid');
        const encoded = canonical(prepared); parseNativeJson(encoded); authority();
        db.prepare('INSERT INTO legacy_memory_effects VALUES(?,?,?,?,?,?,?)')
          .run(key, sealed, 'prepared', encoded, null, Date.now(), null);
        return { previous: false, prepared: parseNativeJson(encoded) };
      });
      if (admitted.previous) { authority(); return copy(admitted.result); }
      let result;
      try { authority(); result = await dispatch(copy(admitted.prepared), authority); authority(); }
      catch { result = unknown(); }
      // Losing authority after dispatch cannot publish success. The immutable
      // uncertain receipt still records that this original call must not replay.
      try {
        transaction(() => {
          const row = db.prepare('SELECT request,phase FROM legacy_memory_effects WHERE identity=?').get(key);
          invariant(row?.request === sealed && row.phase === 'prepared', 'legacy_memory_effect_identity_conflict');
          const encoded = canonical(result); parseNativeJson(encoded);
          db.prepare('UPDATE legacy_memory_effects SET phase=?,result=?,completed_at=? WHERE identity=?')
            .run('finished', encoded, Date.now(), key);
        });
      } catch { return unknown(); }
      return copy(result);
    };
  }
}
