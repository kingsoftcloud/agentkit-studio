import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeKernel, MemoryRunStore, canonical, copy, parseModelJson, parseNativeJson, stringifyModelJson,
  compileToolInput, emptyUsage, submittedFinalText } from '../dist/index.mjs';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { fixture, scope, digest, tool } from './fixtures.mjs';

const integer = 9007199254740993n;
test('integer tokens survive parsing, detached copies and JSON wire output without wrapper authority', () => {
  const text = '{"id":9007199254740993,"n":-9007199254740995,"nested":[9007199254740997]}';
  const parsed = parseModelJson(text);
  assert.equal(parsed.id, integer); assert.equal(parsed.n, -9007199254740995n);
  assert.equal(copy(parsed).nested[0], 9007199254740997n);
  assert.equal(parseNativeJson(canonical(parsed)).id, integer);
  assert.equal(stringifyModelJson(parsed), text);
  assert.equal(stringifyModelJson({ x: integer, omitted: undefined }), '{"x":9007199254740993}');
  assert.equal(typeof parseModelJson('9007199254740993.0'), 'number'); // Python float semantics.
  assert.equal(typeof parseModelJson('1e20'), 'number');
  const largeFloat = parseModelJson('1000000000000000100.0');
  assert.equal(typeof copy(largeFloat), 'number'); assert.equal(copy(largeFloat), largeFloat);
  assert.equal(typeof parseModelJson(stringifyModelJson(largeFloat)), 'number');
  assert.equal(parseModelJson(stringifyModelJson(largeFloat)), largeFloat);
  assert.equal(Object.is(copy(parseModelJson('-0.0')), -0), true);
  assert.equal(stringifyModelJson(parseModelJson('-0.0')), '-0.0');
  assert.equal(Object.is(parseModelJson('-0'), -0), false);
  assert.equal(parseModelJson('42'), 42); assert.equal(parseModelJson('0.1'), 0.1);
  assert.deepEqual(copy(parseModelJson('{"__proto__":{"n":9007199254740993}}')).__proto__, { n: integer });
  assert.equal(Object.getPrototypeOf(copy(parsed)), Object.prototype);
  assert.equal(compileToolInput({ type: 'integer' })(parseModelJson('{"$number":"9007199254740993"}')), false);
  assert.throws(() => parseModelJson('{"n":9007199254740993,"n":1}'), /duplicate_model_json_key/);
  assert.throws(() => parseModelJson('1e309'), /non_finite_model_json_number/);
  assert.equal(typeof parseModelJson('9'.repeat(4300)), 'bigint');
  assert.throws(() => parseModelJson('9'.repeat(4301)), /integer_digits_exceeded/);
  const nested = parseModelJson('['.repeat(256) + integer + ']'.repeat(256));
  assert.equal(canonical(copy({ record: { snapshot: { arguments: nested } } })), canonical({ record: { snapshot: { arguments: nested } } }));
});

