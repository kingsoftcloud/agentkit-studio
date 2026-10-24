/** Local, durable observation delivery. The DSH Session assigns physical seq;
 * the child source retains its independent seq. No model surface, approval,
 * Native kernel commit, external turn or task effect is created here. */
import { createHash } from 'node:crypto';
import { canonical, copy, invariant } from '../../../packages/agentkit-harness-core/dist/index.mjs';
import { dshPresetId } from '../../agent-preset-admission.mjs';
import { awaitA2aControl } from '../../providers/native-a2a-controls.mjs';

export const A2A_SESSION_EVENT = 'agentkit/a2a-observation';
export const A2A_SESSION_CONTRACT = 'agentkit.a2a-session-event/v1';
export const A2A_SESSION_PROJECTION = 'agentkitA2aObservations';
const hash = value => createHash('sha256').update(value).digest('hex');
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 4096;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
// Cordis creates a new context-tracing proxy on every lookup. Its public
// Service.tracker symbol identifies the implementation beneath those proxies.
const serviceIdentity = value => value?.[Symbol.for('cordis.tracker')] ?? value;
const receiptKey = data => `${data.sourceKey}:${data.eventId}`;
function decode(data) {
  invariant(object(data) && data.contract === A2A_SESSION_CONTRACT && /^[a-f0-9]{64}$/u.test(data.sourceKey)
    && object(data.owner) && id(data.owner.agentId) && id(data.owner.sessionId) && ['native', 'dsh'].includes(data.owner.kind)
    && id(data.eventId) && Number.isSafeInteger(data.sourceSeq) && data.sourceSeq >= 1
    && typeof data.eventJson === 'string' && Buffer.byteLength(data.eventJson) <= 8 * 1024 * 1024,
  'A2A_SESSION_EVENT_INVALID');
  let event; try { event = JSON.parse(data.eventJson); } catch { invariant(false, 'A2A_SESSION_EVENT_INVALID'); }
  invariant(event?.schema_version === 2 && event.event_id === data.eventId && event.seq === data.sourceSeq
    && id(event.run_id) && id(event.scope_id) && id(event.event_type) && !event.event_type.startsWith('run.')
    && Number.isFinite(event.timestamp) && event.timestamp >= 0, 'A2A_SESSION_EVENT_INVALID');
  return event;
}

/** Host-only index rebuilt by the maintained projection registry on restore.
 * Full canonical values live once in the Session log, encoded losslessly as
 * a string because DSH's JSON envelope intentionally rejects negative zero. */
export function a2aSessionProjection() {
  return { key: A2A_SESSION_PROJECTION, stateVersion: 1,
    stateSchema: { parse(value) {
      invariant(object(value) && object(value.receipts) && object(value.sources), 'A2A_SESSION_PROJECTION_INVALID');
      for (const entry of Object.values(value.receipts)) invariant(object(entry) && /^[a-f0-9]{64}$/u.test(entry.digest)
        && Number.isSafeInteger(entry.seq) && entry.seq >= 0 && Number.isSafeInteger(entry.sourceSeq) && entry.sourceSeq > 0,
      'A2A_SESSION_PROJECTION_INVALID');
      for (const entry of Object.values(value.sources)) invariant(object(entry) && typeof entry.owner === 'string' && entry.owner.length <= 16384
        && Number.isSafeInteger(entry.through) && entry.through > 0, 'A2A_SESSION_PROJECTION_INVALID');
      return value;
    } },
    init: () => ({ receipts: {}, sources: {} }),
    apply(state, event) {
      if (event.type !== A2A_SESSION_EVENT) return state;
      invariant(event.ignorable === true && event.surfaceOp === undefined && event.sourceEventSeqs === undefined,
        'A2A_SESSION_EVENT_INVALID');
      decode(event.data);
      const data = event.data, key = receiptKey(data), digest = hash(canonical(data)), previous = state.receipts[key];
      if (previous) {
        invariant(previous.digest === digest && previous.sourceSeq === data.sourceSeq, 'A2A_SESSION_EVENT_CONFLICT'); return state;
      }
      const source = state.sources[data.sourceKey], owner = canonical(data.owner);
      invariant(!source || source.owner === owner, 'A2A_SESSION_OWNER_CONFLICT');
      invariant(data.sourceSeq === (source?.through ?? 0) + 1, 'A2A_SESSION_SEQUENCE_GAP');
      return { receipts: { ...state.receipts, [key]: { digest, seq: event.seq, sourceSeq: data.sourceSeq } },
        sources: { ...state.sources, [data.sourceKey]: { owner, through: data.sourceSeq } } };
    },
  };
}

