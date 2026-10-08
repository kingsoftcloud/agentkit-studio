/** Single-attempt in-place updates; acceptance requires the serving bundle's identity. */
import { randomUUID } from 'node:crypto';
import { sha256, portableError } from './portable-resources.mjs';
import { verifyPortableBundle } from './portable-bundle.mjs';
import { planKs3BundleUpload } from './ks3-bundle-store.mjs';
import { createContainerDeploymentEnvironment } from './container-deployment-env.mjs';
import { resolveDeploymentCredentials, PLATFORM_CREDENTIAL_NAMES } from './deployment-credentials.mjs';
import { currentDeployment, deploymentVersions, deploymentVersionId, pendingRollout, publicDeployment,
  verifyDeploymentRemote, probeDeploymentVersion } from './deployment-versions.mjs';

const managed = ['AGENTKIT_BUNDLE_SHA256', 'AGENTKIT_BUNDLE_SOURCE', 'AGENTKIT_RUNTIME_TOKEN', 'AGENTKIT_DEPLOYMENT_VERSION', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL_NAME'];
export function createDeploymentRollouts({ store, owned, detail, images, assemble, portableBundles, models, adapters,
  credentials, configuration, env, client, operations, fetchImpl, storageFactory, credentialScope, exclusive, failure, endpointFor }) {
  async function archive(plan) {
    const zip = Buffer.from((await portableBundles.download(plan.agentId, plan.buildId, plan.bundleId)).base64, 'base64');
    if (sha256(zip) !== plan.bundleSha256) throw portableError('DEPLOYMENT_BUNDLE_MISMATCH', '历史冻结包已变化，请核对后重试');
    const { manifest } = verifyPortableBundle(zip);
    if (manifest.agentId !== plan.agentId || manifest.buildId !== plan.buildId) throw portableError('DEPLOYMENT_BUNDLE_MISMATCH', '历史冻结包身份不匹配');
    return { zip, manifest };
  }
  async function identity(record) {
    const actor = await client.inspectIdentity({ forceRefresh: true });
    const { values } = await configuration.resolve();
    if (actor.kind !== 'subaccount' || actor.userUuid !== record.plan.identity.userUuid || actor.accountId !== record.plan.identity.accountId) {
      throw portableError('CLOUD_SUBACCOUNT_REQUIRED', '更新需要原部署的已核验子账号');
    }
    if (credentialScope(values) !== record.plan.credentialScope) throw portableError('DEPLOYMENT_ACCOUNT_CHANGED', '云端配置已变化，请重新检查部署');
    return values;
  }
  async function prepareTarget(input, exporting) {
    const record = await owned(String(input.deploymentId || '')), current = currentDeployment(record);
    if (record.state !== 'READY' || pendingRollout(record)) throw portableError('DEPLOYMENT_UPDATE_UNAVAILABLE', '请等待当前部署就绪后再升级或回滚');
    const remote = await detail(record);
    if (remote.Basic.Status !== 'RUNNING' || !(remote.Basic.ReadyReplicas > 0)) throw portableError('DEPLOYMENT_UPDATE_UNAVAILABLE', '云端实例当前不允许更新');
    await identity(record);
    let prepared;
    if (input.rollbackVersionId) {
      const version = deploymentVersions(record).find(item => item.id === input.rollbackVersionId);
      if (!version) throw portableError('DEPLOYMENT_VERSION_NOT_FOUND', '历史部署版本不存在');
      const { image, catalog } = await images.resolve(version.plan.runtime, version.plan.image.id);
      if (image.image !== version.plan.image.image || catalog.region !== version.plan.region || catalog.environment !== version.plan.environment) {
        throw portableError('DEPLOYMENT_PREVIEW_STALE', '历史镜像目录已变化，不能回滚到未核验的镜像');
      }
      const { zip } = await archive(version.plan), { values } = await configuration.resolve();
      prepared = { plan: { ...version.plan, image, catalogRevision: catalog.revision }, zip, values,
        resolved: await resolveDeploymentCredentials({ zip, models, adapters, credentials, configuration, env }) };
    } else {
      prepared = await assemble({ ...input, releaseId: input.releaseId || (current.plan.image.runtimeIdentity ? current.plan.image.id : undefined),
        agentId: current.plan.agentId, resources: { ...current.plan.resources, storageGiB: current.plan.resources.storageGiB ?? 0 } }, exporting);
    }
    if (!prepared.plan.image.runtimeIdentity) throw portableError('DEPLOYMENT_IMAGE_UPGRADE_REQUIRED', '目标镜像尚未声明版本探测能力，请先发布支持升级回滚的 Studio 镜像');
    prepared.plan = { ...prepared.plan, name: current.plan.name };
    for (const field of ['agentId', 'runtime', 'credentialScope', 'region', 'environment', 'bucket', 'storageEndpoint']) {
      if (prepared.plan[field] !== current.plan[field]) throw portableError('DEPLOYMENT_UPDATE_SCOPE_CHANGED', '升级须保留 Agent、运行时、账号和部署位置；其他场景请创建独立部署');
    }
    if (prepared.plan.bundleSha256 === current.plan.bundleSha256 && prepared.plan.image.image === current.plan.image.image) {
      throw portableError('DEPLOYMENT_VERSION_UNCHANGED', '所选冻结包和镜像已在运行');
    }
    const previewId = sha256(JSON.stringify([record.id, deploymentVersionId(record), input.rollbackVersionId || null, prepared.plan]));
    return { ...prepared, record, previewId };
  }
  async function prepare(input) {
    const { plan, record, previewId } = await prepareTarget(input, true);
    const { credentialScope: scope, bucket, storageEndpoint, ...preview } = plan;
    return { ...preview, deploymentId: record.id, previewId, releaseId: plan.image.id,
      rollbackVersionId: input.rollbackVersionId || null, fromVersionId: deploymentVersionId(record),
      warnings: ['保留当前云端 Agent 和规格；切换期间暂不可发起对话', '完成后请开启新会话，历史会话仍保留',
        plan.resources.storageGiB ? `保留 ${plan.resources.storageGiB} GiB 持久化存储，各冻结版本使用独立历史目录` : '当前实例使用临时存储，切换会丢失原实例的对话历史'] };
  }
  async function run(id, attemptId, prepared) {
    return exclusive(id, async () => {
      let record = await owned(id), rollout = record.rollout;
      if (rollout?.id !== attemptId || rollout.status !== 'PREPARED') return;
      try {
        const values = await identity(record), remote = await detail(record), token = remote.QuickAccess?.ApiKey;
        if (remote.Basic.Status !== 'RUNNING' || !(remote.Basic.ReadyReplicas > 0) || typeof token !== 'string' || token.length < 24 || token.includes('*')) {
          throw portableError('DEPLOYMENT_UPDATE_UNAVAILABLE', '实例或访问令牌尚未就绪');
        }
        const source = planKs3BundleUpload(prepared.zip, { endpoint: rollout.plan.storageEndpoint, bucket: rollout.plan.bucket, uploadId: randomUUID() });
        rollout = { ...rollout, status: 'UPLOADING', source };
        if (!await store.claim(id, `${attemptId}-upload`)) return;
        await store.update(id, { rollout, state: 'UPDATING' });
        const storage = storageFactory({ accessKey: values.cloudAccessKey, secretKey: values.cloudSecretKey, sessionToken: values.cloudSessionToken, fetchImpl });
        await storage.upload(prepared.zip, source);
        const environment = createContainerDeploymentEnvironment({ zip: prepared.zip, expectedSha256: source.sha256,
          runtimeToken: token, credentials: prepared.resolved, bundleSource: source }).filter(item => !PLATFORM_CREDENTIAL_NAMES.has(item.Key));
        environment.push({ Key: 'AGENTKIT_DEPLOYMENT_VERSION', Value: rollout.id, IsSensitive: false });
        const old = await archive(currentDeployment(record).plan);
        const names = new Set(environment.map(item => item.Key));
        const deleted = [...new Set([...managed, ...old.manifest.requirements.map(item => item.name)])].filter(name => !names.has(name) && !PLATFORM_CREDENTIAL_NAMES.has(name));
        await identity(record);
        await detail(record); // Refuse a foreign/manual change made while uploading.
        if (!await store.claim(id, `${attemptId}-apply`)) return;
        rollout = { ...rollout, status: 'APPLYING' };
        await store.update(id, { rollout });
        const image = rollout.plan.image;
        await client.forAgent(record.cloudAgentId).update({
          ContainerConfig: { ImageType: 'Personal', NameSpace: image.namespace, ImageRepo: image.repository, ImageVersion: image.version,
            ImageAddr: image.image, Visibility: 'public', RequireCredential: false, Port: image.port },
          EnvironmentVariablePatch: { Upsert: environment, Delete: deleted },
        }, { requestId: rollout.requestId });
      } catch (error) {
        rollout = { ...rollout, status: rollout.status === 'APPLYING' ? 'UNKNOWN' : 'FAILED' };
        await store.update(id, { rollout, state: rollout.status === 'UNKNOWN' ? 'UPDATE_UNKNOWN' : 'ACTION_REQUIRED', failure: failure(error) });
        throw portableError(failure(error).code, failure(error).message);
      }
      return { deploymentId: id, summary: '更新已提交，等待入口版本验证' };
    });
  }
  async function apply(input) {
    const key = String(input.idempotencyKey || '');
    if (!/^[A-Za-z0-9._:-]{8,200}$/.test(key)) throw portableError('DEPLOYMENT_REQUEST_ID_REQUIRED', '更新需要独立的请求标识');
    const attemptId = `upd_${sha256(key).slice(0, 32)}`;
    const requestFingerprint = sha256(JSON.stringify([input.previewId, input.buildId, input.bundleId, input.releaseId, input.rollbackVersionId || null]));
    return exclusive(input.deploymentId, async () => {
      let record = await owned(input.deploymentId);
      const previous = [record.rollout, ...(record.rolloutHistory || [])].find(item => item?.id === attemptId);
      if (previous) {
        if (previous.requestFingerprint !== requestFingerprint) throw portableError('DEPLOYMENT_IDEMPOTENCY_CONFLICT', '同一请求已用于其他更新');
        return publicDeployment(record); // Never replay an uncertain write after restart.
      }
      const prepared = await prepareTarget(input, false);
      if (prepared.previewId !== input.previewId) throw portableError('DEPLOYMENT_PREVIEW_STALE', '部署版本、目录或配置已变化，请重新检查');
      const rollout = { id: attemptId, requestFingerprint, requestId: randomUUID(), kind: input.rollbackVersionId ? 'rollback' : 'upgrade',
        status: 'PREPARED', fromVersionId: deploymentVersionId(record), plan: prepared.plan, startedAt: new Date().toISOString() };
      record = await store.update(record.id, { rollout, state: 'UPDATING', failure: null,
        rolloutHistory: [...(record.rolloutHistory || []), ...(record.rollout ? [record.rollout] : [])] });
      await operations.submit({ kind: 'deployment', resourceId: record.plan.agentId, idempotencyKey: `${record.id}-${attemptId}`,
        requestFingerprint, metadata: { deploymentId: record.id, rolloutId: attemptId, revision: rollout.plan.revision }, runner: () => run(record.id, attemptId, prepared) });
      return publicDeployment(record);
    });
  }
  async function refresh(record, remote, common) {
    if (!pendingRollout(record)) return null;
    const rollout = record.rollout, endpoint = endpointFor(remote, record), token = remote.QuickAccess?.ApiKey;
    if (['PREPARED', 'UPLOADING'].includes(rollout.status)) {
      const operation = (await operations.list()).find(item => item.metadata?.deploymentId === record.id && item.metadata?.rolloutId === rollout.id);
      if (!operation || ['failed', 'cancelled'].includes(operation.status)) {
        return store.update(record.id, { ...common, state: 'ACTION_REQUIRED', rollout: { ...rollout, status: 'FAILED' },
          failure: { code: 'DEPLOYMENT_UPDATE_INTERRUPTED', message: '更新在提交云端前中断；刷新确认原实例状态后，可重新检查版本' } });
      }
    }
    let matches = false;
    try { verifyDeploymentRemote(remote, { ...record, plan: rollout.plan }); matches = true; } catch {}
    if (['APPLYING', 'UNKNOWN'].includes(rollout.status) && matches && remote.Basic.Status === 'RUNNING' && common.readyReplicas > 0
      && endpoint && typeof token === 'string' && token.length >= 24 && !token.includes('*')
      && await probeDeploymentVersion({ fetchImpl, endpoint, token, plan: rollout.plan, versionId: rollout.id })) {
      const version = { id: rollout.id, plan: rollout.plan, source: rollout.source, completedAt: new Date().toISOString() };
      return store.update(record.id, { ...common, state: 'READY', activeVersion: version,
        versions: [...deploymentVersions(record), version], rollout: { ...rollout, status: 'SUCCEEDED' }, endpoint, tokenBound: true });
    }
    return store.update(record.id, { ...common, state: rollout.status === 'UNKNOWN' ? 'UPDATE_UNKNOWN' : 'UPDATING', tokenBound: false });
  }
  return { prepare, apply, refresh };
}
