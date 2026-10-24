/** Trusted Host execution admission. These ports are deliberately absent from
 * the HTTP receiver: a signed enqueue may name a grant, never create one.
 * Grant mutations and command qualification share the command-store transaction.
 * Qualification is not a model effect, lease or permission to replay a tool. */
import { performance } from 'node:perf_hooks';
import { canonical, copy, invariant, parseNativeJson, terminal } from '../../packages/agentkit-harness-core/dist/index.mjs';

export const MANAGED_NATIVE_EXECUTION_GRANTS_CONTRACT = 'agentkit.managed-native-execution-grants/v1';
const validText = value => typeof value === 'string' && value.length > 0 && value === value.trim() && !value.includes('\0');
const positive = value => Number.isSafeInteger(value) && value >= 1;
const specFields = ['grant_id', 'tenant_id', 'agent_instance_id', 'session_id', 'owner_ref', 'attempt_epoch'];
const fail = reason => invariant(false, `execution_grant_${reason}`);
function specification(raw) {
  invariant(raw && typeof raw === 'object' && !Array.isArray(raw)
    && Object.keys(raw).every(key => specFields.includes(key)), 'execution_grant_spec_invalid');
  const spec = copy(raw); spec.attempt_epoch ??= null;
  invariant(specFields.slice(0, -1).every(key => validText(spec[key])) && spec.grant_id.length <= 512
    && (spec.attempt_epoch === null || positive(spec.attempt_epoch)), 'execution_grant_spec_invalid');
  return spec;
}
function absoluteTime(value) {
  const match = typeof value === 'string' && /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-](\d{2}):(\d{2}))$/u.exec(value);
  invariant(match && Number.isFinite(Date.parse(value)), 'execution_grant_expiry_invalid');
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(item => Number(item ?? 0));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  invariant(year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]
    && hour <= 23 && minute <= 59 && second <= 59 && Number(match[8] ?? 0) <= 23 && Number(match[9] ?? 0) <= 59,
  'execution_grant_expiry_invalid');
  return new Date(value).toISOString();
}
export function managedExecutionGrantId(command) {
  const id = command.payload.execution_grant_id;
  if (id == null) {
    invariant(command.payload.execution_grant_attempt_epoch == null, 'execution_grant_id_required'); return null;
  }
  invariant(command.command_type === 'enqueue' && validText(id) && id.length <= 512, 'execution_grant_id_invalid');
  return id;
}

