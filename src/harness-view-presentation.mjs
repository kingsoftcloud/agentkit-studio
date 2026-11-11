import { ENGINE_VIEW_CONTRACT, NATIVE_ENGINE_EVENT } from './providers/native-engine-runtime.mjs';

export const HOSTED_HARNESS_VIEW_PATH = '/_ksadk/harness/v1/views';
export const HOSTED_HARNESS_VIEW_EVENT = 'response.harness_view';

/** Publish display fields only. The engine's raw tool arguments and receipts
 * belong to the runtime Session and are never copied into Hosted UI history. */
export function hostedHarnessView(event) {
  if (event?.type !== NATIVE_ENGINE_EVENT) return null;
  const { view, event: frame } = event.data ?? {};
  if (typeof view !== 'string' || !/^[a-f0-9]{64}$/.test(view)
    || frame?.schema !== 'agentkit.engine-event/v1' || typeof frame.kind !== 'string'
    || !Number.isSafeInteger(frame.seq) || frame.seq <= 0) return null;
  const projected = { schema: frame.schema, seq: frame.seq };
  for (const key of ['kind', 'category', 'title', 'status', 'reason', 'callId']) {
    if (typeof frame[key] === 'string') projected[key] = frame[key].slice(0, 200);
  }
  if (frame.kind === 'model.failure_observed' && typeof frame.detail === 'string') projected.detail = frame.detail.slice(0, 200);
  if (Array.isArray(frame.tools)) projected.tools = frame.tools.slice(0, 32).filter(tool => typeof tool === 'string').map(tool => tool.slice(0, 128));
  if (frame.usage) projected.usage = Object.fromEntries(['inputTokens', 'outputTokens']
    .filter(key => Number.isSafeInteger(frame.usage[key]) && frame.usage[key] >= 0).map(key => [key, frame.usage[key]]));
  return { contract: ENGINE_VIEW_CONTRACT, sha256: view, event: projected };
}
