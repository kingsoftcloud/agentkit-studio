import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeKernel, MemoryRunStore, emptyUsage } from '../dist/index.mjs';
import { fixture, digest, scope, acceptance, verificationReport } from './fixtures.mjs';

async function run({ acceptances = [acceptance()], report = request => verificationReport(request), workspace, maxRepairs = 0 } = {}) {
  const { config, snapshot } = fixture({ contract: { objective: 'Verify a host-owned acceptance', acceptance: acceptances },
    limits: { maxRepairs } });
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

for (const dependency of ['none', 'required']) test(`an unavailable workspace observation is not a changed candidate; ${dependency} dependency controls verification`, async () => {
  let verifies = 0;
  const { result, store } = await run({ maxRepairs: 3,
    workspace: { observe: async () => ({ revision: null, changedPaths: [], status: 'unavailable', reason: 'capture_limit_exceeded' }) },
    report: request => { verifies++; return verificationReport(request, { workspaceDependency: dependency }); } });
  assert.equal(result.usage.modelCalls, 1); assert.equal(result.repairs, 0); assert.equal(verifies, 1);
  assert.equal(result.finalText, 'Candidate');
  assert.equal(result.reason, dependency === 'none' ? 'required_acceptance_verified' : 'workspace_observation_unavailable');
  assert.equal(result.outcome, dependency === 'none' ? 'verified' : 'unverified');
  assert.equal(result.messages.some(message => message.kind === 'verification_feedback'), false);
  const observations = store.events(scope, 'run').filter(event => event.kind === 'workspace.observation_unavailable');
  assert.ok(observations.length >= 2);
  assert.ok(observations.every(event => event.payload.reason === 'capture_limit_exceeded' && event.payload.changeEstablished === false));
});

test('loss of terminal workspace observation cannot turn a previously passing required file report into verified completion', async () => {
  let observations = 0;
  const { result } = await run({ maxRepairs: 3, workspace: { observe: async () => ++observations <= 2
    ? { status: 'ok', revision: 'before', changedPaths: [], reason: null }
    : { status: 'unavailable', revision: null, changedPaths: [], reason: 'capture_failed' } },
    report: request => verificationReport(request, { workspaceDependency: 'required' }) });
  assert.equal(observations, 3); assert.equal(result.outcome, 'unverified');
  assert.equal(result.reason, 'workspace_observation_unavailable'); assert.equal(result.repairs, 0);
  assert.equal(result.usage.modelCalls, 1); assert.equal(result.finalText, 'Candidate');
});

test('an unbound candidate does not become a proven change when a later workspace observation succeeds', async () => {
  let observations = 0;
  const { result } = await run({ maxRepairs: 3, workspace: { observe: async () => ++observations === 1
    ? { status: 'unavailable', revision: null, changedPaths: [], reason: 'capture_failed' }
    : { status: 'ok', revision: 'first-observed', changedPaths: [], reason: null } },
    report: request => verificationReport(request, { workspaceDependency: 'required' }) });
  assert.equal(result.outcome, 'unverified'); assert.equal(result.reason, 'workspace_observation_unavailable');
  assert.equal(result.repairs, 0); assert.equal(result.usage.modelCalls, 1);
});
