import { createHash } from 'node:crypto';
import { nativeDurableStream } from './assistant-stream.mjs';
import { canonical, invariant, terminal, RESULT_DELIVERY_POLICY, FINAL_SUBMISSION_TOOL } from '@kingsoftcloud/agentkit-harness-core';
import { NATIVE_DSH_CONTENT_FORMAT } from './dsh-turn-contract.mjs';
import { readNativeDshBackgroundOwnership } from './dsh-background-ownership.mjs';
import { readNativeDshManagedOwnership } from './dsh-managed-ownership.mjs';
import { nativeDeliveryId, nativeDeliveryTimeline } from './delivery-timeline.mjs';
import { projectNativeSessionDelivery } from './session-delivery-journal.mjs';
import { nativeContextMarkerFacts } from './context-markers.mjs';

export const NATIVE_DELIVERY_PROJECTION = 'agentkitNativeDelivery';
export const NATIVE_CONTEXT_PRESENTATION_EVENT = 'agentkit-native/context-marker';
export const NATIVE_CONTEXT_PRESENTATION_CONTRACT = 'agentkit.native-context-presentation/v1';
export const NATIVE_TOOL_OUTCOME_CONTRACT = 'agentkit.native-tool-outcome/v1';
export const NATIVE_TOOL_OUTCOME_PRESENTATION_EVENT = 'agentkit-native/tool-outcome';

/** Presentation fact from a scoped committed journal, never model prose. */
export function nativeToolOutcomeFact(identity, callId, status, presentationTurn = Number(identity.turnId)) {
  // Native identities may use opaque turn IDs. The external owner separately
  // validates the SDK's numeric presentation position; never rewrite a Run's
  // execution identity to manufacture that position.
  const turn = presentationTurn;
  invariant(Number.isSafeInteger(turn) && turn > 0 && typeof identity.sessionId === 'string' && identity.sessionId
    && typeof identity.runId === 'string' && identity.runId && typeof callId === 'string' && callId
    && ['ok', 'error', 'uncertain', 'not_dispatched'].includes(status), 'native_tool_outcome_identity_invalid');
  return { contract: NATIVE_TOOL_OUTCOME_CONTRACT, sessionId: identity.sessionId, runId: identity.runId, turn,
    callId: nativeDeliveryId(identity.scope, identity.runId, `call:${callId}`), status };
}
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const ownObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Public display deltas only. Opaque replay/signatures and tool previews are never content. */
function displayText(stream, type) {
  return stream.filter(record => record.chunk?.type === type && typeof record.chunk.text === 'string')
    .map(record => record.chunk.text).join('');
}

/** Native totals include cache input; DSH's input/cache buckets are disjoint. */
function sessionUsage(usage) {
  const read = usage.cachedInputTokens ?? 0, write = usage.cacheWriteInputTokens ?? 0;
  const splitKnown = Number.isSafeInteger(read) && read >= 0 && Number.isSafeInteger(write) && write >= 0
    && read <= usage.inputTokens && write <= usage.inputTokens - read;
  const total = usage.inputTokens + usage.outputTokens;
  return {
    inputTokens: splitKnown ? usage.inputTokens - read - write : usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(Number.isSafeInteger(total) ? { totalTokens: total } : {}),
    ...(splitKnown && usage.cachedInputTokens !== undefined ? { cacheReadTokens: read } : {}),
    ...(splitKnown && usage.cacheWriteInputTokens !== undefined ? { cacheWriteTokens: write } : {}),
    ...(usage.reasoningTokens === undefined ? {} : { reasoningTokens: usage.reasoningTokens }),
  };
}

