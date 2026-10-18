/** Resolve Studio's own immutable image releases from the existing Server metadata API. */
import { createHash } from 'node:crypto';
import { containerStorageCapability } from './deployment-storage.mjs';
import { studioVersions } from './studio-version.mjs';

export const STUDIO_IMAGE_CONFIG_KEY = 'studio.runtime.images.v1';
const FORMAT = 'agentkit.runtime-images/v1';
const RUNTIMES = new Set(['dsh-native', 'harness', 'codex']);
const VERSION = /^\d+\.\d+\.\d+$/;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/;
const IMAGE = /^(hub(?:-vpc)?(?:-[a-z0-9-]+)?\.kce\.ksyun\.com)\/([a-z0-9][a-z0-9_-]*)\/([a-z0-9][a-z0-9_.-]*)@sha256:([a-f0-9]{64})$/;
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const supportedVersion = (current, minimum) => {
  const left = current.split('.').map(Number), right = minimum.split('.').map(Number);
  for (let index = 0; index < 3; index++) { if (left[index] !== right[index]) return left[index] > right[index]; }
  return true;
};

export function parseStudioImageCatalog(data, { runtime, clientVersion = '0.0.1' } = {}) {
  if (!RUNTIMES.has(runtime) || !VERSION.test(clientVersion)) fail('DEPLOYMENT_RUNTIME_UNSUPPORTED', '部署仅支持 DSH Native、Codex 和 AgentKit Harness');
  if (!object(data) || data.Product !== 'agentkit-studio' || data.ClientType !== 'studio'
    || !ID.test(data.Environment || '') || !ID.test(data.Region || '')) {
    fail('DEPLOYMENT_CATALOG_INVALID', '云端镜像目录的产品、环境或区域不匹配');
  }
  const raw = data.Configs?.[STUDIO_IMAGE_CONFIG_KEY];
  if (!raw) fail('DEPLOYMENT_CATALOG_MISSING', `${data.Environment === 'online' ? '线上' : data.Environment === 'pre-online' ? '预发' : data.Environment}环境（${data.Region}）尚未发布 Studio 运行镜像。请在设置中核对云端环境，或由管理员发布该环境的镜像目录。`);
  if (!object(raw) || raw.format !== FORMAT || !Array.isArray(raw.releases) || raw.releases.length > 100
    || raw.environment !== data.Environment || raw.region !== data.Region) {
    fail('DEPLOYMENT_CATALOG_INVALID', 'Studio 镜像目录格式或目标环境无效');
  }
  const releases = [], ids = new Set();
  for (const item of raw.releases) {
    const image = typeof item?.image === 'string' && IMAGE.exec(item.image);
    if (!object(item) || !ID.test(item.id || '') || ids.has(item.id) || !image
      || (item.capabilities !== undefined && (!Array.isArray(item.capabilities) || item.capabilities.some(value => !['personal-assistant/v1', 'personal-assistant-identity/v1', 'personal-assistant-delete/v1'].includes(value)) || new Set(item.capabilities).size !== item.capabilities.length))
      || (item.runtimeIdentity !== undefined && typeof item.runtimeIdentity !== 'boolean')
      || typeof item.enabled !== 'boolean' || !['preview', 'stable'].includes(item.channel)
      || !Array.isArray(item.runtimes) || !item.runtimes.length || new Set(item.runtimes).size !== item.runtimes.length
      || item.runtimes.some(value => !RUNTIMES.has(value)) || item.bundleFormat !== 'agentkit.portable-bundle/v1'
      || !VERSION.test(item.minimumStudioVersion || '') || !Number.isInteger(item.port) || item.port !== 8080 || item.platform !== 'linux/amd64'
      || !ID.test(item.version || '') || typeof item.label !== 'string' || !item.label.trim() || item.label.length > 120
      || !Array.isArray(item.notices) || item.notices.some(value => typeof value !== 'string' || value.length > 300)) {
      fail('DEPLOYMENT_CATALOG_INVALID', 'Studio 镜像版本缺少有效摘要、兼容范围或发布信息');
    }
    ids.add(item.id);
    // Preview releases are never silently promoted through a production scope.
    if (item.enabled && item.channel === 'preview' && raw.environment !== 'pre-online') {
      fail('DEPLOYMENT_CATALOG_INVALID', '预发候选镜像不能作为生产环境部署目标');
    }
    if (!item.enabled || !item.runtimes.includes(runtime) || !supportedVersion(clientVersion, item.minimumStudioVersion)) continue;
    releases.push({ id: item.id, label: item.label, channel: item.channel, image: item.image, version: item.version,
      runtimeIdentity: item.runtimeIdentity === true, capabilities: [...(item.capabilities || [])], digest: `sha256:${image[4]}`, registry: image[1], namespace: image[2], repository: image[3], port: item.port, platform: item.platform,
      runtimes: [...item.runtimes], bundleFormat: item.bundleFormat, minimumStudioVersion: item.minimumStudioVersion,
      notices: [...item.notices] });
  }
  if (raw.defaultReleaseId !== null && !ID.test(raw.defaultReleaseId || '')) fail('DEPLOYMENT_CATALOG_INVALID', '镜像目录默认版本无效');
  if (raw.defaultReleaseId && !ids.has(raw.defaultReleaseId)) fail('DEPLOYMENT_CATALOG_INVALID', '镜像目录默认版本不存在');
  const defaultReleaseId = releases.some(item => item.id === raw.defaultReleaseId) ? raw.defaultReleaseId : null;
  const containerStorage = containerStorageCapability(data);
  return { format: FORMAT, environment: raw.environment, region: raw.region, runtime, defaultReleaseId, containerStorage,
    revision: createHash('sha256').update(JSON.stringify([raw, containerStorage])).digest('hex'), releases };
}

export function selectStudioImage(catalog, releaseId) {
  const selected = catalog.releases.find(item => item.id === (releaseId || catalog.defaultReleaseId));
  if (!selected) fail('DEPLOYMENT_IMAGE_UNAVAILABLE', '当前运行时没有可用的镜像版本，请更新目录或选择兼容版本');
  return structuredClone(selected);
}

export function createDeploymentImages({ client, configuration, clientVersion }) {
  async function list(runtime, options = {}) {
    const version = clientVersion ?? (await studioVersions()).pluginVersion;
    const { values } = await configuration.resolve();
    const response = await client.getBootstrapConfig({ region: values.cloudRegion || 'cn-beijing-6', runtime, clientVersion: version }, options);
    return parseStudioImageCatalog(response.data, { runtime, clientVersion: version });
  }
  async function resolve(runtime, releaseId, options) {
    const catalog = await list(runtime, options);
    return { catalog, image: selectStudioImage(catalog, releaseId) };
  }
  return { list, resolve };
}
