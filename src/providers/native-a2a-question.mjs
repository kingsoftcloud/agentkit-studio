/** Local question ledger. Answers are not operation grants. Its observation
 * stream is delivered only to the owning Studio Session, never to Append. */
import { canonical, copy, invariant } from '../../packages/agentkit-harness-core/dist/index.mjs';
import { a2aPendingApproval, a2aPendingInput, a2aDecisionDigest, normalizeA2aInputParts } from './native-a2a-decision.mjs';
import { a2aIdentity } from './native-a2a-events.mjs';

export const A2A_QUESTION_WAIT = 'agentkit.a2a-question-wait/v1';
export const A2A_QUESTION_LEDGER = 'agentkit.a2a-question-ledger/v1';
const paused = record => ['input_required', 'auth_required'].includes(record.projection.state);
const terminal = new Set(['rejected', 'expired', 'withdrawn', 'operation_admitted', 'operation_denied', 'observed']);
const pending = record => a2aPendingApproval(record) ?? a2aPendingInput(record);
export function a2aQuestionView(record) {
  if (!record.managed || !paused(record)) return null;
  const interaction = pending(record); if (!interaction || interaction.decision) return null;
  const wait = { contract: A2A_QUESTION_WAIT, interactionId: interaction.interactionId,
    continuationId: interaction.continuationId, request: interaction.request, deadlineAt: record.deadlineAt,
    scopeId: record.request.scopeId, taskId: record.platformTaskId,
    target: { local_name: record.request.spec.local_name, target_agent_id: record.request.spec.target_agent_id },
    pauseDigest: a2aDecisionDigest({ state: record.projection.state, pause: record.projection.pause ?? null,
      generation: record.projection.pauseGeneration ?? 0 }) };
  return { ...wait, questionDigest: a2aDecisionDigest(wait) };
}
export function a2aQuestionJournal(record) {
  record.managed.questions ??= { contract: A2A_QUESTION_LEDGER, entries: {}, log: [], nextSeq: 1 };
  const journal = record.managed.questions;
  invariant(journal.contract === A2A_QUESTION_LEDGER && journal.entries && Array.isArray(journal.log)
    && journal.nextSeq === journal.log.length + 1, 'A2A_QUESTION_JOURNAL_INVALID');
  return journal;
}
function fact(record, entry, stage) {
  const journal = a2aQuestionJournal(record), seq = journal.nextSeq, native = record.request.native;
  const parent = native?.runId ?? a2aIdentity('scope', 'dsh', record.owner.agentId, record.owner.sessionId);
  const item = a2aIdentity('item', 'a2a', entry.interactionId, 'host-question');
  const part = { content_type: 'data', part_id: a2aIdentity('part', item, 'status'), data: {
    schema: A2A_QUESTION_LEDGER, interaction_id: entry.interactionId, status: stage,
    target: record.request.spec.local_name, deadline_at: entry.wait.deadlineAt } };
  const event = { schema_version: 2, event_id: a2aIdentity('event', item, seq), seq, timestamp: Date.now() / 1000,
    run_id: parent, run_seq: null, scope_id: record.request.scopeId, parent_scope_id: parent,
    source: { framework: 'a2a', protocol: null, native_event_id: null, native_cursor: null,
      native_run_id: record.projection.taskId, native_item_id: null, metadata: { host_question: true, local_only: true } },
    event_type: stage === 'pending' ? 'item.started' : terminal.has(stage) ? 'item.completed' : 'item.snapshot_replaced',
    item_id: item, item_kind: 'status', ...(stage === 'pending' ? { phase: null, initial: { parts: [part] } }
      : { snapshot: { parts: [part] } }) };
  invariant(journal.log.length < 8192 && Buffer.byteLength(canonical([...journal.log, event])) <= 8 * 1024 ** 2,
    'A2A_QUESTION_JOURNAL_LIMIT');
  journal.log.push(event); journal.nextSeq++; entry.stage = stage;
}
/** Must run under the original call's publication lock with live ownership. */
export function beginA2aQuestion(record, expectedDigest) {
  const wait = a2aQuestionView(record);
  invariant(wait && wait.questionDigest === expectedDigest, 'A2A_QUESTION_STALE');
  const journal = a2aQuestionJournal(record), old = journal.entries[wait.interactionId];
  if (old) { invariant(old.wait.questionDigest === expectedDigest, 'A2A_QUESTION_STALE'); return copy(old); }
  invariant(Object.keys(journal.entries).length < 4096, 'A2A_QUESTION_JOURNAL_LIMIT');
  const entry = { interactionId: wait.interactionId, wait: copy(wait), status: 'pending', createdAt: Date.now() };
  journal.entries[wait.interactionId] = entry; fact(record, entry, 'pending'); return copy(entry);
}
export function answerA2aQuestion(record, expectedDigest, answer) {
  const entry = beginA2aQuestion(record, expectedDigest), journal = a2aQuestionJournal(record);
  invariant(answer && ['approve', 'submit', 'reject'].includes(answer.action)
    && Object.keys(answer).every(key => ['action', 'parts'].includes(key)), 'A2A_QUESTION_ANSWER_INVALID');
  const approval = entry.wait.request.request_type === 'approval';
  invariant(approval ? answer.action !== 'submit' && answer.parts === undefined
    : answer.action !== 'approve' && (answer.action === 'submit' || answer.parts === undefined), 'A2A_QUESTION_ANSWER_INVALID');
  const parts = answer.action === 'submit' ? normalizeA2aInputParts(record, answer.parts) : null;
  const answerDigest = a2aDecisionDigest({ action: answer.action, parts });
  if (entry.status !== 'pending') {
    invariant(entry.answerDigest === answerDigest, 'A2A_QUESTION_ALREADY_ANSWERED'); return entry;
  }
  invariant(Date.now() < entry.wait.deadlineAt, 'A2A_CONTINUATION_DEADLINE_EXCEEDED');
  const current = journal.entries[entry.interactionId];
  Object.assign(current, { status: answer.action === 'approve' ? 'approved' : answer.action === 'submit' ? 'submitted' : 'rejected',
    parts, rawParts: answer.action === 'submit' ? copy(answer.parts) : null, answerDigest, answeredAt: Date.now() });
  fact(record, current, !approval && current.status === 'rejected' ? 'rejected' : 'awaiting_permission');
  if (!approval && current.status === 'rejected') closeA2aQuestion(record, current, 'rejected', 'A2A_INPUT_REJECTED');
  return copy(current);
}
export function closeA2aQuestion(record, entry, outcome, errorCode) {
  invariant(['rejected', 'expired', 'withdrawn', 'operation_denied'].includes(outcome), 'A2A_QUESTION_OUTCOME_INVALID');
  if (record.managed.questionOutcome) return copy(record.managed.questionOutcome);
  if (outcome === 'expired') invariant(Date.now() >= entry.wait.deadlineAt, 'A2A_QUESTION_NOT_EXPIRED');
  const outcomeRecord = { contract: A2A_QUESTION_LEDGER, interactionId: entry.interactionId,
    outcome, errorCode, at: Date.now(), remoteState: record.projection.state };
  record.managed.questionOutcome = outcomeRecord;
  if (entry.stage !== outcome) fact(record, entry, outcome);
  return copy(outcomeRecord);
}
/** Explicit controls may race an automatic answer. They cannot replace it.
 * Called at the actual effect admission point under the same short lock. */
