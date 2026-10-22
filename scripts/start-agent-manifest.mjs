#!/usr/bin/env node
/** Installed DSH entry for canonical, package-free Agent declarations. */
import { parseArgs } from 'node:util';
import { prepareManagedRuntimeHost } from '../src/managed-runtime-host.mjs';
import { launchRuntimeHost } from '../src/runtime-host-launcher.mjs';

try {
  const { values } = parseArgs({ options: Object.fromEntries(['manifest', 'state', 'installation'].map(name => [name, { type: 'string' }])) });
  if (!values.manifest || !values.state || !values.installation) throw Object.assign(new Error('Usage: start-agent-manifest.mjs --manifest agentengine.yaml --state STATE_DIR --installation INSTALLED_RUNTIME'), { code: 'MANAGED_HOST_USAGE' });
  const plan = await prepareManagedRuntimeHost(values);
  console.log(JSON.stringify({ event: 'manifest.host.starting', ...plan.identity }));
  process.exitCode = await launchRuntimeHost(plan);
} catch (error) {
  console.error(JSON.stringify({ event: 'manifest.host.failed', code: error.code || 'MANAGED_HOST_FAILED',
    message: error.code === 'MANAGED_HOST_USAGE' ? error.message : '声明运行时启动失败，请检查固定安装、声明摘要、专用状态和注入配置' }));
  process.exitCode = 1;
}
