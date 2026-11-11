import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';
import {
  assertChannelSupportsVersion,
  COMPATIBILITY_RELEASE_CHANNELS,
  DEFAULT_RELEASE_CHANNEL,
  isCompatibilityReleaseChannel,
  isNativeReleaseChannel,
  isStableDesktopVersion,
  parseReleaseChannelList,
  STABLE_ONLY_RELEASE_CHANNELS,
} from '../src/desktop-release-channels.mjs';
import {
  compatMirrorEvidence,
  compatMirrorIsCurrent,
  compatMirrorPlan,
  compatMirrorUploads,
  feedObjectKey,
  parseFeedLayoutList,
  verifyMirroredFeed,
} from '../src/desktop-release-feed.mjs';
import { uploadKs3ReleaseArtifact } from '../src/ks3-release-store.mjs';
import { publishWindowsCandidate } from '../scripts/publish-windows-candidate.mjs';

const STORAGE = 'https://agentkit.ks3-cn-beijing.ksyuncs.com';
const FEED = 'https://feed.ks3-cn-beijing.ksyuncs.com';
const VERSION = '0.2.2-rc.1.20261109.1';

function feedBytes(version = VERSION) {
  return Buffer.from(YAML.stringify({
    version,
    files: [{ url: `${STORAGE}/studio/${version}/AgentKit-Studio-mac-arm64.zip`, size: 123, sha512: 'signed-digest' }],
  }));
}

test('the update vocabulary defaults to nightly and reserves preview as the compatibility lane', () => {
  assert.equal(DEFAULT_RELEASE_CHANNEL, 'nightly');
  assert.deepEqual([...COMPATIBILITY_RELEASE_CHANNELS], ['preview']);
  assert.deepEqual([...STABLE_ONLY_RELEASE_CHANNELS], ['latest', 'stable']);
  assert.equal(isCompatibilityReleaseChannel('preview'), true);
  assert.equal(isCompatibilityReleaseChannel('nightly'), false);
  // `preview` is a legacy lane: feeds and old installs still read it, but a new
  // manifest must be sealed with a native lane.
  assert.equal(isNativeReleaseChannel('preview'), false);
  assert.equal(isNativeReleaseChannel('nightly'), true);
});

test('a prerelease version is accepted on nightly/preview and rejected on latest/stable', () => {
  assert.equal(assertChannelSupportsVersion('nightly', VERSION), VERSION);
  assert.equal(assertChannelSupportsVersion('preview', VERSION), VERSION);
  for (const lane of ['latest', 'stable']) {
    assert.throws(() => assertChannelSupportsVersion(lane, VERSION), /requires a stable three-segment version without a prerelease/);
    assert.throws(() => assertChannelSupportsVersion(lane, `${VERSION}.20261109`), /prerelease/);
  }
  assert.equal(assertChannelSupportsVersion('latest', '1.2.3'), '1.2.3');
  assert.equal(isStableDesktopVersion('0.2.2'), true);
  assert.equal(isStableDesktopVersion('0.2.2-rc.1'), false);
  assert.equal(isStableDesktopVersion('0.2.2.20261109.1'), false, 'the dated Studio suffix is not a GA version');
  assert.throws(() => assertChannelSupportsVersion('beta', VERSION), /channel must be one of nightly, latest, preview, stable/);
  assert.throws(() => assertChannelSupportsVersion('nightly', ''), /version is required/);
});

test('channel lists come from the CLI comma syntax and reject unknown lanes', () => {
  assert.deepEqual(parseReleaseChannelList('preview'), ['preview']);
  assert.deepEqual(parseReleaseChannelList(' preview , nightly '), ['preview', 'nightly']);
  assert.deepEqual(parseReleaseChannelList('preview,preview'), ['preview'], 'duplicates collapse');
  assert.throws(() => parseReleaseChannelList('preview,beta'), /channels must be one of/);
  assert.throws(() => parseReleaseChannelList('   '), /is required/);
});