export function createManagedNativeExecutionGrants({ db, guard, transaction, target, clock, hash, wake, readRun,
  monotonic = () => performance.now() } = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS managed_execution_grants (grant_id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS managed_grant_operations (grant_id TEXT NOT NULL, idem TEXT NOT NULL,
      digest TEXT NOT NULL, receipt TEXT NOT NULL, PRIMARY KEY(grant_id,idem));
    CREATE TABLE IF NOT EXISTS managed_command_claims (command_id TEXT PRIMARY KEY, claimed_at TEXT NOT NULL);`);
  // Never reconstructed from persisted deadlines, duplicate receipts or reads.
  const anchors = new Map();
  const now = () => new Date(clock()).toISOString();
  const load = id => { const row = db.prepare('SELECT data FROM managed_execution_grants WHERE grant_id=?').get(id);
    return row ? parseNativeJson(row.data) : null; };
  const claimed = id => Boolean(db.prepare('SELECT 1 FROM managed_command_claims WHERE command_id=?').get(id));
  const persist = record => db.prepare('UPDATE managed_execution_grants SET data=? WHERE grant_id=?').run(canonical(record), record.grant_id);
  function scoped(raw) {
    guard(); const spec = specification(raw);
    invariant(spec.tenant_id === target.tenantId && spec.agent_instance_id === target.agentInstanceId, 'execution_grant_scope_mismatch');
    return spec;
  }
  function exact(spec) {
    const record = load(spec.grant_id);
    if (!record) fail('not_found');
    invariant(specFields.every(key => record[key] === spec[key]), 'execution_grant_scope_mismatch'); return record;
  }
  function budget(seconds) {
    if (seconds == null) return null;
    invariant(typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0, 'execution_grant_ttl_invalid');
    return monotonic() + seconds * 1000;
  }
  function anchor(record, observedDeadline) {
    if (record.expires_at === null) return;
    const deadline = monotonic() + Math.max(0, Date.parse(record.expires_at) - clock());
    anchors.set(record.grant_id, { expiry: record.expires_at, deadline: observedDeadline === null ? deadline : Math.min(deadline, observedDeadline) });
  }
  function localError(record) {
    if (!record || record.expires_at === null) return null;
    const entry = anchors.get(record.grant_id);
    if (!entry || entry.expiry !== record.expires_at) return 'clock_unverified';
    return monotonic() >= entry.deadline ? 'expired' : null;
  }
  const expired = record => record.expires_at !== null && clock() >= Date.parse(record.expires_at);
  function requireActive(record) {
    if (record.state !== 'active') fail(record.state);
    if (expired(record)) fail('expired');
  }
  function requireLive(record) { requireActive(record); const error = localError(record); if (error) fail(error); }
  function commandError(command) {
    const id = managedExecutionGrantId(command); if (id === null) return null;
    const record = load(id);
    if (!record) return 'execution_grant_not_found';
    if (['tenant_id', 'agent_instance_id', 'session_id'].some(key => record[key] !== command[key])) return 'execution_grant_scope_mismatch';
    if (record.state === 'revoked') return 'execution_grant_revoked';
    const epoch = command.payload.execution_grant_attempt_epoch ?? null;
    if (epoch !== record.attempt_epoch || epoch !== null && !positive(epoch)) return 'execution_grant_attempt_epoch_mismatch';
    if (expired(record)) return 'execution_grant_expired';
    const error = localError(record); return error ? `execution_grant_${error}` : null;
  }
  function claimError(row) {
    const command = parseNativeJson(row.data), id = managedExecutionGrantId(command);
    if (id === null) return null;
    const record = load(id), error = commandError(command), qualified = claimed(row.command_id);
    // Legacy qualification survives revocation and suspension, including cold
    // takeover. Expiring grants must remain live even when re-claiming work.
    if (qualified && record?.expires_at === null && (error === null || error === 'execution_grant_revoked')) return null;
    if (error) return error;
    if (record.state === 'suspended') return 'execution_grant_suspended';
    if (qualified) return null;
    return record.admission_allowed ? null : 'execution_grant_admission_paused';
  }
  function qualify(row) {
    return transaction(() => {
      const current = db.prepare('SELECT * FROM managed_commands WHERE command_id=?').get(row.command_id);
      if (!current || current.state !== 'accepted') return false;
      const first = db.prepare("SELECT * FROM managed_commands WHERE session_id=? AND state='accepted' ORDER BY rowid").all(row.session_id)
        .find(candidate => parseNativeJson(candidate.data).command_type === 'enqueue');
      invariant(first?.command_id === row.command_id, 'execution_grant_queued');
      const error = claimError(current); if (error) invariant(false, error);
      db.prepare('INSERT OR IGNORE INTO managed_command_claims VALUES (?,?)').run(row.command_id, now()); return true;
    });
  }
  function readySessions() {
    guard(); const seen = new Set(), ready = [];
    for (const row of db.prepare("SELECT * FROM managed_commands WHERE state='accepted' ORDER BY rowid").all()) {
      if (seen.has(row.session_id) || parseNativeJson(row.data).command_type !== 'enqueue') continue;
      seen.add(row.session_id); if (!claimError(row)) ready.push(row.session_id);
    }
    return ready;
  }
  function inspect(row) {
    const command = parseNativeJson(row.data), id = managedExecutionGrantId(command);
    if (id === null) return null;
    const record = load(id);
    return { contract: MANAGED_NATIVE_EXECUTION_GRANTS_CONTRACT, grantId: id,
      attemptEpoch: record?.attempt_epoch ?? null, state: record?.state ?? 'missing',
      revision: record?.revision ?? null, admissionAllowed: record?.admission_allowed ?? false,
      admissionRevision: record?.admission_revision ?? null, expiresAt: record?.expires_at ?? null,
      qualified: claimed(row.command_id), blockedReason: row.state === 'accepted' ? claimError(row) : null };
  }
  function barrier(record) {
    const result = { grant: copy(record), queued_message_ids: [], in_flight_message_ids: [], discarded_message_ids: [], settled_message_ids: [], commands: [] };
    for (const row of db.prepare('SELECT * FROM managed_commands WHERE session_id=? ORDER BY rowid').all(record.session_id)) {
      const command = parseNativeJson(row.data);
      if (managedExecutionGrantId(command) !== record.grant_id) continue;
      const receipt = parseNativeJson(row.receipt), run = readRun(receipt.run_id), qualified = claimed(row.command_id);
      const state = row.state === 'discarded' ? 'discarded' : !qualified ? 'accepted' : row.state === 'settled' ? 'completed' : 'claimed';
      result.commands.push({ message_id: receipt.message_id, command_id: row.command_id, idempotency_key: row.idem,
        inbox_state: state, run_id: run ? receipt.run_id : null, run_state: run?.snapshot.phase ?? null });
      const key = state === 'discarded' ? 'discarded_message_ids' : state === 'accepted' ? 'queued_message_ids'
        : run && terminal(run.snapshot.phase) ? 'settled_message_ids' : 'in_flight_message_ids';
      result[key].push(receipt.message_id);
    }
    return result;
  }
  function original(spec, key, digest) {
    const row = db.prepare('SELECT * FROM managed_grant_operations WHERE grant_id=? AND idem=?').get(spec.grant_id, key);
    if (!row) return null;
    if (digest !== undefined) invariant(row.digest === digest, 'execution_grant_idempotency_conflict');
    return parseNativeJson(row.receipt);
  }
  function mutation(raw, key, operation, apply) {
    const spec = scoped(raw);
    invariant(validText(key) && key.length <= 4096, 'execution_grant_operation_invalid');
    const digest = hash({ spec, ...operation });
    const result = transaction(() => {
      const record = exact(spec), previous = original(spec, key, digest); if (previous) return { receipt: previous, changed: false };
      const updated = apply(record), receipt = barrier(updated);
      db.prepare('INSERT INTO managed_grant_operations VALUES (?,?,?,?)').run(spec.grant_id, key, digest, canonical(receipt));
      return { receipt, changed: true };
    });
    if (result.changed) wake(); return result;
  }
  const api = Object.freeze({ contract: MANAGED_NATIVE_EXECUTION_GRANTS_CONTRACT,
    ensure(raw, { expires_at = null, remaining_ttl_seconds = null } = {}) {
      const spec = scoped(raw), observed = budget(remaining_ttl_seconds);
      if (expires_at !== null) expires_at = absoluteTime(expires_at);
      const result = transaction(() => {
        const previous = load(spec.grant_id);
        if (previous) return { record: exact(spec), created: false };
        invariant((expires_at === null) === (spec.attempt_epoch === null), 'execution_grant_epoch_expiry_required');
        const record = { ...spec, expires_at, state: 'active', revision: 1, admission_allowed: true,
          admission_revision: 1, created_at: now(), updated_at: now() };
        db.prepare('INSERT INTO managed_execution_grants VALUES (?,?)').run(spec.grant_id, canonical(record));
        return { record, created: true };
      });
      if (result.created) { anchor(result.record, observed); wake(); }
      return copy(result.record);
    },
    get(raw) { const spec = scoped(raw); return transaction(() => barrier(exact(spec))); },
    require(raw) { const spec = scoped(raw); return transaction(() => { const record = exact(spec); requireLive(record); return copy(record); }); },
    lookup(raw, { idempotency_key } = {}) {
      const spec = scoped(raw); invariant(validText(idempotency_key), 'execution_grant_operation_invalid');
      return transaction(() => { exact(spec); return original(spec, idempotency_key); });
    },
    setState(raw, state, { expected_revision, idempotency_key } = {}) {
      invariant(['active', 'suspended', 'revoked'].includes(state) && positive(expected_revision), 'execution_grant_operation_invalid');
      return mutation(raw, idempotency_key, { operation: 'state', state, expected_revision }, record => {
        invariant(record.revision === expected_revision, 'execution_grant_revision_conflict');
        invariant(record.state !== 'revoked' || state === 'revoked', 'execution_grant_irreversible');
        const updated = { ...record, state, revision: record.revision + 1, updated_at: now() }; persist(updated);
        if (state === 'revoked') {
          for (const row of db.prepare("SELECT * FROM managed_commands WHERE session_id=? AND state='accepted' AND command_id NOT IN (SELECT command_id FROM managed_command_claims)").all(record.session_id)) {
            if (managedExecutionGrantId(parseNativeJson(row.data)) === record.grant_id)
              db.prepare("UPDATE managed_commands SET state='discarded' WHERE command_id=?").run(row.command_id);
          }
        }
        return updated;
      }).receipt;
    },
    setAdmission(raw, allowed, { expected_revision, idempotency_key } = {}) {
      invariant(typeof allowed === 'boolean' && positive(expected_revision), 'execution_grant_operation_invalid');
      return mutation(raw, idempotency_key, { operation: 'admission', allowed, expected_revision }, record => {
        requireLive(record); invariant(record.admission_revision === expected_revision, 'execution_grant_admission_revision_conflict');
        const updated = { ...record, admission_allowed: allowed, admission_revision: record.admission_revision + 1, updated_at: now() };
        persist(updated); return updated;
      }).receipt;
    },
    renew(raw, { expected_revision, expires_at, renewal_id, remaining_ttl_seconds = null } = {}) {
      const observed = budget(remaining_ttl_seconds); expires_at = absoluteTime(expires_at);
      invariant(positive(expected_revision), 'execution_grant_operation_invalid');
      const result = mutation(raw, renewal_id, { operation: 'renew', expected_revision, expires_at }, record => {
        if (localError(record) === 'expired') fail('expired');
        requireActive(record);
        invariant(record.expires_at !== null && Date.parse(expires_at) > Date.parse(record.expires_at) && Date.parse(expires_at) > clock(),
          'execution_grant_renewal_invalid');
        invariant(record.revision === expected_revision, 'execution_grant_revision_conflict');
        const updated = { ...record, expires_at, revision: record.revision + 1, updated_at: now() }; persist(updated); return updated;
      });
      if (result.changed) anchor(result.receipt.grant, observed);
      return result.receipt;
    },
  });
  return { api, commandError, qualify, readySessions, claimError, inspect };
}
