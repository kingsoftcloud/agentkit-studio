import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { checkInstalledProfile } from '../scripts/check-profile.mjs';

const packageName = '@kingsoftcloud/agentkit-studio';

async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), 'agentkit-studio-profile-test-'));
  const pluginRoot = resolve(root, 'node_modules', '@kingsoftcloud', 'agentkit-studio');
  await mkdir(resolve(pluginRoot, 'dist'), { recursive: true });
  await mkdir(resolve(pluginRoot, 'src'), { recursive: true });
  await writeFile(resolve(root, 'package.json'), JSON.stringify({
    name: 'dsh-profile-agentkit-studio',
    dependencies: { [packageName]: 'file:studio.tgz' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', packageName] } },
  }));
  await writeFile(resolve(pluginRoot, 'package.json'), JSON.stringify({ name: packageName, version: '0.0.1' }));
  await writeFile(resolve(pluginRoot, 'studio.plugin.json'), JSON.stringify({
    id: 'agentkit-studio',
    version: '0.0.1',
    requiredDsh: '0.1.7-rc.2',
    requiredHostApi: 'dsh-native/0.1.7-rc.2',
  }));
  await writeFile(resolve(pluginRoot, 'dist/client.js'), '');
  await writeFile(resolve(pluginRoot, 'src/index.mjs'), '');
  await writeFile(resolve(pluginRoot, 'cordis.patch.yml'), '');
  return root;
}

test('installed profile contains the release package and bundle registration', async t => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual(checkInstalledProfile(root, '0.0.1'), {
    profile: 'dsh-profile-agentkit-studio',
    version: '0.0.1',
    dependency: 'file:studio.tgz',
  });
});

test('installed profile fails closed when Studio is not a profile bundle', async t => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(resolve(root, 'package.json'), JSON.stringify({
    name: 'dsh-profile-agentkit-studio',
    dependencies: { [packageName]: 'file:studio.tgz' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
  }));
  assert.throws(() => checkInstalledProfile(root, '0.0.1'), /bundle list omits/);
});
