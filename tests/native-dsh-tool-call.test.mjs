import assert from 'node:assert/strict';
import test from 'node:test';
import { executeNativeDshToolCall } from '../src/providers/native-dsh-tool-call.mjs';

const request = () => ({ callId: 'owned-call', name: 'echo', arguments: { text: '中文\n原样' },
  signal: new AbortController().signal, agent: { session: { id: 'owned-session' } } });
const success = () => ({ results: [{ callId: 'owned-call', result: {
  isError: false, value: '中文\n原样', content: [{ type: 'text', text: '中文\n原样' }] } }],
  additionalContexts: [], concluded: false });

test('owned call uses raw batch ABI and preserves policy-added context once', async () => {
  const input = request(), batch = success();
  const context = { role: 'user', content: [{ type: 'text', text: 'policy context' }] };
  batch.results[0].result.additionalContexts = [context];
  batch.additionalContexts = [context];
  let calls = 0;
  const result = await executeNativeDshToolCall({ execute: async actual => {
    calls++;
    assert.deepEqual(actual.calls, [{ type: 'tool-call', id: input.callId, name: input.name,
      arguments: JSON.stringify(input.arguments) }]);
    assert.equal(actual.signal, input.signal);
    assert.equal(actual.agent, input.agent);
    assert.equal(actual.log, undefined, 'Native owns its durable call/result log');
    return batch;
  } }, input);
  assert.equal(calls, 1);
  assert.deepEqual(result.additionalContexts, [context]);
  assert.equal(result.content[0].text, '中文\n原样');
});

test('negotiated caller options are forwarded without hiding any requested option', async () => {
  const options = {argumentEncoding:'dsh.raw-json-number/v1', resultRetention:'caller/v1', preflightDefer:'dsh.tool-preflight-defer/v2'};
  let calls=0;
  await executeNativeDshToolCall({callerOptionsContract:'dsh.tool-batch-caller-options/v1', execute: async input => {
    calls++; assert.deepEqual(input.callerOptions, options); return success();
  }}, {...request(),...options});
  assert.equal(calls,1);
});

test('Host denial remains an error and conclusion remains explicit', async () => {
  const batch = success();
  batch.results[0].result = { isError: true, content: [{ type: 'text', text: 'denied' }], error: { message: 'denied' } };
  assert.equal((await executeNativeDshToolCall({ execute: async () => batch }, request())).isError, true);
  const concluding = success(); concluding.concluded = true;
  assert.equal((await executeNativeDshToolCall({ execute: async () => concluding }, request())).concludesTurn, true);
});

test('an already canceled call never reaches the Host', async () => {
  const input = request(), controller = new AbortController(); controller.abort();
  input.signal = controller.signal;
  await assert.rejects(executeNativeDshToolCall({ execute: () => assert.fail('must not dispatch') }, input),
    { name: 'AbortError' });
});

test('partial Host failures propagate without retries or invented execution receipts', async () => {
  const failure = Object.assign(new Error('batch failed after dispatch'), { partial: success() });
  let calls = 0;
  await assert.rejects(executeNativeDshToolCall({ execute: async () => { calls++; throw failure; } }, request()),
    error => error === failure);
  assert.equal(calls, 1);
});

for (const option of ['argumentEncoding', 'resultRetention', 'preflightDefer'])
  test(`unsupported ${option} is rejected before dispatch instead of silently dropped`, async () => {
    await assert.rejects(executeNativeDshToolCall({ execute: () => assert.fail('must not dispatch') },
      { ...request(), [option]: 'unsupported-contract' }), { code: 'studio_native_batch_caller_options_unavailable' });
  });

for (const [name, mutate] of [
  ['wrong correlation', batch => { batch.results[0].callId = 'another-call'; }],
  ['extra result', batch => { batch.results.push(batch.results[0]); }],
  ['missing context list', batch => { delete batch.additionalContexts; }],
]) test(`invalid batch ${name} cannot settle the owned call`, async () => {
  const batch = success(); mutate(batch);
  await assert.rejects(executeNativeDshToolCall({ execute: async () => batch }, request()),
    { code: 'studio_native_batch_result_invalid' });
});
