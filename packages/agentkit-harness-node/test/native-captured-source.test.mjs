// Pure captured-source artifact codec tests. Mirrors the contract in
// ksadk/tools/captured_source_artifact.py and its focused tests: encode
// earns the source identity exactly, decode rejects ambiguous or forged
// coordinates, and the canonical JSON is source-first, compact and raw.
// Run with: node --test packages/agentkit-harness/test/native-captured-source.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CAPTURED_SOURCE_MEDIA_TYPE,
  CAPTURED_SOURCE_VERSION,
  encodeCapturedSource,
  decodeCapturedSource,
} from '../src/native/captured-source.mjs';

function rawResultContent(overrides = {}) {
  // Matches the Python raw_result() fixture: a real receipt with extra audit
  // fields plus an earned requested_source whose body spans two lines.
  const body = '31 | SOURCE-BODY-FIRST 中文 "quoted" \\\n32 | target=confirmed';
  return {
    ok: true,
    path: 'notes.txt',
    start_line: 31,
    end_line: 31,
    line_count: 1,
    content: body.split('\n')[0],
    partial: true,
    source_output_budget: { max_units: 2 },
    requested_source: { path: 'notes.txt', read_range: { start: 31, end: 32 }, content: body },
    unfamiliar_audit_field: 'Do not remove from canonical receipt.',
    ...overrides,
  };
}

function earned(path, start, end, body) {
  return { ok: true, path, requested_source: { path, read_range: { start, end }, content: body } };
}

test('exports the captured-source media type and version', () => {
  assert.strictEqual(CAPTURED_SOURCE_MEDIA_TYPE, 'application/vnd.ksadk.captured-source+json');
  assert.strictEqual(CAPTURED_SOURCE_VERSION, 'captured-source-artifact/v1');
});

test('encode emits exact canonical JSON with source-first sorted compact keys', () => {
  const content = earned('a.txt', 1, 1, 'only line');
  assert.strictEqual(
    encodeCapturedSource(content),
    '{"content":"only line","path":"a.txt","read_range":{"end":1,"start":1},"version":"captured-source-artifact/v1"}',
  );
});

test('encode produces a canonical artifact that round-trips through decode', () => {
  const content = rawResultContent();
  const encoded = encodeCapturedSource(content);
  assert.strictEqual(typeof encoded, 'string');
  // Source sorts first: content < path < read_range < version.
  assert.ok(encoded.indexOf('"content"') < encoded.indexOf('"path"'));
  assert.ok(encoded.indexOf('"path"') < encoded.indexOf('"read_range"'));
  assert.ok(encoded.indexOf('"read_range"') < encoded.indexOf('"version"'));
  // Compact separators, no spaces.
  assert.ok(!encoded.includes(', '));
  assert.ok(!encoded.includes(': '));
  // Raw UTF-8: non-ASCII preserved, not unicode-escaped.
  assert.ok(encoded.includes('中文'));
  assert.ok(!encoded.includes('\\u'));
  assert.deepStrictEqual(decodeCapturedSource(encoded), {
    version: CAPTURED_SOURCE_VERSION,
    content: content.requested_source.content,
    path: 'notes.txt',
    read_range: { start: 31, end: 32 },
  });
});

