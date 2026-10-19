import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyWindowsCandidateEvidence } from '../scripts/windows-candidate-evidence.mjs';

const run = { status: 'completed', conclusion: 'success', event: 'workflow_dispatch', path: '.github/workflows/release-windows.yml' };
const names = ['Verify immutable Studio source', 'Package the official DSH Windows target', 'Prepare verified signed candidate reuse',
  'Verify timestamped installer and actual installation', 'Verify the actually installed Windows App UI'];
const job = patch => ({ steps: names.map(name => ({ name, conclusion: patch[name] || 'success' })) });

test('signed bytes with a failed UI gate may be recovered for requalification but cannot be published', () => {
  const failed = { ...run, conclusion: 'failure' }, evidence = job({ 'Verify the actually installed Windows App UI': 'failure' });
  assert.equal(verifyWindowsCandidateEvidence(failed, evidence).installedUiVerified, false);
  assert.throws(() => verifyWindowsCandidateEvidence(failed, evidence, { requireUi: true }), /successful qualification/);
});

test('publication requires all original signature and native UI checks', () => {
  assert.equal(verifyWindowsCandidateEvidence(run, job({}), { requireUi: true }).installedUiVerified, true);
  for (const name of names.filter(name => name !== 'Prepare verified signed candidate reuse')) {
    assert.throws(() => verifyWindowsCandidateEvidence(run, job({ [name]: 'failure' }), { requireUi: true }), /has not passed/);
  }
});

test('reused bytes require a successful reuse, installation and UI qualification chain', () => {
  const reused = { 'Package the official DSH Windows target': 'skipped' };
  assert.equal(verifyWindowsCandidateEvidence(run, job(reused), { requireUi: true }).reused, true);
  for (const name of ['Prepare verified signed candidate reuse', 'Verify timestamped installer and actual installation', 'Verify the actually installed Windows App UI']) {
    assert.throws(() => verifyWindowsCandidateEvidence(run, job({ ...reused, [name]: 'failure' })), /has not passed/);
  }
});

test('an unfinished or different workflow never qualifies', () => {
  for (const patch of [{ status: 'in_progress' }, { event: 'pull_request' }, { path: '.github/workflows/ci.yml' }]) {
    assert.throws(() => verifyWindowsCandidateEvidence({ ...run, ...patch }, job({})), /manual Windows release/);
  }
});
