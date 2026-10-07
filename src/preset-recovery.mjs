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
    try { await admission.ensure(record.metadata.id,{agent:record}); }
    catch(error) { warn(`[agentkit-studio] preset restore skipped (${record.metadata.id}:r${record.metadata.revision}):`,error?.message || error); }
  }
}
