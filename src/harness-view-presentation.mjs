import { ENGINE_VIEW_CONTRACT, NATIVE_ENGINE_EVENT } from './providers/native-engine-runtime.mjs';
import { redactDiagnosticText } from './diagnostic-text.mjs';

export const HOSTED_HARNESS_VIEW_PATH = '/_ksadk/harness/v1/views';
export const HOSTED_HARNESS_VIEW_EVENT = 'response.harness_view';

const FILE_TOOLS = new Set(['read_workspace_file', 'write_workspace_file', 'edit_workspace_file']);
const EDIT_TOOLS = new Set(['write_workspace_file', 'edit_workspace_file']);

function displayPath(value) {
  if (typeof value !== 'string' || value.length > 1024 || /[\\:\u0000-\u001f\u007f]/u.test(value)) return;
  const path = value.trim().replace(/^\.\//u, '');
  if (path.split('/').some(part => !part || part === '.' || part === '..')) return;
  return redactDiagnosticText(path, 1024);
}

/** Publish display fields only. Tool contents, full arguments and raw receipts
 * belong to the runtime Session and stay out of Hosted UI history. */
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
  if (frame.kind === 'effect.prepared' && frame.category === 'model' && frame.retry === true) projected.retry = true;
  if (frame.kind === 'effect.prepared' && frame.category === 'model' && frame.purpose === 'compaction') projected.purpose = 'compaction';
  if (['run.terminal', 'model.retry_exhausted'].includes(frame.kind) && typeof frame.modelError === 'string')
    projected.modelError = redactDiagnosticText(frame.modelError, 200);
  if (Array.isArray(frame.tools)) projected.tools = frame.tools.slice(0, 32).filter(tool => typeof tool === 'string').map(tool => tool.slice(0, 128));
  if (frame.kind === 'model.completed' && Array.isArray(frame.calls)) {
    projected.calls = frame.calls.slice(0, 32).flatMap(call => {
      if (typeof call?.callId !== 'string' || !call.callId.trim() || typeof call.name !== 'string' || !call.name.trim()) return [];
      const path = FILE_TOOLS.has(call.name) ? displayPath(call.arguments?.path) : undefined;
      return [{ callId: call.callId.slice(0, 200), name: call.name.slice(0, 128), ...(path ? { arguments: { path } } : {}) }];
    });
  }
  if (frame.kind === 'tool.completed' && frame.status === 'ok' && EDIT_TOOLS.has(frame.title)) {
    const { ok, path: rawPath, diff_additions, diff_deletions } = frame.result ?? {};
    const path = displayPath(rawPath);
    if (ok === true && path && [diff_additions, diff_deletions].every(count => Number.isSafeInteger(count) && count >= 0)) {
      projected.result = { ok, path, diff_additions, diff_deletions };
    }
  }
  if (frame.usage) projected.usage = Object.fromEntries(['inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'reasoningTokens']
    .filter(key => Number.isSafeInteger(frame.usage[key]) && frame.usage[key] >= 0).map(key => [key, frame.usage[key]]));
  return { contract: ENGINE_VIEW_CONTRACT, sha256: view, event: projected };
}
