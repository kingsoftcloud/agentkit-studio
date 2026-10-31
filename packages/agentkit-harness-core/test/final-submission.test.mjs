import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeKernel, MemoryRunStore, emptyUsage, normalizedFinalText, parseModelJson } from '../dist/index.mjs';
import { fixture, scope, digest, tool } from './fixtures.mjs';

const schema = { type: 'object', properties: { answer: { type: 'object', properties: { value: { type: 'integer' } },
  required: ['value'], additionalProperties: false } }, required: ['answer'], additionalProperties: false };
const submission = (arguments_, callId = 'submission') => ({ callId, name: 'submit_final_output', arguments: arguments_ });
const response = (calls, text = '') => ({ kind: calls ? 'tool_calls' : 'final_candidate', text, toolCalls: calls ?? [], usage: emptyUsage() });
async function run(configuration, generate, execute = async () => { throw Error('Unexpected external tool dispatch'); }, ports = {}) {
  const store = new MemoryRunStore();
  const kernel = new NativeKernel({ store, ports: { model: { generate }, tools: { execute }, ...ports }, owner: 'submission-test', digest });
  const { config, snapshot } = fixture(configuration); kernel.start(snapshot, config);
  return { result: await kernel.runUntilIdle(scope, 'run'), record: store.load(scope, 'run') };
}
const contract = (overrides = {}) => ({ objective: 'Return the requested answer', finalSubmissionSchema: schema,
  finalSubmissionPayloadKey: 'answer', finalOutputFormat: 'json_object', ...overrides });

test('internal submission remains available in finalization reserve without a tool budget or external dispatch', async () => {
  const { result, record } = await run({ contract: contract(), tools: [tool()], limits: { maxModelCalls: 1, maxToolCalls: 0 } }, async request => {
    assert.deepEqual(request.tools.map(tool => tool.name), ['submit_final_output']);
    return response([submission({ answer: { value: 42 } })]);
  });
  assert.equal(result.phase, 'completed'); assert.equal(result.finalText, '{"value":42}');
  assert.equal(result.usage.toolCalls, 0); assert.equal(result.usage.modelCalls, 1);
  assert.equal(record.intents.filter(intent => intent.kind === 'tool').length, 0);
  assert.equal(result.messages.at(-1).role, 'tool');
  assert.equal(JSON.parse(result.messages.at(-1).content).status, 'accepted');
});

test('invalid schema arguments are refused before a corrected submission can be accepted', async () => {
  let models = 0;
  const { result } = await run({ contract: contract() }, async request => {
    if (++models === 1) return response([submission({ answer: { value: '42', injected: true } })]);
    assert.equal(JSON.parse(request.messages.at(-1).content).status, 'not_dispatched');
    return response([submission({ answer: { value: 42 } }, 'corrected')]);
  });
  assert.equal(result.phase, 'completed'); assert.equal(result.finalText, '{"value":42}'); assert.equal(models, 2);
});

test('a mixed final submission and workspace write seals every call without executing either', async () => {
  let writes = 0;
  const { result } = await run({ contract: contract(), tools: [tool({ name: 'write', readOnly: false, concurrentSafe: false })],
    profile: { ...fixture().config.profile, maxRetries: 0 } }, async () => response([
    submission({ answer: { value: 42 } }), { callId: 'write', name: 'write', arguments: { text: 'must not execute' } },
  ]), async () => { writes++; return { status: 'ok', content: 'written' }; });
  assert.equal(writes, 0); assert.equal(result.reason, 'final_submission_retry_exhausted'); assert.equal(result.usage.toolCalls, 0);
  const receipts = result.messages.filter(message => message.role === 'tool');
  assert.deepEqual(receipts.map(message => message.callId), ['submission', 'write']);
  assert.ok(receipts.every(message => JSON.parse(message.content).status === 'not_dispatched'));
});

test('an ordinary final draft stays private and can be resubmitted through the required envelope', async () => {
  let models = 0;
  const { result, record } = await run({ contract: contract() }, async request => {
    if (++models === 1) return response(null, 'Rejected draft containing private reasoning');
    assert.equal(request.messages.at(-2).kind, 'unstructured_final_draft');
    assert.equal(request.messages.at(-2).content, 'Rejected draft containing private reasoning');
    assert.equal(request.messages.at(-1).kind, 'final_submission_required');
    return response([submission({ answer: { value: 42 } })]);
  });
  assert.equal(result.finalText, '{"value":42}');
  assert.doesNotMatch(JSON.stringify(record.events), /Rejected draft/);
});

test('repeated ordinary text cannot satisfy a pinned submission contract', async () => {
  const { result } = await run({ contract: contract(), profile: { ...fixture().config.profile, maxRetries: 1 } }, async () => response(null, 'Done'));
  assert.equal(result.phase, 'failed'); assert.equal(result.reason, 'final_submission_missing');
  assert.equal(result.usage.modelCalls, 2); assert.equal(result.candidate, null);
});

