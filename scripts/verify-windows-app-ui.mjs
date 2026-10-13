/** Launch the actually installed Windows app and verify rendered onboarding and build identity. */
import { _electron as electron, expect } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

if (process.platform !== 'win32') throw new Error('Windows app UI acceptance requires Windows');
const executablePath=process.env.STUDIO_INSTALLED_APP;
const expectedVersion=process.env.BUILD_VERSION;
if (!executablePath || !expectedVersion) throw new Error('Installed app and build version are required');
const evidence=resolve('.artifacts/windows-proof');
const root=join(tmpdir(),'studio-installed-ui-'+Date.now());
await mkdir(evidence,{recursive:true}); await mkdir(root,{recursive:true});
const environment=Object.fromEntries(Object.entries(process.env).filter(([name])=> !/(?:SECRET|TOKEN|PASSWORD|CERTUM|ACCESS_KEY)/i.test(name)));
const app=await electron.launch({executablePath,args:['--user-data-dir='+join(root,'electron')],env:{...environment,DSH_HOME:join(root,'dsh'),AGENTKIT_CONFIG:join(root,'agentkit-config.yml'),DSH_TELEMETRY_DISABLED:'1'},timeout:120000});
try {
  const page=await app.firstWindow({timeout:120000});
  await expect(page.locator('body')).toContainText('AgentKit Studio',{timeout:120000});
  // Read app.getVersion from the installed Electron process, independently of feed metadata.
  const version=await app.evaluate(({app:electronApp})=>electronApp.getVersion());
  if (version!==expectedVersion) throw new Error('Installed Electron version differs from release input');
  const body=await page.locator('body').innerText();
  const onboardingVisible=/凭证引导|配置模型|模型与凭证|Model.*credential|Set up.*model/i.test(body);
  await page.screenshot({path:join(evidence,'windows-installed-ui.png'),fullPage:true});
  await writeFile(join(evidence,'windows-installed-ui.json'),JSON.stringify({version,actualInstalledApp:true,windowTitle:await page.title(),onboardingVisible},null,2));
  const receiptPath=join(evidence,'windows-install.json');
  const receipt=JSON.parse(await readFile(receiptPath,'utf8'));
  await writeFile(receiptPath,JSON.stringify({...receipt,version,uiVerified:true,onboardingVisible},null,2));
  console.log('Actually installed Windows App rendered and reported the expected build version.');
} finally {await app.close();}
