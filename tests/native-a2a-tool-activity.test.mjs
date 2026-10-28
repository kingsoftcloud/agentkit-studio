import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { copy, canonical } from '@kingsoftcloud/agentkit-harness-core';
import { projectA2ACanonical } from '../src/providers/native-a2a-canonical.mjs';
import { a2aNonGlobalAddress, A2A_TOOL_ACTIVITY_URI, buildA2aPublicToolActivity } from '../src/providers/native-a2a-tool-activity.mjs';
import { compileA2aPublicToolPolicy, projectA2aPublicTools } from '../src/providers/native-a2a-public-tool-producer.mjs';
import { a2aIdentity, checkpointA2ADescriptor } from '../src/providers/native-a2a-events.mjs';
import { spec, taskId } from './fixtures/native-a2a-internal-peer.mjs';
import { createA2AProjection } from '../src/providers/native-a2a-protocol.mjs';

const oracle = JSON.parse(readFileSync(new URL('./fixtures/a2a-tool-activity-reference.json', import.meta.url)));

test('callee disclosure redacts nested secrets and internal URLs and emits an explicit bounded invocation truncation', () => {
  const activity = buildA2aPublicToolActivity({ event_id: 'event', item_id: 'item', call_id: 'call', item_kind: 'tool_call',
    operation: 'updated', execution_status: 'running', name: 'lookup', arguments: {
      filter: { apiKey: 'never public', url: 'http://127.0.0.1/private' },
      text: '😀' + 'q'.repeat(5000), values: Array.from({ length: 150 }, (_, index) => index),
    } });
  assert.equal(activity.arguments.filter.apiKey, '[REDACTED]');
  assert.equal(activity.arguments.filter.url, '[REDACTED_INTERNAL_URL]');
  assert.equal(activity.arguments.values.length, 128); assert.equal(activity.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(activity)) <= 16 * 1024);
  const oversized = buildA2aPublicToolActivity({ ...activity, arguments: { text: '😀'.repeat(5000) } });
  assert.deepEqual(oversized.arguments, { summary: 'public tool payload omitted by size policy' });
  const policy = compileA2aPublicToolPolicy({ tools: { lookup: { name: 'lookup', arguments: ['query'] } } });
  const record = { task: { id: 'task', contextId: 'context', artifacts: [] } }, updates = [];
  for (let index = 0; index < 150; index++) projectA2aPublicTools(record, {
    family: 'runtime', event_id: `fact-${index}`, payload: { event_type: 'item.completed', item_kind: 'tool_call',
      scope_id: 'scope', item_id: `private-item-${index}`, snapshot: { parts: [{ content_type: 'tool_call', part_id: 'part',
        call_id: `private-call-${index}`, name: 'lookup', arguments: { query: 'q'.repeat(4096) } }] } },
  }, updates, policy);
  assert.equal(record.publicToolActivity.exhausted, true); assert.ok(record.publicToolActivity.bytes <= 1024 * 1024);
  assert.equal(updates.at(-1).artifactUpdate.artifact.parts[0].data.truncated, true);
  assert.equal(updates.at(-1).artifactUpdate.artifact.parts[0].data.arguments, null);
});
const record = () => ({ managed: { taskId, remote: { id: 'remote', contextId: 'context', phase: 'bound' } },
  request: { spec, scopeId: 'child', trigger: { scope_id: 'root', item_id: 'call', call_id: 'call' }, native: { runId: 'root' } },
  createdAt: 1792790000000, phase: 'sending', projection: { state: 'working' } });
