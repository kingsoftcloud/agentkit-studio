import test from 'node:test';
import assert from 'node:assert/strict';
import { appendCommandOutput, createCommandOutputComponents } from '../src/command-output.mjs';

const request = { sessionId: 's', taskId: 't', stdoutCursor: 0, stderrCursor: 0 };
const page = changes => ({ contract: 'agentkit.studio-command-output/v1', sessionId: 's', taskId: 't', runId: 'r', status: 'running',
  stdout: '[redacted]', stderr: '', stdoutCursor: 40, stderrCursor: 0, exitCode: null, ...changes });
test('backend cursors survive redaction and append across a continued session head', () => {
  const first = appendCommandOutput(null, page(), request);
  const next = appendCommandOutput(first, page({ runId: 'next', stdout: 'done', stdoutCursor: 44, status: 'completed', exitCode: 0 }), { ...request, stdoutCursor: 40 });
  assert.equal(next.stdout, '[redacted]done'); assert.equal(next.exitCode, 0); assert.equal(next.runId, 'next');
  assert.throws(() => appendCommandOutput(next, page(), request));
  assert.throws(() => appendCommandOutput(null, page({ taskId: 'foreign' }), request));
});
test('withholding does not append text or consume a cursor, and uncertainty has no exit verdict', () => {
  const first = appendCommandOutput(null, page({ stdout: '', stdoutCursor: 0, withheld: true, status: 'unknown', exitCode: 0 }), request);
  assert.equal(first.stdout, ''); assert.equal(first.stdoutCursor, 0); assert.equal(first.exitCode, null);
  const actual = appendCommandOutput(first, page(), request); assert.equal(actual.stdout, '[redacted]');
});
test('retained preview is bounded without changing raw byte continuation cursors', () => {
  let value = null, cursor = 0;
  for (let i = 0; i < 4; i++) {
    const text = String(i).repeat(65536);
    value = appendCommandOutput(value, page({ stdout: text, stdoutCursor: cursor + 65536 }), { ...request, stdoutCursor: cursor }); cursor += 65536;
  }
  assert.equal(value.stdout, '2'.repeat(65536) + '3'.repeat(65536)); assert.equal(value.omitted, 131072); assert.equal(value.stdoutCursor, 262144);
});
test('the independent output pane strips terminal escapes and distinguishes uncertainty from success', () => {
  const React = { createElement: (tag, props, ...children) => ({ tag, props, children }), useRef: () => ({ current: null }),
    useState: initial => [initial, () => {}], useEffect: () => {} };
  const { CommandOutputPane } = createCommandOutputComponents(React);
  const tree = CommandOutputPane({ output: page({ stdout: '\x1b[31mactual\x1b[0m', status: 'unknown', exitCode: null, evidenceIncomplete: true }) });
  const serialized = JSON.stringify(tree);
  assert.match(serialized, /执行结果未知/); assert.match(serialized, /执行证据不完整/);
  assert.equal(serialized.includes('退出码'), false); assert.equal(serialized.includes('\\u001b'), false);
  assert.equal(serialized.includes('actual'), true);
});
