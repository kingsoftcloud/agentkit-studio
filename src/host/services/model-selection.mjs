/** Resolve a new Session's model without changing persisted Session projections. */
export function createAgentModelSelection({ models, agentStorePromise, codexModels, selectCodexAgentModel, CLOUD_PROVIDER, dshModelSelection }) {
  return async agent => {
      const local = agent?.metadata?.local !== false && agent?.source !== 'agentengine-server';
      if (!local) return { provider: CLOUD_PROVIDER, model: agent.deployment.model };
      if (local && !agent.buildId && !agent.managedRuntime) await (await agentStorePromise).captureRevision(agent);
      if (local && agent?.spec?.runtime?.type === 'codex') return selectCodexAgentModel(agent, { models, catalog: codexModels });
      const settings = { values: await models.settings() };
      const configured = dshModelSelection(agent, settings);
      const bindings = agent?.spec?.bindings || {}, first = bindings.modelProfileIds?.[0];
      const id = bindings.modelProfileId || (typeof first === 'string' ? first : first?.resourceId);
      return configured || (!local || !id ? undefined : dshModelSelection(agent, settings, { resolvedProfile: await models.profile(id) }));
    };
}
