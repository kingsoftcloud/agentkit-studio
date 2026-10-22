/** Durable per-cloud-Agent conversation execution mode; never credentials or responses. */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readExecutionMode } from './execution-policy.mjs';

const FORMAT = 'agentkit.cloud-execution-modes/v1';
const validAgentId = value => typeof value === 'string' && /^ar-(?!local-)[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);

/** The runtime still owns the ceiling; this only records the user's selected mode. */
export function createCloudExecutionModes({ directory }) {
  const path = join(directory, 'cloud-execution-modes.json');
  const modes = new Map();
  let ready = null;
  const load = () => ready ||= (async () => {
    let text;
    try { text = await readFile(path, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; return; }
    let value;
    try { value = JSON.parse(text); } catch { return; }
    if (value?.format !== FORMAT || !value.modes || typeof value.modes !== 'object' || Array.isArray(value.modes)) return;
    for (const [agentId, mode] of Object.entries(value.modes)) {
      const parsed = readExecutionMode(mode);
      if (validAgentId(agentId) && parsed) modes.set(agentId, parsed);
    }
  })();
  const persist = async () => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    const value = { format: FORMAT, modes: Object.fromEntries([...modes].sort(([a], [b]) => a.localeCompare(b))) };
    await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
    await rename(temporary, path);
  };
  return Object.freeze({
    async get(agentId) {
      if (!validAgentId(agentId)) return null;
      await load();
      return modes.get(agentId) || null;
    },
    async set(agentId, mode) {
      const parsed = readExecutionMode(mode);
      if (!validAgentId(agentId)) throw Object.assign(new Error('云端 Agent 标识无效'), { code: 'CLOUD_AGENT_ID_INVALID' });
      if (!parsed) throw Object.assign(new Error('云端执行权限无效'), { code: 'CLOUD_EXECUTION_MODE_INVALID' });
      await load();
      modes.set(agentId, parsed);
      await persist();
      return parsed;
    },
    async clear(agentId) {
      await load();
      if (!modes.delete(agentId)) return false;
      await persist();
      return true;
    },
  });
}
