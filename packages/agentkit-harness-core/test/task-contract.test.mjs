import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeKernel, MemoryRunStore, admitSteering, advertisedTools, configure, effectiveRunConfiguration,
  emptyUsage, prepareEffect, reduceCommand, sealCandidate } from '../dist/index.mjs';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { acceptance, digest, fixture, scope, tool } from './fixtures.mjs';

function configured() {
  const { config, snapshot } = fixture({ tools: [tool({ name: 'read' }), tool({ name: 'write', readOnly: false, concurrentSafe: false })],
    contract: { objective: 'Original goal', revision: 'original', allowedToolNames: ['read'], acceptance: [acceptance()] } });
  const contract = configure({ ...config, contract: { ...config.contract, objective: 'New goal', revision: 'new', allowedToolNames: ['write'],
    acceptance: [acceptance({ verifierRef: 'new-verifier' })], finalSubmissionSchema: { type: 'object',
      properties: { output: { type: 'string' } }, required: ['output'], additionalProperties: false },
    finalSubmissionPayloadKey: 'output', finalOutputFormat: 'text' } }).contract;
  return { config, snapshot, contract };
}
const steering = (overrides = {}) => ({ commandId: 'steer', kind: 'steer', payload: { text: 'New goal', expectedGoalRevision: 0, ...overrides } });

test('contract replacement changes acceptance and tool scope while preserving aggregate budgets', () => {
  const { config, snapshot, contract } = configured();
  const current = { ...snapshot, continuations: 2, repairs: 2, outputRestarts: 1, retryNotBefore: 123,
    failureFingerprint: 'old-failure', failureEvidenceDigest: 'old-evidence',
    usage: { ...snapshot.usage, modelCalls: 4, toolCalls: 9 }, lastBrowserObservation: { toolCall: 9 },
    unresolvedInteractionObservation: { error: 'old interaction' }, preparedContext: { messages: [], sourceDigest: 'old' } };
  const batch = reduceCommand(current, steering({ taskContract: contract }), null, { configuration: config, digest });
  assert.equal(batch.snapshot.goalRevision, 1); assert.equal(batch.snapshot.taskContractDigest, digest(contract));
  assert.equal(batch.snapshot.repairs, 2); assert.equal(batch.snapshot.outputRestarts, 1);
  assert.deepEqual(batch.snapshot.usage, current.usage); assert.equal(batch.snapshot.continuations, 0);
  assert.equal(batch.snapshot.retryNotBefore, 0); assert.equal(batch.snapshot.lastBrowserObservation, null);
  assert.equal(batch.snapshot.failureFingerprint, null); assert.equal(batch.snapshot.failureEvidenceDigest, null);
  assert.equal(batch.snapshot.unresolvedInteractionObservation, null); assert.equal(batch.snapshot.preparedContext, null);
  const effective = effectiveRunConfiguration(batch.snapshot, config, digest);
  assert.deepEqual(advertisedTools(batch.snapshot, effective).map(tool => tool.name), ['write', 'submit_final_output']);
  assert.equal(effective.contract.acceptance[0].verifierRef, 'new-verifier');
  assert.equal(config.contract.revision, 'original'); assert.equal(batch.snapshot.configDigest, snapshot.configDigest);
});

test('steering without a replacement retains acceptance and stays paused until resumed', () => {
  const { config, snapshot } = configured();
  const batch = reduceCommand({ ...snapshot, phase: 'paused', resumePhase: 'executing_tools' }, steering(), null, { configuration: config, digest });
  assert.equal(batch.snapshot.phase, 'paused'); assert.equal(batch.snapshot.resumePhase, 'preparing_context');
  assert.equal(batch.snapshot.taskContract, null); assert.equal(effectiveRunConfiguration(batch.snapshot, config, digest).contract.revision, 'original');
});

