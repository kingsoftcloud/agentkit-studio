/** Only local deployment receipts establish Studio cloud Agent lineage. */
import { CLOUD_EXECUTION_POLICY_CAPABILITY, EXECUTION_MODES, readExecutionMode, readExecutionPolicy } from './execution-policy.mjs';
import { ksxcAgentPreference } from './host/services/ksxc.mjs';
import { currentDeployment, deploymentVersions, deploymentVersionId, inspectDeploymentVersion,
  managedRuntimeReceipt, cloudAgentGone, CLOUD_AGENT_GONE_FAILURE } from './deployment-versions.mjs';
import { verifyPortableBundle } from './portable-bundle.mjs';
import { portableError, sha256 } from './portable-resources.mjs';
import { verifyDeploymentStorage } from './deployment-storage.mjs';
import { frozenModels } from './frozen-models.mjs';
import { isStudioRuntimeType } from './runtime-contract.mjs';
import { DSH_MANIFEST_FORMAT } from './managed-runtime-manifest.mjs';

const available = new Set(['READY', 'AVAILABLE_UPDATING']);
export const CLOUD_PROVIDER = 'agentkit-studio-cloud';

async function inspectManagedDeployment({ remote, record, endpoint, token, fetchImpl }) {
  const { plan, cloudAgentId } = record;
  const state = remote.DeploymentState;
  const runtime = remote.Deployment?.RuntimeConfig || remote.RuntimeConfig;
  const receipt = managedRuntimeReceipt(remote, plan);
  if (state?.Ready !== true || typeof state.ObservedVersionId !== 'string' || !state.ObservedVersionId
    || state.ObservedVersionId !== state.DesiredVersionId || runtime?.ManifestFormat !== DSH_MANIFEST_FORMAT
    || !/^[a-f0-9]{64}$/.test(plan.managedManifestSha256 || '') || !receipt) return null;

  // The public bootstrap asks Server to verify the managed Host with its own runtime credential.
  const response = await fetchImpl(`${endpoint}/agentengine/api/v1/GetAgentUiBootstrap`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ AgentId: cloudAgentId }), redirect: 'error', signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) { await response.body?.cancel(); return null; }
  const bootstrap = await response.json().catch(() => null);
  const data = bootstrap?.Data;
  if (bootstrap?.Code !== 0 || data?.Agent?.AgentId !== cloudAgentId
    || !Array.isArray(data.ApiFormats) || !data.ApiFormats.includes('responses')) return null;
  const policy = data.Capabilities?.ExecutionPolicy;
  const allowedPermissionModes = policy?.Format === 'agentkit.execution-policy/v1' && Array.isArray(policy.Modes)
    ? EXECUTION_MODES.filter(mode => policy.Modes.includes(mode)) : [];
  return {
    managedIdentity: { agentId: cloudAgentId, versionId: state.ObservedVersionId, manifestSha256: runtime.ManifestSha256 },
    allowedPermissionModes,
    defaultPermissionMode: allowedPermissionModes.includes(policy?.DefaultMode) ? policy.DefaultMode : null,
    executionModeSwitching: allowedPermissionModes.length > 1,
  };
}

