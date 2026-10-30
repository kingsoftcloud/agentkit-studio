import type { Json, ObjectValue } from './contracts.mjs';
import { CAPTURED_SOURCE_MEDIA_TYPE, decodeCapturedSource, encodeCapturedSource } from './captured-source.mjs';
import { parseNativeJson } from './model-json.mjs';

const object = (value: Json | undefined): value is ObjectValue => !!value && typeof value === 'object' && !Array.isArray(value);
export interface ArtifactSearchSource { body: string; path?: string; start?: number | bigint }

function integerRangeTokens(text: string, wrapped: boolean): boolean {
  const fields = new WeakMap<object, Set<string>>();
  // Native JSON preserves large integer values. The reviver source additionally
  // distinguishes Python's integer tokens from 31.0/31e0, without rejecting floats
  // in unrelated legacy diagnostics. No rounded JSON.parse value is used as data.
  const tree = JSON.parse(text, function (this: ObjectValue, key: string, value: Json, context?: { source?: string }): Json {
    if ((key === 'start' || key === 'end') && typeof value === 'number'
      && typeof context?.source === 'string' && /^-?(?:0|[1-9][0-9]*)$/.test(context.source)) {
      const keys = fields.get(this) ?? new Set<string>(); keys.add(key); fields.set(this, keys);
    }
    return value;
  }) as ObjectValue;
  const observation = wrapped ? tree.content : tree;
  const carrier = object(observation) ? observation.requested_source : undefined;
  const range = object(carrier) ? carrier.read_range : undefined;
  return object(range) && fields.get(range)?.size === 2;
}

/** Decode only the stored document; paths here remain data and never cause a workspace read. */
export function artifactSearchSource(text: string, mediaType: string): ArtifactSearchSource {
  if (mediaType === CAPTURED_SOURCE_MEDIA_TYPE) {
    const source = decodeCapturedSource(text);
    return source ? { body: source.content, path: source.path, start: source.read_range.start } : { body: text };
  }
  try {
    const document = parseNativeJson(text);
    if (!object(document) || !object(document.content)) return { body: text };
    let observation = document.content, observationText = text, wrapped = true;
    // Our authorized-view archive stores the exact post-policy JSON as model_content.
    // Do not inspect any private receipt or resolve source_path against the filesystem.
    if (typeof observation.model_content === 'string') {
      const projected = parseNativeJson(observation.model_content);
      if (!object(projected)) return { body: text };
      observation = projected;
      observationText = document.content.model_content as string; wrapped = false;
    }
    const carrier = observation.requested_source;
    if (!object(carrier) || !integerRangeTokens(observationText, wrapped)) return { body: text };
    // The reference accepts extra legacy carrier metadata, but range identity and
    // the actual source line count must still pass the captured-source codec.
    const encoded = encodeCapturedSource({ ok: observation.ok, path: observation.path, requested_source: {
      path: carrier.path, content: carrier.content, read_range: carrier.read_range,
    } });
    const source = encoded === null ? null : decodeCapturedSource(encoded);
    return source ? { body: source.content, path: source.path, start: source.read_range.start } : { body: text };
  } catch { return { body: text }; }
}
