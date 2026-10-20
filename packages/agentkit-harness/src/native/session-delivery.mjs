import { createHash } from 'node:crypto';
import { canonical, invariant, terminal } from '../../../agentkit-harness-core/dist/index.mjs';

export const NATIVE_DELIVERY_PROJECTION = 'agentkitNativeDelivery';
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const ownObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function atomKey(event) {
  if (['system/message', 'user/message', 'assistant/message', 'tool/result'].includes(event.type)) {
    const message = event.type === 'user/message' ? event.data : event.data.message;
    return `message:${message.id}`;
  }
  if (event.type === 'tool/call') return `call:${event.data.callId}`;
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
    key: NATIVE_DELIVERY_PROJECTION, stateVersion: 1,
    stateSchema: { parse(value) {
      invariant(ownObject(value) && ownObject(value.atoms) && Number.isSafeInteger(value.turn) && value.turn >= 0
        && typeof value.hasSurface === 'boolean' && Object.values(value.atoms).every(item => /^[a-f0-9]{64}$/.test(item)), 'native_delivery_state_invalid');
      if (value.head !== null) invariant(ownObject(value.head) && Number.isSafeInteger(value.head.seq)
        && typeof value.head.id === 'string' && Array.isArray(value.head.content), 'native_delivery_state_invalid');
      canonical(value);
      return value;
    } },
    init: () => ({ atoms: {}, turn: 0, hasSurface: false, head: null }),
    apply(state, event) {
      if (event.type === 'turn/start') return { ...state, turn: event.data.turn };
      const key = atomKey(event);
      if (key === null) return state;
      const fingerprint = atomDigest(event);
      invariant(!Object.hasOwn(state.atoms, key) || state.atoms[key] === fingerprint, 'native_delivery_atom_conflict');
      const head = event.type === 'system/message' && event.surfaceOp
        ? { id: event.data.message.id, seq: event.seq, content: event.data.message.content } : state.head;
      return { ...state, atoms: { ...state.atoms, [key]: fingerprint }, head,
        hasSurface: state.hasSurface || Boolean(event.surfaceOp) };
    },
  };
}

/**
 * Deliver committed Native transcript and usage into a live DSH turn. Register
 * nativeDeliveryProjection first. `flush` must call the Host's sessions.flush.
 * The Native cursor is acknowledged only after a durable flush. Replaying the
 * complete plan deduplicates an append that succeeded before acknowledgment.
 */
