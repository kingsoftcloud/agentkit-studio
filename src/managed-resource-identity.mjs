/** Resource identity comes from the durable, platform-owned session directory.
 * Model options and request metadata cannot select a memory partition.
 */
import { createManagedSessionRegistry, managedSessionKey } from './managed-session-registry.mjs';

const unavailable = () => Object.assign(new Error('托管资源缺少可核对的会话归属'), {
  code: 'MANAGED_RESOURCE_IDENTITY_UNAVAILABLE', status: 503,
});

export async function createManagedResourceIdentityResolver({ runtime, directory }) {
  const { agentId, versionId } = runtime?.identity || {};
  if (!managedSessionKey(agentId) || !managedSessionKey(versionId)) throw unavailable();
  const registry = await createManagedSessionRegistry(directory);
  const nativeToPublic = new Map();
  return async key => {
    if (key?.agentId !== agentId || !managedSessionKey(key?.sessionId)) throw unavailable();
    let record;
    const publicId = nativeToPublic.get(key.sessionId);
    if (publicId) record = await registry.read(publicId);
    else {
      const matches = (await registry.list()).filter(item => item.nativeSessionId === key.sessionId);
      if (matches.length !== 1) throw unavailable();
      [record] = matches;
    }
    // Re-read the authoritative record on every model step: a cached mapping
    // cannot keep a deleted session or a different platform version usable.
    if (!record || record.nativeSessionId !== key.sessionId || record.phase !== 'ready'
      || record.versionId !== versionId || record.userId !== `aeu_${record.owner}`) throw unavailable();
    nativeToPublic.set(key.sessionId, record.sessionId);
    return record.userId;
  };
}
