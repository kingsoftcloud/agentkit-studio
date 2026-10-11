import { readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withDesktopCheckout } from './desktop-checkout.mjs';

const studioRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dshRoot = resolve(process.env.AGENTKIT_DSH_ROOT || join(studioRoot, '../../deepseek-harness'));
const patchRoot = resolve(process.env.AGENTKIT_DESKTOP_UPDATE_PATCHES || join(studioRoot, 'patches/dsh-v0.2.0-rc.2'));
const read = path => readFile(path, 'utf8');

async function verify(checkout) {
  const [desktopPackage, builderConfig, coordinator, updateSchedule, tsdownConfig, packageMac, macUpdateConfig, autoUpdateEnvironment, releaseEnvironment, packageTarget, makefile, releaseTool, installTool] = await Promise.all([
    read(join(checkout, 'apps/desktop/package.json')),
    read(join(checkout, 'apps/desktop/scripts/electron-builder-config.mjs')),
    read(join(checkout, 'apps/desktop/src/update-coordinator.ts')),
    read(join(checkout, 'apps/desktop/src/update-schedule.ts')),
    read(join(checkout, 'apps/desktop/tsdown.config.ts')),
    read(join(checkout, 'apps/desktop/scripts/package-macos.ts')),
    read(join(checkout, 'apps/desktop/scripts/macos-app-update-config.mjs')),
    read(join(checkout, 'apps/desktop/scripts/desktop-auto-update-environment.mjs')),
    read(join(checkout, 'apps/desktop/scripts/desktop-release-environment.mjs')),
    read(join(checkout, 'apps/desktop/scripts/package-target.ts')),
    read(join(studioRoot, 'Makefile')),
    read(join(studioRoot, 'scripts/desktop-release.mjs')),
    read(join(studioRoot, 'scripts/verify-desktop-installed-update.mjs')),
  ]);
  const packageJson = JSON.parse(desktopPackage);
  if (!packageJson.dependencies?.['electron-updater']) throw new Error('DSH Desktop updater dependency is missing');
  if (!/differentialPackage\s*:\s*true/.test(builderConfig)) throw new Error('electron-builder differentialPackage is not enabled');
  if (!/DSH_DESKTOP_UPDATE_ORIGIN/.test(autoUpdateEnvironment + builderConfig + coordinator + packageTarget + makefile)) throw new Error('Studio update origin input is missing');
  if (/download\.deepseek\.com/u.test(autoUpdateEnvironment + builderConfig + coordinator + packageTarget + makefile)) throw new Error('Studio updater still falls back to the DSH download origin');
  if (!/DSH_DESKTOP_UPDATE_CHANNEL/.test(coordinator + tsdownConfig + makefile)) throw new Error('Studio Stable/Preview channel input is missing');
  if (!/production[\s\S]*must explicitly be stable or preview/.test(autoUpdateEnvironment)) throw new Error('production channel is not fail-closed');
  if (!/setTimeout|intervalMs|check\(/.test(updateSchedule)) throw new Error('automatic update checking is missing');
  if (!/production[\s\S]*(?:DESKTOP_APP_ID_ENV|DSH_DESKTOP_APP_ID)[\s\S]*com\.kingsoftcloud\.agentkit-studio/.test(releaseEnvironment)) throw new Error('Studio desktop App ID input is missing');
  if (!/channel\s*:\s*update\.channel/.test(builderConfig)) throw new Error('electron-builder does not publish the selected Studio channel');
  if (!/stable.*preview|preview.*stable/s.test(macUpdateConfig)) throw new Error('macOS updater does not expose Stable/Preview channels');
  for (const [label, source, patterns] of [
    ['coordinator', coordinator, ['checkForUpdates', 'downloadUpdate', 'quitAndInstall', 'autoDownload = false']],
    ['mac package', packageMac, ['.zip.blockmap']],
    ['macOS update config', macUpdateConfig, ['app-update.yml', 'writeMacOSAppUpdateConfig', 'channel(provider.channel)']],
    ['desktop package', packageTarget, ['writeReleaseRecord']],
    ['Studio package preflight', makefile, ['desktop-package-preflight', 'DSH_DESKTOP_PLUGIN_INPUTS']],
    ['Studio release publisher', releaseTool, ['desktop-upload-plan.ts', 'desktop-upload-run.ts', 'Range', 'publish']],
    ['Studio installed update qualification', installTool, ['hdiutil', 'codesign', 'spctl', 'real Electron', 'DSH_HOME', 'install-confirmed']],
  ]) {
    for (const pattern of patterns) if (!source.includes(pattern)) throw new Error(`${label} is missing ${pattern}`);
  }
  console.log(JSON.stringify({
    dsh: checkout,
    updater: 'electron-updater',
    differentialPackage: true,
    artifacts: ['DMG', 'ZIP', 'ZIP.blockmap', 'stable-mac.yml|preview-mac.yml'],
    productIdentity: 'com.kingsoftcloud.agentkit-studio (release input; local unsigned default is isolated)',
    channels: ['stable', 'preview'],
    studioPluginInput: 'verified npm tarball',
    status: 'source-inputs-passed',
  }, null, 2));
}

let isGitCheckout = false;
try { await stat(join(dshRoot, '.git')); isGitCheckout = true; } catch { /* fixture or extracted source */ }
if (isGitCheckout) {
  await withDesktopCheckout({
    source: dshRoot,
    output: join(studioRoot, '.artifacts', 'update-verification'),
    patches: patchRoot,
    commit: process.env.DSH_COMMIT || '639ed015397290b3745d163aafe02ffee4aa3f84',
  }, verify);
} else {
  await verify(dshRoot);
}
