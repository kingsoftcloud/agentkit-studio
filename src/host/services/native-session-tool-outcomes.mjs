import { nativeToolOutcomeFact } from '@kingsoftcloud/agentkit-harness-node/native/session-delivery';

/** Resolve SDK positions separately from opaque Native execution turn IDs. */
function presentationTurn(record, sessionId, boundTurn) {
  if (Number.isSafeInteger(boundTurn) && boundTurn > 0) return boundTurn;
  const prefix = `dsh:${sessionId}:`;
  const positions = Object.keys(record.projections ?? {}).flatMap(key => {
    const match = key.startsWith(prefix) && /^([1-9][0-9]*):v1:[a-f0-9]{64}$/.exec(key.slice(prefix.length));
    const value = match && Number(match[1]);
    return Number.isSafeInteger(value) && value > 0 ? [value] : [];
  });
  if (positions.length) return Math.max(...positions);
  const turn = Number(record.snapshot.turnId);
  return Number.isSafeInteger(turn) && turn > 0 ? turn : null;
}

/** Unmapped standalone turns retain their unknown ledger state without inventing a UI position. */
export function nativeSessionToolOutcomes(store, record, sessionId, boundTurn) {
  const scope = record.snapshot.scope;
  let unmappedCount = 0;
  const positions = new Map();
  const outcomes = store.sessionToolOutcomes ? store.sessionToolOutcomes(scope, sessionId)
    : store.uncertainToolCalls(scope, sessionId).map(fact => ({ ...fact, status: 'uncertain' }));
  const facts = outcomes.flatMap(fact => {
    if (fact.runId !== record.snapshot.runId && !positions.has(fact.runId)) positions.set(fact.runId,
      typeof store.projectionCursors === 'function'
        ? { snapshot: { turnId: fact.turnId }, projections: store.projectionCursors(scope, fact.runId) }
        : store.load(scope, fact.runId));
    const source = fact.runId === record.snapshot.runId ? record : positions.get(fact.runId);
    const turn = presentationTurn(source, sessionId, fact.runId === record.snapshot.runId ? boundTurn : null);
    if (turn === null) { unmappedCount++; return []; }
    return [nativeToolOutcomeFact({ scope, sessionId, runId: fact.runId, turnId: fact.turnId }, fact.callId, fact.status, turn)];
  });
  return { contract: 'agentkit.native-session-tool-outcomes/v1', sessionId, facts, unmappedCount };
}