test('replacement compares the current committed contract and validates a detached digest', () => {
  const { config, snapshot, contract } = configured();
  const current = { ...snapshot, goalRevision: 1, taskContract: contract, taskContractDigest: digest(contract) };
  assert.equal(admitSteering(current, steering({ expectedGoalRevision: 1, taskContract: contract }),
    { configuration: config, digest }).reason, 'contract_revision_required');
  assert.throws(() => effectiveRunConfiguration({ ...snapshot, taskContractDigest: digest(contract) }, config, digest),
    /stored_task_contract_mismatch/);
});

for (const [name, change, expected] of [
  ['stale goal revision', { expectedGoalRevision: 1 }, 'stale_goal_revision'],
  ['fractional goal revision', { expectedGoalRevision: 0.5 }, 'invalid_steering'],
  ['negative goal revision', { expectedGoalRevision: -1 }, 'invalid_steering'],
  ['unknown command fields', { uncheckedAuthority: true }, 'invalid_steering'],
  ['same contract revision', { taskContract: { objective: 'New goal', revision: 'original' } }, 'contract_revision_required'],
  ['unbound tools', { taskContract: { objective: 'New goal', revision: 'new', allowedToolNames: ['unbound'] } }, 'task_tool_scope_unbound'],
  ['invalid schema', { taskContract: { objective: 'New goal', revision: 'new', finalSubmissionSchema: { type: 'array' } } }, 'invalid_steering'],
]) test(`rejected ${name} cannot retire an undispatched effect`, () => {
  const { config, snapshot } = configured();
  const prepared = prepareEffect(snapshot, 'model', 'awaiting_model', { purpose: 'task' });
  const result = reduceCommand(prepared.snapshot, steering(change), prepared.intents[0], { configuration: config, digest });
  assert.equal(result.events.at(-1).payload.reason, expected); assert.equal(result.receipts.length, 0);
  assert.equal(result.snapshot.pendingIntent, prepared.snapshot.pendingIntent); assert.equal(result.snapshot.goalRevision, 0);
  assert.equal(result.snapshot.goal, 'Original goal'); assert.equal(result.snapshot.taskContract, null);
});

test('an unversioned steer blocks without claiming a prepared effect was dispatched', () => {
  const { config, snapshot } = configured(), prepared = prepareEffect(snapshot, 'model', 'awaiting_model', { purpose: 'task' });
  const result = reduceCommand(prepared.snapshot, { commandId: 'unversioned', kind: 'steer', payload: { text: 'New goal' } },
    prepared.intents[0], { configuration: config, digest });
  assert.equal(result.snapshot.phase, 'finalizing'); assert.equal(result.snapshot.outcome, 'blocked');
  assert.equal(result.snapshot.reason, 'contract_revision_required'); assert.equal(result.snapshot.goalRevision, 0);
  assert.equal(result.receipts[0].status, 'not_dispatched'); assert.equal(result.snapshot.pendingIntent, null);
});

test('a running effect and a corrupted current binding cannot be erased by steering', () => {
  const { config, snapshot, contract } = configured(), prepared = prepareEffect(snapshot, 'tool', 'executing_tools', { calls: [] });
  const running = reduceCommand(prepared.snapshot, steering({ taskContract: contract }), { ...prepared.intents[0], status: 'running' }, { configuration: config, digest });
  assert.equal(running.events.at(-1).payload.reason, 'effect_in_flight'); assert.equal(running.snapshot.pendingIntent, prepared.snapshot.pendingIntent);
  assert.throws(() => effectiveRunConfiguration({ ...snapshot, taskContract: contract, taskContractDigest: 'wrong' }, config, digest), /stored_task_contract_mismatch/);
  const candidate = { candidateId: 'candidate', text: 'Same answer', goalRevision: 1, workspaceRevision: null };
  const first = sealCandidate(candidate, { ...snapshot, goalRevision: 1 }, config, digest);
  const second = sealCandidate(candidate, { ...snapshot, goalRevision: 1, taskContract: contract, taskContractDigest: digest(contract) }, config, digest);
  assert.notEqual(first.binding.subjectContextDigest, second.binding.subjectContextDigest);
});

