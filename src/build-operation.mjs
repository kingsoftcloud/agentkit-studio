/** Resolve the requested immutable revision before admitting a background build. */
import { BuildError } from './studio-build.mjs';
import { buildIdFor } from './zip.mjs';

export async function submitAgentBuild({ payload, localStore, serverClient, build, operations, signal }) {
  const agentId = String(payload?.agentId || '').trim();
  if (!agentId) throw new BuildError('INVALID_AGENT_ID', 'AgentId 不能为空');
  const requested = payload?.revision;
  if (requested !== undefined && (!Number.isSafeInteger(requested) || requested < 1)) {
    throw new BuildError('BUILD_REVISION_INVALID', 'Revision 必须是正整数');
  }
  const local = await localStore.get(agentId);
  if (!local && agentId.startsWith('ar-local-')) throw new BuildError('AGENT_NOT_FOUND', '本地 Agent 不存在');
  let detail = local || await serverClient.getAgent(agentId, { signal });
  const revision = requested ?? detail?.metadata?.revision;
  if (!Number.isSafeInteger(revision) || revision < 1) throw new BuildError('BUILD_REVISION_INVALID', 'Agent 没有有效的 Revision');
  if (local) {
    const saved = await localStore.getRevision(agentId, revision);
    // Legacy local records can capture their current revision, never fabricate an old one.
    detail = saved || (local.metadata.revision === revision ? await localStore.captureRevision(local) : null);
    if (!detail) throw new BuildError('BUILD_REVISION_NOT_FOUND', '指定的 Agent Revision 不存在');
  } else if (detail?.metadata?.revision !== revision) {
    throw new BuildError('BUILD_REVISION_UNAVAILABLE', '当前云端接口无法读取指定 Revision，请刷新 Agent 后重新构建');
  }
  if (detail?.metadata?.id !== agentId || detail.metadata.revision !== revision || !detail.spec || typeof detail.spec !== 'object' || Array.isArray(detail.spec)) {
    throw new BuildError('BUILD_DEFINITION_INVALID', 'Agent 定义与指定身份或 Revision 不一致');
  }
  const snapshot = structuredClone({
    agentId, agentName: String(detail.metadata.name || agentId), revision,
    spec: detail.spec, bindings: detail.spec.bindings ?? detail.bindings ?? {}, metadata: detail.metadata,
  });
  const fingerprint = buildIdFor(snapshot);
  const operation = await operations.submit({
    kind: 'build', resourceId: agentId,
    idempotencyKey: String(payload?.idempotencyKey || `build-${fingerprint}`),
    requestFingerprint: fingerprint,
    metadata: { agentName: snapshot.agentName, revision },
    runner: async () => {
      const record = await build.build(snapshot);
      return { buildId: record.id, summary: record.id };
    },
  });
  return { operationId: operation.id, status: operation.status, buildId: operation.result?.buildId || null };
}
