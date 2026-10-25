/** Durable Teams facts in the original managed command database. Registry
 * records, nonces and callbacks are NOT execution authority. The trusted Host
 * must verify current permits/grants and resolve policy at every actual use. */
import { randomUUID } from 'node:crypto';
import { canonical, copy, invariant, parseNativeJson } from '../../packages/agentkit-harness-core/dist/index.mjs';
import { validatePreparedTeamsContext, validateTeamsCallbackPermit, teamsSessionOwnerDigest } from './native-teams-context-contract.mjs';

export const MANAGED_NATIVE_TEAMS_CONTEXT_CONTRACT = 'agentkit.managed-native-teams-context/v1';
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && value === value.trim() && !value.includes('\0');
const revision = value => Number.isSafeInteger(value) && value >= 1;
const check = condition => invariant(condition, 'NATIVE_TEAMS_CONTEXT_CONFLICT');

export function createManagedNativeTeamsContexts({ db, guard, transaction, target, validateCommand } = {}) {
  // A standalone metadata file cannot impersonate the original Kernel store.
  db.prepare('SELECT command_id FROM managed_commands LIMIT 1').get();
  guard(); db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS managed_teams_identity (id INTEGER PRIMARY KEY CHECK(id=1), incarnation TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS managed_teams_extensions (name TEXT PRIMARY KEY, identity TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS managed_teams_owners (session_id TEXT PRIMARY KEY, digest TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS managed_teams_contexts (context_ref TEXT PRIMARY KEY, session_id TEXT NOT NULL,
        command_id TEXT NOT NULL, idem TEXT NOT NULL, policy_ref TEXT UNIQUE NOT NULL, data TEXT NOT NULL,
        UNIQUE(session_id,command_id), UNIQUE(session_id,idem));
      CREATE TABLE IF NOT EXISTS managed_teams_callbacks (context_ref TEXT NOT NULL, revision INTEGER NOT NULL,
        data TEXT NOT NULL, PRIMARY KEY(context_ref,revision));
      CREATE TABLE IF NOT EXISTS managed_teams_nonces (nonce TEXT PRIMARY KEY, command_id TEXT NOT NULL, idem TEXT NOT NULL);`);
    db.prepare('INSERT OR IGNORE INTO managed_teams_identity VALUES (1,?)').run(randomUUID());
    guard(); db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  const initial = db.prepare('SELECT incarnation FROM managed_teams_identity WHERE id=1').get()?.incarnation;
  invariant(identifier(initial), 'NATIVE_TEAMS_STORE_IDENTITY_MISMATCH');
  function identity(expected) {
    guard();
    invariant(identifier(expected) && expected === initial
      && db.prepare('SELECT incarnation FROM managed_teams_identity WHERE id=1').get()?.incarnation === initial,
    'NATIVE_TEAMS_STORE_IDENTITY_MISMATCH');
    return initial;
  }
  function context(ref) {
    const row = db.prepare('SELECT * FROM managed_teams_contexts WHERE context_ref=?').get(ref);
    if (!row) return null;
    const prepared = validatePreparedTeamsContext(parseNativeJson(row.data), { target, validateCommand });
    invariant(prepared.context_ref === ref && prepared.ref.sessionId === row.session_id && prepared.ref.commandId === row.command_id
      && prepared.ref.idempotencyKey === row.idem && prepared.policy_ref === row.policy_ref, 'NATIVE_TEAMS_STORE_IDENTITY_MISMATCH');
    invariant(db.prepare('SELECT digest FROM managed_teams_owners WHERE session_id=?').get(prepared.ref.sessionId)?.digest
      === teamsSessionOwnerDigest(prepared), 'NATIVE_TEAMS_STORE_IDENTITY_MISMATCH');
    return prepared;
  }
  const api = Object.freeze({ contract: MANAGED_NATIVE_TEAMS_CONTEXT_CONTRACT,
    durable: true, sharedAcrossHosts: false,
    incarnation() { return transaction(() => identity(initial)); },
    ownsSession(sessionId) {
      check(identifier(sessionId)); return transaction(() => { identity(initial);
        return Boolean(db.prepare('SELECT 1 FROM managed_teams_owners WHERE session_id=?').get(sessionId)); });
    },
    put(raw, { expectedIncarnation } = {}) {
      const prepared = validatePreparedTeamsContext(raw, { target, validateCommand }), body = canonical(prepared);
      return transaction(() => {
        identity(expectedIncarnation);
        const ownerDigest = teamsSessionOwnerDigest(prepared);
        // A prepared context cannot take over a Session which already contains
        // ordinary managed work. Product Session ownership is checked again by
        // the eventual trusted ingress/policy composition, never inferred here.
        const ordinary = db.prepare('SELECT data FROM managed_commands WHERE session_id=?').all(prepared.ref.sessionId)
          .some(row => parseNativeJson(row.data).payload.teams_context_ref == null);
        check(!ordinary);
        db.prepare('INSERT OR IGNORE INTO managed_teams_owners VALUES (?,?)').run(prepared.ref.sessionId, ownerDigest);
        check(db.prepare('SELECT digest FROM managed_teams_owners WHERE session_id=?').get(prepared.ref.sessionId)?.digest === ownerDigest);
        db.prepare('INSERT OR IGNORE INTO managed_teams_contexts VALUES (?,?,?,?,?,?)')
          .run(prepared.context_ref, prepared.ref.sessionId, prepared.ref.commandId, prepared.ref.idempotencyKey, prepared.policy_ref, body);
        check(db.prepare('SELECT data FROM managed_teams_contexts WHERE context_ref=?').get(prepared.context_ref)?.data === body);
      });
    },
    get(ref, { expectedIncarnation } = {}) {
      check(identifier(ref)); return transaction(() => { identity(expectedIncarnation); return context(ref); });
    },
    extensionIdentity(name, { expectedIncarnation } = {}) {
      check(identifier(name)); return transaction(() => { identity(expectedIncarnation);
        return db.prepare('SELECT identity FROM managed_teams_extensions WHERE name=?').get(name)?.identity ?? null; });
    },
    bindExtensionIdentity(name, value, { expectedIncarnation } = {}) {
      check(identifier(name) && typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0'));
      return transaction(() => {
        identity(expectedIncarnation);
        db.prepare('INSERT OR IGNORE INTO managed_teams_extensions VALUES (?,?)').run(name, value);
        invariant(db.prepare('SELECT identity FROM managed_teams_extensions WHERE name=?').get(name)?.identity === value,
          'NATIVE_TEAMS_STORE_IDENTITY_MISMATCH');
      });
    },
    registerNonce(nonce, commandId, idempotencyKey, { expectedIncarnation } = {}) {
      check(identifier(nonce) && identifier(commandId) && identifier(idempotencyKey));
      return transaction(() => {
        identity(expectedIncarnation);
        db.prepare('INSERT OR IGNORE INTO managed_teams_nonces VALUES (?,?,?)').run(nonce, commandId, idempotencyKey);
        const row = db.prepare('SELECT * FROM managed_teams_nonces WHERE nonce=?').get(nonce);
        return row.command_id === commandId && row.idem === idempotencyKey;
      });
    },
    putCallback(ref, raw, { expectedIncarnation } = {}) {
      check(identifier(ref)); const permit = validateTeamsCallbackPermit(raw);
      return transaction(() => {
        identity(expectedIncarnation); const prepared = context(ref); check(prepared);
        // This detects cross-context storage errors, not signature authority.
        check(['groupId', 'teamRunId', 'memberId', 'commandId', 'sessionId', 'attemptEpoch', 'leaderEpoch', 'bundleDigest']
          .every(key => permit[key] === prepared.ref[key])
          && permit.agentInstanceId === prepared.command.agent_instance_id && permit.policyDigest === prepared.policy_digest
          && permit.authorityId === prepared.ref.authorityId);
        const previous = db.prepare('SELECT data FROM managed_teams_callbacks WHERE context_ref=? AND revision=?').get(ref, permit.grantRevision);
        if (previous && Date.parse(validateTeamsCallbackPermit(parseNativeJson(previous.data)).expiresAt) >= Date.parse(permit.expiresAt)) return;
        db.prepare('INSERT INTO managed_teams_callbacks VALUES (?,?,?) ON CONFLICT(context_ref,revision) DO UPDATE SET data=excluded.data')
          .run(ref, permit.grantRevision, canonical(permit));
      });
    },
    getCallback(ref, grantRevision, { expectedIncarnation } = {}) {
      check(identifier(ref) && revision(grantRevision)); return transaction(() => {
        identity(expectedIncarnation);
        const row = db.prepare('SELECT data FROM managed_teams_callbacks WHERE context_ref=? AND revision=?').get(ref, grantRevision);
        return row ? copy(validateTeamsCallbackPermit(parseNativeJson(row.data))) : null;
      });
    },
  });
  return { api,
    // Used inside the admission transaction, never by the model or public HTTP.
    reserved(sessionId) { identity(initial); return Boolean(db.prepare('SELECT 1 FROM managed_teams_owners WHERE session_id=?').get(sessionId)); },
  };
}
