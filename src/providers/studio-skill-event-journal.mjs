/** Skill runtime receipts from the Studio Host and its bound sandbox. */
import { createHash } from 'node:crypto';
import { canonical, copy, invariant } from '../contracts/native-values.mjs';
import { parseNativeJson } from '../contracts/native-json.mjs';
import { isNativeSkillEventTime, isNativeSkillEventType, MAX_SKILL_EVENTS, MAX_SKILL_EVENT_EVIDENCE_BYTES,
  NATIVE_SKILL_EVENTS, requiresSkillInvocation, selectNativeSkillEvents } from '../contracts/engine-skill-events.mjs';

export const SKILL_EVENT_BYTES = 256 * 1024;
const ATTRIBUTES = new Set(['source', 'scope', 'requested_skill', 'artifact_name', 'artifact_ref', 'agent_step_id',
  'availability', 'backend', 'cache_hit', 'candidate_count', 'candidate_skill_ids', 'has_description', 'mime_type',
  'reason', 'selected_skill_ids', 'selection_receipt_id', 'size_bytes', 'cleanup_scope']);
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const code = value => typeof value === 'string' && /^[a-z][a-z0-9_]{0,95}$/u.test(value) ? value : '';
function text(value) {
  if (typeof value !== 'string') return undefined;
  // Attributes are diagnostic labels, never URLs, host paths or credentials.
  if (/https?:\/\/|(?:^|\s)(?:\/|[A-Z]:\\)|bearer\s|(?:api[_-]?key|token|password|secret)\s*[:=]/iu.test(value)) return '[redacted]';
  return Array.from(value).slice(0, 256).join('');
}
function attributes(input) {
  const output = {};
  for (const [key, value] of Object.entries(input ?? {})) if (ATTRIBUTES.has(key)) {
    if (typeof value === 'string') output[key] = text(value);
    else if (typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) output[key] = value;
    else if (Array.isArray(value)) output[key] = value.slice(0, 100).filter(item => typeof item === 'string').map(text);
  }
  return output;
}
function refFor(pkg) {
  if (!pkg?.skillId || typeof pkg.versionId !== 'string') return null;
  const checksum = String(pkg.archiveHash || pkg.contentHash || '').toLowerCase().replace(/^sha256:/u, '');
  return { skill_id: String(pkg.skillId), version_id: String(pkg.versionId), version: '', name: String(pkg.name),
    description: '', status: 'active', content_hash: checksum ? `sha256:${checksum}` : '', aliases: [], tags: [] };
}
function sameRef(actual, expected) {
  if (expected === null) return actual === null;
  return actual && actual.skill_id === expected.skill_id && actual.version_id === expected.version_id
    && (!expected.content_hash || actual.content_hash === expected.content_hash);
}
export function nativeSkillEventEvidence(events) {
  return Array.isArray(events) ? { skill_event_contract: NATIVE_SKILL_EVENTS, skill_events: selectNativeSkillEvents(events) } : {};
}

