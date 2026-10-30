import type { BrowserRecovery, BrowserSessionRef } from './browser-contract.mjs';
import { browserObservationDigest, validateBrowserObservation, validateBrowserRecovery, validateBrowserSessionRef } from './browser-contract.mjs';
import type { CommitBatch, EffectIntent, RunSnapshot, ToolCall, ToolDefinition, ToolResult } from './contracts.mjs';
import { canonical, copy, invariant } from './values.mjs';
import { transition } from './transitions.mjs';

const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const owns = (snapshot: RunSnapshot, ref: BrowserSessionRef) => same(ref.scope, snapshot.scope) && ref.runId === snapshot.runId;
const invalidated = (snapshot: RunSnapshot): Partial<RunSnapshot> => ({
  lastBrowserObservation: null, lastBrowserAttemptToolCall: null, preparedContext: null,
  candidate: null, verification: null, finalText: '',
  contextState: snapshot.contextState ? { ...snapshot.contextState, compaction: null } : null,
});
const failed = (reason: string): Partial<RunSnapshot> => ({ phase: 'finalizing', outcome: 'failed', reason });
const REOBSERVATION_RETIREMENT = 'browser_context_invalidated';

/** A request reserves work; a claim authorizes dispatch. Only an unclaimed
 * boundary may discard requests made against the lost resource context. */
function replanBoundary(snapshot: RunSnapshot, pending: EffectIntent | null): boolean {
  if (pending === null) return snapshot.pendingIntent === null
    && ['preparing_context', 'executing_tools'].includes(snapshot.phase);
  if (pending.status !== 'prepared' || pending.operationKey !== snapshot.pendingIntent) return false;
  if (pending.kind === 'tool' && snapshot.phase === 'executing_tools') {
    const calls = pending.payload.calls;
    return Array.isArray(calls) && calls.length > 0 && calls.length <= snapshot.pendingTools.length
      && same(calls, snapshot.pendingTools.slice(0, calls.length));
  }
  if (snapshot.pendingTools.length) return false;
  return pending.kind === 'context' && snapshot.phase === 'preparing_context'
    || pending.kind === 'model' && snapshot.phase === 'requesting_model'
      && (pending.payload.purpose === undefined || pending.payload.purpose === 'task');
}

export interface BrowserIsolation {
  contract: 'agentkit.browser-isolation/v1'; sessionRef: BrowserSessionRef; operationKey: string;
  fenced: true; externalEffects: false; oldActionsReplayed: false;
}

/** Outcome uncertainty and disposable resource continuity are separate facts.
 * The receipt remains uncertain. No original call is rescheduled, and only a
 * complete capture on generation+1 can discharge the observation debt. */
export function isolatedBrowserFailure(snapshot: RunSnapshot, result: ToolResult, definition: ToolDefinition | undefined,
  operationKey: string): Partial<RunSnapshot> | null {
  if (definition?.recoveryPolicy !== 'ephemeral-browser/v1' || result.status !== 'uncertain'
    || result.browserIsolation === undefined) return null;
  const proof = result.browserIsolation, ref = validateBrowserSessionRef(proof.sessionRef);
  invariant(definition.observationRole === 'browser' && !definition.concurrentSafe
    && Object.keys(proof).sort().join(',') === 'contract,externalEffects,fenced,oldActionsReplayed,operationKey,sessionRef'
    && proof.contract === 'agentkit.browser-isolation/v1' && proof.operationKey === operationKey
    && proof.fenced === true && proof.externalEffects === false && proof.oldActionsReplayed === false
    && owns(snapshot, ref) && same(result.browserSessionRef, ref) && !result.browserSessionClosed
    && snapshot.browserSessionRefs.some(known => same(known, ref)), 'invalid_browser_isolation');
  const debt = new Map(snapshot.browserReobservationRefs.map(known => [known.runtimeId, known]));
  debt.set(ref.runtimeId, ref);
  invariant(debt.size <= 16, 'browser_reference_limit');
  return { ...invalidated(snapshot), browserReobservationRefs: [...debt.values()],
    recoveryRetriesUsed: snapshot.recoveryRetriesUsed + 1 };
}

