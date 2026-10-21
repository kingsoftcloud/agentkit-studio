// Codec-boundary regression tests for the Native artifact store. These
// reproduce the two defects an independent parent review found in
// artifact-codec.mjs and pin the fixes with deterministic, side-effect-free
// assertions (real temp dirs for the store-level cases; direct codec calls for
// the unit boundaries). Run with: node --test test/native-artifact-codec.test.mjs
//
// Defect A: safeJsonParse accepted 0x10/+1/01/1./.1 via Number() although the
//   JSON grammar (RFC 8259) rejects them, and invalid string escapes escaped
//   as a bare SyntaxError with no stable error code.
// Defect B: encodeUtf8 silently replaced an unpaired surrogate (U+D800) with
//   U+FFFD, so a store write/read changed the user's bytes; decodeUtf8Fatal
//   stripped a leading BOM via the default TextDecoder, so '﻿hi' did not
//   round-trip.
//
// Valid Unicode (astral characters, BOM, combining marks, NUL) must round-trip
// faithfully; invalid UTF-16 content must be rejected BEFORE any artifact is
// published (no content/meta/intent file left on disk).

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeArtifactStore } from '../src/native/artifact-store.mjs';
import {
  safeJsonParse, encodeUtf8, decodeUtf8Fatal, canonicalStringify, sha256Hex,
} from '../src/native/artifact-codec.mjs';

const SCOPE = Object.freeze({ tenantId: 'tenant', workspaceId: 'ws', userId: 'user', agentId: 'agent' });

test('artifact numeric codec preserves arbitrary integers and large IEEE float values distinctly', () => {
  const integer = 9007199254740993n;
  assert.equal(safeJsonParse(canonicalStringify({ id: integer })).id, integer);
  const float = 1000000000000000100.0;
  assert.equal(typeof safeJsonParse(canonicalStringify(float)), 'number');
  assert.equal(safeJsonParse(canonicalStringify(float)), float);
  assert.equal(Object.is(safeJsonParse(canonicalStringify(-0)), -0), true);
  assert.equal(Object.is(safeJsonParse('-0'), -0), true); // The local artifact decoder retains its JSON.parse-compatible sign.
  assert.equal(typeof safeJsonParse('9'.repeat(4300)), 'bigint');
  assert.throws(() => safeJsonParse('9'.repeat(4301)));
});

function ctx(runId, operationKey, signal) {
  return {
    scope: SCOPE, runId, sessionId: 'sess', turnId: 'turn-1', buildId: 'build-1',
    parentRunId: null, taskChainId: 'chain', operationKey,
    signal: signal || new AbortController().signal,
  };
}

async function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'native-art-codec-'));
  const store = await createNativeArtifactStore({ directory, scope: SCOPE });
  const cleanup = () => rmSync(directory, { recursive: true, force: true });
  return { directory, store, cleanup };
}

// ---------------------------------------------------------------------------
// Defect A, part 1: JSON number grammar. safeJsonParse must match JSON.parse
// exactly for numbers — accept the RFC 8259 grammar, reject what Number()
// silently coerces.

const VALID_NUMBERS = [
  ['0', 0], ['-0', -0], ['1', 1], ['-1', -1], ['10', 10],
  ['1.5', 1.5], ['-1.5', -1.5], ['0.5', 0.5], ['0.0', 0],
  ['1e10', 1e10], ['1e+10', 1e+10], ['1e-10', 1e-10],
  ['1.5e3', 1.5e3], ['-1.5e-3', -1.5e-3], ['1E10', 1e10],
];

const INVALID_NUMBERS = [
  '0x10', '+1', '01', '1.', '.1', '0.', '1e', '1.0e+',
  'Infinity', 'NaN', '-0x1', '00', '1_000', '0x1G', '.',
  '0b1', '0o7',
];

// Grammatically valid JSON numbers that overflow Number to Infinity.
// JSON.parse accepts these (returns Infinity); safeJsonParse rejects them via
// the Number.isFinite guard, which the store relies on because canonicalStringify
// never emits a non-finite number — a non-finite in a stored record is corruption.
const OVERFLOW_NUMBERS = ['1e400', '-1e400'];

test('safeJsonParse accepts exactly the RFC 8259 number grammar and matches JSON.parse', () => {
  for (const [text, expected] of VALID_NUMBERS) {
    const got = safeJsonParse(text);
    assert.equal(got, expected, `accepted ${JSON.stringify(text)}`);
    assert.equal(JSON.parse(text), expected, `JSON.parse agrees on ${JSON.stringify(text)}`);
    // Object.is so -0 and 0 are distinguished where they should be.
    assert.equal(Object.is(got, JSON.parse(text)), true);
  }
});

