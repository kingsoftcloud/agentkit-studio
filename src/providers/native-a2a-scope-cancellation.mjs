/** A Server scope cancellation is an authorized withdrawal of the original
 * invocation. It is never a human answer or a grant to continue remote work. */
import { canonical, copy, invariant } from '@kingsoftcloud/agentkit-harness-core';
import { createHash } from 'node:crypto';
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');

export const A2A_SCOPE_CANCELLATION = 'agentkit.native-a2a-scope-cancellation/v1';
export function validateA2aScopeCancellation(record, command, receipt) {
  invariant(command.kind === 'cancel' && receipt?.contract === A2A_SCOPE_CANCELLATION
    && receipt.commandId === command.commandId && receipt.scopeId === record.request.scopeId
    && receipt.requestDigest === record.requestDigest
    && receipt.commandDigest === digest(command)
    && canonical(receipt.locator) === canonical(record.request.identity)
    && receipt.nativeDigest === digest(record.request.native)
    && typeof receipt.actor === 'string' && receipt.actor.length > 0
    && typeof receipt.rootRunId === 'string' && receipt.rootRunId.length > 0,
  'A2A_SCOPE_CANCELLATION_INVALID');
  return copy(receipt);
}
