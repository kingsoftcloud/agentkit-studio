import { hostFetch } from '../../http-fetch.mjs';
/** Legacy REST/SSE consumer; preserve per-request handler construction. */
export function createLegacyLocalConversationFactory(ctx, {
  agentStorePromise, configurationPromise, resourceAdaptersPromise, studioObservabilityPromise,
}) {
  return () => Promise.all([
    agentStorePromise, configurationPromise, resourceAdaptersPromise, studioObservabilityPromise,
  ]).then(async ([store, configuration, resourceAdapters, observability]) => {
    const credentials = ctx.get('credentials');
    const models = await import('../../model-service.mjs').then(({ createModelService }) =>
      createModelService({ configuration, credentials }));
    const { createLocalConversationHandler } = await import('../../local-runtime.mjs');
    return createLocalConversationHandler({ agentStore: async () => store, modelService: models, resourceAdapter: resourceAdapters, fetchImpl: hostFetch, observability });
  });
}