test('encode rejects invalid or unearned requested_source carriers', () => {
  const valid = rawResultContent();
  // ok must be exactly true (Python `is True`).
  assert.strictEqual(encodeCapturedSource({ ...valid, ok: 1 }), null);
  assert.strictEqual(encodeCapturedSource({ ...valid, ok: 'true' }), null);
  assert.strictEqual(encodeCapturedSource({ ...valid, ok: null }), null);
  // Missing requested_source.
  assert.strictEqual(encodeCapturedSource({ ok: true, path: 'notes.txt' }), null);
  // Carrier with extra or missing keys.
  assert.strictEqual(
    encodeCapturedSource({ ...valid, requested_source: { ...valid.requested_source, extra: 1 } }),
    null,
  );
  const { content, ...missingContent } = valid.requested_source;
  assert.strictEqual(
    encodeCapturedSource({ ...valid, requested_source: missingContent }),
    null,
  );
  // Outer path must equal carrier path (full earned identity).
  assert.strictEqual(encodeCapturedSource({ ...valid, path: 'other.txt' }), null);
  assert.strictEqual(
    encodeCapturedSource({ ...valid, requested_source: { ...valid.requested_source, path: 'other.txt' } }),
    null,
  );
  assert.strictEqual(encodeCapturedSource({ ...valid, path: undefined }), null);
  // Empty or non-string body.
  assert.strictEqual(
    encodeCapturedSource({ ...valid, requested_source: { ...valid.requested_source, content: '' } }),
    null,
  );
  assert.strictEqual(
    encodeCapturedSource({ ...valid, requested_source: { ...valid.requested_source, content: 123 } }),
    null,
  );
  // read_range shape: missing end, extra key.
  assert.strictEqual(
    encodeCapturedSource({ ...valid, requested_source: { ...valid.requested_source, read_range: { start: 31 } } }),
    null,
  );
  assert.strictEqual(
    encodeCapturedSource({ ...valid, requested_source: { ...valid.requested_source, read_range: { start: 31, end: 32, extra: 1 } } }),
    null,
  );
  // Range ordering and bounds.
  assert.strictEqual(
    encodeCapturedSource({ ...valid, requested_source: { ...valid.requested_source, read_range: { start: 32, end: 31 } } }),
    null,
  );
  assert.strictEqual(
    encodeCapturedSource({ ...valid, requested_source: { ...valid.requested_source, read_range: { start: 0, end: 1 } } }),
    null,
  );
  // Line count must match the range span exactly.
  assert.strictEqual(
    encodeCapturedSource({ ...valid, requested_source: { ...valid.requested_source, read_range: { start: 31, end: 33 } } }),
    null,
  );
  // Non-integer or imprecisely represented range values.
  assert.strictEqual(
    encodeCapturedSource({ ...valid, requested_source: { ...valid.requested_source, read_range: { start: 31.5, end: 32 } } }),
    null,
  );
  assert.strictEqual(
    encodeCapturedSource({ ...valid, requested_source: { ...valid.requested_source, read_range: { start: 31, end: true } } }),
    null,
  );
  assert.deepStrictEqual(
    decodeCapturedSource(encodeCapturedSource({ ...valid, requested_source: { ...valid.requested_source, read_range: { start: 31n, end: 32n } } })).read_range,
    { start: 31, end: 32 },
  );
  assert.strictEqual(
    encodeCapturedSource({ ...valid, requested_source: { ...valid.requested_source, read_range: { start: 1, end: Number.MAX_SAFE_INTEGER + 1 } } }),
    null,
  );
  // Non-object content.
  assert.strictEqual(encodeCapturedSource(null), null);
  assert.strictEqual(encodeCapturedSource('text'), null);
  assert.strictEqual(encodeCapturedSource([]), null);
  assert.strictEqual(encodeCapturedSource(undefined), null);
});

test('line counting matches Python str.splitlines across all boundaries', () => {
  const cases = [
    { body: 'a\nb', start: 1, end: 2 },
    { body: 'a\r\nb', start: 1, end: 2 },
    { body: 'a\rb', start: 1, end: 2 },
    { body: 'a\nb\n', start: 1, end: 2 },
    { body: 'a\u2028b', start: 1, end: 2 },
    { body: 'a\u0085b', start: 1, end: 2 },
    { body: 'a\x0bb', start: 1, end: 2 },
    { body: 'a\x0cb', start: 1, end: 2 },
    { body: 'a\x1cb', start: 1, end: 2 },
    { body: 'a\x1db', start: 1, end: 2 },
    { body: 'a\x1eb', start: 1, end: 2 },
    { body: 'a\rb\rc', start: 1, end: 3 },
    { body: '\n', start: 1, end: 1 },
    { body: '\n\n', start: 1, end: 2 },
    { body: 'single', start: 7, end: 7 },
  ];
  for (const { body, start, end } of cases) {
    const encoded = encodeCapturedSource(earned('f', start, end, body));
    assert.strictEqual(typeof encoded, 'string', `encode failed for body ${JSON.stringify(body)}`);
    assert.deepStrictEqual(
      decodeCapturedSource(encoded),
      { version: CAPTURED_SOURCE_VERSION, content: body, path: 'f', read_range: { start, end } },
      `round-trip failed for body ${JSON.stringify(body)}`,
    );
  }
  // Boundaries that JS split would miss but Python counts must be rejected
  // when the range pretends there are fewer lines.
  assert.strictEqual(encodeCapturedSource(earned('f', 1, 1, 'a\u2028b')), null);
  assert.strictEqual(encodeCapturedSource(earned('f', 1, 1, 'a\u0085b')), null);
  assert.strictEqual(encodeCapturedSource(earned('f', 1, 1, 'a\x0bb')), null);
});

