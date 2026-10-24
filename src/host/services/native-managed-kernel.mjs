import { join } from 'node:path';
import { invariant } from '../../../packages/agentkit-harness-core/dist/index.mjs';
import { createManagedNativeKernel } from '../../providers/native-managed-kernel.mjs';
import { createManagedNativeKernelHttp, MANAGED_NATIVE_KERNEL_PATH } from '../../providers/native-managed-kernel-http.mjs';
import { createStudioManagedNativeExecution } from './native-managed-execution.mjs';
import { createStudioManagedNativeBinding } from './native-managed-binding.mjs';

/** Optional trusted composition; a workspace or public Agent spec cannot
 * install a Server key, select another tenant, or mint an execution permit. */
export function registerStudioManagedNativeKernel(ctx, { storeDir, configuration, resolveHost } = {}) {
  invariant(configuration && typeof configuration.assertCurrent === 'function', 'NATIVE_KERNEL_CONFIGURATION_INVALID');
  const lifetime = new AbortController(), original = configuration.assertCurrent;
  let runtime, transport, execution;
  ctx.effect(() => async () => {
    lifetime.abort(); transport?.close();
    try { await runtime?.close(); } finally { execution?.close(); }
  }, 'agentkit-studio: managed Native Kernel owner');
  const assertCurrent = () => {
    lifetime.signal.throwIfAborted();
    invariant(ctx.fiber.uid !== null && configuration.assertCurrent === original, 'NATIVE_KERNEL_AUTHORITY_LOST');
    return original();
  };
  let resolveBinding = configuration.resolveBinding;
  if (resolveBinding === undefined) {
    execution = createStudioManagedNativeExecution({ ctx });
    resolveBinding = createStudioManagedNativeBinding({ ctx, target: configuration.target, principal: configuration.principal,
      resolveHost, execution });
  }
  runtime = createManagedNativeKernel({ ...configuration, resolveBinding,
    directory: join(storeDir, 'native-harness', 'managed-kernel'), assertCurrent });
  transport = createManagedNativeKernelHttp(runtime);
  ctx.provide('studioManagedNativeKernel', runtime);
  ctx.inject(['webServer'], webCtx => {
    const release = webCtx.webServer.register({ kind: 'prefix', path: MANAGED_NATIVE_KERNEL_PATH,
      handler: (request, response) => transport.handle(request, response, { signal: lifetime.signal }) });
    webCtx.effect(() => release, 'agentkit-studio: managed Native Kernel transport');
  });
  return runtime;
}
