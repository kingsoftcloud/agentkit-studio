import { join } from "node:path";
import { listPlatformResources } from "../../platform-resource-bindings.mjs";
import * as ExpertCatalogPlugin from "../../../packages/expert-catalog/src/index.mjs";
async function createTemplateServices(ctx, { storeDir: studioStoreDir, env: runtimeEnv, configurationPromise, serverClientPromise, skillDiscoveryPromise, localMcpStorePromise, mcpProbePromise, agentStorePromise, credentialsService, models, listCodexAgentModels, codexModels, getTeamTemplates }) {
  const templateCatalog = await (await import("../../template-catalog-source.mjs")).createTemplateCatalogSource({ studioStoreDir, env: runtimeEnv, configuration: () => configurationPromise, serverClient: () => serverClientPromise });
  ctx.plugin(ExpertCatalogPlugin, { catalog: templateCatalog });
  const templateDependencies = (await import("../../catalog-dependencies.mjs")).createCatalogDependencies({
    catalog: templateCatalog,
    packageStore: join(studioStoreDir, "template-packages"),
    skillDiscovery: await skillDiscoveryPromise,
    mcpStore: await localMcpStorePromise,
    probeMcp: async (id) => (await mcpProbePromise).probe(id)
  });
  const templateOptions = {
    catalog: templateCatalog,
    store: await agentStorePromise,
    dependencies: templateDependencies,
    platformResources: async (kind) => listPlatformResources(await serverClientPromise, kind),
    resources: async (kind, runtimeType) => {
      if (kind === "model" && runtimeType === "codex") return listCodexAgentModels({ models, catalog: codexModels });
      const serverClient = await serverClientPromise;
      if (kind === "tool") return serverClient.listCatalogResources({ kind, limit: 200 });
      const { listStudioResources } = await import("../../resource-catalog.mjs");
      const items = [];
      let cursor;
      do {
        const result = await listStudioResources({
          query: { kind, limit: 200, cursor },
          models,
          serverClient,
          localMcpStore: await localMcpStorePromise,
          skillDiscovery: await skillDiscoveryPromise
        });
        items.push(...result.items);
        cursor = result.nextCursor;
      } while (cursor);
      return { items };
    }
  };
  const templateAuthoring = (await import("../../template-authoring.mjs")).createTemplateAuthoring(templateOptions);
  const templateSummon = (await import("../../template-summon.mjs")).createTemplateSummon({ ...templateOptions, authoring: templateAuthoring, models, operationDir: join(studioStoreDir, "template-summons") });
  const templateResources = (await import("../../template-resource-library.mjs")).createTemplateResourceLibrary({ catalog: templateCatalog, dependencies: templateDependencies, skills: await skillDiscoveryPromise, mcps: await localMcpStorePromise, credentials: credentialsService });
  const templateWorkflows = (await import("../../template-workflows.mjs")).createTemplateWorkflows({ directory: join(studioStoreDir, "template-workflows"), summon: (payload) => templateSummon.summon(payload), summonTeam: (payload) => getTeamTemplates().summon(payload), catalog: templateCatalog, authoring: templateAuthoring, dependencies: templateDependencies, resourceLibrary: templateResources });
  ctx.effect(() => () => templateWorkflows.close(), "agentkit-studio: template workflow lifetime");
  return { templateCatalog, templateAuthoring, templateSummon, templateResources, templateWorkflows };
}
export {
  createTemplateServices
};
