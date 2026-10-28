/** Derive canonical Kernel facts from committed Native events, never live
 * model callbacks. Projection receipts/cursors are committed by the owner. */
import { createHash } from 'node:crypto';
import { canonical } from '@kingsoftcloud/agentkit-harness-core';
import { nativePublicTerminalError } from './native-terminal-failure.mjs';

export function nativeKernelFactId(source, index) {
  const hex = createHash('sha256').update(canonical([source, index])).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function projectNativeKernelEvent(event, { scopeId, commandId } = {}) {
  const runId = event.runId, payload = event.payload, facts = [];
  const runtime = value => facts.push({ family: 'runtime', family_version: 2, event_type: value.event_type,
    payload: { schema_version: 2, run_id: runId, scope_id: scopeId, ...value } });
  const transition = state => facts.push({ family: 'control', family_version: 1, event_type: 'control.run_transition',
    causation_id: commandId, payload: { run_id: runId, state } });
  const textItem = (id, text) => {
    runtime({ event_type: 'item.updated', item_id: id, item_kind: 'message', op: 'replace',
      update: { content_type: 'text', part_id: 'text', text } });
    runtime({ event_type: 'item.completed', item_id: id, item_kind: 'message',
      snapshot: { parts: [{ content_type: 'text', part_id: 'text', text }] } });
  };
  if (event.kind === 'run.started') {
    transition('running'); runtime({ event_type: 'run.started', status: 'running' });
  } else if (event.kind === 'model.completed') {
    if (payload.candidateStatus !== 'rejected' && payload.text) textItem(event.eventId, payload.text);
    if (payload.usageReported !== false && payload.usage) runtime({ event_type: 'usage.reported',
      input_tokens: payload.usage.inputTokens, output_tokens: payload.usage.outputTokens,
      total_tokens: payload.usage.inputTokens + payload.usage.outputTokens,
      cached_tokens: payload.usage.cachedInputTokens ?? 0, reasoning_tokens: payload.usage.reasoningTokens ?? 0 });
    // Appended after the message/usage facts so existing event_ids stay unchanged.
    if (payload.candidateStatus !== 'rejected' && Array.isArray(payload.toolCalls)) {
      for (const call of payload.toolCalls) {
        if (!call?.callId || !call?.name) continue;
        runtime({ event_type: 'item.completed', item_id: `call-${call.callId}`, item_kind: 'tool_call',
          snapshot: { parts: [{ content_type: 'tool_call', part_id: 'call', call_id: call.callId,
            name: call.name, arguments: call.arguments ?? {} }] } });
      }
    }
    // displayStream thinking records are a committed capture, not a live token callback.
    const thinkingText = (payload.displayStream?.records ?? [])
      .filter(record => record.event?.kind === 'thinking' && record.event?.text)
      .map(record => record.event.text);
    if (thinkingText.length) runtime({ event_type: 'item.completed', item_id: `reasoning-${event.eventId}`,
      item_kind: 'reasoning',
      snapshot: { parts: [{ content_type: 'text', part_id: 'thinking', text: thinkingText.join('') }] } });
  } else if (event.kind === 'tool.completed') {
    if (payload.status === 'uncertain') {
      runtime({ event_type: 'item.failed', item_id: `result-${payload.callId}`, item_kind: 'tool_result',
        error: { code: 'NATIVE_TOOL_OUTCOME_UNKNOWN', source: 'agentkit-native', scope_id: scopeId } });
    } else {
      runtime({ event_type: 'item.completed', item_id: `result-${payload.callId}`, item_kind: 'tool_result',
        snapshot: { parts: [{ content_type: 'tool_result', part_id: 'result', call_id: payload.callId,
          result: Object.hasOwn(payload, 'content') ? payload.content : {}, is_error: payload.status === 'error' }] } });
    }
  } else if (event.kind === 'tool.rejected') {
    runtime({ event_type: 'item.failed', item_id: `result-${payload.callId}`, item_kind: 'tool_result',
      error: { code: 'NATIVE_TOOL_REJECTED', message: payload.reason ?? null, source: 'agentkit-native', scope_id: scopeId } });
  } else if (event.kind === 'tool.not_dispatched') {
    runtime({ event_type: 'item.failed', item_id: `result-${payload.callId}`, item_kind: 'tool_result',
      error: { code: 'NATIVE_TOOL_NOT_DISPATCHED', message: payload.reason ?? null, source: 'agentkit-native', scope_id: scopeId } });
  } else if (event.kind === 'approval.requested') {
    facts.push({ family: 'interaction', family_version: 1, event_type: 'interaction.requested', payload: {
      interaction_id: payload.interactionId, revision: 1, kind: 'approval', request: {
        presentation: { title: 'Tool approval', description: `Allow ${payload.name}?` },
      },
    } });
    transition('waiting');
  } else if (event.kind === 'approval.resolved') {
    facts.push({ family: 'interaction', family_version: 1, event_type: 'interaction.resolved', payload: {
      interaction_id: payload.interactionId, revision: 2,
    } }); transition('running');
  } else if (event.kind === 'command.applied') {
    if (payload.reason && !['applied', 'already_paused', 'not_paused'].includes(payload.reason)) {
      facts.push({ family: 'control', family_version: 1, event_type: 'control.command_rejected',
        causation_id: payload.commandId, payload: { command_id: payload.commandId, reason: payload.reason } });
    }
    // causation is the control command, not the original enqueue.
    if (payload.reason === 'applied' && payload.kind === 'pause') {
      facts.push({ family: 'control', family_version: 1, event_type: 'control.run_transition',
        causation_id: payload.commandId, payload: { run_id: runId, state: 'paused' } });
    } else if (payload.reason === 'applied' && payload.kind === 'resume') {
      facts.push({ family: 'control', family_version: 1, event_type: 'control.run_transition',
        causation_id: payload.commandId, payload: { run_id: runId, state: 'running' } });
    }
  } else if (event.kind === 'run.terminal') {
    const state = payload.phase === 'canceled' ? 'cancelled' : payload.phase;
    const output = [];
    if (state === 'completed' && payload.finalText) {
      // The final candidate may differ from an earlier draft after verification.
      const itemId = `final-${runId}`; textItem(itemId, payload.finalText);
      output.push({ scope_id: scopeId, item_id: itemId, part_id: 'text' });
    }
    runtime(state === 'completed' ? { event_type: 'run.completed', status: 'completed', output_refs: output }
      : state === 'cancelled' ? { event_type: 'run.canceled', status: 'canceled', reason: 'Execution canceled' }
      : state === 'interrupted' ? { event_type: 'run.interrupted', status: 'interrupted', reason: payload.reason ?? null }
        : { event_type: 'run.failed', status: 'failed', error: {
          ...nativePublicTerminalError('failed', payload.reason), source: 'agentkit-native', scope_id: scopeId } });
    transition(state);
  }
  return facts.map((fact, index) => ({ ...fact, event_id: nativeKernelFactId(event.eventId, index), run_id: runId }));
}