test('a nightly macOS publication mirrors the same feed onto preview in both layouts', () => {
  const plan = compatMirrorPlan({ version: VERSION, sourceChannel: 'nightly' });
  assert.equal(plan.version, VERSION);
  assert.equal(plan.sourceChannel, 'nightly');
  assert.equal(plan.target, 'mac-arm64');
  assert.deepEqual(plan.mirrors.map(({ targetChannel, targetLayout, objectKey, contentType }) =>
    [targetChannel, targetLayout, objectKey, contentType]), [
    ['preview', 'studio', 'studio/feeds/mac-arm64/preview-mac.yml', 'application/yaml'],
    ['preview', 'legacy', 'dsh-desk/feeds/mac-arm64/preview-mac.yml', 'application/yaml'],
  ]);
  // A repeated publication plans the exact same targets: mirroring is idempotent.
  assert.deepEqual(compatMirrorPlan({ version: VERSION, sourceChannel: 'nightly' }), plan);
});

test('Windows mirrors keep the platform-neutral channel filename in both layouts', () => {
  const plan = compatMirrorPlan({ version: VERSION, sourceChannel: 'nightly', target: 'win-x64' });
  assert.deepEqual(plan.mirrors.map(({ targetLayout, objectKey }) => [targetLayout, objectKey]), [
    ['studio', 'studio/feeds/win-x64/preview.yml'],
    ['legacy', 'dsh-desk/feeds/win-x64/preview.yml'],
  ]);
  assert.deepEqual(compatMirrorPlan({ version: VERSION, sourceChannel: 'nightly', target: 'win-x64', layouts: ['legacy'] }).mirrors
    .map(({ objectKey }) => objectKey), ['dsh-desk/feeds/win-x64/preview.yml']);
});

test('a preview publication does not mirror onto itself, and lanes can be selected', () => {
  assert.deepEqual(compatMirrorPlan({ version: VERSION, sourceChannel: 'preview' }).mirrors, []);
  const selected = compatMirrorPlan({ version: VERSION, sourceChannel: 'nightly', channels: ['preview', 'preview'] });
  assert.equal(selected.mirrors.length, 2, 'duplicate channels collapse to one lane');
  const stable = compatMirrorPlan({ version: '1.2.3', sourceChannel: 'nightly', channels: ['preview', 'stable'] });
  assert.deepEqual(stable.mirrors.map(({ targetChannel }) => targetChannel), ['preview', 'preview', 'stable', 'stable']);
  assert.throws(() => compatMirrorPlan({ version: VERSION, sourceChannel: 'nightly', channels: ['latest'] }), /requires a stable three-segment version/);
  assert.throws(() => compatMirrorPlan({ version: VERSION, sourceChannel: 'nightly', channels: [] }), /non-empty channel list/);
  assert.throws(() => compatMirrorPlan({ version: VERSION, sourceChannel: 'nightly', channels: ['beta'] }), /must be one of/);
});

test('the source lane itself must be able to serve the feed version', () => {
  assert.throws(() => compatMirrorPlan({ version: VERSION, sourceChannel: 'latest' }), /latest channel requires a stable three-segment version/);
  assert.deepEqual(compatMirrorPlan({ version: '1.2.3', sourceChannel: 'latest' }).mirrors.map(({ targetChannel }) => targetChannel), ['preview', 'preview']);
});

test('mirror layouts are validated before planning uploads', () => {
  assert.deepEqual(parseFeedLayoutList('studio, legacy'), ['studio', 'legacy']);
  assert.deepEqual(parseFeedLayoutList('studio,studio'), ['studio']);
  assert.throws(() => parseFeedLayoutList('studio,other'), /feed layouts must be one of studio, legacy/);
  assert.throws(() => parseFeedLayoutList(' '), /feed layouts is required/);
  assert.throws(() => compatMirrorPlan({ version: VERSION, sourceChannel: 'nightly', layouts: ['other'] }), /feed layout must be one of/);
  assert.throws(() => compatMirrorPlan({ version: VERSION, sourceChannel: 'nightly', layouts: [] }), /non-empty feed layout list/);
  assert.throws(() => feedObjectKey({ layout: 'studio', channel: 'beta' }), /channel must be one of/);
  assert.throws(() => feedObjectKey({ layout: 'other', channel: 'preview' }), /feed layout/);
  assert.throws(() => feedObjectKey({ layout: 'studio', channel: 'preview', target: 'mac-x64' }), /feed target must be one of/);
});

