/** Launch the actually installed Windows app and verify rendered onboarding and build identity. */
import { _electron as electron, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import asar from '@electron/asar';
import YAML from 'yaml';
import { verifyDesktopModuleGraph } from './desktop-module-graph.mjs';
import { verifyWindowsCoexistence } from './verify-windows-coexistence.mjs';
import { verifyOfficialDshCoexistence } from './verify-windows-official-dsh.mjs';
import { verifyStudioOnboarding } from './verify-studio-onboarding-ui.mjs';

if (process.platform !== 'win32') throw new Error('Windows app UI acceptance requires Windows');
const executablePath=process.env.STUDIO_INSTALLED_APP;
const expectedVersion=process.env.BUILD_VERSION;
if (!executablePath || !expectedVersion) throw new Error('Installed app and build version are required');
const archive=join(dirname(executablePath),'resources/app.asar');
const trayBytes=await readFile(join(dirname(executablePath),'resources/tray.ico'));
if(!trayBytes.equals(await readFile(new URL('../assets/agentkit-studio-tray.ico',import.meta.url)))) throw new Error('Installed tray icon differs from the Nexus product resource');
const updateProvider=YAML.parse(await readFile(join(dirname(executablePath),'resources/app-update.yml'),'utf8'));
if(updateProvider.useMultipleRangeRequest!==false || updateProvider.url!=='https://agentkit.ks3-cn-beijing.ksyuncs.com/studio/feeds/win-x64/') throw new Error('Installed Windows update provider must use canonical Studio single-range feed');
const moduleGraph=await verifyDesktopModuleGraph(path=>asar.extractFile(archive,normalize(path)).toString('utf8'));
const evidence=resolve('.artifacts/windows-proof');
const root=join(tmpdir(),'studio-installed-ui-'+Date.now());
await mkdir(evidence,{recursive:true}); await mkdir(root,{recursive:true});
const environment=Object.fromEntries(Object.entries(process.env).filter(([name])=> !/(?:KEY|SECRET|TOKEN|PASSWORD|CERTUM|PSMODULEPATH)/i.test(name)));
const app=await electron.launch({executablePath,args:['--user-data-dir='+join(root,'electron')],env:{...environment,DSH_HOME:join(root,'dsh'),AGENTKIT_HOME:join(root,'agentkit'),DSH_TELEMETRY_DISABLED:'1'},timeout:120000});
try {
  const page=await app.firstWindow({timeout:120000});
  await expect(page.locator('body')).toContainText('AgentKit Studio',{timeout:120000});
  // Read app.getVersion from the installed Electron process, independently of feed metadata.
  const version=await app.evaluate(({app:electronApp})=>electronApp.getVersion());
  if (version!==expectedVersion) throw new Error('Installed Electron version differs from release input');
  const trayImage=await app.evaluate(({nativeImage})=>nativeImage.createFromPath(process.resourcesPath+'/tray.ico').getSize());
  if(trayImage.width<16 || trayImage.height<16) throw new Error('Native Windows tray image could not be decoded');
  const onboardingProof=await verifyStudioOnboarding(page,join(evidence,'windows-onboarding-model.png'));
  const onboardingVisible=true;
  await page.screenshot({path:join(evidence,'windows-installed-ui.png'),fullPage:true});
  // Windows exposes both the brand row and the separate new-session button.
  await expect(page.getByRole('button',{name:/^(新会话|新建会话|New session|New chat)$/}).first()).toBeVisible({timeout:120000});
  await page.getByRole('button',{name:/^(设置|Settings)$/}).click();
  await page.getByRole('button',{name:'AgentKit Studio',exact:true}).click();
  await expect(page.getByText(expectedVersion,{exact:true}).first()).toBeVisible({timeout:30000});
  await page.screenshot({path:join(evidence,'windows-version-settings.png'),fullPage:true});
  await promisify(execFile)('powershell.exe',['-NoProfile','-File',fileURLToPath(new URL('./verify-windows-tray.ps1',import.meta.url)),'-Evidence',evidence],{timeout:60000});
  await writeFile(join(evidence,'windows-installed-ui.json'),JSON.stringify({version,actualInstalledApp:true,windowTitle:await page.title(),onboardingVisible,...onboardingProof,studioGuideNavigatesToModelSettings:true,singleRangeConfigured:true,trayResourceMatchesNexus:true,nativeTrayDecoded:true,moduleGraph},null,2));
  const receiptPath=join(evidence,'windows-install.json');
  const receipt=JSON.parse(await readFile(receiptPath,'utf8'));
  await writeFile(receiptPath,JSON.stringify({...receipt,version,uiVerified:true,onboardingVisible},null,2));
  console.log('Actually installed Windows App rendered and reported the expected build version.');
} finally {await app.close();}

await verifyWindowsCoexistence(executablePath, { ...environment, DSH_HOME: join(root, 'shared-dsh'), AGENTKIT_HOME: join(root, 'shared-agentkit'), DSH_TELEMETRY_DISABLED: '1' }, root, evidence);

await promisify(execFile)('powershell.exe', ['-NoProfile', '-File', fileURLToPath(new URL('./verify-windows-installer-ui.ps1', import.meta.url)), '-Installer', process.env.STUDIO_SIGNED_INSTALLER, '-Evidence', evidence], { timeout: 900000, maxBuffer: 1024 * 1024 });

const visibleInstall=JSON.parse(await readFile(join(evidence,'windows-installer-ui.json'),'utf8'));
await verifyOfficialDshCoexistence(visibleInstall.installedPath, environment, root, evidence);
