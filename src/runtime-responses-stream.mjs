/** Project public DSH attempt frames; never turn a discarded attempt into success. */
import { runtimeResponse } from './runtime-responses-contract.mjs';
import { CODEX_TOOL_EVENT } from './providers/codex-tool-events.mjs';
import { RESOURCE_CHECK_EVENT, sanitizeResourceCheck } from './resource-checks.mjs';

export function createRuntimeResponsesStream(request, write) {
  const items = [], blocks = new Map(), calls = new Map(), delivery = [];
  let sequence = 0;
  const emit = (type, data) => {
    if (!['response.created', 'response.in_progress', 'response.completed', 'response.failed', 'response.canceled'].includes(type)) {
      delivery.push({ type, data: structuredClone(data) });
    }
    write(type, { ...data, type, sequence_number: sequence++ });
  };
  const lifecycle = (type, response) => emit(type, { ...response, response });
  const item = (key, kind) => {
    if (blocks.has(key)) return blocks.get(key);
    const index = items.length, id = `${kind === 'reasoning' ? 'rs' : 'msg'}_${request.runId.slice(4)}_${index}`;
    const value = { id, type: kind, status: 'in_progress', ...(kind === 'message' ? { role: 'assistant', content: [{ type: 'output_text', text: '', annotations: [] }] } : { summary: [{ type: 'summary_text', text: '' }] }) };
    const record = { index, item: value, key, closed: false };
    items.push(record); blocks.set(key, record);
    emit('response.output_item.added', { output_index: index, item: value });
    if (kind === 'message') emit('response.content_part.added', { output_index: index, item_id: id, content_index: 0, part: value.content[0] });
    return record;
  };
  const close = (record, status) => {
    if (record.closed) return;
    record.closed = true; record.item.status = status;
    if (record.item.type === 'message') {
      emit('response.output_text.done', { output_index: record.index, item_id: record.item.id, content_index: 0, text: record.item.content[0].text });
      emit('response.content_part.done', { output_index: record.index, item_id: record.item.id, content_index: 0, part: record.item.content[0] });
    } else if (record.item.type === 'reasoning') {
      emit('response.reasoning_summary_text.done', { output_index: record.index, item_id: record.item.id, summary_index: 0, text: record.item.summary[0].text });
    }
    emit('response.output_item.done', { output_index: record.index, item: record.item });
  };
  const projector = {
    start() { lifecycle('response.created', runtimeResponse(request)); lifecycle('response.in_progress', runtimeResponse(request)); },
    frame(frame) {
      const value = frame.value;
      if (frame.kind === 'assistant' && value.type === 'chunk') {
        const chunk = value.chunk;
        if (!['text-delta', 'reasoning-delta'].includes(chunk.type)) return;
        const reasoning = chunk.type === 'reasoning-delta';
        const record = item(`${value.attemptId}:${chunk.index}`, reasoning ? 'reasoning' : 'message');
        if (record.closed) return;
        (reasoning ? record.item.summary[0] : record.item.content[0]).text += chunk.text;
        emit(reasoning ? 'response.reasoning_summary_text.delta' : 'response.output_text.delta', {
          output_index: record.index, item_id: record.item.id, ...(reasoning ? { summary_index: 0 } : { content_index: 0 }), delta: chunk.text,
        });
      } else if (frame.kind === 'assistant' && value.type === 'end') {
        const status = value.outcome?.kind === 'committed' && value.outcome.eventType === 'assistant/message' ? 'completed' : 'incomplete';
        for (const record of items) if (record.key?.startsWith(`${value.attemptId}:`)) close(record, status);
      } else if (frame.kind === 'event' && value.type === RESOURCE_CHECK_EVENT) {
        const check = sanitizeResourceCheck(value.data);
        if (check) emit('response.resource_check', { check });
      } else if (frame.kind === 'event' && value.type === CODEX_TOOL_EVENT) {
        const call = value.data;
        // Codex has already executed these tools. Project its presentation
        // facts only; never append model-facing calls for DSH to execute again.
        if (!calls.has(call.callId)) projector.frame({ kind: 'event', value: { type: 'tool/call', data: call } });
        if (call.phase !== 'started') projector.frame({ kind: 'event', value: { type: 'tool/result', data: {
          message: { source: { callId: call.callId }, content: call.content || [], isError: call.phase === 'failed' },
        } } });
      } else if (frame.kind === 'event' && value.type === 'tool/call') {
        const call = value.data;
        if (calls.has(call.callId)) return;
        const index = items.length;
        const record = { index, closed: false, item: { id: `fc_${request.runId.slice(4)}_${index}`, type: 'function_call', status: 'in_progress', call_id: call.callId, name: call.name, arguments: call.arguments } };
        items.push(record); calls.set(call.callId, record);
        emit('response.output_item.added', { output_index: index, item: record.item });
        emit('response.function_call_arguments.done', { output_index: index, item_id: record.item.id, arguments: call.arguments });
      } else if (frame.kind === 'event' && value.type === 'tool/result') {
        const message = value.data.message, record = calls.get(message?.source?.callId);
        if (!record) return;
        close(record, message.isError ? 'incomplete' : 'completed');
        // Tool output is a Studio extension, separate from the assistant text.
        emit('response.tool_result', { call_id: record.item.call_id, output: message.content, is_error: message.isError === true });
      }
    },
    prepare(result) {
      // Replayed idempotent runs have durable output but no new live frames.
      const lastMessage = items.findLast(record => record.item.type === 'message' && record.item.status === 'completed');
      const lastAttempt = lastMessage?.key.slice(0, lastMessage.key.lastIndexOf(':'));
      const lastText = items.filter(record => record.item.type === 'message' && record.item.status === 'completed' && record.key.slice(0, record.key.lastIndexOf(':')) === lastAttempt).map(record => record.item.content[0].text).join('');
      if (!lastMessage || lastText !== result.output) {
        const record = item('final', 'message');
        record.item.content[0].text = String(result.output || '');
        emit('response.output_text.delta', { output_index: record.index, item_id: record.item.id, content_index: 0, delta: record.item.content[0].text });
        close(record, 'completed');
      }
      for (const record of items) if (!record.closed) close(record, 'incomplete');
      const response = runtimeResponse(request, result, 'completed', items.filter(record => record.item.status === 'completed').map(record => record.item));
      return response;
    },
    publish(response) { lifecycle('response.completed', response); return response; },
    complete(result) { return projector.publish(projector.prepare(result)); },
    snapshot() { return structuredClone(delivery); },
    replay(response, events) {
      // A new HTTP delivery reuses the original public item IDs and response.
      // It never routes these presentation facts back into tool execution.
      for (const event of events) emit(event.type, structuredClone(event.data));
      return projector.publish(response);
    },
    fail(code) {
      for (const record of items) if (!record.closed) close(record, 'incomplete');
      const cancelled = code === 'RUNTIME_CANCELLED' || code === 'RUNTIME_CLIENT_DISCONNECTED';
      lifecycle(cancelled ? 'response.canceled' : 'response.failed', runtimeResponse(request, { error: { code } }, cancelled ? 'cancelled' : 'failed', []));
    },
  };
  return projector;
}