function semantic(event) {
  const { event_id, seq, run_seq, timestamp, ...rest } = event;
  return rest;
}
for (const row of oracle.cases) test(`actual reference public activity: ${row.label}`, () => {
  let r = record(); checkpointA2ADescriptor(r);
  for (const [index, step] of row.steps.entries()) {
    const before = copy(r), count = r.managed.events.log.length;
    const observe = () => projectA2ACanonical(r, { payload: step.payload, method: step.method, observationId: `operation-${index}` });
    if (step.error) {
      assert.throws(observe, { code: step.error }); assert.deepEqual(r, before);
    } else {
      observe();
      assert.deepEqual(r.managed.events.log.slice(count).map(semantic), step.events.map(semantic));
      assert.equal(r.managed.events.adapter.toolActivityBytes ?? 0, step.activityBytes);
      assert.ok(r.managed.events.log.every(event => !event.event_type.startsWith('run.')));
      assert.deepEqual(r.managed.events.adapter.refs, []);
    }
    // Reconstruct from the same codec used by the durable per-call record.
    r = copy(r);
  }
});
test('public activity IP classification matches reference ipaddress.is_global, including mapped and exceptional addresses', () => {
  for (const row of oracle.addresses) assert.equal(a2aNonGlobalAddress(row.host), row.nonGlobal, row.host);
});
test('public observation never grants local tool or approval authority and retains original DSH owner', () => {
  const r = record(); delete r.request.native; r.request.dsh = { agentId: 'agent', sessionId: 'session' };
  const step = oracle.cases[0].steps[0]; projectA2ACanonical(r, { ...step, observationId: 'operation' });
  const parent = a2aIdentity('scope', 'dsh', 'agent', 'session');
  assert.ok(r.managed.events.log.every(event => event.run_id === parent && event.parent_scope_id === parent && event.scope_id === 'child'));
  assert.ok(r.managed.events.log.every(event => event.source.metadata.remote_observation === true));
  assert.ok(r.managed.events.log.every(event => event.event_type.startsWith('item.')));
  assert.equal(r.managed.events.adapter.activeInteraction, undefined);
  assert.equal(r.managed.events.adapter.toolActivityBytes, step.activityBytes);
});
test('public budget includes every accepted version and never echoes rejected invocation data', () => {
  const r = record();
  const payload = copy(oracle.cases[0].steps[0].payload), activity = payload.artifactUpdate.artifact.parts[0].data;
  activity.arguments = { text: '😀'.repeat(2000) };
  let accepted = 0;
  for (let index = 0; index < 100; index++) {
    activity.event_id = `progress-${index}`;
    projectA2ACanonical(r, { payload, method: 'SendStreamingMessage', observationId: `operation-${index}` });
    if (r.managed.events.adapter.toolActivityBytes !== accepted) {
      accepted = r.managed.events.adapter.toolActivityBytes;
    } else {
      const before = copy(r);
      projectA2ACanonical(r, { payload, method: 'SendStreamingMessage', observationId: 'overflow-repeat' });
      assert.deepEqual(r.managed.events.adapter, before.managed.events.adapter);
      assert.deepEqual(r.managed.events.log, before.managed.events.log);
      assert.ok(accepted <= 1024 * 1024);
      assert.ok(accepted > 1024 * 1024 - 25000);
      return;
    }
  }
  assert.fail('invocation budget never enforced');
});
test('a late public closed conflict rolls back earlier snapshot content and all queued events', () => {
  const r = record(), open = copy(oracle.cases[0].steps[0].payload);
  open.artifactUpdate.artifact.parts[0].data.operation = 'completed';
  projectA2ACanonical(r, { payload: open, method: 'SendStreamingMessage', observationId: 'closed' });
  const before = copy(r), changed = copy(open.artifactUpdate.artifact); changed.parts[0].data.arguments = { changed: true };
  assert.throws(() => projectA2ACanonical(r, { observationId: 'get', method: 'GetTask', payload: {
    id: 'remote', contextId: 'context', status: { state: 'TASK_STATE_COMPLETED' }, artifacts: [
      { artifactId: 'ordinary', parts: [{ text: 'must not publish' }] }, changed,
    ],
  } }), { code: 'A2A_TOOL_CLOSED_CONFLICT' });
  assert.deepEqual(r, before);
});
test('wire identity failures cannot persist a malformed public observation', () => {
  const r = record(); checkpointA2ADescriptor(r); const before = copy(r);
  const payload = { artifactUpdate: { taskId: 'different', contextId: 'context', artifact: {
    artifactId: 'bad', metadata: { extension_uri: A2A_TOOL_ACTIVITY_URI }, parts: [{ data: { token: 'NEVER_ECHO' } }],
  } } };
  assert.throws(() => projectA2ACanonical(r, { payload, method: 'SendStreamingMessage', observationId: 'other' }), { code: 'A2A_REMOTE_BINDING_CONFLICT' });
  assert.deepEqual(r, before);
});
test('declared observations never erase final reply text or expose malformed extension text to legacy selectors', () => {
  for (const deferTerminal of [false, true]) {
    const p = createA2AProjection('child', null, { deferTerminal });
    const normal = { artifactId: 'answer', parts: [{ text: 'final answer' }] };
    p.apply({ artifactUpdate: { taskId: 'remote', contextId: 'context', artifact: normal } });
    const bad = { artifactId: 'unsafe', metadata: { extension_uri: 'unknown' }, parts: [{ text: 'NEVER_ECHO' }] };
    p.apply({ artifactUpdate: { taskId: 'remote', contextId: 'context', artifact: bad, append: true, lastChunk: true } }, 'bad-frame');
    const good = oracle.cases[0].steps[0].payload.artifactUpdate.artifact;
    p.task({ id: 'remote', contextId: 'context', status: { state: 'TASK_STATE_COMPLETED' }, artifacts: [normal, bad, good] });
    assert.equal(p.snapshot().output_refs.length, 1);
    assert.deepEqual(Object.values(p.snapshot().snapshots), [{ p0: 'final answer' }]);
    assert.doesNotMatch(JSON.stringify(p.snapshot().snapshots), /NEVER_ECHO/);
    assert.doesNotMatch(JSON.stringify(p.snapshot().seen), /NEVER_ECHO/);
  }
});
test('opaque occurrence receipts detect changed payloads and still read earlier v1 collision receipts', () => {
  const p = createA2AProjection('child'), payload = oracle.cases[0].steps[0].payload;
  p.apply(payload, 'frame'); assert.match(p.snapshot().seen[canonical('frame')], /^sha256:[a-f0-9]{64}$/u);
  const checkpoint = p.snapshot(); checkpoint.seen[canonical('frame')] = canonical(payload);
  const reopened = createA2AProjection('child', checkpoint); reopened.apply(payload, 'frame');
  assert.deepEqual(reopened.snapshot(), checkpoint);
  const changed = copy(payload); changed.artifactUpdate.artifact.parts[0].data.event_id = 'other';
  assert.throws(() => reopened.apply(changed, 'frame'), { code: 'A2A_EVENT_ID_CONFLICT' });
  assert.deepEqual(reopened.snapshot(), checkpoint);
});
