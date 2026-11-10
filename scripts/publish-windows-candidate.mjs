/** Promote original signed Windows bytes only after installed-App acceptance. */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { studioWindowsPublication } from '../src/desktop-release-metadata.mjs';
import { resolveKs3OriginCredentials, uploadKs3ReleaseArtifact } from '../src/ks3-release-store.mjs';
import { assertChannelSupportsVersion, assertReleaseChannel, COMPATIBILITY_RELEASE_CHANNELS, DEFAULT_RELEASE_CHANNEL } from '../src/desktop-release-channels.mjs';
import { compatMirrorEvidence, compatMirrorIsCurrent, compatMirrorPlan } from '../src/desktop-release-feed.mjs';

async function digest(body, algorithm = 'sha512', encoding = 'base64') {
  const hash = createHash(algorithm); let size = 0;
  for await (const bytes of body) { hash.update(bytes); size += bytes.length; }
  return { size, hash: hash.digest(encoding) };
}

/** Read a compatibility feed that may not exist yet; undefined means "create it". */
async function readCompatFeed(request, objectKey) {
  const response = await request(objectKey);
  if (response.status === 404) { await response.body?.cancel(); return undefined; }
  if (!response.ok) { await response.body?.cancel(); throw Error(`Compatibility feed could not be read: ${response.status} ${objectKey}`); }
  return Buffer.from(await response.arrayBuffer());
}

