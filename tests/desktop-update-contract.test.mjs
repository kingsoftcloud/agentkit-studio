import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));

async function fixture(t, fallback = false) {
  const dsh = await mkdtemp(join(tmpdir(), 'studio-desktop-contract-'));
  t.after(() => rm(dsh, { recursive: true, force: true }));
  await mkdir(join(dsh, 'apps/desktop/scripts'), { recursive: true });
  await mkdir(join(dsh, 'apps/desktop/src'), { recursive: true });
  const files = {
    'apps/desktop/package.json': JSON.stringify({ dependencies: { 'electron-updater': '6.8.9' } }),
    'apps/desktop/scripts/electron-builder-config.mjs': `differentialPackage: true; publish: [{ channel: update.channel }]; appId = 'com.kingsoftcloud.agentkit-studio'`,
    'apps/desktop/src/update-coordinator.ts': 'checkForUpdates downloadUpdate quitAndInstall autoDownload = false DSH_DESKTOP_UPDATE_CHANNEL',
    'apps/desktop/src/update-schedule.ts': 'intervalMs setTimeout check()',
    'apps/desktop/tsdown.config.ts': 'DSH_DESKTOP_UPDATE_CHANNEL',
    'apps/desktop/scripts/package-macos.ts': '.zip.blockmap',
    'apps/desktop/scripts/macos-app-update-config.mjs': `app-update.yml writeMacOSAppUpdateConfig const CHANNELS = new Set(['stable', 'preview']); channel(provider.channel)`,
    'apps/desktop/scripts/desktop-auto-update-environment.mjs': `DSH_DESKTOP_UPDATE_ORIGIN DSH_DESKTOP_UPDATE_CHANNEL production must explicitly be stable or preview ${fallback ? 'https://download.deepseek.com' : ''}`,
    'apps/desktop/scripts/desktop-release-environment.mjs': 'production DSH_DESKTOP_APP_ID com.kingsoftcloud.agentkit-studio',
    'apps/desktop/scripts/package-target.ts': 'writeReleaseRecord com.kingsoftcloud.agentkit-studio',
    'Makefile': 'desktop-package-preflight DSH_DESKTOP_PLUGIN_INPUTS',
  };
  for (const [name, contents] of Object.entries(files)) await writeFile(join(dsh, name), contents);
  return dsh;
}

test('desktop update contract accepts an explicit Studio source and channel', async t => {
  const dsh = await fixture(t);
  const result = await run(process.execPath, ['scripts/verify-desktop-update-inputs.mjs'], {
    cwd: root, env: { ...process.env, AGENTKIT_DSH_ROOT: dsh },
  });
  assert.match(result.stdout, /source-inputs-passed/);
});

test('desktop update contract rejects the DSH production download fallback', async t => {
  const dsh = await fixture(t, true);
  await assert.rejects(run(process.execPath, ['scripts/verify-desktop-update-inputs.mjs'], {
    cwd: root, env: { ...process.env, AGENTKIT_DSH_ROOT: dsh },
  }), /DSH download origin/);
});
