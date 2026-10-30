import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryRunStore, NativeKernel, emptyUsage, reduceVerification, sealCandidate } from '../dist/index.mjs';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { acceptance, digest, fixture, scope, verificationReport } from './fixtures.mjs';

function failure(request, number, summary = 'Repair the observed script error') {
  const report = verificationReport(request, { status: 'failed', repairable: true, failureFingerprint: 'same-defect' });
  report.checks[0] = { ...report.checks[0], status: 'failed', safeSummary: summary, repairable: true,
    evidence: { privateDiagnostic: 'private-payload' }, evidenceRefs: [`fixture://private/${number}`] };
  return report;
}

test('a verifier repair starts a new response chain without giving the model audit locations', () => {
  const { config, snapshot } = fixture({ contract: { objective: 'Task', acceptance: [acceptance()] } });
  const candidate = sealCandidate({ candidateId: 'candidate', text: 'Draft', goalRevision: 0, workspaceRevision: null }, snapshot, config, digest);
  const current = { ...snapshot, candidate, continuations: 2, outputRestarts: 1,
    usage: { ...snapshot.usage, modelCalls: 7, toolCalls: 9 } };
  const report = failure({ candidate, contract: config.contract }, 1);
  const result = reduceVerification(current, report, config, digest);
  assert.equal(result.continuations, 0); assert.equal(result.repairs, 1); assert.equal(result.candidate, null);
  assert.equal(result.verificationToolCalls, 9);
  assert.equal(result.outputRestarts, undefined); assert.equal(result.usage, undefined);
  assert.equal(result.verification, report);
  const feedback = result.messages.at(-1);
  assert.equal(feedback.content.includes('fixture://private'), false);
  assert.equal(feedback.content.includes('private-payload'), false);
  assert.deepEqual(JSON.parse(feedback.content).failed[0], { id: 'test', status: 'failed',
    safeSummary: 'Repair the observed script error', repairable: true });
});

test('a mismatched new report cannot inherit a previous verification cursor', () => {
  const { config, snapshot } = fixture({ contract: { objective: 'Task', acceptance: [acceptance()] } });
  const candidate = sealCandidate({ candidateId: 'new', text: 'Draft', goalRevision: 0, workspaceRevision: null }, snapshot, config, digest);
  const report = verificationReport({ candidate, contract: config.contract }, { candidateId: 'old' });
  const result = reduceVerification({ ...snapshot, candidate, verificationToolCalls: 8 }, report, config, digest);
  assert.equal(result.verificationToolCalls, null); assert.equal(result.reason, 'candidate_mismatch');
});

for (const backend of ['memory', 'sqlite']) for (const variation of ['locator-only', 'diagnostic', 'subject']) {
  test(`${backend}: ${variation} changes after a persisted repair do not confuse evidence with progress`, async t => {
    const directory = mkdtempSync(join(tmpdir(), 'native-verification-repair-')), filename = join(directory, 'runs.sqlite');
    let store = backend === 'sqlite' ? new SqliteRunStore(filename) : new MemoryRunStore();
    t.after(() => { store.close?.(); rmSync(directory, { recursive: true, force: true }); });
    const { config, snapshot } = fixture({ contract: { objective: 'Task', acceptance: [acceptance()] },
      limits: { maxModelCalls: 6, maxRepairs: 3 } });
    let models = 0, verifiers = 0;
    const ports = { model: { generate: async request => {
      models++;
      assert.equal(JSON.stringify(request.messages).includes('fixture://private'), false);
      assert.equal(JSON.stringify(request.messages).includes('private-payload'), false);
      return { kind: 'final_candidate', text: variation === 'subject' && models > 1 ? 'New draft' : 'Draft', toolCalls: [], usage: emptyUsage() };
    } }, verification: { verify: async request => {
      verifiers++;
      if (variation !== 'locator-only' && verifiers === 3) return verificationReport(request);
      return failure(request, verifiers, variation === 'diagnostic' && verifiers === 2 ? 'A different observed script error' : undefined);
    } } };
    const stop = new Error('Repair commit persisted');
    const before = new NativeKernel({ store, ports, digest, owner: 'before', onCheckpoint: async view => {
      if (view.repairs === 1 && view.phase === 'preparing_context') throw stop;
    } });
    before.start(snapshot, config); await assert.rejects(before.runUntilIdle(scope, 'run'), error => error === stop);
    const committed = store.load(scope, 'run').snapshot;
    assert.equal(committed.failureFingerprint, 'same-defect'); assert.ok(committed.failureEvidenceDigest);
    assert.equal(committed.verification.checks[0].evidenceRefs[0], 'fixture://private/1');
    if (backend === 'sqlite') { store.close(); store = new SqliteRunStore(filename); }
    const after = new NativeKernel({ store, ports, digest, owner: 'after' });
    const result = await after.runUntilIdle(scope, 'run');
    if (variation === 'locator-only') {
      assert.equal(result.outcome, 'unverified'); assert.equal(result.reason, 'repeated_verification_failure');
      assert.equal(result.repairs, 1); assert.equal(models, 2); assert.equal(verifiers, 2);
      assert.equal(result.verification.checks[0].evidenceRefs[0], 'fixture://private/2');
    } else {
      assert.equal(result.outcome, 'verified'); assert.equal(result.repairs, 2);
      assert.equal(models, 3); assert.equal(verifiers, 3);
    }
  });
}
