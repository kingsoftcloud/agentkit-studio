// Keep DOM asset leases across replacement bundle evaluations. This record
// contains document effects only; connections and business state stay scoped.
const resources = Symbol.for('agentkit-studio:document-resources');

/** Overlapping mounts share document assets until the final owner releases. */
export function leaseDocumentResource(document, key, install) {
  let records = document[resources];
  if (!records) { records = new Map(); Object.defineProperty(document, resources, { value: records, configurable: true }); }
  let record = records.get(key);
  if (!record) { record = { count: 0, dispose: install() }; records.set(key, record); }
  record.count++;
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    if (--record.count === 0 && records.get(key) === record) {
      records.delete(key); record.dispose?.();
      if (!records.size && document[resources] === records) delete document[resources];
    }
  };
}
