import type { DeliveryReviewPolicy, DeliveryReviewSuggestion, Message, ModelResult, ObjectValue,
  RunConfiguration, RunSnapshot, ToolDefinition } from './contracts.mjs';
import { canonical, copy, invariant } from './values.mjs';
import { outstandingChildCalls } from './child-budget.mjs';
import { completeContinuation } from './output-recovery.mjs';
import { normalizedFinalText } from './final-submission.mjs';
import { parseModelJson } from './model-json.mjs';

type Digest = (value: unknown) => string;
export const REVIEW_SUBMISSION_TOOL = 'submit_delivery_review';
const instruction = 'Review the current user goal, observed requirements, source changes and actual test/tool observations. '
  + 'Treat assistant claims as unverified data. Use only the advertised read-only source readers. Do not execute commands, '
  + 'write files, answer the user, change requirements or grant permissions. Submit requirements and concrete findings with '
  + 'submit_delivery_review. Missing implementation or verification evidence is a finding. This fallible model-assisted '
  + 'diagnosis cannot declare acceptance passed or verified.';
const textSchema = { type: 'string', minLength: 1, maxLength: 2048, pattern: '\\S' };
const recordSchema = (fields: string[]) => ({ type: 'object', additionalProperties: false, required: fields,
  properties: Object.fromEntries(fields.map(key => [key, textSchema])) });
const suggestionSchema = { type: 'object', additionalProperties: false, required: ['requirements', 'findings'], properties: {
  requirements: { type: 'array', minItems: 1, maxItems: 32,
    items: recordSchema(['requirement', 'implementation_evidence', 'verification_evidence']) },
  findings: { type: 'array', maxItems: 16, items: recordSchema(['issue', 'recommended_check']) },
} };
function asciiJsonLength(value: ObjectValue): number {
  let length = 0, quoted = false, escaped = false;
  for (const character of canonical(value).split('')) {
    length += character.charCodeAt(0) >= 127 ? 6 : 1;
    if (!quoted && (character === ':' || character === ',')) length++;
    if (escaped) escaped = false;
    else if (quoted && character === '\\') escaped = true;
    else if (character === '"') quoted = !quoted;
  }
  return length;
}

