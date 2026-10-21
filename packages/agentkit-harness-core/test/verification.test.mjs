import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeKernel, MemoryRunStore, emptyUsage } from '../dist/index.mjs';
import { fixture, digest, scope, acceptance, verificationReport } from './fixtures.mjs';

async function run({ acceptances = [acceptance()], report = request => verificationReport(request), workspace } = {}) {
  const { config, snapshot } = fixture({ contract: { objective: 'Verify a host-owned acceptance', acceptance: acceptances },
    limits: { maxRepairs: 0 } });
  const store = new MemoryRunStore();
  const kernel = new NativeKernel({ store, owner: 'fixture', digest, ports: {
    model: { generate: async () => ({ kind: 'final_candidate', text: 'Candidate', toolCalls: [], usage: emptyUsage() }) },
    tools: { execute: async () => { throw new Error('No fixture tools allowed'); } },
    verification: { verify: report }, ...(workspace ? { workspace } : {}),
  } });
  kernel.start(snapshot, config);
  return { result: await kernel.runUntilIdle(scope, 'run'), store };
}

test('verified completion requires a pinned required check and nonempty evidence references', async () => {
  const { result } = await run();
  assert.equal(result.outcome, 'verified');
  assert.equal(result.reason, 'required_acceptance_verified');
  assert.equal(result.verification.binding.subjectContextDigest, result.candidate.binding.subjectContextDigest);
  assert.equal(result.verificationToolCalls, 0);
  const missing = await run({ report: request => {
    const report = verificationReport(request); report.checks[0].evidenceRefs = []; return report;
  } });
  assert.equal(missing.result.outcome, 'unverified');
  assert.equal(missing.result.reason, 'qualified_evidence_missing');
});

test('a model-assisted pass cannot qualify as verified completion', async () => {
  const { result } = await run({ acceptances: [acceptance({ verificationMethod: 'model_assisted' })], report: request => {
    const report = verificationReport(request); report.checks[0].verificationMethod = 'model_assisted'; return report;
  } });
  assert.equal(result.outcome, 'unverified');
  assert.equal(result.reason, 'qualified_evidence_missing');
});

for (const [field, replacement, reason] of [
  ['candidateId', 'previous-candidate', 'candidate_mismatch'],
  ['contractRevision', 'previous-contract', 'contract_revision_mismatch'],
  ['binding', { subjectDigest: 'different', subjectContextDigest: 'different', environmentDigest: 'different' }, 'subjectDigest_mismatch'],
]) test(`stale ${field} cannot verify the current candidate`, async () => {
  const { result } = await run({ report: request => verificationReport(request, { [field]: replacement }) });
  assert.equal(result.outcome, 'unverified'); assert.equal(result.reason, reason); assert.equal(result.repairs, 0);
  assert.equal(result.verificationToolCalls, null);
});

test('partially qualified acceptance retains a partial outcome and never becomes a full pass', async () => {
  const { result } = await run({ acceptances: [acceptance(), acceptance({ id: 'second' })], report: request => {
    const report = verificationReport(request);
    return { ...report, status: 'failed', checks: [...report.checks, { ...report.checks[0], id: 'second', status: 'failed' }] };
  } });
  assert.equal(result.outcome, 'partial');
  assert.equal(result.reason, 'required_acceptance_failed');
});

test('a workspace change after verification invalidates a prior passing report before terminal commit', async () => {
  let observations = 0;
  const { result, store } = await run({ workspace: { observe: async () => ({
    revision: ++observations <= 2 ? 'before' : 'after', changedPaths: observations <= 2 ? [] : ['changed.txt'], status: 'ok', reason: null,
  }) } });
  assert.equal(observations, 3);
  assert.equal(result.outcome, 'unverified');
  assert.equal(result.reason, 'candidate_workspace_changed');
  assert.equal(result.verification, null);
  assert.equal(result.candidate, null);
  assert.equal(store.load(scope, 'run').receipts.filter(receipt => receipt.result.status === 'passed').length, 1);
  assert.notEqual(store.events(scope, 'run').at(-1).payload.outcome, 'verified');
});
