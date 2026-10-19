/** Live approval identities are independent of read-only audit history. */
const fields = ['requestId', 'generation', 'hostId', 'sessionId', 'turn', 'turnStartSeq'];
export const sameAssistantApproval = (left, right) => Boolean(left && right && fields.every(field => left[field] === right[field]));

/** Offer only unexpired requests whose scope matches the authoritative running turn. */
export function assistantLiveApprovals(view, now = Date.now()) {
  if (view?.capabilities?.approval?.interactive !== true || view.status !== 'running' || !Array.isArray(view.pendingInteractions)) return [];
  return view.pendingInteractions.filter(row => row?.kind === 'approval'
    && fields.slice(0, 4).every(field => typeof row[field] === 'string' && row[field].length > 0 && row[field].length <= 256)
    && Number.isSafeInteger(row.turn) && row.turn >= 0 && Number.isSafeInteger(row.turnStartSeq) && row.turnStartSeq >= 0
    && row.turn === view.currentTurn && row.turnStartSeq === view.turnStartSeq
    && Number.isSafeInteger(row.expiresAt) && row.expiresAt > now && typeof row.toolName === 'string' && row.toolName.length > 0
    && Array.isArray(row.choices) && row.choices.includes('rejected'));
}

/** Send only the native question identity and the user's selected one-shot decision. */
export function assistantApprovalInput(request, decision) {
  return { ...Object.fromEntries(fields.map(field => [field, request[field]])), decision };
}
