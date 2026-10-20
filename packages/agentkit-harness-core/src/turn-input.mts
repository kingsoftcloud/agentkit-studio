import type { ObjectValue, RunSnapshot, TurnInputMessage } from './contracts.mjs';
import { invariant } from './values.mjs';
import { toolContext } from './tool-context.mjs';

/** A Host input receipt adds observations, never tools, roles or permissions. */
export function reduceTurnInput(snapshot: RunSnapshot, result: ObjectValue): Partial<RunSnapshot> {
  invariant(Object.keys(result).every(key => ['status', 'messages'].includes(key))
    && ['admitted', 'rejected'].includes(String(result.status)) && Array.isArray(result.messages), 'invalid_turn_input');
  invariant(result.status !== 'rejected' || result.messages.length === 0, 'invalid_turn_input');
  const messages = result.messages.map(input => {
    invariant(input !== null && typeof input === 'object' && !Array.isArray(input), 'invalid_turn_input');
    const { retention, ...context } = input as unknown as TurnInputMessage;
    invariant(retention === undefined || ['persistent', 'normal'].includes(retention), 'invalid_turn_input');
    return { ...toolContext(context), role: 'user' as const, kind: 'host_input',
      ...(retention === 'normal' ? {} : { persistent: true }) };
  });
  return { pendingIntent: null, context: { ...snapshot.context, inputModelCursor: snapshot.usage.modelCalls,
    ...(messages.length ? { preparedCursor: null } : {}) },
  ...(result.status === 'rejected' ? { phase: 'finalizing' as const, outcome: 'blocked' as const,
    reason: 'host_input_rejected', candidate: null, verification: null, finalText: '', preparedContext: null } : {}),
  ...(messages.length ? { messages: [...snapshot.messages, ...messages], preparedContext: null,
    candidate: null, verification: null, finalText: '', outcome: null, reason: null, phase: 'preparing_context' as const,
    contextState: snapshot.contextState ? { ...snapshot.contextState, compaction: null } : null } : {}) };
}
