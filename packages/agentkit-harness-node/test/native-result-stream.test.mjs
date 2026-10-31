import test from 'node:test';
import assert from 'node:assert/strict';
import { answerStringDecoder } from '../src/native/result-stream.mjs';
import { nativeStreamProjector, nativeDurableStream, nativeLiveStream } from '../src/native/assistant-stream.mjs';
import { RESULT_DELIVERY_POLICY } from '@kingsoftcloud/agentkit-harness-core';

const configuration = { deliveryScopePolicy: RESULT_DELIVERY_POLICY, tools: [{ name: 'read' }] };
const record = (text, index = 0, name = 'submit_final_output') => ({ time: 1,
  event: { kind: 'tool_delta', text, metadata: { index, ...(name ? { name } : {}) } } });
const textOf = records => records.filter(item => item.chunk.type === 'text-delta').map(item => item.chunk.text).join('');

test('answer string decoding handles every chunk boundary, escaped keys, artifacts-first ordering and nested decoys', () => {
  const answer = '你好🌟\n"quotes"\t\\path\b\r\f/end';
  const json = JSON.stringify({ artifacts: [{ path: 'secret.html', answer: 'not prose', kind: 'file' }], answer })
    .replace('"answer":"你好', '"ans\\u0077er":"你好').replace('🌟', '\\ud83c\\udf1f');
  for (let split = 0;split <= json.length;split++) {
    const decode = answerStringDecoder();assert.equal(decode(json.slice(0, split)) + decode(json.slice(split)), answer);
  }
  const decode = answerStringDecoder();assert.equal([...json].map(ch => decode(ch)).join(''), answer);
  assert.equal(answerStringDecoder()('{"answer":{"nested":"not prose"},"artifacts":[]}'), '');
});

test('live and durable result streams produce only answer prose, preserve tool streams and keep legacy bytes', () => {
  const frames = [record('{"artifacts":[{"kind":"file","path":"secret.md"}],'),
    record('"answer":"Hello\\nworld"}', 0, null), record('{"path":"readme"}', 1, 'read')];
  const projected = frames.flatMap(nativeStreamProjector('operation', configuration));
  assert.equal(textOf(projected), 'Hello\nworld');assert.doesNotMatch(JSON.stringify(projected), /secret\.md|submit_final_output/);
  assert.equal(projected.filter(item => item.chunk.type === 'tool-call-delta').length, 1);
  const durable = nativeDurableStream('operation', { version: 'agentkit.model-display/v1', records: frames }, configuration);
  assert.deepEqual(durable, projected);
  const output = [], agent = {}, live = nativeLiveStream({ agent, runId: 'run', turn: 1, configuration,
    revisions: new WeakMap(), beginStep: () => 1, publish: frame => output.push(frame) });
  for (const frame of frames) live.accept({ operationKey: 'operation' }, frame);
  assert.deepEqual(output.filter(frame => frame.type === 'chunk').map(({ time, chunk }) => ({ type: 'chunk', time, chunk })), projected);
  assert.match(JSON.stringify(frames.flatMap(nativeStreamProjector('operation'))), /secret\.md|submit_final_output/);
});

test('unnamed tool fragments wait for their name and artifacts never become prose', () => {
  const project = nativeStreamProjector('operation', configuration);
  assert.deepEqual(project(record('{"answer":"wait', 0, null)), []);
  assert.equal(textOf(project(record('ed","artifacts":[]}', 0))), 'waited');
  assert.doesNotMatch(JSON.stringify(project(record('ignored', 0))), /ignored/);
});
