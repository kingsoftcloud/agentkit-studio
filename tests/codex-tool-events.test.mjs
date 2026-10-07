import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { createCodexToolRecorder, CODEX_TOOL_EVENT } from '../src/providers/codex-tool-events.mjs';

const definition = runInNewContext(`${await readFile(new URL('../src/client-fragments/02-codex-tool-nodes.js', import.meta.url), 'utf8')}\ncodexToolDefinition`);
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
