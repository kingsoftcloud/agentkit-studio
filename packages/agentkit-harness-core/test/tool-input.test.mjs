import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeKernel, MemoryRunStore, emptyUsage, toolInputRejection, compileToolInput, addUsage } from '../dist/index.mjs';
import { fixture, scope, digest, tool } from './fixtures.mjs';

const result = (calls = [], options = {}) => ({ kind: calls.length ? 'tool_calls' : 'final_candidate', text: calls.length ? '' : 'Done',
  toolCalls: calls, usage: emptyUsage(), ...options });
const call = (arguments_, overrides = {}) => ({ callId: 'call', name: 'read', arguments: arguments_, ...overrides });
async function run({ configuration = {}, model, execute } = {}) {
  const store = new MemoryRunStore();
  const { config, snapshot } = fixture({ tools: [tool()], ...configuration });
  const kernel = new NativeKernel({ store, owner: 'validator-test', digest,
    ports: { model: { generate: model }, tools: { execute: execute ?? (async () => { throw Error('Must not dispatch'); }) } } });
  kernel.start(snapshot, config); return { snapshot: await kernel.runUntilIdle(scope, 'run'), store };
}

test('a sealed call with undecodable wire arguments never reaches a permissive external tool', async () => {
  let models = 0, executions = 0;
  const { snapshot, store } = await run({ model: async request => {
    if (++models === 1) return result([call({}, { wireArgumentsInvalid: true })]);
    assert.equal(JSON.parse(request.messages.at(-1).content).reason, 'wire_arguments_invalid'); return result();
  }, execute: async () => { executions++; return { status: 'ok', content: 'unsafe' }; } });
  assert.equal(executions, 0); assert.equal(snapshot.usage.toolCalls, 1); assert.equal(snapshot.phase, 'completed');
  const receipt = store.load(scope, 'run').receipts.find(receipt => receipt.result.results);
  assert.equal(receipt.result.results[0].status, 'error'); assert.equal(receipt.result.results[0].content.executed, false);
});

test('required fields, nested constraints, formats and local refs validate before any authorization callback', async () => {
  const definition = tool({ parameters: { type: 'object', $defs: { count: { type: 'integer', minimum: 1 } }, properties: {
    count: { $ref: '#/$defs/count' }, email: { type: 'string', format: 'email' }, code: { type: 'string', pattern: '^ok-' },
  }, required: ['count', 'email', 'code'], additionalProperties: false } });
  let models = 0, callbacks = 0;
  const { snapshot } = await run({ configuration: { tools: [definition] }, model: async request => {
    if (++models === 1) return result([call({ count: '1', email: 'not-an-email', code: 'bad', extra: true })]);
    const error = JSON.parse(request.messages.at(-1).content);
    assert.equal(error.code, 'invalid_arguments'); assert.equal(error.executed, false);
    assert.deepEqual(new Set(error.errors.map(error => error.keyword)), new Set(['additionalProperties', 'type', 'format', 'pattern']));
    return result();
  }, execute: async () => { callbacks++; return { status: 'ok', content: '' }; } });
  assert.equal(callbacks, 0); assert.equal(snapshot.usage.toolCalls, 1);
});

test('a valid call retains exact admitted arguments without inserting defaults or coercing values', async () => {
  const definition = tool({ parameters: { type: 'object', properties: { count: { type: 'integer' }, optional: { type: 'string', default: 'no insertion' } }, required: ['count'] } });
  let models = 0, received;
  const { snapshot } = await run({ configuration: { tools: [definition] }, model: async () => ++models === 1 ? result([call({ count: 2 })]) : result(),
    execute: async request => { received = request.call.arguments; return { status: 'ok', content: 'safe' }; } });
  assert.deepEqual(received, { count: 2 }); assert.equal(snapshot.usage.toolCalls, 1);
});

test('a read-only batch can return an argument error alongside a separately valid read without dispatching invalid input', async () => {
  let models = 0; const executed = [];
  const { snapshot } = await run({ configuration: { tools: [tool({ parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } })] },
    model: async () => ++models === 1 ? result([call({}, { callId: 'bad' }), call({ path: 'one.txt' }, { callId: 'good' })]) : result(),
    execute: async request => { executed.push(request.call.callId); return { status: 'ok', content: 'contents' }; } });
  assert.deepEqual(executed, ['good']); assert.equal(snapshot.usage.toolCalls, 2);
  assert.deepEqual(snapshot.messages.filter(message => message.role === 'tool').map(message => message.callId), ['bad', 'good']);
});

test('pinned schemas cannot resolve external references or run asynchronous schema callbacks', () => {
  for (const parameters of [{ type: 'object', properties: { x: { $ref: 'https://example.invalid/schema' } } }, { type: 'object', $async: true }]) {
    assert.throws(() => fixture({ tools: [tool({ parameters })] }), /external_tool_schema_reference|asynchronous_tool_schema/);
  }
});

