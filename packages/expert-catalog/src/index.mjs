/** Independently loadable DSH plugin; Studio bundles it as a child plugin. */
export const name = 'agentkit-expert-catalog';
export async function apply(ctx, config = {}) {
  const catalog = config.catalog || await (await import('./release.mjs')).loadExpertCatalog(config.catalogFile);
  ctx.provide('studioTemplates', catalog);
}
export default { name, apply };
