import { createNativeE2BSandboxOwner } from '@kingsoftcloud/agentkit-harness-node/native/e2b-sandbox-owner';
import { copy, scopeKey } from '../../../../src/contracts/native-values.mjs';
import { createE2BHostBinding, prepareE2BHost } from '../../../../src/providers/native-e2b-host.mjs';
export { nativeCommandBackend } from '../../../../src/providers/native-command-backend.mjs';

export const STUDIO_NATIVE_E2B_HOST = 'agentkit.studio-native-e2b-host/v1';

export function prepareNativeE2BHost(options = {}) {
  return prepareE2BHost(options, STUDIO_NATIVE_E2B_HOST, createNativeE2BHostBinding);
}

export function createNativeE2BHostBinding(options = {}) {
  scopeKey(options.scope);
  return createE2BHostBinding({ ...options, ownership: { contract: STUDIO_NATIVE_E2B_HOST,
    fields: { scope: copy(options.scope) }, create: createNativeE2BSandboxOwner, runtime: 'agentkit' } });
}
