import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeSkillEventJournal, nativeSkillEventEvidence, recordNativeSkillResultConsumption } from '../packages/agentkit-harness/src/native/skill-events.mjs';

const pkg = { name: 'alpha', skillId: 'skill-alpha', versionId: 'v1', body: '# Alpha', archiveHash: 'a'.repeat(64) };
function journal() {
  const events = [], writes = [];
  const port = createNativeSkillEventJournal({ runtimeId: 'runtime-one', request: { runId: 'run-one', operationKey: 'original-operation' },
    bindingDigest: 'binding-one', events, persist: () => writes.push(structuredClone(events)) });
  return { events, port, writes };
}

test('typed Skill facts retain outer identities and only sanitize allowlisted diagnostic attributes', () => {
  const h = journal(); h.port.emit('skill.workflow.started', 'running');
  const event = h.port.emit('skill.execution.started', 'running', { pkg,
    attributes: { requested_skill: 'alpha', backend: 'local_process', password: 'never-export', reason: 'Bearer never-export' } });
  assert.equal(event.run_id, 'run-one'); assert.equal(event.binding_snapshot_id, 'binding-one');
  assert.equal(event.skill_ref.content_hash, 'sha256:' + 'a'.repeat(64));
  assert.equal(event.attributes.password, undefined); assert.equal(event.attributes.reason, '[redacted]');
  assert.equal(h.writes.length, 2); assert.equal(h.writes[1].length, 2);
  h.port.failOpen(); assert.equal(h.events.at(-1).status, 'uncertain');
  assert.equal(h.events.at(-1).skill_invocation_id, event.skill_invocation_id);
  assert.deepEqual(nativeSkillEventEvidence(h.events).skill_events, h.events);
  assert.ok(!h.events.some(event => event.event_type === 'skill.result.consumed'));
});

test('sandbox Skill envelopes require the immutable invocation, overwrite correlation, redact and deduplicate', () => {
  const h = journal(), identity = h.port.identity(pkg);
  const input = { schema_version: 1, event_id: 'child-one', event_type: 'skill.manifest.parsed', status: 'completed',
    started_at: 10, ...identity, run_id: 'forged-run', binding_snapshot_id: 'forged-binding',
    attributes: { source: 'host', has_description: true, password: 'do-not-copy' } };
  h.port.accept(JSON.stringify(input) + '\n' + JSON.stringify(input));
  assert.equal(h.events.length, 1); assert.equal(h.events[0].run_id, 'run-one');
  assert.equal(h.events[0].attributes.source, 'sandbox'); assert.equal(h.events[0].attributes.password, undefined);
  for (const changes of [{ event_type: 'skill.workflow.completed' }, { skill_invocation_id: 'foreign' },
    { skill_ref: { ...identity.skill_ref, version_id: 'wrong' } }, { event_type: 'skill.result.consumed' }, { started_at: 1e100 }])
    h.port.accept(JSON.stringify({ ...input, ...changes }));
  assert.equal(h.events.filter(event => event.event_type === 'sandbox.envelope.rejected').length, 5);
  h.port.accept(JSON.stringify({ ...input, status: 'failed' }));
  assert.equal(h.events.at(-1).error_category, 'correlation_mismatch');
});

test('Skill diagnostic budgets leave an explicit truncation fact without changing execution authority', () => {
  const events = [], port = createNativeSkillEventJournal({ runtimeId: 'one', request: { runId: 'run' }, bindingDigest: 'binding', events });
  for (let index = 0; index < 1100; index++) port.emit('skill.workflow.started', 'running');
  assert.equal(events.length, 1024); assert.equal(events.at(-1).event_type, 'sandbox.envelope.rejected');
  assert.equal(events.at(-1).error_category, 'event_budget_exceeded');
  assert.ok(Buffer.byteLength(JSON.stringify(events)) < 1024 * 1024);
});

test('explicit Skill consumption requires a committed matching outer step and a Host completion fact', () => {
  const h = journal(), id = h.port.emit('skill.execution.completed', 'completed', { pkg }).skill_invocation_id;
  const receipt = { id: 'step-one', committed: true, at: 100, runId: 'run-one', runtimeId: 'runtime-one', bindingDigest: 'binding-one' };
  const request = { events: h.events, receipt, invocationIds: [id] };
  assert.equal(recordNativeSkillResultConsumption(request)[0].event_type, 'skill.result.consumed');
  assert.equal(recordNativeSkillResultConsumption({ ...request, receipt: { ...receipt, runId: 'foreign' } })[0].event_type, 'sandbox.envelope.rejected');
  assert.throws(() => recordNativeSkillResultConsumption({ ...request, receipt: { ...receipt, committed: false } }), /receipt_required/);
  const child = structuredClone(h.events); child[0].attributes.source = 'sandbox';
  assert.equal(recordNativeSkillResultConsumption({ ...request, events: child })[0].event_type, 'sandbox.envelope.rejected');
});
