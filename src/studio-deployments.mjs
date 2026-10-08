/** Node orchestration for Studio-owned Container deployments. */
import { randomBytes, randomUUID } from 'node:crypto';
import { createDeploymentStore } from './deployment-store.mjs';
import { createDeploymentImages } from './deployment-images.mjs';
import { createKs3BundleStore, ks3BundleEndpoint, planKs3BundleUpload } from './ks3-bundle-store.mjs';
import { createContainerDeploymentEnvironment } from './container-deployment-env.mjs';
import { resolveDeploymentCredentials, PLATFORM_CREDENTIAL_NAMES } from './deployment-credentials.mjs';
import { verifyPortableBundle } from './portable-bundle.mjs';
import { portableError, sha256 } from './portable-resources.mjs';
import { createDeploymentAgents } from './deployment-agents.mjs';
import { currentDeployment, pendingRollout, publicDeployment as publicRecord, verifyDeploymentRemote, probeDeploymentVersion, deploymentVersionId } from './deployment-versions.mjs';
import { createDeploymentRollouts } from './deployment-rollouts.mjs';
import { storageSize, deploymentStorage, admitDeploymentStorage, verifyDeploymentStorage } from './deployment-storage.mjs';

const cloudId = value => /^ar-(?!local-)[A-Za-z0-9-]+$/.test(value || '');
const failure = error => ({ code: /^[A-Z][A-Z0-9_]{2,80}$/.test(error?.code || '') ? error.code : 'DEPLOYMENT_FAILED',
  message: error?.code === 'DEPLOYMENT_STORAGE_MISMATCH' ? '云端存储与所选配置不符，暂不可对话；请核对实例配置' : '操作未完成，请查看部署状态并核对云端结果；不会自动重试云端写操作',
  ...(typeof error?.requestId === 'string' && /^[a-f0-9-]{36}$/.test(error.requestId) ? { requestId: error.requestId } : {}) });
