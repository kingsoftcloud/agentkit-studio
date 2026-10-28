export const NATIVE_HOST_CONTEXT_OWNERSHIP = 'agentkit.native-context-ownership/v1';

// Source ownership is independent of prompt wording. Native resolves its bound
// skill resources; the host supplies environment snapshots and external input.
const sources = Object.freeze({
  'skill-catalog': Object.freeze({ owner: 'native', lifetime: 'catalog' }),
  'runtime-context': Object.freeze({ owner: 'host', lifetime: 'snapshot' }),
  'time-context': Object.freeze({ owner: 'host', lifetime: 'snapshot' }),
});

/** Keep source indices so attachment identities cannot shift across admission. */
export function nativeHostInputRows(messages, policy) {
  if (!Array.isArray(messages)) throw Object.assign(Error('studio_native_prepared_input_invalid'), { code: 'studio_native_prepared_input_invalid' });
  if (policy !== undefined && policy !== NATIVE_HOST_CONTEXT_OWNERSHIP)
    throw Object.assign(Error('studio_native_context_ownership_invalid'), { code: 'studio_native_context_ownership_invalid' });
  return messages.flatMap((message, sourceIndex) => {
    const source = policy ? sources[message?.source?.kind] : null;
    return source?.owner === 'native' ? [] : [{ message, sourceIndex, snapshot: source?.lifetime === 'snapshot' }];
  });
}

/** A refreshed environment snapshot is not a new user task after a candidate. */
export function nativeHostInputIsRefresh(rows, policy) {
  return rows.every(({ message, snapshot }) => policy ? snapshot : ['runtime-context', 'time-context'].includes(message?.source?.kind));
}
