/** Real Electron single-instance regression with an already running DSH-identity fixture. */
import { _electron as electron, expect } from '@playwright/test';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import asar from '@electron/asar';

export async function verifyWindowsCoexistence(executablePath, environment, root, evidence) {
  const fixture = join(root, 'official-dsh-fixture');
  const source = join(root, 'fixture-source');
  const marker = join(root, 'foreign-second-instance.txt');
  await mkdir(join(fixture, 'resources'), { recursive: true });
  await mkdir(source, { recursive: true });
  // Borrow only Electron's signed engine, not the product runtime or plugins.
  for (const entry of await readdir(dirname(executablePath), { withFileTypes: true })) {
    if (entry.isFile() || entry.name === 'locales') await cp(join(dirname(executablePath), entry.name), join(fixture, entry.name), { recursive: true });
  }
  await writeFile(join(source, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-desktop', version: '0.2.0', main: 'main.cjs' }));
  await writeFile(join(source, 'main.cjs'), `
const { app, BrowserWindow } = require('electron');
const { writeFileSync } = require('node:fs');
const http = require('node:http');
if (!app.requestSingleInstanceLock()) app.exit(91);
app.on('second-instance', () => writeFileSync(${JSON.stringify(marker)}, 'forwarded to official DSH'));
app.whenReady().then(() => {
  const server = http.createServer((q, r) => r.end('official DSH fixture'));
  server.listen(19387, '127.0.0.1', () => {
    const window = new BrowserWindow();
    window.loadURL('data:text/html,<title>Official DSH identity fixture</title><h1>Official DSH identity fixture</h1>');
  });
});
`);
  await asar.createPackage(source, join(fixture, 'resources', 'app.asar'));
  const legacyProfile = join(environment.DSH_HOME, 'profiles', 'desktop');
  await mkdir(legacyProfile, { recursive: true });
  const legacyPatch = '# existing official DSH plugin configuration\n[]\n';
  await writeFile(join(legacyProfile, 'cordis.patch.yml'), legacyPatch);
  const foreign = await electron.launch({ executablePath: join(fixture, executablePath.split(/[\\/]/).at(-1)), env: environment, timeout: 120000 });
  let studio;
  try {
    const foreignPage = await foreign.firstWindow();
    await expect(foreignPage.getByRole('heading')).toHaveText('Official DSH identity fixture');
    studio = await electron.launch({ executablePath, env: environment, timeout: 120000 });
    const page = await studio.firstWindow({ timeout: 120000 });
    await expect(page.getByRole('button', { name: '总览', exact: true })).toBeVisible({ timeout: 120000 });
    const later=page.locator('.agentkit-credential-onboarding-content').getByRole('button',{name:'稍后设置',exact:true});
    if(await later.isVisible()) await later.click();
    await expect(page.getByRole('button', { name: 'Agents', exact: true })).toBeVisible();
    const identity = await studio.evaluate(({ app }) => ({ name: app.name, version: app.getVersion(), userData: app.getPath('userData') }));
    const foreignIdentity = await foreign.evaluate(({ app }) => ({ name: app.name, userData: app.getPath('userData') }));
    if (identity.userData === foreignIdentity.userData) throw new Error('Studio still shares official DSH Electron state');
    const productProfile = join(environment.DSH_HOME, 'profiles', 'desktop-agentkit-studio', 'package.json');
    const profile = JSON.parse(await readFile(productProfile, 'utf8'));
    if (!profile.dsh?.profile?.bundles?.includes('@kingsoftcloud/agentkit-studio')) throw new Error('Studio product plugin is not activated');
    if (await readFile(join(legacyProfile, 'cordis.patch.yml'), 'utf8') !== legacyPatch) throw new Error('Official DSH profile was modified');
    try { await readFile(marker); throw new Error('Studio launch was forwarded to official DSH'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await page.screenshot({ path: join(evidence, 'windows-dsh-coexistence.png'), fullPage: true });
    await writeFile(join(evidence, 'windows-dsh-coexistence.json'), JSON.stringify({ fixture: 'real Electron with official DSH package identity and occupied port 19387', identity, foreignIdentity, studioPluginActivated: true, legacyProfilePreserved: true, foreignProcessAlive: true }, null, 2));
  } catch (error) {
    const forwarded = await readFile(marker, 'utf8').then(() => true, () => false);
    await writeFile(join(evidence, 'windows-dsh-coexistence-failure.json'), JSON.stringify({ message: error.message, launchForwardedToForeignDsh: forwarded }, null, 2));
    throw error;
  } finally { if (studio) await studio.close(); await foreign.close(); }
}
