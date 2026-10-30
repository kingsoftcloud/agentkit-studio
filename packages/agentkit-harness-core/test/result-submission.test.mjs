import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NativeKernel, MemoryRunStore, RESULT_DELIVERY_POLICY, DELIVERY_SCOPE_POLICY, deliveryToolDefinitions,
  finalSubmissionTool, emptyUsage, canonical, configure, sealCandidate } from '../dist/index.mjs';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { fixture, scope, digest, tool, acceptance, verificationReport } from './fixtures.mjs';

const response = (args, text = '') => ({ kind: args ? 'tool_calls' : 'final_candidate', text,
  toolCalls: args ? [{ callId: 'result', name: 'submit_final_output', arguments: args }] : [], usage: emptyUsage() });
const configuration = overrides => ({ deliveryScopePolicy: RESULT_DELIVERY_POLICY,
  tools: deliveryToolDefinitions(RESULT_DELIVERY_POLICY), ...overrides });

for (const backend of ['memory', 'sqlite']) test(`${backend}: final answer and artifact scope commit together without an external effect or second model call`, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'atomic-result-'));t.after(() => rmSync(dir, { recursive: true, force: true }));
  let store = backend === 'sqlite' ? new SqliteRunStore(join(dir, 'runs.sqlite')) : new MemoryRunStore();
  const { config, snapshot } = fixture(configuration({ limits: { maxModelCalls: 1, maxToolCalls: 0 } }));
  let models = 0;
  const ports = { model: { generate: async request => {
    models++;assert.deepEqual(request.tools.map(tool => tool.name), ['submit_final_output']);
    return response({ answer: 'The report is ready.', artifacts: [{ path: 'report.md', kind: 'file' }] });
  } }, tools: { execute: async () => assert.fail('no tool effect') } };
  let kernel = new NativeKernel({ store, owner: 'result', digest, ports });kernel.start(snapshot, config);
  const done = await kernel.runUntilIdle(scope, 'run');
  assert.equal(done.finalText, 'The report is ready.');assert.equal(done.phase, 'completed');
  assert.equal(done.outcome, 'unverified');assert.equal(models, 1);assert.equal(done.usage.toolCalls, 0);
  assert.deepEqual(done.deliveryManifest.artifacts, [{ path: 'report.md', kind: 'file' }]);
  const record = store.load(scope, 'run');assert.equal(record.intents.filter(i => i.kind === 'tool').length, 0);
  assert.equal(done.candidate.binding.subjectContextDigest, sealCandidate(done.candidate, done, config, digest).binding.subjectContextDigest);
  if (backend === 'sqlite') { store.close();store = new SqliteRunStore(join(dir, 'runs.sqlite')); }
  kernel = new NativeKernel({ store, owner: 'cold', digest, ports });
  assert.equal((await kernel.runUntilIdle(scope, 'run')).finalText, done.finalText);assert.equal(models, 1);
  if (backend === 'sqlite') store.close();
});

test('ordinary prose with reference-file mutations ends without a declaration-repair round', async () => {
  const store = new MemoryRunStore(), { config, snapshot } = fixture(configuration());let models = 0;
  const state = { ...snapshot, workspaceModifiedPaths: ['references/source.js'], workspaceRevision: 'reference-revision' };
  const kernel = new NativeKernel({ store, owner: 'text', digest, ports: { model: { generate: async () => {
    models++;return response(null, 'Here is the research answer.');
  } } } });kernel.start(state, config);
  const done = await kernel.runUntilIdle(scope, 'run');
  assert.equal(models, 1);assert.equal(done.phase, 'completed');assert.equal(done.finalText, 'Here is the research answer.');
  assert.deepEqual(done.deliveryManifest.artifacts, []);assert.equal(done.repairs, 0);
});

for (const repeat of [false, true]) test(`an early web selection is retained at final submission (${repeat ? 'repeated' : 'omitted'} artifacts)`, async () => {
  const store = new MemoryRunStore(), { config, snapshot } = fixture(configuration());let models = 0;
  const artifacts = [{ path: 'game/index.html', kind: 'web', root: 'game' }];
  const kernel = new NativeKernel({ store, owner: 'early', digest, ports: {
    tools: { execute: async () => assert.fail('declaration is a pure control') }, model: { generate: async () => {
    if (++models === 1) return { kind: 'tool_calls', text: '', usage: emptyUsage(), toolCalls: [
      { callId: 'early', name: 'declare_deliverables', arguments: { artifacts } }] };
    return response({ answer: 'Game result.', ...(repeat ? { artifacts } : {}) });
  } } } });kernel.start(snapshot, config);
  const done = await kernel.runUntilIdle(scope, 'run');assert.equal(done.deliveryManifest.revision, 1);
  assert.deepEqual(done.deliveryManifest.artifacts, artifacts);assert.equal(done.usage.toolCalls, 1);
  assert.equal(done.usage.modelCalls, 2);assert.equal(done.finalText, 'Game result.');
});