test('the upload list names every target object for every distinct origin', () => {
  const plan = compatMirrorPlan({ version: VERSION, sourceChannel: 'nightly' });
  const uploads = compatMirrorUploads(plan, { origins: [STORAGE, FEED, STORAGE] });
  assert.deepEqual(uploads, [
    { origin: STORAGE, objectKey: 'studio/feeds/mac-arm64/preview-mac.yml', contentType: 'application/yaml' },
    { origin: FEED, objectKey: 'studio/feeds/mac-arm64/preview-mac.yml', contentType: 'application/yaml' },
    { origin: STORAGE, objectKey: 'dsh-desk/feeds/mac-arm64/preview-mac.yml', contentType: 'application/yaml' },
    { origin: FEED, objectKey: 'dsh-desk/feeds/mac-arm64/preview-mac.yml', contentType: 'application/yaml' },
  ]);
  assert.equal(new Set(uploads.map(upload => upload.objectKey)).size, 2, 'one byte copy per target object');
  assert.throws(() => compatMirrorUploads(plan, { origins: [] }), /at least one upload origin/);
  assert.throws(() => compatMirrorUploads(plan, { origins: ['http://agentkit.ks3-cn-beijing.ksyuncs.com'] }), /HTTPS origin/);
  assert.throws(() => compatMirrorUploads({}, { origins: [STORAGE] }), /mirror plan is required/);
});

test('a current compatibility feed is left untouched so repeated mirrors are idempotent', () => {
  const bytes = feedBytes();
  assert.equal(compatMirrorIsCurrent(bytes, Buffer.from(bytes)), true);
  assert.equal(compatMirrorIsCurrent(bytes, feedBytes()), true, 'equal bytes are current');
  assert.equal(compatMirrorIsCurrent(undefined, bytes), false, 'a missing target must be created');
  assert.equal(compatMirrorIsCurrent(bytes, Buffer.from('version: other\n')), false);
  assert.equal(compatMirrorIsCurrent(null, bytes), false);
});

test('mirror evidence records the fields a publication report needs', () => {
  const plan = compatMirrorPlan({ version: VERSION, sourceChannel: 'nightly' });
  const bytes = feedBytes();
  const [studioMirror] = plan.mirrors;
  const evidence = compatMirrorEvidence({ mirror: studioMirror, feedUrl: `${STORAGE}/studio/feeds/mac-arm64/preview-mac.yml`,
    bytes, status: 'updated', uploaded: [{ origin: STORAGE, objectKey: studioMirror.objectKey }] });
  assert.deepEqual({ ...evidence, feedSha512: undefined, uploaded: undefined }, {
    version: VERSION,
    sourceChannel: 'nightly',
    targetChannel: 'preview',
    targetLayout: 'studio',
    objectKey: 'studio/feeds/mac-arm64/preview-mac.yml',
    feedUrl: `${STORAGE}/studio/feeds/mac-arm64/preview-mac.yml`,
    feedBytes: bytes.length,
    feedSha512: undefined,
    status: 'updated',
    uploaded: undefined,
  });
  assert.equal(evidence.feedSha512, createHash('sha512').update(bytes).digest('base64'));
  assert.equal(evidence.uploaded.length, 1);
  assert.throws(() => compatMirrorEvidence({ bytes }), /one planned mirror/);
  assert.throws(() => compatMirrorEvidence({ mirror: studioMirror, bytes }), /feed URL is required/);
  assert.throws(() => compatMirrorEvidence({ mirror: studioMirror, feedUrl: `${STORAGE}/x.yml`, bytes, status: 'skipped' }), /status must be updated or unchanged/);
});

