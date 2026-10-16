/** Verify a signed macOS candidate in isolated test data without updating the user's installed app. */
import {_electron as electron,expect} from '@playwright/test';
import {parseArgs,promisify} from 'node:util';
import {execFile} from 'node:child_process';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {verifyStudioCatalogUi} from './verify-studio-catalog-ui.mjs';
import {verifyStudioOnboarding} from './verify-studio-onboarding-ui.mjs';
if(process.platform!=='darwin') throw new Error('Native macOS onboarding verification requires macOS');
const {values}=parseArgs({options:Object.fromEntries(['app','version','output'].map(key=>[key,{type:'string'}]))});
const appPath=resolve(values.app), evidence=resolve(values.output), root=await mkdtemp(join(tmpdir(),'studio-onboarding-mac-'));
await mkdir(evidence,{recursive:true});
const executable=(await promisify(execFile)('/usr/libexec/PlistBuddy',['-c','Print :CFBundleExecutable',join(appPath,'Contents/Info.plist')])).stdout.trim();
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/(KEY|SECRET|TOKEN|PASSWORD|CERTUM|APPLE|CSC_)/i.test(key)));
Object.assign(env,{DSH_HOME:join(root,'dsh'),AGENTKIT_HOME:join(root,'agentkit'),DSH_TELEMETRY_DISABLED:'1'});
const app=await electron.launch({executablePath:join(appPath,'Contents/MacOS',executable),args:['--user-data-dir='+join(root,'electron')],cwd:root,env,timeout:120000});
try {
  const page=await app.firstWindow({timeout:120000});
  const version=await app.evaluate(({app})=>app.getVersion());
  if(version!==values.version) throw new Error('Signed macOS candidate version mismatch');
  const proof=await verifyStudioOnboarding(page,join(evidence,'macos-onboarding-model.png'));
  await expect(page.getByRole('button',{name:'智能体',exact:true})).toBeVisible();
  await page.getByRole('button',{name:/^(设置|Settings)$/}).click();
  await page.getByRole('button',{name:'AgentKit Studio',exact:true}).click();
  await page.getByRole('button',{name:'重新打开凭证引导',exact:true}).click();
  await expect(page.locator('.agentkit-credential-onboarding-content')).toContainText('可以开始对话了');
  await page.locator('.agentkit-onboarding-actions').getByRole('button',{name:'开始对话',exact:true}).click();
  const catalog = await verifyStudioCatalogUi(page);
  await page.screenshot({path:join(evidence,'macos-catalog.png'),fullPage:true});
  await writeFile(join(evidence,'macos-onboarding.json'),JSON.stringify({version,actualSignedApp:true,catalog,...proof,configuredReopenVerified:true},null,2));
} catch(error) {
  for(const [index,page] of app.windows().entries()) {
    await page.screenshot({path:join(evidence,`macos-onboarding-failure-${index}.png`),fullPage:true}).catch(()=>{});
  }
  await writeFile(join(evidence,'macos-onboarding-failure.json'),JSON.stringify({message:error.message},null,2));
  throw error;
} finally {await app.close();}
