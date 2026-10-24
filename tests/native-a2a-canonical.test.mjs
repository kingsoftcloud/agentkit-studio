import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { copy } from '../packages/agentkit-harness-core/dist/index.mjs';
import { projectA2ACanonical } from '../src/providers/native-a2a-canonical.mjs';
import { convertA2AContent } from '../src/providers/native-a2a-content.mjs';
import { a2aIdentity, checkpointA2ADescriptor } from '../src/providers/native-a2a-events.mjs';
import { normalizeA2AObservation } from '../src/providers/native-a2a-wire-value.mjs';
import { createA2AProjection } from '../src/providers/native-a2a-protocol.mjs';
import { spec, taskId } from './fixtures/native-a2a-internal-peer.mjs';
const record = () => ({ managed: { taskId, remote: { id: 'remote', contextId: 'context', phase: 'bound' } },
  request: { spec, scopeId: 'child', trigger: { scope_id: 'root', item_id: 'call', call_id: 'call' }, native: { runId: 'root' } },
  createdAt: 1792790000000, phase: 'sending', projection: { state: 'working' } });
const task = (state = 'TASK_STATE_COMPLETED', extra = {}) => ({ id: 'remote', contextId: 'context', status: { state }, ...extra });
const update = (artifact, extra = {}) => ({ artifactUpdate: { taskId: 'remote', contextId: 'context', artifact, ...extra } });
const observe = (r, payload, method = 'SendStreamingMessage', observationId = 'operation', sourceEventId = '') =>
  projectA2ACanonical(r, { payload, method, observationId, sourceEventId });
