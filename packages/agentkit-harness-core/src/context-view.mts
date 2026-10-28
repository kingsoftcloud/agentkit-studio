import type { Message, RunSnapshot } from './contracts.mjs';
import { canonical, copy, invariant } from './values.mjs';

export function contextSourceDigest(snapshot: RunSnapshot, digest: (value: unknown) => string): string {
  return digest({ messages: snapshot.messages, goalRevision: snapshot.goalRevision,
    workspaceRevision: snapshot.workspaceRevision, configDigest: snapshot.configDigest,
    ...(snapshot.todos ? { todos: snapshot.todos.items, todoRevision: snapshot.todos.revision } : {}),
    ...(snapshot.planMode ? { planMode: snapshot.planMode } : {}),
    ...(snapshot.executionBudgetObservation ? { executionBudgetObservation: snapshot.executionBudgetObservation } : {}),
    ...(snapshot.deliveryReview?.status === 'pending' ? { deliveryReview: snapshot.deliveryReview } : {}) });
}

/** Validate the provider-neutral protocol after pruning, before a model can see it. */
export function validateContextMessages(input: unknown): Message[] {
  invariant(Array.isArray(input), 'invalid_context_messages');
  const messages = copy(input) as Message[];
  const pending = new Set<string>(), seen = new Set<string>();
  for (const message of messages) {
    invariant(message && ['system', 'user', 'assistant', 'tool'].includes(message.role)
      && typeof message.content === 'string', 'invalid_context_messages');
    invariant(message.completedAtMs === undefined || message.role === 'assistant'
      && Number.isSafeInteger(message.completedAtMs) && message.completedAtMs >= 0, 'invalid_context_completion_time');
    if (message.role === 'tool') {
      invariant(typeof message.callId === 'string' && pending.delete(message.callId)
        && message.toolCalls === undefined, 'invalid_context_tool_pairing');
      continue;
    }
    invariant(pending.size === 0, 'invalid_context_tool_pairing');
    if (message.toolCalls !== undefined) {
      invariant(message.role === 'assistant' && Array.isArray(message.toolCalls), 'invalid_context_messages');
      for (const call of message.toolCalls) {
        invariant(call && typeof call.callId === 'string' && call.callId.trim() && !seen.has(call.callId)
          && typeof call.name === 'string' && call.name.trim() && call.arguments !== null
          && typeof call.arguments === 'object' && !Array.isArray(call.arguments), 'invalid_context_tool_pairing');
        seen.add(call.callId); pending.add(call.callId);
      }
    }
  }
  invariant(pending.size === 0, 'invalid_context_tool_pairing');
  return messages;
}

export function modelContextMessages(snapshot: RunSnapshot, digest: (value: unknown) => string): Message[] {
  if (!snapshot.preparedContext) return copy(snapshot.messages);
  invariant(snapshot.preparedContext.sourceDigest === contextSourceDigest(snapshot, digest), 'context_binding_mismatch');
  return copy(snapshot.preparedContext.messages);
}

/** Store guard: projections and summaries can never rewrite authoritative observations. */
export function transcriptExtends(previous: Message[], next: Message[]): boolean {
  return next.length >= previous.length && previous.every((message, index) => canonical(message) === canonical(next[index]));
}