export function createStudioA2aSessionSink({ ctx } = {}) {
  let registration, registeredProjections, closed = false;
  const lifetime = new AbortController();
  const chains = new Map();
  function services() {
    invariant(!closed, 'A2A_SESSION_SINK_CLOSED');
    const sessions = ctx.get('sessions'), projections = ctx.get('sessionProjections');
    invariant(typeof sessions?.get === 'function' && typeof sessions.flush === 'function'
      && typeof projections?.stateOf === 'function' && typeof projections.register === 'function', 'A2A_SESSION_SERVICES_UNAVAILABLE');
    if (!registration) { registration = projections.register(a2aSessionProjection()); registeredProjections = serviceIdentity(projections); }
    invariant(serviceIdentity(projections) === registeredProjections, 'A2A_SESSION_SERVICES_CHANGED');
    return { sessions, projections };
  }
  return Object.freeze({
    forPreset({ agentId, agentRevision = 1, buildId = null }) {
      invariant(id(agentId) && Number.isSafeInteger(agentRevision) && agentRevision > 0 && (buildId === null || id(buildId)), 'A2A_SESSION_PRESET_INVALID');
      const preset = dshPresetId(agentId, agentRevision, buildId || '');
      return Object.freeze({ contract: A2A_SESSION_CONTRACT,
        write({ owner, destinationSessionId = owner?.sessionId, sourceKey, events, signal }) {
          invariant(!closed, 'A2A_SESSION_SINK_CLOSED');
          invariant(signal instanceof AbortSignal && object(owner) && id(destinationSessionId)
            && /^[a-f0-9]{64}$/u.test(sourceKey) && Array.isArray(events) && events.length > 0 && events.length <= 100,
          'A2A_SESSION_DELIVERY_INVALID');
          signal = AbortSignal.any([signal, lifetime.signal]);
          const kind = owner.scope ? 'native' : 'dsh', sourceAgent = owner.scope?.agentId ?? owner.agentId;
          invariant(kind === 'native' ? sourceAgent === agentId || sourceAgent?.startsWith(agentId + ':child:')
            : sourceAgent === agentId && owner.agentRevision === agentRevision && owner.buildId === buildId && destinationSessionId === owner.sessionId,
          'A2A_SESSION_OWNER_CONFLICT');
          const admitted = copy(events), envelopeOwner = { agentId, sessionId: destinationSessionId, kind };
          const entries = admitted.map(event => {
            const data = { contract: A2A_SESSION_CONTRACT, sourceKey, owner: envelopeOwner,
              eventId: event.event_id, sourceSeq: event.seq, eventJson: canonical(event) };
            decode(data); return data;
          });
          const work = async () => {
            signal.throwIfAborted(); const { sessions, projections } = services(), session = sessions.get(destinationSessionId);
            const guard = () => {
              signal.throwIfAborted(); invariant(!closed && serviceIdentity(sessions) === serviceIdentity(ctx.get('sessions'))
                && serviceIdentity(projections) === serviceIdentity(ctx.get('sessionProjections'))
                && session && sessions.get(destinationSessionId) === session && String(session.id) === destinationSessionId,
              'A2A_SESSION_UNAVAILABLE');
              invariant(projections.stateOf(session, 'agentPreset') === preset, 'A2A_SESSION_PRESET_CHANGED');
            };
            guard();
            const state = () => {
              const value = projections.stateOf(session, A2A_SESSION_PROJECTION);
              invariant(value, 'A2A_SESSION_PROJECTION_UNAVAILABLE'); return value;
            };
            let last;
            for (const data of entries) {
              guard(); const current = state(), key = receiptKey(data), digest = hash(canonical(data)), previous = current.receipts[key];
              if (previous) { invariant(previous.digest === digest, 'A2A_SESSION_EVENT_CONFLICT'); last = previous.seq; continue; }
              const source = current.sources[sourceKey];
              invariant(!source || source.owner === canonical(envelopeOwner), 'A2A_SESSION_OWNER_CONFLICT');
              invariant(data.sourceSeq === (source?.through ?? 0) + 1, 'A2A_SESSION_SEQUENCE_GAP');
              session.append(A2A_SESSION_EVENT, data, { ignorable: true });
              const accepted = state().receipts[key];
              invariant(accepted?.digest === digest, 'A2A_SESSION_PROJECTION_NOT_ADVANCED'); last = accepted.seq;
            }
            guard();
            // Deduplicated appends must also flush: a prior attempt may have
            // reached Session.append but not its persistence acknowledgement.
            invariant(await awaitA2aControl(() => sessions.flush(session), signal) === true, 'A2A_SESSION_NOT_DURABLE'); guard();
            return { contract: A2A_SESSION_CONTRACT, sourceKey, through: entries.at(-1).sourceSeq, sessionSeq: last };
          };
          const previous = chains.get(destinationSessionId) ?? Promise.resolve(), result = previous.catch(() => {}).then(work);
          chains.set(destinationSessionId, result);
          void result.finally(() => { if (chains.get(destinationSessionId) === result) chains.delete(destinationSessionId); }).catch(() => {});
          return result;
        },
      });
    },
    async close() { closed = true; lifetime.abort(); await Promise.allSettled(chains.values()); registration?.(); },
  });
}