const credentialScope = values => sha256(JSON.stringify([values.cloudServerUrl || 'https://aicp.api.ksyun.com', values.cloudRegion || 'cn-beijing-6', values.cloudCustomSource || '', values.cloudAccessKey]));
const shapeOf = input => {
  const cpu = input?.cpu ?? 2, memoryGiB = input?.memoryGiB ?? 8;
  if (![1, 2, 4, 8, 16].includes(cpu) || ![cpu * 4, cpu * 8].includes(memoryGiB)) throw portableError('DEPLOYMENT_RESOURCE_INVALID', 'CPU 和内存比例须为 1:4 或 1:8');
  return { cpu, memoryGiB, replicas: 1, storageGiB: storageSize(input?.storageGiB) };
};
function endpointFor(detail, record) {
  const value = detail.Network?.PublicEndpoint || detail.QuickAccess?.PublicEndpoint;
  if (!value) return null;
  let url;
  try { url = new URL(value); } catch { throw portableError('DEPLOYMENT_ENDPOINT_INVALID', '云端返回了无效的运行地址'); }
  const suffix = record.plan.environment === 'pre-online' ? 'agent-pre.kspmas.ksyun.com' : 'agent.kspmas.ksyun.com';
  if (url.protocol !== 'https:' || url.hostname !== `${record.cloudAgentId}.${suffix}` || url.port || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw portableError('DEPLOYMENT_ENDPOINT_INVALID', '云端运行地址与当前部署不匹配');
  return url.origin;
}

export function createStudioDeployments({ storeDir, build, portableBundles, models, adapters, credentials, configuration,
  client, operations, fetchImpl = fetch, env = process.env, storageFactory = createKs3BundleStore }) {
  const store = createDeploymentStore({ storeDir }), images = createDeploymentImages({ client, configuration });
  const active = new Map(), locks = new Map();
  function exclusive(id, work) {
    const next = (locks.get(id) || Promise.resolve()).then(work, work), settled = next.catch(() => {});
    locks.set(id, settled);
    void settled.then(() => { if (locks.get(id) === settled) locks.delete(id); });
    return next;
  }
  async function assemble(input, prepareBundle = false) {
    const agentId = String(input?.agentId || ''), buildId = String(input?.buildId || '');
    const frozen = await build.resolve(agentId, buildId);
    if (!/^ar-local-[a-f0-9]{16}$/.test(agentId) || frozen.metadata.local === false) throw portableError('DEPLOYMENT_AGENT_UNSUPPORTED', '仅支持本地创建的 Agent Build 部署');
    const bundleId = prepareBundle ? (await portableBundles.prepare(agentId, buildId)).bundleId : input.bundleId;
    const zip = Buffer.from((await portableBundles.download(agentId, buildId, bundleId)).base64, 'base64');
    const { manifest } = verifyPortableBundle(zip);
    const runtime = frozen.spec.runtime.type, { catalog, image } = await images.resolve(runtime, input.releaseId);
    const identity = await client.inspectIdentity(), { values } = await configuration.resolve();
    if (identity.kind !== 'subaccount') throw portableError('CLOUD_SUBACCOUNT_REQUIRED', '部署需要已核验的子账号 AK/SK，请在设置中更新云端凭证；不会使用主账号创建资源');
    if (!values.cloudBucket) throw portableError('KS3_BUCKET_REQUIRED', '请先在设置中配置用于私有运行包的 KS3 Bucket');
    const resources = shapeOf(input.resources);
    admitDeploymentStorage(resources, catalog, runtime);
    const resolved = await resolveDeploymentCredentials({ zip, models, adapters, credentials, configuration, env });
    // Validate storage and environment before the user commits to a billable create.
    const source = planKs3BundleUpload(zip, { endpoint: ks3BundleEndpoint(catalog.region), bucket: values.cloudBucket, uploadId: randomUUID() });
    createContainerDeploymentEnvironment({ zip, expectedSha256: source.sha256, runtimeToken: randomBytes(32).toString('hex'), credentials: resolved, bundleSource: source });
    const plan = { agentId, agentName: frozen.metadata.name || agentId, buildId, bundleId, bundleSha256: sha256(zip),
      revision: frozen.metadata.revision, runtime, image, catalogRevision: catalog.revision, region: catalog.region, environment: catalog.environment,
      resources, bucket: source.bucket, storageEndpoint: source.endpoint, credentialScope: credentialScope(values),
      identity: { kind: identity.kind, accountId: identity.accountId, userUuid: identity.userUuid, userName: identity.userName },
      resourceCounts: { models: manifest.resources.profiles.length, mcps: manifest.resources.mcps.length, skills: manifest.resources.skills.length, remote: manifest.resources.remote.length } };
    return { plan, zip, resolved, values, fingerprint: sha256(JSON.stringify(plan)) };
  }
  async function prepare(input) {
    const { plan, fingerprint } = await assemble(input, true);
    const { credentialScope: _, bucket, storageEndpoint, ...preview } = plan;
    return { ...preview, previewId: fingerprint, releaseId: plan.image.id,
      warnings: [...plan.image.notices,
        '单副本按所选规格创建；费用以平台实际计费为准', plan.resources.storageGiB
          ? `持久化存储 ${plan.resources.storageGiB} GiB；按天计费，删除实例前请备份需要保留的历史`
          : '使用临时存储，实例重建会丢失对话历史'] };
  }
  async function owned(id) {
    const record = await store.get(id);
    if (!record) throw portableError('DEPLOYMENT_NOT_FOUND', '部署记录不存在');
    const { values } = await configuration.resolve();
    if (credentialScope(values) !== record.plan.credentialScope) throw portableError('DEPLOYMENT_ACCOUNT_CHANGED', '当前云端凭证或环境与部署记录不同，请切回原配置后管理');
    return record;
  }
  async function detail(record) {
    if (!cloudId(record.cloudAgentId)) throw portableError('DEPLOYMENT_CREATE_UNCONFIRMED', '创建结果尚未确认，请先核对云端记录');
    const result = (await client.forAgent(record.cloudAgentId).get({ IncludeApiKey: true })).data;
    try { verifyDeploymentRemote(result, currentDeployment(record)); }
    catch (error) {
      if (!pendingRollout(record)) throw error;
      verifyDeploymentRemote(result, { ...record, plan: record.rollout.plan });
    }
    return result;
  }
  async function advance(record, prepared) {
    try {
      const identity = await client.inspectIdentity({ forceRefresh: true });
      if (identity.kind !== 'subaccount' || identity.userUuid !== record.plan.identity.userUuid || identity.accountId !== record.plan.identity.accountId) {
        throw portableError('CLOUD_SUBACCOUNT_REQUIRED', '部署身份已变化，请重新核验子账号后提交');
      }
      if (!await store.claim(record.id, 'upload')) return;
      const source = planKs3BundleUpload(prepared.zip, { endpoint: record.plan.storageEndpoint, bucket: record.plan.bucket, uploadId: randomUUID() });
      await store.update(record.id, { state: 'UPLOADING', source });
      const storage = storageFactory({ accessKey: prepared.values.cloudAccessKey, secretKey: prepared.values.cloudSecretKey, sessionToken: prepared.values.cloudSessionToken, fetchImpl });
      await storage.upload(prepared.zip, source);
      await store.update(record.id, { state: 'UPLOADED' });
      const { values } = await configuration.resolve();
      if (credentialScope(values) !== record.plan.credentialScope) throw portableError('DEPLOYMENT_ACCOUNT_CHANGED', '云端配置已变化，已停止创建');
      const { image, resources, runtime, name } = record.plan;
      const environment = createContainerDeploymentEnvironment({ zip: prepared.zip, expectedSha256: source.sha256,
        runtimeToken: randomBytes(32).toString('hex'), credentials: prepared.resolved, bundleSource: source })
        .filter(item => !PLATFORM_CREDENTIAL_NAMES.has(item.Key));
      if (!await store.claim(record.id, 'create')) return;
      await store.update(record.id, { state: 'CREATING' });
      const result = await client.createAgent({ Name: name, Description: `AgentKit Studio ${record.id}`, Framework: runtime === 'codex' ? 'codex' : 'harness',
        Region: record.plan.region, DeploymentType: 'Container',
        ContainerConfig: { ImageType: 'Personal', NameSpace: image.namespace, ImageRepo: image.repository, ImageVersion: image.version,
          ImageAddr: image.image, Visibility: 'public', RequireCredential: false, Port: image.port },
        Resource: { Cpu: resources.cpu, Memory: resources.memoryGiB }, Scaling: { MinReplicas: 1, MaxReplicas: 1, QpsPerInstance: 10 },
        ...(deploymentStorage(resources) ? { Storage: deploymentStorage(resources) } : {}),
        Network: { EnablePublicAccess: true, EnableVpcAccess: false }, Access: { AuthType: 'ApiKey', IsPrivate: true },
        Advanced: { IsPrivate: true, EnableObservability: true, Tags: ['agentkit-studio'], EnvironmentVariables: environment }, AutoPay: true,
      }, { requestId: record.requestId });
      if (!cloudId(result.data?.AgentId)) throw portableError('DEPLOYMENT_CREATE_UNCONFIRMED', '平台未返回有效 AgentId，请核对创建结果');
      await store.update(record.id, { cloudAgentId: result.data.AgentId, state: 'PROVISIONING' });
      await refresh(record.id);
    } catch (error) {
      const latest = await store.get(record.id);
      const state = latest.state === 'CREATING' ? 'CREATE_UNKNOWN' : latest.cloudAgentId ? 'ACTION_REQUIRED' : latest.state === 'UPLOADING' ? 'UPLOAD_UNKNOWN' : 'FAILED';
      await store.update(record.id, { state, failure: failure(error) });
      throw portableError(failure(error).code, failure(error).message);
    }
    return { deploymentId: record.id, summary: record.id };
  }
  async function create(input) {
    const prepared = await assemble(input);
    if (input.previewId !== prepared.fingerprint) throw portableError('DEPLOYMENT_PREVIEW_STALE', '部署版本、身份或环境已变化，请重新检查后确认');
    const nameSuffix = sha256(String(input.idempotencyKey || '')).slice(0, 12);
    const plan = { ...prepared.plan, name: `studio-${prepared.plan.runtime}-${nameSuffix}` };
    const { record, created } = await store.create(plan, input.idempotencyKey);
    if (created || record.state === 'PREPARED') {
      await operations.submit({ kind: 'deployment', resourceId: plan.agentId, idempotencyKey: `deploy-${record.id}`, requestFingerprint: record.fingerprint,
        metadata: { deploymentId: record.id, agentName: plan.agentName, revision: plan.revision }, runner: () => advance(record, prepared) });
    }
    return publicRecord(record);
  }
  async function refresh(id) {
    if (active.has(id)) return active.get(id);
    const work = exclusive(id, () => refreshState(id));
    active.set(id, work);
    try { return await work; } finally { active.delete(id); }
  }
  async function probeAccess(endpoint, key) {
    const response = await fetchImpl(`${endpoint}/v1/responses`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: '' }), redirect: 'error', signal: AbortSignal.timeout(10000) });
    const code = (await response.json()).error?.code;
    return { ready: response.status === 400 && code === 'RESPONSES_SINGLE_USER_MESSAGE_REQUIRED',
      mismatch: response.status === 401 && code === 'RUNTIME_UNAUTHORIZED' };
  }
  async function refreshState(id) {
    let record = await owned(id);
    if (!record.cloudAgentId || record.state === 'DELETED') return publicRecord(record);
    try {
      const remote = await detail(record), basic = remote.Basic;
      const common = { cloudStatus: String(basic.Status || ''), cloudPhase: String(basic.Phase || ''), readyReplicas: Number(basic.ReadyReplicas || 0), lastCheckedAt: new Date().toISOString(), failure: null };
      if (['FAILED', 'DELETED'].includes(basic.Status)) return publicRecord(await store.update(id, { ...common, state: basic.Status }));
      if (['DELETING', 'DELETE_UNKNOWN'].includes(record.state)) return publicRecord(await store.update(id, { ...common, failure: record.failure }));
      if (['RUNNING', 'UPDATING'].includes(basic.Status) && common.readyReplicas > 0) {
        try { verifyDeploymentStorage(remote, currentDeployment(record)); }
        catch (error) { return publicRecord(await store.update(id, { ...common, state: 'ACTION_REQUIRED', failure: failure(error) })); }
      }
      const rolloutState = await rollouts.refresh(record, remote, common);
      if (rolloutState) return publicRecord(rolloutState);
      const key = remote.QuickAccess?.ApiKey;
      if (typeof key !== 'string' || key.length < 24 || key.includes('*')) return publicRecord(await store.update(id, { ...common, state: 'PROVISIONING' }));
      const runtimeToken = remote.Advanced?.EnvironmentVariables?.find(item => item.Key === 'AGENTKIT_RUNTIME_TOKEN')?.Value;
      // Updating immediately after CreateAgentProduct can race with initial
      // provisioning. Wait until the first instance is actually running.
      if (runtimeToken !== key && basic.Status === 'RUNNING' && common.readyReplicas > 0 && await store.claim(id, 'token')) {
        await store.update(id, { ...common, state: 'CONFIGURING' });
        await client.forAgent(record.cloudAgentId).update({ EnvironmentVariablePatch: { Upsert: [{ Key: 'AGENTKIT_RUNTIME_TOKEN', Value: key, IsSensitive: true }] } });
        return publicRecord(await store.update(id, { state: 'TOKEN_PENDING' }));
      }
      const endpoint = endpointFor(remote, record);
      const next = { ...common, ...(endpoint ? { endpoint } : {}), state: 'STARTING', tokenBound: false };
      if (endpoint && ['RUNNING', 'UPDATING'].includes(basic.Status) && common.readyReplicas > 0) {
        const response = await fetchImpl(`${endpoint}/health`, { headers: { Authorization: `Bearer ${key}` }, redirect: 'error', signal: AbortSignal.timeout(10000) });
        // The gateway may answer /health itself with "ok". This is not runtime
        // readiness: the authenticated protocol probe below must also pass.
        const healthy = response.ok && ['ready', 'ok'].includes((await response.json()).status);
        if (healthy) {
          // GetAgent masks sensitive environment values. Prove token alignment
          // through runtime validation without starting a model run or session.
          const probe = await probeAccess(endpoint, key);
          const versionReady = !record.activeVersion || await probeDeploymentVersion({ fetchImpl, endpoint, token: key, plan: currentDeployment(record).plan, versionId: deploymentVersionId(record) });
          next.state = !probe.ready ? 'TOKEN_PENDING' : !versionReady ? 'STARTING' : basic.Status === 'UPDATING' ? 'AVAILABLE_UPDATING' : 'READY';
          next.tokenBound = probe.ready;
        }
      }
      return publicRecord(await store.update(id, next));
    } catch (error) {
      if (error.status === 404 && ['DELETING', 'DELETE_UNKNOWN'].includes(record.state)) return publicRecord(await store.update(id, { state: 'DELETED', failure: null }));
      return publicRecord(await store.update(id, { failure: failure(error), lastCheckedAt: new Date().toISOString() }));
    }
  }
  async function repairAccess(id) {
    return exclusive(id, async () => {
      const record = await owned(id), remote = await detail(record), key = remote.QuickAccess?.ApiKey;
      if (record.state !== 'TOKEN_PENDING' || remote.Basic.Status !== 'RUNNING' || !(remote.Basic.ReadyReplicas > 0)
        || typeof key !== 'string' || key.length < 24 || key.includes('*')) {
        throw portableError('DEPLOYMENT_ACCESS_REPAIR_UNAVAILABLE', '请等待实例运行并确认访问配置状态后重试');
      }
      const endpoint = endpointFor(remote, record);
      if (!endpoint) throw portableError('DEPLOYMENT_ENDPOINT_INVALID', '运行地址尚未就绪');
      const probe = await probeAccess(endpoint, key);
      if (probe.ready) return refreshState(id);
      if (!probe.mismatch) throw portableError('DEPLOYMENT_ACCESS_REPAIR_UNAVAILABLE', '尚未确认是运行时令牌不匹配，请检查网络或平台状态');
      if (!await store.claim(id, 'token-repair')) throw portableError('DEPLOYMENT_ACCESS_REPAIR_PENDING', '访问配置修复已提交，请刷新状态核对结果，不重复提交');
      await store.update(id, { state: 'CONFIGURING' });
      try {
        await client.forAgent(record.cloudAgentId).update({ EnvironmentVariablePatch: { Upsert: [{ Key: 'AGENTKIT_RUNTIME_TOKEN', Value: key, IsSensitive: true }] } });
        return publicRecord(await store.update(id, { state: 'TOKEN_PENDING', failure: null }));
      } catch (error) {
        return publicRecord(await store.update(id, { state: 'TOKEN_PENDING', failure: failure(error) }));
      }
    });
  }
  async function remove(id) {
    // A background health check must finish before deletion; its result must
    // never overwrite DELETING and prevent a later 404 from confirming removal.
    return exclusive(id, async () => {
      const record = await owned(id);
      if (record.state === 'DELETED') return publicRecord(record);
      const remote = await detail(record);
      if (remote.Basic?.Status === 'UPDATING') throw portableError('DEPLOYMENT_DELETE_BUSY', '云端仍在更新，请待平台状态恢复后删除');
      if (!await store.claim(id, 'delete')) return refreshState(id);
      await store.update(id, { state: 'DELETING' });
      try { await client.forAgent(record.cloudAgentId).remove(); }
      catch (error) { await store.update(id, { state: 'DELETE_UNKNOWN', failure: failure(error) }); }
      return refreshState(id);
    });
  }
  async function reconcile(id) {
    const record = await owned(id);
    if (record.cloudAgentId) return refresh(id);
    if (!['CREATE_UNKNOWN', 'CREATING'].includes(record.state)) return publicRecord(record);
    const response = await client.findByName(record.plan.name);
    const agents = response.data?.Agents;
    if (!Array.isArray(agents) || Number(response.data?.Total || 0) > agents.length) throw portableError('DEPLOYMENT_CREATE_UNCONFIRMED', '创建记录查询不完整，请保留记录并核对云端结果');
    const matches = agents.filter(item => (item.Basic?.Name || item.Name) === record.plan.name);
    if (matches.length !== 1) throw portableError('DEPLOYMENT_CREATE_UNCONFIRMED', matches.length ? '发现多条同名记录，请人工核对创建请求' : '暂未找到唯一创建结果；保持待确认，不重新创建');
    const cloudAgentId = matches[0].Basic?.AgentId || matches[0].AgentId;
    if (!cloudId(cloudAgentId)) throw portableError('DEPLOYMENT_CREATE_UNCONFIRMED', '候选创建记录缺少有效身份');
    const candidate = { ...record, cloudAgentId };
    await detail(candidate);
    await store.update(id, { cloudAgentId, state: 'PROVISIONING', failure: null });
    return refresh(id);
  }
  async function logs(id) {
    const record = await owned(id), remote = await detail(record);
    const secrets = [remote.QuickAccess?.ApiKey, ...(remote.Advanced?.EnvironmentVariables || []).filter(row => row.IsSensitive).map(row => row.Value)]
      .filter(value => typeof value === 'string' && value.length >= 4).sort((a, b) => b.length - a.length);
    const response = await client.forAgent(record.cloudAgentId).logs({ LogType: 'Stdout', PageSize: 200 });
    const redact = value => {
      let text = String(value || '').slice(0, 16000);
      for (const secret of secrets) text = text.split(secret).join('[已隐藏凭证]');
      return text.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [已隐藏凭证]')
        .replace(/([?&](?:token|access_token|api_key|apiKey|key)=)[^&\s"'<>]+/gi, '$1[已隐藏凭证]');
    };
    return { deploymentId: id, lines: (response.data?.Logs || []).slice(-200).map(row => redact(typeof row === 'string' ? row : row.Content || row.Message || row.Log || '')), total: Number(response.data?.Total || 0) };
  }
  const rollouts = createDeploymentRollouts({ store, owned, detail, images, assemble, portableBundles, models, adapters, credentials, configuration, env,
    client, operations, fetchImpl, storageFactory, credentialScope, exclusive, failure, endpointFor });
  const agents = createDeploymentAgents({ store, build, portableBundles, configuration, credentialScope, owned, detail, endpointFor, fetchImpl });
  return { prepare, create, prepareUpdate: rollouts.prepare, applyUpdate: rollouts.apply, refresh, repairAccess, reconcile, logs, remove, agents, get: async id => publicRecord(await owned(id)),
    list: async () => ({ items: (await store.list()).map(publicRecord) }) };
}
