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

async function digest(body, algorithm = 'sha512', encoding = 'base64') {
  const hash = createHash(algorithm); let size = 0;
  for await (const bytes of body) { hash.update(bytes); size += bytes.length; }
  return { size, hash: hash.digest(encoding) };
}

export async function publishWindowsCandidate({ candidate, proof, origin, source, version, previous, channel = 'preview',
  environment = process.env, fetchImpl = fetch, upload = uploadKs3ReleaseArtifact }) {
  if (!/^[0-9a-f]{40}$/.test(source || '') || !previous) throw Error('Source and previous feed state are required');
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
  const result = { ...release, feedUrl: new URL(plan.feedKey, origin).href, rangeVerified: true, bridgeVerified: true };
  await writeFile(join(output, 'publication.json'), JSON.stringify(result, null, 2));
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: Object.fromEntries(['candidate', 'proof', 'origin', 'source', 'version', 'previous', 'channel'].map(key => [key, { type: 'string' }])) });
  console.log(JSON.stringify(await publishWindowsCandidate(values), null, 2));
}
