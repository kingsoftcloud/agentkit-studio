/** The Server must preserve explicit storage before Studio creates a stateful container. */
import { portableError } from './portable-resources.mjs';

export function containerStorageCapability(data) {
  const value = data?.Capabilities?.ContainerStorage;
  if (value?.Contract !== 'agentengine.container-storage/v1') return null;
  if (!Array.isArray(value.Frameworks) || value.Frameworks.some(item => !['harness', 'codex'].includes(item))
    || value.MinSizeGi !== 20 || value.MaxSizeGi !== 500 || value.MaxReplicas !== 1 || value.PaymentType !== 'Daily') {
    throw portableError('DEPLOYMENT_CATALOG_INVALID', '云端持久化能力声明无效');
  }
  return structuredClone(value);
}

export function storageSize(value = 20) {
  if (!Number.isInteger(value) || (value !== 0 && (value < 20 || value > 500))) {
    throw portableError('DEPLOYMENT_STORAGE_INVALID', '持久化容量须为 20 至 500 GiB，或选择临时存储');
  }
  return value;
}

export function deploymentStorage(resources) {
  return resources?.storageGiB ? { MountPath: '/var/lib/agentkit', SizeGi: resources.storageGiB } : null;
}

export function admitDeploymentStorage(resources, catalog, runtime) {
  if (!deploymentStorage(resources)) return;
  if (!catalog.containerStorage?.Frameworks.includes(runtime === 'codex' ? 'codex' : 'harness')) {
    throw portableError('DEPLOYMENT_STORAGE_UNAVAILABLE', '当前云端未声明支持持久化部署，请先升级 Server；不会创建缺少所选存储的实例');
  }
}

export function verifyDeploymentStorage(detail, record) {
  const expected = deploymentStorage(record.plan.resources);
  if (!expected) return;
  const actual = detail.Deployment?.Storage;
  if (actual?.MountPath !== expected.MountPath || actual?.SizeGi !== expected.SizeGi) {
    throw portableError('DEPLOYMENT_STORAGE_MISMATCH', '云端存储与部署配置不符，暂不可对话；请核对实例配置');
  }
}