export function createDeploymentAgents({ store, build, portableBundles, configuration, credentialScope, owned, detail, endpointFor, fetchImpl }) {
  async function records(includeDeleted = false) {
    const { values } = await configuration.resolve();
    const scope = credentialScope(values);
    return (await store.list()).filter(row => row.cloudAgentId && (includeDeleted || row.state !== 'DELETED')
      && row.plan.credentialScope === scope && isStudioRuntimeType(row.plan.runtime));
  }
  async function project(record) {
    record = currentDeployment(record);
    const frozen = await build.resolve(record.plan.agentId, record.plan.buildId);
    let models, profile;
    if (record.plan.runtime === 'ksxc') {
      profile = { id: ksxcAgentPreference(frozen.spec) };
      models = [];
    } else if (record.plan.bundleId) {
      const zip = Buffer.from((await portableBundles.download(record.plan.agentId, record.plan.buildId, record.plan.bundleId)).base64, 'base64');
      if (sha256(zip) !== record.plan.bundleSha256) throw portableError('DEPLOYMENT_PROVENANCE_MISMATCH', '冻结运行包与部署记录不一致');
      const { manifest } = verifyPortableBundle(zip);
      if (manifest.agentId !== record.plan.agentId || manifest.buildId !== record.plan.buildId) throw portableError('DEPLOYMENT_PROVENANCE_MISMATCH', '冻结运行包身份不一致');
      models = frozenModels(manifest.resources.profiles);
      profile = models.find(item => item.default) || models[0];
    } else {
      const model = String(record.plan.managedModelConfig?.Model || '').trim();
      if (model) models = [{ id: model, name: model }];
      profile = models?.[0];
    }
    if (!profile) throw portableError('DEPLOYMENT_MODEL_MISSING', '冻结版本缺少模型配置');
    return { source: 'studio-deployment', metadata: { ...frozen.metadata, id: record.cloudAgentId, local: false,
      name: record.plan.agentName, createdAt: record.createdAt }, spec: frozen.spec,
      deployment: { id: record.id, versionId: deploymentVersionId(record), agentId: record.plan.agentId, buildId: record.plan.buildId, bundleId: record.plan.bundleId,
        state: record.state, available: available.has(record.state), ...(record.plan.runtime === 'ksxc' ? {} : { model: profile.id }), models: models.map(item => item.id),
        environment: record.plan.environment, region: record.plan.region } };
  }
  async function getRecord(agentId) {
    const found = (await records(true)).find(row => row.cloudAgentId === agentId);
    if (!found) throw portableError('DEPLOYMENT_AGENT_NOT_FOUND', '当前账号下没有该 Agent 的 Studio 部署记录');
    const record = await owned(found.id);
    if (record.state === 'DELETED') throw portableError('DEPLOYMENT_DELETED', '云端实例已删除；历史对话仍可查看，请选择就绪的部署开启新会话');
    return record;
  }
  async function get(agentId) {
    return project(await getRecord(agentId));
  }
  // Never exposed as a browser RPC: the platform token stays on the Node Host.
  async function connect(agentId) {
    const record = await getRecord(agentId);
    const agent = await project(record);
    if (!available.has(record.state)) throw portableError('DEPLOYMENT_NOT_READY', '云端部署尚未就绪，请在运行中心刷新状态');
    // A console-side delete leaves this binding stale; take the operator to the
    // recoverable meaning instead of a raw GetAgent 404.
    let remote;
    try { remote = await detail(record); }
    catch (error) {
      if (!cloudAgentGone(error)) throw error;
      await store.update(record.id, { state: 'DELETED', failure: null, lastCheckedAt: new Date().toISOString() });
      throw portableError('DEPLOYMENT_CLOUD_DELETED', CLOUD_AGENT_GONE_FAILURE.message);
    }
    const token = remote.QuickAccess?.ApiKey;
    const current = currentDeployment(record);
    verifyDeploymentStorage(remote, current);
    if (!['RUNNING', 'UPDATING'].includes(remote.Basic?.Status) || !(remote.Basic?.ReadyReplicas > 0)) throw portableError('DEPLOYMENT_NOT_READY', '云端实例当前不可用，请在运行中心查看状态');
    const endpoint = endpointFor(remote, record);
    if (!endpoint || typeof token !== 'string' || token.length < 24 || token.includes('*')) throw portableError('DEPLOYMENT_NOT_READY', '云端访问配置尚未就绪');
    const unverified = () => portableError('DEPLOYMENT_NOT_READY', '运行入口尚未确认当前冻结版本，请刷新部署状态后重试');
    if (current.plan.deploymentType === 'ManagedRuntime') {
      const identity = await inspectManagedDeployment({ remote, record: current, endpoint, token, fetchImpl });
      if (!identity) throw unverified();
      return { agent, endpoint, token, ...identity };
    }
    const identityRequired = record.activeVersion || current.plan.image.runtimeIdentity === true;
    const identity = identityRequired ? await inspectDeploymentVersion({ fetchImpl, endpoint, token,
      plan: { ...current.plan, cloudAgentId: record.cloudAgentId }, versionId: deploymentVersionId(record) }) : null;
    if (identityRequired && !identity) throw unverified();
    const capabilities = Array.isArray(identity?.capabilities) ? identity.capabilities : [];
    const allowedPermissionModes = Array.isArray(identity?.allowedPermissionModes)
      ? identity.allowedPermissionModes.map(readExecutionMode).filter(Boolean) : [];
    return { agent, endpoint, token, executionPolicy: readExecutionPolicy(identity?.executionPolicy), capabilities,
      allowedPermissionModes,
      executionModeSwitching: capabilities.includes(CLOUD_EXECUTION_POLICY_CAPABILITY) && allowedPermissionModes.length > 1 };
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
    recover: async () => projectRows((await store.list()).filter(row => row.cloudAgentId && isStudioRuntimeType(row.plan.runtime))
      .flatMap(row => deploymentVersions(row).map(version => ({ ...row, activeVersion: version })))) };
}

/** Frozen cloud models need no desktop model credentials or local Codex login. */
export function createDeploymentModelAdapter({ agents, runtime }) {
  const metadata = (provider, model) => ({ provider, id: model, name: model, modalities: ['text'] });
  return Object.assign(Object.create(Object.getPrototypeOf(runtime)), runtime, {
    providerInfo(provider) { return { id: provider, name: '云端部署' }; },
    async listModels(provider) { return [...new Set((await (await agents()).list()).items.flatMap(item => item.deployment.models || [item.deployment.model]))].map(model => metadata(provider, model)); },
    // A deleted deployment must still render historical messages. Admission and
    // each invocation separately verify its receipt and live remote identity.
    async resolveModel(provider, model) { return metadata(provider, model); },
  });
}
