/** Deterministic tests for the legacy Memory format/parse helper.
 *  No network, no credentials, no I/O. Pure input/output assertions. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatLegacyMemoryEntries, parseLegacySdkMemoryEntries } from '../src/legacy-memory-format.mjs';

// ---- formatLegacyMemoryEntries --------------------------------------------

test('empty array returns empty string, not "未找到"', () => {
  assert.equal(formatLegacyMemoryEntries([]), '');
});

test('plain string entries are enumerated with 1-based index and blank-line separator', () => {
  assert.equal(formatLegacyMemoryEntries(['alpha', 'beta']), '[1] alpha\n\n[2] beta');
});

test('JSON entry with parts[0].text displays the inner text', () => {
  const entry = JSON.stringify({ role: 'ROLE_USER', parts: [{ text: 'inner content 😀' }] });
  assert.equal(formatLegacyMemoryEntries([entry]), '[1] inner content 😀');
});

test('JSON entry with parts[0].text falsy (empty string, 0, false, null) falls back to original entry', () => {
  for (const falsyText of ['', 0, false, null]) {
    const entry = JSON.stringify({ parts: [{ text: falsyText }] });
    assert.equal(formatLegacyMemoryEntries([entry]), `[1] ${entry}`, `falsy text: ${JSON.stringify(falsyText)}`);
  }
});

test('JSON entry with parts being empty array (Python falsy) retains original', () => {
  const entry = JSON.stringify({ parts: [] });
  assert.equal(formatLegacyMemoryEntries([entry]), `[1] ${entry}`);
});

test('JSON entry with parts being empty object (not array) retains original', () => {
  const entry = JSON.stringify({ parts: {} });
  assert.equal(formatLegacyMemoryEntries([entry]), `[1] ${entry}`);
});

test('JSON entry with parts[0] not object retains original', () => {
  const entry = JSON.stringify({ parts: ['plain-string'] });
  assert.equal(formatLegacyMemoryEntries([entry]), `[1] ${entry}`);
});

test('JSON entry without parts retains original', () => {
  const entry = JSON.stringify({ role: 'user', content: 'no parts field' });
  assert.equal(formatLegacyMemoryEntries([entry]), `[1] ${entry}`);
});

test('non-JSON string entry is retained as-is', () => {
  assert.equal(formatLegacyMemoryEntries(['plain text {not json']), '[1] plain text {not json');
});

test('multiple entries mix JSON and plain, preserving order', () => {
  const entries = ['plain', JSON.stringify({ parts: [{ text: 'json-text' }] }), 'another plain'];
  assert.equal(formatLegacyMemoryEntries(entries), '[1] plain\n\n[2] json-text\n\n[3] another plain');
});

test('rejects non-array input', () => {
  assert.throws(() => formatLegacyMemoryEntries('not-array'), { code: 'legacy_memory_entries_invalid' });
  assert.throws(() => formatLegacyMemoryEntries(null), { code: 'legacy_memory_entries_invalid' });
  assert.throws(() => formatLegacyMemoryEntries({}), { code: 'legacy_memory_entries_invalid' });
});

test('rejects non-string entries', () => {
  assert.throws(() => formatLegacyMemoryEntries([123]), { code: 'legacy_memory_entries_invalid' });
  assert.throws(() => formatLegacyMemoryEntries([null]), { code: 'legacy_memory_entries_invalid' });
  assert.throws(() => formatLegacyMemoryEntries([{}]), { code: 'legacy_memory_entries_invalid' });
  assert.throws(() => formatLegacyMemoryEntries(['ok', 42]), { code: 'legacy_memory_entries_invalid' });
});

test('Unicode content is preserved', () => {
  const entry = JSON.stringify({ parts: [{ text: '中文记忆 😀 世界' }] });
  assert.equal(formatLegacyMemoryEntries([entry]), '[1] 中文记忆 😀 世界');
});

test('parts[0].text boolean true produces Python str(True) = "True"', () => {
  const entry = JSON.stringify({ parts: [{ text: true }] });
  assert.equal(formatLegacyMemoryEntries([entry]), '[1] True');
});

test('parts[0].text boolean false falls back to original (Python falsy)', () => {
  const entry = JSON.stringify({ parts: [{ text: false }] });
  assert.equal(formatLegacyMemoryEntries([entry]), `[1] ${entry}`);
});

test('parts[0].text number produces Python str(number)', () => {
  const entry = JSON.stringify({ parts: [{ text: 42 }] });
  assert.equal(formatLegacyMemoryEntries([entry]), '[1] 42');
  const entry2 = JSON.stringify({ parts: [{ text: 3.14 }] });
  assert.equal(formatLegacyMemoryEntries([entry2]), '[1] 3.14');
});

test('parts[0].text object/array is rejected as malformed non-string text', () => {
  assert.throws(() => formatLegacyMemoryEntries([JSON.stringify({ parts: [{ text: { nested: true } }] })]),
    { code: 'legacy_memory_entries_invalid' });
  assert.throws(() => formatLegacyMemoryEntries([JSON.stringify({ parts: [{ text: [1, 2] }] })]),
    { code: 'legacy_memory_entries_invalid' });
});

// ---- parseLegacySdkMemoryEntries -------------------------------------------

test('format 1: top-level Memories array of strings', () => {
  assert.deepEqual(parseLegacySdkMemoryEntries({ Memories: ['hello', 'world'] }), ['hello', 'world']);
});

test('format 1: Memories with dict items extracts Content/Text/Memory/Data', () => {
  const payload = { Memories: [{ Content: 'c1' }, { Text: 't1' }, { Memory: 'm1' }, { Data: 'd1' }] };
  assert.deepEqual(parseLegacySdkMemoryEntries(payload), ['c1', 't1', 'm1', 'd1']);
});

test('format 1: dict item with no text fields falls back to JSON.stringify (Python json.dumps)', () => {
  const item = { Unknown: 'field' };
  assert.deepEqual(parseLegacySdkMemoryEntries({ Memories: [item] }), [JSON.stringify(item)]);
});

test('format 1: dict item with object/array text value JSON-stringifies it', () => {
  assert.deepEqual(parseLegacySdkMemoryEntries({ Memories: [{ Content: { nested: true } }] }), ['{"nested":true}']);
  assert.deepEqual(parseLegacySdkMemoryEntries({ Memories: [{ Content: [1, 2] }] }), ['[1,2]']);
});

// ---- Python truthy OR counterexamples for all three envelopes ----

test('format 1: Content:"" (falsy) falls through to Text', () => {
  assert.deepEqual(parseLegacySdkMemoryEntries({ Memories: [{ Content: '', Text: 'fact' }] }), ['fact']);
});

test('format 1: Content:0 (falsy) falls through to Text', () => {
  assert.deepEqual(parseLegacySdkMemoryEntries({ Memories: [{ Content: 0, Text: 'fact' }] }), ['fact']);
});

test('format 1: Content:false (falsy) falls through to Text', () => {
  assert.deepEqual(parseLegacySdkMemoryEntries({ Memories: [{ Content: false, Text: 'fact' }] }), ['fact']);
});

test('format 1: Content:[] (Python falsy, JS truthy) falls through to Text', () => {
  assert.deepEqual(parseLegacySdkMemoryEntries({ Memories: [{ Content: [], Text: 'fact' }] }), ['fact']);
});

test('format 1: Content:{} (Python falsy, JS truthy) falls through to Text', () => {
  assert.deepEqual(parseLegacySdkMemoryEntries({ Memories: [{ Content: {}, Text: 'fact' }] }), ['fact']);
});

test('format 1: Content:"0" (truthy) stays "0"', () => {
  assert.deepEqual(parseLegacySdkMemoryEntries({ Memories: [{ Content: '0', Text: 'fact' }] }), ['0']);
});

test('format 1: all fields falsy falls through to json.dumps(item)', () => {
  const item = { Content: '', Text: 0, Memory: false, Data: [], Extra: 'x' };
  assert.deepEqual(parseLegacySdkMemoryEntries({ Memories: [item] }), [JSON.stringify(item)]);
});

test('format 1: Content:true (truthy) produces pythonStr "True"', () => {
  assert.deepEqual(parseLegacySdkMemoryEntries({ Memories: [{ Content: true }] }), ['True']);
});

test('format 1: Content:42 (truthy) produces "42"', () => {
  assert.deepEqual(parseLegacySdkMemoryEntries({ Memories: [{ Content: 42 }] }), ['42']);
});

test('format 2: Content:"" (falsy) falls through to Text in _parse_memory_item', () => {
  assert.deepEqual(parseLegacySdkMemoryEntries({ Data: [{ Content: '', Text: 'fact' }] }), ['fact']);
});

test('format 2: Content:[] (Python falsy) falls through to Text', () => {
  assert.deepEqual(parseLegacySdkMemoryEntries({ Data: [{ Content: [], Text: 'fact' }] }), ['fact']);
});

test('format 2: Content:{} (Python falsy) falls through to Text', () => {
  assert.deepEqual(parseLegacySdkMemoryEntries({ Data: [{ Content: {}, Text: 'fact' }] }), ['fact']);
});

test('format 2: all text fields falsy but Data:[] (last operand) returns json.dumps([])', () => {
  // Python `or` returns the last operand as-is when all are falsy. Data:[] is
  // a list → isinstance check → json.dumps([]) → "[]". Not None, so not [].
  assert.deepEqual(parseLegacySdkMemoryEntries({ Data: [{ Content: '', Text: 0, Memory: false, Data: [] }] }), ['[]']);
});

test('format 2: all fields missing (undefined) throws (strict, Python returns [])', () => {
  assert.throws(() => parseLegacySdkMemoryEntries({ Data: [{ Unknown: 'x' }] }),
    { code: 'legacy_memory_response_invalid' });
});

test('format 2: Content:true produces pythonStr "True"', () => {
  assert.deepEqual(parseLegacySdkMemoryEntries({ Data: [{ Content: true }] }), ['True']);
});

test('format 3: Content:"" (falsy) falls through to Text', () => {
  assert.deepEqual(parseLegacySdkMemoryEntries({ Results: [{ Content: '', Text: 'fact' }] }), ['fact']);
});

test('format 3: Content:[] (Python falsy) falls through to Text', () => {
  assert.deepEqual(parseLegacySdkMemoryEntries({ Results: [{ Content: [], Text: 'fact' }] }), ['fact']);
});

test('format 3: Content:{} (Python falsy) falls through to Text', () => {
  assert.deepEqual(parseLegacySdkMemoryEntries({ Results: [{ Content: {}, Text: 'fact' }] }), ['fact']);
});

test('format 3: all fields falsy falls through to json.dumps(item)', () => {
  const item = { Content: '', Text: false, Memory: 0, Extra: 'x' };
  assert.deepEqual(parseLegacySdkMemoryEntries({ Results: [item] }), [JSON.stringify(item)]);
});

test('format 3: Content:true produces pythonStr "True"', () => {
  assert.deepEqual(parseLegacySdkMemoryEntries({ Results: [{ Content: true }] }), ['True']);
});

// ---- format 2 nested Memories ----

test('format 2: Data array with nested Memories', () => {
  const payload = { Data: [{ Memories: ['nested-1', 'nested-2'] }, { Memories: ['nested-3'] }] };
  assert.deepEqual(parseLegacySdkMemoryEntries(payload), ['nested-1', 'nested-2', 'nested-3']);
});

test('format 2: Data array with string items', () => {
  assert.deepEqual(parseLegacySdkMemoryEntries({ Data: ['plain-1', 'plain-2'] }), ['plain-1', 'plain-2']);
});

test('format 2: deeply nested Memories recursion', () => {
  assert.deepEqual(parseLegacySdkMemoryEntries({ Data: [{ Memories: [{ Memories: ['deep'] }] }] }), ['deep']);
});

// ---- format 3 ----

test('format 3: Results array of strings', () => {
  assert.deepEqual(parseLegacySdkMemoryEntries({ Results: ['r1', 'r2'] }), ['r1', 'r2']);
});

test('format 3: dict item with no text falls back to JSON.stringify', () => {
  const item = { Foo: 'bar' };
  assert.deepEqual(parseLegacySdkMemoryEntries({ Results: [item] }), [JSON.stringify(item)]);
});

// ---- general ----

test('string payload is parsed as JSON', () => {
  assert.deepEqual(parseLegacySdkMemoryEntries('{"Memories":["from-string"]}'), ['from-string']);
});

test('empty Memories/Data/Results arrays yield [] (valid known envelopes)', () => {
  assert.deepEqual(parseLegacySdkMemoryEntries({ Memories: [] }), []);
  assert.deepEqual(parseLegacySdkMemoryEntries({ Data: [] }), []);
  assert.deepEqual(parseLegacySdkMemoryEntries({ Results: [] }), []);
});

test('ordering is preserved', () => {
  assert.deepEqual(parseLegacySdkMemoryEntries({ Memories: ['first', 'second', 'third'] }), ['first', 'second', 'third']);
});

test('Unicode content is preserved in parse', () => {
  assert.deepEqual(parseLegacySdkMemoryEntries({ Memories: ['记忆 😀 世界'] }), ['记忆 😀 世界']);
});

// ---- strict failure cases ----

test('malformed JSON string throws', () => {
  assert.throws(() => parseLegacySdkMemoryEntries('not json'), { code: 'legacy_memory_response_invalid' });
  assert.throws(() => parseLegacySdkMemoryEntries('{broken'), { code: 'legacy_memory_response_invalid' });
});

test('non-object JSON throws', () => {
  assert.throws(() => parseLegacySdkMemoryEntries('[]'), { code: 'legacy_memory_response_invalid' });
  assert.throws(() => parseLegacySdkMemoryEntries('"string"'), { code: 'legacy_memory_response_invalid' });
  assert.throws(() => parseLegacySdkMemoryEntries(42), { code: 'legacy_memory_response_invalid' });
  assert.throws(() => parseLegacySdkMemoryEntries(null), { code: 'legacy_memory_response_invalid' });
});

test('rejected Code throws', () => {
  assert.throws(() => parseLegacySdkMemoryEntries({ Code: 500, Memories: [] }), { code: 'legacy_memory_response_invalid' });
  assert.throws(() => parseLegacySdkMemoryEntries({ Code: true, Memories: [] }), { code: 'legacy_memory_response_invalid' });
  assert.throws(() => parseLegacySdkMemoryEntries({ Code: 'error', Memories: [] }), { code: 'legacy_memory_response_invalid' });
});

test('top-level Error throws', () => {
  assert.throws(() => parseLegacySdkMemoryEntries({ Error: { Message: 'service error' }, Memories: [] }), { code: 'legacy_memory_response_invalid' });
  assert.throws(() => parseLegacySdkMemoryEntries({ Error: 'failed', Memories: [] }), { code: 'legacy_memory_response_invalid' });
});

test('ResponseMetadata.Error throws', () => {
  assert.throws(() => parseLegacySdkMemoryEntries({ ResponseMetadata: { Error: 'metadata error' }, Memories: [] }), { code: 'legacy_memory_response_invalid' });
});

test('ResponseMetadata not object throws', () => {
  assert.throws(() => parseLegacySdkMemoryEntries({ ResponseMetadata: 'invalid', Memories: [] }), { code: 'legacy_memory_response_invalid' });
});

test('unrecognized envelope throws (not silent empty like Python)', () => {
  assert.throws(() => parseLegacySdkMemoryEntries({ Unknown: 'shape' }), { code: 'legacy_memory_response_invalid' });
  assert.throws(() => parseLegacySdkMemoryEntries({ Foo: [] }), { code: 'legacy_memory_response_invalid' });
  assert.throws(() => parseLegacySdkMemoryEntries({}), { code: 'legacy_memory_response_invalid' });
});

test('Memories not array throws', () => {
  assert.throws(() => parseLegacySdkMemoryEntries({ Memories: 'not-array' }), { code: 'legacy_memory_response_invalid' });
  assert.throws(() => parseLegacySdkMemoryEntries({ Memories: {} }), { code: 'legacy_memory_response_invalid' });
});

test('Results not array throws', () => {
  assert.throws(() => parseLegacySdkMemoryEntries({ Results: 'not-array' }), { code: 'legacy_memory_response_invalid' });
});

test('non-string non-object item in Memories throws', () => {
  assert.throws(() => parseLegacySdkMemoryEntries({ Memories: [123] }), { code: 'legacy_memory_response_invalid' });
  assert.throws(() => parseLegacySdkMemoryEntries({ Memories: [null] }), { code: 'legacy_memory_response_invalid' });
});

test('non-string non-object item in Results throws', () => {
  assert.throws(() => parseLegacySdkMemoryEntries({ Results: [42] }), { code: 'legacy_memory_response_invalid' });
});

test('non-string non-object item in Data throws', () => {
  assert.throws(() => parseLegacySdkMemoryEntries({ Data: [true] }), { code: 'legacy_memory_response_invalid' });
});

test('accepted Code values do not throw', () => {
  assert.deepEqual(parseLegacySdkMemoryEntries({ Code: 0, Memories: ['ok'] }), ['ok']);
  assert.deepEqual(parseLegacySdkMemoryEntries({ Code: 200, Memories: ['ok'] }), ['ok']);
  assert.deepEqual(parseLegacySdkMemoryEntries({ Code: '0', Memories: ['ok'] }), ['ok']);
  assert.deepEqual(parseLegacySdkMemoryEntries({ Code: '200', Memories: ['ok'] }), ['ok']);
});

test('Data is a non-array value does not match format 2 and falls through', () => {
  assert.throws(() => parseLegacySdkMemoryEntries({ Data: { not: 'array' } }), { code: 'legacy_memory_response_invalid' });
});
