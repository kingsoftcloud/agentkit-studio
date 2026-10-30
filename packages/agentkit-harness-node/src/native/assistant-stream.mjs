import { createHash } from 'node:crypto';
import { invariant } from '@kingsoftcloud/agentkit-harness-core';
import { finalResultDisplay } from './result-stream.mjs';

// Display block identities are local to an attempt. They never authorize a
// Native tool call, whose canonical identity arrives in the committed message.
export function nativeStreamProjector(operationKey, configuration) {
  const blocks = new Map();
  const display = finalResultDisplay(configuration);
  const project = record => {
    const { event, time } = record;
    const key = event.kind === 'tool_delta' ? `tool:${event.metadata.index}` : event.kind;
    const output = [];
    if (!blocks.has(key)) {
      const index = blocks.size;
      blocks.set(key, { index, id: `native-preview-${createHash('sha256').update(`${operationKey}:${key}`).digest('hex')}` });
      output.push({ type: 'chunk', time, chunk: { type: 'block-start', index,
        blockType: event.kind === 'text' ? 'text' : event.kind === 'thinking' ? 'reasoning' : 'tool-call' } });
    }
    const { index, id } = blocks.get(key);
    const chunk = event.kind === 'tool_delta'
      ? { type: 'tool-call-delta', index, id, argumentsDelta: event.text,
        ...(event.metadata.name ? { name: event.metadata.name } : {}) }
      : { type: event.kind === 'text' ? 'text-delta' : 'reasoning-delta', index, text: event.text };
    output.push({ type: 'chunk', time, chunk });
    return output;
  };
  return record => display(record).flatMap(project);
}

export function nativeDurableStream(operationKey, display, configuration) {
  if (display === undefined) return [];
  invariant(display.version === 'agentkit.model-display/v1' && Array.isArray(display.records)
    && typeof operationKey === 'string', 'native_display_stream_invalid');
  return display.records.flatMap(nativeStreamProjector(operationKey, configuration));
}

/** Public DSH frames; publication failures cannot change execution authority. */
export function nativeLiveStream({ agent, runId, turn, publish, beginStep, revisions, configuration }) {
  const attempts = new Map();
  // DSH continuity revisions count every frame in the Agent lifecycle, not
  // model attempts. Reusing a start revision for its chunks makes the real
  // Session follower discard the active stream as a continuity violation.
  const emit = frame => {
    const revision = (revisions.get(agent) ?? 0) + 1;
    revisions.set(agent, revision);
    try { publish?.(structuredClone({ ...frame, revision })); } catch { /* display observer */ }
  };
  return {
    pending(operationKey) { return attempts.has(operationKey); },
    accept(context, record) {
      if (!publish) return;
      let attempt = attempts.get(context.operationKey);
      if (!attempt) {
        attempt = { attemptId: `${runId}:${context.operationKey}`, index: 0,
          project: nativeStreamProjector(context.operationKey, configuration) };
        attempts.set(context.operationKey, attempt);
        emit({ type: 'start', attemptId: attempt.attemptId, turn, step: beginStep() });
      }
      for (const { time, chunk } of attempt.project(record)) emit({ type: 'chunk', attemptId: attempt.attemptId,
        index: attempt.index++, time, chunk });
    },
    settled(operationKey, eventType, seq) {
      const attempt = attempts.get(operationKey);
      if (!attempt) return;
      attempts.delete(operationKey);
      emit({ type: 'end', attemptId: attempt.attemptId, index: attempt.index,
        outcome: { kind: 'committed', eventType, seq } });
    },
    abandon() {
      for (const attempt of attempts.values()) emit({ type: 'end', attemptId: attempt.attemptId,
        index: attempt.index, outcome: { kind: 'abandoned' } });
      attempts.clear();
    },
  };
}