function atomKey(event) {
  if (event.type === NATIVE_TOOL_OUTCOME_PRESENTATION_EVENT) {
    const fact = event.data;
    invariant(event.ignorable === true && fact?.contract === NATIVE_TOOL_OUTCOME_CONTRACT
      && fact.status === 'not_dispatched' && [fact.runId, fact.sessionId].every(value => typeof value === 'string' && value.trim())
      && Number.isSafeInteger(fact.turn) && fact.turn > 0 && /^ak-native-[a-f0-9]{64}$/.test(fact.callId ?? ''),
    'native_delivery_tool_outcome_invalid');
    return `tool-outcome:${fact.runId}:${fact.callId}:${fact.status}`;
  }
  if (event.type === NATIVE_CONTEXT_PRESENTATION_EVENT) {
    const { contract, runId, sessionId, turn, marker } = event.data ?? {};
    invariant(event.ignorable === true && contract === NATIVE_CONTEXT_PRESENTATION_CONTRACT
      && [runId, sessionId].every(value => typeof value === 'string' && value.trim() && value.length <= 256)
      && Number.isSafeInteger(turn) && turn > 0 && /^ak-native-[a-f0-9]{64}$/.test(marker?.id ?? '')
      && ['completed', 'failed', 'interrupted'].includes(marker.status) && marker.origin === 'auto'
      && ['start', 'tool', 'message'].includes(marker.after?.kind)
      && (marker.after.kind === 'start' || /^ak-native-[a-f0-9]{64}$/.test(marker.after.id ?? '')),
    'native_delivery_context_marker_invalid');
    return `context:${runId}:${marker.id}:${marker.status}`;
  }
  if (event.type === 'plan/mode' && /^ak-native-[a-f0-9]{64}$/.test(event.data.nativeId ?? '')) return `plan:${event.data.nativeId}`;
  if (event.type === 'todo/write' && /^ak-native-[a-f0-9]{64}$/.test(event.data.nativeId ?? '')) return `todo:${event.data.nativeId}`;
  if (['system/message', 'user/message', 'assistant/message', 'tool/result'].includes(event.type)) {
    const message = event.type === 'user/message' ? event.data : event.data.message;
    return `message:${message.id}`;
  }
  if (event.type === 'tool/call') return `call:${event.data.callId}`;
  // Standard DSH may produce several failed attempts in the same step. Their
  // streams must coexist in this host-wide fold without claiming a Native ID.
  if (event.type === 'assistant/attempt') return `attempt:${hash(event.data)}`;
  if (event.type === 'step/start' || event.type === 'step/end') return `${event.type}:${event.data.turn}:${event.data.step}`;
  return null;
}
function atomDigest(event) {
  return hash({ type: event.type, data: event.data,
    ...(event.ignorable ? { ignorable: true } : {}),
    ...(event.surfaceOp ? { surfaceOp: event.surfaceOp } : {}),
    ...(event.sourceEventSeqs ? { sourceEventSeqs: event.sourceEventSeqs } : {}),
  });
}

/** Host-only fold of actual Session events; it grants no Native execution authority. */
export function nativeDeliveryProjection() {
  return {
    key: NATIVE_DELIVERY_PROJECTION, stateVersion: 3,
    stateSchema: { parse(value) {
      invariant(ownObject(value) && ownObject(value.atoms) && ownObject(value.seqs) && Number.isSafeInteger(value.turn) && value.turn >= 0
        && typeof value.openTurn === 'boolean' && typeof value.hasSurface === 'boolean' && Object.values(value.atoms).every(item => /^[a-f0-9]{64}$/.test(item)), 'native_delivery_state_invalid');
      invariant(Object.keys(value.atoms).length === Object.keys(value.seqs).length
        && Object.keys(value.atoms).every(key => Number.isSafeInteger(value.seqs[key]) && value.seqs[key] > 0), 'native_delivery_state_invalid');
      if (value.head !== null) invariant(ownObject(value.head) && Number.isSafeInteger(value.head.seq)
        && typeof value.head.id === 'string' && Array.isArray(value.head.content), 'native_delivery_state_invalid');
      canonical(value);
      return value;
    } },
    init: () => ({ atoms: {}, seqs: {}, turn: 0, openTurn: false, hasSurface: false, head: null }),
    apply(state, event) {
      if (event.type === 'turn/start') return { ...state, turn: event.data.turn, openTurn: true };
      if (event.type === 'turn/end') return { ...state, openTurn: false };
      const key = atomKey(event);
      if (key === null) return state;
      const fingerprint = atomDigest(event);
      invariant(!Object.hasOwn(state.atoms, key) || state.atoms[key] === fingerprint, 'native_delivery_atom_conflict');
      const head = event.type === 'system/message' && event.surfaceOp
        ? { id: event.data.message.id, seq: event.seq, content: event.data.message.content } : state.head;
      return { ...state, atoms: { ...state.atoms, [key]: fingerprint }, seqs: { ...state.seqs, [key]: event.seq }, head,
        hasSurface: state.hasSurface || Boolean(event.surfaceOp) };
    },
  };
}

