import type { ObjectValue } from './contracts.mjs';
import { copy, invariant, NativeError } from './values.mjs';

/**
 * Host-bound, before-seal artifact-search result selection. Mirrors the
 * reference ArtifactSearchBudget.select result-selection behavior: keep the
 * longest honest original-excerpt prefix that fits, then drop visible matches
 * from the last row backwards, preserving every original URI and coordinate.
 *
 * The input is never mutated; each candidate is a detached copy measured in
 * full via `fits`, which may be async and need not be monotonic. No I/O or
 * hashing happens here — the caller computes the digest and owns the final
 * capacity-unavailable framing when this returns null. Unknown metadata is
 * carried through untouched; only shape failures fail closed.
 */
export async function selectArtifactSearchFeedback(
  input: ObjectValue,
  fits: (content: ObjectValue) => Promise<boolean>
): Promise<ObjectValue | null> {
  const CODE = 'artifact_search_feedback_shape';
  assertPlainObject(input, CODE);
  assertObjectArray(input.results, CODE);
  const originalRows = input.results;
  for (const row of originalRows) {
    if (row.matches !== undefined) assertObjectArray(row.matches, CODE);
  }

  // A detached original is returned unchanged when it already fits.
  const detached = copy(input);
  if (await fits(copy(detached))) return detached;

  // Original excerpts per row, captured from the unmutated input so a later
  // truncation can never feed back into its own prefix measurement.
  const originals: string[][] = originalRows.map(row => {
    const matches = row.matches;
    if (!Array.isArray(matches)) return [];
    return (matches as ObjectValue[]).map(match =>
      typeof match.excerpt === 'string' ? match.excerpt : ''
    );
  });

  let maximum = 0;
  for (const texts of originals) {
    for (const text of texts) {
      const codepoints = [...text];
      if (codepoints.length > maximum) maximum = codepoints.length;
    }
  }

  // floor(max/2), floor(max/4), ... down to 1, then 0 — measured in codepoints.
  const lengths: number[] = [];
  let size = Math.floor(maximum / 2);
  while (size > 0) {
    lengths.push(size);
    size = Math.floor(size / 2);
  }

  const content = copy(input);
  content.capacity_limited = true;
  content.continuation = 'Complete original bytes remain at these earned URIs (ArtifactRead).';
  const contentRows = content.results as ObjectValue[];

  const recomputeComplete = (): void => {
    content.complete = contentRows.every(row => Boolean(row.complete));
  };

  // Keep the longest tested original-excerpt prefix that fits. Each candidate
  // is measured in full; costs need not be monotonic. No excerpt is rebuilt or
  // attributed to a different match — only its own original prefix is used.
  for (const current of [...lengths, 0]) {
    for (let i = 0; i < contentRows.length; i++) {
      const row = contentRows[i]!;
      const matches = row.matches;
      if (!Array.isArray(matches)) continue;
      const matchList = matches as ObjectValue[];
      const texts = originals[i]!;
      for (let j = 0; j < matchList.length; j++) {
        const match = matchList[j]!;
        const text = texts[j] ?? '';
        const codepoints = [...text];
        if (codepoints.length > current) {
          match.excerpt = codepoints.slice(0, current).join('');
          match.excerpt_truncated = true;
          row.complete = false;
        }
      }
    }
    recomputeComplete();
    const candidate = copy(content);
    if (await fits(copy(candidate))) return candidate;
  }

  // Drop only visible matches, retaining each original URI and coordinate
  // system. Empty + complete=false is not a statement that no match exists.
  for (let i = contentRows.length - 1; i >= 0; i--) {
    const row = contentRows[i]!;
    const matches = row.matches;
    if (!Array.isArray(matches)) continue;
    const matchList = matches as ObjectValue[];
    while (matchList.length > 0) {
      matchList.pop();
      row.complete = false;
      recomputeComplete();
      const candidate = copy(content);
      if (await fits(copy(candidate))) return candidate;
    }
  }

  // The metadata envelope (URIs + coordinates, all visible matches gone)
  // never fit; the caller owns the capacity-unavailable framing and digest.
  return null;
}

function assertPlainObject(value: unknown, code: string): asserts value is ObjectValue {
  invariant(value !== null && typeof value === 'object' && !Array.isArray(value), code);
}

function assertObjectArray(value: unknown, code: string): asserts value is ObjectValue[] {
  if (!Array.isArray(value)) throw new NativeError(code);
  for (const item of value) assertPlainObject(item, code);
}
