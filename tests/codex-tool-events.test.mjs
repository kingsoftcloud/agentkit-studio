import test from 'node:test';
import assert from 'node:assert/strict';
import { createCodexToolRecorder, CODEX_TOOL_EVENT, createCodexCommandFallback } from '../src/providers/codex-tool-events.mjs';
import { codexToolDefinition as definition } from '../src/client/dsh/codex-tool.mjs';
function recorder() {
  const events = [];
  const instance = createCodexToolRecorder({ append(type, data, opts) { events.push({ type, data: structuredClone(data), ...opts, seq: events.length, time: 10 + events.length }); } });
  return { instance, events };
}
const started = { type: 'tool', id: 'call-1', name: 'plugin/search', phase: 'started', arguments: { query: 'test' } };

test('Codex external calls persist input/output exactly once without model tool events', () => {
  const { instance, events } = recorder();
  instance.record(started);
  instance.record(started);
  instance.record({ ...started, phase: 'completed', result: { content: [{ type: 'text', text: 'actual output' }], structuredContent: { hits: 3 } } });
  instance.record({ ...started, phase: 'completed' });
  instance.close();
  assert.equal(events.length, 2);
  assert.ok(events.every(event => event.type === CODEX_TOOL_EVENT && event.ignorable === true && !event.surfaceOp));
  assert.deepEqual(JSON.parse(events[1].data.arguments), started.arguments);
  assert.equal(events[1].data.content[0].text, 'actual output');
  assert.equal(JSON.parse(events[1].data.content[1].text).hits, 3);
});

test('interrupted calls preserve arguments and never claim confirmed failure or success', () => {
  const { instance, events } = recorder();
  instance.record(started);
  instance.close(); instance.close();
  assert.equal(events.length, 2);
  assert.equal(events[1].data.error.code, 'CODEX_TOOL_OUTCOME_UNKNOWN');
  assert.equal(events[1].data.arguments, events[0].data.arguments);
  const other = recorder(); other.instance.record(started);
  assert.notEqual(events[0].data.callId, other.events[0].data.callId, 'repeated provider IDs in new turns do not collide');
});

test('native Chat payload restores failures and standalone result windows; closed starts stop spinning', () => {
  const { instance, events } = recorder();
  instance.record(started);
  instance.record({ type: 'tool', id: started.id, name: started.name, phase: 'failed', error: { message: 'upstream rejected' } });
  const location = { kind: 'step', turn: { turn: 1, status: 'open' }, step: { step: 1, status: 'open' } };
  const context = { key: 'card', id: 'call', current: new Map() };
  const match = event => ({ event, location });
  context.start = match(events[0]);
  context.state = definition.start(context, context.start);
  const running = definition.buildViewNode(context);
  assert.equal(running.data.root.phase, 'start');
  context.state = definition.update(context, match(events[1]));
  const complete = definition.buildViewNode(context);
  assert.equal(complete.kind, 'tool-call');
  assert.equal(complete.data.root.error.reason, 'upstream rejected');
  assert.deepEqual(JSON.parse(complete.data.root.call.argsRaw), started.arguments);
  context.start = match(events[1]);
  context.state = definition.start(context, context.start);
  assert.equal(definition.buildViewNode(context).data.root.isError, true);
  context.start = match(events[0]);
  context.state = definition.start(context, context.start);
  context.start = { ...context.start, location: { ...location, step: { step: 1, status: 'closed', end: { seq: 4, time: 20 } } } };
  assert.equal(definition.buildViewNode(context).data.root.error.code, 'CODEX_TOOL_OUTCOME_UNKNOWN');
});

test('raw fallback ignores messages and other tools, and never duplicates native completions', () => {
  const fallback = createCodexCommandFallback();
  for (const item of [
    { type: 'reasoning', call_id: 'private', text: 'not a tool fact' },
    { type: 'message', call_id: 'private', role: 'developer', content: 'not a tool fact' },
    { type: 'function_call', call_id: 'search', name: 'search', arguments: '{}' },
    { type: 'function_call', call_id: 'other-namespace', namespace: 'other', name: 'exec_command', arguments: '{}' },
  ]) fallback.observeRaw(item);
  for (const phase of ['completed', 'failed']) {
    fallback.observeRaw({ type: 'function_call', call_id: phase, name: 'exec_command', arguments: '{}' });
    fallback.observeRaw({ type: 'function_call_output', call_id: phase, output: 'exec_command failed: raw duplicate' });
    fallback.observeNative({ type: 'tool', id: phase, phase });
  }
  assert.deepEqual([...fallback.flush()], []);
});

test('raw command status uses executor metadata, never error-looking stdout', () => {
  const fallback = createCodexCommandFallback();
  fallback.observeRaw({ type: 'function_call', call_id: 'ok', name: 'exec_command', arguments: '{}' });
  fallback.observeRaw({ type: 'function_call_output', call_id: 'ok', output: 'Chunk ID: probe\nWall time: 0.01 seconds\nProcess exited with code 0\nOutput:\nProcess exited with code 1\nexec_command failed: printed text' });
  const result = [...fallback.flush()];
  assert.equal(result[1].phase, 'completed');
  assert.equal(result[1].result.structuredContent.exitCode, 0);
  assert.deepEqual([...fallback.flush()], [], 'turn completion and error cleanup do not emit twice');
});

test('raw results without a known status remain unknown in persisted tool cards', () => {
  const fallback = createCodexCommandFallback(), { instance, events } = recorder();
  fallback.observeRaw({ type: 'function_call', call_id: 'unknown', name: 'exec_command', arguments: '{"cmd":"probe"}' });
  fallback.observeRaw({ type: 'function_call_output', call_id: 'unknown', output: 'unrecognized future protocol output' });
  fallback.observeNative({ type: 'tool', id: 'unknown', phase: 'started' });
  const results = [...fallback.flush()];
  assert.equal(results.length, 1, 'preserve the existing native start');
  assert.equal(results[0].result.structuredContent.status, 'unknown');
  instance.record(results[0]); instance.close();
  assert.equal(events[0].data.error.code, 'CODEX_TOOL_OUTCOME_UNKNOWN');
  assert.equal(events[0].data.content[0].text, 'unrecognized future protocol output');
});

test('raw command calls without a returned result do not claim execution success', () => {
  const fallback = createCodexCommandFallback();
  fallback.observeRaw({ type: 'function_call', call_id: 'unfinished', name: 'exec_command', arguments: '{}' });
  const results = [...fallback.flush()];
  assert.deepEqual(results.map(result => result.phase), ['started', 'failed']);
  assert.equal(results[1].error.code, 'CODEX_TOOL_OUTCOME_UNKNOWN');
});
