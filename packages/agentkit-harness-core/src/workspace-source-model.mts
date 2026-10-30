import type { Json, ObjectValue } from './contracts.mjs';
import { canonical, invariant } from './values.mjs';
import { parseNativeJson } from './model-json.mjs';

export const WORKSPACE_SOURCE_MODEL_VERSION = 'workspace-source-model/v1' as const;
const object = (value: unknown): value is ObjectValue => !!value && typeof value === 'object' && !Array.isArray(value);
const integer = (value: Json | undefined): value is number | bigint => typeof value === 'bigint'
  || typeof value === 'number' && Number.isSafeInteger(value) && !Object.is(value, -0);
const fields = (value: ObjectValue, names: string[]) => Object.keys(value).sort().join(',') === [...names].sort().join(',');
const numeric = (value: Json | undefined) => ['number', 'bigint', 'boolean'].includes(typeof value);
function equal(a: Json | undefined, b: Json | undefined): boolean {
  // Python mapping equality treats bool/numeric values alike where the reference
  // has no explicit integer-type check. This projection grants no read authority.
  if (a == null && b == null) return true;
  if (numeric(a) && numeric(b)) return a == b;
  if (object(a) && object(b)) return fields(a, Object.keys(b)) && Object.keys(a).every(key => equal(a[key], b[key]));
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((value, index) => equal(value, b[index]));
  return a === b;
}
const audit = new Set(['size', 'size_bytes', 'mtime_ns', 'source_output_budget', 'original_chars', 'preview_chars']);

/** Pure reference model projection. Full receipts and source capture stay separate. */
export function workspaceSourceModelReply(input: unknown): string | null {
  try {
    if (!object(input) || input.ok !== true || typeof input.path !== 'string' || !input.path || typeof input.content !== 'string') return null;
    const { start_line: start, total_lines: total, line_count: count, requested_source: carrier } = input;
    const end = input.end_line ?? null, range = input.read_range ?? null;
    if (input.artifact_only === true) {
      if (!object(carrier) || carrier.path !== input.path || typeof carrier.content !== 'string' || !carrier.content
        || !object(carrier.read_range) || !integer(start) || !integer(total) || BigInt(start) < 1n || BigInt(start) > BigInt(total)
        || !integer(count) || BigInt(count) !== 0n || end !== null || range !== null || input.content !== ''
        || input.truncated !== true || input.partial !== true) return null;
      const requested = carrier.read_range;
      if (!fields(requested, ['start', 'end']) || !integer(requested.start) || !integer(requested.end)
        || BigInt(requested.start) !== BigInt(start) || BigInt(requested.end) < BigInt(start) || BigInt(requested.end) > BigInt(total)) return null;
      return canonical({ status: 'ok', content: { ok: true, path: input.path, source_state: 'unread', source_read_range: requested } });
    }
    if (!integer(start) || !integer(total) || !integer(count) || BigInt(start) < 1n || BigInt(total) < 0n || BigInt(count) < 0n) return null;
    if (BigInt(count) > 0n) {
      if (!integer(end) || BigInt(end) !== BigInt(start) + BigInt(count) - 1n || BigInt(end) > BigInt(total)
        || !object(range) || !integer(range.start) || !integer(range.end) || !equal(range, { start, end })) return null;
    } else if (BigInt(total) > 0n) {
      if (BigInt(start) > BigInt(total) || end !== null || range !== null || !equal(input.partial_line, start)
        || input.truncated !== true || !input.content) return null;
    } else if (!equal(end, 0) || input.content || BigInt(start) !== 1n || !equal(range, { start: 1, end: 0 })) return null;
    if (typeof input.partial !== 'boolean' || typeof input.truncated !== 'boolean') return null;
    const captured = Object.hasOwn(input, 'requested_source'), view: ObjectValue = {};
    for (const [key, value] of Object.entries(input)) if (!audit.has(key) && (!captured || !['requested_source', 'persisted'].includes(key)))
      Object.defineProperty(view, key, { value, enumerable: true, writable: true, configurable: true });
    if (captured && !(object(carrier) && carrier.path === input.path && equal(carrier.read_range, range) && carrier.content === input.content))
      view.suggested_action = 'Inspect the complete requested source through the host artifact reference.';
    return canonical({ status: 'ok', content: view });
  } catch { return null; }
}

/** Same framing is used for source-page admission and the actual issued locator. */
export function archivedSourceObservation(modelContent: string, uri: string | null): string {
  const value = parseNativeJson(modelContent);
  invariant(object(value) && value.status === 'ok' && Object.hasOwn(value, 'content'), 'archive_model_view_invalid');
  invariant(!['artifact_uri', 'artifact_state', 'artifact_instruction'].some(key => Object.hasOwn(value, key)), 'archive_model_view_reserved_field');
  invariant(uri === null || uri.startsWith('artifact://') && Array.from(uri).length <= 256, 'archive_model_uri_invalid');
  return canonical({ ...value, artifact_state: uri === null ? 'unavailable' : 'available',
    artifact_instruction: uri === null ? 'The complete observation could not be saved; only this preview was returned.'
      : 'Use ArtifactSearch to query artifact_uri, or ArtifactRead to inspect a page.',
    ...(uri === null ? {} : { artifact_uri: uri }) });
}
