/** Coexistence qualification against a pinned, publicly distributed official DSH installer. */
import { _electron as electron, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import asar from '@electron/asar';

const OFFICIAL_VERSION = '0.2.1-rc.2';
const OFFICIAL_URL = `https://download.deepseek.com/dsh-desk/bin/win-x64/deepseek-harness-${OFFICIAL_VERSION}-win-x64.exe`;
const OFFICIAL_SHA256 = '72e4a8579f11b5428dd0a1506532777924adba7ecaacc710a7e429085796537f';

export async function verifyOfficialDshCoexistence(executablePath, environment, root, evidence) {
  const installer = join(root, `official-dsh-${OFFICIAL_VERSION}.exe`), destination = join(root, 'official-dsh-installed');
  const response = await fetch(OFFICIAL_URL, { redirect: 'error', signal: AbortSignal.timeout(600000) });
  if (!response.ok || !response.body) throw new Error('Official DSH installer is unavailable');
  const hash = createHash('sha256');
  await pipeline(Readable.fromWeb(response.body), new Transform({ transform(bytes, _encoding, done) { hash.update(bytes); done(null, bytes); } }), createWriteStream(installer, { flags: 'wx' }));
  const downloadedSha256 = hash.digest('hex');
  await writeFile(join(evidence, 'windows-official-installer-download.json'), JSON.stringify({ url: OFFICIAL_URL, version: OFFICIAL_VERSION, expectedSha256: OFFICIAL_SHA256, downloadedSha256 }, null, 2));
  if (downloadedSha256 !== OFFICIAL_SHA256) throw new Error(`Pinned official installer digest differs: ${downloadedSha256}`);
  await promisify(execFile)('powershell.exe', ['-NoProfile', '-Command', '$ErrorActionPreference="Stop"; $s=Get-AuthenticodeSignature $env:OFFICIAL_INSTALLER; if($s.Status -ne "Valid" -or -not $s.TimeStamperCertificate){throw "Official installer signature invalid"}; if($s.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName,$false) -ne "Hangzhou DeepSeek Artificial Intelligence Co., Ltd."){throw "Official installer publisher differs"}; if((Get-Item $env:OFFICIAL_INSTALLER).VersionInfo.ProductVersion -ne $env:OFFICIAL_VERSION){throw "Official installer version differs"}; $p=Start-Process $env:OFFICIAL_INSTALLER -ArgumentList @("/S",("/D="+$env:OFFICIAL_DESTINATION)) -PassThru -Wait; if($p.ExitCode){throw "Official installation failed"}'], { env: { ...environment, OFFICIAL_INSTALLER: installer, OFFICIAL_DESTINATION: destination, OFFICIAL_VERSION }, timeout: 300000 });
  const officialPath = join(destination, 'DeepSeek Harness.exe');
  const officialMetadata = JSON.parse(asar.extractFile(join(destination, 'resources', 'app.asar'), 'package.json'));
  if (officialMetadata.version !== OFFICIAL_VERSION) throw new Error('Installed official DSH version differs');
  const sharedHome = join(root, 'real-official-shared-dsh');
  const shared = { ...environment, DSH_HOME: sharedHome, AGENTKIT_HOME: join(root, 'real-official-agentkit'), DEEPSEEK_API_KEY: 'qualification-local-only', DSH_TELEMETRY_DISABLED: '1' };
  console.log('Official signed installer installed; launching its normal desktop entry.');
  const official = spawn(officialPath, [], { env: shared, stdio: 'ignore' });
  const nativeProbe = fileURLToPath(new URL('./verify-windows-official-window.ps1', import.meta.url));
  const probe = async (close = false) => promisify(execFile)('powershell.exe', ['-NoProfile','-File',nativeProbe,'-AppPath',officialPath,'-Evidence',evidence,...(close ? ['-Close'] : [])], { env: shared, timeout: 180000 });
  let studio;
  try {
    await probe();
    const legacyPath = join(sharedHome, 'profiles', 'desktop', 'package.json');
    await expect.poll(() => readFile(legacyPath,'utf8').then(() => true, () => false), { timeout: 120000 }).toBe(true);
    const before = await readFile(legacyPath, 'utf8');
    const officialBefore = JSON.parse(await readFile(join(evidence, 'windows-official-process.json'), 'utf8'));
    console.log('Real official DSH window is alive; launching Studio beside it.');
    const studioHash = createHash('sha256').update(await readFile(executablePath)).digest('hex');
    await writeFile(join(evidence, 'windows-before-real-coexistence.json'), JSON.stringify({ officialBefore, studioExecutablePresent: true, studioExecutableSha256: studioHash, executablePath }, null, 2));
    studio = await electron.launch({ executablePath, env: shared, timeout: 120000 });
    const page = await studio.firstWindow({ timeout: 120000 });
    console.log('Studio process connected; waiting for its product navigation.');
    await expect(page.getByRole('button', { name: /^(智能体|Agents)$/ })).toBeVisible({ timeout: 120000 });
    const later=page.locator('.agentkit-credential-onboarding-content').getByRole('button',{name:'稍后设置',exact:true});
    if(await later.isVisible()) await later.click();
    await expect(page.getByRole('button', { name: '总览', exact: true })).toBeVisible();
    if (await readFile(legacyPath, 'utf8') !== before) throw new Error('Studio changed the running official DSH profile');
    await probe();
    const officialAfter = JSON.parse(await readFile(join(evidence, 'windows-official-process.json'), 'utf8'));
    if (officialAfter.pid !== officialBefore.pid) throw new Error('Official DSH was closed or replaced during Studio startup');
    await page.screenshot({ path: join(evidence, 'windows-real-dsh-studio-coexistence.png'), fullPage: true });
    const studioIdentity = await studio.evaluate(({app}) => ({ name: app.name, version: app.getVersion(), userData: app.getPath('userData') }));
    const officialIdentity = { ...officialAfter, name: officialMetadata.name, version: officialMetadata.version };
    await writeFile(join(evidence, 'windows-real-official-dsh.json'), JSON.stringify({ realOfficialInstaller: true, officialInstallerSha256: OFFICIAL_SHA256, officialMetadata: { name: officialMetadata.name, version: officialMetadata.version }, officialIdentity, studioIdentity, bothProcessesAlive: true, legacyProfilePreserved: true, studioNavigationVerified: true }, null, 2));
  } finally { if (studio) await studio.close(); await probe(true); if (!official.killed) official.kill(); }
}
