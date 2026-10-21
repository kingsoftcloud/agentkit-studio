/** Durable first-use flow over the existing Agent, Build and Deployment services. */
import { mkdir, readFile, open, rename, rm, link } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sha256, portableError } from './portable-resources.mjs';
import { createDeploymentImages } from './deployment-images.mjs';
import { admitDeploymentStorage } from './deployment-storage.mjs';
import { listStudioResources } from './resource-catalog.mjs';
import { ASSISTANT_MANAGED_PERMISSION_CAPABILITY } from './contracts/assistant-capabilities.mjs';

export const ASSISTANT_WELCOME_REQUEST = 'assistant-welcome-v1';
const resources = Object.freeze({ cpu: 2, memoryGiB: 4, storageGiB: 20 });
const labels = { PREPARING: '正在准备你的助理', UPLOADING: '正在保存助理配置', UPLOADED: '正在创建云端环境', PREPARED: '正在准备云端环境', CREATING: '正在创建云端环境', PROVISIONING: '正在分配云端资源', CONFIGURING: '正在连接你的助理', TOKEN_PENDING: '正在连接你的助理', STARTING: '助理正在启动', READY: '助理已就绪', AVAILABLE_UPDATING: '助理已就绪' };
const readyStates = new Set(['READY', 'AVAILABLE_UPDATING']);

