export const FROZEN_RUNTIME_READY = 'studioFrozenRuntimeReady';

/** The configured runtime lives exactly as long as its native dependencies. */
export function bindFrozenRuntime(ctx, { start, onUnavailable, readyService }) {
  return ctx.inject(['agentPresets', 'sessionController', 'agents', 'permissionPresets', 'approval'], async runtimeCtx => {
    let stopped = false, runtime;
    const close = () => { const owned = runtime; runtime = undefined; return owned?.close(); };
    runtimeCtx.effect(() => () => { stopped = true; return close(); }, 'agentkit-studio: frozen runtime dependencies');
    try {
      runtime = await start(runtimeCtx);
      // Cordis invalidates the public fiber identity synchronously on dispose,
      // before its queued cleanup effects can set our stopped flag.
      if (stopped || runtimeCtx.fiber.uid === null) await close();
      else if (runtime && readyService) runtimeCtx.provide(readyService, Object.freeze({ ready: true }));
    } catch (error) {
      if (error?.code !== 'STUDIO_HOST_INCOMPATIBLE') throw error;
      onUnavailable(error);
    }
  });
}
