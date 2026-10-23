/** Human task approvals use an owned Host turn when the original conversation
 * is idle. The remote command ledger independently owns effects and recovery;
 * an approval turn never drives the model or invents a Native Run. */
import { canonical, invariant } from '../../../packages/agentkit-harness-core/dist/index.mjs';
import { awaitA2aControl } from '../../providers/native-a2a-controls.mjs';

const engine = 'agentkit.a2a-human-control/v1';
export async function requestStudioA2aApproval({ ctx, agent, presetId, request, assertCurrent }) {
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
    invariant(typeof approval?.request === 'function', 'STUDIO_A2A_APPROVAL_UNAVAILABLE');
    const outcome = await awaitA2aControl(() => approval.request({ ...request, signal: activeSignal }), activeSignal);
    assertCurrent(); checkTurn(); await flush(activeSignal); checkTurn();
    return outcome;
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