export function createAssistantSetup({ storeDir, configuration, models, serverClient, deploymentClient, agents, build, deployments, fetchImpl = fetch }) {
  const images = createDeploymentImages({ client: deploymentClient, configuration });
  const active = new Map(), errors = new Map();
  async function scope() {
    const { values } = await configuration.resolve();
    if (!values.cloudAccessKey || !values.cloudSecretKey) throw portableError('CLOUD_CREDENTIALS_MISSING', '请先配置云端凭证，再开通个人助理');
    return sha256(JSON.stringify([values.cloudServerUrl || '', values.cloudRegion || '', values.cloudCustomSource || '', values.cloudAccessKey]));
  }
  const path = key => join(storeDir, `${key}.json`);
  async function read(key) {
    try {
      const record = JSON.parse(await readFile(path(key), 'utf8'));
      if (record.format !== 'agentkit.assistant-setup/v1' || record.scope !== key) throw Error();
      return record;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw portableError('ASSISTANT_SETUP_CORRUPT', '开通记录无法读取，请保留记录并核对云端实例');
    }
  }
  async function write(record) {
    await mkdir(storeDir, { recursive: true, mode: 0o700 });
    const temporary = `${path(record.scope)}.${randomUUID()}.tmp`;
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(record)); await file.sync(); } finally { await file.close(); }
    try { await rename(temporary, path(record.scope)); } finally { await rm(temporary, { force: true }); }
    const directory = await open(storeDir, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }
  async function locked(key, work) {
    await mkdir(storeDir, { recursive: true, mode: 0o700 });
    const target = `${path(key)}.lock`;
    // Publish a complete owner record atomically. A crash before publication
    // leaves only an unused temporary file, never an unreadable live lock.
    const temporary = `${target}.${randomUUID()}.tmp`;
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify({ pid: process.pid })); await file.sync(); } finally { await file.close(); }
    try { await link(temporary, target); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let owner;
      try { owner = JSON.parse(await readFile(target, 'utf8')); }
      catch (e) {
        if (e.code === 'ENOENT') return locked(key, work);
        throw portableError('ASSISTANT_SETUP_LOCK_INVALID', '开通锁记录无法读取，请保留记录并核对云端实例');
      }
      if (!Number.isSafeInteger(owner.pid) || owner.pid < 1) throw portableError('ASSISTANT_SETUP_LOCK_INVALID', '开通锁记录无效，请核对云端实例');
      try { process.kill(owner.pid, 0); return; } catch (e) { if (e.code !== 'ESRCH') return; }
      await rm(target, { force: true });
      return locked(key, work);
    } finally { await rm(temporary, { force: true }); }
    try { return await work(); }
    finally { await rm(target, { force: true }); }
  }
  function publicState(record) {
    if (!record) return { state: 'NOT_STARTED' };
    return { state: record.state, message: record.failure?.message || labels[record.state] || '请核对开通状态',
      ready: readyStates.has(record.state), cloudAgentId: record.cloudAgentId || null, deploymentId: record.deploymentId || null,
      failure: record.failure || null, resources, startedAt: record.startedAt };
  }
  async function options() {
    const key = await scope();
    const [model, catalog, memory] = await Promise.all([models.profile(''), images.list('dsh-native'), listStudioResources({ serverClient, query: { kind: 'memory-instance', limit: 200 } })]);
    const eligible = catalog.releases.filter(item => item.runtimeIdentity && item.capabilities.includes('personal-assistant/v1') && item.capabilities.includes(ASSISTANT_MANAGED_PERMISSION_CAPABILITY));
    const image = eligible.find(item => item.id === catalog.defaultReleaseId) || (eligible.length === 1 ? eligible[0] : null);
    if (!image) throw portableError('ASSISTANT_IMAGE_UNAVAILABLE', '当前环境还没有支持受管工作区与敏感审批的个人助理镜像，请先更新云端版本配置');
    admitDeploymentStorage(resources, catalog, 'dsh-native');
    const memories = memory.items.filter(item => !item.disabled).map(item => ({ id: item.resourceId, name: item.name || item.resourceId, region: item.region || catalog.region }));
    if (!memories.length) throw portableError('ASSISTANT_MEMORY_REQUIRED', '请先创建一个云端记忆库，再开通能够长期记忆的助理');
    return { optionsId: sha256(JSON.stringify([key, catalog.revision, image.id, model.id, memories, 'workspace-managed/v1'])), model: { id: model.id, name: model.displayName || model.modelName },
      permissionProfile: 'workspace-managed/v1',
      permissionNotice: '助理可联网搜索公开信息、读取公开网页，并在专属云工作区读写文件；删除单个文件需在线逐次确认。内网与本机访问、任意 Shell、未接通的外发与支付不会自动开放。',
      memories, releaseId: image.id, environment: catalog.environment, region: catalog.region, resources,
      billingNotice: '开通后创建 1 个常驻实例（2 核 / 4 GiB）和 20 GiB 持久存储，按平台规则计费；关闭 Studio 不会停止云端计费。' };
  }
  async function welcome(record) {
    const connection = await deployments.agents.connect(record.cloudAgentId);
    if (!connection.capabilities.includes('personal-assistant/v1')) throw portableError('ASSISTANT_IMAGE_UPGRADE_REQUIRED', '云端版本未提供个人助理能力');
    if (record.selection?.permissionProfile === 'workspace-managed/v1' && !connection.capabilities.includes(ASSISTANT_MANAGED_PERMISSION_CAPABILITY)) throw portableError('ASSISTANT_IMAGE_UPGRADE_REQUIRED', '当前云端版本未确认受管工作区权限能力，尚未发送欢迎任务');
    const call = async (operation, input) => {
      const response = await fetchImpl(`${connection.endpoint}/v1/assistant/${operation}`, { method: 'POST', headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(input), redirect: 'error', signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw portableError('ASSISTANT_WELCOME_PENDING', '助理正在准备欢迎消息，请稍后刷新');
      return response.json();
    };
    const snapshot = await call('snapshot', {});
    if (!snapshot.messages.length) {
      const result = await call('submit', { requestId: ASSISTANT_WELCOME_REQUEST, text: '用户刚开通了个人助理。请用两三句自然的中文欢迎用户，说明你可以帮他查资料（联网搜索、读取网页）、整理手头文件、设置提醒，并在他明确要求时记住偏好。不要声称已经执行了任务或记录了记忆，最后问用户想先做什么。' });
      if (!result.accepted || result.requestId !== ASSISTANT_WELCOME_REQUEST) throw portableError('ASSISTANT_WELCOME_PENDING', '欢迎消息尚未确认，请稍后刷新');
    }
    record.welcomed = true;
  }
  async function drive(key) {
    await locked(key, async () => {
      let record = await read(key);
      if (!record || record.scope !== await scope()) return;
      try {
        if (!record.agentId) {
          const selected = record.selection;
          const agent = await agents.create({ name: '我的个人助理', purpose: 'personal-assistant', runtimeType: 'dsh-native', spec: {
            ...(selected.permissionProfile === 'workspace-managed/v1' ? { security: { assistantPermissions: { profile: selected.permissionProfile } } } : {}),
            instructions: { system: '你是用户的个人助理。自然、简洁地用中文交流。你可以联网搜索公开信息、读取公开网页，在专属云端工作区读写文件，管理提醒，并在用户明确要求时记录长期记忆。不能运行任意命令，也不能访问内网、本机或需要登录的内容；做不到时直接说明，不要编造设置项或声称未执行的事情。准确区分计划和已执行的工作。' },
            memory: { enabled: true, write: { mode: 'explicit_only' } },
            bindings: { modelProfileId: selected.modelId, plugins: [{ name: 'memory', config: { binding: { resource: { kind: 'memory-instance', ...selected.memory } } } }] },
          } });
          record.agentId = agent.metadata.id; await write(record);
        }
        if (!record.buildId) {
          const agent = await agents.get(record.agentId);
          const frozen = await build.build({ agentId: agent.metadata.id, agentName: agent.metadata.name, revision: agent.metadata.revision, metadata: agent.metadata, spec: agent.spec, bindings: agent.bindings });
          record.buildId = frozen.id; await write(record);
        }
        if (!record.preview) {
          record.preview = await deployments.prepare({ agentId: record.agentId, buildId: record.buildId, releaseId: record.selection.releaseId, resources });
          await write(record);
        }
        let deployment;
        try { deployment = await deployments.get(record.deploymentId); }
        catch (error) { if (error.code !== 'DEPLOYMENT_NOT_FOUND') throw error; }
        if (!deployment) {
          deployment = await deployments.create({ agentId: record.agentId, buildId: record.buildId, releaseId: record.selection.releaseId, resources,
            bundleId: record.preview.bundleId, previewId: record.preview.previewId, idempotencyKey: record.requestId });
        } else deployment = await deployments.refresh(record.deploymentId);
        record.state = deployment.state;
        record.cloudAgentId = deployment.cloudAgentId;
        record.failure = deployment.failure || null;
        if (readyStates.has(record.state) && !record.welcomed) await welcome(record);
        await write(record);
      } catch (error) {
        record.failure = { code: /^[A-Z_]{3,80}$/.test(error.code || '') ? error.code : 'ASSISTANT_SETUP_FAILED', message: '开通尚未完成，请刷新核对现有实例；不会重复创建云端助理。' };
        record.state = 'ACTION_REQUIRED'; await write(record);
      }
    });
  }
  function kick(key) {
    if (active.has(key)) return;
    errors.delete(key);
    const work = drive(key).catch(error => errors.set(key, error)).finally(() => active.delete(key));
    active.set(key, work);
  }
  async function status() {
    const key = await scope(), record = await read(key);
    if (errors.has(key)) { const error = errors.get(key); errors.delete(key); throw error; }
    if (record?.deploymentId && record.state !== 'DELETED' && (await deployments.get(record.deploymentId).catch(error => {
      if (error.code !== 'DEPLOYMENT_NOT_FOUND') throw error;
      return null;
    }))?.state === 'DELETED') {
      await locked(key, async () => {
        const latest = await read(key);
        if (latest?.deploymentId === record.deploymentId) { latest.state = 'DELETED'; latest.failure = null; await write(latest); }
      });
      return publicState(await read(key));
    }
    if (record && !['DELETED', 'FAILED', 'CREATE_UNKNOWN', 'UPLOAD_UNKNOWN'].includes(record.state) && !(readyStates.has(record.state) && record.welcomed)) kick(key);
    return publicState(record);
  }
  async function start(input = {}) {
    if (input.confirmed !== true) throw portableError('ASSISTANT_CONFIRM_REQUIRED', '请确认资源规格和计费提示后开通');
    const key = await scope();
    const previous = await status();
    if (!['NOT_STARTED', 'DELETED'].includes(previous.state)) {
      const existing = await read(key);
      if (!(readyStates.has(existing.state) && existing.welcomed)) kick(key);
      return publicState(existing);
    }
    const available = await options();
    if (input.optionsId !== available.optionsId) throw portableError('ASSISTANT_OPTIONS_CHANGED', '开通配置已变化，请刷新后确认');
    const memory = available.memories.find(item => item.id === input.memoryId) || (available.memories.length === 1 && !input.memoryId ? available.memories[0] : null);
    if (!memory) throw portableError('ASSISTANT_MEMORY_REQUIRED', '请选择保存助理记忆的云端记忆库');
    await locked(key, async () => {
      const existing = await read(key);
      if (existing && existing.state !== 'DELETED') return;
      // One intent per account/environment. Even concurrent recovery cannot
      // turn the same opening action into a second billable cloud create.
      const requestId = existing ? `assistant-${key}-${randomUUID()}` : `assistant-${key}`;
      await write({ format: 'agentkit.assistant-setup/v1', scope: key, state: 'PREPARING', startedAt: new Date().toISOString(), requestId,
        deploymentId: `dep_${sha256(requestId).slice(0, 32)}`, selection: { modelId: available.model.id, memory, releaseId: available.releaseId, permissionProfile: available.permissionProfile } });
    });
    kick(key); return publicState(await read(key));
  }
  // Read-only lineage lookup: catalog/binding must never start deployment work.
  async function reference() {
    let key;
    try { key = await scope(); } catch (error) { if (error.code === 'CLOUD_CREDENTIALS_MISSING') return null; throw error; }
    const record = await read(key);
    return record ? { agentId: record.agentId, cloudAgentId: record.cloudAgentId, deploymentId: record.deploymentId } : null;
  }
  return { options, start, status, reference };
}