test('exact bounds, composition, equality, arrays and local references never validate a rounded proxy', () => {
  const validate = compileToolInput(parseModelJson('{"type":"integer","minimum":9007199254740993,"maximum":9007199254740995}'));
  assert.equal(validate(integer), true); assert.equal(validate(integer - 1n), false); assert.equal(validate(integer + 3n), false);
  assert.equal(compileToolInput({ type: 'integer', maximum: 9007199254740992 })(integer), false);
  assert.equal(compileToolInput({ type: 'integer', exclusiveMinimum: 9007199254740992 })(integer), true);
  const compound = compileToolInput({ $id: 'urn:native:exact-number-schema', type: 'object',
    $defs: { id: { type: 'integer', minimum: integer, multipleOf: 3 } },
    properties: { id: { $ref: '#/$defs/id' }, values: { type: 'array', uniqueItems: true },
      choice: { oneOf: [{ const: integer }, { type: 'string' }] } }, required: ['id', 'values', 'choice'], additionalProperties: false });
  assert.equal(compound({ id: integer, values: [integer, integer + 1n], choice: integer }), true);
  assert.equal(compound({ id: integer + 1n, values: [], choice: integer }), false);
  assert.equal(compound({ id: integer, values: [integer, integer], choice: integer }), false);
  assert.equal(compound({ id: integer, values: [], choice: integer + 1n }), false);
  const decimal = compileToolInput({ type: 'integer', multipleOf: 0.1 });
  assert.equal(decimal(integer), true);
  assert.equal(compileToolInput({ enum: [{ value: integer }] })({ value: integer }), true);
  assert.equal(compileToolInput({ enum: [{ value: integer }] })({ value: integer - 1n }), false);
  assert.equal(compileToolInput({ type: 'array', uniqueItems: true })([9007199254740992, 9007199254740992n, integer]), false);
  assert.equal(compileToolInput({ type: 'object', propertyNames: { enum: ['id'] } })({ id: integer }), true);
  assert.equal(compileToolInput({ type: 'object', propertyNames: { enum: ['id'] } })({ other: integer }), false);
  assert.equal(compileToolInput({ type: 'array', maxItems: integer })([1, 2]), true);
  assert.equal(compileToolInput({ type: 'array', minItems: integer })([1, 2]), false);
  assert.equal(compileToolInput({ type: 'string', minLength: integer })('abc'), false);
  assert.equal(compileToolInput({ type: 'object', maxProperties: integer })({ id: integer }), true);
  assert.equal(compileToolInput({ type: 'array', contains: { type: 'integer' }, minContains: integer })([integer]), false);
  assert.equal(compileToolInput({ enum: [] })(integer), false);
  assert.equal(compileToolInput({ allOf: [{ const: integer }, { enum: [] }] })(integer), false);
  for (const bad of [{ minimum: 'bad', const: integer }, { multipleOf: 0, const: integer },
    { uniqueItems: 'bad', const: integer }, { agentkitExactIntegerV1: {} }]) assert.throws(() => compileToolInput(bad));
});

for (const version of ['04', '06', '07']) test(`draft ${version} numeric bounds retain exact integers and reference-sibling semantics`, () => {
  const schema = { $schema: `http://json-schema.org/draft-${version}/schema#`, definitions: { value: { type: 'integer', minimum: integer } },
    type: 'object', properties: { id: { $ref: '#/definitions/value', type: 'string', maximum: integer - 1n } } };
  const validate = compileToolInput(schema);
  assert.equal(validate({ id: integer }), true); assert.equal(validate({ id: integer - 1n }), false);
  assert.throws(() => compileToolInput({ $schema: schema.$schema, enum: [integer, integer] }));
  assert.equal(compileToolInput({ $schema: schema.$schema, type: 'integer', minimum: integer, minContains: -integer })(integer), true);
  if (version !== '07') assert.equal(compileToolInput({ $schema: schema.$schema, type: 'integer', minimum: integer,
    if: { minimum: 'Ignored annotation in this older draft' } })(integer), true);
  if (version === '04') {
    const exclusive = compileToolInput({ $schema: schema.$schema, minimum: integer, exclusiveMinimum: true });
    assert.equal(exclusive(integer), false); assert.equal(exclusive(integer + 1n), true);
  }
});

test('structured final output accepts exact integers and enforces the true bound', () => {
  const { config } = fixture({ contract: { objective: 'Return the id', finalOutputFormat: 'json_value', finalSubmissionPayloadKey: 'output',
    finalSubmissionSchema: { type: 'object', properties: { output: { type: 'integer', minimum: integer, maximum: integer } }, required: ['output'] } } });
  const call = { callId: 'final', name: 'submit_final_output', arguments: { output: integer } };
  assert.equal(submittedFinalText(call, config), '9007199254740993');
  assert.equal(submittedFinalText({ ...call, arguments: { output: integer - 1n } }, config), null);
});

