/** Separate recoverable signed bytes from fully qualified publication evidence. */
export function verifyWindowsCandidateEvidence(run, job, { requireUi = false } = {}) {
  if (run.status !== 'completed' || run.event !== 'workflow_dispatch' || run.path !== '.github/workflows/release-windows.yml') throw Error('Candidate build must be a completed manual Windows release run');
  const conclusion = name => job?.steps.find(step => step.name === name)?.conclusion;
  const reused = conclusion('Package the official DSH Windows target') === 'skipped';
  if ((requireUi || reused) && run.conclusion !== 'success') throw Error('Publication requires a successful qualification run');
  for (const name of ['Verify immutable Studio source', reused ? 'Prepare verified signed candidate reuse' : 'Package the official DSH Windows target',
    'Verify timestamped installer and actual installation', ...(requireUi || reused ? ['Verify the actually installed Windows App UI'] : [])]) {
    if (conclusion(name) !== 'success') throw Error(`Original candidate has not passed ${name}`);
  }
  return { reused, installedUiVerified: conclusion('Verify the actually installed Windows App UI') === 'success' };
}
