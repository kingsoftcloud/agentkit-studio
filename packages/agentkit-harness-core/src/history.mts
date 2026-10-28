import { terminal } from './contracts.mjs';
import type { Message, ModelResult, RunConfiguration, RunSnapshot, StoredRun } from './contracts.mjs';
import { canonical, copy, invariant } from './values.mjs';

type Identify = (value: unknown) => string;
const inheritedKinds = new Set(['user_guidance', 'historical_tool_observation',
  'guidance', 'steering', 'user_input', 'dsh_context', 'tool_context', 'host_input',
  'historical_verification_observation', 'user_document_observation', 'background_child_observation', 'background_command_observation', 'delivery_review_source']);

/** Imported protocol ids are stable across later turns; observations grant no new execution. */
export function projectSessionHistory(parent: StoredRun | null, configuration: RunConfiguration, identify: Identify,
  options: { identityNamespace?: string } = {}): Message[] {
  if (!parent) return [];
  invariant(terminal(parent.snapshot.phase), 'history_requires_terminal_parent');
  return projectHistory(parent, [...parent.snapshot.messages, ...parent.snapshot.queuedGuidance], configuration, identify, options, true);
}

/** A Host-authenticated conversation cut is data, even when its source is still
 * running. It imports neither queued future input nor the source's final text.
 * The Host must resolve the exact published boundary before calling this. */
export function projectConversationHistory(parent: StoredRun, transcript: Message[], configuration: RunConfiguration, identify: Identify,
  options: { identityNamespace: string }): Message[] {
  invariant(Array.isArray(transcript) && typeof options.identityNamespace === 'string' && options.identityNamespace.trim(),
    'invalid_conversation_history_boundary');
  return projectHistory(parent, transcript, configuration, identify, options, false);
}

