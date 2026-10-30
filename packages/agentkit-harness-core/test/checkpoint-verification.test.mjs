import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { MemoryRunStore, NativeKernel, checkpointCandidate, emptyUsage, hookResult, plan, reduceVerification, sealCandidate } from '../dist/index.mjs';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { acceptance, digest, fixture, scope, tool, verificationReport } from './fixtures.mjs';

const finish = () => ({ kind: 'final_candidate', text: 'Done', toolCalls: [], usage: emptyUsage() });
const call = name => ({ ...finish(), kind: 'tool_calls', text: '', toolCalls: [{ callId: name, name, arguments: {} }] });
const stopHook = { hookId: 'stop', sourceRef: 'host://stop', bindingDigest: `sha256:${'a'.repeat(64)}`,
  executionPolicyDigest: `sha256:${'b'.repeat(64)}`, readOnly: true, events: ['Stop'], timeoutMs: 100,
  maxInputBytes: 64000, maxOutputBytes: 64000, failureMode: 'block' };

test('checkpoint boundaries require changed work, model room and a current workspace revision', () => {
  const { config, snapshot } = fixture({ limits: { verificationIdleToolCalls: 4 } });
  const current = { ...snapshot, phase: 'preparing_context', workspaceRevision: 'v2', workspaceDirtySinceCheckpoint: true,
    lastWorkspaceMutationToolCall: 1, usage: { ...snapshot.usage, toolCalls: 5 } };
  assert.equal(checkpointCandidate(current, config, digest).purpose, 'checkpoint');
  for (const change of [{ workspaceDirtySinceCheckpoint: false }, { checkpointWorkspaceRevision: 'v2' },
    { workspaceRevision: null }, { browserReobservationRefs: [{}] }, { lastWorkspaceMutationToolCall: 2 }, { usage: { ...current.usage, toolCalls: 0 } }]) {
    assert.equal(checkpointCandidate({ ...current, ...change }, config, digest), null);
  }
  const exhausted = fixture({ limits: { maxModelCalls: 3, verificationReserveModelCalls: 2 } }).config;
  assert.ok(checkpointCandidate({ ...current, usage: { ...current.usage, modelCalls: 1 } }, exhausted, digest));
  assert.equal(checkpointCandidate({ ...current, usage: { ...current.usage, modelCalls: 2 },
    descendantUsage: { ...current.descendantUsage, modelCalls: 1 } }, exhausted, digest), null);
});

test('a fresh browser observation checkpoints each changed web revision once', () => {
  const { config, snapshot } = fixture({ workspaceObservationPolicy: { role: 'browser', pathSuffixes: ['.html'] } });
  const current = { ...snapshot, workspaceRevision: 'v2', workspaceDirtySinceCheckpoint: true,
    lastWebMutationToolCall: 1, usage: { ...snapshot.usage, toolCalls: 2 }, lastBrowserObservation: { toolCall: 2 } };
  assert.ok(checkpointCandidate(current, config, digest));
  assert.equal(checkpointCandidate({ ...current, lastBrowserObservation: { toolCall: 1 } }, config, digest), null);
  assert.equal(checkpointCandidate({ ...current, checkpointWebMutationToolCall: 1 }, config, digest), null);
});

test('a checkpoint rejects a mismatched report without granting repair or completion', () => {
  const { config, snapshot } = fixture({ contract: { objective: 'Task', acceptance: [acceptance()] } });
  const candidate = sealCandidate({ candidateId: 'checkpoint', purpose: 'checkpoint', text: '', goalRevision: 0, workspaceRevision: null }, snapshot, config, digest);
  const current = { ...snapshot, candidate };
  const report = verificationReport({ candidate, contract: config.contract }, { candidateId: 'another' });
  const result = reduceVerification(current, report, config);
  assert.equal(result.outcome, 'unverified'); assert.equal(result.reason, 'checkpoint_candidate_mismatch');
  assert.equal(result.repairs, undefined); assert.notEqual(result.phase, 'preparing_context');
});