test('safeJsonParse rejects numbers that Number() coerces but JSON does not allow', () => {
  for (const text of INVALID_NUMBERS) {
    // JSON.parse must reject it too, so this is a true grammar mismatch.
    assert.throws(() => JSON.parse(text), SyntaxError, `JSON.parse must reject ${JSON.stringify(text)} (control)`);
    assert.throws(
      () => safeJsonParse(text),
      (e) => e.code === 'invalid_artifact_record',
      `safeJsonParse must reject ${JSON.stringify(text)} with the stable code`,
    );
  }
});

test('safeJsonParse rejects grammatically-valid numbers that overflow to Infinity', () => {
  for (const text of OVERFLOW_NUMBERS) {
    // JSON.parse accepts these as Infinity — they are valid JSON grammar.
    assert.equal(Number.isFinite(JSON.parse(text)), false, `JSON.parse accepts ${JSON.stringify(text)} as non-finite (control)`);
    assert.throws(
      () => safeJsonParse(text),
      (e) => e.code === 'invalid_artifact_record',
      `safeJsonParse must reject non-finite ${JSON.stringify(text)}`,
    );
  }
});

test('safeJsonParse rejects 0x10 inside an object (the reported sizeBytes case)', () => {
  assert.throws(
    () => safeJsonParse('{"sizeBytes":0x10}'),
    (e) => e.code === 'invalid_artifact_record',
  );
  // and the valid equivalent still parses to the integer 16
  assert.equal(safeJsonParse('{"sizeBytes":16}').sizeBytes, 16);
});

// ---------------------------------------------------------------------------
// Defect A, part 2: string escapes. Invalid escapes must throw the stable
// invalid_artifact_record code (not a bare SyntaxError). Lone-surrogate
// \u escapes are valid JSON grammar and must still parse (surrogate rejection
// is the content path's job, exercised below).

test('safeJsonParse rejects invalid string escapes with the stable error code', () => {
  const bad = ['"\\z"', '"\\x41"', '"\\u00"', '"\\u0"', '"\\u"', '"abc\\"', '"\\u12"', '"\\uZZZZ"'];
  for (const text of bad) {
    assert.throws(() => JSON.parse(text), SyntaxError, `control: JSON.parse rejects ${JSON.stringify(text)}`);
    assert.throws(
      () => safeJsonParse(text),
      (e) => e.code === 'invalid_artifact_record',
      `safeJsonParse must reject ${JSON.stringify(text)} with the stable code`,
    );
  }
});

test('safeJsonParse still accepts valid string escapes including control chars and surrogate escapes', () => {
  assert.equal(safeJsonParse('"\\t"'), '\t');
  assert.equal(safeJsonParse('"\\n"'), '\n');
  assert.equal(safeJsonParse('"\\u0000"'), '\u0000');
  assert.equal(safeJsonParse('"abc\\u0041"'), 'abcA');
  assert.equal(safeJsonParse('"\\uD835\\uDD4F"'), '𝕏'); // paired -> astral
  // A lone-surrogate \u escape is valid JSON grammar (RFC 8259); it parses to a
  // JS string holding the lone surrogate. Content-byte rejection happens in
  // encodeUtf8, not here.
  assert.equal(safeJsonParse('"\\uD800"'), '\uD800');
});

// ---------------------------------------------------------------------------
// Preserve duplicate-key and prototype-polluting-key checks (regression guard
// that the number/escape work did not weaken them). The error code stays the
// caller's default invalid_artifact_record.

test('safeJsonParse still rejects duplicate keys and prototype-polluting keys', () => {
  const bad = [
    '{"a":1,"a":2}',
    '{"__proto__":1}',
    '{"constructor":1}',
    '{"prototype":1}',
  ];
  for (const text of bad) {
    assert.throws(
      () => safeJsonParse(text),
      (e) => e.code === 'invalid_artifact_record',
      `safeJsonParse must reject ${JSON.stringify(text)}`,
    );
  }
  // a plain record and an array still parse; records use a null-prototype
  // object so prototype-equality with a literal does not hold — check by hand.
  const obj = safeJsonParse('{"a":1}');
  assert.equal(obj.a, 1);
  assert.equal(Object.getPrototypeOf(obj), null);
  assert.deepEqual([...safeJsonParse('[1,2]')], [1, 2]);
});

