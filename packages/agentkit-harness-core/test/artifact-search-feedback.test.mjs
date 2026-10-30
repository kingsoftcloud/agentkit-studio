import test from 'node:test';
import assert from 'node:assert/strict';
import { selectArtifactSearchFeedback } from '../dist/artifact-search-feedback.mjs';
import { canonical } from '../dist/values.mjs';

const CONTINUATION = 'Complete original bytes remain at these earned URIs (ArtifactRead).';

test('returns a detached copy of the original when it already fits', async () => {
  const input = {
    observation_type: 'scoped-artifact-search/v1',
    query: 'needle',
    results: [
      { uri: 'file:///a', matches: [{ offset_chars: 0, excerpt: 'hit', excerpt_truncated: false, source_line: 1 }],
        complete: true, coordinate_space: 'bytes', source_path: '/a' }
    ],
    complete: true
  };
  const before = canonical(input);
  let calls = 0;
  const out = await selectArtifactSearchFeedback(input, async () => { calls++; return true; });
  assert.equal(calls, 1);
  assert.deepEqual(out, input);            // structurally identical
  assert.notEqual(out, input);             // detached: not the same reference
  assert.notEqual(out.results, input.results);
  assert.equal(canonical(input), before); // input unmutated
});

test('truncates excerpts by Unicode codepoint (emoji) and never mutates input', async () => {
  const emoji = '😀😀😀'; // 3 codepoints, 6 UTF-16 code units
  const input = {
    observation_type: 'scoped-artifact-search/v1', query: 'q',
    results: [{ uri: 'file:///e', matches: [{ offset_chars: 0, excerpt: emoji, excerpt_truncated: false }],
      complete: true, coordinate_space: 'bytes' }],
    complete: true
  };
  const before = canonical(input);
  // fits only when the total visible excerpt is at most one codepoint
  const out = await selectArtifactSearchFeedback(input, async content => {
    const total = content.results.reduce((sum, row) =>
      sum + (Array.isArray(row.matches) ? row.matches.reduce((s, m) => s + [...m.excerpt].length, 0) : 0), 0);
    return total <= 1;
  });
  assert.equal(canonical(input), before);  // input unmutated
  assert.equal(out.capacity_limited, true);
  assert.equal(out.continuation, CONTINUATION);
  assert.equal(out.complete, false);
  assert.equal(out.results[0].complete, false);
  const match = out.results[0].matches[0];
  assert.equal(match.excerpt, '😀');                  // one codepoint, not a broken surrogate
  assert.equal([...match.excerpt].length, 1);
  assert.equal(match.excerpt_truncated, true);
  assert.equal(match.offset_chars, 0);               // coordinate metadata preserved
  assert.equal(input.results[0].matches[0].excerpt, emoji); // original intact
});

test('preserves failed rows and removes visible matches from the last row backwards', async () => {
  const input = {
    observation_type: 'scoped-artifact-search/v1', query: 'q',
    results: [
      { uri: 'file:///a', matches: [{ offset_chars: 0, excerpt: '', excerpt_truncated: false },
        { offset_chars: 5, excerpt: '', excerpt_truncated: false }], complete: true, coordinate_space: 'bytes' },
      { uri: 'file:///b', matches: [{ offset_chars: 0, excerpt: '', excerpt_truncated: false }],
        complete: true, coordinate_space: 'bytes' },
      { uri: 'file:///c', complete: false, code: 'not_found' }
    ],
    complete: false
  };
  const before = canonical(input);
  // fits only when at most one visible match remains in total
  const out = await selectArtifactSearchFeedback(input, async content =>
    content.results.reduce((sum, row) => sum + (Array.isArray(row.matches) ? row.matches.length : 0), 0) <= 1);
  assert.equal(canonical(input), before);
  assert.ok(out);
  assert.equal(out.capacity_limited, true);
  // failed row preserved untouched, never given matches
  assert.equal(out.results[2].uri, 'file:///c');
  assert.equal(out.results[2].code, 'not_found');
  assert.equal(out.results[2].complete, false);
  assert.equal('matches' in out.results[2], false);
  // last match row (row1) is emptied first
  assert.deepEqual(out.results[1].matches, []);
  assert.equal(out.results[1].complete, false);
  assert.equal(out.results[1].uri, 'file:///b');
  // then the last match of row0 is removed, leaving its first match retained
  assert.equal(out.results[0].matches.length, 1);
  assert.equal(out.results[0].matches[0].offset_chars, 0);
  assert.equal(out.results[0].matches[0].excerpt, '');
  assert.equal(out.results[0].complete, false);
});

test('measures each candidate independently and keeps the largest fitting prefix', async () => {
  const excerpt = '0123456789'; // 10 codepoints
  const input = {
    observation_type: 'scoped-artifact-search/v1', query: 'q',
    results: [{ uri: 'file:///a', matches: [{ offset_chars: 0, excerpt, excerpt_truncated: false }],
      complete: true, coordinate_space: 'bytes', source_path: '/a', custom_row: 99 }],
    complete: true, custom_envelope: 'top'
  };
  const before = canonical(input);
  const seen = [];
  // Nonmonotonic budget: only the length-2 prefix fits; lengths 5 and 1 do not.
  const out = await selectArtifactSearchFeedback(input, async content => {
    const len = [...content.results[0].matches[0].excerpt].length;
    seen.push(len);
    return len === 2;
  });
  assert.equal(canonical(input), before);              // input unmutated
  assert.equal([...out.results[0].matches[0].excerpt].length, 2);
  // original (10), floor(10/2)=5, floor(10/4)=2 — stop at first fit
  assert.deepEqual(seen, [10, 5, 2]);
  // coordinate + unknown metadata preserved on the truncated output
  assert.equal(out.results[0].coordinate_space, 'bytes');
  assert.equal(out.results[0].source_path, '/a');
  assert.equal(out.results[0].custom_row, 99);
  assert.equal(out.custom_envelope, 'top');
  assert.equal(out.results[0].matches[0].offset_chars, 0);
  assert.equal(out.capacity_limited, true);
  assert.equal(out.continuation, CONTINUATION);
});

test('returns null when even the empty metadata envelope never fits', async () => {
  const input = {
    observation_type: 'scoped-artifact-search/v1', query: 'q',
    results: [
      { uri: 'file:///a', matches: [{ offset_chars: 7, excerpt: 'keep', excerpt_truncated: false,
        source_line: 3, custom_match: 'x' }], complete: true, coordinate_space: 'bytes' },
      { uri: 'file:///b', complete: false, code: 'not_found' }
    ],
    complete: true, custom_envelope: 'top'
  };
  const before = canonical(input);
  const out = await selectArtifactSearchFeedback(input, async () => false);
  assert.equal(out, null);
  assert.equal(canonical(input), before);  // input untouched, incl. unknown metadata
  assert.equal(input.results[0].matches[0].custom_match, 'x');
  assert.equal(input.results[0].matches[0].excerpt, 'keep');
  assert.equal(input.results[1].code, 'not_found');
  assert.equal(input.custom_envelope, 'top');
});
