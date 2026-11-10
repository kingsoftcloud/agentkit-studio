/** Publish a qualified Windows NSIS candidate, then promote its public channel feed. */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import YAML from 'yaml';
import { resolveKs3OriginCredentials, uploadKs3ReleaseArtifact } from '../src/ks3-release-store.mjs';
import { studioWindowsPublication } from '../src/desktop-release-metadata.mjs';
import { assertChannelSupportsVersion, assertReleaseChannel, COMPATIBILITY_RELEASE_CHANNELS, DEFAULT_RELEASE_CHANNEL } from '../src/desktop-release-channels.mjs';
import { compatMirrorEvidence, compatMirrorIsCurrent, compatMirrorPlan } from '../src/desktop-release-feed.mjs';

async function digest(path, algorithm = 'sha512') {
  const hash = createHash(algorithm); let size = 0;
  for await (const bytes of createReadStream(path)) { hash.update(bytes); size += bytes.length; }
  return { size, hash: hash.digest(algorithm === 'sha512' ? 'base64' : 'hex') };
}

/** Read a compatibility feed that may not exist yet; undefined means "create it". */
async function readOptionalFeed(url) {
  const response = await fetch(url, { cache: 'no-store', redirect: 'error' });
  if (response.status === 404) { await response.body?.cancel(); return undefined; }
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Compatibility feed could not be read: ${response.status} ${url}`); }
  return Buffer.from(await response.arrayBuffer());
}

export async function publishWindowsRelease({ candidate, evidence, origin, channel = DEFAULT_RELEASE_CHANNEL, sourceCommit, credentials }) {
  if (!/^[0-9a-f]{40}$/.test(sourceCommit || '')) throw new Error('The actual signed Studio source commit is required');
  assertReleaseChannel(channel, 'channel');
  const root = resolve(candidate), proofRoot = resolve(evidence);
  const metadata = YAML.parse(await readFile(join(root, `${channel}.yml`), 'utf8'));
  // Fail before uploading when this version cannot live on the selected lane.
  assertChannelSupportsVersion(channel, metadata.version, 'candidate version');
  const plan = studioWindowsPublication(metadata, { origin, channel });
  const install = JSON.parse(await readFile(join(proofRoot, 'windows-install.json'), 'utf8'));
  const ui = JSON.parse(await readFile(join(proofRoot, 'windows-installed-ui.json'), 'utf8'));
  const coexistence = JSON.parse(await readFile(join(proofRoot, 'windows-dsh-coexistence.json'), 'utf8'));
  const realOfficial = JSON.parse(await readFile(join(proofRoot, 'windows-real-official-dsh.json'), 'utf8'));
  const installerUI = JSON.parse(await readFile(join(proofRoot, 'windows-installer-ui.json'), 'utf8'));
  if (install.version !== metadata.version || ui.version !== metadata.version || !install.installerSigned || !install.timestamped
    || !install.appSigned || !install.installed || !install.uiVerified || !ui.actualInstalledApp || !ui.moduleGraph?.verified
    || !ui.officialWelcomeAbsent || !ui.officialRechargeAbsent || !ui.studioGuideNavigatesToModelSettings || !ui.singleRangeConfigured
    || !ui.trayResourceMatchesNexus || !ui.nativeTrayDecoded
    || !realOfficial.realOfficialInstaller || !realOfficial.bothProcessesAlive || !realOfficial.legacyProfilePreserved || !realOfficial.studioNavigationVerified
    || !coexistence.studioPluginActivated || !coexistence.foreignProcessAlive || !coexistence.legacyProfilePreserved
    || !installerUI.installerBrandVerified || !installerUI.visibleInstallation || !installerUI.finishLaunchVerified || !installerUI.studioNavigationVerified) {
    throw new Error('Real signed installation, Studio UI, coexistence and visible Finish launch qualification are required');
  }
  const exe = join(root, `deepseek-harness-${metadata.version}-win-x64.exe`);
  const sha512 = await digest(exe), sha256 = await digest(exe, 'sha256');
  if (sha512.hash !== metadata.sha512 || sha512.size !== metadata.files[0].size || sha256.hash !== install.installerSha256.toLowerCase()) throw new Error('Qualified installer bytes do not match metadata or installation receipt');
  const output = join(root, '.windows-publication'); await mkdir(output, { recursive: true });
  const uploaded = [];
  for (const [path, objectKey] of [[exe, plan.assets.exe], [`${exe}.blockmap`, plan.assets.blockmap]]) {
    uploaded.push(await uploadKs3ReleaseArtifact({ ...credentials, origin, objectKey, path, contentType: 'application/octet-stream' }));
    const response = await fetch(`${origin}/${objectKey}`, { redirect: 'error', signal: AbortSignal.timeout(900000) });
    if (!response.ok || !response.body) throw new Error('Published Windows binary is not publicly readable');
    const remote = createHash('sha512'); let size = 0;
    for await (const bytes of response.body) { remote.update(bytes); size += bytes.length; }
    const local = await digest(path);
    if (remote.digest('base64') !== local.hash || size !== local.size) throw new Error('Public Windows bytes differ from the qualified artifact');
    const range = await fetch(`${origin}/${objectKey}`, { headers: { Range: 'bytes=0-0' }, redirect: 'error', signal: AbortSignal.timeout(30000) });
    if (range.status !== 206 || (await range.arrayBuffer()).byteLength !== 1 || range.headers.get('content-range') !== `bytes 0-0/${size}`) throw new Error('KS3 byte-range download failed');
  }
  const feed = join(output, `${channel}.yml`), release = join(output, 'win-x64-release.json');
  await writeFile(feed, YAML.stringify(plan.metadata));
  const report = { version: metadata.version, sourceCommit, origin, installerSha256: sha256.hash, installerSha512: sha512.hash,
    feedUrl: `${origin}/${plan.feedKey}`, bridgeFeedUrl: `${origin}/${plan.bridgeFeedKey}`, assets: plan.assets,
    signedInstalledUIVerified: true, installerFinishVerified: true, coexistenceFixtureVerified: true, publishedAt: new Date().toISOString() };
  await writeFile(release, JSON.stringify(report, null, 2));
  // Promote feeds only after both immutable files have passed complete public digest and Range checks.
  for (const [path, objectKey, contentType] of [[release, plan.releaseKey, 'application/json'], [feed, plan.feedKey, 'application/yaml'], [feed, plan.bridgeFeedKey, 'application/yaml']]) {
    uploaded.push(await uploadKs3ReleaseArtifact({ ...credentials, origin, objectKey, path, contentType }));
    const response = await fetch(`${origin}/${objectKey}`, { cache: 'no-store', redirect: 'error' });
    if (!response.ok || Buffer.compare(Buffer.from(await response.arrayBuffer()), await readFile(path))) throw new Error('Public Windows feed/release bytes differ from publication');
  }
  // Old installs keep reading the channel sealed into their own manifest, so
  // mirror the verified feed bytes onto the compatibility lanes (both layouts).
  const compatMirrors = [];
  const feedBytes = await readFile(feed);
  for (const mirror of compatMirrorPlan({ version: metadata.version, sourceChannel: channel, target: 'win-x64', channels: COMPATIBILITY_RELEASE_CHANNELS }).mirrors) {
    const feedUrl = new URL(mirror.objectKey, origin).href;
    let status = 'unchanged';
    const mirrorUploads = [];
    if (!compatMirrorIsCurrent(await readOptionalFeed(feedUrl), feedBytes)) {
      mirrorUploads.push(await uploadKs3ReleaseArtifact({ ...credentials, origin, objectKey: mirror.objectKey, path: feed, contentType: mirror.contentType }));
      uploaded.push(...mirrorUploads);
      if (!compatMirrorIsCurrent(await readOptionalFeed(feedUrl), feedBytes)) throw new Error(`Published compatibility feed differs: ${mirror.objectKey}`);
      status = 'updated';
    }
    compatMirrors.push(compatMirrorEvidence({ mirror, feedUrl, bytes: feedBytes, status, uploaded: mirrorUploads }));
  }
  report.compatMirrors = compatMirrors;
  await writeFile(join(output, 'publication.json'), JSON.stringify({ ...report, uploaded }, null, 2));
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: Object.fromEntries(['candidate', 'evidence', 'origin', 'channel', 'source'].map(key => [key, { type: 'string' }])) });
  const credentials = resolveKs3OriginCredentials(process.env, values.origin);
  const result = await publishWindowsRelease({ ...values, sourceCommit: values.source, credentials });
  console.log(`Windows feed published: ${result.feedUrl}`);
}
