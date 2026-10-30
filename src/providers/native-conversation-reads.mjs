import { canonical, copy, invariant } from '@kingsoftcloud/agentkit-harness-core';
import { deserializeReadState } from '@kingsoftcloud/agentkit-harness-node/native/workspace-state';

/** Rebuild read knowledge from the exact retained results, never the source
 * Session's latest read cache or fresh filesystem bytes. The seed's historical
 * provenance identifies original private receipts without copying them into
 * model history or the public Session marker. */
export function nativeConversationReadStates({ store, scope, seed }) {
  if (!seed) return [];
  const records = new Map(), states = new Map();
  for (const selected of seed.messages) {
    const source = selected.history;
    if (selected.role !== 'tool' || !source || selected.kind === 'incomplete_tool_observation') continue;
    if (!records.has(source.sourceRunId)) {
      let record;
      try { record = store.load(scope, source.sourceRunId); }
      catch (error) { if (error.code !== 'run_not_found') throw error; }
      const results = new Map(), receipts = new Map(record?.receipts.map(receipt => [receipt.operationKey, receipt]) ?? []);
      for (const intent of record?.intents ?? []) if (intent.kind === 'tool') {
        const receipt = receipts.get(intent.operationKey);
        for (const [index, call] of intent.payload.calls.entries())
          results.set(call.callId, { receipt, result: receipt?.result.results?.[index] });
      }
      records.set(source.sourceRunId, record ? { record, results } : null);
    }
    const entry = records.get(source.sourceRunId);
    if (!entry) continue; // Legacy/unavailable evidence requires a new read.
    const { record, results } = entry;
    invariant(canonical(record.snapshot.scope) === canonical(scope), 'native_conversation_read_scope_mismatch');
    const original = record.snapshot.messages[source.sourceIndex];
    if (original?.role !== 'tool' || original.name !== selected.name || original.content !== selected.content || !original.callId) continue;
    {
      const { receipt, result } = results.get(original.callId) ?? {}, metadata = result?.metadata?.nativeWorkspaceReads;
      if (receipt?.status !== 'committed' || result?.status !== 'ok' || result.sourceObservationState === 'unread'
        || metadata?.contract !== 'native-workspace-read-observation/v1' || metadata.tool !== original.name
        || !Array.isArray(metadata.states)
        || selected.content !== (result.context?.content ?? canonical(result.content))) continue;
      for (const raw of metadata.states) {
        const state = deserializeReadState(raw);
        if (state && !state.partial) states.set(state.path, copy(raw));
      }
    }
  }
  return [...states.values()];
}
