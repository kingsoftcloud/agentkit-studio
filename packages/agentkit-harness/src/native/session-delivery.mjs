import { createHash } from 'node:crypto';
import { nativeDurableStream } from './assistant-stream.mjs';
import { canonical, invariant, terminal } from '../../../agentkit-harness-core/dist/index.mjs';
import { toolContext } from '../../../agentkit-harness-core/dist/tool-context.mjs';
import { NATIVE_DSH_CONTENT_FORMAT } from './dsh-turn-contract.mjs';
import { readNativeDshBackgroundOwnership } from './dsh-background-ownership.mjs';
import { readNativeDshManagedOwnership } from './dsh-managed-ownership.mjs';

export const NATIVE_DELIVERY_PROJECTION = 'agentkitNativeDelivery';
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const ownObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function atomKey(event) {
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
  flush, systemText, inputMessages, source, onStreamSettled, flushTimeoutMs = 30_000,
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
  const identity = hash({ scope, runId });
  const id = key => `ak-native-${hash({ identity, key })}`;
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

  async function deliver(snapshot) {
    const record = store.load(scope, runId);
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
    invariant(store.sessionHead(scope, snapshot.sessionId)?.runId === runId, 'native_delivery_run_superseded');
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
    // Output retirement preserves immutable model events with their ORIGINAL
    // transcript positions. Reconstruct that timeline, then replay each exact
    // retirement at its original point. Never index old events into new text.
    const messages = structuredClone(snapshot.messages);
    const retirements = new Map();
    for (const event of events.toReversed()) {
      if (event.kind !== 'output.restarted') continue;
      const payload = event.payload, retained = payload.retainedMessageCount, retired = payload.retiredMessages;
      invariant(Number.isSafeInteger(retained) && retained >= 0 && retained < messages.length && Array.isArray(retired)
        && retired.every(message => ownObject(message) && ['user', 'assistant'].includes(message.role)
          && typeof message.content === 'string' && ['continuation_fragment', 'continuation_observation'].includes(message.kind)
          && Object.keys(message).every(key => ['role', 'kind', 'content'].includes(key)))
        && canonical({ role: messages[retained].role, kind: messages[retained].kind ?? null, content: messages[retained].content })
          === canonical(payload.notice), 'native_delivery_output_restart_invalid');
      retirements.set(event.seq, { retained, retired, notice: structuredClone(messages[retained]) });
      messages.splice(retained, 1, ...structuredClone(retired));
    }
    // Admission can contain multiple user/context messages and attachments.
    // They have already been published above, with their original host source
    // and content blocks. Never publish a flattened second copy from Native.
    const admittedUsers = new Set(messages.flatMap((message, index) => message.role === 'user' && !message.history ? [index] : [])
      .slice(0, record.configuration.inputMessages?.length ?? 1));
    const completed = new Map(events.filter(event => event.kind === 'tool.completed')
      .map(event => [event.payload.callId, event.payload.status]));
    const pending = new Map();
    let cursor = 0, step = 1, modelCount = 0, lastAssistant = null;
    const settlements = [];
    const assistant = (key, text, calls, usage, stream = []) => {
      const content = [...(text ? [{ type: 'text', text }] : []),
        ...calls.map(call => ({ type: 'tool-call', id: projectedCallId(call.callId), name: call.name, arguments: canonical(call.arguments) }))];
      const seq = append('assistant/message', { turn, step, message: { id: id(key), role: 'assistant', content, source: { kind: 'model', ...source } },
        stream, ...(usage ? { usage } : {}) }, { surfaceOp: 'append' });
      lastAssistant = { text, calls };
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
      append('tool/result', { turn, step, message: { id: id(key), role: 'tool', source: { kind: 'tool', callId: projected },
        toolCallId: projected, content: blocks(message), isError } }, { surfaceOp: 'append' });
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
          let status = completed.get(message.callId);
          if (status === undefined) {
            try { status = JSON.parse(message.content)?.status; } catch { status = undefined; }
          }
          result(`transcript:${index}`, message.callId, message, ['error', 'uncertain', 'not_dispatched'].includes(status));
        } else invariant(false, 'native_delivery_assistant_binding_missing');
      }
    };
    for (const event of events) {
      if (event.kind === 'output.restarted') {
        const { retained, retired, notice } = retirements.get(event.seq);
        invariant(cursor === retained + retired.length, 'native_delivery_output_restart_cursor_invalid');
        messages.splice(retained, retired.length, notice); cursor = retained;
        continue;
      }
      if (!['model.completed', 'context.summary_completed', 'model.stream_interrupted'].includes(event.kind)) continue;
      const payload = event.payload, index = payload.messageIndex;
      const summary = event.kind === 'context.summary_completed';
      const interrupted = event.kind === 'model.stream_interrupted';
      if (interrupted) {
        drain(payload.messageCursor);
        if (modelCount++ > 0) { append('step/end', { turn, step }); step++; append('step/start', { turn, step }); }
        const seq = append('assistant/attempt', { turn, step, stream: nativeDurableStream(payload.operationKey, payload.displayStream) });
        settlements.push([payload.operationKey, 'assistant/attempt', seq]);
        continue;
      }
      invariant(summary || index === null || Number.isSafeInteger(index) && index >= cursor && messages[index]?.role === 'assistant',
        'native_delivery_model_binding_missing');
      drain(summary || index === null ? payload.messageCursor : index);
      if (modelCount++ > 0) { append('step/end', { turn, step }); step++; append('step/start', { turn, step }); }
      const message = summary || index === null ? null : messages[index];
      const usage = payload.usageReported === false ? null : {
        inputTokens: payload.usage.inputTokens, outputTokens: payload.usage.outputTokens,
        ...(payload.usage.cachedInputTokens === undefined ? {} : { cacheReadTokens: payload.usage.cachedInputTokens }),
        ...(payload.usage.reasoningTokens === undefined ? {} : { reasoningTokens: payload.usage.reasoningTokens }),
      };
      const stream = nativeDurableStream(payload.operationKey, payload.displayStream);
      // An uncommitted provider prefix is an attempt, never a tool batch or
      // final candidate. Keep any reported usage on its existing empty message.
      if (!summary && index === null && stream.length) {
        const seq = append('assistant/attempt', { turn, step, stream });
        settlements.push([payload.operationKey, 'assistant/attempt', seq]);
        assistant(`response:${event.eventId}`, '', [], usage);
      } else {
        const seq = assistant(`response:${event.eventId}`, summary || payload.candidateStatus === 'rejected' ? '' : message?.content ?? payload.text,
          message?.toolCalls ?? [], usage, stream);
        if (payload.operationKey) settlements.push([payload.operationKey, 'assistant/message', seq]);
      }
      if (!summary && index !== null) cursor = index + 1;
      drain(payload.messageCursor);
    }
    drain(messages.length);
    if (terminal(snapshot.phase)) {
      for (const [callId] of pending) {
        const intent = record.intents.find(item => item.kind === 'tool' && item.payload.calls?.some(call => call.callId === callId));
        const receipt = intent && record.receipts.find(item => item.operationKey === intent.operationKey);
        // A committed effect receipt can contain an uncertain per-call result.
        // The state machine stops before adding that result to the transcript;
        // publish its actual public context rather than calling it undispatched.
        const index = intent?.payload.calls.findIndex(call => call.callId === callId);
        const observed = receipt?.status === 'committed' && index >= 0 ? receipt.result.results?.[index] : null;
        if (observed) {
          const context = observed.context === undefined ? { content: canonical(observed.content) } : toolContext(observed.context);
          result(`closure:${callId}`, callId, context, observed.status !== 'ok');
          continue;
        }
        const unknown = intent?.status === 'running' && (!receipt || receipt.status === 'uncertain');
        result(`closure:${callId}`, callId, { content: canonical({ status: unknown ? 'uncertain' : 'not_dispatched',
          reason: unknown ? 'effect_outcome_unknown' : snapshot.reason ?? 'run_ended' }) }, true);
      }
      if (snapshot.finalText && (lastAssistant?.text !== snapshot.finalText || lastAssistant.calls.length)) {
        assistant('final-delivery', snapshot.finalText, [], null);
      }
      append('step/end', { turn, step });
    }
    let timer;
    try {
      const persisted = await Promise.race([Promise.resolve().then(() => flush(session)), new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('native_delivery_flush_timeout'), { code: 'native_delivery_flush_timeout' })), flushTimeoutMs);
      })]);
      invariant(persisted === true, 'native_delivery_not_durable');
    } finally { clearTimeout(timer); }
    state();
    store.acknowledge(scope, runId, projectionName, snapshot.eventSeq);
    for (const settlement of settlements) onStreamSettled?.(...settlement);
  }
  const delivery = snapshot => {
    const next = chain.then(() => deliver(snapshot));
    chain = next.catch(() => {});
    return next;
  };
  delivery.beginStream = () => {
    const record = store.load(scope, runId);
    const step = 1 + record.events.filter(event => ['model.completed', 'context.summary_completed', 'model.stream_interrupted'].includes(event.kind)).length;
    if (step > 1) append('step/end', { turn, step: step - 1 });
    append('step/start', { turn, step });
    return step;
  };
  return delivery;
}
