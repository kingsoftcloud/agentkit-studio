/** Recover persisted Studio definitions through DSH's public preset registry. */
export async function restoreLocalPresets({store,build,admission,warn=console.warn}) {
  const rows = new Map();
  for (const current of await store.list()) {
    const id = current.metadata.id;
    await store.captureRevision(current);
    for (const item of await build.list(id)) {
      try {
        const frozen = await build.resolve(id,item.id);
        frozen.metadata = {...current.metadata,...frozen.metadata,local:true};
        rows.set(`${id}:${item.id}`,frozen);
        // Existing builds are verified, durable evidence for pre-history
        // revisions; never reconstruct a lost definition from a transcript.
        await store.captureRevision(frozen);
      } catch(error) { warn(`[agentkit-studio] persisted Build revision skipped (${id}):`,error?.message || error); }
    }
    for (const revision of await store.listRevisions(id)) rows.set(`${id}:r${revision.metadata.revision}`,revision);
  }
  for (const record of rows.values()) {
    try { await admission.ensure(record.metadata.id,{agent:record,allowUnavailableResources:true}); }
    catch(error) { warn(`[agentkit-studio] preset restore skipped (${record.metadata.id}:r${record.metadata.revision}):`,error?.message || error); }
  }
}

/** Await local recovery on either registry arrival order; cloud recovery stays independent. */
export function createStartupReconciler({ store, build, deployments, getAdmission, warn = console.warn }) {
  const pending = new WeakMap();
  return {
    run(admission = getAdmission()) {
      if (!admission?.registry) return Promise.resolve();
      if (pending.has(admission)) return pending.get(admission);
      const recovery = (async () => {
        try {
          await restoreLocalPresets({ store: await store, build: (await build).build, admission, warn });
        } catch (error) { warn('[agentkit-studio] local revision recovery failed:', error?.code || 'RECOVERY_FAILED'); }
        void deployments().then(async service => {
          const catalog = await service.agents.recover();
          for (const agent of catalog.items || []) {
            try { await admission.ensure(agent.metadata.id, { agent }); }
            catch (error) { warn('[agentkit-studio] cloud preset restore skipped:', error?.code || 'RECOVERY_FAILED'); }
          }
        }).catch(error => warn('[agentkit-studio] cloud preset recovery unavailable:', error?.code || 'RECOVERY_FAILED'));
      })().finally(() => { pending.delete(admission); });
      pending.set(admission, recovery);
      return recovery;
    },
  };
}