export function createNativeSkillEventJournal({ runtimeId, request, bindingDigest, events = [], persist = () => {} }) {
  invariant(typeof runtimeId === 'string' && runtimeId && typeof bindingDigest === 'string' && bindingDigest
    && Array.isArray(events) && events.length === 0, 'skill_event_journal_invalid');
  const plan = new Map(), seen = new Map(), running = new Map(), starts = new Map(); let bytes = 0, truncated = false;
  const context = { runtime_id: runtimeId, trace_id: String(request.traceId ?? request.runId ?? ''),
    run_id: String(request.runId ?? ''), binding_snapshot_id: bindingDigest,
    decision_id: String(request.operationKey ?? request.callId ?? '') };
  function identity(pkg) {
    const ref = refFor(pkg), key = ref ? [ref.skill_id, ref.version_id] : [pkg.name, hash(pkg.body ?? '')];
    const id = `skill_inv_${hash([runtimeId, bindingDigest, key])}`;
    const previous = plan.get(id);
    invariant(!previous || sameRef(ref, previous.ref) || !previous.ref?.content_hash && sameRef(previous.ref, ref),
      'skill_event_plan_changed');
    plan.set(id, { ref, pkg }); return { skill_ref: copy(ref), skill_invocation_id: id };
  }
  function append(type, status, options = {}) {
    invariant(isNativeSkillEventType(type) && typeof status === 'string' && status, 'skill_event_invalid');
    if (truncated) return;
    const correlation = options.pkg ? identity(options.pkg) : { skill_ref: null, skill_invocation_id: '' };
    invariant(!requiresSkillInvocation(type) || correlation.skill_invocation_id, 'skill_event_invocation_required');
    const at = options.startedAt ?? Date.now() / 1000;
    const lifecycle = `${type.replace(/\.(?:started|completed|failed|created|cleaned_up|cleanup_failed)$/u, '')}:${correlation.skill_invocation_id || runtimeId}`;
    if (options.source !== 'sandbox' && /\.(?:started|created)$/u.test(type)) starts.set(lifecycle, at);
    const started = options.source !== 'sandbox' && /\.(?:completed|failed|cleaned_up|cleanup_failed)$/u.test(type) ? starts.get(lifecycle) : undefined;
    let event = { schema_version: 1, event_id: `skill_evt_${hash([runtimeId, events.length, type, correlation])}`,
      event_type: type, status, started_at: started ?? at, ended_at: options.endedAt ?? (started === undefined ? null : at), ...correlation, ...context,
      attributes: { ...attributes(options.attributes), source: options.source ?? 'host' },
      error_code: code(options.errorCode ?? ''), error_category: code(options.errorCategory ?? '') };
    let size = Buffer.byteLength(canonical(event));
    if (events.length >= MAX_SKILL_EVENTS - 1 || bytes + size > MAX_SKILL_EVENT_EVIDENCE_BYTES - 2048) {
      truncated = true;
      event = { ...event, event_type: 'sandbox.envelope.rejected', status: 'rejected', skill_ref: null,
        skill_invocation_id: '', attributes: { reason: 'event_budget_exceeded' }, error_category: 'event_budget_exceeded' };
      size = Buffer.byteLength(canonical(event));
    }
    events.push(copy(event)); bytes += size;
    if (options.source !== 'sandbox' && options.pkg) {
      if (type === 'skill.execution.started') running.set(correlation.skill_invocation_id, options.pkg);
      else if (/^skill\.execution\.(?:completed|failed)$/u.test(type)) running.delete(correlation.skill_invocation_id);
    }
    persist(); return copy(event);
  }
  function reject(reason = 'invalid_envelope') { return append('sandbox.envelope.rejected', 'rejected', { errorCategory: reason }); }
  function accept(raw) {
    if (typeof raw !== 'string' || Buffer.byteLength(raw) > SKILL_EVENT_BYTES) { reject(); return; }
    let lines = 0;
    for (const line of raw.split(/\r?\n/u)) {
      if (!line.trim()) continue;
      if (++lines > 512) { reject('event_budget_exceeded'); break; }
      try {
        invariant(Buffer.byteLength(line) <= 16 * 1024, 'envelope_too_large');
        const event = parseNativeJson(line), target = plan.get(event?.skill_invocation_id);
        // Child output cannot claim Host workflow, session, selection or consumption facts.
        invariant(event?.schema_version === 1 && isNativeSkillEventType(event.event_type) && target
          && /^(?:skill\.(?:load|execution|package|manifest|artifact)\.)/u.test(event.event_type)
          && sameRef(event.skill_ref ?? null, target.ref) && typeof event.event_id === 'string' && event.event_id
          && event.event_id.length <= 256 && /^[a-z_]{1,32}$/u.test(event.status)
          && isNativeSkillEventTime(event.started_at)
          && (event.ended_at == null || isNativeSkillEventTime(event.ended_at) && event.ended_at >= event.started_at), 'invalid_envelope');
        const key = hash([event.skill_invocation_id, event.event_id]);
        const fingerprint = hash(event), previous = seen.get(key);
        if (previous) { if (previous !== fingerprint) reject('correlation_mismatch'); continue; }
        seen.set(key, fingerprint);
        append(event.event_type, event.status, { pkg: target.pkg, attributes: event.attributes, source: 'sandbox',
          startedAt: event.started_at, endedAt: event.ended_at, errorCategory: code(event.error_category), errorCode: code(event.error_code) });
      } catch { reject(); }
    }
  }
  return { emit: append, identity, accept, reject, snapshot: () => copy(events),
    failOpen() { for (const pkg of [...running.values()]) append('skill.execution.failed', 'uncertain', { pkg, errorCategory: 'outcome_unknown' }); },
    commandEnvironment(pkg, file) { return { KSADK_SKILL_EVENT_FILE: file,
      KSADK_SKILL_INVOCATION_ID: identity(pkg).skill_invocation_id, KSADK_SKILL_REF_JSON: canonical(refFor(pkg)) }; },
    artifacts(result, packages) {
      const pkg = packages.find(item => item.name === result.executed_skill);
      if (pkg) for (const item of result.artifact_metadata ?? []) append('skill.artifact.created', 'completed', { pkg,
        attributes: { artifact_ref: `sha256:${item.sha256}`, artifact_name: item.source_path?.split('/').at(-1) ?? '', size_bytes: item.size_bytes } });
    } };
}
