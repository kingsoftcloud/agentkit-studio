import type { Json, ObjectValue } from './contracts.mjs';
import { canonical } from './values.mjs';
import { parseNativeJson } from './model-json.mjs';

export const CAPTURED_SOURCE_MEDIA_TYPE = 'application/vnd.ksadk.captured-source+json';
export const CAPTURED_SOURCE_VERSION = 'captured-source-artifact/v1';
export interface CapturedSource {
  version: typeof CAPTURED_SOURCE_VERSION; content: string; path: string;
  read_range: { start: number | bigint; end: number | bigint };
}
const object = (value: unknown): value is ObjectValue => !!value && typeof value === 'object' && !Array.isArray(value);
const keys = (value: ObjectValue, expected: string[]) => Object.keys(value).sort().join(',') === expected.sort().join(',');
const integer = (value: Json | undefined): value is number | bigint => typeof value === 'bigint'
  || typeof value === 'number' && Number.isSafeInteger(value) && !Object.is(value, -0);
/** Python splitlines boundaries, including a final boundary without an extra empty line. */
export function sourceLineCount(text: string): number {
  if (!text) return 0;
  const parts = text.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/);
  return parts.length - (parts.at(-1) === '' ? 1 : 0);
}
function capture(value: unknown): CapturedSource | null {
  if (!object(value) || value.ok !== true || !object(value.requested_source)) return null;
  const carrier = value.requested_source, span = carrier.read_range;
  if (!keys(carrier, ['path', 'content', 'read_range']) || typeof carrier.path !== 'string' || !carrier.path
    || value.path !== carrier.path || typeof carrier.content !== 'string' || !carrier.content
    || !object(span) || !keys(span, ['start', 'end']) || !integer(span.start) || !integer(span.end)
    || BigInt(span.start) < 1n || BigInt(span.end) < BigInt(span.start)
    || BigInt(sourceLineCount(carrier.content)) !== BigInt(span.end) - BigInt(span.start) + 1n) return null;
  return { version: CAPTURED_SOURCE_VERSION, content: carrier.content, path: carrier.path,
    read_range: { start: span.start, end: span.end } };
}
/** Pure framing only. A valid document does not grant a reference or source freshness. */
export function encodeCapturedSource(content: unknown): string | null {
  const source = capture(content); return source ? canonical(source) : null;
}
export function decodeCapturedSource(payload: unknown): CapturedSource | null {
  if (typeof payload !== 'string') return null;
  try {
    const value = parseNativeJson(payload);
    if (!object(value) || !keys(value, ['version', 'content', 'path', 'read_range'])
      || value.version !== CAPTURED_SOURCE_VERSION) return null;
    // After strict parsing and shape validation, range coordinates are the only
    // numeric tokens. Preserve Python's integer-token requirement (31.0 is float).
    const syntax = payload.replace(/"(?:[^"\\]|\\.)*"/g, '""');
    const numbers = syntax.match(/-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/g) ?? [];
    if (numbers.length !== 2 || numbers.some(token => /[.eE]/.test(token))) return null;
    return capture({ ok: true, path: value.path, requested_source: {
      path: value.path, content: value.content, read_range: value.read_range,
    } });
  } catch { return null; }
}
