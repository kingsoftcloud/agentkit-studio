import { canonical, copy, invariant, parseNativeJson } from '../../packages/agentkit-harness-core/dist/index.mjs';
import { nativeDeliveryTimeline } from '../../packages/agentkit-harness/src/native/delivery-timeline.mjs';
import { ownedCommandReceipt } from '../../packages/agentkit-harness/src/native/owned-command.mjs';
import { readNativeDshOwnership } from '../../packages/agentkit-harness/src/native/dsh-turn-ownership.mjs';
import { NATIVE_DSH_TURN_CONTRACT } from '../../packages/agentkit-harness/src/native/dsh-turn-contract.mjs';

/** Same-Session retention is execution authority. Prove original launch receipts
 * and actual published turn boundaries; never infer ownership from output text. */
export function nativeConversationRetainedCommands({ store, scope, record, seed, prefix, sourceEvents }) {
  const sources = new Map(), retained = [];
  for (const row of record.snapshot.backgroundCommands) {
    ownedCommandReceipt({ scope, store, current: record, ref: row.ref });
    let source = sources.get(row.ref.sourceRunId);
    if (!source) {
      source = store.load(scope, row.ref.sourceRunId); sources.set(row.ref.sourceRunId, source);
    }
    const owner = sourceEvents.find(event => {
      if (event.type !== 'turn/owner' || event.data.engine !== NATIVE_DSH_TURN_CONTRACT) return false;
      const admission = parseNativeJson(event.data.binding);
      return admission.identity?.runId === source.snapshot.runId;
    });
    invariant(owner, 'native_conversation_command_source_unavailable');
    const admission = readNativeDshOwnership(owner.data, { sessionId: record.snapshot.sessionId, turn: Number(source.snapshot.turnId) });
    invariant(canonical(admission.identity.scope) === canonical(scope) && admission.configDigest === source.snapshot.configDigest,
      'native_conversation_command_source_unavailable');
    if (!prefix.some(event => event.seq === owner.seq && canonical(event) === canonical(owner))) continue;
    const closed = prefix.some(event => event.seq > owner.seq && event.type === 'turn/end' && String(event.data.turn) === source.snapshot.turnId);
    if (closed) { retained.push(copy(row.ref)); continue; }
    const callId = source.intents.find(intent => intent.operationKey === row.ref.operationKey).payload.calls[0].callId;
    const messages = nativeDeliveryTimeline(source).messages;
    const kept = seed.messages.some(message => {
      if (message.history?.sourceRunId !== source.snapshot.runId) return false;
      const original = messages[message.history.sourceIndex];
      return original?.role === 'tool' && original.callId === callId
        || original?.role === 'assistant' && original.toolCalls?.some(call => call.callId === callId);
    });
    if (kept) retained.push(copy(row.ref));
  }
  return retained;
}
