/** Durable intent and single-attempt claims. No credentials or API responses. */
import { mkdir, open, readFile, readdir, rename, rm, link } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sha256, portableError } from './portable-resources.mjs';

const valid = id => /^dep_[a-f0-9]{32}$/.test(id || '');
export function createDeploymentStore({ storeDir, clock = Date.now }) {
  const ready = mkdir(storeDir, { recursive: true, mode: 0o700 });
  const locks = new Map();
  const path = id => {
    if (!valid(id)) throw portableError('DEPLOYMENT_ID_INVALID', '部署记录标识无效');
    return join(storeDir, `${id}.json`);
  };
  const timestamp = () => new Date(clock()).toISOString();
  async function durableWrite(target, value) {
    const handle = await open(target, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(value, null, 2)); await handle.sync(); }
    finally { await handle.close(); }
  }
  async function syncDirectory() {
    const directory = await open(storeDir, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }
  async function get(id) {
    await ready;
    let text;
    try { text = await readFile(path(id), 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
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
    try { await durableWrite(temporary, record); await link(temporary, path(id)); await syncDirectory(); return { record, created: true }; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = await get(id);
      if (existing.fingerprint !== fingerprint) throw portableError('DEPLOYMENT_IDEMPOTENCY_CONFLICT', '同一请求标识已用于不同部署，请刷新后检查已有记录');
      return { record: existing, created: false };
    }
    finally { await rm(temporary, { force: true }); }
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
      try { await durableWrite(temp, next); await rename(temp, path(id)); await syncDirectory(); }
      finally { await rm(temp, { force: true }); }
      return next;
    });
  }
  async function claim(id, action) {
    if (!['upload', 'create', 'token', 'token-repair', 'delete'].includes(action) && !/^upd_[a-f0-9]{32}-(upload|apply)$/.test(action)) throw portableError('DEPLOYMENT_CLAIM_INVALID', '部署动作无效');
    if (!await get(id)) throw portableError('DEPLOYMENT_NOT_FOUND', '部署记录不存在');
    try { await durableWrite(`${path(id)}.${action}`, { at: timestamp() }); await syncDirectory(); return true; }
    catch (error) { if (error.code === 'EEXIST') return false; throw error; }
  }
  async function list() {
    await ready;
    const names = (await readdir(storeDir)).filter(name => /^dep_[a-f0-9]{32}\.json$/.test(name));
    return (await Promise.all(names.map(name => get(name.slice(0, -5))))).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  return { ready, create, get, update, claim, list };
}
