/** Independent, no-remote-side-effect question presenter for A2A managed
 * structured-input / remote-approval waits. Surfaces a remote interaction prompt
 * through the maintained DSH `ctx.userQuestions.ask` UI seam only. It performs
 * NO remote SendMessage/CancelTask, NO approval/authorization, NO persistence,
 * and generates NO receipt — the parent owns durable persistence and the
 * automatic wait loop.
 *
 * Authority contract (maintained DSH user-questions, verified against
 * .artifacts/dsh-native-idle/packages/interaction/user-questions/src/{index,types}.ts):
 *   ctx.userQuestions.ask({ agent, signal, questions: [{id, question, options,
 *     detail?, header?, multiSelect?, intent?}] }) -> { answers: [{id, selected, custom?}] }
 *   - ask does not write a durable audit; it returns a plain answer batch.
 *   - the service requires the exact live calling root agent (assertLiveRoot,
 *     CALLER_NOT_LIVE / DELEGATED_CALLER); ask propagates abort as ASK_ABORTED.
 *
 * Wait shape (immutable, caller-supplied):
 *   { contract:'agentkit.a2a-question-wait/v1', interactionId, continuationId,
 *     request:{ request_type:'structured_input'|'approval', prompt?, schema?, detail? },
 *     deadlineAt, scopeId, taskId, target:{ local_name, target_agent_id } }
 *
 * Return:
 *   input submit : { action:'submit', parts:[{ data: <value> }] }
 *   input reject : { action:'reject' }
 *   approval     : { action:'approve' } | { action:'reject' }
 *
 */
import { canonical, copy, invariant, parseNativeJson } from '@kingsoftcloud/agentkit-harness-core';
import { awaitA2aControl } from '../../providers/native-a2a-controls.mjs';

const WAIT_CONTRACT = 'agentkit.a2a-question-wait/v1';
const REJECT_INPUT_LABEL = '拒绝输入';
const APPROVE_LABEL = '批准远端操作';
const REJECT_LABEL = '拒绝远端操作';
const MAX_TEXT = 1024 * 1024;

function invalid(code) { const e = new Error(code); e.code = code; return e; }
function reject(code) { throw invalid(code); }

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const serviceIdentity = value => value?.[Symbol.for('cordis.tracker')] ?? value;
const isString = v => typeof v === 'string';
const id = v => isString(v) && v.length > 0 && v.length <= 4096;

/** Validate and freeze the immutable wait. Returns a defensive copy. */
function validateWait(wait) {
  if (!isObject(wait)) reject('A2A_QUESTION_BINDING_INVALID');
  if (wait.contract !== WAIT_CONTRACT) reject('A2A_QUESTION_BINDING_INVALID');
  if (!id(wait.interactionId)) reject('A2A_QUESTION_BINDING_INVALID');
  if (!id(wait.continuationId)) reject('A2A_QUESTION_BINDING_INVALID');
  if (!id(wait.scopeId)) reject('A2A_QUESTION_BINDING_INVALID');
  if (!id(wait.taskId)) reject('A2A_QUESTION_BINDING_INVALID');
  if (!Number.isSafeInteger(wait.deadlineAt) || wait.deadlineAt <= 0) reject('A2A_QUESTION_BINDING_INVALID');
  const target = wait.target;
  if (!isObject(target) || !id(target.local_name) || !id(target.target_agent_id)) reject('A2A_QUESTION_BINDING_INVALID');
  const request = wait.request;
  if (!isObject(request)) reject('A2A_QUESTION_BINDING_INVALID');
  if (request.request_type !== 'structured_input' && request.request_type !== 'approval') reject('A2A_QUESTION_BINDING_INVALID');
  if (request.prompt != null && !isString(request.prompt)) reject('A2A_QUESTION_BINDING_INVALID');
  if (request.schema !== undefined && !isObject(request.schema)) reject('A2A_QUESTION_BINDING_INVALID');
  return copy(wait);
}

/** Coerce a custom string to the data value per schema type:
 *  - string schema: raw custom (including empty string)
 *  - other schema: parseNativeJson(custom) (preserves big-integer/negative-zero)
 *  No result-envelope unwrapping, no schema validation here. */
function coerceData(custom, schema) {
  const type = isObject(schema) ? schema.type : undefined;
  if (type === 'string') return custom;
  let value;
  try { value = parseNativeJson(custom); }
  catch { reject('A2A_QUESTION_ANSWER_INVALID'); }
  return value;
}

/** Validate a single answer item against the question it answered. */
function validateAnswerItem(answer, question, interactionId) {
  if (!isObject(answer)) reject('A2A_QUESTION_ANSWER_INVALID');
  if (answer.id !== interactionId) reject('A2A_QUESTION_ANSWER_INVALID');
  if (!Array.isArray(answer.selected)) reject('A2A_QUESTION_ANSWER_INVALID');
  const selected = answer.selected;
  if (question.kind === 'approval') {
    // Approval: exactly one of the two labels, no custom.
    if (selected.length !== 1) reject('A2A_QUESTION_ANSWER_INVALID');
    if (answer.custom !== undefined) reject('A2A_QUESTION_ANSWER_INVALID');
    if (selected[0] === APPROVE_LABEL) return { action: 'approve' };
    if (selected[0] === REJECT_LABEL) return { action: 'reject' };
    reject('A2A_QUESTION_ANSWER_INVALID');
  }
  // Structured input.
  if (selected.length === 1 && selected[0] === REJECT_INPUT_LABEL) {
    if (answer.custom !== undefined) reject('A2A_QUESTION_ANSWER_INVALID');
    return { action: 'reject' };
  }
  if (selected.length !== 0) reject('A2A_QUESTION_ANSWER_INVALID');
  const custom = answer.custom;
  if (!isString(custom)) reject('A2A_QUESTION_ANSWER_INVALID');
  if (Buffer.byteLength(custom, 'utf8') > MAX_TEXT) reject('A2A_QUESTION_ANSWER_INVALID');
  return { action: 'submit', parts: [{ data: coerceData(custom, question.schema) }] };
}

