/** Durable ownership/ID metadata only. Native DSH remains the transcript owner.
 * One isolated Host is the single writer; no cross-replica takeover is claimed.
 */
import { constants } from 'node:fs';
import { open, rename, rm, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { privateRuntimeDirectory } from './runtime-host-installation.mjs';
import { runtimeError } from './runtime-responses-contract.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
export const managedSessionKey = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);

export async function createManagedSessionRegistry(directory) {
  const root = await privateRuntimeDirectory(directory, 'MANAGED_SESSION');
  const sessions = await privateRuntimeDirectory(join(root, 'sessions'), 'MANAGED_SESSION');
  const requests = await privateRuntimeDirectory(join(root, 'requests'), 'MANAGED_SESSION');
  const lanes = new Map();
  const serial = (key, work) => {
    const pending = (lanes.get(key) || Promise.resolve()).catch(() => {}).then(work);
    lanes.set(key, pending);
    void pending.finally(() => { if (lanes.get(key) === pending) lanes.delete(key); }).catch(() => {});
    return pending;
  };
  async function read(path) {
    let handle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 32 * 1024) throw runtimeError('RUNTIME_SESSION_METADATA_INVALID', 503);
      return JSON.parse(await handle.readFile('utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      if (error.status) throw error;
      throw runtimeError('RUNTIME_SESSION_METADATA_UNAVAILABLE', 503);
    } finally { await handle?.close(); }
  }
  async function write(path, value) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    let file;
    try {
      file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      await file.writeFile(JSON.stringify(value) + '\n'); await file.sync();
      await file.close(); file = null;
      await rename(temporary, path);
      const folder = await open(dirname(path), constants.O_RDONLY);
      try { await folder.sync(); } finally { await folder.close(); }
    } finally { await file?.close(); await rm(temporary, { force: true }); }
  }
  const sessionPath = id => {
    if (!managedSessionKey(id)) throw runtimeError('RUNTIME_SESSION_ID_INVALID');
    return join(sessions, hash(id) + '.json');
  };
  function validate(value, id) {
    if (value && (value.format !== 'agentengine.dsh-session/v1' || value.sessionId !== id || !managedSessionKey(value.nativeSessionId)
      || !/^[a-f0-9]{64}$/.test(value.owner || '') || !/^[a-f0-9-]{36}$/.test(value.epoch || '')
      || !['creating', 'ready', 'deleting', 'deleted'].includes(value.phase))) throw runtimeError('RUNTIME_SESSION_METADATA_INVALID', 503);
    return value;
  }
  return {
    serial,
    read: async id => validate(await read(sessionPath(id)), id),
    write: async value => { validate(value, value.sessionId); await write(sessionPath(value.sessionId), value); },
    list: async () => {
      const values = [];
      for (const name of await readdir(sessions)) {
        if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
        const value = await read(join(sessions, name));
        if (!value || name !== hash(value.sessionId || '') + '.json') throw runtimeError('RUNTIME_SESSION_METADATA_INVALID', 503);
        values.push(validate(value, value.sessionId));
      }
      return values;
    },
    request: async (session, runId, invocationId) => {
      if (!/^run_[a-f0-9]{32}$/.test(runId) || !managedSessionKey(invocationId)) throw runtimeError('RUNTIME_REQUEST_ID_INVALID');
      const path = join(requests, hash(JSON.stringify([session.nativeSessionId, runId])) + '.json');
      return serial(path, async () => {
        const value = { format: 'agentengine.dsh-request/v1', nativeSessionId: session.nativeSessionId, runId, invocationId };
        const previous = await read(path);
        if (previous && !isDeepStrictEqual(previous, value)) throw runtimeError('RUNTIME_REQUEST_CONFLICT', 409);
        if (!previous) await write(path, value);
        return value;
      });
    },
    invocationId: async (nativeSessionId, runId) => {
      const value = await read(join(requests, hash(JSON.stringify([nativeSessionId, runId])) + '.json'));
      if (!value || value.format !== 'agentengine.dsh-request/v1' || value.nativeSessionId !== nativeSessionId || value.runId !== runId
        || !managedSessionKey(value.invocationId)) throw runtimeError('RUNTIME_REQUEST_METADATA_UNAVAILABLE', 503);
      return value.invocationId;
    },
  };
}