for (const backend of ['memory', 'sqlite']) {
  function state(t) {
    const directory = mkdtempSync(join(tmpdir(), 'native-checkpoint-')), filename = join(directory, 'runs.sqlite');
    let store = backend === 'sqlite' ? new SqliteRunStore(filename) : new MemoryRunStore();
    t.after(() => { store.close?.(); rmSync(directory, { recursive: true, force: true }); });
    return { get store() { return store; }, reopen() { if (backend === 'sqlite') { store.close(); store = new SqliteRunStore(filename); } return store; } };
  }
  for (const scenario of ['passed', 'failed', 'blocked', 'workspace-drift']) test(`${backend}: checkpoint ${scenario} survives reattachment without early completion or Stop`, async t => {
    const status = scenario === 'workspace-drift' ? 'passed' : scenario;
    const data = state(t), { config, snapshot } = fixture({ contract: { objective: 'Task', acceptance: [acceptance()] },
      tools: [tool({ name: 'write', readOnly: false, concurrentSafe: false }), tool()], hooks: [stopHook], stopHookContinuationLimit: 1,
      limits: { verificationIdleToolCalls: 1, finalizationReserveModelCalls: 0 } });
    let modelCalls = 0, tools = 0, verifications = 0, stops = 0, revision = 'v1', observations = 0;
    const ports = { model: { generate: async request => {
      modelCalls++;
      if (modelCalls === 1) return call('write');
      if (modelCalls === 2) return call('read');
      const feedback = request.messages.find(message => message.kind === (scenario === 'workspace-drift' ? 'verification_feedback' : 'verification_observation'));
      assert.ok(feedback); assert.equal(feedback.content.includes('private-evidence-locator'), false);
      if (scenario === 'workspace-drift') assert.match(feedback.content, /workspace changed/);
      if (status !== 'passed') assert.equal(JSON.parse(feedback.content)[status][0].safeSummary, 'Independent observation');
      return finish();
    } }, tools: { execute: async ({ call }) => {
      tools++; if (call.name === 'write') revision = 'v2';
      return { status: 'ok', content: 'Observed', workspaceChangedPaths: call.name === 'write' ? ['app.html'] : [] };
    } }, workspace: { observe: async () => {
      observations++; if (scenario === 'workspace-drift' && verifications === 1) revision = 'v3';
      return { status: 'ok', revision, changedPaths: [] };
    } },
    verification: { verify: async request => {
      verifications++;
      if (verifications === 1) { assert.equal(request.candidate.purpose, 'checkpoint'); assert.equal(request.candidate.text, ''); }
      else assert.notEqual(request.candidate.purpose, 'checkpoint');
      return verificationReport(request, { checks: [{ id: 'test', status: verifications === 1 ? status : 'passed', verifierId: 'fixture', verifierVersion: '1',
        verificationMethod: 'deterministic', evidence: { secret: 'private-evidence-locator' }, evidenceRefs: ['private-evidence-locator'],
        safeSummary: 'Independent observation' }] });
    } }, hooks: { invoke: async request => { stops++; return hookResult(request, 'ok', { action: 'continue', additionalContext: [], updatedArguments: null }); } } };
    const stop = new Error('Stop after checkpoint receipt commit');
    const before = new NativeKernel({ store: data.store, ports, digest, owner: 'before', onCheckpoint: async view => {
      if (view.phase === 'finalizing' && view.candidate?.purpose === 'checkpoint' && view.verification) throw stop;
    } });
    before.start(snapshot, config); await assert.rejects(before.runUntilIdle(scope, 'run'), error => error === stop);
    assert.equal(verifications, 1); assert.equal(stops, 0); assert.equal(modelCalls, 2); assert.equal(tools, 2);
    const committed = data.store.load(scope, 'run').snapshot;
    assert.equal(committed.outcome, null); assert.equal(committed.verificationToolCalls, 2); assert.equal(committed.repairs, 0);
    const postObservations = observations;
    const after = new NativeKernel({ store: data.reopen(), ports, digest, owner: 'after' });
    const result = await after.runUntilIdle(scope, 'run');
    assert.equal(result.phase, 'completed'); assert.equal(result.outcome, 'verified'); assert.equal(result.finalText, 'Done');
    assert.equal(modelCalls, 3); assert.equal(tools, 2); assert.equal(verifications, 2); assert.equal(stops, 1);
    assert.ok(observations > postObservations);
    assert.equal(result.checkpointWorkspaceRevision, scenario === 'workspace-drift' ? null : 'v2');
    assert.equal(result.workspaceDirtySinceCheckpoint, scenario === 'workspace-drift');
    assert.equal(result.repairs, scenario === 'workspace-drift' ? 1 : 0);
    assert.equal(data.store.events(scope, 'run').filter(event => event.kind === 'verification.checkpoint_started').length, 1);
  });
}

test('a checkpoint with no workspace or verification capability does not dispatch a verifier', () => {
  const { config, snapshot } = fixture({ limits: { verificationIdleToolCalls: 1 } });
  const current = { ...snapshot, phase: 'preparing_context', workspaceDirtySinceCheckpoint: true, workspaceRevision: 'v2',
    lastWorkspaceMutationToolCall: 1, usage: { ...snapshot.usage, toolCalls: 2 }, context: { workspaceCursor: '0:0:2:' } };
  for (const capabilities of [{ workspace: false, verification: true }, { workspace: true, verification: false }]) {
    assert.equal(plan(current, config, { ...capabilities, context: false }, digest).intents[0].kind, 'model');
  }
  const blocked = plan({ ...current, toolErrorStreak: { signature: 'same', count: 6, goalRevision: 0,
    workspaceRevision: 'v2', modelCall: 0 } }, config, { workspace: true, verification: true, context: false }, digest);
  assert.equal(blocked.snapshot.reason, 'repeated_tool_error_no_progress'); assert.equal(blocked.intents.length, 0);
});

test('a real process lost inside a checkpoint verifier is never redispatched', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'native-checkpoint-crash-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const child = spawnSync(process.execPath, [new URL('./fixtures/checkpoint-worker.mjs', import.meta.url).pathname, directory],
    { encoding: 'utf8', env: { ...process.env, PATH: '/no-programs' } });
  assert.equal(child.status, 77, child.stderr);
  const store = new SqliteRunStore(join(directory, 'runs.sqlite'));
  try {
    assert.equal(store.load(scope, 'run').intents.find(intent => intent.kind === 'verify').status, 'running');
    const after = new NativeKernel({ store, digest, owner: 'replacement', now: () => 1000,
      ports: { model: { generate: async () => assert.fail('No new model') }, verification: { verify: async () => assert.fail('No verifier replay') } } });
    const result = await after.runUntilIdle(scope, 'run');
    assert.equal(result.phase, 'interrupted'); assert.equal(result.reason, 'effect_outcome_unknown');
    assert.equal(result.verification, null); assert.equal(result.outcome, 'unverified');
    assert.equal(readFileSync(join(directory, 'observations.txt'), 'utf8'), 'once');
  } finally { store.close(); }
});