test('safeJsonParse rejects trailing garbage after a value', () => {
  assert.throws(() => safeJsonParse('1 2'), (e) => e.code === 'invalid_artifact_record');
  assert.throws(() => safeJsonParse('{}x'), (e) => e.code === 'invalid_artifact_record');
});

// ---------------------------------------------------------------------------
// Defect B, part 1: encodeUtf8 must reject unpaired surrogates BEFORE any
// encoding (no silent U+FFFD replacement). Valid surrogate pairs (astral) pass.

test('encodeUtf8 rejects unpaired surrogates with invalid_artifact_content', () => {
  const lone = ['\uD800', '\uDFFF', '\uDBFF', '\uDC00', 'a\uD800b', 'a\uDBFFb', '\uD800\uD800', 'abc\uDC00'];
  for (const text of lone) {
    assert.throws(
      () => encodeUtf8(text),
      (e) => e.code === 'invalid_artifact_content',
      `encodeUtf8 must reject lone surrogate in ${JSON.stringify(text)}`,
    );
  }
});

test('encodeUtf8 accepts valid surrogate pairs (astral) and encodes them as UTF-8', () => {
  const astral = ['𝕏', '𝕏', '🀀', '𝕏𝕐🀀𝔸'];
  for (const text of astral) {
    const bytes = encodeUtf8(text);
    assert.equal(decodeUtf8Fatal(bytes), text, `astral round-trip for ${JSON.stringify(text)}`);
  }
  // a paired high+low encodes to the 4-byte astral sequence, not two 3-byte replacements
  assert.equal(encodeUtf8('𝕏').toString('hex'), 'f09d958f'); // U+1D54F
});

test('encodeUtf8 rejects non-strings', () => {
  for (const v of [undefined, null, 42, true, {}, []]) {
    assert.throws(() => encodeUtf8(v), (e) => e.code === 'invalid_artifact_content');
  }
});

// ---------------------------------------------------------------------------
// Defect B, part 2: decodeUtf8Fatal must preserve a leading BOM (ignoreBOM),
// matching Python's strict decode('utf-8') and the existing workspace reader.
// Invalid UTF-8 still throws artifact_content_not_utf8.

test('decodeUtf8Fatal preserves a leading BOM and round-trips with encodeUtf8', () => {
  for (const text of ['﻿hi', '﻿', '﻿﻿', 'x﻿y', '﻿完整😀']) {
    const bytes = encodeUtf8(text);
    assert.equal(decodeUtf8Fatal(bytes), text, `BOM round-trip for ${JSON.stringify(text)}`);
  }
  // The BOM bytes EF BB BF must decode to U+FEFF, not be stripped.
  assert.equal(decodeUtf8Fatal(Buffer.from([0xEF, 0xBB, 0xBF, 0x68, 0x69])), '﻿hi');
});

test('decodeUtf8Fatal throws artifact_content_not_utf8 on invalid UTF-8 (no substitution)', () => {
  // lone continuation byte, truncated 2-byte sequence, overlong-ish garbage
  const bad = [
    Buffer.from([0x80]),
    Buffer.from([0xC3]),            // truncated 2-byte
    Buffer.from([0xFF, 0xFE, 0x00]), // not UTF-8
  ];
  for (const bytes of bad) {
    assert.throws(() => decodeUtf8Fatal(bytes), (e) => e.code === 'artifact_content_not_utf8');
  }
  // confirm the default TextDecoder would have stripped the BOM — this is the
  // behavior we deliberately diverge from by setting ignoreBOM: true.
  const bomBytes = Buffer.from([0xEF, 0xBB, 0xBF, 0x68, 0x69]);
  assert.equal(new TextDecoder('utf-8', { fatal: true }).decode(bomBytes), 'hi', 'default strips BOM (control)');
  assert.notEqual(decodeUtf8Fatal(bomBytes), 'hi', 'our decoder does not strip BOM');
});

// ---------------------------------------------------------------------------
// End-to-end through the store: a lone-surrogate content is rejected BEFORE any
// artifact is published, and valid astral/BOM content round-trips byte-for-byte.

