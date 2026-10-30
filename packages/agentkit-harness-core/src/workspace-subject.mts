import type { RunConfiguration, RunSnapshot, WorkspaceObservationSubject } from './contracts.mjs';
import { currentDeliveryManifest, deliveryArtifacts } from './deliverables.mjs';
import { invariant } from './values.mjs';

/** Select observation subjects, never execution permissions or acceptance. An
 * absent declaration retains whole-workspace observation; [] means text only. */
export function workspaceObservationSubject(snapshot: RunSnapshot, config: RunConfiguration): WorkspaceObservationSubject | null {
  if (config.workspaceCapturePolicy !== 'declared-subjects/v1') return null;
  const manifest = currentDeliveryManifest(snapshot);
  return manifest ? { contract: 'agentkit.delivery-observation-subject/v1', goalRevision: manifest.goalRevision,
    manifestRevision: manifest.revision, artifacts: deliveryArtifacts(manifest.artifacts) } : null;
}

export function validateWorkspaceObservationSubject(value: unknown): WorkspaceObservationSubject {
  const subject = value as WorkspaceObservationSubject;
  invariant(subject && typeof subject === 'object' && !Array.isArray(subject)
    && Object.keys(subject).sort().join(',') === 'artifacts,contract,goalRevision,manifestRevision'
    && subject.contract === 'agentkit.delivery-observation-subject/v1'
    && Number.isSafeInteger(subject.goalRevision) && subject.goalRevision >= 0
    && Number.isSafeInteger(subject.manifestRevision) && subject.manifestRevision > 0, 'invalid_workspace_observation_subject');
  return { ...subject, artifacts: deliveryArtifacts(subject.artifacts) };
}
