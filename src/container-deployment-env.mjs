/** Node-only projection: never persist or send this result to the browser. */
import { verifyPortableBundle } from './portable-bundle.mjs';
import { portableError, sha256, validatePortableCredentialNames } from './portable-resources.mjs';

export function createContainerDeploymentEnvironment({ zip, expectedSha256, runtimeToken, credentials = {} }) {
  if (!/^[a-f0-9]{64}$/.test(expectedSha256 || '') || sha256(zip) !== expectedSha256) {
    throw portableError('DEPLOYMENT_BUNDLE_MISMATCH', '运行包与部署指定的 SHA256 不一致');
  }
  const { manifest, definition } = verifyPortableBundle(zip);
  validatePortableCredentialNames(manifest.requirements);
  if (!['harness', 'dsh-native', 'codex'].includes(definition.spec?.runtime?.type)) {
    throw portableError('PORTABLE_RUNTIME_UNSUPPORTED', '此运行包的运行时不受支持');
  }
  if (typeof runtimeToken !== 'string' || runtimeToken.length < 24 || /[\r\n\0]/.test(runtimeToken)) {
    throw portableError('BUNDLE_HOST_TOKEN_REQUIRED', '运行入口需要至少 24 字符的独立访问令牌');
  }
  const entries = new Map();
  function put(Key, Value, IsSensitive) {
    const previous = entries.get(Key);
    if (previous && previous.Value !== Value) {
      throw portableError('DEPLOYMENT_ENV_CONFLICT', '资源凭证与部署环境变量冲突，请调整凭证引用');
    }
    entries.set(Key, { Key, Value, IsSensitive: Boolean(IsSensitive || previous?.IsSensitive) });
  }
  put('AGENTKIT_BUNDLE_SHA256', expectedSha256, false);
  put('AGENTKIT_RUNTIME_TOKEN', runtimeToken, true);
  for (const { name } of manifest.requirements) {
    const value = Object.hasOwn(credentials, name) ? credentials[name] : undefined;
    if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
      throw portableError('PORTABLE_CREDENTIAL_MISSING', '目标部署缺少运行包声明的凭证');
    }
    put(name, value, true);
  }
  const bindings = definition.spec?.bindings || definition.bindings || {};
  const first = bindings.modelProfileIds?.[0];
  const primaryId = bindings.modelProfileId || (typeof first === 'string' ? first : first?.resourceId || first?.id);
  const profile = manifest.resources.profiles?.find(item => item.id === primaryId);
  const key = profile && entries.get(profile.credentialName)?.Value;
  if (!profile?.modelName || !profile.baseUrl || !key) {
    throw portableError('DEPLOYMENT_MODEL_MISSING', '运行包缺少默认绑定模型及其凭证');
  }
  // Existing CreateAgentProduct recognizes OPENAI_API_KEY. Without this alias it
  // tries to provision an AICP key, even when the frozen Host already has a key.
  put('OPENAI_API_KEY', key, true);
  put('OPENAI_BASE_URL', profile.baseUrl, false);
  put('OPENAI_MODEL_NAME', profile.modelName, false);
  return [...entries.values()];
}
