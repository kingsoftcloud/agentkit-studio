/** Read-only projection of an already admitted Native Run into Studio traces.
 * The ledger remains authoritative; projection failure never drives the Run. */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { mkdir, realpath } from 'node:fs/promises';
import { canonical, copy, invariant, scopeKey } from '@kingsoftcloud/agentkit-harness-core';
import { lockUntil } from '@kingsoftcloud/agentkit-harness-node/native/local-command-state';

export const NATIVE_TRACE_PROJECTION = 'agentkit.native-trace-projection/v1';
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const keyFor = (scope, runId) => hash([scopeKey(scope), runId]);
const terminal = phase => ['completed', 'failed', 'canceled', 'interrupted'].includes(phase);
function diagnosticJson(value) {
  return JSON.parse(canonical(value), (_key, item, context) => {
    if (typeof item !== 'number' || !context?.source) return item;
    return !Number.isFinite(item) || !Number.isSafeInteger(item) && Number.isInteger(item)
      || context.source !== String(item) ? context.source : item;
  });
}

export function createNativeTraceProjection({ stateDir, observability, onError = () => {} }) {
  invariant(typeof observability?.get === 'function' && typeof observability?.syncTrace === 'function', 'native_trace_port_required');
  const handles = new Map();
  let directory;
  async function lockRoot() {
    if (!directory) directory = (async () => { await mkdir(stateDir, { recursive: true, mode: 0o700 }); return realpath(stateDir); })()
      .catch(error => { directory = undefined; throw error; });
    return directory;
  }
  function attach({ store, scope, sessionId, runId, agentName = '' }) {
    const fixedScope = copy(scope), key = keyFor(fixedScope, runId), traceId = `native_${key}`;
    invariant(typeof store?.load === 'function' && typeof sessionId === 'string' && sessionId
      && typeof runId === 'string' && runId, 'native_trace_identity_invalid');
    let pending = Promise.resolve(), queued = false, stopped = false;
    async function project() {
      const release = await lockUntil(join(await lockRoot(), `${key}.sqlite`), performance.now() + 1000);
      try {
        const record = store.load(fixedScope, runId), snapshot = record.snapshot;
        invariant(scopeKey(snapshot.scope) === scopeKey(fixedScope) && snapshot.runId === runId
          && snapshot.sessionId === sessionId, 'native_trace_scope_mismatch');
        const previous = await observability.get(traceId), old = previous?.provenance?.nativeProjection;
        if (previous) invariant(old?.contract === NATIVE_TRACE_PROJECTION && old.identity === key, 'native_trace_identity_conflict');
        if (old && (old.revision > snapshot.revision || old.revision === snapshot.revision && old.eventSeq >= snapshot.eventSeq)) return;
        const at = new Date().toISOString(), times = new Map((previous?.events ?? []).map(event => [event.native_event_id, event.at]));
        const events = record.events.map(event => {
          invariant(event.runId === runId && Number.isSafeInteger(event.seq) && event.seq > 0 && event.seq <= snapshot.eventSeq,
            'native_trace_event_invalid');
          return { seq: event.seq, native_event_id: event.eventId, event_type: event.kind,
            at: times.get(event.eventId) ?? at, timing_source: 'projection_observed', run_id: runId, session_id: sessionId,
            payload: diagnosticJson(event.payload) };
        });
        const inputTokens = snapshot.usage.inputTokens, outputTokens = snapshot.usage.outputTokens;
        invariant([inputTokens, outputTokens, inputTokens + outputTokens].every(value => Number.isSafeInteger(value) && value >= 0),
          'native_trace_usage_invalid');
        await observability.syncTrace({ traceId, sessionId, agentId: fixedScope.agentId, agentName,
          status: terminal(snapshot.phase) || ['paused', 'awaiting_interaction'].includes(snapshot.phase) ? snapshot.phase : 'running',
          startedAt: previous?.startedAt ?? at, completedAt: at, events,
          measuredTokenUsage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
          provenance: { nativeProjection: { contract: NATIVE_TRACE_PROJECTION, identity: key, runId,
            revision: snapshot.revision, eventSeq: snapshot.eventSeq, phase: snapshot.phase, outcome: snapshot.outcome,
            source: 'durable-native-ledger', timing: 'first-projection-observation', numericEncoding: 'exact-decimal-strings' } } });
      } finally { release(); }
    }
    function schedule() {
      if (queued) return;
      queued = true;
      pending = pending.then(async () => { queued = false; await project(); }).catch(error => {
        try { onError({ code: error?.code ?? 'native_trace_projection_failed', traceId }); } catch { /* diagnostics cannot drive the Run */ }
      });
    }
    const handle = { schedule, async close() {
      if (!stopped) { stopped = true; if (handles.get(key) === handle) handles.delete(key); schedule(); }
      await pending;
    } };
    handles.set(key, handle); schedule();
    return { traceId, close: handle.close };
  }
  return { attach, checkpoint(snapshot) { handles.get(keyFor(snapshot.scope, snapshot.runId))?.schedule(); },
    async close() { await Promise.all([...handles.values()].map(handle => handle.close())); } };
}
