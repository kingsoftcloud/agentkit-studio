import { listPlatformResources } from "../../platform-resource-bindings.mjs";
import { readCatalogAvatar } from "../../catalog-dependencies.mjs";
import { exportTemplateDefinition } from "../../../packages/expert-catalog/src/catalog.mjs";
function createTemplateRoutes({ templateCatalog, templateAuthoring, templateSummon, templateResources, templateWorkflows, studioTeams, teamTemplates, agentStorePromise, serverClientPromise }) {
  return async (endpoint, payload, signal) => {
    if (endpoint.startsWith("team-templates/")) return { ok: true, value: await teamTemplates[endpoint.slice(15)](payload) };
    if (endpoint.startsWith("teams/")) return { ok: true, value: await studioTeams[endpoint.slice(6)](payload) };
    if (endpoint === "templates/list") return { ok: true, value: await templateSummon.list() };
    if (endpoint.startsWith("template-workflows/")) return { ok: true, value: await templateWorkflows[endpoint.split("/")[1]](payload) };
    if (endpoint.startsWith("template-resources/")) return { ok: true, value: await templateResources[endpoint.split("/")[1]](payload) };
    if (endpoint === "templates/avatar") return { ok: true, value: await readCatalogAvatar(templateCatalog, payload) };
    if (endpoint === "templates/prepare") return { ok: true, value: await templateWorkflows.prepare(payload, { signal }) };
    if (endpoint === "templates/summon-plan") return { ok: true, value: await templateSummon.plan(payload) };
    if (endpoint === "templates/summon") return { ok: true, value: await templateSummon.summon({ ...payload, signal }) };
    if (endpoint === "templates/export") {
      const record = await (await agentStorePromise).getRevision(payload?.agentId, payload?.revision);
      return { ok: true, value: exportTemplateDefinition(record) };
    }
    if (endpoint === "platform/resources") return { ok: true, value: await listPlatformResources(await serverClientPromise, payload?.kind, { signal }) };
  };
}
export {
  createTemplateRoutes
};
