import type { Message, ObjectValue, RunSnapshot, RunConfiguration, TurnInputMessage } from './contracts.mjs';
import { canonical, invariant } from './values.mjs';
import { validateInstructionScopes } from './instruction-scopes.mjs';
import { toolContext } from './tool-context.mjs';
import { planModeGuidance, CHILD_PLAN_MODE_POLICY } from './plan-mode.mjs';

/** Host receipts cannot grant tools or per-call permission. The optional,
 * versioned plan control adopts the user's mode at an accepted boundary. */
export function reduceTurnInput(snapshot: RunSnapshot, result: ObjectValue, config?: RunConfiguration): Partial<RunSnapshot> {
  invariant(config?.planModePolicy !== CHILD_PLAN_MODE_POLICY || result.planMode === undefined, 'child_plan_mode_is_immutable');
  invariant(Object.keys(result).every(key => ['status', 'messages', 'instructionScopes', ...(snapshot.planMode ? ['planMode'] : [])].includes(key))
    && ['admitted', 'rejected'].includes(String(result.status)) && Array.isArray(result.messages), 'invalid_turn_input');
  invariant(result.planMode === undefined || typeof result.planMode === 'boolean' && result.status === 'admitted', 'invalid_turn_input');
  invariant(result.instructionScopes === undefined || result.status === 'admitted' && config, 'invalid_turn_input');
  const instructionScopes = result.instructionScopes === undefined ? undefined : validateInstructionScopes(result.instructionScopes, config);
  const scopesChanged = instructionScopes !== undefined && canonical(instructionScopes) !== canonical(snapshot.context.instructionScopes ?? null);
  const modeChanged = snapshot.planMode && typeof result.planMode === 'boolean' && result.planMode !== snapshot.planMode.active;
  invariant(result.status !== 'rejected' || result.messages.length === 0, 'invalid_turn_input');
  const messages: Message[] = result.messages.map(input => {
    invariant(input !== null && typeof input === 'object' && !Array.isArray(input), 'invalid_turn_input');
    const { retention, ...context } = input as unknown as TurnInputMessage;
    invariant(retention === undefined || ['persistent', 'normal'].includes(retention), 'invalid_turn_input');
    return { ...toolContext(context), role: 'user' as const, kind: 'host_input',
      ...(retention === 'normal' ? {} : { persistent: true }) };
  });
  if (modeChanged) messages.push({ role: 'user', kind: 'plan_mode', content: planModeGuidance({ ...snapshot,
    planMode: { ...snapshot.planMode!, active: result.planMode as boolean } }, config) });
  return { pendingIntent: null, context: { ...snapshot.context, inputModelCursor: snapshot.usage.modelCalls,
    ...(instructionScopes ? { instructionScopes } : {}),
    ...(messages.length || modeChanged || scopesChanged ? { preparedCursor: null } : {}) },
  ...(modeChanged ? { planMode: { ...snapshot.planMode!, active: result.planMode as boolean, revision: snapshot.planMode!.revision + 1 } } : {}),
  ...(result.status === 'rejected' ? { phase: 'finalizing' as const, outcome: 'blocked' as const,
    reason: 'host_input_rejected', candidate: null, verification: null, finalText: '', preparedContext: null } : {}),
  ...(messages.length || modeChanged || scopesChanged ? { messages: [...snapshot.messages, ...messages], preparedContext: null,
    candidate: null, verification: null, finalText: '', outcome: null, reason: null, phase: 'preparing_context' as const,
    contextState: snapshot.contextState ? { ...snapshot.contextState, compaction: null } : null } : {}) };
}
