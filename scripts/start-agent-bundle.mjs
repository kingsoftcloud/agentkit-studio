#!/usr/bin/env node
/** Container/installed Host entry; all dependencies must be installed at image build time. */
import { parseArgs } from 'node:util';
import { dirname, join, resolve } from 'node:path';
import { prepareBundleHost } from '../src/bundle-host.mjs';
import { prepareBundleArchive } from '../src/bundle-source.mjs';
import { launchRuntimeHost } from '../src/runtime-host-launcher.mjs';

try {
  const { values } = parseArgs({ options: { ...Object.fromEntries(['archive', 'state', 'installation', 'sha256'].map(name => [name, { type: 'string' }])), 'versioned-state': { type: 'boolean', default: false } } });
  if (!values.archive || !values.state || !values.installation) throw Object.assign(new Error('Usage: start-agent-bundle.mjs --archive portable.zip --state STATE_DIR --installation INSTALLED_RUNTIME [--sha256 SHA256]'), { code: 'BUNDLE_HOST_USAGE' });
  const archive = await prepareBundleArchive({ archive: values.archive, cache: join(dirname(resolve(values.state)), '.bundle-cache') });
  const plan = await prepareBundleHost({ ...values, archive, expectedSha256: values.sha256, versionedState: values['versioned-state'] });
  console.log(JSON.stringify({ event: 'bundle.host.starting', ...plan.identity }));
  process.exitCode = await launchRuntimeHost(plan);
} catch (error) {
  // Do not leak a failing dependency's URL, environment, headers or local path.
  console.error(JSON.stringify({ event: 'bundle.host.failed', code: error.code || 'BUNDLE_HOST_FAILED',
    message: error.code === 'BUNDLE_HOST_USAGE' ? error.message : '运行包启动失败，请检查安装、运行包、独立状态目录及所需凭证' }));
  process.exitCode = 1;
}
