import type { CompletionCandidate, RunConfiguration, RunSnapshot, VerificationReport } from './contracts.mjs';
import { canonical, invariant } from './values.mjs';

/** Bind verification to the candidate, committed model context and host environment. */
export function sealCandidate(candidate: CompletionCandidate, snapshot: RunSnapshot, configuration: RunConfiguration,
  digest: (value: unknown) => string): CompletionCandidate {
  return { ...candidate, binding: {
    subjectDigest: digest({ text: candidate.text, workspaceRevision: candidate.workspaceRevision }),
    subjectContextDigest: digest({ messages: snapshot.messages, goalRevision: candidate.goalRevision,
      configDigest: snapshot.configDigest, artifactRefs: snapshot.artifactRefs }),
    environmentDigest: configuration.hostBindingDigest,
  } };
}

/** Only a pinned required check with host-owned evidence can qualify completion. */
export function reduceVerification(snapshot: RunSnapshot, report: VerificationReport, config: RunConfiguration): Partial<RunSnapshot> {
  invariant(['passed', 'failed', 'unverified'].includes(report.status) && Array.isArray(report.checks), 'invalid_verification_report');
  invariant(new Set(report.checks.map(check => check.id)).size === report.checks.length
    && report.checks.every(check => ['passed', 'failed', 'not_run', 'blocked', 'unverified'].includes(check.status)), 'invalid_verification_checks');
  const finish = (outcome: RunSnapshot['outcome'], reason: string): Partial<RunSnapshot> => ({
    pendingIntent: null, phase: 'finalizing', verification: report, outcome, reason,
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
  if (report.workspaceDependency !== 'none' && report.workspaceRevision !== candidate.workspaceRevision) return finish('unverified', 'candidate_workspace_changed');
  for (const check of report.checks) {
    const item = items.get(check.id)!;
    if (check.verifierId !== item.verifierRef || check.verifierVersion !== item.verifierVersion
      || check.verificationMethod !== item.verificationMethod) return finish('unverified', 'verifier_identity_mismatch');
    invariant(check.evidenceRefs === undefined || Array.isArray(check.evidenceRefs)
      && check.evidenceRefs.every(ref => typeof ref === 'string' && ref.trim()), 'invalid_verification_evidence');
  }
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
  return { pendingIntent: null, phase: 'preparing_context', verification: report, repairs: snapshot.repairs + 1,
    candidate: null, outcome: null, reason: null,
    messages: [...snapshot.messages, { role: 'user', kind: 'verification_feedback', content: canonical(report) }] };
}
