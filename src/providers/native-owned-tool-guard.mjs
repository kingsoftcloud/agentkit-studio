import { canonical, parseNativeJson } from '@kingsoftcloud/agentkit-harness-core';
import { sandboxRegistryName } from './sandbox-code-name.mjs';

/** Recheck immutable Native authority after approval and immediately before dispatch,
 * including DSH-owned Skill bodies outside the Node builtin wrappers. */
export function createNativeOwnedToolGuard({ calls, isClosed, assertWorkspace, codeNames, repairToolName }) {
  return exec => {
    const invocation = calls.get(String(exec.callId));
    if (!invocation) return undefined;
    if (invocation.agent !== exec.agent) return 'Native tool execution authority expired';
    if (isClosed() || exec.signal.aborted || invocation.request.signal?.aborted)
      return 'Native tool execution authority expired';
    // DSH-owned extensions have no Node builtin wrapper. Seal every owned
    // registry call to the Native intent, including third-party tools whose
    // pre-execute listeners can otherwise replace arguments before dispatch.
    const expectedName = invocation.repair ? repairToolName
      : codeNames.has(invocation.request.call?.name) ? sandboxRegistryName(invocation.request.call.name)
      : invocation.request.call?.name;
    const expectedArguments = invocation.repair
      ? { original_operation_key: invocation.request.originalOperationKey }
      : invocation.request.call?.arguments;
    if (exec.name !== expectedName || canonical(invocation.argumentEncoding
      ? parseNativeJson(JSON.stringify(exec.arguments)) : exec.arguments) !== canonical(expectedArguments))
      return 'Native tool execution authority expired';
    try {
      assertWorkspace?.(exec.agent);
      if (typeof invocation.assertCurrent === 'function'
        && invocation.assertCurrent(invocation.request) !== true)
        return 'Native tool execution authority expired';
    } catch { return 'Native tool execution authority expired'; }
    // `tools/execute` wrappers run after guards. DSH deep-freezes the value
    // but leaves this property writable until result notification; pin it
    // now so an around-dispatch wrapper cannot swap arguments after approval.
    try { Object.defineProperty(exec, 'arguments', { value: exec.arguments, writable: false, configurable: false }); }
    catch { return 'Native tool execution authority expired'; }
    return undefined;
  };
}