function projectHistory(parent: StoredRun, transcript: Message[], configuration: RunConfiguration, identify: Identify,
  options: { identityNamespace?: string }, includeFinal: boolean): Message[] {
  const snapshot = parent.snapshot;
  const knownResults = new Map<string, { name: string; content: string }>();
  if (configuration.contextPolicy?.sourceReusePolicy === 'captured-source/v1') {
    const intents = new Map(parent.intents.map(intent => [intent.operationKey, intent]));
    const readers = new Set(parent.configuration.tools.filter(tool => tool.readOnly && tool.contextRole === 'workspace_read'
      && tool.sourceObservationPolicy === 'workspace-source-model/v1' && tool.resultArchivePolicy === 'archived-model-view/v5').map(tool => tool.name));
    for (const receipt of parent.receipts) {
      const intent = intents.get(receipt.operationKey), calls = intent?.payload.calls as unknown as Message['toolCalls'];
      const results = receipt.result.results;
      if (receipt.status !== 'committed' || intent?.kind !== 'tool' || !Array.isArray(calls) || !Array.isArray(results) || calls.length !== results.length) continue;
      for (const [index, value] of results.entries()) {
        if (!readers.has(calls[index]!.name)) continue;
        if (!value || typeof value !== 'object' || Array.isArray(value) || value.status !== 'ok') continue;
        const context = value.context;
        if (!(context && typeof context === 'object' && !Array.isArray(context) && typeof context.content === 'string')
          && value.content === undefined) continue;
        const content = context && typeof context === 'object' && !Array.isArray(context) && typeof context.content === 'string'
          ? context.content : canonical(value.content);
        knownResults.set(calls[index]!.callId, { name: calls[index]!.name, content });
      }
    }
  }
  const replayAllowed = configuration.profile.providerReplayMode !== 'none'
    && canonical(configuration.profile) === canonical(parent.configuration.profile);
  const output: Message[] = [], seen = new Set<string>();
  const pending = new Map<string, { mapped: string; source: NonNullable<Message['history']> }>();
  const flush = () => {
    for (const { mapped, source } of pending.values()) output.push({ role: 'tool', callId: mapped, history: source,
      kind: 'incomplete_tool_observation', content: canonical({ status: 'uncertain', executionStatus: 'unknown',
        reason: includeFinal ? 'previous_turn_ended_without_tool_result' : 'conversation_cut_before_tool_result',
        instruction: includeFinal
          ? 'No committed result is available. Check actual state before assuming success or repeating a side effect.'
          : 'No result is included at this history boundary. Check actual state before assuming success or repeating a side effect.' }) });
    pending.clear();
  };
  for (const [index, original] of transcript.entries()) {
    if (original.role === 'system' || original.kind && !inheritedKinds.has(original.kind) && original.role !== 'tool') continue;
    const message = copy(original);
    // Journal sections belong to the old Run and are not imported as system authority.
    delete message.operatorInputHistory;
    const source = message.history ?? { sourceRunId: snapshot.runId, sourceIndex: index };
    invariant(source.sourceRunId.trim() && Number.isSafeInteger(source.sourceIndex) && source.sourceIndex >= 0, 'invalid_historical_source');
    message.history = source;
    if (!replayAllowed || original.kind === 'delivery_review_source') {
      delete message.providerReplay; delete message.replayToolIds; delete message.providerReplayProjection;
    }
    if (message.role === 'tool') {
      const pair = message.callId ? pending.get(message.callId) : undefined;
      if (pair) {
        // Backfill only an immediate source Run's exact committed model view.
        // Older ancestry without a carried Host outcome remains unproven.
        const known = message.callId && !original.history ? knownResults.get(message.callId) : null;
        if (message.toolOutcome === undefined && known && known.name === message.name && known.content === message.content)
          message.toolOutcome = 'ok';
        // The source receipt is immutable. A new binding may remove tools;
        // imported references must not require or advertise their old schemas.
        if (configuration.profile.providerToolSearchPolicy === 'anthropic-deferred/v1' && message.discoveredToolNames !== undefined) {
          const allowed = new Set(configuration.tools.filter(tool => configuration.contract.allowedToolNames === null
            || configuration.contract.allowedToolNames.includes(tool.name)).map(tool => tool.name));
          message.discoveredToolNames = message.discoveredToolNames.filter(name => allowed.has(name));
        }
        pending.delete(message.callId!); message.callId = pair.mapped; output.push(message);
      } else {
        flush(); output.push({ role: 'user', kind: 'historical_tool_observation', history: source,
          content: canonical({ status: 'unmatched_tool_result', content: message.content }) });
      }
      continue;
    }
    flush();
    if (message.toolCalls?.length) {
      invariant(message.role === 'assistant', 'malformed_tool_history');
      const ids = new Map<string, string>();
      for (const [callIndex, call] of message.toolCalls.entries()) {
        invariant(call.callId.trim() && !pending.has(call.callId), 'malformed_tool_history');
        const mapped = original.history && options.identityNamespace === undefined ? call.callId : 'hist_' + identify({ scope: snapshot.scope,
          sourceRunId: source.sourceRunId, sourceIndex: source.sourceIndex, callId: call.callId, callIndex,
          ...(options.identityNamespace === undefined ? {} : { identityNamespace: options.identityNamespace }) }).slice(0, 32);
        invariant(!seen.has(mapped), 'duplicate_historical_tool_id'); seen.add(mapped);
        ids.set(call.callId, mapped); pending.set(call.callId, { mapped, source }); call.callId = mapped;
      }
      if (message.providerReplay) message.replayToolIds = composeReplayIds(message.replayToolIds, ids);
    }
    output.push(message);
  }
  flush();
  if (includeFinal && snapshot.finalText && ['completed', 'interrupted'].includes(snapshot.phase)) {
    const last = output.at(-1);
    if (!(last?.role === 'assistant' && !last.toolCalls?.length && last.content === snapshot.finalText)) {
      const candidate = [...snapshot.messages].reverse().find(message => message.role === 'assistant'
        && !message.toolCalls?.length && message.content === snapshot.finalText);
      output.push({ role: 'assistant', content: snapshot.finalText,
        ...(candidate?.completedAtMs === undefined ? {} : { completedAtMs: candidate.completedAtMs }),
        history: candidate?.history ?? { sourceRunId: snapshot.runId, sourceIndex: snapshot.messages.length },
        ...(replayAllowed && candidate?.providerReplay ? { providerReplay: copy(candidate.providerReplay) } : {}) });
    }
  }
  return output;
}

function composeReplayIds(previous: Message['replayToolIds'], ids: Map<string, string>): Record<string, string> {
  const mapped: Record<string, string> = {};
  for (const [original, current] of Object.entries(previous ?? {})) mapped[original] = ids.get(current) ?? current;
  for (const [original, current] of ids) if (!previous || !Object.values(previous).includes(original)) mapped[original] = current;
  return mapped;
}

/** Preserve the raw result receipt while preventing a provider's reused local ids from aliasing history. */
export function normalizeToolIdentities(snapshot: RunSnapshot, result: ModelResult, identify: Identify): ModelResult {
  if (result.kind !== 'tool_calls') return result;
  const existing = new Set(snapshot.messages.flatMap(message => message.toolCalls?.map(call => call.callId) ?? []));
  const originalIds = result.toolCalls.map(call => call.callId);
  invariant(new Set(originalIds).size === originalIds.length, 'invalid_tool_call');
  const reserved = new Set([...existing, ...originalIds]), ids = new Map<string, string>();
  const projected = copy(result);
  for (const [index, call] of projected.toolCalls.entries()) {
    if (!existing.has(call.callId)) continue;
    let salt = 0, mapped: string;
    do {
      invariant(salt < 128, 'tool_identity_collision');
      mapped = 'call_' + identify({ runId: snapshot.runId, revision: snapshot.revision,
        callId: call.callId, index, salt: salt++ }).slice(0, 32);
    } while (reserved.has(mapped));
    reserved.add(mapped); ids.set(call.callId, mapped); call.callId = mapped;
  }
  if (ids.size && projected.providerReplay) projected.replayToolIds = composeReplayIds(projected.replayToolIds, ids);
  return projected;
}
