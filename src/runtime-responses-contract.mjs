/** Responses ingress for a frozen Agent; DSH owns the underlying conversation. */
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { sanitizeResourceCheck } from './resource-checks.mjs';

export const runtimeError = (code, status = 400) => Object.assign(new Error(code), { code, status });
const digest = value => createHash('sha256').update(value).digest('hex').slice(0, 32);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const identity = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);

function userText(input) {
  if (typeof input === 'string' && input.trim()) return input;
  if (!Array.isArray(input) || input.length !== 1) throw runtimeError('RESPONSES_SINGLE_USER_MESSAGE_REQUIRED');
  const message = input[0];
  if (!object(message) || message.role !== 'user' || (message.type && message.type !== 'message')
    || Object.keys(message).some(key => !['role', 'type', 'content'].includes(key))) throw runtimeError('RESPONSES_SINGLE_USER_MESSAGE_REQUIRED');
  if (typeof message.content === 'string' && message.content.trim()) return message.content;
  if (!Array.isArray(message.content) || !message.content.length || message.content.some(part => !object(part)
    || !['text', 'input_text'].includes(part.type) || typeof part.text !== 'string'
    || Object.keys(part).some(key => !['type', 'text'].includes(key)))) throw runtimeError('RESPONSES_TEXT_INPUT_REQUIRED');
  const text = message.content.map(part => part.text).join('');
  if (!text.trim()) throw runtimeError('RESPONSES_TEXT_INPUT_REQUIRED');
  return text;
}

export function createRuntimeResponsesContract({ agentId, buildId, token, model = '', models = [model] }) {
  // Handles carry only scoped hashes. Their signature binds Agent, Build and
  // principal without a second transcript/response store beside DSH.
  const sign = (value, principal = '') => createHmac('sha256', token).update(JSON.stringify([agentId, buildId, principal, value])).digest('hex').slice(0, 32);
  const checked = (value, prefix, principal) => {
    const match = new RegExp(`^${prefix}_([a-f0-9]{32}${prefix === 'resp' ? '_[a-f0-9]{32}' : ''})_([a-f0-9]{32})$`).exec(value || '');
    if (!match || !timingSafeEqual(Buffer.from(sign(`${prefix}_${match[1]}`, principal)), Buffer.from(match[2]))) throw runtimeError('RESPONSES_HANDLE_INVALID', 404);
    return match[1].split('_');
  };
  const responseHandle = (session, run, principal) => { const value = `resp_${session}_${run}`; return `${value}_${sign(value, principal)}`; };
  const sessionHandle = (session, principal) => { const value = `conv_${session}`; return `${value}_${sign(value, principal)}`; };
  return {
    cancellation(responseId) {
      // Cancellation holds the Agent bearer, but has no body carrying a user.
      // Active entries verify the complete opaque response ID before aborting.
      if (!/^resp_[a-f0-9]{32}_[a-f0-9]{32}_[a-f0-9]{32}$/.test(responseId)) throw runtimeError('RESPONSES_HANDLE_INVALID', 404);
      return `run_${responseId.split('_')[2]}`;
    },
    parse(input, headers = {}) {
      const allowed = ['input', 'stream', 'session_id', 'conversation', 'previous_response_id', 'request_id', 'model', 'user', 'account_id', 'metadata'];
      if (!object(input) || Object.keys(input).some(key => !allowed.includes(key))) throw runtimeError('RESPONSES_UNSUPPORTED_FIELD');
      if (input.stream !== undefined && typeof input.stream !== 'boolean') throw runtimeError('RESPONSES_INPUT_INVALID');
      if (input.model !== undefined && !models.includes(input.model)) throw runtimeError('RESPONSES_FROZEN_MODEL_MISMATCH');
      for (const field of ['session_id', 'user', 'account_id', 'request_id']) if (input[field] !== undefined && !identity(input[field])) throw runtimeError('RESPONSES_INPUT_INVALID');
      if (input.metadata !== undefined && (!object(input.metadata) || Object.entries(input.metadata).some(([key, value]) => key !== 'agentengine' && (key.length > 64 || typeof value !== 'string' || value.length > 512))
        || Object.keys(input.metadata).length > 17)) throw runtimeError('RESPONSES_METADATA_INVALID');
      const principal = JSON.stringify([input.account_id || '', input.user || '']);
      let conversation = input.conversation;
      if (object(conversation) && Object.keys(conversation).length === 1) conversation = conversation.id;
      if (conversation !== undefined && !identity(conversation)) throw runtimeError('RESPONSES_INPUT_INVALID');
      if ((conversation && input.session_id && conversation !== input.session_id) || (conversation && input.previous_response_id)) throw runtimeError('RESPONSES_SESSION_CONFLICT');
      const ids = [input.request_id, headers['idempotency-key'], input.metadata?.agentengine?.invocation_id].filter(value => value !== undefined);
      if (ids.some(value => !identity(value)) || new Set(ids).size > 1) throw runtimeError('RESPONSES_REQUEST_ID_INVALID');
      const requestId = ids[0] || randomUUID();
      const label = conversation || input.session_id;
      let session = label?.startsWith('conv_') ? checked(label, 'conv', principal)[0] : digest(JSON.stringify([agentId, buildId, principal, label || requestId]));
      let previous;
      if (input.previous_response_id !== undefined) {
        if (typeof input.previous_response_id !== 'string') throw runtimeError('RESPONSES_INPUT_INVALID');
        const [priorSession, priorRun] = checked(input.previous_response_id, 'resp', principal);
        if (label && session !== priorSession) throw runtimeError('RESPONSES_SESSION_CONFLICT');
        session = priorSession;
        previous = { sessionId: `runtime-${session}`, occurrenceId: `run_${priorRun}` };
      }
      const run = digest(JSON.stringify([session, requestId]));
      return { input: userText(input.input), requestId, stream: input.stream === true, sessionId: `runtime-${session}`, runId: `run_${run}`,
        responseId: responseHandle(session, run, principal), conversationId: sessionHandle(session, principal), previous,
        model: input.model ?? model, createdAt: Math.floor(Date.now() / 1000), metadata: { ...(input.metadata || {}), agentkit: { agentId, buildId } } };
    },
  };
}

export function runtimeResponse(request, result = {}, status = 'in_progress', output = []) {
  const input = Number(result.tokenUsage?.inputTokens || 0), generated = Number(result.tokenUsage?.outputTokens || 0);
  const text = status === 'completed' ? String(result.output || '') : '';
  return { id: request.responseId, object: 'response', created_at: request.createdAt, status, model: request.model,
    session_id: request.conversationId, conversation: { id: request.conversationId }, metadata: Array.isArray(result.resourceChecks)
      ? { ...request.metadata, agentkit: { ...request.metadata?.agentkit, resourceChecks: result.resourceChecks.map(sanitizeResourceCheck).filter(Boolean) } } : request.metadata,
    output, output_text: text, error: result.error || null,
    ...(result.tokenUsage ? { usage: { input_tokens: input, output_tokens: generated, total_tokens: input + generated } } : {}) };
}