test('store.write rejects lone-surrogate content before publishing any file', async () => {
  const { directory, store, cleanup } = await setup();
  try {
    for (const evil of ['\uD800', 'a\uD800b', '\uD800\uD800', '\uDC00x']) {
      await assert.rejects(
        () => store.write({ ...ctx('r1', 'op-evil'), content: evil, mediaType: 'text/plain', metadata: {} }),
        (e) => e.code === 'invalid_artifact_content',
      );
    }
    // No run directory was ever created for the rejected write: the scope dir
    // either does not exist or holds no content/meta/intent for r1.
    const scopeDir = join(directory, 'artifacts');
    if (existsSync(scopeDir)) {
      for (const d of readdirSync(scopeDir, { withFileTypes: true })) {
        if (d.isDirectory()) {
          for (const runDir of readdirSync(join(scopeDir, d.name), { withFileTypes: true })) {
            const files = readdirSync(join(scopeDir, d.name, runDir.name));
            assert.equal(files.length, 0, `no files published for a rejected write in ${runDir.name}`);
          }
        }
      }
    }
    assert.equal(await store.usageBytes({ scope: SCOPE, runId: 'r1' }), 0);
  } finally { cleanup(); }
});

test('store write/read round-trips astral characters, BOM and combining marks byte-for-byte', async () => {
  const { store, cleanup } = await setup();
  try {
    const samples = [
      '𝕏𝕐🀀𝔸',            // astral plane (surrogate pairs)
      '﻿hi',           // leading BOM
      '﻿完整内容😀abc', // BOM + CJK + astral + ascii
      'éx',            // combining acute (two code points)
      '\u0000\u0001ctrl',    // NUL and control chars
      'plain ascii',         // baseline
    ];
    for (let i = 0; i < samples.length; i += 1) {
      const content = samples[i];
      const ref = await store.write({ ...ctx('r1', `op-${i}`), content, mediaType: 'text/plain', metadata: { i } });
      assert.equal(ref.sizeBytes, Buffer.byteLength(content, 'utf8'), `sizeBytes for ${JSON.stringify(content)}`);
      const page = await store.read({ ...ctx('r1', `op-${i}`), ref, offset: 0, limit: 32000 });
      assert.equal(page.content, content, `round-trip for ${JSON.stringify(content)}`);
      assert.equal(page.nextOffset, null);
      // the digest is over the exact UTF-8 bytes, with the BOM included
      assert.equal(ref.digest, 'sha256:' + sha256Hex(encodeUtf8(content)));
    }
  } finally { cleanup(); }
});

test('store rejects a tampered meta sidecar whose sizeBytes is an invalid JSON number', async () => {
  const { directory, store, cleanup } = await setup();
  try {
    const ref = await store.write({ ...ctx('r1', 'op-1'), content: 'hello', mediaType: 'text/plain', metadata: {} });
    // locate the meta file
    const scopeDir = join(directory, 'artifacts');
    let metaPath = null;
    for (const d of readdirSync(scopeDir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      for (const runDir of readdirSync(join(scopeDir, d.name), { withFileTypes: true })) {
        if (!runDir.isDirectory()) continue;
        for (const f of readdirSync(join(scopeDir, d.name, runDir.name))) {
          if (f.endsWith('.meta.json')) metaPath = join(scopeDir, d.name, runDir.name, f);
        }
      }
    }
    assert.ok(metaPath, 'meta sidecar exists');
    // Each of these is accepted by Number() but invalid JSON grammar.
    for (const badSize of ['0x10', '+1', '01', '1.', '.1']) {
      writeFileSync(metaPath, canonicalStringify({ uri: ref.uri, digest: ref.digest, mediaType: 'text/plain', sizeBytes: badSize, metadata: {}, createdAt: 't' }));
      // sizeBytes is now a STRING holding invalid-grammar number text; safeJsonParse
      // parses the string fine, but validateDurableRecord's type check (number) rejects.
      await assert.rejects(() => store.read({ ...ctx('r1', 'r'), ref, offset: 0, limit: 10 }), /invalid_artifact_record/);
    }
    // And when the bad number appears as a bare JSON number token, the grammar
    // check rejects it directly during parse.
    writeFileSync(metaPath, '{"uri":' + JSON.stringify(ref.uri) + ',"digest":' + JSON.stringify(ref.digest) + ',"mediaType":"text/plain","sizeBytes":0x10,"metadata":{},"createdAt":"t"}');
    await assert.rejects(() => store.read({ ...ctx('r1', 'r'), ref, offset: 0, limit: 10 }), /invalid_artifact_record/);
  } finally { cleanup(); }
});
