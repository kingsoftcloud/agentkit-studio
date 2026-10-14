/** Coexistence qualification against a pinned, publicly distributed official DSH installer. */
import { _electron as electron, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import asar from '@electron/asar';

const OFFICIAL_URL = 'https://download.deepseek.com/desktop/dsh-latest-windows-x64.exe';
const OFFICIAL_SHA256 = 'd61cd8882f8b8a1251144320493ad27920d15139503eba2465b9579eee720cfc';

export async function verifyOfficialDshCoexistence(executablePath, environment, root, evidence) {
  const installer = join(root, 'official-dsh-0.2.0-rc.2.exe'), destination = join(root, 'official-dsh-installed');
  const response = await fetch(OFFICIAL_URL, { signal: AbortSignal.timeout(600000) });
  if (!response.ok || !response.body) throw new Error('Official DSH installer is unavailable');
  const hash = createHash('sha256');
  await pipeline(Readable.fromWeb(response.body), new Transform({ transform(bytes, _encoding, done) { hash.update(bytes); done(null, bytes); } }), createWriteStream(installer, { flags: 'wx' }));
  if (hash.digest('hex') !== OFFICIAL_SHA256) throw new Error('Official mutable download has changed; review and pin the new official installer before continuing');
  await promisify(execFile)('powershell.exe', ['-NoProfile', '-Command', '$ErrorActionPreference="Stop"; $s=Get-AuthenticodeSignature $env:OFFICIAL_INSTALLER; if($s.Status -ne "Valid" -or -not $s.TimeStamperCertificate){throw "Official installer signature invalid"}; $p=Start-Process $env:OFFICIAL_INSTALLER -ArgumentList @("/S",("/D="+$env:OFFICIAL_DESTINATION)) -PassThru -Wait; if($p.ExitCode){throw "Official installation failed"}'], { env: { ...environment, OFFICIAL_INSTALLER: installer, OFFICIAL_DESTINATION: destination }, timeout: 300000 });
  const officialPath = join(destination, 'DeepSeek Harness.exe');
  const officialMetadata = JSON.parse(asar.extractFile(join(destination, 'resources', 'app.asar'), 'package.json'));
  const sharedHome = join(root, 'real-official-shared-dsh');
  const shared = { ...environment, DSH_HOME: sharedHome, AGENTKIT_HOME: join(root, 'real-official-agentkit'), DEEPSEEK_API_KEY: 'qualification-local-only', DSH_TELEMETRY_DISABLED: '1' };
  const official = await electron.launch({ executablePath: officialPath, env: shared, timeout: 120000 });
  let studio;
  try {
    const officialPage = await official.firstWindow({ timeout: 120000 });
    await expect(officialPage.locator('body')).not.toBeEmpty({ timeout: 120000 });
    const legacyPath = join(sharedHome, 'profiles', 'desktop', 'package.json');
    await expect.poll(() => readFile(legacyPath,'utf8').then(() => true, () => false), { timeout: 120000 }).toBe(true);
    const before = await readFile(legacyPath, 'utf8');
    await officialPage.screenshot({ path: join(evidence, 'windows-real-official-dsh.png'), fullPage: true });
    studio = await electron.launch({ executablePath, env: shared, timeout: 120000 });
    const page = await studio.firstWindow({ timeout: 120000 });
    await expect(page.getByRole('button', { name: 'Agents', exact: true })).toBeVisible({ timeout: 120000 });
    await expect(page.getByRole('button', { name: '总览', exact: true })).toBeVisible();
    if (await readFile(legacyPath, 'utf8') !== before) throw new Error('Studio changed the running official DSH profile');
    if (await official.evaluate(({app}) => app.getVersion()) !== officialMetadata.version) throw new Error('The running official application identity changed');
    await page.screenshot({ path: join(evidence, 'windows-real-dsh-studio-coexistence.png'), fullPage: true });
    const studioIdentity = await studio.evaluate(({app}) => ({ name: app.name, version: app.getVersion(), userData: app.getPath('userData') }));
    const officialIdentity = await official.evaluate(({app}) => ({ name: app.name, version: app.getVersion(), userData: app.getPath('userData') }));
    if (studioIdentity.userData === officialIdentity.userData) throw new Error('Real official DSH and Studio share Electron state');
    await writeFile(join(evidence, 'windows-real-official-dsh.json'), JSON.stringify({ realOfficialInstaller: true, officialInstallerSha256: OFFICIAL_SHA256, officialMetadata: { name: officialMetadata.name, version: officialMetadata.version }, officialIdentity, studioIdentity, bothProcessesAlive: true, legacyProfilePreserved: true, studioNavigationVerified: true }, null, 2));
  } finally { if (studio) await studio.close(); await official.close(); }
}