export function createNativeSessionDelivery({ store, scope, runId, session, turn, projections,
  flush, systemText, inputMessages, source, flushTimeoutMs = 30_000 } = {}) {
  invariant(typeof flush === 'function' && typeof systemText === 'string' && Array.isArray(inputMessages)
    && Number.isSafeInteger(turn) && turn > 0 && typeof source?.provider === 'string' && source.provider
    && typeof source?.model === 'string' && source.model, 'native_delivery_binding_invalid');
  invariant(Number.isFinite(flushTimeoutMs) && flushTimeoutMs > 0, 'native_delivery_flush_timeout_invalid');
  const input = structuredClone(inputMessages);
  canonical(input);
  invariant(input.every(message => message.role === 'user' && typeof message.id === 'string'), 'native_delivery_input_invalid');
  source = { provider: source.provider, model: source.model };
  const identity = hash({ scope, runId });
  const id = key => `ak-native-${hash({ identity, key })}`;
  const projectedCallId = callId => id(`call:${callId}`);
  const projectionPrefix = `dsh:${session.id}:${turn}:v1:`;
  const projectionName = `${projectionPrefix}${hash({ systemText, input, source })}`;
  let chain = Promise.resolve();
  const state = () => {
    const value = projections.stateOf(session, NATIVE_DELIVERY_PROJECTION);
    invariant(value !== undefined, 'native_delivery_projection_missing');
    invariant(value.turn === turn, 'native_delivery_turn_mismatch');
    return value;
  };
  const append = (type, data, options = {}) => {
    const event = { type, data, ...options }, key = atomKey(event);
    invariant(key !== null, 'native_delivery_event_invalid');
    const fingerprint = atomDigest(event), previous = state().atoms[key];
    if (previous !== undefined) { invariant(previous === fingerprint, 'native_delivery_atom_conflict'); return; }
    session.append(type, data, options);
    invariant(state().atoms[key] === fingerprint, 'native_delivery_projection_not_advanced');
  };

  async function deliver(snapshot) {
    const record = store.load(scope, runId);
    invariant(record.snapshot.revision === snapshot.revision && record.snapshot.eventSeq === snapshot.eventSeq,
      'native_delivery_checkpoint_stale');
    invariant(canonical(snapshot.scope) === canonical(scope) && snapshot.runId === runId
      && snapshot.sessionId === String(session.id) && snapshot.turnId === String(turn), 'native_delivery_identity_mismatch');
    invariant(store.sessionHead(scope, snapshot.sessionId)?.runId === runId, 'native_delivery_run_superseded');
    invariant(Object.keys(record.projections).filter(key => key.startsWith(projectionPrefix))
      .every(key => key === projectionName), 'native_delivery_admission_changed');
    // Pin the consumer identity before any Session append; a retry must use
    // the same admitted input even if no Native event has been delivered yet.
    if (!Object.hasOwn(record.projections, projectionName)) store.acknowledge(scope, runId, projectionName, 0);
    state();
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

    const messages = snapshot.messages, events = record.events.filter(event => event.seq <= snapshot.eventSeq);
    const firstUser = messages.findIndex(message => message.role === 'user' && !message.history);
    const completed = new Map(events.filter(event => event.kind === 'tool.completed')
      .map(event => [event.payload.callId, event.payload.status]));
    const pending = new Map();
    let cursor = 0, step = 1, modelCount = 0, lastAssistant = null;
    const assistant = (key, text, calls, usage) => {
      const content = [...(text ? [{ type: 'text', text }] : []),
        ...calls.map(call => ({ type: 'tool-call', id: projectedCallId(call.callId), name: call.name, arguments: canonical(call.arguments) }))];
      append('assistant/message', { turn, step, message: { id: id(key), role: 'assistant', content, source: { kind: 'model', ...source } },
        stream: [], ...(usage ? { usage } : {}) }, { surfaceOp: 'append' });
      lastAssistant = { text, calls };
      for (const call of calls) {
        pending.set(call.callId, call);
        append('tool/call', { turn, step, callId: projectedCallId(call.callId), name: call.name, arguments: canonical(call.arguments) });
      }
    };
    const result = (key, callId, text, isError) => {
      const projected = projectedCallId(callId);
      append('tool/result', { turn, step, message: { id: id(key), role: 'tool', source: { kind: 'tool', callId: projected },
        toolCallId: projected, content: [{ type: 'text', text }], isError } }, { surfaceOp: 'append' });
      pending.delete(callId);
    };
    const drain = through => {
      invariant(Number.isSafeInteger(through) && through >= cursor && through <= messages.length, 'native_delivery_transcript_cursor_invalid');
      while (cursor < through) {
        const index = cursor++, message = messages[index];
        if (message.history || message.role === 'system' || index === firstUser) continue;
        if (message.role === 'user') append('user/message', { id: id(`transcript:${index}`), role: 'user',
          content: [{ type: 'text', text: message.content }] }, { surfaceOp: 'append' });
        else if (message.role === 'tool') {
          let status = completed.get(message.callId);
          if (status === undefined) {
            try { status = JSON.parse(message.content)?.status; } catch { status = undefined; }
          }
          result(`transcript:${index}`, message.callId, message.content, ['error', 'uncertain', 'not_dispatched'].includes(status));
        } else invariant(false, 'native_delivery_assistant_binding_missing');
      }
    };
    for (const event of events) {
      if (!['model.completed', 'context.summary_completed'].includes(event.kind)) continue;
      const payload = event.payload, index = payload.messageIndex;
      const summary = event.kind === 'context.summary_completed';
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
      assistant(`response:${event.eventId}`, summary || payload.candidateStatus === 'rejected' ? '' : message?.content ?? payload.text,
        message?.toolCalls ?? [], usage);
      if (!summary && index !== null) cursor = index + 1;
      drain(payload.messageCursor);
    }
    drain(messages.length);
    if (terminal(snapshot.phase)) {
      for (const [callId] of pending) {
        const intent = record.intents.find(item => item.kind === 'tool' && item.payload.calls?.some(call => call.callId === callId));
        const receipt = intent && record.receipts.find(item => item.operationKey === intent.operationKey);
        const unknown = intent?.status === 'running' && (!receipt || receipt.status === 'uncertain');
        result(`closure:${callId}`, callId, canonical({ status: unknown ? 'uncertain' : 'not_dispatched',
          reason: unknown ? 'effect_outcome_unknown' : snapshot.reason ?? 'run_ended' }), true);
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
    store.acknowledge(scope, runId, projectionName, snapshot.eventSeq);
  }
  return snapshot => {
    const next = chain.then(() => deliver(snapshot));
    chain = next.catch(() => {});
    return next;
  };
}