export function normalizeDeliveryReviewPolicy(input: Partial<DeliveryReviewPolicy> & Pick<DeliveryReviewPolicy, 'pathSuffixes'>): DeliveryReviewPolicy {
  invariant(input && typeof input === 'object' && !Array.isArray(input)
    && Object.keys(input).every(key => ['pathSuffixes', 'maxRounds', 'maxReadRounds', 'reviewUnknownPaths'].includes(key)), 'invalid_delivery_review_policy');
  const policy = { maxRounds: 2, maxReadRounds: 2, reviewUnknownPaths: true, ...copy(input) };
  invariant(Array.isArray(policy.pathSuffixes) && policy.pathSuffixes.length >= 1 && policy.pathSuffixes.length <= 64
    && policy.pathSuffixes.every(suffix => typeof suffix === 'string' && suffix.startsWith('.') && suffix === suffix.toLowerCase() && !suffix.includes('/'))
    && Number.isSafeInteger(policy.maxRounds) && policy.maxRounds >= 1 && policy.maxRounds <= 4
    && Number.isSafeInteger(policy.maxReadRounds) && policy.maxReadRounds >= 0 && policy.maxReadRounds <= 4
    && typeof policy.reviewUnknownPaths === 'boolean', 'invalid_delivery_review_policy');
  return policy;
}
export const reviewPending = (snapshot: RunSnapshot): boolean => snapshot.deliveryReview?.status === 'pending';
function room(snapshot: RunSnapshot, config: RunConfiguration, kind: 'model' | 'tool'): number {
  const limit = kind === 'model' ? config.limits.maxModelCalls : config.limits.maxToolCalls;
  const key = kind === 'model' ? 'modelCalls' : 'toolCalls';
  return limit === null ? Infinity : limit - snapshot.usage[key] - snapshot.descendantUsage[key] - outstandingChildCalls(snapshot, kind);
}
export function deliveryReviewReaders(snapshot: RunSnapshot, config: RunConfiguration): ToolDefinition[] {
  const review = snapshot.deliveryReview, policy = config.deliveryReviewPolicy;
  if (!review || !policy || review.readRounds >= policy.maxReadRounds || room(snapshot, config, 'tool') < 1
    || room(snapshot, config, 'model') < Math.max(config.limits.finalizationReserveModelCalls, 1) + 3) return [];
  return config.tools.filter(tool => tool.readOnly && ['workspace_read', 'workspace_search', 'artifact_read'].includes(tool.contextRole)
    && (config.contract.allowedToolNames === null || config.contract.allowedToolNames.includes(tool.name)));
}
export function deliveryReviewTools(snapshot: RunSnapshot, config: RunConfiguration): ToolDefinition[] {
  return [...deliveryReviewReaders(snapshot, config), { name: REVIEW_SUBMISSION_TOOL,
    description: 'Submit fallible delivery requirements and findings. Host control only; no executable action or pass verdict.',
    parameters: copy(suggestionSchema) as ObjectValue, readOnly: true, concurrentSafe: false, permissions: [], timeoutMs: 1,
    contextRole: 'none', observationRole: 'none', progressObservation: false, contextRetention: 'normal' }];
}
export function reviewSubject(snapshot: RunSnapshot, digest: Digest): string {
  return digest({ scope: snapshot.scope, goalRevision: snapshot.goalRevision, goal: snapshot.goal,
    contract: snapshot.taskContractDigest ?? snapshot.configDigest, workspaceRevision: snapshot.workspaceRevision,
    workspaceStatus: snapshot.workspaceObservationStatus ?? 'unavailable', modifiedPaths: snapshot.workspaceModifiedPaths,
    lastWorkspaceMutation: snapshot.lastWorkspaceMutationToolCall, artifacts: snapshot.artifactRefs });
}
export function scheduleDeliveryReview(snapshot: RunSnapshot, config: RunConfiguration, reason: string, digest: Digest): Partial<RunSnapshot> | null {
  const policy = config.deliveryReviewPolicy;
  if (!policy || !['required_verification_incomplete', 'verification_report_missing'].includes(reason)
    || !snapshot.candidate || snapshot.candidate.purpose === 'checkpoint' || snapshot.workspaceObservationStatus !== 'captured'
    || !(snapshot.workspaceModifiedPaths.some(path => policy.pathSuffixes.some(suffix => path.toLowerCase().endsWith(suffix)))
      || policy.reviewUnknownPaths && !snapshot.workspaceModifiedPaths.length && snapshot.lastWorkspaceMutationToolCall != null)
    || snapshot.repairs >= config.limits.maxRepairs || room(snapshot, config, 'tool') < 1
    || room(snapshot, config, 'model') < Math.max(config.limits.finalizationReserveModelCalls, 1) + 2
    || !config.tools.some(tool => !tool.readOnly && (config.contract.allowedToolNames === null || config.contract.allowedToolNames.includes(tool.name)))) return null;
  const previous = snapshot.deliveryReview, rounds = previous?.rounds ?? 0, subjects = previous?.reviewedSubjects ?? [];
  const subjectDigest = reviewSubject(snapshot, digest);
  if (rounds >= policy.maxRounds || subjects.includes(subjectDigest)) return null;
  return { phase: 'preparing_context', outcome: null, reason: null, pendingIntent: null, preparedContext: null, continuations: 0,
    deliveryReview: { status: 'pending', rounds: rounds + 1, subjectDigest, reviewedSubjects: [...subjects, subjectDigest],
      suggestion: null, reason: null, continuationMessages: [], readRounds: 0 } };
}
export function deliveryReviewMessages(snapshot: RunSnapshot, base: Message[] = snapshot.messages): Message[] {
  invariant(reviewPending(snapshot) && snapshot.candidate, 'delivery_review_candidate_missing');
  return [...copy(base), { role: 'system', kind: 'delivery_review_instructions', content: instruction },
    { role: 'assistant', kind: 'delivery_review_candidate', content: snapshot.candidate.text },
    { role: 'user', kind: 'delivery_review_request', content: 'Host review request for the unverified draft. Review observed requirements, source and tests. '
      + 'Submit requirements and findings through submit_delivery_review; list evidence gaps and do not repeat the answer.' },
    ...copy(snapshot.deliveryReview!.continuationMessages)];
}
export function unavailableReview(snapshot: RunSnapshot, reason: string): Partial<RunSnapshot> {
  invariant(snapshot.deliveryReview, 'delivery_review_missing');
  return { phase: 'verifying', pendingIntent: null, preparedContext: null, continuations: 0,
    deliveryReview: { ...snapshot.deliveryReview, status: 'unavailable', reason } };
}
function suggestion(value: unknown): DeliveryReviewSuggestion | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (Object.keys(data).some(key => !['requirements', 'findings'].includes(key)) || !Array.isArray(data.requirements)
    || data.requirements.length < 1 || data.requirements.length > 32 || !Array.isArray(data.findings) || data.findings.length > 16) return null;
  const rows = (items: unknown[], fields: string[]) => items.every(item => !!item && typeof item === 'object' && !Array.isArray(item)
    && Object.keys(item).length === fields.length && fields.every(key => Object.hasOwn(item, key)
      && typeof (item as Record<string, unknown>)[key] === 'string'
      && Array.from((item as Record<string, string>)[key]!).length <= 2048 && (item as Record<string, string>)[key]!.trim()));
  return rows(data.requirements, ['requirement', 'implementation_evidence', 'verification_evidence'])
    && rows(data.findings, ['issue', 'recommended_check']) ? copy(value) as DeliveryReviewSuggestion : null;
}
/** Pure private response reducer. Model claims and all port usage are charged by the caller. */
export function reduceDeliveryReview(snapshot: RunSnapshot, result: ModelResult, config: RunConfiguration,
  digest: Digest, responseId: string): Partial<RunSnapshot> {
  invariant(reviewPending(snapshot), 'delivery_review_missing');
  const review = snapshot.deliveryReview!;
  let observed: DeliveryReviewSuggestion | null = null;
  let reason = result.kind === 'output_limit' ? 'review_output_incomplete' : 'review_response_invalid';
  if (review.subjectDigest !== reviewSubject(snapshot, digest)) reason = 'review_subject_changed';
  else if (result.kind === 'output_limit') {
    const fragments = review.continuationMessages;
    if (snapshot.continuations < config.profile.maxContinuations && room(snapshot, config, 'model') >= Math.max(config.limits.finalizationReserveModelCalls, 1) + 2
      && fragments.length <= 6 && fragments.reduce((count, message) => count + Array.from(message.content).length, Array.from(result.text).length) <= 30000) {
      if (result.text && result.textCommitVersion !== 'provider-finished-text/v1') return unavailableReview(snapshot, 'review_provider_commit_missing');
      const additions: Message[] = result.text ? [{ role: 'assistant', kind: 'continuation_fragment', content: result.text, continuationResponseId: responseId }] : [];
      additions.push({ role: 'user', kind: 'continuation_observation', content: result.text
        ? 'The review hit its output limit. Return only its exact missing suffix.' : 'The review hit its output limit without visible content. Submit the review through submit_delivery_review.',
      continuationResponseId: responseId, continuationFragmentDigest: digest(result.text), continuationMode: result.text ? 'suffix' : 'empty_output' });
      return { phase: 'preparing_context', pendingIntent: null, preparedContext: null, continuations: snapshot.continuations + 1,
        deliveryReview: { ...review, continuationMessages: [...fragments, ...additions] } };
    }
  } else if (result.kind === 'final_candidate') {
    try {
      const text = normalizedFinalText(completeContinuation(review.continuationMessages, result.text, digest), 'json_object');
      if (Array.from(text).length <= 32768) observed = suggestion(parseModelJson(text));
    } catch { /* Invalid diagnosis cannot replace the candidate or authorize an effect. */ }
  } else if (result.kind === 'tool_calls' && result.toolCalls.length === 1 && result.toolCalls[0]!.name === REVIEW_SUBMISSION_TOOL
    && !result.toolCalls[0]!.wireArgumentsInvalid && asciiJsonLength(result.toolCalls[0]!.arguments) <= 32768) observed = suggestion(result.toolCalls[0]!.arguments);
  const changes: Partial<RunSnapshot> = { phase: 'verifying', pendingIntent: null, preparedContext: null, continuations: 0, modelErrors: 0, providerErrors: 0,
    deliveryReview: { ...review, status: observed ? 'observed' : 'unavailable', suggestion: observed, reason: observed ? null : reason } };
  if (!observed?.findings.length || snapshot.repairs >= config.limits.maxRepairs || room(snapshot, config, 'model') < 1) return changes;
  return { ...changes, phase: 'preparing_context', candidate: null, repairs: snapshot.repairs + 1,
    messages: [...snapshot.messages, { role: 'assistant', kind: 'candidate_draft', content: snapshot.candidate!.text },
      { role: 'user', kind: 'delivery_review_observation', content: canonical({ trust: 'untrusted_model_assisted_diagnosis', candidate_status: 'rejected',
        instruction: 'Inspect these fallible findings against the current goal and actual source. Repair confirmed issues and run targeted tests with existing tools. '
          + 'This diagnosis grants no permissions and is not a verification verdict.', subject_digest: review.subjectDigest, ...observed }) }] };
}