/**
 * Deliver committed Native transcript and usage into a live DSH turn. Register
 * nativeDeliveryProjection first. `flush` must call the Host's sessions.flush.
 * The Native cursor is acknowledged only after a durable flush. Replaying the
 * complete plan deduplicates an append that succeeded before acknowledgment.
 * Without an explicit external ownership contract, Native turn ID must equal
 * the numeric DSH position. Managed ownership pins the sealed Run and input;
 * background ownership pins its admission/notice with empty inputMessages.
 */
export function createNativeSessionDelivery({ store, scope, runId, session, turn, projections,
  flush, systemText, inputMessages, source, onStreamSettled, isStreamPending, flushTimeoutMs = 30_000,
  backgroundOwnership = null, managedOwnership = null } = {}) {
  invariant(typeof flush === 'function' && typeof systemText === 'string' && Array.isArray(inputMessages)
    && Number.isSafeInteger(turn) && turn > 0 && typeof source?.provider === 'string' && source.provider
    && typeof source?.model === 'string' && source.model, 'native_delivery_binding_invalid');
  invariant(Number.isFinite(flushTimeoutMs) && flushTimeoutMs > 0, 'native_delivery_flush_timeout_invalid');
  const input = structuredClone(inputMessages);
  canonical(input);
  invariant(input.every(message => message.role === 'user' && typeof message.id === 'string'), 'native_delivery_input_invalid');
  // Explicit external-owner contracts separate Native identity from the SDK's
  // numeric delivery position. Ordinary turns retain their original contract.
  invariant(backgroundOwnership === null || managedOwnership === null, 'native_delivery_binding_invalid');
  const background = backgroundOwnership === null ? null
    : readNativeDshBackgroundOwnership(backgroundOwnership, { sessionId: String(session.id), turn });
  const managed = managedOwnership === null ? null
    : readNativeDshManagedOwnership(managedOwnership, { sessionId: String(session.id), turn });
  if (managed) invariant(managed.identity.runId === runId && canonical(managed.identity.scope) === canonical(scope),
    'native_delivery_managed_admission_invalid');
  if (background) invariant(input.length === 0 && background.identity.runId === runId
    && canonical(background.identity.scope) === canonical(scope) && background.configuration.instructions === systemText,
  'native_delivery_background_admission_invalid');
  source = { provider: source.provider, model: source.model };
  const id = key => nativeDeliveryId(scope, runId, key);
  const projectedCallId = callId => id(`call:${callId}`);
  const projectionPrefix = `dsh:${session.id}:${turn}:v1:`;
  const projectionName = `${projectionPrefix}${hash({ systemText, input, source, ...(background ? { background } : {}),
    ...(managed ? { managed } : {}) })}`;
  let chain = Promise.resolve();
  const state = () => {
    const value = projections.stateOf(session, NATIVE_DELIVERY_PROJECTION);
    invariant(value !== undefined, 'native_delivery_projection_missing');
    invariant(value.turn === turn, 'native_delivery_turn_mismatch');
    invariant(value.openTurn, 'native_delivery_turn_closed');
    return value;
  };
  const append = (type, data, options = {}) => {
    const event = { type, data, ...options }, key = atomKey(event);
    invariant(key !== null, 'native_delivery_event_invalid');
    const fingerprint = atomDigest(event), previous = state().atoms[key];
    if (previous !== undefined) { invariant(previous === fingerprint, 'native_delivery_atom_conflict'); return state().seqs[key]; }
    session.append(type, data, options);
    invariant(state().atoms[key] === fingerprint, 'native_delivery_projection_not_advanced');
    return state().seqs[key];
  };

  async function flushDurably() {
    let timer;
    try {
      const persisted = await Promise.race([Promise.resolve().then(() => flush(session)), new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('native_delivery_flush_timeout'), { code: 'native_delivery_flush_timeout' })), flushTimeoutMs);
      })]);
      invariant(persisted === true, 'native_delivery_not_durable');
    } finally { clearTimeout(timer); }
  }
  async function settleStream(operationKey, eventType, seq) {
    if (!operationKey || !onStreamSettled || isStreamPending && !isStreamPending(operationKey)) return;
    // The SDK's committed end frame names a DURABLE Session event. Keep later
    // tool events behind this barrier so a follower can first release its
    // staged assistant message. A failed flush leaves the live attempt open
    // for abandonment; Native execution evidence is already committed.
    await flushDurably();
    await onStreamSettled(operationKey, eventType, seq);
  }

  async function deliver(snapshot) {
    const record = typeof store.sessionDeliveryState === 'function'
      ? store.sessionDeliveryState(scope, runId) : projectNativeSessionDelivery(store.load(scope, runId));
    invariant(record.snapshot.revision === snapshot.revision && record.snapshot.eventSeq === snapshot.eventSeq,
      'native_delivery_checkpoint_stale');
    invariant(canonical(snapshot.scope) === canonical(scope) && snapshot.runId === runId
      && snapshot.sessionId === String(session.id) && snapshot.turnId === (background?.identity.turnId ?? managed?.identity.turnId ?? String(turn)),
    'native_delivery_identity_mismatch');
    if (managed) {
      const capsule = record.configuration.hostRecoveryBinding;
      invariant(snapshot.configDigest === managed.configDigest && hash(record.configuration) === managed.configDigest
        && Object.entries(managed.identity).every(([key, value]) => canonical(snapshot[key]) === canonical(value))
        && capsule && canonical(capsule.messages) === canonical(input) && canonical(capsule.source) === canonical(source)
        && capsule.systemPrompt === systemText && record.configuration.instructions === systemText,
      'native_delivery_managed_admission_invalid');
    }
    if (background) invariant(record.snapshot.configDigest === background.configDigest
      && canonical(record.configuration) === canonical(background.configuration)
      && canonical(record.snapshot.backgroundNotification ?? null) === canonical(background.notification)
      && ['buildId', 'parentRunId', 'taskChainId'].every(key => snapshot[key] === background.identity[key]),
    'native_delivery_background_admission_invalid');
    const head = store.sessionHeadView ? store.sessionHeadView(scope, snapshot.sessionId) : store.sessionHead(scope, snapshot.sessionId);
    invariant(head?.runId === runId, 'native_delivery_run_superseded');
    invariant(Object.keys(record.projections).filter(key => key.startsWith(projectionPrefix))
      .every(key => key === projectionName), 'native_delivery_admission_changed');
    // Pin the consumer identity before any Session append; a retry must use
    // the same admitted input even if no Native event has been delivered yet.
    state();
    if (!Object.hasOwn(record.projections, projectionName)) store.acknowledge(scope, runId, projectionName, 0);
    append('step/start', { turn, step: 1 });
    const desired = systemText ? [{ type: 'text', text: systemText }] : [];
    const current = state();
    if (!current.head || canonical(current.head.content) !== canonical(desired)) {
      invariant(current.head || !current.hasSurface, 'native_delivery_system_head_missing');
      append('system/message', { turn, step: 1, message: { id: id('system'), role: 'system', content: desired,
        source: { kind: 'system-prompt' } } }, current.head
        ? { surfaceOp: 'replace', sourceEventSeqs: [current.head.seq] } : { surfaceOp: 'append' });
    }
    for (const message of input) {
      append('user/message', message, { surfaceOp: 'append' });
    }
    if (background) {
      const notices = snapshot.messages.filter(message => message.role === 'user'
        && message.kind === 'background_command_observation' && !message.history);
      invariant(notices.length === 1, 'native_delivery_background_notice_missing');
      append('user/message', { id: id('background-notification'), role: 'user',
        source: { kind: 'agentkit-native-background-notification', form: 'notice', summary: 'Background command result',
          sourceRunId: background.notification.sourceRunId, taskId: background.notification.taskId },
        content: [{ type: 'text', text: notices[0].content }] }, { surfaceOp: 'append' });
    }

    const events = record.events.filter(event => event.seq <= snapshot.eventSeq);
    const inputBoundaries = new Map(record.inputBoundaries);
    // Output retirement preserves immutable model events with their ORIGINAL
    // transcript positions. Reconstruct that timeline, then replay each exact
    // retirement at its original point. Never index old events into new text.
    const { messages, retirements } = nativeDeliveryTimeline(record);
    // Admission can contain multiple user/context messages and attachments.
    // They have already been published above, with their original host source
    // and content blocks. Never publish a flattened second copy from Native.
    const admittedUsers = new Set(messages.flatMap((message, index) => message.role === 'user' && !message.history && message.kind !== 'session_injection' ? [index] : [])
      .slice(0, record.configuration.inputMessages?.length ?? 1));
    const completed = new Map(record.toolOutcomes), displays = new Map(record.displays), closures = new Map(record.closures);
    const privateResultCalls = new Set(record.configuration.deliveryScopePolicy === RESULT_DELIVERY_POLICY
      ? messages.flatMap(message => (message.toolCalls ?? []).filter(call => call.name === FINAL_SUBMISSION_TOOL).map(call => call.callId)) : []);
    const pending = new Map();
    let cursor = 0, step = 1, modelCount = 0, lastAssistant = null;
    const visibleReasoning = record.configuration.profile.providerThinkingDisplayPolicy === 'provider-visible/v1';
    const assistant = async (key, text, calls, usage, stream = [], interrupted = false, operationKey) => {
      calls = calls.filter(call => !privateResultCalls.has(call.callId));
      const reasoning = visibleReasoning ? displayText(stream, 'reasoning-delta') : '';
      const content = [...(reasoning ? [{ type: 'reasoning', text: reasoning }] : []), ...(text ? [{ type: 'text', text }] : []),
        ...calls.map(call => ({ type: 'tool-call', id: projectedCallId(call.callId), name: call.name, arguments: canonical(call.arguments) }))];
      const seq = append('assistant/message', { turn, step, message: { id: id(key), role: 'assistant', content, source: { kind: 'model', ...source } },
        stream, ...(interrupted ? { interrupted: true } : {}), ...(usage ? { usage } : {}) }, { surfaceOp: 'append' });
      await settleStream(operationKey, 'assistant/message', seq);
      lastAssistant = interrupted ? null : { text, calls };
      for (const call of calls) {
        pending.set(call.callId, call);
        append('tool/call', { turn, step, callId: projectedCallId(call.callId), name: call.name, arguments: canonical(call.arguments) });
      }
      return seq;
    };
    const blocks = message => message.presentation?.format === NATIVE_DSH_CONTENT_FORMAT
      ? structuredClone(message.presentation.content) : [{ type: 'text', text: message.content }];
    const result = (key, callId, message, isError) => {
      const projected = projectedCallId(callId);
      const outcome = completed.get(callId);
      // A separate additive fact preserves the exact old tool/result atom on
      // replay. Publish it first for new results so the Native follower never
      // paints an undispatched request as a failed execution.
      if (outcome === 'not_dispatched') append(NATIVE_TOOL_OUTCOME_PRESENTATION_EVENT,
        nativeToolOutcomeFact(snapshot, callId, outcome, turn), { ignorable: true });
      const nativeOutcome = outcome === 'uncertain' ? nativeToolOutcomeFact(snapshot, callId, outcome, turn) : null;
      const display = !isError && displays.has(callId) ? structuredClone(displays.get(callId)) : null;
      append('tool/result', { turn, step, message: { id: id(key), role: 'tool', source: { kind: 'tool', callId: projected },
        toolCallId: projected, content: blocks(message), isError },
        ...(display || nativeOutcome ? { meta: { ...display, ...(nativeOutcome ? { nativeOutcome } : {}) } } : {}) }, { surfaceOp: 'append' });
      pending.delete(callId);
    };
    const drain = through => {
      invariant(Number.isSafeInteger(through) && through >= cursor && through <= messages.length, 'native_delivery_transcript_cursor_invalid');
      while (cursor < through) {
        const index = cursor++, message = messages[index];
        if (message.history || message.role === 'system' || admittedUsers.has(index)) continue;
        if (message.role === 'user') {
          // Human steering and Host-admitted tool context keep distinct sources.
          // Model, verification and Hook feedback remain private execution context.
          if (['tool_context', 'host_input'].includes(message.kind) && message.presentation?.format === NATIVE_DSH_CONTENT_FORMAT) {
            const original = message.presentation.source;
            const contextSource = message.kind === 'tool_context' && original?.kind === 'tool' ? { ...original, callId: projectedCallId(original.callId) }
              : original || (message.kind === 'host_input' ? { kind: 'user' }
                : { kind: 'agentkit-native-tool-context', form: 'notice', summary: 'Tool-provided context' });
            append('user/message', { id: id(`transcript:${index}`), role: 'user', source: contextSource,
              content: blocks(message) }, { surfaceOp: 'append' });
          } else if (['guidance', 'steering', 'host_input'].includes(message.kind)) append('user/message', {
            id: id(`transcript:${index}`), role: 'user', source: { kind: 'user' },
            content: [{ type: 'text', text: message.content }] }, { surfaceOp: 'append' });
        }
        else if (message.role === 'tool') {
          if (privateResultCalls.has(message.callId)) continue;
          let status = completed.get(message.callId);
          if (status === undefined) {
            try { status = JSON.parse(message.content)?.status; } catch { status = undefined; }
          }
          result(`transcript:${index}`, message.callId, message, ['error', 'uncertain', 'not_dispatched'].includes(status));
        } else if (message.role !== 'assistant' || message.kind !== 'candidate_draft') invariant(false, 'native_delivery_assistant_binding_missing');
      }
    };
    const contextFacts = nativeContextMarkerFacts(record, { driving: !terminal(snapshot.phase) });
    for (const event of events) {
      // The adoption/terminal event fixes the durable position across warm
      // checkpoints, append-before-flush retries and cold replay.
      for (const { marker, settledSeq } of contextFacts) if (settledSeq === event.seq) {
        append(NATIVE_CONTEXT_PRESENTATION_EVENT, { contract: NATIVE_CONTEXT_PRESENTATION_CONTRACT,
          runId, sessionId: String(session.id), turn, marker }, { ignorable: true });
      }
      if (['plan.initialized', 'plan.mode_changed'].includes(event.kind)) {
        drain(event.payload.messageCursor);
        append('plan/mode', { active: event.payload.active, nativeId: id(`plan:${event.eventId}`) });
        continue;
      }
      if (['todo.initialized', 'todo.updated'].includes(event.kind)) {
        drain(event.payload.messageCursor);
        append('todo/write', { todos: structuredClone(event.payload.todos), nativeId: id(`todo:${event.eventId}`) });
        continue;
      }
      if (event.kind === 'effect.prepared' && event.payload.kind === 'input'
        && inputBoundaries.has(event.payload.operationKey) && modelCount > 0) {
        // Host pre-step observers consume durable file touches at step/end.
        // Publish that boundary before preparing the next input, including on
        // cold replay; the intent cursor fixes its order before new context.
        drain(inputBoundaries.get(event.payload.operationKey));
        invariant(pending.size === 0, 'native_delivery_input_before_tool_settlement');
        append('step/end', { turn, step });
        continue;
      }
      if (event.kind === 'output.restarted') {
        const { retained, retired, notice } = retirements.get(event.seq);
        invariant(cursor === retained + retired.length, 'native_delivery_output_restart_cursor_invalid');
        messages.splice(retained, retired.length, notice); cursor = retained;
        continue;
      }
      if (!['model.completed', 'context.summary_completed', 'completion.delivery_review_completed', 'model.stream_interrupted'].includes(event.kind)) continue;
      const payload = event.payload, index = payload.messageIndex;
      const summary = event.kind === 'context.summary_completed' || event.kind === 'completion.delivery_review_completed' && index === null;
      const interrupted = event.kind === 'model.stream_interrupted';
      if (interrupted) {
        drain(payload.messageCursor);
        if (modelCount++ > 0) { append('step/end', { turn, step }); step++; append('step/start', { turn, step }); }
        const stream = nativeDurableStream(payload.operationKey, payload.displayStream, record.configuration);
        const readable = visibleReasoning && (displayText(stream, 'text-delta') || displayText(stream, 'reasoning-delta'));
        if (readable) await assistant(`interrupted:${event.eventId}`, displayText(stream, 'text-delta'), [], null, stream, true, payload.operationKey);
        else {
          const seq = append('assistant/attempt', { turn, step, stream });
          await settleStream(payload.operationKey, 'assistant/attempt', seq);
        }
        continue;
      }
      invariant(summary || index === null || Number.isSafeInteger(index) && index >= cursor && messages[index]?.role === 'assistant',
        'native_delivery_model_binding_missing');
      drain(summary || index === null ? payload.messageCursor : index);
      if (modelCount++ > 0) { append('step/end', { turn, step }); step++; append('step/start', { turn, step }); }
      const message = summary || index === null ? null : messages[index];
      const usage = payload.usageReported === false ? null : sessionUsage(payload.usage);
      const stream = nativeDurableStream(payload.operationKey, payload.displayStream, record.configuration);
      // An uncommitted provider prefix is an attempt, never a tool batch or
      // final candidate. New display admissions retain readable public content;
      // legacy admissions keep their attempt and empty usage message unchanged.
      if (!summary && index === null && stream.length) {
        if (visibleReasoning && (displayText(stream, 'text-delta') || displayText(stream, 'reasoning-delta'))) {
          await assistant(`response:${event.eventId}`, displayText(stream, 'text-delta'), [], usage, stream, true, payload.operationKey);
        } else {
          const seq = append('assistant/attempt', { turn, step, stream });
          await settleStream(payload.operationKey, 'assistant/attempt', seq);
          await assistant(`response:${event.eventId}`, '', [], usage);
        }
      } else {
        await assistant(`response:${event.eventId}`, summary || payload.candidateStatus === 'rejected' ? '' : message?.content ?? payload.text,
          message?.toolCalls ?? [], usage, stream, false, payload.operationKey);
      }
      if (!summary && index !== null) cursor = index + 1;
      drain(payload.messageCursor);
    }
    drain(messages.length);
    if (terminal(snapshot.phase)) {
      for (const [callId] of pending) {
        const closure = closures.get(callId);
        invariant(closure, 'native_delivery_closure_missing');
        const { context, isError } = closure;
        result(`closure:${callId}`, callId, context, isError);
      }
      if (snapshot.finalText && (lastAssistant?.text !== snapshot.finalText || lastAssistant.calls.length)) {
        await assistant('final-delivery', snapshot.finalText, [], null);
      }
      append('step/end', { turn, step });
    }
    await flushDurably();
    state();
    store.acknowledge(scope, runId, projectionName, snapshot.eventSeq);
  }
  const delivery = snapshot => {
    const next = chain.then(() => deliver(snapshot));
    chain = next.catch(() => {});
    return next;
  };
  delivery.beginStream = () => {
    const events = typeof store.sessionDeliveryState === 'function'
      ? store.sessionDeliveryState(scope, runId).events : store.events(scope, runId);
    const step = 1 + events.filter(event => ['model.completed', 'context.summary_completed', 'completion.delivery_review_completed', 'model.stream_interrupted'].includes(event.kind)).length;
    if (step > 1) append('step/end', { turn, step: step - 1 });
    append('step/start', { turn, step });
    return step;
  };
  return delivery;
}
