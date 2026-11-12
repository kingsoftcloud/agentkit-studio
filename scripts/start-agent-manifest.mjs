#!/usr/bin/env node
/// <reference types="node" />
/** Installed DSH entry for canonical, package-free Agent declarations. */
import { parseArgs } from 'node:util';

/**
 * Trace the creator of every long `AbortSignal.timeout` deadline.
 *
 * A deadline that fires inside the run boundary surfaces only as a
 * `DOMException` `TimeoutError` whose stack is the timer callback, so the
 * duration is the sole clue and every layer looks equally guilty. This must run
 * at the process entry, before any plugin module arms a deadline at import time.
 * @param thresholdMs - deadlines at or above this value are traced.
 */
function traceLongAbortDeadlines(thresholdMs = 100_000) {
  const original = AbortSignal.timeout;
  if (typeof original !== 'function' || original.traced) return;
  const traced = function timeout(ms) {
    try {
      if (Number(ms) >= thresholdMs) {
        console.info('[agentkit-studio] abort deadline', JSON.stringify({
          ms: Number(ms),
          stack: String(new Error().stack || '').split('\n').slice(1, 9)
            .map(line => line.trim().replace(/^at /, '')).join(' <- '),
        }));
      }
    } catch { /* diagnostics never arm a deadline */ }
    return original.call(AbortSignal, ms);
  };
  traced.traced = true;
  AbortSignal.timeout = traced;
}

traceLongAbortDeadlines();
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
