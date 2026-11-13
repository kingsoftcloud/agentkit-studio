/** A mounted declaration projected into the existing DSH admission contract.
 * Native Session storage remains authoritative; no ZIP or local Build is made.
 */
import { isAbsolute } from 'node:path';
import { engineServiceEndpoint } from './providers/engine-service-client.mjs';
import { HARNESS_SERVICE_MODEL_PROVIDER } from './providers/native-engine-runtime.mjs';
import { isDeepStrictEqual } from 'node:util';
import { loadManagedRuntimeManifest } from './managed-runtime-manifest.mjs';
import { managedResourceBindings } from './managed-resource-contract.mjs';
import { defaultNativeToolBindings } from './native-tool-catalog.mjs';

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);

function loadHostModel(model, env) {
  let endpoint;
  try { endpoint = new URL(env.OPENAI_BASE_URL); } catch { /* checked below */ }
  if (!endpoint || !['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    fail('MANAGED_HOST_MODEL_INVALID', '平台模型入口必须是无内嵌凭证的 HTTP(S) 地址');
  }
  if (!String(env.AGENTKIT_MODEL_API_KEY || '').trim()) fail('MANAGED_HOST_MODEL_CREDENTIAL_MISSING', '平台模型凭证未注入');
  const codexApi = env.AGENTKIT_MANAGED_CODEX_API || 'responses';
  if (!['responses', 'chat-completions'].includes(codexApi)) fail('MANAGED_HOST_MODEL_INVALID', 'Codex 模型接口类型无效');
  return { id: model, modelName: model, provider: 'openai-compatible', baseUrl: endpoint.href.replace(/\/$/, ''),
    credentialName: 'AGENTKIT_MODEL_API_KEY', enabled: true, default: true, codexApi };
}

export async function loadManagedRuntimeDefinition({ manifest, env = process.env }) {
  const loaded = await loadManagedRuntimeManifest(manifest, { env });
  const agentId = env.AGENTENGINE_AGENT_ID, versionId = env.AGENTENGINE_AGENT_VERSION_ID;
  if (!identifier(agentId) || !identifier(versionId)) fail('MANAGED_HOST_IDENTITY_INVALID', '平台 AgentId 和 VersionId 必须明确提供');
  if (env.AGENTKIT_RUNTIME_BUILD_ID || env.AGENTKIT_BUNDLE_SOURCE || env.AGENTKIT_BUNDLE_SHA256) {
    fail('MANAGED_HOST_INPUT_CONFLICT', '声明输入不能同时指定 portable Build 或运行包');
  }
  const { declaration, sha256 } = loaded;
  const remoteHarness = declaration.framework === 'harness' && [
    'AGENTKIT_ENGINE_SERVICE_URL', 'AGENTKIT_ENGINE_SERVICE_TOKEN', 'AGENTKIT_ENGINE_SERVICE_WORKSPACE', 'AGENTKIT_ENGINE_SERVICE_CA_FILE',
  ].some(key => env[key] !== undefined);
  if (remoteHarness) {
    try {
      const endpoint = engineServiceEndpoint(env.AGENTKIT_ENGINE_SERVICE_URL, env.AGENTKIT_ENGINE_SERVICE_TOKEN);
      if (env.AGENTKIT_ENGINE_SERVICE_CA_FILE !== undefined && (!isAbsolute(env.AGENTKIT_ENGINE_SERVICE_CA_FILE) || new URL(endpoint).protocol !== 'https:'))
        throw new Error('CA binding invalid');
      if (typeof env.AGENTKIT_ENGINE_SERVICE_WORKSPACE !== 'string'
        || !isAbsolute(env.AGENTKIT_ENGINE_SERVICE_WORKSPACE)) throw new Error('workspace missing');
    } catch {
      fail('MANAGED_HARNESS_SERVICE_BINDING_INVALID', '托管 Harness 服务地址、凭据或工作区绑定无效');
    }
  }
  const profile = remoteHarness ? null : loadHostModel(declaration.model, env);
  const harnessModelSelection = remoteHarness ? { provider: HARNESS_SERVICE_MODEL_PROVIDER, model: declaration.model } : null;
  const identity = { agentId, versionId, manifestSha256: sha256, runtimeName: declaration.runtime.name, runtimeVersion: declaration.runtime.version };
  // A platform declaration bypasses createAgentStore's authoring defaults.
  // Use the same available Native builtin profile before preset admission;
  // ordinary per-session permission checks still own every invocation.
  const bindings = { ...(profile ? { modelProfileId: profile.id, modelProfileIds: [profile.id] } : {}),
    ...(declaration.framework === 'harness' && !remoteHarness ? { tools: defaultNativeToolBindings({ env }) } : {}),
    ...managedResourceBindings(declaration.resources) };
  // The platform declaration is the only authority for a managed Agent, so the
  // local Studio `spec.memory` projection must be materialized here: without it
  // every managed turn skipped recall/write defaults even though the memory
  // library was bound in the manifest.
  const memory = declaration.resources?.memory
    ? { enabled: true, recall: { enabled: true }, write: { mode: 'candidate' } }
    : undefined;
  const agent = { metadata: { id: agentId, name: declaration.name, description: declaration.description || '', revision: 1, local: true, versionId },
    source: 'managed-runtime', managedRuntime: identity,
    spec: { runtime: { type: remoteHarness ? 'native-engine' : declaration.framework }, instructions: { system: declaration.prompt }, ...(memory ? { memory } : {}), bindings }, bindings };
  return { ...loaded, identity, agent, modelProfiles: profile ? [profile] : [], harnessModelSelection };
}

/** A read-only definition view for existing Harness/Codex resource consumers.
 * A manifest is not authored or rebuilt inside its runtime container.
 */
export function createManagedAgentStore(runtime) {
  const record = runtime.agent;
  const copy = () => structuredClone(record);
  const owns = id => id === record.metadata.id;
  const readonly = async () => fail('MANAGED_RUNTIME_READ_ONLY', '托管声明由平台版本管理，不支持在运行容器内编辑');
  return {
    list: async () => [copy()],
    get: async id => owns(id) ? copy() : null,
    getRevision: async (id, revision) => owns(id) && Number(revision) === 1 ? copy() : null,
    listRevisions: async id => owns(id) ? [copy()] : [],
    captureRevision: async value => {
      if (!owns(value?.metadata?.id) || value?.managedRuntime?.manifestSha256 !== runtime.sha256 || !isDeepStrictEqual(value?.spec, record.spec)) return readonly();
      return copy();
    },
    create: readonly, update: readonly, remove: readonly,
  };
}
