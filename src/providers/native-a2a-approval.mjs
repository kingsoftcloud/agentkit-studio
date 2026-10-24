/** Public remote approval hints. These are presentation only: approval and
 * continuation authority remain with the original Host interaction ledger. */
import { canonical, invariant } from '../../packages/agentkit-harness-core/dist/index.mjs';
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && canonical(Object.keys(value).sort()) === canonical(keys.sort());
const cut = (value, size) => Array.from(value).slice(0, size).join('');
const length = value => Array.from(value).length;
const secret = /secret|password|passphrase|token|credential|api[_-]?key|access[_-]?key|private[_-]?key|authorization|cookie/iu;
const truncated = '…（预览已截断）';
function fromPresentation(callId, presentation) {
  const title = presentation.title || 'Remote approval', description = presentation.description || 'Approval required';
  let payload; try { payload = JSON.parse(description); } catch { payload = null; }
  const detail = { name: title, args: object(payload?.arguments) ? payload.arguments : { description }, prompt: description };
  if (['low', 'medium', 'high', 'critical'].includes(payload?.risk)) detail.risk = payload.risk;
  return { request_type: 'approval', call_id: callId, kind: 'tool', detail };
}
function presentation(request) {
  let detail = request.detail;
  for (let i = 0; i < 32 && object(detail.child_approval); i++) detail = detail.child_approval;
  let remaining = 12000, nodes = 128, shortened = false;
  function preview(value, depth = 0) {
    if (depth > 6 || --nodes < 0 || remaining <= 0) { shortened = true; return truncated; }
    if (typeof value === 'string') {
      const result = cut(value, Math.min(4096, remaining)); remaining -= length(result);
      if (length(result) < length(value)) { shortened = true; return result + truncated; } return result;
    }
    if (Array.isArray(value)) { if (value.length > 32) shortened = true; return value.slice(0, 32).map(item => preview(item, depth + 1)); }
    if (object(value)) {
      const entries = [];
      for (const [key, item] of Object.entries(value)) {
        if (entries.length >= 32 || nodes <= 0) { shortened = true; break; }
        if (length(key) > 128) shortened = true;
        entries.push([cut(key, 128), secret.test(key) ? '[REDACTED]' : preview(item, depth + 1)]);
      }
      return Object.fromEntries(entries);
    }
    return value;
  }
  const payload = { arguments: preview(detail.args) };
  if (detail.risk) payload.risk = detail.risk;
  if (shortened) payload.previewTruncated = true;
  return { title: cut(detail.name, 128), description: JSON.stringify(payload) };
}
export function parseA2AApproval(metadata, callId) {
  const value = metadata.ksadk_interaction;
  if (value == null) return null;
  const code = 'A2A_INTERACTION_DECLARATION_INVALID', expectedSchema = { type: 'string', enum: ['approve', 'reject'] };
  invariant(exact(value, ['version', 'kind', 'allowed_decisions', 'presentation']) && value.version === 1
    && value.kind === 'approval' && canonical(value.allowed_decisions) === canonical(['approve', 'reject']), code);
  const p = value.presentation;
  invariant(exact(p, ['title', 'description']) && typeof p.title === 'string' && length(p.title) <= 128
    && typeof p.description === 'string' && length(p.description) <= 96000
    && metadata.input_schema && canonical(metadata.input_schema) === canonical(expectedSchema), code);
  return fromPresentation(callId, presentation(fromPresentation(callId, p)));
}
