import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSmokeOptions, assertAutomaticProfilePatch, assertManagedSnapshot, selectFixturePlan, assertReplayUnchanged, assertRestoredSchedule } from '../scripts/verify-assistant-automatic-startup.mjs';

test('automatic startup smoke requires explicit archive identity and accepts portable CLI options', () => {
  const sha = 'a'.repeat(64), commit = 'b'.repeat(40);
  const positional = parseSmokeOptions(['installation', 'plugin.tgz', 'report.json', sha]);
  const named = parseSmokeOptions(['--installation', 'installation', '--tgz', 'plugin.tgz', '--report', 'report.json', '--expected-sha256', sha]);
  assert.deepEqual(positional, named); assert.equal(named.sourceCommit, null);
  assert.equal(parseSmokeOptions(['installation', 'plugin.tgz', 'report.json', sha, '--source-commit', commit]).sourceCommit, commit);
  assert.equal(parseSmokeOptions(['installation', 'plugin.tgz', 'report.json', sha, '--profile-migration']).profileMigration, true);
  assert.throws(() => parseSmokeOptions(['installation', 'plugin.tgz', 'report.json']));
  assert.throws(() => parseSmokeOptions(['installation', 'plugin.tgz', 'report.json', 'not-a-digest']));
});

const schedulePatch = '- id: schedule\n  inject: [studioFrozenRuntimeReady]\n';
const providerPatch = '- id: llm-pi-ai\n  name: "@deepseek-ai/dsh-llm-pi-ai"\n  config:\n    providers:\n      agentkit-studio-automatic-fixture:\n        baseURL: http://127.0.0.1:1234/v1\n';

test('automatic profiles require the exact official Schedule readiness dependency', () => {
  assert.equal(assertAutomaticProfilePatch(schedulePatch).scheduleReadinessRows, 1);
  assert.equal(assertAutomaticProfilePatch(schedulePatch + providerPatch).providerSettingsRows, 1);
  assert.equal(assertAutomaticProfilePatch(schedulePatch + '  config: { deliveryHistoryDays: 91, deliveryHistoryRecords: 350 }\n').scheduleReadinessRows, 1);
  assert.equal(assertAutomaticProfilePatch(schedulePatch + '  name: "@deepseek-ai/dsh-schedule"\n  disabled: false\n').scheduleReadinessRows, 1);
  for (const patch of ['[]', providerPatch, '- id: schedule\n', '- id: schedule\n  inject: []\n',
    '- id: schedule\n  inject: [studioFrozenRuntimeReady, fixtureBootstrap]\n', schedulePatch + schedulePatch,
    schedulePatch + '  disabled: true\n', schedulePatch + '  name: fixture-bootstrap\n']) {
    assert.throws(() => assertAutomaticProfilePatch(patch));
  }
});

test('home Settings need no duplicate readiness gate but cannot override Studio or bootstrap', () => {
  const home = { requireScheduleReadiness: false };
  assert.equal(assertAutomaticProfilePatch('[]', home).scheduleReadinessRows, 0);
  assert.equal(assertAutomaticProfilePatch(providerPatch, home).providerSettingsRows, 1);
  for (const patch of ['- id: agentkit-studio\n  disabled: true\n', '- insert:\n    - id: manual-bootstrap\n', '- id: llm-pi-ai\n  name: fixture-bootstrap\n  config: {}\n', '- id: llm-pi-ai\n  disabled: true\n  config: {}\n', providerPatch + providerPatch, schedulePatch + schedulePatch]) {
    assert.throws(() => assertAutomaticProfilePatch(schedulePatch + patch));
    assert.throws(() => assertAutomaticProfilePatch(patch, home));
  }
});

test('replay checks the terminal boundary and original receipt, not an arbitrary sleep', () => {
  const before = { status: 'completed', queuedCount: 0, lastTurnEndSeq: 8, asOfSeq: 8, events: [{ type: 'user/message', seq: 3, data: { source: { rpcId: 'first' } } }] };
  assertReplayUnchanged(before, structuredClone(before), 'first');
  for (const change of [{ status: 'running' }, { queuedCount: 1 }, { lastTurnEndSeq: 9 }, { asOfSeq: 9 }, { events: [] }]) {
    assert.throws(() => assertReplayUnchanged(before, { ...before, ...change }, 'first'));
  }
});

test('title and other auxiliary model requests cannot consume a planned native write', () => {
  const plans = [{ prompt: 'cold startup write' }], body = { messages: [{ role: 'user', content: 'cold startup write' }] };
  assert.equal(selectFixturePlan(body, plans), undefined);
  assert.equal(selectFixturePlan({ ...body, tools: [] }, plans), undefined);
  assert.equal(selectFixturePlan({ ...body, tools: [{ function: { name: 'write' } }] }, plans), plans[0]);
  assert.equal(selectFixturePlan({ ...body, tools: [{ function: { name: 'read' } }] }, plans), plans[0], 'a main request missing write must still reach the write-schema assertion');
});

test('schedule proof binds a unique native message to delivery in the new process', () => {
  const created = { id: 'schedule-fixture', scheduledAt: '2026-01-01T00:00:00.000Z' };
  const schedule = { ...created, status: 'inactive', sessionId: 'assistant-fixture', lastDelivery: { scheduledAt: created.scheduledAt, deliveredAt: '2026-01-01T00:00:02.000Z', messageId: 'message-fixture' } };
  const snapshot = { events: [{ type: 'user/message', data: { id: 'message-fixture', source: { kind: 'schedule' } } }] };
  const value = { schedule, created, snapshot, sessionId: 'assistant-fixture', startedAt: Date.parse('2026-01-01T00:00:01.000Z') };
  assertRestoredSchedule(value);
  assert.throws(() => assertRestoredSchedule({ ...value, startedAt: Date.parse('2026-01-01T00:00:03.000Z') }));
  assert.throws(() => assertRestoredSchedule({ ...value, snapshot: { events: [...snapshot.events, ...snapshot.events] } }));
  assert.throws(() => assertRestoredSchedule({ ...value, schedule: { ...schedule, sessionId: 'foreign' } }));
});

test('restored routine writes require the verified managed permission snapshot', () => {
  const execution = { profile: 'workspace-managed/v1', managed: true, permission: 'workspace-write', approval: 'ask' };
  assertManagedSnapshot({ capabilities: { execution } });
  for (const change of [{ managed: false }, { permission: 'unknown' }, { approval: 'never' }]) {
    assert.throws(() => assertManagedSnapshot({ capabilities: { execution: { ...execution, ...change } } }));
  }
});
