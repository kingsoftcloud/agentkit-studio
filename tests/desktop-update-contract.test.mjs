import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import product from '../src/product.json' with { type: 'json' };
import { resolveProductInputs, resolveWorkflowProductOutputs } from '../scripts/product-config.mjs';

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
    'apps/desktop/scripts/macos-app-update-config.mjs': `app-update.yml writeMacOSAppUpdateConfig const CHANNELS = new Set(['stable', 'preview', 'nightly', 'latest']); channel(provider.channel); useMultipleRangeRequest: false`,
    'apps/desktop/scripts/desktop-auto-update-environment.mjs': `DSH_DESKTOP_UPDATE_ORIGIN DSH_DESKTOP_UPDATE_CHANNEL production must explicitly be stable, preview, or latest ${fallback ? 'https://download.deepseek.com' : ''}`,
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

test('the product definition seals the nightly lane because every Studio build is a prerelease', () => {
  assert.equal(product.desktop.updates.channel, 'nightly');
  const outputs = resolveWorkflowProductOutputs({});
  assert.equal(outputs.channel, 'nightly');
  assert.equal(outputs.build_version, '0.2.2-rc.1', 'an omitted build version falls back to the pinned DSH version');
  // The pinned DSH version carries `-rc.1`; sealing it onto `latest` makes the
  // packaged DSH coordinator throw on every update check.
  assert.throws(() => resolveWorkflowProductOutputs({ channel: 'latest' }),
    /product configuration: latest channel requires a stable three-segment version without a prerelease/);
  assert.throws(() => resolveWorkflowProductOutputs({ channel: 'latest', buildVersion: '0.2.2-rc.1.20261109.1' }),
    /requires a stable three-segment version without a prerelease/);
  assert.equal(resolveWorkflowProductOutputs({ channel: 'nightly', buildVersion: '0.2.2-rc.1.20261109.1' }).channel, 'nightly');
  assert.equal(resolveWorkflowProductOutputs({ channel: 'preview', buildVersion: '0.2.2-rc.1.20261109.1' }).channel, 'preview');
});

test('only a GA three-segment desktop version may select the latest lane', () => {
  const latest = resolveProductInputs({ buildVersion: '1.2.3', updateChannel: 'latest' });
  assert.equal(latest.desktopVersion, '1.2.3');
  assert.equal(latest.settings.DSH_DESKTOP_UPDATE_CHANNEL, 'latest');
  assert.throws(() => resolveProductInputs({ buildVersion: '1.2.3-rc.1', updateChannel: 'latest' }),
    /product configuration: latest channel requires a stable three-segment version without a prerelease/);
  assert.throws(() => resolveProductInputs({ buildVersion: '1.2.3.20261109.1', updateChannel: 'latest' }),
    /invalid public product inputs/, 'the dated four-segment Studio suffix is not a stable semver build version');
  assert.equal(resolveProductInputs({ buildVersion: '1.2.3-rc.1', updateChannel: 'nightly' }).settings.DSH_DESKTOP_UPDATE_CHANNEL, 'nightly');
  assert.equal(resolveProductInputs({ buildVersion: '1.2.3', updateChannel: 'nightly' }).settings.DSH_DESKTOP_UPDATE_CHANNEL, 'nightly');
});
