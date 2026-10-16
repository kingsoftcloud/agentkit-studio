/** Durable deletion journal: retired data is never confused with confirmed cloud removal. */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
const fail = (code, message) => Object.assign(new Error(message), { code, status: 409 });
export function createAssistantLifecycle({ directory, deployments, fetchImpl = fetch }) {
  const active = new Map();
  async function close(payload) {
    if (payload.confirmAgentId !== payload.agentId || !payload.deploymentId || !payload.versionId) throw fail('ASSISTANT_DELETE_CONFIRMATION_REQUIRED', '请确认要删除的助理及当前部署版本');
    const key = createHash('sha256').update(JSON.stringify([payload.agentId, payload.deploymentId])).digest('hex');
    if (active.has(key)) return active.get(key);
    const operation = execute(payload, key).finally(() => { if (active.get(key) === operation) active.delete(key); });
    active.set(key, operation); return operation;
  }
  async function execute(payload, key) {
    const service = await deployments();
    let record = await service.get(payload.deploymentId);
    if (record.cloudAgentId !== payload.agentId || record.runtime !== 'dsh-native' || record.versionId !== payload.versionId) throw fail('ASSISTANT_DELETE_SCOPE_CHANGED', '助理或部署版本已变化，请刷新后重新确认');
    const file = join(directory, key + '.json');
    let journal;
    try { journal = JSON.parse(await readFile(file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (journal && journal.versionId !== payload.versionId) throw fail('ASSISTANT_DELETE_SCOPE_CHANGED', '关闭记录与当前版本不符，请核对部署');
    const save = async value => { await mkdir(directory, { recursive: true, mode: 0o700 }); await writeFile(file + '.next', JSON.stringify(value), { mode: 0o600 }); await rename(file + '.next', file); journal = value; };
    if (!journal?.cleanup) {
      const connection = await service.agents.connect(payload.agentId);
      if (connection.agent.deployment.id !== payload.deploymentId || !connection.capabilities.includes('personal-assistant-delete/v1')) throw fail('ASSISTANT_DELETE_UPGRADE_REQUIRED', '请更新专属云端助理镜像后关闭，以确保会话和记忆能够清理');
      await save({ versionId: payload.versionId, phase: 'cleaning' });
      // No implicit retry of an unknown mutation; the user can retry the same journal.
      const response = await fetchImpl(`${connection.endpoint}/v1/assistant/close`, { method: 'POST', redirect: 'error',
        headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(120000) });
      const cleanup = await response.json();
      if (!response.ok || cleanup.deleted !== true || cleanup.historyDeleted !== true || cleanup.memoryDeleted !== true
        || cleanup.agentId !== record.agentId || cleanup.buildId !== record.buildId) throw fail('ASSISTANT_DELETE_UNCONFIRMED', '助理专属数据清理尚未确认，云端部署未删除');
      await save({ versionId: payload.versionId, phase: 'removing', cleanup });
    }
    if (record.state !== 'DELETED') record = await service.remove(payload.deploymentId);
    const deleted = record.state === 'DELETED';
    await save({ ...journal, phase: deleted ? 'closed' : 'removing' });
    return { status: deleted ? 'closed' : 'deleting', deleted, deploymentId: payload.deploymentId,
      historyDeleted: true, memoryDeleted: true };
  }
  return { close };
}