test('scalar, array, string, and null payloads preserve their declared output type', async t => {
  for (const [type, payload, format, text] of [
    ['string', 'Hello', 'text', 'Hello'], ['integer', 0, 'json_value', '0'], ['boolean', false, 'json_value', 'false'],
    ['array', [1, 'two'], 'json_value', '[1,"two"]'], ['null', null, 'json_value', 'null'],
  ]) await t.test(type, async () => {
    const { result } = await run({ contract: contract({ finalSubmissionSchema: { type: 'object', properties: { answer: { type } }, required: ['answer'] },
      finalOutputFormat: format }) }, async () => response([submission({ answer: payload })]));
    assert.equal(result.finalText, text); assert.equal(result.phase, 'completed');
  });
});

test('Draft 2020-12 constraints are enforced without coercion or schema-global identity collisions', async () => {
  const constrained = { ...schema, $id: 'urn:native:result', properties: { answer: { type: 'object', properties: {
    mode: { enum: ['count', 'text'] }, value: {}, tag: { type: 'string', pattern: '^ok-' },
  }, required: ['mode', 'value', 'tag'], additionalProperties: false,
  if: { properties: { mode: { const: 'count' } } }, then: { properties: { value: { type: 'integer', minimum: 1 } } },
  else: { properties: { value: { type: 'string', minLength: 2 } } } } } };
  let models = 0;
  const { result } = await run({ contract: contract({ finalSubmissionSchema: constrained }) }, async () => {
    return response([submission({ answer: ++models === 1 ? { mode: 'count', value: '2', tag: 'ok-tag' }
      : { mode: 'text', value: 'done', tag: 'ok-tag' } }, `call-${models}`)]);
  });
  assert.equal(models, 2); assert.equal(result.finalText, '{"mode":"text","tag":"ok-tag","value":"done"}');
  assert.doesNotThrow(() => fixture({ contract: contract({ finalSubmissionSchema: { ...schema, $id: 'urn:native:result' } }) }));
});

test('submission schemas reject remote references, ambiguous payloads, excess depth, and escaped-size overflow', () => {
  const invalid = [
    contract({ finalSubmissionSchema: { type: 'object', properties: { answer: { $ref: 'https://invalid.example/schema' } } } }),
    contract({ finalSubmissionSchema: { type: 'object', properties: { answer: { type: ['string', 'null'] } }, required: ['answer'] } }),
    contract({ finalSubmissionSchema: { type: 'object', properties: { answer: { type: 'object' } } } }),
    contract({ finalSubmissionSchema: { type: 'object', required: ['answer'] } }),
    contract({ finalSubmissionSchema: { ...schema, description: '汉'.repeat(2800) } }),
    contract({ finalOutputFormat: 'text' }),
  ];
  let nested = { type: 'object' }; for (let index = 0; index < 34; index++) nested = { type: 'object', properties: { next: nested } };
  invalid.push(contract({ finalSubmissionSchema: nested, finalSubmissionPayloadKey: null }));
  for (const value of invalid) assert.throws(() => fixture({ contract: value }), /invalid_final_submission|final_submission_format_mismatch/);
});

test('normalization unwraps only one complete JSON fence and leaves ambiguous output to verification', async () => {
  const malformed = ['```json\n{"x":1,"x":2}\n```', '```json\n{"x":1e400}\n```', '```js\n{"x":1}\n```', '```json\n{"x":1}', '[1]', 'Summary: {"x":1}'];
  assert.equal(normalizedFinalText('```json\n{ "x": 1 }\n```', 'json_object'), '{ "x": 1 }');
  assert.equal(normalizedFinalText('```\n[1]\n```', 'json_value'), '[1]');
  assert.equal(normalizedFinalText('  {"x":1}  ', 'text'), '  {"x":1}  ');
  for (const text of malformed) assert.equal(normalizedFinalText(text, 'json_object'), text);
  let candidate;
  const { result } = await run({ contract: { objective: 'Return JSON', finalOutputFormat: 'json_object' } }, async () => response(null, malformed[0]), undefined,
    { verification: { verify: async request => { candidate = request.candidate.text; return { status: 'unverified', reason: 'invalid_json' }; } } });
  assert.equal(candidate, malformed[0]); assert.equal(result.usage.modelCalls, 1);
});

test('strict model JSON rejects escaped duplicate keys, non-finite numbers and trailing data', () => {
  for (const text of ['{"x":1,"\\u0078":2}', '{"a":{"b":1,"b":2}}', '1e400', 'NaN', '[1,]', '01', 'true false']) {
    assert.throws(() => parseModelJson(text));
  }
  const value = parseModelJson('{"__proto__":{"safe":true},"a":[null,-1.2e-2,true,"\\\"hi"]}');
  assert.equal(value.__proto__.safe, true); assert.equal(Object.getPrototypeOf(value), null);
});

test('invented tool names terminate on the invalid-response limit without an unlimited model loop', async () => {
  const { result } = await run({ profile: { ...fixture().config.profile, maxRetries: 1 } }, async () => response([
    { callId: 'invented', name: 'not_bound', arguments: {} },
  ]));
  assert.equal(result.reason, 'tool_call_not_advertised_retry_exhausted'); assert.equal(result.outcome, 'blocked');
  assert.equal(result.usage.modelCalls, 2); assert.equal(result.usage.toolCalls, 0);
});