test('a legacy feed layout accepts the canonical studio binary it already serves', () => {
  // Live dsh-desk feeds point at studio/<version>/ binaries even though the feed
  // object itself lives under dsh-desk/feeds/. The feed layout and the binary
  // location are validated separately.
  const live = Buffer.from(YAML.stringify({
    version: '0.2.1-rc.2.20261022.14',
    files: [{ url: `${STORAGE}/studio/0.2.1-rc.2.20261022.14/AgentKit-Studio-mac-arm64.zip`, size: 123, sha512: 'signed' }],
  }));
  assert.equal(verifyMirroredFeed(live, { expectedVersion: '0.2.1-rc.2.20261022.14', storageOrigin: STORAGE, layout: 'legacy' }).binaryUrl,
    `${STORAGE}/studio/0.2.1-rc.2.20261022.14/AgentKit-Studio-mac-arm64.zip`);
  const legacyBinary = Buffer.from(YAML.stringify({
    version: VERSION,
    files: [{ url: `${STORAGE}/dsh-desk/bin/mac-arm64/deepseek-harness-${VERSION}-mac-arm64.zip`, size: 9, sha512: 'signed' }],
  }));
  assert.equal(verifyMirroredFeed(legacyBinary, { expectedVersion: VERSION, storageOrigin: STORAGE, layout: 'legacy' }).size, 9);
  // A canonical studio feed must never point outside the versioned Studio storage.
  assert.throws(() => verifyMirroredFeed(legacyBinary, { expectedVersion: VERSION, storageOrigin: STORAGE, layout: 'studio' }),
    /outside the studio feed binary prefixes/);
  assert.throws(() => verifyMirroredFeed(feedBytes(), { expectedVersion: VERSION, storageOrigin: 'https://elsewhere.example.com', layout: 'legacy' }),
    /escapes the release storage/);
  // Callers may narrow the accepted prefix set explicitly.
  assert.throws(() => verifyMirroredFeed(legacyBinary, { expectedVersion: VERSION, storageOrigin: STORAGE, layout: 'legacy', allowedBinaryPrefixes: ['/studio/'] }),
    /inside|outside/);
  assert.throws(() => verifyMirroredFeed(feedBytes(), { expectedVersion: VERSION, storageOrigin: STORAGE, allowedBinaryPrefixes: [] }),
    /absolute path prefixes/);
});

test('compatibility object keys are accepted by the KS3 release store without network access', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'studio-compat-keys-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'feed.yml');
  await writeFile(path, feedBytes());
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    requests.push({ method: init.method ?? 'GET', key: new URL(url).pathname.slice(1) });
    return new Response(null, { status: 200 });
  };
  const accepted = [];
  for (const target of ['mac-arm64', 'win-x64']) {
    for (const mirror of compatMirrorPlan({ version: VERSION, sourceChannel: 'nightly', target }).mirrors) {
      const result = await uploadKs3ReleaseArtifact({ origin: STORAGE, bucket: 'agentkit', accessKey: 'test-access', secretKey: 'test-secret',
        objectKey: mirror.objectKey, path, contentType: mirror.contentType, fetchImpl });
      accepted.push(result.objectKey);
    }
  }
  assert.deepEqual(accepted, [
    'studio/feeds/mac-arm64/preview-mac.yml',
    'dsh-desk/feeds/mac-arm64/preview-mac.yml',
    'studio/feeds/win-x64/preview.yml',
    'dsh-desk/feeds/win-x64/preview.yml',
  ]);
  assert.deepEqual(requests.map(request => request.method), ['PUT', 'PUT', 'PUT', 'PUT'], 'feed objects are replaced, not reconciled as binaries');
  await assert.rejects(uploadKs3ReleaseArtifact({ origin: STORAGE, bucket: 'agentkit', accessKey: 'test-access', secretKey: 'test-secret',
    objectKey: 'studio/feeds/mac-arm64/beta-mac.yml', path, contentType: 'application/yaml', fetchImpl }), /invalid KS3 release object key/);
});

