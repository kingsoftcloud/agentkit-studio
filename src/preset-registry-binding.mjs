/** Keep each admission's lifetime inside its official Cordis registry scope. */
export function bindPresetRegistry(ctx, { createAdmission, publishAdmission, reconcile }) {
  return ctx.inject(['agentPresets'], async registryCtx => {
    const admission = createAdmission(registryCtx.agentPresets);
    publishAdmission(admission);
    registryCtx.effect(() => () => admission.dispose(), 'agentkit-studio: dynamic preset cleanup');
    await reconcile(admission);
  });
}
