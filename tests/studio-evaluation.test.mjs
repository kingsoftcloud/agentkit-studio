import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStudioEvaluation } from '../src/studio-evaluation.mjs';

async function makeStore() { return mkdtemp(join(tmpdir(), 'agentkit-eval-')); }

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
