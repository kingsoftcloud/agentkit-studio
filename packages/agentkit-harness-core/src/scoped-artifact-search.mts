import type { ArtifactRef, ObjectValue, ToolResult } from './contracts.mjs';
import { canonical } from './values.mjs';
import { artifactSearchSource } from './artifact-search-source.mjs';
import { selectArtifactSearchFeedback } from './artifact-search-feedback.mjs';

const bytes = (text: string) => new TextEncoder().encode(text).byteLength;
const chars = (text: string) => Array.from(text);
/** Literal search of already granted immutable documents. Paths are data only. */
export async function scopedArtifactSearch(args: ObjectValue, refs: ArtifactRef[],
  read: (ref: ArtifactRef, offset: number, limit: number) => Promise<{ content: string; nextOffset: number | null }>,
  digest: (text: string) => Promise<string>, fits: (result: ToolResult) => Promise<boolean>, signal: AbortSignal): Promise<ToolResult> {
  const query = args.query as string, margin = Number(args.context_chars ?? 80);
  let remaining = Number(args.max_matches ?? 8), characters = 8192;
  const rows: ObjectValue[] = [], fingerprints: ObjectValue[] = [];
  for (const ref of refs) {
    if (ref.sizeBytes > 1024 * 1024) { rows.push({ uri: ref.uri, complete: false, code: 'artifact_search_too_large' }); continue; }
    let text = '', offset = 0;
    try {
      while (true) {
        signal.throwIfAborted();
        const page = await read(ref, offset, 32000); text += page.content;
        if (bytes(text) > 1024 * 1024) throw Error('artifact_search_too_large');
        if (page.nextOffset === null) break;
        offset = page.nextOffset;
      }
      if (bytes(text) !== ref.sizeBytes || await digest(text) !== ref.digest) throw Error('artifact_search_content_mismatch');
    } catch { signal.throwIfAborted(); rows.push({ uri: ref.uri, complete: false, code: 'artifact_search_failed' }); continue; }
    const source = artifactSearchSource(text, ref.mediaType), body = source.body, all = chars(body), queryLength = chars(query).length;
    const matches: ObjectValue[] = [];
    let cursor = 0;
    while (remaining && characters) {
      const found = body.indexOf(query, cursor); if (found < 0) break;
      const start = chars(body.slice(0, found)).length;
      const full = all.slice(Math.max(0, start - margin), start + queryLength + margin);
      const excerpt = full.slice(0, characters).join(''), clipped = full.length > characters;
      matches.push({ offset_chars: start, excerpt, excerpt_truncated: clipped,
        ...(source.start === undefined ? {} : { source_line: BigInt(source.start) + BigInt(body.slice(0, found).split('\n').length - 1) }) });
      remaining--; characters -= chars(excerpt).length; cursor = found + query.length;
    }
    const complete = body.indexOf(query, cursor) < 0 && !matches.some(match => match.excerpt_truncated);
    rows.push({ uri: ref.uri, matches, complete, coordinate_space: source.path ? 'captured_source' : 'artifact',
      ...(source.path ? { source_path: source.path } : {}) });
    fingerprints.push({ digest: ref.digest, query, matches, complete });
  }
  const content: ObjectValue = { observation_type: 'scoped-artifact-search/v1', query, results: rows,
    complete: rows.every(row => row.complete === true) };
  const selected = await selectArtifactSearchFeedback(content, value => fits({ status: 'ok', content: value }));
  if (!selected) return { status: 'error', content: { code: 'artifact_search_capacity_unavailable' } };
  return { status: 'ok', content: selected, ...(fingerprints.length ? { metadata: {
    progressObservationDigest: await digest(canonical(selected.capacity_limited ? selected : fingerprints)),
  } } : {}) };
}