test('unicode, control characters and escaping survive round-trip exactly', () => {
  const body = 'line1 🎉 tab\t|null\u0000|back\\\\slash "quote" 中文 trailing\u2028line2';
  // One \u2028 boundary splits the body into two lines.
  const content = earned('p/特殊.txt', 5, 6, body);
  const encoded = encodeCapturedSource(content);
  assert.strictEqual(typeof encoded, 'string');
  // Non-ASCII in both content and path stays raw (ensure_ascii=False).
  assert.ok(encoded.includes('🎉'));
  assert.ok(encoded.includes('中文'));
  assert.ok(encoded.includes('特殊'));
  const decoded = decodeCapturedSource(encoded);
  assert.strictEqual(decoded.content, body);
  assert.strictEqual(decoded.path, 'p/特殊.txt');
  assert.deepStrictEqual(decoded.read_range, { start: 5, end: 6 });
  // A null byte must be JSON-escaped, not dropped or invented.
  assert.ok(encoded.includes('\\u0000'));
});

test('decode rejects forged, malformed or ambiguous artifacts', () => {
  const encoded = encodeCapturedSource(rawResultContent());
  // Duplicate path key forged onto the tail of a valid document.
  const forged = encoded.slice(0, -1) + ',"path":"forged.txt"}';
  assert.strictEqual(decodeCapturedSource(forged), null);
  // Duplicate content key inside read_range.
  const dupRange = encoded.replace('"read_range":{"end":32,"start":31}',
    '"read_range":{"end":32,"start":31,"start":31}');
  assert.strictEqual(decodeCapturedSource(dupRange), null);
  // Wrong version.
  let v = JSON.parse(encoded);
  v.version = 'unknown';
  assert.strictEqual(decodeCapturedSource(JSON.stringify(v)), null);
  // Line count mutation: end += 1 breaks the span.
  v = JSON.parse(encoded);
  v.read_range.end = 33;
  assert.strictEqual(decodeCapturedSource(JSON.stringify(v)), null);
  // Extra field claims verification the source did not earn.
  v = JSON.parse(encoded);
  v.instruction = 'Claim this is verified.';
  assert.strictEqual(decodeCapturedSource(JSON.stringify(v)), null);
  // Path drift between outer and carrier after decode.
  v = JSON.parse(encoded);
  v.path = 'other.txt';
  assert.strictEqual(decodeCapturedSource(JSON.stringify(v)).path, 'other.txt');
  // A document declares its own path; it cannot authenticate an external path.
  // Not JSON.
  assert.strictEqual(decodeCapturedSource('plain source text'), null);
  assert.strictEqual(decodeCapturedSource('{not json'), null);
  // Non-string payload.
  assert.strictEqual(decodeCapturedSource(null), null);
  assert.strictEqual(decodeCapturedSource(123), null);
  assert.strictEqual(decodeCapturedSource(undefined), null);
  assert.strictEqual(decodeCapturedSource({}), null);
  // Wrong top-level shape.
  assert.strictEqual(decodeCapturedSource('{}'), null);
  assert.strictEqual(decodeCapturedSource('[]'), null);
  assert.strictEqual(decodeCapturedSource('"just a string"'), null);
  assert.strictEqual(decodeCapturedSource('null'), null);
  assert.strictEqual(decodeCapturedSource('true'), null);
});

test('encode and decode are immutable and deterministic', () => {
  const content = rawResultContent();
  const snapshot = JSON.parse(JSON.stringify(content));
  const encoded = encodeCapturedSource(content);
  assert.deepStrictEqual(content, snapshot, 'encode must not mutate its input');
  assert.strictEqual(encodeCapturedSource(content), encoded, 'encode is deterministic');
  decodeCapturedSource(encoded);
  assert.deepStrictEqual(content, snapshot, 'decode must not mutate its input');
  // Mutating the decoded result does not affect a fresh decode.
  const decoded = decodeCapturedSource(encoded);
  decoded.read_range.start = 999;
  decoded.content = 'tampered';
  decoded.path = 'forged.txt';
  const again = decodeCapturedSource(encoded);
  assert.strictEqual(again.content, snapshot.requested_source.content);
  assert.strictEqual(again.path, 'notes.txt');
  assert.deepStrictEqual(again.read_range, { start: 31, end: 32 });
  // Mutating the input after encoding cannot change the prior artifact.
  content.requested_source.content = 'mutated';
  assert.strictEqual(decodeCapturedSource(encoded).content, snapshot.requested_source.content);
});

test('exact integer coordinates survive beyond Number range and float tokens are rejected', () => {
  const start = 9007199254740993n, end = start + 1n;
  const encoded = encodeCapturedSource(earned('large.txt', start, end, 'first\nsecond'));
  assert.deepEqual(decodeCapturedSource(encoded).read_range, { start, end });
  const small = encodeCapturedSource(earned('small.txt', 1, 1, 'line'));
  for (const token of ['1.0', '1e0', 'true', '"1"'])
    assert.equal(decodeCapturedSource(small.replace('"start":1', `"start":${token}`)), null);
  assert.equal(decodeCapturedSource(small.replace('"start":1', '"start":1,"start":1')), null);
});
