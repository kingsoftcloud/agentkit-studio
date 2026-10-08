/** Only local deployment receipts establish Studio cloud Agent lineage. */
import { currentDeployment, deploymentVersions, deploymentVersionId, probeDeploymentVersion } from './deployment-versions.mjs';
import { verifyPortableBundle } from './portable-bundle.mjs';
import { portableError, sha256 } from './portable-resources.mjs';
import { verifyDeploymentStorage } from './deployment-storage.mjs';

const supported = new Set(['harness', 'dsh-native', 'codex']);
const available = new Set(['READY', 'AVAILABLE_UPDATING']);
export const CLOUD_PROVIDER = 'agentkit-studio-cloud';

export function createDeploymentAgents({ store, build, portableBundles, configuration, credentialScope, owned, detail, endpointFor, fetchImpl }) {
  async function records(includeDeleted = false) {
    const { values } = await configuration.resolve();
    const scope = credentialScope(values);
    return (await store.list()).filter(row => row.cloudAgentId && (includeDeleted || row.state !== 'DELETED')
      && row.plan.credentialScope === scope && supported.has(row.plan.runtime));
  }
  async function project(record) {
    record = currentDeployment(record);
    const frozen = await build.resolve(record.plan.agentId, record.plan.buildId);
    const zip = Buffer.from((await portableBundles.download(record.plan.agentId, record.plan.buildId, record.plan.bundleId)).base64, 'base64');
    if (sha256(zip) !== record.plan.bundleSha256) throw portableError('DEPLOYMENT_PROVENANCE_MISMATCH', '冻结运行包与部署记录不一致');
    const { manifest } = verifyPortableBundle(zip);
    if (manifest.agentId !== record.plan.agentId || manifest.buildId !== record.plan.buildId) throw portableError('DEPLOYMENT_PROVENANCE_MISMATCH', '冻结运行包身份不一致');
    const profile = manifest.resources.profiles.find(item => item.default) || manifest.resources.profiles[0];
    if (!profile?.modelName) throw portableError('DEPLOYMENT_MODEL_MISSING', '冻结版本缺少模型配置');
    return { source: 'studio-deployment', metadata: { ...frozen.metadata, id: record.cloudAgentId, local: false,
      name: record.plan.agentName, createdAt: record.createdAt }, spec: frozen.spec,
      deployment: { id: record.id, versionId: deploymentVersionId(record), agentId: record.plan.agentId, buildId: record.plan.buildId, bundleId: record.plan.bundleId,
        state: record.state, available: available.has(record.state), model: profile.modelName,
        environment: record.plan.environment, region: record.plan.region } };
  }
  async function get(agentId) {
    const record = (await records(true)).find(row => row.cloudAgentId === agentId);
    if (!record) throw portableError('DEPLOYMENT_AGENT_NOT_FOUND', '当前账号下没有该 Agent 的 Studio 部署记录');
    if (record.state === 'DELETED') throw portableError('DEPLOYMENT_DELETED', '云端实例已删除；历史对话仍可查看，请选择就绪的部署开启新会话');
    return project(await owned(record.id));
  }
  // Never exposed as a browser RPC: the platform token stays on the Node Host.
  async function connect(agentId) {
    const agent = await get(agentId), record = await owned(agent.deployment.id);
    if (!available.has(record.state)) throw portableError('DEPLOYMENT_NOT_READY', '云端部署尚未就绪，请在运行中心刷新状态');
    const remote = await detail(record), token = remote.QuickAccess?.ApiKey;
    verifyDeploymentStorage(remote, currentDeployment(record));
    if (!['RUNNING', 'UPDATING'].includes(remote.Basic?.Status) || !(remote.Basic?.ReadyReplicas > 0)) throw portableError('DEPLOYMENT_NOT_READY', '云端实例当前不可用，请在运行中心查看状态');
    const endpoint = endpointFor(remote, record);
    if (!endpoint || typeof token !== 'string' || token.length < 24 || token.includes('*')) throw portableError('DEPLOYMENT_NOT_READY', '云端访问配置尚未就绪');
    if (record.activeVersion && !await probeDeploymentVersion({ fetchImpl, endpoint, token, plan: currentDeployment(record).plan, versionId: deploymentVersionId(record) })) {
      throw portableError('DEPLOYMENT_NOT_READY', '运行入口尚未确认当前冻结版本，请刷新部署状态后重试');
    }
    return { agent, endpoint, token };
  }
  async function projectRows(rows) {
    const items = [], warnings = [];
    for (const record of rows) {
      try { items.push(await project(record)); }
      catch { warnings.push(`部署 ${record.id} 的冻结版本不可读取，请在运行中心核对`); }
    }
    return { items, warnings };
  }
  return { list: async () => projectRows(await records()), get, connect,
    // Restore display-only presets even after deletion or a credential switch.
    // Every new turn still passes connect() with the current credential scope.
    recover: async () => projectRows((await store.list()).filter(row => row.cloudAgentId && supported.has(row.plan.runtime))
      .flatMap(row => deploymentVersions(row).map(version => ({ ...row, activeVersion: version })))) };
}

/** Frozen cloud models need no desktop model credentials or local Codex login. */
export function createDeploymentModelAdapter({ agents, runtime }) {
  const metadata = (provider, model) => ({ provider, id: model, name: model, modalities: ['text'] });
  return Object.assign(Object.create(Object.getPrototypeOf(runtime)), runtime, {
    providerInfo(provider) { return { id: provider, name: '云端部署' }; },
    async listModels(provider) { return [...new Set((await (await agents()).list()).items.map(item => item.deployment.model))].map(model => metadata(provider, model)); },
    // A deleted deployment must still render historical messages. Admission and
    // each invocation separately verify its receipt and live remote identity.
    async resolveModel(provider, model) { return metadata(provider, model); },
  });
}
