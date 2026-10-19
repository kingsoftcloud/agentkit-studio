import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStudioEvaluation } from '../src/studio-evaluation.mjs';

async function makeStore() { return mkdtemp(join(tmpdir(), 'agentkit-eval-')); }

async function waitForPublishedRun(evaluation, runId, { observe = () => {}, until = record => record?.completedAt && ['succeeded', 'partial', 'failed'].includes(record.status) } = {}) {
  const deadline = performance.now() + 5000;
  let record;
  while (performance.now() < deadline) {
    record = await evaluation.getRun(runId);
    observe(record);
    if (until(record)) return record;
    // Yield to the producer's asynchronous filesystem work. Read counts are
    // not a completion clock, especially with parallel CI workers.
    await new Promise(setImmediate);
  }
  assert.fail(`evaluation did not reach the expected published state (last status: ${record?.status || 'missing'})`);
}

test('evalset native and studio_suite formats parse with assertions', async () => {
  const store = await makeStore();
  const evaluation = createStudioEvaluation({ storeDir: store });
  try {
    const native = await evaluation.importEvalset({ content: '[{ "id": "c1", "input": "hello", "assertions": [{ "type": "response.contains", "value": "hi" }] }]', fileName: 'native.json' });
    assert.equal(native.sourceFormat, 'native');
    assert.equal(native.caseCount, 1);

    const studio = await evaluation.importEvalset({ content: 'apiVersion: schedule.ksadk.io/v1\nkind: EvalSet\nmetadata:\n  name: my-set\ncases:\n  - id: c1\n    input: test\n    assertions:\n      - type: response.contains\n        value: ok', fileName: 'my-set.yaml' });
    assert.equal(studio.sourceFormat, 'studio_suite/v0');
    assert.equal(studio.name, 'my-set');
    assert.equal(studio.cases[0].input, 'test');

    const listed = await evaluation.listEvalsets();
    assert.equal(listed.items.length, 2);
  } finally { await rm(store, { recursive: true, force: true }); }
});

test('evaluation without a runner records pending then honest failure', async () => {
  const store = await makeStore();
  const evaluation = createStudioEvaluation({ storeDir: store });
  try {
    const imported = await evaluation.importEvalset({ content: '[{ "id": "c1", "input": "hello", "assertions": [{ "type": "response.contains", "value": "hi" }] }]', fileName: 'native.json' });
    const run = await evaluation.createEvaluation({ evalsetId: imported.id, target: 'build_test', agentId: 'ar-1', config: {} });
    assert.equal(run.status, 'pending');
    for (let i = 0; i < 20; i++) { await new Promise(r => setTimeout(r, 25)); const current = await evaluation.getRun(run.id); if (current?.status === 'failed') break; }
    const done = await evaluation.getRun(run.id);
    assert.equal(done.status, 'failed');
    assert.equal(done.summary.skipped, 1);
    assert.match(done.caseResults[0].error, /run 合同/);
  } finally { await rm(store, { recursive: true, force: true }); }
});

test('evaluation with a runner executes cases and evaluates assertions', async () => {
  const store = await makeStore();
  const evaluation = createStudioEvaluation({ storeDir: store, runner: async ({ input }) => ({ output: 'hello world', toolCalls: [], tokenUsage: { inputTokens: 10, outputTokens: 5 }, latencyMs: 5 }) });
  try {
    const imported = await evaluation.importEvalset({ content: '[{ "id": "c1", "input": "hi", "assertions": [{ "type": "response.contains", "value": "hello" }, { "type": "runtime.maxOutputTokens", "value": 100 }] }]', fileName: 'native.json' });
    const run = await evaluation.createEvaluation({ evalsetId: imported.id, target: 'build_test', agentId: 'ar-1', config: {} });
    for (let i = 0; i < 40; i++) { await new Promise(r => setTimeout(r, 25)); const current = await evaluation.getRun(run.id); if (current?.status === 'succeeded') break; }
    const done = await evaluation.getRun(run.id);
    assert.equal(done.status, 'succeeded');
    assert.equal(done.summary.passed, 1);
    assert.equal(done.caseResults[0].assertions.length, 2);
    assert.equal(done.caseResults[0].assertions.every(item => item.passed), true);
  } finally { await rm(store, { recursive: true, force: true }); }
});

test('the Studio create contract resolves a frozen target before running and respects JSON Schema', async () => {
  const store = await makeStore(); const seen = [];
  const evaluation = createStudioEvaluation({ storeDir: store, resolveTarget: async id => ({ id, agentId: 'frozen-agent' }), runner: async request => { seen.push(request); return { output: '{"value":"wrong-type"}', toolCalls: [] }; } });
  try {
    const imported = await evaluation.importEvalset({ content: JSON.stringify([{ input: 'check', assertions: [{ type: 'response.jsonSchema', value: { type: 'object', properties: { value: { type: 'number' } }, required: ['value'] } }] }]), fileName: 'schema.json' });
    const run = await evaluation.createEvaluation({ evalsetFile: imported.id, target: { kind: 'studio_build', locator: 'build-frozen' } });
    const done = await waitForPublishedRun(evaluation, run.id);
    assert.equal(seen[0].agentId, 'frozen-agent'); assert.equal(seen[0].buildId, 'build-frozen');
    assert.equal(done.status, 'failed'); assert.equal(done.summary.failed, 1);
  } finally { await rm(store, { recursive: true, force: true }); }
});

test('polling a running evaluation never observes a partially written record', async () => {
  const store = await makeStore();
  const releaseRunner = Promise.withResolvers();
  const evaluation = createStudioEvaluation({ storeDir: store, runner: async () => { await releaseRunner.promise; return { output: 'ok'.repeat(1024), toolCalls: [] }; } });
  try {
    const imported = await evaluation.importEvalset({ content: JSON.stringify(Array.from({ length: 24 }, (_, i) => ({ id: `case-${i}`, input: 'check', assertions: [{ type: 'response.contains', value: 'ok' }] }))), fileName: 'poll.json' });
    const run = await evaluation.createEvaluation({ evalsetId: imported.id, target: 'build-poll', agentId: 'agent-poll' });
    await waitForPublishedRun(evaluation, run.id, { until: record => record?.status === 'running' });
    let missing = 0, startedReaders = 0;
    await Promise.all(Array.from({ length: 8 }, async () => {
      let firstRead = true;
      const done = await waitForPublishedRun(evaluation, run.id, { observe(record) {
        if (!record) missing++;
        if (firstRead) {
          firstRead = false;
          assert.equal(record?.status, 'running', 'every reader must observe the live run before completion is released');
          if (++startedReaders === 8) releaseRunner.resolve();
        }
      } });
      assert.equal(done.status, 'succeeded'); assert.equal(done.summary.passed, 24);
    }));
    assert.equal(missing, 0, 'a published run must remain readable while its status is updated');
  } finally { releaseRunner.resolve(); await rm(store, { recursive: true, force: true }); }
});
