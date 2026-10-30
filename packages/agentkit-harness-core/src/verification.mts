import type { CompletionCandidate, RunConfiguration, RunSnapshot, VerificationReport, WorkspaceObservation } from './contracts.mjs';
import { canonical, invariant } from './values.mjs';
import { outstandingChildCalls } from './child-budget.mjs';
import { NativePolicyRegistry } from './policy-registry.mjs';
import { deliveryScopeEnabled, currentDeliveryManifest } from './deliverables.mjs';
import { workspaceObservationSubject } from './workspace-subject.mjs';

function modelFeedbackItem(check: VerificationReport['checks'][number]) {
  return { id: check.id, status: check.status, safeSummary: check.safeSummary ?? '', repairable: check.repairable === true };
}

/** Missing observation is not a positive observation of change. Only two
 * observed revisions can establish that a candidate's workspace is stale. */
export function candidateWorkspaceContinuity(candidate: CompletionCandidate, observation: WorkspaceObservation,
  subject: string | null = null): 'same' | 'changed' | 'unobserved' {
  if (candidate.workspaceSubject !== undefined && candidate.workspaceSubject !== subject) return 'unobserved';
  if (observation.status !== 'ok' || !observation.revision || !candidate.workspaceRevision) return 'unobserved';
  return candidate.workspaceRevision === observation.revision ? 'same' : 'changed';
}

/** Verify changed work while there is still model room to consume the observation. */
export function checkpointCandidate(snapshot: RunSnapshot, config: RunConfiguration,
  digest: (value: unknown) => string): CompletionCandidate | null {
  if (deliveryScopeEnabled(config) && !currentDeliveryManifest(snapshot)) return null;
  const remaining = config.limits.maxModelCalls === null ? Infinity
    : config.limits.maxModelCalls - snapshot.usage.modelCalls - snapshot.descendantUsage.modelCalls - outstandingChildCalls(snapshot, 'model');
  const reserve = config.limits.verificationReserveModelCalls, idle = config.limits.verificationIdleToolCalls ?? 0;
  const budgetBoundary = reserve > 0 && Number.isFinite(remaining) && remaining <= reserve;
  const idleBoundary = idle > 0 && snapshot.lastWorkspaceMutationToolCall != null
    && snapshot.usage.toolCalls - snapshot.lastWorkspaceMutationToolCall >= idle;
  const browserBoundary = !!config.workspaceObservationPolicy && snapshot.lastWebMutationToolCall != null
    && snapshot.lastWebMutationToolCall > (snapshot.checkpointWebMutationToolCall ?? 0)
    && snapshot.lastBrowserObservation?.toolCall === snapshot.usage.toolCalls
    && snapshot.usage.toolCalls >= snapshot.lastWebMutationToolCall;
  if (remaining <= 0 || snapshot.browserReobservationRefs?.length || !snapshot.usage.toolCalls || !snapshot.workspaceDirtySinceCheckpoint
    || snapshot.workspaceRevision === null || snapshot.workspaceRevision === snapshot.checkpointWorkspaceRevision
    || !(budgetBoundary || idleBoundary || browserBoundary)) return null;
  return sealCandidate({ candidateId: `${snapshot.runId}:checkpoint:${snapshot.goalRevision}:${snapshot.usage.modelCalls}:${snapshot.usage.toolCalls}`,
    text: '', purpose: 'checkpoint', goalRevision: snapshot.goalRevision, workspaceRevision: snapshot.workspaceRevision }, snapshot, config, digest);
}

/** A checkpoint only gives bounded repair feedback; even a pass cannot finish the Run. */
export function finishCheckpoint(snapshot: RunSnapshot): Partial<RunSnapshot> {
  invariant(snapshot.candidate?.purpose === 'checkpoint' && snapshot.verification, 'checkpoint_report_missing');
  const checks = snapshot.verification.checks;
  return { phase: 'preparing_context', candidate: null, preparedContext: null, outcome: null, reason: null,
    checkpointWorkspaceRevision: snapshot.workspaceRevision, checkpointWebMutationToolCall: snapshot.lastWebMutationToolCall,
    workspaceDirtySinceCheckpoint: false,
    messages: checks.length ? [...snapshot.messages, { role: 'user', kind: 'verification_observation', content: canonical({
      instruction: 'Repair observed failures and complete remaining acceptance checks before final delivery. Blocked checks were not verified; inspect their reported cause before treating them as passed.',
      contractRevision: snapshot.verification.contractRevision,
      failed: checks.filter(check => check.status === 'failed').map(modelFeedbackItem), blocked: checks.filter(check => check.status === 'blocked').map(modelFeedbackItem),
      notRun: checks.filter(check => check.status === 'not_run').map(modelFeedbackItem),
    }) }] : snapshot.messages };
}