export function admitA2aQuestionEffect(record, control) {
  const interactionId = control.hostDecision?.interactionId;
  const entry = record.managed?.questions?.entries[interactionId]; if (!entry) return;
  if (entry.status !== 'pending') {
    const valid = control.command.kind === 'cancel' || (entry.status === 'submitted' && control.command.kind === 'continue'
      && canonical(control.command.parts) === canonical(entry.parts))
      || entry.status === 'approved' && control.command.kind === 'continue'
        && canonical(control.command.parts) === canonical([{ data: 'approve' }])
      || entry.status === 'rejected' && entry.wait.request.request_type === 'approval' && control.command.kind === 'reject';
    invariant(valid, 'A2A_QUESTION_ANSWER_CONFLICT');
  }
  // Later explicit remote controls retain their own audit/intent. A locally
  // ended question must not acquire a second item.completed lifecycle.
  if (terminal.has(entry.stage)) return;
  invariant(!entry.effectCommandId || entry.effectCommandId === control.command.commandId, 'A2A_QUESTION_EFFECT_ALREADY_ADMITTED');
  entry.effectCommandId = control.command.commandId; fact(record, entry, 'operation_admitted');
}
/** Remote observations can withdraw an unanswered question, never answer it. */
export function retireA2aQuestions(record) {
  const journal = record.managed?.questions; if (!journal) return;
  const activeId = a2aQuestionView(record)?.interactionId ?? null;
  for (const entry of Object.values(journal.entries)) if (entry.interactionId !== activeId && !terminal.has(entry.stage))
    fact(record, entry, entry.status === 'pending' ? 'withdrawn' : 'observed');
}

/** The owning Run has a committed terminal. End its outstanding local waits
 * without sending remote cancellation or replacing a decided answer. */
export function settleA2aQuestions(record) {
  const entries = Object.values(record.managed?.questions?.entries ?? {});
  for (const entry of entries) if (!terminal.has(entry.stage)) {
    const expired = Date.now() >= entry.wait.deadlineAt;
    closeA2aQuestion(record, entry, expired ? 'expired' : 'withdrawn', expired ? 'A2A_OVERALL_TIMEOUT' : 'A2A_INPUT_WITHDRAWN');
  }
}