test('schema cache detaches producer-owned data and keeps independent schemas with the same id', () => {
  const parameters = { $id: 'urn:native:tool-input-test', type: 'object', properties: { mode: { enum: ['safe'] } }, required: ['mode'] };
  const definition = tool({ parameters }); compileToolInput(parameters); parameters.properties.mode.enum.push('unsafe');
  const pinned = tool({ parameters: { ...parameters, properties: { mode: { enum: ['safe'] } } } });
  assert.equal(toolInputRejection(pinned, call({ mode: 'unsafe' })).code, 'invalid_arguments');
  assert.equal(toolInputRejection(definition, call({ mode: 'unsafe' })), null);
  assert.equal(toolInputRejection(tool({ parameters: { ...parameters, properties: { mode: { type: 'integer' } } } }), call({ mode: 1 })), null);
});

test('explicit Draft 7 and Draft 2019 tool schemas retain their own validation semantics', () => {
  for (const dialect of ['http://json-schema.org/draft-07/schema#', 'https://json-schema.org/draft/2019-09/schema']) {
    const definition = tool({ parameters: { $schema: dialect, type: 'object', properties: { flag: { type: 'boolean' }, value: {} },
      if: { required: ['flag'], properties: { flag: { const: true } } }, then: { required: ['value'], properties: { value: { type: 'integer' } } } } });
    assert.equal(toolInputRejection(definition, call({ flag: true, value: 'no' })).code, 'invalid_arguments');
    assert.equal(toolInputRejection(definition, call({ flag: false, value: 'okay' })), null);
  }
});

test('Draft 4 and Draft 6 retain exclusive bounds, ignore later keywords and ignore ref siblings', () => {
  const fourth = tool({ parameters: { $schema: 'https://json-schema.org/draft-04/schema#', type: 'object', properties: {
    amount: { type: 'number', minimum: 1, exclusiveMinimum: true, const: 99 },
    ref: { $ref: '#/definitions/value', type: 'string' },
  }, definitions: { value: { type: 'integer' } }, required: ['amount', 'ref'] } });
  assert.equal(toolInputRejection(fourth, call({ amount: 2, ref: 3 })), null);
  assert.equal(toolInputRejection(fourth, call({ amount: 1, ref: 3 })).code, 'invalid_arguments');
  const sixth = tool({ parameters: { $schema: 'https://json-schema.org/draft-06/schema', type: 'object',
    properties: { value: { exclusiveMinimum: 1 } }, required: ['value'],
    if: { required: ['flag'] }, then: { required: ['later'] } } });
  assert.equal(toolInputRejection(sixth, call({ value: 2, flag: true })), null);
  assert.equal(toolInputRejection(sixth, call({ value: 1 })).code, 'invalid_arguments');
  assert.throws(() => compileToolInput({ $schema: 'https://example.invalid/schema', type: 'object' }), /unsupported_tool_schema_dialect/);
});

test('cached read/write and reasoning usage survives aggregation while missing reports stay explicitly incomplete', async () => {
  let models = 0;
  const { snapshot, store } = await run({ model: async request => {
    assert.equal(request.maxInlineImageBytes, 40 * 1024 * 1024);
    return ++models === 1 ? result([], { kind: 'provider_retryable_error', usageReported: false })
      : result([], { usage: { ...emptyUsage(), inputTokens: 9, outputTokens: 5, cachedInputTokens: 4, cacheWriteInputTokens: 3, reasoningTokens: 2 }, usageReported: true });
  }, configuration: { profile: { ...fixture().config.profile, retryInitialDelayMs: 0, retryMaxDelayMs: 0 } } });
  assert.equal(snapshot.usage.cachedInputTokens, 4); assert.equal(snapshot.usage.reasoningTokens, 2);
  assert.equal(snapshot.usage.cacheWriteInputTokens, 3);
  assert.equal(snapshot.diagnostics.providerUsageIncomplete, true); assert.equal(store.events(scope, 'run').at(-1).payload.usageComplete, false);
  for (const usage of [{ ...emptyUsage(), inputTokens: 0.5 }, { ...emptyUsage(), reasoningTokens: -1 }, { ...emptyUsage(), cachedInputTokens: Number.MAX_SAFE_INTEGER + 1 }]) {
    assert.throws(() => addUsage(emptyUsage(), usage));
  }
});

test('six identical definite tool errors stop across unrelated successful reads', async () => {
  let models = 0, failures = 0;
  const { snapshot } = await run({ configuration: { tools: [tool({ name: 'write', readOnly: false, concurrentSafe: false }), tool()] },
    model: async () => { models++; return result([call({ attempt: models }, { callId: `fail-${models}`, name: 'write' }), call({}, { callId: `read-${models}` })]); },
    execute: async request => request.call.name === 'write' ? (failures++, { status: 'error', content: { code: 'fixed_failure' } }) : { status: 'ok', content: 'unrelated observation' } });
  assert.equal(models, 6); assert.equal(failures, 6); assert.equal(snapshot.usage.toolCalls, 12);
  assert.equal(snapshot.reason, 'repeated_tool_error_no_progress'); assert.equal(snapshot.outcome, 'blocked');
});

test('independent read queries and multiple failures in one model batch do not invent a repeated decision', async () => {
  let models = 0;
  const { snapshot } = await run({ model: async () => ++models <= 7
    ? result([call({ query: models }, { callId: `a-${models}` }), call({ query: models }, { callId: `b-${models}` })]) : result(),
    execute: async () => ({ status: 'error', content: { code: 'not_found' } }) });
  assert.equal(snapshot.phase, 'completed'); assert.equal(snapshot.toolErrorStreak.count, 1); assert.equal(snapshot.usage.toolCalls, 14);
});