for (const backend of ['memory', 'sqlite']) test(`${backend}: exact integers cross a committed tool receipt, reopen and final submission`, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'native-exact-integer-')), filename = join(directory, 'runs.sqlite');
  let store = backend === 'sqlite' ? new SqliteRunStore(filename) : new MemoryRunStore();
  t.after(() => { store.close?.(); rmSync(directory, { recursive: true, force: true }); });
  const { config, snapshot } = fixture({ tools: [tool({ parameters: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } })],
    contract: { objective: 'Return the same exact id', finalOutputFormat: 'json_value', finalSubmissionPayloadKey: 'output',
      finalSubmissionSchema: { type: 'object', properties: { output: { type: 'integer', const: integer } }, required: ['output'] } } });
  let models = 0, executions = 0;
  const stop = new Error('Persisted receipt');
  const ports = { model: { generate: async request => {
    models++;
    const call = models === 1 ? { callId: 'read', name: 'read', arguments: parseModelJson('{"id":9007199254740993}') }
      : { callId: 'final', name: 'submit_final_output', arguments: { output: integer } };
    if (models > 1) assert.equal(parseModelJson(request.messages.find(message => message.role === 'tool').content).id, integer);
    return { kind: 'tool_calls', text: '', toolCalls: [call], usage: emptyUsage() };
  } }, tools: { execute: async request => {
    executions++; assert.equal(request.call.arguments.id, integer);
    return { status: 'ok', content: { id: request.call.arguments.id } };
  } } };
  const before = new NativeKernel({ store, ports, digest, owner: 'before', onCheckpoint: async view => {
    if (view.messages.some(message => message.role === 'tool')) throw stop;
  } });
  before.start(snapshot, config); await assert.rejects(before.runUntilIdle(scope, 'run'), error => error === stop);
  assert.equal(store.load(scope, 'run').snapshot.messages[1].toolCalls[0].arguments.id, integer);
  if (backend === 'sqlite') { store.close(); store = new SqliteRunStore(filename); }
  const after = new NativeKernel({ store, ports, digest, owner: 'after' });
  const final = await after.runUntilIdle(scope, 'run');
  assert.equal(final.finalText, '9007199254740993'); assert.equal(executions, 1); assert.equal(models, 2);
  assert.equal(store.load(scope, 'run').receipts.find(receipt => receipt.result.results)?.result.results[0].content.id, integer);
});

test('a replacement Node process retains exact integers after receipt commit and never repeats the tool', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'native-integer-process-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('./fixtures/exact-integer-worker.mjs', import.meta.url)), directory],
    { encoding: 'utf8', env: { ...process.env, PATH: '/no-programs' } });
  assert.equal(child.status, 83, child.stderr);
  const store = new SqliteRunStore(join(directory, 'runs.sqlite')); t.after(() => store.close());
  const record = store.load(scope, 'run');
  assert.equal(record.snapshot.messages[1].toolCalls[0].arguments.id, integer);
  assert.equal(record.receipts.find(receipt => receipt.result.results).result.results[0].content.id, integer);
  let models = 0;
  const replacement = new NativeKernel({ store, digest, owner: 'replacement', now: () => 1000,
    ports: { model: { generate: async request => {
      models++; assert.equal(parseModelJson(request.messages.find(message => message.role === 'tool').content).id, integer);
      return { kind: 'tool_calls', text: '', toolCalls: [{ callId: 'final', name: 'submit_final_output', arguments: { output: integer } }], usage: emptyUsage() };
    } }, tools: { execute: async () => assert.fail('Committed tool must not be replayed') } } });
  const result = await replacement.runUntilIdle(scope, 'run');
  assert.equal(result.finalText, '9007199254740993'); assert.equal(models, 1);
  assert.equal(readFileSync(join(directory, 'effects.txt'), 'utf8'), '{"id":9007199254740993}\n');
});
