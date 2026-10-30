import { createHash } from 'node:crypto';
import { canonical, invariant } from '@kingsoftcloud/agentkit-harness-core';

export const CHILD_COMMAND_RESOURCE = 'agentkit.child-local-command-resource/v1';

/** Host capability identity only. Environment values stay with the owner; the
 * descriptor cannot grant a tool, choose a model path or bypass shell policy. */
export function childCommandResource(commandBinding) {
  if (!commandBinding || commandBinding.backend !== 'local_process') return null;
  invariant(commandBinding.contract === 'agentkit.local-command-tools/v1'
    && commandBinding.controls?.contract === 'agentkit.local-process-control/v1'
    && /^[a-f0-9]{64}$/.test(commandBinding.environmentDigest), 'native_child_command_binding_invalid');
  return Object.freeze({ contract: CHILD_COMMAND_RESOURCE, backend: 'local_process',
    bindingDigest: createHash('sha256').update(canonical(commandBinding)).digest('hex') });
}

export function validChildCommandResource(value) {
  return value?.contract === CHILD_COMMAND_RESOURCE && value.backend === 'local_process'
    && /^[a-f0-9]{64}$/.test(value.bindingDigest) && Object.keys(value).length === 3;
}
