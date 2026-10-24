/** Pure tests for convertA2AContent + a2aMetadataString. Not run by the
 *  implementer; parent runs them against the real a2aIdentity helper and a
 *  Python oracle (ksadk/events/adapters/_a2a_snapshot.py:_convert_part).
 *
 *  Reference: _a2a_snapshot.py:504-581 + _a2a_support.py. Wire field names are
 *  protobuf JSON json_name: text|raw|url|data oneof, metadata, filename,
 *  mediaType. raw is TYPE_BYTES → base64 string on the wire.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { convertA2AContent, a2aMetadataString } from '../src/providers/native-a2a-content.mjs';

const ITEM = 'item_0123456789abcdef0123456';
function artifact(parts, { artifactId = 'art-1', name = 'doc' } = {}) { return { artifactId, name, parts }; }
function message(parts, { messageId = 'msg-1', role = 'ROLE_AGENT' } = {}) { return { messageId, role, parts }; }
function ptext(text, metadata) { const out = { text }; if (metadata) out.metadata = metadata; return out; }
function pdata(data, metadata) { const out = { data }; if (metadata) out.metadata = metadata; return out; }
function purl(url, { filename, mediaType, metadata } = {}) {
  const out = { url }; if (filename !== undefined) out.filename = filename; if (mediaType !== undefined) out.mediaType = mediaType;
  if (metadata) out.metadata = metadata; return out;
}
function praw(raw, { filename, mediaType, metadata } = {}) {
  const out = { raw }; if (filename !== undefined) out.filename = filename; if (mediaType !== undefined) out.mediaType = mediaType;
  if (metadata) out.metadata = metadata; return out;
}

// ---- text ----------------------------------------------------------------

test('text part yields TextContent with stable part_id from text:{index}', () => {
  const out = convertA2AContent(artifact([ptext('hi')]), ITEM);
  assert.equal(out.length, 1);
  assert.equal(out[0].content_type, 'text');
  assert.equal(out[0].text, 'hi');
  assert.match(out[0].part_id, /^part_[0-9a-f]{24}$/u);
});

test('text part uses explicit metadata.part_id when present and non-empty', () => {
  const out = convertA2AContent(artifact([ptext('hi', { part_id: 'p-7' })]), ITEM);
  assert.ok(out[0].part_id.startsWith('part_'));
  assert.notEqual(out[0].part_id, convertA2AContent(artifact([ptext('hi')]), ITEM)[0].part_id);
});

test('startIndex offsets text:{index} fallback and message-attachment id', () => {
  const a0 = convertA2AContent(artifact([ptext('a'), ptext('b')]), ITEM, { startIndex: 0 });
  const a5 = convertA2AContent(artifact([ptext('a'), ptext('b')]), ITEM, { startIndex: 5 });
  assert.notEqual(a0[0].part_id, a5[0].part_id);
  assert.notEqual(a0[1].part_id, a5[1].part_id);
});

// ---- data kinds ----------------------------------------------------------

test('data part without kind → DataContent', () => {
  const out = convertA2AContent(artifact([pdata({ x: 1 })]), ITEM);
  assert.equal(out[0].content_type, 'data');
  assert.deepEqual(out[0].data, { x: 1 });
});

test('data part with kind=tool_call → ToolCallContent with required call_id/name', () => {
  const out = convertA2AContent(artifact([pdata({ q: 'r' }, { kind: 'tool_call', call_id: 'c1', name: 'search' })]), ITEM);
  assert.equal(out[0].content_type, 'tool_call');
  assert.equal(out[0].call_id, 'c1');
  assert.equal(out[0].name, 'search');
  assert.deepEqual(out[0].arguments, { q: 'r' });
});

test('data part with ksadk_kind=tool_result → ToolResultContent', () => {
  const out = convertA2AContent(artifact([pdata({ ok: true }, { ksadk_kind: 'tool_result', call_id: 'c1' })]), ITEM);
  assert.equal(out[0].content_type, 'tool_result');
  assert.equal(out[0].call_id, 'c1');
  assert.deepEqual(out[0].result, { ok: true });
  assert.equal(out[0].is_error, false);
});

// ---- Python bool(empty container) truthiness for is_error ----------------

test('is_error Python-falsy containers stay false (JS Boolean would diverge)', () => {
  for (const falsy of [false, 0, '', null, [], {}]) {
    const out = convertA2AContent(artifact([pdata({}, { ksadk_kind: 'tool_result', call_id: 'c1', is_error: falsy })]), ITEM);
    assert.equal(out[0].is_error, false, `is_error should be false for ${JSON.stringify(falsy)}`);
  }
});

test('is_error Python-truthy values become true', () => {
  for (const truthy of [true, 1, 'x', ['x'], { a: 1 }]) {
    const out = convertA2AContent(artifact([pdata({}, { ksadk_kind: 'tool_result', call_id: 'c1', is_error: truthy })]), ITEM);
    assert.equal(out[0].is_error, true, `is_error should be true for ${JSON.stringify(truthy)}`);
  }
});

test('is_error missing defaults to false', () => {
  const out = convertA2AContent(artifact([pdata({}, { ksadk_kind: 'tool_result', call_id: 'c1' })]), ITEM);
  assert.equal(out[0].is_error, false);
});

// ---- unknown / data kind -------------------------------------------------

test('data part with unsupported kind → A2A_CONTENT_UNKNOWN_KIND', () => {
  assert.throws(() => convertA2AContent(artifact([pdata({}, { kind: 'weird' })]), ITEM),
    { code: 'A2A_CONTENT_UNKNOWN_KIND' });
});

test('tool_call missing call_id → A2A_CONTENT_MISSING_CALL_ID', () => {
  assert.throws(() => convertA2AContent(artifact([pdata({}, { kind: 'tool_call', name: 'n' })]), ITEM),
    { code: 'A2A_CONTENT_MISSING_CALL_ID' });
  assert.throws(() => convertA2AContent(artifact([pdata({}, { kind: 'tool_call', call_id: '  ', name: 'n' })]), ITEM),
    { code: 'A2A_CONTENT_MISSING_CALL_ID' });
});

test('tool_call missing name → A2A_CONTENT_MISSING_NAME', () => {
  assert.throws(() => convertA2AContent(artifact([pdata({}, { kind: 'tool_call', call_id: 'c1' })]), ITEM),
    { code: 'A2A_CONTENT_MISSING_NAME' });
});

// ---- url / raw / artifact_id / name fallback / mediaType -----------------

test('url part on artifact → ArtifactContent with artifact_id and name fallback', () => {
  const out = convertA2AContent(artifact([purl('https://x/y')]), ITEM);
  assert.equal(out[0].content_type, 'artifact');
  assert.equal(out[0].artifact_id, 'art-1');
  assert.equal(out[0].name, 'doc');
  assert.equal(out[0].uri, 'https://x/y');
  assert.equal(out[0].mime_type, null);
  assert.equal(out[0].data, null);
});

test('url part on message → message:{messageId}:part:{index} artifact_id, name "attachment"', () => {
  const out = convertA2AContent(message([purl('https://x')]), ITEM, { startIndex: 3 });
  assert.equal(out[0].artifact_id, 'message:msg-1:part:3');
  assert.equal(out[0].name, 'attachment');
});

test('url filename overrides owner name; mediaType propagated', () => {
  const out = convertA2AContent(artifact([purl('https://x', { filename: 'f.pdf', mediaType: 'application/pdf' })]), ITEM);
  assert.equal(out[0].name, 'f.pdf');
  assert.equal(out[0].mime_type, 'application/pdf');
});

test('mediaType is read from camelCase wire field, not media_type', () => {
  // A part that sets media_type (snake) but not mediaType should NOT pick it up.
  const out = convertA2AContent(artifact([{ url: 'https://x', media_type: 'application/pdf' }]), ITEM);
  assert.equal(out[0].mime_type, null, 'snake_case media_type must be ignored');
  const out2 = convertA2AContent(artifact([purl('https://x', { mediaType: 'image/png' })]), ITEM);
  assert.equal(out2[0].mime_type, 'image/png');
});

test('raw part → ArtifactContent with canonical base64 data, uri null', () => {
  // "Hi" → base64 "SGk="
  const out = convertA2AContent(artifact([praw('SGk=')]), ITEM);
  assert.equal(out[0].uri, null);
  assert.deepEqual(out[0].data, { base64: 'SGk=' });
});

test('raw accepts URL-safe alphabet and no padding, normalizes to canonical', () => {
  // bytes with / and + force URL-safe: "AB/c" +, etc. Use a value containing
  // + and / so URL-safe differs from standard.
  const bytes = Buffer.from([0x00, 0x10, 0x83, 0xfb, 0xff]); // base64 "ABAD" + ...
  const std = bytes.toString('base64');
  const urlsafe = std.replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
  const out = convertA2AContent(artifact([praw(urlsafe)]), ITEM);
  assert.equal(out[0].data.base64, std, 'URL-safe unpadded normalizes to standard padded');
});

test('raw invalid base64 character is rejected, not silently repaired', () => {
  assert.throws(() => convertA2AContent(artifact([praw('SGk!')]), ITEM), { code: 'A2A_CONTENT_INVALID_BYTES' });
  assert.throws(() => convertA2AContent(artifact([praw('A')]), ITEM), { code: 'A2A_CONTENT_INVALID_BYTES' });
  assert.throws(() => convertA2AContent(artifact([praw('AB')]), ITEM), { code: 'A2A_CONTENT_INVALID_BYTES' });
  // length % 4 == 1 after stripping padding is invalid
  assert.throws(() => convertA2AContent(artifact([praw('ABCDE')]), ITEM), { code: 'A2A_CONTENT_INVALID_BYTES' });
});

test('raw non-string → A2A_CONTENT_INVALID_BYTES', () => {
  assert.throws(() => convertA2AContent(artifact([praw(5)]), ITEM), { code: 'A2A_CONTENT_INVALID_BYTES' });
  assert.throws(() => convertA2AContent(artifact([praw(Uint8Array.from([1]))]), ITEM), { code: 'A2A_CONTENT_INVALID_BYTES' });
});

test('artifact missing artifactId for url part → A2A_CONTENT_MISSING_ARTIFACT_ID', () => {
  assert.throws(() => convertA2AContent(artifact([purl('https://x')], { artifactId: '  ' }), ITEM),
    { code: 'A2A_CONTENT_MISSING_ARTIFACT_ID' });
});

// ---- bigint / IEEE double -----------------------------------------------

test('bigint in data is reduced to finite Number without dropping structure', () => {
  const out = convertA2AContent(artifact([pdata({ big: 9007199254740993n, nested: [1n, 2n] })]), ITEM);
  assert.equal(out[0].data.big, 9007199254740992);
  assert.deepEqual(out[0].data.nested, [1, 2]);
});

test('small bigint preserves exact value as number', () => {
  const out = convertA2AContent(artifact([pdata({ v: 42n })]), ITEM);
  assert.strictEqual(out[0].data.v, 42);
  assert.equal(typeof out[0].data.v, 'number');
});

test('non-finite number in data is rejected', () => {
  assert.throws(() => convertA2AContent(artifact([pdata({ v: Infinity })]), ITEM), { code: 'A2A_CONTENT_NON_FINITE' });
  assert.throws(() => convertA2AContent(artifact([pdata({ v: NaN })]), ITEM), { code: 'A2A_CONTENT_NON_FINITE' });
});

test('bigint Infinity-equivalent is rejected', () => {
  assert.throws(() => convertA2AContent(artifact([pdata({ v: 10n ** 400n })]), ITEM), { code: 'A2A_CONTENT_NON_FINITE' });
});

// ---- metadata Python str() / repr() via a2aMetadataString ----------------

test('a2aMetadataString: number 1 (double) → "1.0", 1e-5 → "1e-05", 1e20 → "1e+20"', () => {
  assert.equal(a2aMetadataString({ kind: 1 }, 'kind'), '1.0');
  assert.equal(a2aMetadataString({ kind: 1e-5 }, 'kind'), '1e-05');
  assert.equal(a2aMetadataString({ kind: 1e20 }, 'kind'), '1e+20');
  assert.equal(a2aMetadataString({ kind: 100 }, 'kind'), '100.0');
  assert.equal(a2aMetadataString({ kind: 0.1 }, 'kind'), '0.1');
  assert.equal(a2aMetadataString({ kind: -0 }, 'kind'), '-0.0');
});

test('a2aMetadataString: bool → "True"/"False", null skipped', () => {
  assert.equal(a2aMetadataString({ kind: true }, 'kind'), 'True');
  assert.equal(a2aMetadataString({ kind: false }, 'kind'), 'False');
  assert.equal(a2aMetadataString({ kind: null }, 'kind'), null);
  assert.equal(a2aMetadataString({ kind: null, fallback: 'x' }, 'kind', 'fallback'), 'x');
});

test('a2aMetadataString: empty list → "[]", empty dict → "{}"', () => {
  assert.equal(a2aMetadataString({ kind: [] }, 'kind'), '[]');
  assert.equal(a2aMetadataString({ kind: {} }, 'kind'), '{}');
});

test('a2aMetadataString: containers use Python repr (True/None/single quotes)', () => {
  assert.equal(a2aMetadataString({ kind: [1, true, null, 'x'] }, 'kind'), "[1.0, True, None, 'x']");
  assert.equal(a2aMetadataString({ kind: { a: 1 } }, 'kind'), "{'a': 1.0}");
  assert.equal(a2aMetadataString({ kind: { a: true, b: null } }, 'kind'), "{'a': True, 'b': None}");
});

test('a2aMetadataString: string with apostrophe/backslash escaped in repr', () => {
  // Python repr(["it's", 'back\slash']) == ["it's", 'back\\slash']
  //   "it's" has a single quote and no double quote → Python uses double quotes
  //   'back\slash' has no single quote → single quotes, backslash escaped to \\
  assert.equal(a2aMetadataString({ kind: ["it's", 'back\\slash'] }, 'kind'), "[\"it's\", 'back\\\\slash']");
});

test('a2aMetadataString: empty string and whitespace-only skipped', () => {
  assert.equal(a2aMetadataString({ kind: '' }, 'kind'), null);
  assert.equal(a2aMetadataString({ kind: '   ' }, 'kind'), null);
});

test('a2aMetadataString: non-object metadata returns null', () => {
  assert.equal(a2aMetadataString(null, 'kind'), null);
  assert.equal(a2aMetadataString([], 'kind'), null);
  assert.equal(a2aMetadataString('x', 'kind'), null);
});

// metadata str drives kind/part_id selection
test('metadata number kind is coerced to float str before matching', () => {
  // kind=1 → "1.0" → not tool_call/tool_result/data → unknown
  assert.throws(() => convertA2AContent(artifact([pdata({}, { kind: 1 })]), ITEM), { code: 'A2A_CONTENT_UNKNOWN_KIND' });
});

// ---- Unicode / determinism -----------------------------------------------

test('Unicode text is preserved', () => {
  const out = convertA2AContent(artifact([ptext('中文记忆 😀 üñîçødé')]), ITEM);
  assert.equal(out[0].text, '中文记忆 😀 üñîçødé');
});

test('same owner+itemId+part_id yields identical part_id (determinism)', () => {
  const a = convertA2AContent(artifact([ptext('x', { part_id: 'p1' })]), ITEM);
  const b = convertA2AContent(artifact([ptext('x', { part_id: 'p1' })]), ITEM);
  assert.equal(a[0].part_id, b[0].part_id);
});

// ---- duplicate part_id ---------------------------------------------------

test('duplicate part_id across parts → A2A_CONTENT_DUPLICATE_PART_ID', () => {
  assert.throws(() => convertA2AContent(artifact([ptext('a', { part_id: 'dup' }), ptext('b', { part_id: 'dup' })]), ITEM),
    { code: 'A2A_CONTENT_DUPLICATE_PART_ID' });
});

test('two text parts with same fallback text:{index} distinct', () => {
  const out = convertA2AContent(artifact([ptext('a'), ptext('b')]), ITEM);
  assert.notEqual(out[0].part_id, out[1].part_id);
});

// ---- negatives: owner / parts / oneof ------------------------------------

test('owner not object → A2A_CONTENT_INVALID_OWNER', () => {
  assert.throws(() => convertA2AContent(null, ITEM), { code: 'A2A_CONTENT_INVALID_OWNER' });
  assert.throws(() => convertA2AContent([], ITEM), { code: 'A2A_CONTENT_INVALID_OWNER' });
  assert.throws(() => convertA2AContent('x', ITEM), { code: 'A2A_CONTENT_INVALID_OWNER' });
});

test('owner missing both artifactId and messageId → A2A_CONTENT_INVALID_OWNER', () => {
  assert.throws(() => convertA2AContent({ parts: [ptext('a')] }, ITEM), { code: 'A2A_CONTENT_INVALID_OWNER' });
});

test('parts not array → A2A_CONTENT_INVALID_PARTS', () => {
  assert.throws(() => convertA2AContent({ artifactId: 'a', name: 'n', parts: 'x' }, ITEM), { code: 'A2A_CONTENT_INVALID_PARTS' });
});

test('empty parts array → A2A_CONTENT_EMPTY_PARTS', () => {
  assert.throws(() => convertA2AContent(artifact([]), ITEM), { code: 'A2A_CONTENT_EMPTY_PARTS' });
});

test('part with no content oneof → A2A_CONTENT_EMPTY_PART', () => {
  assert.throws(() => convertA2AContent(artifact([{}]), ITEM), { code: 'A2A_CONTENT_EMPTY_PART' });
  assert.throws(() => convertA2AContent(artifact([{ text: null }]), ITEM), { code: 'A2A_CONTENT_EMPTY_PART' });
});

test('part with two content fields → A2A_CONTENT_ONEOF_CONFLICT', () => {
  assert.throws(() => convertA2AContent(artifact([{ text: 'a', data: { x: 1 } }]), ITEM),
    { code: 'A2A_CONTENT_ONEOF_CONFLICT' });
});

test('text part with non-string text → A2A_CONTENT_INVALID_TEXT', () => {
  assert.throws(() => convertA2AContent(artifact([{ text: 123 }]), ITEM), { code: 'A2A_CONTENT_INVALID_TEXT' });
});

test('url part with non-string url → A2A_CONTENT_INVALID_URL', () => {
  assert.throws(() => convertA2AContent(artifact([{ url: 5 }]), ITEM), { code: 'A2A_CONTENT_INVALID_URL' });
});

test('invalid itemId → A2A_CONTENT_INVALID_ITEM_ID', () => {
  assert.throws(() => convertA2AContent(artifact([ptext('a')]), ''), { code: 'A2A_CONTENT_INVALID_ITEM_ID' });
  assert.throws(() => convertA2AContent(artifact([ptext('a')]), 5), { code: 'A2A_CONTENT_INVALID_ITEM_ID' });
});

test('invalid startIndex → A2A_CONTENT_INVALID_START_INDEX', () => {
  assert.throws(() => convertA2AContent(artifact([ptext('a')]), ITEM, { startIndex: -1 }), { code: 'A2A_CONTENT_INVALID_START_INDEX' });
  assert.throws(() => convertA2AContent(artifact([ptext('a')]), ITEM, { startIndex: 1.5 }), { code: 'A2A_CONTENT_INVALID_START_INDEX' });
});

test('non-object metadata → A2A_CONTENT_INVALID_METADATA', () => {
  assert.throws(() => convertA2AContent(artifact([ptext('a', 'not-object')]), ITEM), { code: 'A2A_CONTENT_INVALID_METADATA' });
  assert.throws(() => convertA2AContent(artifact([ptext('a', [])]), ITEM), { code: 'A2A_CONTENT_INVALID_METADATA' });
});

test('parts over limit → A2A_CONTENT_PARTS_LIMIT', () => {
  const parts = Array.from({ length: 4097 }, () => ptext('x'));
  assert.throws(() => convertA2AContent(artifact(parts), ITEM), { code: 'A2A_CONTENT_PARTS_LIMIT' });
});

test('deep nesting over limit → A2A_CONTENT_DEPTH_LIMIT', () => {
  let v = { x: 1 };
  for (let i = 0; i < 105; i++) v = { nested: v };
  assert.throws(() => convertA2AContent(artifact([pdata(v)]), ITEM), { code: 'A2A_CONTENT_DEPTH_LIMIT' });
});

// ---- safety: non-JSON / prototype / surrogates ---------------------------

test('undefined in data is rejected, not coerced to null', () => {
  assert.throws(() => convertA2AContent(artifact([pdata({ v: undefined })]), ITEM), { code: 'A2A_CONTENT_INVALID_DATA' });
});

test('Date instance in data is rejected (not JSON, not coerced to ISO string)', () => {
  assert.throws(() => convertA2AContent(artifact([pdata({ v: new Date(0) })]), ITEM), { code: 'A2A_CONTENT_INVALID_DATA' });
});

test('function value in data is rejected', () => {
  assert.throws(() => convertA2AContent(artifact([pdata({ v: () => 1 })]), ITEM), { code: 'A2A_CONTENT_INVALID_DATA' });
});

test('__proto__ key remains JSON data without changing the output prototype', () => {
  // Use JSON.parse to construct a literal __proto__ own-key object safely.
  const obj = JSON.parse('{"__proto__":{"polluted":true}}');
  const converted = convertA2AContent(artifact([pdata(obj)]), ITEM)[0].data;
  assert.equal(Object.getPrototypeOf(converted), Object.prototype);
  assert.equal(Object.hasOwn(converted, '__proto__'), true);
  assert.deepEqual(converted.__proto__, { polluted: true });
  assert.equal(({}).polluted, undefined, 'prototype not polluted');
});

test('isolated UTF-16 surrogate in text is rejected', () => {
  assert.throws(() => convertA2AContent(artifact([ptext('a\uD800b')]), ITEM), { code: 'A2A_CONTENT_INVALID_STRING' });
  assert.throws(() => convertA2AContent(artifact([ptext('\uDC00')]), ITEM), { code: 'A2A_CONTENT_INVALID_STRING' });
});

test('isolated surrogate in raw base64 string is rejected', () => {
  assert.throws(() => convertA2AContent(artifact([praw('SGk\uD800=')]), ITEM), { code: 'A2A_CONTENT_INVALID_STRING' });
});

test('error message never echoes payload bytes, URLs, or base64', () => {
  try { convertA2AContent(artifact([{ ...purl('https://secret.example/cred'), text: 'private' }]), ITEM); assert.fail('throw expected'); }
  catch (err) {
    assert.match(err.code, /^A2A_CONTENT_/);
    assert.equal(err.message.includes('secret.example'), false, 'URL leaked in message');
    assert.equal(err.message.includes('cred'), false, 'path leaked');
  }
  try { convertA2AContent(artifact([praw('SGk=')]), ITEM, { startIndex: -1 }); }
  catch (err) { assert.equal(err.message.includes('SGk'), false, 'base64 leaked'); }
});
