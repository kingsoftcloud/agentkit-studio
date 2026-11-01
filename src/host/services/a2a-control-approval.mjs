/** Human task approvals use an owned Host turn when the original conversation
 * is idle. The remote command ledger independently owns effects and recovery;
 * an approval turn never drives the model or invents a Native Run. */
import { canonical, invariant } from '@kingsoftcloud/agentkit-harness-core';
import { awaitA2aControl } from '../../providers/native-a2a-controls.mjs';
import { A2A_HOST_DECISION, a2aDecisionDigest } from '../../providers/native-a2a-decision.mjs';

const engine = 'agentkit.a2a-human-control/v1';
export async function requestStudioA2aApproval({ ctx, agent, presetId, request, assertCurrent, requireReceipt = false }) {
  const session = agent.session, signal = request.signal;
  const projection = () => ctx.get('sessionProjections')?.stateOf?.(session, 'turnBoundary');
  const boundary = projection();
  invariant(boundary && Number.isSafeInteger(boundary.lastTurn) && boundary.lastTurn >= 0
    && (boundary.openTurnStartSeq === null || Number.isSafeInteger(boundary.openTurnStartSeq) && boundary.openTurnStartSeq >= 0),
  'STUDIO_A2A_APPROVAL_TURN_UNAVAILABLE');
  const flush = async (activeSignal = signal) => {
    assertCurrent();
    invariant(await awaitA2aControl(() => ctx.get('sessions')?.flush?.(session), activeSignal) === true,
      'STUDIO_A2A_APPROVAL_NOT_DURABLE');
    assertCurrent();
  };
  const ask = async (checkTurn, activeSignal = signal) => {
    assertCurrent(); checkTurn();
    const approval = ctx.get('approval');
    const approvalIdentity = approval?.[Symbol.for('cordis.tracker')] ?? approval;
    invariant(typeof approval?.request === 'function', 'STUDIO_A2A_APPROVAL_UNAVAILABLE');
    let asked, decided, conflict = false;
    invariant(!requireReceipt || typeof ctx.on === 'function', 'STUDIO_A2A_APPROVAL_AUDIT_UNAVAILABLE');
    const stop = requireReceipt ? ctx.on('session/event', (source, event) => {
      if (source !== session) return;
      if (event.type === 'approval/asked' && event.data?.callId === request.callId
        && event.data.toolName === request.toolName && event.data.reason === request.reason) {
        if (asked) conflict = true;
        else asked = { id: event.data.id, seq: event.seq };
      }
      if (event.type === 'approval/decided' && asked && event.data?.id === asked.id) {
        if (decided) conflict = true;
        else decided = { outcome: event.data.outcome, seq: event.seq };
      }
    }) : undefined;
    try {
      const outcome = await awaitA2aControl(() => approval.request({ ...request, signal: activeSignal }), activeSignal);
      assertCurrent(); checkTurn(); await flush(activeSignal); checkTurn();
      if (!requireReceipt) return outcome;
      const currentApproval = ctx.get('approval');
      invariant((currentApproval?.[Symbol.for('cordis.tracker')] ?? currentApproval) === approvalIdentity,
        'STUDIO_A2A_APPROVAL_SERVICE_CHANGED');
      invariant(!conflict && typeof asked?.id === 'string' && asked.id && decided?.outcome === outcome
        && Number.isSafeInteger(asked.seq) && asked.seq >= 0 && Number.isSafeInteger(decided.seq)
        && decided.seq > asked.seq, 'STUDIO_A2A_APPROVAL_AUDIT_MISMATCH');
      return { outcome, receipt: { contract: A2A_HOST_DECISION, sessionId: session.id, presetId,
        requestId: asked.id, callId: request.callId, toolName: request.toolName,
        requestDigest: a2aDecisionDigest({ toolName: request.toolName, callId: request.callId, reason: request.reason ?? null }),
        outcome, askedSeq: asked.seq, decidedSeq: decided.seq } };
    } finally { stop?.(); }
  };
  const host = agent.externalTurns;
  const binding = canonical({ contract: engine, sessionId: session.id, presetId });
  const pending = host?.pending?.();
  if (boundary.openTurnStartSeq !== null && pending?.engine !== engine) {
    // A live tool or a recoverable Native turn already owns the audit log.
    // If it closes while consent is pending, discard the grant before effects.
    return ask(() => {
      const current = projection();
      invariant(current?.openTurnStartSeq === boundary.openTurnStartSeq
        && current?.lastTurn === boundary.lastTurn, 'STUDIO_A2A_APPROVAL_TURN_CHANGED');
    });
  }
  invariant(host?.contract === 'dsh.external-turn-host/v1'
    && host.idleAdmissionContract === 'dsh.external-turn-start/v1'
    && typeof host.start === 'function' && typeof host.resume === 'function', 'STUDIO_A2A_APPROVAL_TURN_UNAVAILABLE');
  if (pending) invariant(pending.engine === engine && pending.binding === binding, 'STUDIO_A2A_APPROVAL_OWNER_CHANGED');
  let outcome, failure;
  const execute = async payload => {
    const ownedSignal = AbortSignal.any([signal, payload.signal]);
    // No grant is reused after a crash. Even an interrupted decided approval
    // asks again; only the remote ledger can confirm an already sent command.
    const checkTurn = () => {
      ownedSignal.throwIfAborted();
      const current = host.pending();
      invariant(current?.engine === engine && current.binding === binding && current.turn === payload.turn,
        'STUDIO_A2A_APPROVAL_OWNER_CHANGED');
    };
    try {
      await flush(ownedSignal);
      outcome = await ask(checkTurn, ownedSignal);
      return { reason: { kind: 'completed' } };
    } catch (error) {
      failure = error;
      return { reason: { kind: 'error', error: { code: 'UNKNOWN', message: 'Human A2A approval did not complete.' } } };
    }
  };
  if (pending) await host.resume(engine, execute);
  else await host.start(async ({ turn }) => { assertCurrent(); return { contract: 'dsh.external-turn/v1', engine, binding, turn }; }, execute);
  // Commit the owned ending before a caller may use the grant.
  await flush(); if (failure) throw failure;
  return outcome;
}
