/** The configured runtime lives exactly as long as its native dependencies. */
export function bindFrozenRuntime(ctx, { start, onUnavailable }) {
  return ctx.inject(['agentPresets', 'sessionController', 'agents', 'commands', 'approval'], async runtimeCtx => {
    let stopped = false, runtime;
    runtimeCtx.effect(() => () => { stopped = true; return runtime?.close(); }, 'agentkit-studio: frozen runtime dependencies');
    try {
      runtime = await start(runtimeCtx);
      if (stopped) await runtime?.close();
    } catch (error) {
      if (error?.code !== 'STUDIO_HOST_INCOMPATIBLE') throw error;
      onUnavailable(error);
    }
  });
}
