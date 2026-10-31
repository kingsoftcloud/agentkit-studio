/** Keep each admission's lifetime inside its official Cordis registry scope.
 * A Host with an existing registry can await `ready` before publishing startup
 * completion. Injection's fork alone is not the async reconciliation result. */
export function bindPresetRegistry(ctx, { createAdmission, publishAdmission, reconcile }) {
  let resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  // Catalog-only Hosts need not await an optional registry. Observe any later
  // failure while leaving Cordis' original activation failure authoritative.
  void ready.catch(() => {});
  const scope = ctx.inject(['agentPresets'], async registryCtx => {
    try {
      const admission = createAdmission(registryCtx.agentPresets);
      let retired = false;
      registryCtx.effect(() => () => {
        retired = true;
        rejectReady(Object.assign(new Error('Preset registry retired during startup'), { code: 'STUDIO_PRESET_REGISTRY_RETIRED' }));
        return admission.dispose();
      }, 'agentkit-studio: dynamic preset cleanup');
      publishAdmission(admission);
      await reconcile(admission);
      if (!retired) resolveReady(admission);
    } catch (error) { rejectReady(error); throw error; }
  });
  return { scope, ready };
}