export async function publishWindowsCandidate({ candidate, proof, origin, source, version, previous, channel = DEFAULT_RELEASE_CHANNEL,
  environment = process.env, fetchImpl = fetch, upload = uploadKs3ReleaseArtifact }) {
  if (!/^[0-9a-f]{40}$/.test(source || '') || !previous) throw Error('Source and previous feed state are required');
  assertReleaseChannel(channel, 'channel');
  // A prerelease feed on the latest lane leaves every packaged client unable to
  // check for updates; refuse to publish it before reading or uploading anything.
  assertChannelSupportsVersion(channel, version, 'candidate version');
  const root = resolve(candidate), output = join(root, '.publication');
  const metadata = YAML.parse(await readFile(join(root, `${channel}.yml`), 'utf8'));
  if (metadata.version !== version) throw Error('Candidate version differs');
  const plan = studioWindowsPublication(metadata, { origin, channel });
  const name = `deepseek-harness-${version}-win-x64.exe`, installer = join(root, name), blockmap = `${installer}.blockmap`;
  const receipt = JSON.parse((await readFile(proof, 'utf8')).replace(/^\uFEFF/, ''));
  if (receipt.version !== version || receipt.installer !== name ||
    !['installerSigned', 'timestamped', 'installed', 'appSigned', 'uiVerified'].every(key => receipt[key] === true)) throw Error('Installed Windows acceptance is incomplete');
  const actual = await digest(createReadStream(installer));
  const sha256 = (await digest(createReadStream(installer), 'sha256', 'hex')).hash;
  if (actual.hash !== metadata.files[0].sha512 || actual.size !== metadata.files[0].size ||
    sha256 !== String(receipt.installerSha256).toLowerCase()) throw Error('Signed installer digest differs');
  const mapDigest = await digest(createReadStream(blockmap));
  if (!mapDigest.size) throw Error('Blockmap is empty');
  const request = (key, init = {}) => fetchImpl(new URL(key, origin), { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(900000), ...init });
  const before = await request(plan.feedKey);
  if (before.status === 404) {
    await before.body?.cancel();
    if (previous !== 'absent') throw Error('Previous feed is missing');
  } else {
    if (!before.ok) throw Error(`Previous feed could not be read: ${before.status}`);
    const current = YAML.parse(await before.text());
    const identical = current.version === version && current.files?.[0]?.sha512 === actual.hash && current.files?.[0]?.url === plan.metadata.files[0].url;
    if (!identical && (previous === 'absent' || current.version !== previous)) throw Error('Previous feed changed');
  }
  const credentials = resolveKs3OriginCredentials(environment, origin);
  const send = (objectKey, path, contentType) => upload({ ...credentials, origin, objectKey, path, contentType });
  await send(plan.assets.exe, installer, 'application/vnd.microsoft.portable-executable');
  await send(plan.assets.blockmap, blockmap, 'application/octet-stream');
  const head = await request(plan.assets.exe, { method: 'HEAD' });
  if (!head.ok || Number(head.headers.get('content-length')) !== actual.size) throw Error('Public installer size differs');
  const range = await request(plan.assets.exe, { headers: { Range: 'bytes=0-0' } });
  if (range.status !== 206 || range.headers.get('content-range') !== `bytes 0-0/${actual.size}` ||
    range.headers.get('accept-ranges')?.toLowerCase() !== 'bytes' || (await range.arrayBuffer()).byteLength !== 1) throw Error('Public installer range failed');
  const publicExe = await request(plan.assets.exe), publicMap = await request(plan.assets.blockmap);
  if (!publicExe.ok || !publicMap.ok) throw Error('Public release assets are unavailable');
  const downloaded = await digest(publicExe.body), downloadedMap = await digest(publicMap.body);
  if (downloaded.hash !== actual.hash || downloaded.size !== actual.size || downloadedMap.hash !== mapDigest.hash || downloadedMap.size !== mapDigest.size) throw Error('Public release bytes differ');
  await mkdir(output, { recursive: true });
  const release = { version, sourceCommit: source, installerSha256: sha256, installerSha512: actual.hash,
    installerBytes: actual.size, signed: true, timestamped: true, installedUiVerified: true };
  const releasePath = join(output, 'win-x64-release.json'), feedPath = join(output, `${channel}.yml`);
  await writeFile(releasePath, JSON.stringify(release, null, 2));
  await writeFile(feedPath, YAML.stringify(plan.metadata));
  await send(plan.releaseKey, releasePath, 'application/json');
  // Both binary objects are publicly verified before either feed can advance.
  await send(plan.feedKey, feedPath, 'application/yaml');
  await send(plan.bridgeFeedKey, feedPath, 'application/yaml');
  for (const key of [plan.feedKey, plan.bridgeFeedKey]) {
    const response = await request(key);
    if (!response.ok || YAML.stringify(YAML.parse(await response.text())) !== YAML.stringify(plan.metadata)) throw Error('Published Windows feed differs');
  }
  // Every historical Windows install reads the channel sealed into its own
  // app-update.yml. Mirror the exact published bytes onto the compatibility
  // lanes and both feed layouts so one update reaches the newest build.
  const compatMirrors = [];
  const feedBytes = await readFile(feedPath);
  for (const mirror of compatMirrorPlan({ version, sourceChannel: channel, target: 'win-x64', channels: COMPATIBILITY_RELEASE_CHANNELS }).mirrors) {
    const feedUrl = new URL(mirror.objectKey, origin).href;
    let status = 'unchanged';
    const uploaded = [];
    if (!compatMirrorIsCurrent(await readCompatFeed(request, mirror.objectKey), feedBytes)) {
      uploaded.push(await send(mirror.objectKey, feedPath, mirror.contentType));
      const published = await readCompatFeed(request, mirror.objectKey);
      if (!compatMirrorIsCurrent(published, feedBytes)) throw Error(`Published compatibility feed differs: ${mirror.objectKey}`);
      status = 'updated';
    }
    compatMirrors.push(compatMirrorEvidence({ mirror, feedUrl, bytes: feedBytes, status, uploaded }));
  }
  const result = { ...release, feedUrl: new URL(plan.feedKey, origin).href, rangeVerified: true, bridgeVerified: true, compatMirrors };
  await writeFile(join(output, 'publication.json'), JSON.stringify(result, null, 2));
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: Object.fromEntries(['candidate', 'proof', 'origin', 'source', 'version', 'previous', 'channel'].map(key => [key, { type: 'string' }])) });
  console.log(JSON.stringify(await publishWindowsCandidate(values), null, 2));
}
