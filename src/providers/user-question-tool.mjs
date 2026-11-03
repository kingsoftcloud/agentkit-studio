/**
 * Model-facing question tool for managed interactive runs.
 *
 * Codex's app-server can ask the client for input (`item/tool/requestUserInput`)
 * but it does not expose that as a model tool, so an agent could never actually
 * ask the user anything. This registers an explicit function tool whose handler
 * reuses the managed question channel (`kind: 'question'`), which presents an
 * `mcp_user_question` item and settles through InteractionAction=submit. Tool
 * approvals stay on their own channel and can never settle a question.
 */

// Codex's app-server ships its own `request_user_input` tool (gated to Plan
// mode), which shadows any dynamic tool with the same name. Use a distinct
// name so the managed channel actually receives the call.
export const USER_QUESTION_TOOL_NAME = 'ask_user';

export const USER_QUESTION_TOOL_SPEC = {
  type: 'function',
  name: USER_QUESTION_TOOL_NAME,
  description:
    'Ask the user a question and wait for their answer before continuing. '
    + 'Use it when a decision, preference or clarification is required and cannot be inferred. '
    + 'Provide selectable options when the answer is a choice; the run pauses until the user answers or the ask times out.',
  inputSchema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The question to show the user.' },
      options: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional selectable answers. Omit for a free-form answer.',
      },
      multi_select: {
        type: 'boolean',
        description: 'When true the user may select more than one option.',
      },
    },
    required: ['question'],
    additionalProperties: false,
  },
};

/**
 * Build the dynamic-tool handler that turns one tool call into one presented
 * question. `request` is the managed approval registry's provider-facing ask
 * (`requestManagedApproval`), already bound to the live run.
 *
 * @param {{request: (ask: object) => Promise<unknown> | undefined, sessionId: string}} options
 */
export function createUserQuestionTool({ request, sessionId } = {}) {
  const handler = async ({ name, arguments: args, signal } = {}) => {
    if (name !== USER_QUESTION_TOOL_NAME) return undefined;
    const question = String(args?.question || '').trim();
    if (!question) throw Object.assign(new Error(`${USER_QUESTION_TOOL_NAME} 需要一个非空的 question`), { code: 'USER_QUESTION_INVALID' });
    const options = Array.isArray(args?.options)
      ? args.options.map(option => String(option)).filter(Boolean).slice(0, 20)
      : [];
    const outcome = await request?.({
      kind: 'question',
      nativeSessionId: sessionId,
      sessionId,
      questions: [{
        id: 'answer',
        question,
        ...(options.length ? { options } : {}),
        ...(args?.multi_select === true ? { multiSelect: true } : {}),
      }],
      signal,
    });
    const answers = outcome && typeof outcome === 'object' && outcome.answers
      && typeof outcome.answers === 'object' && !Array.isArray(outcome.answers)
      ? outcome.answers : {};
    const answer = answers.answer ?? null;
    return JSON.stringify({
      answered: answer !== null && answer !== undefined && String(answer).length > 0,
      answer,
    });
  };
  return { spec: USER_QUESTION_TOOL_SPEC, handler };
}
