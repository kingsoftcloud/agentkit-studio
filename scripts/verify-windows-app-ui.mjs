/** Launch the actually installed Windows app and verify rendered onboarding and build identity. */
import { _electron as electron, expect } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import asar from '@electron/asar';
import { verifyDesktopModuleGraph } from './desktop-module-graph.mjs';

if (process.platform !== 'win32') throw new Error('Windows app UI acceptance requires Windows');
const executablePath=process.env.STUDIO_INSTALLED_APP;
const expectedVersion=process.env.BUILD_VERSION;
if (!executablePath || !expectedVersion) throw new Error('Installed app and build version are required');
const archive=join(dirname(executablePath),'resources/app.asar');
const moduleGraph=await verifyDesktopModuleGraph(path=>asar.extractFile(archive,path).toString('utf8'));
const evidence=resolve('.artifacts/windows-proof');
const root=join(tmpdir(),'studio-installed-ui-'+Date.now());
await mkdir(evidence,{recursive:true}); await mkdir(root,{recursive:true});
const environment=Object.fromEntries(Object.entries(process.env).filter(([name])=> !/(?:SECRET|TOKEN|PASSWORD|CERTUM|ACCESS_KEY)/i.test(name)));
const app=await electron.launch({executablePath,args:['--user-data-dir='+join(root,'electron')],env:{...environment,DSH_HOME:join(root,'dsh'),AGENTKIT_HOME:join(root,'agentkit'),DSH_TELEMETRY_DISABLED:'1'},timeout:120000});
try {
  const page=await app.firstWindow({timeout:120000});
  await expect(page.locator('body')).toContainText('AgentKit Studio',{timeout:120000});
  // Read app.getVersion from the installed Electron process, independently of feed metadata.
  const version=await app.evaluate(({app:electronApp})=>electronApp.getVersion());
  if (version!==expectedVersion) throw new Error('Installed Electron version differs from release input');
  const guide=page.locator('.agentkit-credential-onboarding-content');
  await expect(guide).toBeVisible({timeout:120000});
  const onboardingVisible=true;
  await page.screenshot({path:join(evidence,'windows-installed-ui.png'),fullPage:true});
  await page.getByRole('button',{name:'跳过本次',exact:true}).click();
  // Windows exposes both the brand row and the separate new-session button.
  await expect(page.getByRole('button',{name:/^(新会话|新建会话|New session|New chat)$/}).first()).toBeVisible({timeout:120000});
  await page.getByRole('button',{name:/^(设置|Settings)$/}).click();
  await page.getByRole('button',{name:'AgentKit Studio',exact:true}).click();
  await expect(page.getByText(expectedVersion,{exact:true})).toBeVisible({timeout:30000});
  await page.screenshot({path:join(evidence,'windows-version-settings.png'),fullPage:true});
  await writeFile(join(evidence,'windows-installed-ui.json'),JSON.stringify({version,actualInstalledApp:true,windowTitle:await page.title(),onboardingVisible,moduleGraph},null,2));
  const receiptPath=join(evidence,'windows-install.json');
  const receipt=JSON.parse(await readFile(receiptPath,'utf8'));
  await writeFile(receiptPath,JSON.stringify({...receipt,version,uiVerified:true,onboardingVisible},null,2));
  console.log('Actually installed Windows App rendered and reported the expected build version.');
} finally {await app.close();}
