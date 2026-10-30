import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionTaskProjector } from '../src/host/session-task-events.mjs';
import { initialState, reduce } from '../src/reducer.mjs';

const entry = (seq, type, data) => ({ type: type === 'assistant/live-chunk' ? 'transient' : 'event',
  event: { seq, time: seq + 1000, type, data: { turn: 1, step: 1, ...data } } });
const start = () => entry(0, 'turn/start', {});
const text = (seq, value) => entry(seq, 'assistant/live-chunk', { chunk: { type: 'text-delta', index: 0, text: value } });
const window = (revision, entries, kind = 'append') => ({ revision, entries, change: { kind, entries: entries.slice(-1) } });

test('coalesced publications apply each new payload once and agree with cold replay', () => {
  let reads = 0;
  const entries = [start(), ...Array.from({ length: 1200 }, (_, i) => {
    const row = text(i + 1, '中'), data = row.event.data;
    Object.defineProperty(row.event, 'data', { get() { reads++;return data; } });return row;
  })];
  const projector = createSessionTaskProjector({ sessionId: 's' });
  projector.project(window(1, [entries[0]], 'replace'));
  let projected;
  for (let end = 9; end <= entries.length; end = Math.min(end + 8, entries.length)) {
    projected = projector.project(window(end, entries.slice(0, end)));
    if (end === entries.length) break;
  }
  assert.equal(reads, 1200, 'batched rendering cannot re-read already folded model payloads');
  assert.equal(projected[0].state.items[0].text, '中'.repeat(1200));
  assert.deepEqual(createSessionTaskProjector({ sessionId: 's' }).project(window(2000, entries, 'replace')), projected);
});

test('a missed replacement or prepend cannot masquerade as an appended suffix', () => {
  for (const replace of [false, true]) {
    const projector = createSessionTaskProjector(), original = [start(), text(1, 'Old')];
    const before = projector.project(window(2, original, 'replace'));
    const next = replace ? [original[0], text(1, 'New'), text(2, ' tail')]
      : [entry(-1, 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'Earlier' }] }), ...original, text(2, ' tail')];
    const after = projector.project(window(4, next));
    assert.deepEqual(after, createSessionTaskProjector().project(window(4, next, 'replace')));
    assert.equal(before[0].state.items[0].text, 'Old', 'old snapshots remain immutable');
    assert.equal(after[0].state.items.at(-1).text, replace ? 'New tail' : 'Old tail');
  }
});

test('coalesced settlement retires transient positions before starting the next response', () => {
  const projector = createSessionTaskProjector({ sessionId: 's' }), prefix = [start(), text(1, 'Draft')];
  projector.project(window(2, prefix, 'replace'));
  const settled = entry(2, 'assistant/message', { message: { id: 'm', content: [{ type: 'text', text: 'Committed' }] } });
  const next = entry(3, 'assistant/live-chunk', { step: 2, chunk: { type: 'text-delta', index: 0, text: 'Next response' } });
  const rows = [...prefix, settled, next], result = projector.project(window(4, rows));
  assert.deepEqual(result, createSessionTaskProjector({ sessionId: 's' }).project(window(4, rows, 'replace')));
  assert.deepEqual(result[0].state.items.map(x => x.text), ['Committed', 'Next response']);
});

test('public channels settle only their own reasoning presentation and real reasoning can resume', () => {
  const event = (type, id, value) => ({ v: 1, type, id, ...value });
  let state = initialState();
  state = reduce(state, event('thinking.delta', 'a', { itemId: 'thought-a', responseId: 'response-a', delta: 'A' }));
  state = reduce(state, event('thinking.delta', 'b', { itemId: 'thought-b', responseId: 'response-b', delta: 'B' }));
  const before = state;
  state = reduce(state, event('text.delta', 'text', { itemId: 'text-a', responseId: 'response-a', delta: 'Answer' }));
  assert.equal(state.items[0].streaming, false);assert.equal(state.items[1].streaming, true);
  assert.equal(before.items[0].streaming, true);assert.equal(state.items[0].duration, undefined);
  state = reduce(state, event('thinking.delta', 'resume', { itemId: 'thought-a', responseId: 'response-a', delta: ' continued' }));
  assert.equal(state.items[0].streaming, true);assert.equal(state.items[0].text, 'A continued');
  state = reduce(state, event('tool.preview', 'tool', { previewId: 'preview', responseId: 'response-a',
    name: 'read', input: {}, receivedChars: 2 }));
  assert.equal(state.items[0].streaming, false);assert.equal(state.items[1].streaming, true);
  const unscoped = reduce(state, event('text.delta', 'unscoped', { itemId: 'other', delta: 'No response identity' }));
  assert.equal(unscoped.items[1].streaming, true);
});
