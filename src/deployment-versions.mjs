/** A deployment's creation intent stays immutable; successful versions are append-only. */
import { portableError } from './portable-resources.mjs';

export const pendingRollout = record => ['PREPARED', 'UPLOADING', 'APPLYING', 'UNKNOWN'].includes(record.rollout?.status);
export function currentDeployment(record) {
  return record.activeVersion ? { ...record, plan: record.activeVersion.plan, source: record.activeVersion.source } : record;
}
export function deploymentVersions(record) {
  return record.versions?.length ? record.versions : [{ id: 'initial', plan: record.plan, source: record.source, completedAt: record.createdAt }];
}
export function deploymentVersionId(record) { return record.activeVersion?.id || 'initial'; }
export function publicDeployment(record) {
  const { plan: original, source, fingerprint, format, activeVersion, versions, rollout, rolloutHistory, ...state } = record;
  const { plan } = currentDeployment(record);
  const version = item => ({ id: item.id, buildId: item.plan.buildId, revision: item.plan.revision,
    imageVersion: item.plan.image.version, completedAt: item.completedAt });
  return { ...state, agentId: plan.agentId, agentName: plan.agentName, buildId: plan.buildId, bundleId: plan.bundleId,
    revision: plan.revision, runtime: plan.runtime, region: plan.region, environment: plan.environment,
    imageVersion: plan.image.version, imageDigest: plan.image.digest, resources: plan.resources,
    notices: plan.image.notices, identity: plan.identity, name: plan.name, status: record.state,
    versionId: deploymentVersionId(record), versions: deploymentVersions(record).map(version),
    ...(rollout ? { rollout: { id: rollout.id, kind: rollout.kind, status: rollout.status,
      buildId: rollout.plan.buildId, revision: rollout.plan.revision, startedAt: rollout.startedAt } } : {}) };
}
export function verifyDeploymentRemote(detail, record) {
  const digest = detail.Advanced?.EnvironmentVariables?.find(item => item.Key === 'AGENTKIT_BUNDLE_SHA256')?.Value;
  if (detail.Basic?.AgentId !== record.cloudAgentId || detail.Basic.Name !== record.plan.name
    || detail.Deployment?.ArtifactPath !== record.plan.image.image || digest !== record.plan.bundleSha256) {
    throw portableError('DEPLOYMENT_PROVENANCE_MISMATCH', '云端 Agent 与冻结部署记录不一致，已停止管理操作');
  }
}
export async function inspectDeploymentVersion({ fetchImpl = fetch, endpoint, token, plan, versionId }) {
  const response = await fetchImpl(`${endpoint}/v1/agentkit/runtime`, { headers: { Authorization: `Bearer ${token}` },
    redirect: 'error', signal: AbortSignal.timeout(10000) });
  if (!response.ok) { await response.body?.cancel(); return null; }
  const body = await response.json();
  return body.format === 'agentkit.runtime-identity/v1' && body.status === 'ready' && body.agentId === plan.agentId
    && body.buildId === plan.buildId && body.bundleSha256 === plan.bundleSha256 && body.deploymentVersion === versionId ? body : null;
}
export async function probeDeploymentVersion(options) { return Boolean(await inspectDeploymentVersion(options)); }
