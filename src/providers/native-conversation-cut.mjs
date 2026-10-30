import { copy, invariant } from '@kingsoftcloud/agentkit-harness-core';
import { nativeDeliveryClosure, nativeDeliveryId, nativeDeliveryTimeline } from '@kingsoftcloud/agentkit-harness-node/native/delivery-timeline';

/** Resolve a published partial-turn boundary to its exact Native transcript.
 * A source may have continued since the fork. Never use its latest message
 * cursor, pending input, or final answer as the selected conversation boundary. */
export function nativeConversationCut(record, admission, prefix) {
  const { messages, retirements } = nativeDeliveryTimeline(record);
  const id = key => nativeDeliveryId(record.snapshot.scope, record.snapshot.runId, key);
  const ownerIndex = prefix.findLastIndex(event => event.type === 'turn/owner');
  const start = prefix.findLastIndex((event, index) => index < ownerIndex && event.type === 'turn/start');
  invariant(start >= 0, 'native_conversation_fork_invalid_transcript');
  const nextTurn = prefix.findIndex((event, index) => index > ownerIndex && event.type === 'turn/start');
  const visible = prefix.slice(start + 1, nextTurn < 0 ? undefined : nextTurn)
    .filter(event => ['user/message', 'assistant/message', 'tool/result'].includes(event.type));
  const target = visible.at(-1);
  const targetId = target?.type === 'user/message' ? target.data.id : target?.data.message.id;
  const admitted = messages.flatMap((message, index) => message.role === 'user' && !message.history ? [index] : [])
    .slice(0, record.configuration.inputMessages?.length ?? 1);
  invariant(admitted.length === admission.messages.length, 'native_conversation_fork_input_boundary_invalid');
  if (!target) {
    // Before the first input: this also supports an empty/root conversation.
    return copy(messages.slice(0, admitted[0]));
  }
  const inputIndex = admission.messages.findIndex(message => message.id === targetId);
  if (inputIndex >= 0) {
    invariant(target.type === 'user/message', 'native_conversation_fork_message_boundary_invalid');
    return copy(messages.slice(0, admitted[inputIndex] + 1));
  }
  const selected = () => copy(messages.slice(0, cursor));
  const inputBoundaries = new Map(record.intents.filter(intent => intent.kind === 'input'
    && Number.isSafeInteger(intent.payload.messageCursor)).map(intent => [intent.operationKey, intent.payload.messageCursor]));
  let cursor = 0;
  const drain = through => {
    invariant(Number.isSafeInteger(through) && through >= cursor && through <= messages.length,
      'native_conversation_fork_message_boundary_invalid');
    while (cursor < through) {
      const index = cursor++, message = messages[index];
      if (message.history || message.role === 'system' || admitted.includes(index)) continue;
      if (id(`transcript:${index}`) !== targetId) continue;
      invariant(target.type === (message.role === 'tool' ? 'tool/result' : 'user/message')
        && ['tool', 'user'].includes(message.role), 'native_conversation_fork_message_boundary_invalid');
      return true;
    }
    return false;
  };
  for (const event of record.events.filter(event => event.seq <= record.snapshot.eventSeq)) {
    const payload = event.payload;
    if (['plan.initialized', 'plan.mode_changed', 'todo.initialized', 'todo.updated'].includes(event.kind)) {
      if (drain(payload.messageCursor)) return selected();
    } else if (event.kind === 'effect.prepared' && payload.kind === 'input' && inputBoundaries.has(payload.operationKey)) {
      if (drain(inputBoundaries.get(payload.operationKey))) return selected();
    } else if (event.kind === 'output.restarted') {
      const { retained, retired, notice } = retirements.get(event.seq);
      invariant(cursor === retained + retired.length, 'native_conversation_fork_output_restart_invalid');
      messages.splice(retained, retired.length, notice); cursor = retained;
    } else if (['model.completed', 'context.summary_completed', 'completion.delivery_review_completed', 'model.stream_interrupted'].includes(event.kind)) {
      const index = payload.messageIndex;
      const summary = event.kind === 'context.summary_completed' || event.kind === 'completion.delivery_review_completed' && index === null;
      const interrupted = event.kind === 'model.stream_interrupted';
      if (drain(summary || interrupted || index === null ? payload.messageCursor : index)) return selected();
      if (!summary && !interrupted && index !== null) {
        invariant(messages[index]?.role === 'assistant', 'native_conversation_fork_message_boundary_invalid');
        // Delivery publishes accepted candidates/fragments as ordinary model
        // messages. Their old control-state kinds must not suppress that public
        // prose in the fork, or resurrect a rejected private candidate draft.
        messages[index] = { ...messages[index], content: payload.candidateStatus === 'rejected' ? '' : messages[index].content };
        delete messages[index].kind;
      }
      // New display admissions publish an interrupted prefix as a readable
      // message. A cut there contains only its sealed public prose: no partial
      // tool batch, reasoning display, later answer or private replay state.
      if (!summary && (interrupted || index === null)
        && record.configuration.profile.providerThinkingDisplayPolicy === 'provider-visible/v1'
        && targetId === id(`${interrupted ? 'interrupted' : 'response'}:${event.eventId}`)) {
        const display = payload.displayStream?.records ?? [];
        const text = display.filter(member => member.event.kind === 'text').map(member => member.event.text).join('');
        const reasoning = display.some(member => member.event.kind === 'thinking' && member.event.text);
        if (text || reasoning) {
          invariant(target.type === 'assistant/message' && target.data.interrupted === true,
            'native_conversation_fork_message_boundary_invalid');
          return text ? [...selected(), { role: 'assistant', content: text }] : selected();
        }
      }
      if (!interrupted && targetId === id(`response:${event.eventId}`)) {
        invariant(target.type === 'assistant/message', 'native_conversation_fork_message_boundary_invalid');
        if (!summary && index !== null) cursor = index + 1;
        return selected();
      }
      if (!summary && !interrupted && index !== null) cursor = index + 1;
      if (drain(payload.messageCursor)) return selected();
    }
  }
  if (drain(messages.length)) return selected();
  // Terminal fallback answers and uncertain receipts are delivery-only data.
  // Resolve their exact public value, rather than importing a later checkpoint.
  const calls = messages.flatMap(message => message.toolCalls ?? []);
  for (const event of visible.filter(event => event.type === 'tool/result')) {
    const publicMessage = event.data.message;
    const call = calls.find(call => id(`closure:${call.callId}`) === publicMessage.id);
    if (!call) continue;
    invariant(publicMessage.toolCallId === id(`call:${call.callId}`), 'native_conversation_fork_message_boundary_invalid');
    messages.push({ role: 'tool', callId: call.callId, name: call.name, ...nativeDeliveryClosure(record, call.callId).context });
    cursor++;
    if (publicMessage.id === targetId) return selected();
  }
  if (targetId === id('final-delivery')) {
    invariant(target.type === 'assistant/message' && record.snapshot.finalText, 'native_conversation_fork_message_boundary_invalid');
    return [...selected(), { role: 'assistant', content: record.snapshot.finalText }];
  }
  invariant(false, 'native_conversation_fork_message_boundary_unavailable');
}