test('atomic web scope still reaches the pinned verifier and cannot approve itself', async () => {
  const store = new MemoryRunStore(), { config, snapshot } = fixture(configuration({ contract: {
    objective: 'Deliver the game', acceptance: [acceptance()] } }));let verified = 0;
  const kernel = new NativeKernel({ store, owner: 'web', digest, ports: {
    model: { generate: async () => response({ answer: 'Game ready.', artifacts: [{ path: 'game/index.html', kind: 'web', root: 'game' }] }) },
    verification: { verify: async request => {
      verified++;assert.deepEqual(request.snapshot.deliveryManifest.artifacts, [{ path: 'game/index.html', kind: 'web', root: 'game' }]);
      return verificationReport(request, { status: 'failed', reason: 'browser_unavailable', checks: [{ ...verificationReport(request).checks[0],
        status: 'blocked', safeSummary: 'Browser unavailable', repairable: false }] });
    } },
  } });kernel.start(snapshot, config);
  const done = await kernel.runUntilIdle(scope, 'run');
  assert.equal(verified, 1);assert.equal(done.outcome, 'blocked');assert.equal(done.repairs, 0);
});

test('invalid paths and mixed final/write batches cause no writes and no partial artifact selection', async () => {
  for (const invalid of [[{ path: '../outside.html', kind: 'web', root: '.' }],
    [{ path: 'index.html', kind: 'web', root: 'other' }],
    [{ path: 'x.html', kind: 'web', root: '.' }, { path: 'y.html', kind: 'web', root: '.' }]]) {
    const store = new MemoryRunStore(), { config, snapshot } = fixture(configuration({ profile: { ...fixture().config.profile, maxRetries: 0 } }));
    const kernel = new NativeKernel({ store, owner: 'bad', digest, ports: { model: {
      generate: async () => response({ answer: 'No', artifacts: invalid }) } } });kernel.start(snapshot, config);
    const done = await kernel.runUntilIdle(scope, 'run');assert.equal(done.candidate, null);assert.equal(done.deliveryManifest, undefined);
    assert.equal(done.reason, 'final_submission_retry_exhausted');
  }
  const store = new MemoryRunStore(), { config, snapshot } = fixture(configuration({
    tools: [...deliveryToolDefinitions(RESULT_DELIVERY_POLICY), tool({ name: 'write', readOnly: false, concurrentSafe: false })],
    profile: { ...fixture().config.profile, maxRetries: 0 } }));
  const mixed = response({ answer: 'No', artifacts: [] });mixed.toolCalls.push({ callId: 'write', name: 'write', arguments: {} });
  const kernel = new NativeKernel({ store, owner: 'mixed', digest, ports: { model: { generate: async () => mixed },
    tools: { execute: async () => assert.fail('mixed batch must not run') } } });kernel.start(snapshot, config);
  const done = await kernel.runUntilIdle(scope, 'run');assert.equal(done.deliveryManifest, undefined);assert.equal(done.usage.toolCalls, 0);
});

test('an explicit output contract keeps its exact type and validation inside the atomic answer', async () => {
  const contract = { objective: 'Return count', finalSubmissionSchema: { type: 'object', required: ['count'],
    additionalProperties: false, properties: { count: { type: 'integer' } } }, finalSubmissionPayloadKey: null, finalOutputFormat: 'json_object' };
  const store = new MemoryRunStore(), { config, snapshot } = fixture(configuration({ contract }));let models = 0;
  const kernel = new NativeKernel({ store, owner: 'json', digest, ports: { model: { generate: async () =>
    response({ answer: { count: ++models === 1 ? '42' : 42 }, artifacts: [] }) } } });kernel.start(snapshot, config);
  const done = await kernel.runUntilIdle(scope, 'run');assert.equal(models, 2);assert.equal(done.finalText, '{"count":42}');
});

test('historical configurations and their tool definitions keep their original identities', () => {
  for (const policy of [undefined, DELIVERY_SCOPE_POLICY]) {
    const { config } = fixture(policy ? { deliveryScopePolicy: policy, tools: deliveryToolDefinitions(policy) } : {});
    assert.equal(finalSubmissionTool(config), null);assert.equal(canonical(configure(config)), canonical(config));
    assert.equal(config.policyModules.some(p => p.id === 'native.delivery-results'), false);
  }
  const { config } = fixture(configuration());
  assert.equal(config.policyModules.some(p => p.id === 'native.delivery-results'), true);
  assert.equal(config.policyModules.some(p => p.id === 'native.delivery-scope'), false);
});
