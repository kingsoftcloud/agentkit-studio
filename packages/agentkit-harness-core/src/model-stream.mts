import type { ModelStreamEvent, ModelStreamRecord } from './contracts.mjs';
import { canonical, copy } from './values.mjs';

/** A bounded, public display prefix. It never supplies execution or replay authority. */
export function modelStreamCapture(maxBytes: number, now: () => number,
  publish: (event: ModelStreamEvent, record: ModelStreamRecord) => void) {
  const records: ModelStreamRecord[] = [];
  let bytes = 2, truncated = false, discarded = 0, closed = false;
  return {
    emit(value: ModelStreamEvent) {
      if (closed || truncated) return;
      if (!value || !['text', 'thinking', 'tool_delta'].includes(value.kind) || typeof value.text !== 'string') {
        discarded++; return;
      }
      if (!value.text) return;
      const event: ModelStreamEvent = { kind: value.kind, text: value.text };
      if (event.kind === 'tool_delta') {
        const index = value.metadata?.index;
        if (!Number.isSafeInteger(index) || Number(index) < 0) { discarded++; return; }
        // Provider signatures, private replay state and arbitrary metadata must
        // never reach Session streams, even when a port includes them.
        event.metadata = { index: Number(index),
          ...(typeof value.metadata?.callId === 'string' ? { callId: value.metadata.callId } : {}),
          ...(typeof value.metadata?.name === 'string' ? { name: value.metadata.name } : {}) };
      }
      const clock = now();
      const time = Math.max(records.at(-1)?.time ?? 0, Number.isSafeInteger(clock) && clock >= 0 ? clock : 0);
      const record = { time, event };
      const size = new TextEncoder().encode(canonical(record)).length + (records.length ? 1 : 0);
      if (bytes + size > maxBytes) { truncated = true; return; }
      bytes += size; records.push(record);
      // Display observers cannot veto or mutate the model result or receipt.
      try { publish(copy(event), copy(record)); } catch { /* non-authoritative observer */ }
    },
    close() { closed = true; return { version: 'agentkit.model-display/v1', records: copy(records), truncated, discarded }; },
  };
}