const log = r => r.managed.events.log;
test('remote notification is provisional, original GetTask alone closes artifacts and publishes output refs', () => {
  const r = record(); checkpointA2ADescriptor(r);
  const artifact = { artifactId: 'report', parts: [{ text: 'provisional' }, { data: { n: 1 } }] };
  observe(r, update(artifact, { lastChunk: true }));
  observe(r, { statusUpdate: { taskId: 'remote', contextId: 'context', status: { state: 'TASK_STATE_COMPLETED' } } });
  assert.equal(log(r).some(e => e.item_kind === 'artifact' && e.event_type === 'item.completed'), false);
  assert.deepEqual(r.managed.events.adapter.refs, []);
  artifact.parts = [{ text: 'authoritative' }, { url: 'https://example.com/report', filename: 'report' }];
  observe(r, task(undefined, { artifacts: [artifact] }), 'GetTask', 'get-one');
  const completed = log(r).find(e => e.item_kind === 'artifact' && e.event_type === 'item.completed');
  assert.equal(completed.snapshot.parts[0].text, 'authoritative');
  r.projection.state = 'completed'; checkpointA2ADescriptor(r);
  assert.deepEqual(r.managed.events.descriptor.output_refs, [{ scope_id: 'child', item_id: completed.item_id, part_id: completed.snapshot.parts[0].part_id }]);
  assert.ok(log(r).every(e => e.run_id === 'root' && e.scope_id === 'child' && e.parent_scope_id === 'root' && !e.event_type.startsWith('run.')));
  assert.deepEqual(log(r).map(e => e.seq), log(r).map((_, i) => i + 1));
});
test('append preserves stable offset identities, survives cold JSON checkpoint, and requires an existing base', () => {
  let r = record(); const artifact = { artifactId: 'a', parts: [{ text: 'a' }] };
  assert.throws(() => observe(r, update(artifact, { append: true })), { code: 'A2A_ARTIFACT_BASE_REQUIRED' });
  observe(r, update(artifact)); r = copy(r);
  observe(r, update({ ...artifact, parts: [{ text: 'b' }] }, { append: true, lastChunk: true }));
  const appended = log(r).at(-1); assert.equal(appended.op, 'append');
  assert.equal(appended.update.part_id, a2aIdentity('part', 'a2a', appended.item_id, 'text:1'));
  observe(r, task(undefined, { artifacts: [{ ...artifact, parts: [{ text: 'a' }, { text: 'b' }] }] }), 'GetTask', 'get');
  assert.equal(log(r).at(-1).snapshot.parts.length, 2);
  assert.throws(() => observe(r, update(artifact)), { code: 'A2A_ARTIFACT_ALREADY_CLOSED' });
});
test('authoritative removal fails a provisional artifact, terminal reads deduplicate and cannot change it', () => {
  const r = record(); observe(r, update({ artifactId: 'removed', parts: [{ text: 'x' }] }));
  const final = task(); observe(r, final, 'GetTask', 'get');
  assert.equal(log(r).at(-1).error.code, 'a2a_artifact_removed_by_snapshot'); const before = copy(r);
  observe(r, { ...final, artifacts: [], history: [], metadata: null }, 'GetTask', 'another-get');
  assert.deepEqual(r, before);
  assert.throws(() => observe(r, task('TASK_STATE_FAILED'), 'GetTask', 'changed'), { code: 'A2A_TERMINAL_SNAPSHOT_CONFLICT' });
  assert.deepEqual(r, before);
});
test('producer and transport event identity conflicts fail without publishing shadow content', () => {
  const r = record(), payload = update({ artifactId: 'a', parts: [{ text: 'x' }] }, { metadata: { event_id: 'event', seq: 1 } });
  observe(r, payload, 'SendStreamingMessage', 'send', 'sse'); const before = copy(r);
  assert.equal(log(r).at(-1).source.native_cursor, '1.0');
  assert.equal(observe(r, payload, 'SendStreamingMessage', 'send', 'sse'), false); assert.deepEqual(r, before);
  const changed = copy(payload); changed.artifactUpdate.artifact.parts[0].text = 'changed';
  assert.throws(() => observe(r, changed, 'SendStreamingMessage', 'send', 'sse'), { code: 'A2A_CANONICAL_OBSERVATION_CONFLICT' });
  assert.throws(() => observe(r, changed, 'SendStreamingMessage', 'send', 'other'), { code: 'A2A_PRODUCER_EVENT_ID_CONFLICT' });
  assert.deepEqual(r, before);
});
test('completed messages deduplicate default wire fields and reject changed immutable contents', () => {
  const r = record(), message = { messageId: 'm', role: 'ROLE_AGENT', parts: [{ text: 'answer' }] };
  observe(r, task(undefined, { history: [message] }), 'GetTask', 'get'); const before = copy(r);
  // A fresh task signature is used here: direct repeated-message checks are independent of terminal-task checks.
  delete r.managed.events.adapter.terminalFingerprint;
  observe(r, task(undefined, { history: [{ ...message, extensions: [], referenceTaskIds: [], taskId: '', parts: [{ text: 'answer', filename: '', mediaType: '' }] }] }), 'GetTask', 'get2');
  assert.equal(log(r).length, log(before).length);
  delete r.managed.events.adapter.terminalFingerprint;
  assert.throws(() => observe(r, task(undefined, { history: [{ ...message, parts: [{ text: 'different' }] }] }), 'GetTask', 'get3'), { code: 'A2A_MESSAGE_IDENTITY_CONFLICT' });
});
test('internal projection waits for GetTask and lastChunk permits further provisional observations', () => {
  const p = createA2AProjection('child', null, { deferTerminal: true });
  p.apply({ task: task() }); assert.equal(p.snapshot().state, 'working');
  p.apply(update({ artifactId: 'a', parts: [{ text: 'first' }] }, { lastChunk: true }));
  p.apply(update({ artifactId: 'a', parts: [{ text: 'next' }] }, { append: true }));
  p.task(task()); assert.equal(p.snapshot().state, 'completed'); assert.equal(p.snapshot().pendingTerminal, undefined);
});
test('wire defaults normalize without dropping Value nulls, empty oneof strings, signed zero or prototype keys', () => {
  const normalized = normalizeA2AObservation({ message: { messageId: 'm', role: 'ROLE_AGENT', extensions: [], taskId: '', parts: [
    { text: '', filename: '', mediaType: '' }, { data: null }, { data: JSON.parse('{"__proto__":{"key":1},"n":-0.0}') } ] } }, 'SendMessage');
  assert.deepEqual(normalized.message.parts.slice(0, 2), [{ text: '' }, { data: null }]);
  assert.equal(Object.hasOwn(normalized.message.parts[2].data, '__proto__'), true);
  assert.equal(Object.is(normalized.message.parts[2].data.n, -0), true);
  for (const value of [new Date(), { message: { messageId: '\ud800' } }, { message: { parts: [{ data: undefined }] } }])
    assert.throws(() => normalizeA2AObservation(value, 'SendMessage'));
});
test('interaction collisions and malformed approval hints cannot publish a partial request or resolve previous input', () => {
  const r = record();
  const status = message => ({ statusUpdate: { taskId: 'remote', contextId: 'context', status: { state: 'TASK_STATE_INPUT_REQUIRED', message } } });
  const message = { messageId: 'question', role: 'ROLE_AGENT', parts: [{ text: 'Answer?' }] };
  observe(r, status(message)); const before = copy(r);
  assert.throws(() => observe(r, status({ ...message, parts: [{ text: 'changed' }] })), { code: 'A2A_INTERACTION_PAYLOAD_CONFLICT' });
  assert.deepEqual(r, before);
  assert.throws(() => observe(r, status({ ...message, messageId: 'other', metadata: { ksadk_interaction: { version: true } } })),
    { code: 'A2A_INTERACTION_DECLARATION_INVALID' });
  assert.deepEqual(r, before);
  assert.throws(() => observe(r, { statusUpdate: { taskId: 'remote', contextId: 'context', status: { state: 'TASK_STATE_INPUT_REQUIRED' } } }),
    { code: 'A2A_INTERACTION_MESSAGE_REQUIRED' });
  assert.deepEqual(r, before);
});
test('a late failing snapshot leaves all previous content, interaction checkpoint and pending batches unchanged', () => {
  const r = record(); observe(r, update({ artifactId: 'a', parts: [{ text: 'old' }] })); const before = copy(r);
  assert.throws(() => observe(r, task(undefined, { artifacts: [{ artifactId: 'a', parts: [{ text: 'new' }] },
    { artifactId: 'bad', parts: [{ text: 'x', metadata: { part_id: 'same' } }, { text: 'y', metadata: { part_id: 'same' } }] }] }), 'GetTask', 'get'),
    { code: 'A2A_CONTENT_DUPLICATE_PART_ID' });
  assert.deepEqual(r, before);
});
// Actual reference-generated expectations; Python is not invoked by these tests.
const oracle = JSON.parse(readFileSync(new URL('./fixtures/a2a-canonical-reference.json', import.meta.url)));
const contentOracle = JSON.parse(readFileSync(new URL('./fixtures/a2a-content-reference.json', import.meta.url)));
for (const row of contentOracle.cases) test(`actual Python content conversion: ${row.label}`, () => {
  assert.deepEqual(convertA2AContent(row.owner, 'content-item', { startIndex: row.startIndex ?? 0 }), row.expected);
});
function semantic(event) {
  const { event_id, seq, run_seq, timestamp, source, ...value } = event;
  if (value.error) { const { source_ref, ...error } = value.error; value.error = error; }
  if (value.request?.request_type === 'approval') {
    value.request.detail.prompt = JSON.parse(value.request.detail.prompt);
  }
  return value;
}
for (const row of oracle.cases) test(`actual Python canonical behavior: ${row.label}`, () => {
  let r = record(); if (row.direct) r.managed.remote = null;
  for (const [index, step] of row.steps.entries()) {
    observe(r, step.payload, step.method, `operation-${index}`); r = copy(r);
  }
  assert.deepEqual(log(r).map(semantic), row.events.map(semantic));
});
