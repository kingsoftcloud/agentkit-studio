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
      if (configured) return configured;
      if (!local || !id) {
        // A Team role blueprint may intentionally omit a model binding (for
        // example an older saved template).  DSH still needs one deterministic
        // route for the root and child Sessions; use the configured default
        // profile for Team-owned synthetic identities instead of inheriting an
        // arbitrary runtime placeholder.
        if (/^team-role-[a-f0-9]{24}$/.test(identity)) {
          const profiles = Array.isArray(settings.values?.modelProfiles) ? settings.values.modelProfiles : [];
          const index = profiles.findIndex(profile => profile?.enabled !== false && profile?.default === true)
            >= 0
            ? profiles.findIndex(profile => profile?.enabled !== false && profile?.default === true)
            : profiles.findIndex(profile => profile?.enabled !== false);
          const profile = index >= 0 ? profiles[index] : undefined;
          if (profile?.modelName) return {
            provider: dshModelSelection({ spec: { bindings: { modelProfileId: profile.id || profile.modelName } } }, settings)?.provider
              || `agentkit-studio-${String(profile.id || profile.modelName).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`.slice(0, 64),
            model: String(profile.modelName).trim(),
          };
        }
        return undefined;
      }
      return dshModelSelection(agent, settings, { resolvedProfile: await models.profile(id) });
    };
}