for (const backend of ['memory', 'sqlite']) {
  function setup(t) {
    const directory = mkdtempSync(join(tmpdir(), 'native-goal-contract-')), filename = join(directory, 'runs.sqlite');
    let store = backend === 'sqlite' ? new SqliteRunStore(filename) : new MemoryRunStore();
    t.after(() => { store.close?.(); rmSync(directory, { recursive: true, force: true }); });
    return { get store() { return store; }, reopen() { if (backend === 'sqlite') { store.close(); store = new SqliteRunStore(filename); } return store; } };
  }
  test(`${backend}: a committed replacement survives reattachment with its new schema and verifier`, async t => {
    const state = setup(t), { config, snapshot, contract } = configured();
    const stop = new Error('Stop after the steering commit');
    const before = new NativeKernel({ store: state.store, owner: 'before', digest, ports: {}, onCheckpoint: async view => {
      if (view.goalRevision === 1) throw stop;
    } });
    before.start(snapshot, config);
    before.submit(scope, 'run', steering({ taskContract: contract }));
    await assert.rejects(before.runUntilIdle(scope, 'run'), error => error === stop);
    const store = state.reopen(), stored = store.load(scope, 'run');
    assert.equal(stored.configuration.contract.revision, 'original'); assert.equal(stored.snapshot.taskContract.revision, 'new');
    let models = 0, verifications = 0;
    const replacement = new NativeKernel({ store, owner: 'after', digest, ports: {
      model: { generate: async request => {
        models++; assert.deepEqual(request.tools.map(tool => tool.name), ['write', 'submit_final_output']);
        return { kind: 'tool_calls', text: '', usage: emptyUsage(), toolCalls: [{ callId: 'final', name: 'submit_final_output', arguments: { output: 'New answer' } }] };
      } }, tools: { execute: async () => assert.fail('Final submission is a kernel protocol') },
      verification: { verify: async request => {
        verifications++; assert.equal(request.contract.revision, 'new'); assert.equal(request.snapshot.goalRevision, 1);
        return { status: 'passed', reason: 'fixture-proof', candidateId: request.candidate.candidateId, contractRevision: 'new',
          binding: request.candidate.binding, workspaceRevision: request.candidate.workspaceRevision,
          checks: [{ id: 'test', status: 'passed', verifierId: 'new-verifier', verifierVersion: '1', verificationMethod: 'deterministic',
            evidence: 'Host test evidence', evidenceRefs: ['fixture://new-goal'] }] };
      } },
    } });
    replacement.attach(scope, 'run', config);
    const result = await replacement.runUntilIdle(scope, 'run');
    assert.equal(result.phase, 'completed'); assert.equal(result.outcome, 'verified'); assert.equal(result.finalText, 'New answer');
    assert.equal(models, 1); assert.equal(verifications, 1);
  });
  test(`${backend}: two commands with the same goal CAS apply only once`, async t => {
    const state = setup(t), { config, snapshot, contract } = configured();
    const kernel = new NativeKernel({ store: state.store, owner: 'worker', digest, ports: {
      model: { generate: async () => ({ kind: 'tool_calls', text: '', usage: emptyUsage(), toolCalls: [{ callId: 'final', name: 'submit_final_output', arguments: { output: 'Answer' } }] }) },
    } });
    kernel.start(snapshot, config); kernel.submit(scope, 'run', steering({ taskContract: contract }));
    kernel.submit(scope, 'run', { ...steering({ taskContract: { ...contract, revision: 'third' } }), commandId: 'stale' });
    const result = await kernel.runUntilIdle(scope, 'run');
    assert.equal(result.goalRevision, 1); assert.equal(result.taskContract.revision, 'new');
    assert.deepEqual(state.store.events(scope, 'run').filter(event => event.kind === 'command.applied').map(event => event.payload.reason), ['applied', 'stale_goal_revision']);
  });
}