/** Only host-typed receipts from a locked browser tool may become resource authority. */
export function reduceBrowserReceipt(snapshot: RunSnapshot, result: ToolResult, definition: ToolDefinition,
  call: ToolCall, digest: (value: unknown) => string): Partial<RunSnapshot> {
  if (definition.observationRole !== 'browser' || result.status === 'approval_required') return {};
  invariant(result.browserSessionClosed === undefined || typeof result.browserSessionClosed === 'boolean', 'invalid_browser_closure');
  invariant(!result.browserSessionClosed || result.browserSessionRef, 'browser_closure_reference_missing');
  const refs = copy(snapshot.browserSessionRefs ?? []), debt = copy(snapshot.browserReobservationRefs ?? []);
  const changes: Partial<RunSnapshot> = { lastBrowserAttemptToolCall: snapshot.usage.toolCalls };
  const ref = result.browserSessionRef ? validateBrowserSessionRef(result.browserSessionRef) : null;
  if (ref) {
    if (!owns(snapshot, ref)) return { ...invalidated(snapshot), ...failed('browser_reference_scope_mismatch') };
    if (result.browserSessionClosed) {
      changes.browserSessionRefs = refs.filter(previous => !same(previous, ref));
      if (same(snapshot.lastBrowserObservation?.sessionRef ?? null, ref)) changes.lastBrowserObservation = null;
    } else {
      const retained = refs.filter(previous => previous.runtimeId !== ref.runtimeId);
      if (retained.length >= 16) return { ...invalidated(snapshot), ...failed('browser_reference_limit') };
      changes.browserSessionRefs = [...retained, ref];
      const previous = snapshot.lastBrowserObservation?.sessionRef;
      if (previous?.runtimeId === ref.runtimeId && !same(previous, ref)) changes.lastBrowserObservation = null;
    }
  }
  if (result.browserObservation === undefined) return changes;
  const observation = validateBrowserObservation(result.browserObservation);
  invariant(ref && !result.browserSessionClosed && same(observation.sessionRef, ref), 'browser_observation_reference_mismatch');
  // Failed/incomplete capture can record ownership, but cannot replace evidence
  // or pay resource debt. The full typed capture stays in the tool receipt.
  if (result.status !== 'ok' || observation.status !== 'ok' || !observation.complete || !observation.screenshot) return changes;
  const entryPath = result.content !== null && typeof result.content === 'object' && !Array.isArray(result.content)
    && typeof result.content.entry_path === 'string' && result.content.entry_path ? result.content.entry_path : null;
  changes.lastBrowserObservation = { sessionRef: ref, actionId: observation.actionId, actionSeq: observation.actionSeq,
    digest: browserObservationDigest(observation, digest), toolCall: snapshot.usage.toolCalls, callId: call.callId,
    goalRevision: snapshot.goalRevision, workspaceRevision: snapshot.workspaceRevision, ...(entryPath ? { entryPath } : {}) };
  changes.browserReobservationRefs = debt.filter(previous => !same({ ...previous,
    generation: previous.generation + 1, leaseEpoch: previous.leaseEpoch + 1 }, ref));
  return changes;
}