/** Bind verification to the candidate, committed model context and host environment. */
export function sealCandidate(candidate: CompletionCandidate, snapshot: RunSnapshot, configuration: RunConfiguration,
  digest: (value: unknown) => string): CompletionCandidate {
  if (configuration.workspaceCapturePolicy === 'declared-subjects/v1') {
    const subject = workspaceObservationSubject(snapshot, configuration), key = subject ? digest(subject) : null;
    candidate = { ...candidate, workspaceSubject: key,
      workspaceRevision: key === (snapshot.workspaceObservationSubject ?? null) ? candidate.workspaceRevision : null };
  }
  return { ...candidate, binding: {
    subjectDigest: digest({ text: candidate.text, workspaceRevision: candidate.workspaceRevision,
      ...(candidate.workspaceSubject !== undefined ? { workspaceSubject: candidate.workspaceSubject } : {}),
      ...(candidate.purpose === 'checkpoint' ? { purpose: 'checkpoint' } : {}) }),
    subjectContextDigest: digest({ messages: snapshot.messages, goalRevision: candidate.goalRevision,
      configDigest: snapshot.configDigest, artifactRefs: snapshot.artifactRefs,
      ...(deliveryScopeEnabled(configuration) ? { deliveryManifest: snapshot.deliveryManifest ?? null } : {}),
      ...(snapshot.taskContract ? { taskContractDigest: snapshot.taskContractDigest } : {}),
      ...(snapshot.browserSessionRefs?.length || snapshot.lastBrowserObservation ? {
        browserSessionRefs: snapshot.browserSessionRefs, browserObservation: snapshot.lastBrowserObservation,
      } : {}) }),
    environmentDigest: configuration.hostBindingDigest,
  } };
}

