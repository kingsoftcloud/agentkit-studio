import { join } from 'node:path';
import { copy, invariant } from '../../../packages/agentkit-harness-core/dist/index.mjs';
import { createManagedNativeKernel } from '../../providers/native-managed-kernel.mjs';
import { createManagedNativeKernelHttp, MANAGED_NATIVE_KERNEL_PATH } from '../../providers/native-managed-kernel-http.mjs';
import { createStudioManagedNativeExecution } from './native-managed-execution.mjs';
import { createStudioManagedNativeBinding } from './native-managed-binding.mjs';

/** Local authenticated product transport, bound to the trusted installation's
 * target/principal. It cannot mint or accept new Server control commands. */
export function createStudioManagedNativeSessionControl({ runtime, target, principal }) {
  const boundTarget = copy(target), boundPrincipal = copy(principal);
  const query = request => {
    invariant(request.agentId === boundTarget.agentInstanceId, 'NATIVE_MANAGED_STATUS_IDENTITY_MISMATCH');
    return { scope: { tenantId: boundTarget.tenantId, workspaceId: request.workspaceId,
      userId: boundPrincipal.userId, agentId: boundTarget.agentInstanceId },
      sessionId: request.sessionId, ...(request.runId === undefined ? {} : { runId: request.runId }) };
  };
  return Object.freeze({ agentId: boundTarget.agentInstanceId,
    inspect: request => runtime.inspectSession(query(request)),
    retry: request => runtime.retryAcceptedRun(query(request)),
    childRecord: request => runtime.readChildRecord({ ...query(request), childRunId: request.childRunId }),
    childHistory: (request, options) => runtime.readChildHistory({ ...query(request),
      ...Object.fromEntries(['offset', 'limit', 'inventoryDigest', 'childRunId'].filter(key => request[key] !== undefined)
        .map(key => [key, request[key]])) }, options) });
}

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
  // Session preset restoration must finish before cold commands resolve their
  // Agent/Build. Bootstrap explicitly starts recovery at its readiness boundary.
  const scopedControl = configuration.scopedControl ?? (execution ? Object.fromEntries(['prepare', 'execute'].map(kind => [kind, async request => {
    assertCurrent(); request.signal.throwIfAborted();
    const host = await resolveHost();
    assertCurrent(); request.signal.throwIfAborted();
    invariant(typeof host?.managedScopeControl?.[kind] === 'function', 'NATIVE_MANAGED_SCOPE_UNAVAILABLE');
    return host.managedScopeControl[kind](request);
  }])) : undefined);
  runtime = createManagedNativeKernel({ ...configuration, resolveBinding, scopedControl, autoStart: false,
    directory: join(storeDir, 'native-harness', 'managed-kernel'), assertCurrent });
  transport = createManagedNativeKernelHttp(runtime);
  ctx.provide('studioManagedNativeKernel', runtime);
  if (execution) ctx.provide('studioManagedNativeSessionControl', createStudioManagedNativeSessionControl({
    runtime, target: configuration.target, principal: configuration.principal }));
  ctx.inject(['webServer'], webCtx => {
    const release = webCtx.webServer.register({ kind: 'prefix', path: MANAGED_NATIVE_KERNEL_PATH,
      handler: (request, response) => transport.handle(request, response, { signal: lifetime.signal }) });
    webCtx.effect(() => release, 'agentkit-studio: managed Native Kernel transport');
  });
  return runtime;
}