/** Pure ownership reconciliation. Continuity loss never replays old input. */
export function browserRecoveryTransition(snapshot: RunSnapshot, values: BrowserRecovery[], pending: EffectIntent | null = null,
  elapsedMs = 0): CommitBatch | null {
  invariant(Number.isFinite(elapsedMs) && elapsedMs >= 0, 'invalid_browser_probe_elapsed');
  const refs = (snapshot.browserSessionRefs ?? []).map(validateBrowserSessionRef);
  invariant(Array.isArray(values) && values.length === refs.length, 'browser_recovery_count_mismatch');
  for (let index = 0; index < values.length; index++) invariant(Object.hasOwn(values, index), 'browser_recovery_count_mismatch');
  const reports = values.map(validateBrowserRecovery);
  const facts: { kind: string; payload: Record<string, string | number | boolean | null> }[] = [];
  for (const [index, original] of refs.entries()) {
    invariant(owns(snapshot, original), 'persisted_browser_scope_mismatch');
    const report = reports[index]!;
    const expected = report.status === 'restarted' ? { ...original,
      generation: original.generation + 1, leaseEpoch: original.leaseEpoch + 1 } : original;
    invariant(same(report.sessionRef, expected), 'browser_recovery_reference_mismatch');
    facts.push({ kind: 'browser.recovered', payload: {
      sessionId: report.sessionRef.sessionId, runtimeId: report.sessionRef.runtimeId, status: report.status,
      generation: report.sessionRef.generation, leaseEpoch: report.sessionRef.leaseEpoch,
      lastActionSeq: report.lastActionSeq, reason: report.reason, reobserveAvailable: report.reobserveAvailable,
    } });
  }
  const missing = refs.length === 0 && snapshot.lastBrowserObservation != null;
  if (missing) facts.push({ kind: 'browser.recovered', payload: { status: 'lost', reason: 'browser_reference_missing' } });
  if (!facts.length) return null;
  const unavailable = missing || reports.some(report => report.status !== 'reconnected');
  const unknown = ['effect_outcome_unknown', 'recovery_retry_exhausted'].includes(snapshot.reason ?? '');
  let changes: Partial<RunSnapshot> = {};
  let retire = false;
  let retirementCode = 'browser_session_unavailable';
  if (unavailable || unknown) {
    changes = invalidated(snapshot);
    const safe = unavailable && !unknown && !missing
      && replanBoundary(snapshot, pending)
      && reports.every(report => report.status === 'reconnected' || report.status === 'lost' && report.reobserveAvailable);
    if (safe) {
      const debt = new Map((snapshot.browserReobservationRefs ?? []).map(ref => [ref.runtimeId, ref]));
      for (const report of reports) if (report.status === 'lost') debt.set(report.sessionRef.runtimeId, report.sessionRef);
      invariant(debt.size <= 16, 'browser_reference_limit');
      retire = pending !== null;
      retirementCode = REOBSERVATION_RETIREMENT;
      Object.assign(changes, { phase: 'preparing_context', hookState: null, pendingIntent: null,
        pendingTools: [], pendingInteraction: null, interaction: null,
        context: { ...snapshot.context, preparedCursor: null },
        browserReobservationRefs: [...debt.values()],
        messages: [...snapshot.messages, ...snapshot.pendingTools.map(call => ({ role: 'tool' as const,
          callId: call.callId, name: call.name,
          content: canonical({ status: 'not_dispatched', reason: REOBSERVATION_RETIREMENT, executed: false }) })),
        { role: 'user', kind: 'browser_recovery_observation', content: canonical({
          status: 'lost', pageContinuity: false, priorObservationValid: false, freshObservationRequired: true,
        }) }],
      });
      if (pending) facts.push({ kind: 'effect.not_dispatched', payload: { operationKey: pending.operationKey,
        kind: pending.kind, reason: REOBSERVATION_RETIREMENT } });
      for (const call of snapshot.pendingTools) facts.push({ kind: 'tool.not_dispatched', payload: {
        callId: call.callId, name: call.name, reason: REOBSERVATION_RETIREMENT } });
      facts.push({ kind: 'browser.reobservation_required', payload: { priorObservationValid: false, oldActionsReplayed: false } });
    } else if (!unknown) {
      invariant(!pending || pending.status === 'prepared', 'browser_recovery_claim_not_classified');
      retire = !!pending;
      Object.assign(changes, { phase: 'finalizing', outcome: 'unverified', reason: 'browser_session_unavailable', pendingIntent: null });
      if (pending) facts.push({ kind: 'effect.not_dispatched', payload: { kind: pending.kind,
        operationKey: pending.operationKey, reason: 'browser_session_unavailable' } });
    }
  }
  changes.activeElapsedMs = snapshot.activeElapsedMs + elapsedMs;
  return transition(snapshot, changes, facts, { requireNoPendingCommands: true, ...(retire ? { receipts: [{ operationKey: pending!.operationKey,
    status: 'not_dispatched' as const, result: { code: retirementCode, executed: false } }] } : {}) });
}

/** The store admits this receipt exception only for the complete, original
 * resource-loss transition. No claimed effect, edited transcript or command
 * consumption can be hidden behind a fabricated non-dispatch result. */
export function isBrowserReobservationBatch(snapshot: RunSnapshot, pending: EffectIntent, batch: CommitBatch): boolean {
  try {
    if (!batch.events.some(event => event.kind === 'browser.reobservation_required')) return false;
    const recovered = batch.events.filter(event => event.kind === 'browser.recovered');
    if (recovered.length !== snapshot.browserSessionRefs.length) return false;
    const reports = recovered.map((event, index) => ({ sessionRef: snapshot.browserSessionRefs[index]!,
      status: event.payload.status, lastActionSeq: event.payload.lastActionSeq,
      reason: event.payload.reason, reobserveAvailable: event.payload.reobserveAvailable })) as BrowserRecovery[];
    const elapsedMs = batch.snapshot.activeElapsedMs - snapshot.activeElapsedMs;
    const expected = browserRecoveryTransition(snapshot, reports, pending, elapsedMs);
    return expected !== null && expected.snapshot.phase === 'preparing_context' && same(expected, batch);
  } catch { return false; }
}