/**
 * createStudioA2aQuestionPresenter({ ctx, agent, assertCurrent })
 * Returns an async function ({ wait, signal }) => result.
 * The presenter only calls ctx.userQuestions.ask; it never sends, cancels,
 * approves, tools, or persists. assertCurrent() must synchronously return true.
 */
export function createStudioA2aQuestionPresenter({ ctx, agent, assertCurrent }) {
  invariant(isObject(ctx), 'A2A_QUESTION_UNAVAILABLE');
  invariant(isObject(agent) && isString(agent.session?.id), 'A2A_QUESTION_BINDING_INVALID');
  invariant(typeof assertCurrent === 'function', 'A2A_QUESTION_BINDING_INVALID');
  // Pin the Session object; resolving a service is lazy so a non-question
  // receipt wait does not require an installed human answerer.
  const originalSessionId = agent.session.id;
  const originalSession = agent.session;
  const originalAgent = agent;
  const checkCurrent = () => {
    const verdict = assertCurrent();
    if (verdict && typeof verdict.then === 'function') void Promise.resolve(verdict).catch(() => {});
    if (verdict !== true) reject('A2A_QUESTION_BINDING_INVALID');
  };

  return async function present({ wait, signal } = {}) {
    // Synchronous authority must hold throughout.
    checkCurrent();
    if (!(signal instanceof AbortSignal)) reject('A2A_QUESTION_BINDING_INVALID');
    signal.throwIfAborted();

    const frozen = validateWait(wait);
    const sealed = canonical(wait);
    const request = frozen.request;
    const originalService = ctx.get('userQuestions');
    if (typeof originalService?.ask !== 'function') reject('A2A_QUESTION_UNAVAILABLE');

    // Identity drift checks: session, agent instance, and service must be unchanged.
    if (agent !== originalAgent || agent.session !== originalSession || agent.session?.id !== originalSessionId) reject('A2A_QUESTION_BINDING_INVALID');
    checkCurrent();
    signal.throwIfAborted();

    const isApproval = request.request_type === 'approval';
    const questionText = request.prompt || (isApproval ? '远端操作需要审批' : '远端请求补充输入');
    const options = isApproval
      ? [{ label: APPROVE_LABEL }, { label: REJECT_LABEL }]
      : [{ label: REJECT_INPUT_LABEL, description: '不提供输入并拒绝该远端请求' }];
    const detail = [`目标：${frozen.target.local_name}`, request.detail == null ? ''
      : typeof request.detail === 'string' ? request.detail : canonical(request.detail),
    isApproval ? '' : request.schema?.type === 'string' ? '请填写文本答案。'
      : `请填写满足以下要求的 JSON 值：\n${canonical(request.schema ?? {})}`].filter(Boolean).join('\n\n');
    const question = {
      id: frozen.interactionId,
      question: questionText,
      ...(detail !== undefined ? { detail } : {}),
      ...(isApproval ? {} : { header: '可填写自由文本作为答案，或选择“拒绝输入”' }),
      options,
    };

    // Ask the maintained DSH user-questions seam. ask does not persist.
    let answer;
    try {
      answer = await awaitA2aControl(() => originalService.ask({ agent: originalAgent, signal, questions: [question] }), signal);
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (error?.code === 'ASK_ABORTED') throw signal.aborted ? signal.reason : error;
      // NO_PROVIDER / CALLER_NOT_LIVE / DELEGATED_CALLER surface as unavailable.
      if (['NO_PROVIDER', 'CALLER_NOT_LIVE', 'DELEGATED_CALLER'].includes(error?.code)) {
        const e = new Error('A2A_QUESTION_UNAVAILABLE'); e.code = 'A2A_QUESTION_UNAVAILABLE'; e.cause = error; throw e;
      }
      throw error;
    }

    // Post-ask authority: signal must not have aborted, identities still pinned.
    signal.throwIfAborted();
    if (agent !== originalAgent || agent.session !== originalSession || agent.session?.id !== originalSessionId
      || canonical(wait) !== sealed) reject('A2A_QUESTION_BINDING_INVALID');
    if (serviceIdentity(ctx.get('userQuestions')) !== serviceIdentity(originalService)) reject('A2A_QUESTION_BINDING_INVALID');
    checkCurrent();

    // Validate the returned batch shape.
    if (!isObject(answer) || !Array.isArray(answer.answers)) reject('A2A_QUESTION_ANSWER_INVALID');
    // Exactly one answer for the one question we asked; reject extras/duplicates.
    if (answer.answers.length !== 1) reject('A2A_QUESTION_ANSWER_INVALID');
    return validateAnswerItem(answer.answers[0], { kind: isApproval ? 'approval' : 'input', schema: request.schema }, frozen.interactionId);
  };
}
