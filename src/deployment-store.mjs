/** Durable intent and single-attempt claims. No credentials or API responses. */
import * as nodeFs from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sha256, portableError } from './portable-resources.mjs';

const valid = id => /^dep_[a-f0-9]{32}$/.test(id || '');
// Network homes, synced folders and filesystems without directory fsync support
// reject fsync with these codes while still accepting the write. Directory fsync
// only protects the new directory entry against power loss and the record content
// is already flushed, so degrade that step instead of dead-ending the deployment
// at the confirm button, which is the last point the user can act on.
const UNSYNCABLE = new Set(['EPERM', 'EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS']);
export const unsyncableDirectory = error => UNSYNCABLE.has(String(error?.code || ''));
const storageFailure = (error, action, storeDir) => error?.syscall
  ? portableError('DEPLOYMENT_STORE_IO_FAILED', `本机部署记录${action}失败（${error.syscall} ${error.code}）：${error.path || storeDir}。请确认记录目录位于本机可写磁盘，网络主目录或同步盘会拒绝文件同步，安全软件也可能拦截；可通过 AGENTKIT_HOME 指向本机目录后重试`)
  : error;

export function createDeploymentStore({ storeDir, clock = Date.now, fs = nodeFs }) {
  const ready = fs.mkdir(storeDir, { recursive: true, mode: 0o700 })
    .catch(error => { throw storageFailure(error, '初始化', storeDir); });
  const locks = new Map();
  const path = id => {
    if (!valid(id)) throw portableError('DEPLOYMENT_ID_INVALID', '部署记录标识无效');
    return join(storeDir, `${id}.json`);
  };
  const timestamp = () => new Date(clock()).toISOString();
  async function durableWrite(target, value) {
    const handle = await fs.open(target, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(value, null, 2)); await handle.sync(); }
    finally { await handle.close(); }
  }
  async function syncDirectory() {
    let directory;
    try { directory = await fs.open(storeDir, 'r'); }
    catch (error) { if (unsyncableDirectory(error)) return; throw error; }
    try { await directory.sync(); }
    catch (error) { if (!unsyncableDirectory(error)) throw error; }
    finally { await directory.close(); }
  }
  // Surface a disk that cannot persist the receipt during the read-only preview,
  // not after the user has already committed a billable cloud create.
  async function preflight() {
    await ready;
    const probe = join(storeDir, `.preflight-${randomUUID()}`);
    try { await durableWrite(probe, { format: 'agentkit.deployment-probe/v1' }); await syncDirectory(); }
    catch (error) { throw storageFailure(error, '写入', storeDir); }
    finally { await fs.rm(probe, { force: true }); }
  }
  async function get(id) {
    await ready;
    let text;
    try { text = await fs.readFile(path(id), 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return null; throw storageFailure(error, '读取', storeDir); }
    try {
      const record = JSON.parse(text);
      if (record.id !== id || record.format !== 'agentkit.deployment/v1' || !record.plan || !Array.isArray(record.events)) throw Error();
      return record;
    } catch { throw portableError('DEPLOYMENT_RECORD_CORRUPT', '部署记录损坏，请保留文件并核对云端结果，不能重新提交创建'); }
  }
  async function create(plan, idempotencyKey) {
    await ready;
    if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{8,200}$/.test(idempotencyKey)) throw portableError('DEPLOYMENT_REQUEST_ID_REQUIRED', '部署需要独立的请求标识');
    const id = `dep_${sha256(idempotencyKey).slice(0, 32)}`, fingerprint = sha256(JSON.stringify(plan)), now = timestamp();
    const record = { format: 'agentkit.deployment/v1', id, fingerprint, plan, state: 'PREPARED', createdAt: now, updatedAt: now,
      cloudAgentId: null, requestId: randomUUID(), events: [{ at: now, state: 'PREPARED' }] };
    const temporary = `${path(id)}.${randomUUID()}.tmp`;
    try { await durableWrite(temporary, record); await fs.link(temporary, path(id)); await syncDirectory(); return { record, created: true }; }
    catch (error) {
      if (error.code !== 'EEXIST') throw storageFailure(error, '写入', storeDir);
      const existing = await get(id);
      if (existing.fingerprint !== fingerprint) throw portableError('DEPLOYMENT_IDEMPOTENCY_CONFLICT', '同一请求标识已用于不同部署，请刷新后检查已有记录');
      return { record: existing, created: false };
    }
    finally { await fs.rm(temporary, { force: true }); }
  }
  function exclusive(id, fn) {
    path(id);
    const next = (locks.get(id) || Promise.resolve()).then(fn, fn), settled = next.catch(() => {});
    locks.set(id, settled);
    void settled.then(() => { if (locks.get(id) === settled) locks.delete(id); });
    return next;
  }
  async function update(id, patch) {
    return exclusive(id, async () => {
      const record = await get(id);
      if (!record) throw portableError('DEPLOYMENT_NOT_FOUND', '部署记录不存在');
      const allowed = new Set(['state', 'cloudAgentId', 'source', 'failure', 'cloudStatus', 'cloudPhase', 'readyReplicas', 'endpoint', 'tokenBound', 'lastCheckedAt', 'activeVersion', 'versions', 'rollout', 'rolloutHistory']);
      if (Object.keys(patch).some(key => !allowed.has(key))) throw portableError('DEPLOYMENT_PATCH_INVALID', '部署记录只允许更新执行状态');
      const next = { ...record, ...patch, updatedAt: timestamp() };
      if (next.state !== record.state) next.events = [...record.events, { at: next.updatedAt, state: next.state }].slice(-200);
      const temp = `${path(id)}.${randomUUID()}.tmp`;
      try { await durableWrite(temp, next); await fs.rename(temp, path(id)); await syncDirectory(); }
      catch (error) { throw storageFailure(error, '更新', storeDir); }
      finally { await fs.rm(temp, { force: true }); }
      return next;
    });
  }
  async function claim(id, action) {
    if (!['upload', 'create', 'token', 'token-repair', 'delete'].includes(action) && !/^upd_[a-f0-9]{32}-(upload|apply)$/.test(action)) throw portableError('DEPLOYMENT_CLAIM_INVALID', '部署动作无效');
    if (!await get(id)) throw portableError('DEPLOYMENT_NOT_FOUND', '部署记录不存在');
    try { await durableWrite(`${path(id)}.${action}`, { at: timestamp() }); await syncDirectory(); return true; }
    catch (error) { if (error.code === 'EEXIST') return false; throw storageFailure(error, '写入', storeDir); }
  }
  async function list() {
    await ready;
    let names;
    try { names = (await fs.readdir(storeDir)).filter(name => /^dep_[a-f0-9]{32}\.json$/.test(name)); }
    catch (error) { throw storageFailure(error, '读取', storeDir); }
    return (await Promise.all(names.map(name => get(name.slice(0, -5))))).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  return { ready, preflight, create, get, update, claim, list };
}
