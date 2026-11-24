import { createNativeChildren } from '@kingsoftcloud/agentkit-harness-node/native/children';
import { nativeGoalContract } from './native-verification.mjs';
export { nativeChildRoles, STUDIO_NATIVE_CHILD_CONTRACT, STUDIO_NATIVE_CHILD_SKILLS_CONTRACT }
  from '@kingsoftcloud/agentkit-harness-node/native/children';

/** Studio supplies its goal-verification policy; Native owns child execution. */
export function createStudioNativeChildren(options) {
  return createNativeChildren({ ...options, goalContractFactory: nativeGoalContract });
}