async function windowsFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'studio-compat-win-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const version = VERSION, channel = 'nightly', name = `deepseek-harness-${version}-win-x64.exe`;
  const bytes = Buffer.from('signed installer bytes'), sha512 = createHash('sha512').update(bytes).digest('base64');
  const metadata = { version, path: name, sha512, files: [{ url: name, size: bytes.length, sha512 }] };
  await writeFile(join(root, name), bytes);
  await writeFile(join(root, `${name}.blockmap`), 'signed blockmap');
  await writeFile(join(root, `${channel}.yml`), YAML.stringify(metadata));
  const proof = join(root, 'windows-install.json');
  await writeFile(proof, JSON.stringify({ version, installer: name, installerSha256: createHash('sha256').update(bytes).digest('hex'),
    installerSigned: true, timestamped: true, installed: true, appSigned: true, uiVerified: true }));
  const objects = new Map(), uploads = [], origin = STORAGE;
  const fetchImpl = async (url, init = {}) => {
    const key = new URL(url).pathname.slice(1), body = objects.get(key);
    if (!body) return new Response(null, { status: 404 });
    if (init.method === 'HEAD') return new Response(null, { headers: { 'content-length': String(body.length) } });
    if (init.headers?.Range) return new Response(body.subarray(0, 1), { status: 206, headers: { 'accept-ranges': 'bytes', 'content-range': `bytes 0-0/${body.length}` } });
    return new Response(body);
  };
  const upload = async ({ objectKey, path }) => { uploads.push(objectKey); objects.set(objectKey, await readFile(path)); };
  const options = { candidate: root, proof, version, source: 'a'.repeat(40), previous: 'absent', origin, channel,
    environment: { STUDIO_DOWNLOAD_PROD_KS3_BUCKET: 'agentkit', STUDIO_DOWNLOAD_PROD_KS3_ACCESS_KEY: 'test-access', STUDIO_DOWNLOAD_PROD_KS3_SECRET_KEY: 'test-secret' },
    fetchImpl, upload };
  return { objects, uploads, options };
}

test('a nightly Windows publication mirrors the same bytes onto both preview feed layouts', async t => {
  const fixture = await windowsFixture(t);
  const result = await publishWindowsCandidate(fixture.options);
  assert.deepEqual(result.compatMirrors.map(({ targetChannel, targetLayout, objectKey, status, feedUrl }) =>
    [targetChannel, targetLayout, objectKey, status, feedUrl]), [
    ['preview', 'studio', 'studio/feeds/win-x64/preview.yml', 'updated', `${STORAGE}/studio/feeds/win-x64/preview.yml`],
    ['preview', 'legacy', 'dsh-desk/feeds/win-x64/preview.yml', 'updated', `${STORAGE}/dsh-desk/feeds/win-x64/preview.yml`],
  ]);
  const canonical = fixture.objects.get('studio/feeds/win-x64/nightly.yml');
  for (const key of ['studio/feeds/win-x64/preview.yml', 'dsh-desk/feeds/win-x64/preview.yml']) {
    assert.deepEqual(fixture.objects.get(key), canonical, `${key} carries the exact published feed bytes`);
  }
  assert.equal(YAML.parse(canonical.toString()).version, VERSION);
  const compatUploads = fixture.uploads.filter(key => key.includes('preview.yml'));
  assert.deepEqual(compatUploads, ['studio/feeds/win-x64/preview.yml', 'dsh-desk/feeds/win-x64/preview.yml']);

  // Re-publishing the same version must not fail nor duplicate mirror evidence.
  fixture.uploads.length = 0;
  const repeated = await publishWindowsCandidate(fixture.options);
  assert.deepEqual(repeated.compatMirrors.map(({ status, uploaded }) => [status, uploaded.length]), [['unchanged', 0], ['unchanged', 0]]);
  assert.deepEqual(fixture.uploads.filter(key => key.includes('preview.yml')), []);
});

test('a Windows publication refuses a prerelease on the latest lane before uploading', async t => {
  const fixture = await windowsFixture(t);
  await assert.rejects(publishWindowsCandidate({ ...fixture.options, channel: 'latest' }), /requires a stable three-segment version/);
  assert.equal(fixture.uploads.length, 0);
  await assert.rejects(publishWindowsCandidate({ ...fixture.options, channel: 'beta' }), /channel must be one of nightly, latest, preview, stable/);
  assert.equal(fixture.uploads.length, 0);
});
