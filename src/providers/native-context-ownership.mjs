export const NATIVE_HOST_CONTEXT_OWNERSHIP = 'agentkit.native-context-ownership/v1';
export const NATIVE_EXECUTION_CONTEXT_OWNERSHIP = 'agentkit.native-context-ownership/v2';
export const NATIVE_WORKSPACE_CONTEXT_OWNERSHIP = 'agentkit.native-context-ownership/v3';
export const NATIVE_CURRENT_INSTRUCTION_OWNERSHIP = 'agentkit.native-context-ownership/v4';

// Source ownership is independent of prompt wording. Native resolves its bound
// skill resources; the host supplies environment snapshots and external input.
const sources = Object.freeze({
  'skill-catalog': Object.freeze({ owner: 'native', lifetime: 'catalog' }),
  'runtime-context': Object.freeze({ owner: 'host', lifetime: 'snapshot' }),
  'time-context': Object.freeze({ owner: 'host', lifetime: 'snapshot' }),
});

/** Keep source indices so attachment identities cannot shift across admission. */
export function nativeHostInputRows(messages, policy, { initial = false } = {}) {
  if (!Array.isArray(messages)) throw Object.assign(Error('studio_native_prepared_input_invalid'), { code: 'studio_native_prepared_input_invalid' });
  if (typeof initial !== 'boolean' || policy !== undefined
    && ![NATIVE_HOST_CONTEXT_OWNERSHIP, NATIVE_EXECUTION_CONTEXT_OWNERSHIP, NATIVE_WORKSPACE_CONTEXT_OWNERSHIP, NATIVE_CURRENT_INSTRUCTION_OWNERSHIP].includes(policy))
    throw Object.assign(Error('studio_native_context_ownership_invalid'), { code: 'studio_native_context_ownership_invalid' });
  return messages.flatMap((message, sourceIndex) => {
    // The initial Host assembly may describe its Session container. The bound
    // execution owner refreshes workspace instructions in a durable input
    // effect before inference. Preserve all original admission bytes elsewhere.
    if (policy === NATIVE_CURRENT_INSTRUCTION_OWNERSHIP
      && ['working-directory', 'agent-instructions'].includes(message?.source?.kind)) return [];
    if (policy === NATIVE_WORKSPACE_CONTEXT_OWNERSHIP
      && (message?.source?.kind === 'working-directory' || initial && message?.source?.kind === 'agent-instructions')) return [];
    const source = policy ? sources[message?.source?.kind] : null;
    return source?.owner === 'native' || [NATIVE_EXECUTION_CONTEXT_OWNERSHIP, NATIVE_WORKSPACE_CONTEXT_OWNERSHIP, NATIVE_CURRENT_INSTRUCTION_OWNERSHIP].includes(policy)
      && source?.lifetime === 'snapshot'
      ? [] : [{ message, sourceIndex, snapshot: source?.lifetime === 'snapshot' }];
  });
}

/** A refreshed environment snapshot is not a new user task after a candidate. */
export function nativeHostInputIsRefresh(rows, policy) {
  return rows.every(({ message, snapshot }) => policy ? snapshot : ['runtime-context', 'time-context'].includes(message?.source?.kind));
}
