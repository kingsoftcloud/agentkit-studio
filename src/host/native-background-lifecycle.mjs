/** Start cold background recovery when the real Session services are ready.
 * A dependency replacement retires the previous watcher before starting its
 * successor. No prompt, Session prewarming, or timer stands in for readiness.
 */
export function bindNativeBackgroundRuntime(ctx, { getHost, readyService, onError }) {
  let retired = Promise.resolve();
  const dependencies = ['sessions', 'sessionProjections', 'llm', 'agentPresets', 'sessionController', 'agents', 'permissionPresets', 'approval'];
  if (readyService) dependencies.push(readyService);
  return ctx.inject(dependencies, async runtimeCtx => {
    const previous = retired;
    let release;
    retired = new Promise(resolve => { release = resolve; });
    const controller = new AbortController();
    let resource, closing;
    const startup = previous.then(async () => {
      if (controller.signal.aborted || runtimeCtx.fiber.uid === null) return;
      const host = await getHost();
      if (controller.signal.aborted || runtimeCtx.fiber.uid === null) return;
      resource = await host.startBackgroundWatcher({ signal: controller.signal });
      if (controller.signal.aborted || runtimeCtx.fiber.uid === null) await resource.close();
    });
    const close = () => {
      if (closing) return closing;
      controller.abort(new Error('Studio background runtime dependencies retired'));
      return closing = startup.catch(() => {}).then(() => resource?.close()).finally(release);
    };
    runtimeCtx.effect(() => close, 'agentkit-studio: Native background dependencies');
    try { await startup; }
    catch (error) {
      const wasRetired = controller.signal.aborted || runtimeCtx.fiber.uid === null;
      await close();
      if (wasRetired) return;
      onError?.(error);
      throw error;
    }
  });
}
