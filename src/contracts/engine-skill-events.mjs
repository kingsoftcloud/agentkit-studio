import { canonical, copy, isRecord } from './native-values.mjs';

export const NATIVE_SKILL_EVENTS = 'agentkit.native-skill-events/v1';
export const MAX_SKILL_EVENTS = 1024;
export const MAX_SKILL_EVENT_EVIDENCE_BYTES = 1024 ** 2;
const types = new Set(['skill.candidates.resolved', 'skill.selection.completed', 'skill.selection.skipped',
  'skill.package.cache_hit', 'skill.package.downloaded', 'skill.package.hash_verified', 'skill.package.extracted',
  'skill.manifest.parsed', 'skill.load.started', 'skill.load.completed', 'skill.load.failed',
  'sandbox.session.created', 'sandbox.session.cleaned_up', 'sandbox.session.cleanup_failed',
  'skill.workflow.started', 'skill.workflow.completed', 'skill.workflow.failed',
  'skill.execution.started', 'skill.execution.completed', 'skill.execution.failed',
  'skill.artifact.created', 'skill.result.consumed', 'sandbox.envelope.rejected']);
/** @param {string} type */
export const requiresSkillInvocation = type => /^(?:skill\.load\.|skill\.execution\.)/.test(type)
  || type === 'skill.artifact.created' || type === 'skill.result.consumed';
/** @param {unknown} type @returns {type is string} */
export const isNativeSkillEventType = type => typeof type === 'string' && types.has(type);
/** @param {unknown} time @returns {time is number} */
export const isNativeSkillEventTime = time => typeof time === 'number' && Number.isFinite(time) && time >= 0 && time <= 8640000000000;

/** Read diagnostic frames for the Studio trace projection. @param {unknown} events */
export function selectNativeSkillEvents(events) {
  if (!Array.isArray(events) || events.length > MAX_SKILL_EVENTS
    || new TextEncoder().encode(canonical(events)).byteLength > MAX_SKILL_EVENT_EVIDENCE_BYTES) return [];
  return copy(events.filter((/** @type {unknown} */ event) => isRecord(event) && event.schema_version === 1
    && isNativeSkillEventType(event.event_type)
    && typeof event.event_id === 'string' && /^skill_evt_[a-f0-9]{64}$/u.test(event.event_id)
    && typeof event.status === 'string' && isNativeSkillEventTime(event.started_at)
    && (event.ended_at == null || isNativeSkillEventTime(event.ended_at) && event.ended_at >= event.started_at)
    && (!requiresSkillInvocation(event.event_type) || typeof event.skill_invocation_id === 'string' && event.skill_invocation_id)));
}
