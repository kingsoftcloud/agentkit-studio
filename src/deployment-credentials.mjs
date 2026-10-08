/** Resolve only frozen resource requirements, never serialize this result. */
import { verifyPortableBundle } from './portable-bundle.mjs';
import { portableError, validatePortableCredentialNames } from './portable-resources.mjs';
import { resolveMcpConnection } from './local-resource-adapters.mjs';

const normalizeUrl = value => new URL(value).href.replace(/\/$/, '');
const changed = () => { throw portableError('DEPLOYMENT_RESOURCE_CHANGED', '资源配置在准备部署后发生变化，请重新检查运行包'); };
const idOf = value => String(value?.resourceId || value?.id || value || '');
export const PLATFORM_CREDENTIAL_NAMES = new Set(['KSYUN_ACCESS_KEY', 'KSYUN_SECRET_KEY', 'KSYUN_SESSION_TOKEN']);

export async function resolveDeploymentCredentials({ zip, models, adapters, credentials, configuration, env = process.env }) {
  const { manifest, definition } = verifyPortableBundle(zip);
  validatePortableCredentialNames(manifest.requirements);
  const values = Object.create(null);
  const put = (name, value) => {
    if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw portableError('PORTABLE_CREDENTIAL_MISSING', '目标部署缺少运行包声明的凭证，请检查模型与资源设置');
    if (Object.hasOwn(values, name) && values[name] !== value) throw portableError('DEPLOYMENT_ENV_CONFLICT', '多个绑定资源使用了同名但不同值的凭证，请调整凭证引用');
    values[name] = value;
  };
  for (const profile of manifest.resources.profiles) {
    const current = await models.profile(profile.id);
    if (['provider', 'modelName'].some(key => current[key] !== profile[key]) || normalizeUrl(current.baseUrl) !== profile.baseUrl || (current.codexApi || '') !== (profile.codexApi || '')) changed();
    put(profile.credentialName, current.apiKey);
  }
  for (const mcp of manifest.resources.mcps) {
    const binding = (definition.spec.bindings?.mcpServers || definition.bindings?.mcpServers || []).find(item => idOf(item) === mcp.resourceId);
    if (!binding) changed();
    const current = await resolveMcpConnection(await adapters.describeMcp(binding), credentials, env);
    if (current.resourceId !== mcp.resourceId || normalizeUrl(current.endpoint) !== mcp.endpointUrl) changed();
    const headers = new Map(Object.entries(current.headers).map(([key, value]) => [key.toLowerCase(), String(value)]));
    const expected = [...Object.keys(mcp.headers), ...Object.keys(mcp.envRefs)].map(key => key.toLowerCase());
    if (headers.size !== expected.length || expected.some(key => !headers.has(key))) changed();
    for (const [header, value] of Object.entries(mcp.headers)) if (headers.get(header.toLowerCase()) !== value) changed();
    for (const [header, name] of Object.entries(mcp.envRefs)) put(name, headers.get(header.toLowerCase()));
  }
  const { values: config } = await configuration.resolve();
  for (const requirement of manifest.requirements) {
    if (PLATFORM_CREDENTIAL_NAMES.has(requirement.name)) {
      if (requirement.resourceId !== 'cloud') throw portableError('DEPLOYMENT_ENV_CONFLICT', '资源凭证名称不能覆盖平台云端身份');
      // Current Container contract injects AK/SK, but has no STS token guarantee.
      if (requirement.name === 'KSYUN_SESSION_TOKEN') throw portableError('DEPLOYMENT_STS_UNSUPPORTED', '该运行包要求 STS 令牌，当前容器注入合同尚未支持');
      const frozen = manifest.resources.cloud;
      if (normalizeUrl(config.cloudServerUrl || 'https://aicp.api.ksyun.com') !== frozen.cloudServerUrl || (config.cloudRegion || 'cn-beijing-6') !== frozen.cloudRegion || (config.cloudCustomSource || '') !== (frozen.cloudCustomSource || '')) changed();
      put(requirement.name, config[requirement.name === 'KSYUN_ACCESS_KEY' ? 'cloudAccessKey' : 'cloudSecretKey']);
    }
    if (!Object.hasOwn(values, requirement.name)) throw portableError('PORTABLE_CREDENTIAL_MISSING', '运行包凭证没有对应的绑定资源');
  }
  return values;
}