/** Only a pinned required check with host-owned evidence can qualify completion. */
export function reduceVerification(snapshot: RunSnapshot, report: VerificationReport, config: RunConfiguration,
  digest: (value: unknown) => string = canonical, policies = new NativePolicyRegistry()): Partial<RunSnapshot> {
  invariant(['passed', 'failed', 'unverified'].includes(report.status) && Array.isArray(report.checks), 'invalid_verification_report');
  invariant(new Set(report.checks.map(check => check.id)).size === report.checks.length
    && report.checks.every(check => ['passed', 'failed', 'not_run', 'blocked', 'unverified'].includes(check.status)), 'invalid_verification_checks');
  let reportBound = false;
  const finish = (outcome: RunSnapshot['outcome'], reason: string): Partial<RunSnapshot> => ({
    pendingIntent: null, phase: 'finalizing', verification: report, outcome,
    verificationToolCalls: reportBound ? snapshot.usage.toolCalls : null,
    reason: snapshot.candidate?.purpose === 'checkpoint' ? `checkpoint_${reason}` : reason,
    ...policies.forRun(config).review.scheduleDeliveryReview({ ...snapshot, verification: report,
      verificationToolCalls: reportBound ? snapshot.usage.toolCalls : null }, config, reason, digest),
  });
  const candidate = snapshot.candidate;
  invariant(candidate, 'verification_candidate_missing');
  const items = new Map(config.contract.acceptance.map(item => [item.id, item]));
  invariant(report.checks.every(check => items.has(check.id)), 'unknown_verification_check');
  if (report.candidateId !== candidate.candidateId) return finish('unverified', 'candidate_mismatch');
  if (report.contractRevision !== config.contract.revision) return finish('unverified', 'contract_revision_mismatch');
  if (!candidate.binding || !report.binding) return finish('unverified', 'subject_context_digest_missing');
  for (const key of ['subjectDigest', 'subjectContextDigest', 'environmentDigest'] as const) {
    if (report.binding[key] !== candidate.binding[key]) return finish('unverified', `${key}_mismatch`);
  }
  if (report.workspaceDependency === 'required' && (!candidate.workspaceRevision || !snapshot.workspaceRevision))
    return finish('unverified', 'workspace_observation_unavailable');
  if (report.workspaceDependency !== 'none' && config.workspaceCapturePolicy === 'declared-subjects/v1'
    && candidate.workspaceSubject !== (snapshot.workspaceObservationSubject ?? null))
    return finish('unverified', 'workspace_subject_mismatch');
  if (report.workspaceDependency !== 'none' && report.workspaceRevision !== candidate.workspaceRevision) return finish('unverified', 'candidate_workspace_changed');
  for (const check of report.checks) {
    const item = items.get(check.id)!;
    if (check.verifierId !== item.verifierRef || check.verifierVersion !== item.verifierVersion
      || check.verificationMethod !== item.verificationMethod) return finish('unverified', 'verifier_identity_mismatch');
    invariant(check.evidenceRefs === undefined || Array.isArray(check.evidenceRefs)
      && check.evidenceRefs.every(ref => typeof ref === 'string' && ref.trim()), 'invalid_verification_evidence');
  }
  reportBound = true;
  if (candidate.purpose === 'checkpoint' && deliveryScopeEnabled(config)
    && report.checks.some(check => check.status === 'blocked' && items.get(check.id)?.required))
    return finish('blocked', 'required_acceptance_blocked');
  if (candidate.purpose === 'checkpoint') return { pendingIntent: null, phase: 'finalizing', verification: report,
    verificationToolCalls: snapshot.usage.toolCalls, outcome: null, reason: null };
  const required = config.contract.acceptance.filter(item => item.required);
  if (!required.length) return finish('unverified', 'required_acceptance_empty');
  const results = new Map(report.checks.map(check => [check.id, check]));
  const observations = required.map(item => results.get(item.id));
  const qualified = observations.filter(check => check?.status === 'passed' && check.evidenceRefs?.length
    && check.verificationMethod !== 'model_assisted');
  if (qualified.length === required.length) return finish('verified', 'required_acceptance_verified');
  if (observations.some(check => check?.status === 'blocked')) return finish('blocked', 'required_acceptance_blocked');
  const outcome = qualified.length ? 'partial' : 'unverified';
  if (observations.some(check => !check)) return finish(outcome, 'required_verification_incomplete');
  if (observations.some(check => check?.status === 'passed'
    && (!check.evidenceRefs?.length || check.verificationMethod === 'model_assisted'))) return finish(outcome, 'qualified_evidence_missing');
  const actionable = observations.some(check => check && ['failed', 'not_run'].includes(check.status)
    && (report.repairable || check.repairable) && check.safeSummary?.trim() && check.evidenceRefs?.length);
  if (!actionable) return finish(outcome, observations.some(check => check?.status === 'not_run' || check?.status === 'unverified')
    ? 'required_verification_incomplete' : 'required_acceptance_failed');
  if (snapshot.repairs >= config.limits.maxRepairs) return finish(outcome, 'repair_budget_exhausted');
  if (!report.failureFingerprint?.trim()) return finish(outcome, 'failure_fingerprint_missing');
  // Changing an artifact locator is not progress on the verified subject.
  const evidenceDigest = digest({ subject: report.binding.subjectDigest, environment: report.binding.environmentDigest,
    items: report.checks.map(check => ({ id: check.id, status: check.status, verifierId: check.verifierId ?? '',
      verifierVersion: check.verifierVersion ?? '', safeSummary: check.safeSummary ?? '' }))
      .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0) });
  if (snapshot.failureFingerprint === report.failureFingerprint && snapshot.failureEvidenceDigest === evidenceDigest) {
    return finish(outcome, 'repeated_verification_failure');
  }
  return { pendingIntent: null, phase: 'preparing_context', verification: report, repairs: snapshot.repairs + 1,
    verificationToolCalls: snapshot.usage.toolCalls,
    candidate: null, preparedContext: null, outcome: null, reason: null, continuations: 0,
    failureFingerprint: report.failureFingerprint, failureEvidenceDigest: evidenceDigest,
    messages: [...snapshot.messages, { role: 'user', kind: 'verification_feedback', content: canonical({
      instruction: 'Repair failed required items and host-marked actionable unobserved items, then verify again. Unobserved is not passed.',
      contractRevision: config.contract.revision, candidateStatus: 'rejected',
      failed: report.checks.filter(check => check.status === 'failed').map(modelFeedbackItem),
      notRun: report.checks.filter(check => check.status === 'not_run').map(modelFeedbackItem),
    }) }] };
}
