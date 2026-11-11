/** Resolve a new Session's model without changing persisted Session projections. */
export function createAgentModelSelection({ models, agentStorePromise, codexModels, selectCodexAgentModel, CLOUD_PROVIDER, dshModelSelection }) {
  return async agent => {
      const local = agent?.metadata?.local !== false && agent?.source !== 'agentengine-server';
      if (!local) return { provider: CLOUD_PROVIDER, model: agent.deployment.model };
      // Team runtime members use a synthetic `team-role-*` identity while
      // their source Agent remains persisted under `ar-local-*`. They are
      // admitted into a DSH Session, but must not be written back as local
      // Agent revisions. Keep the historical archive behavior for real local
      // Agent records only; ordinary callers without an id retain the
      // historical archive behavior used by the admission fixtures.
      const identity = String(agent?.metadata?.id || '');
      const syntheticTeamIdentity = /^team-role-[a-f0-9]{24}$/.test(identity);
      if (!syntheticTeamIdentity && !agent.buildId && !agent.managedRuntime) await (await agentStorePromise).captureRevision(agent);
      if (local && agent?.spec?.runtime?.type === 'codex') return selectCodexAgentModel(agent, { models, catalog: codexModels });
      const settings = { values: await models.settings() };
      const configured = dshModelSelection(agent, settings);
      const bindings = agent?.spec?.bindings || {}, first = bindings.modelProfileIds?.[0];
      const id = bindings.modelProfileId || (typeof first === 'string' ? first : first?.resourceId);
      return configured || (!local || !id ? undefined : dshModelSelection(agent, settings, { resolvedProfile: await models.profile(id) }));
    };
}
