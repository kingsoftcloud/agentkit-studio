/** Publish and qualify one signed AgentKit Studio macOS release to KS3. */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import YAML from 'yaml'
import { resolveKs3OriginCredentials, uploadKs3ReleaseArtifact } from '../src/ks3-release-store.mjs'
import { publishedDesktopMetadata, studioDesktopPublication } from '../src/desktop-release-metadata.mjs'
import { desktopReleaseUploads } from '../src/desktop-release-uploads.mjs'
import { assertChannelSupportsVersion, assertReleaseChannel, channelMetadataFilename, COMPATIBILITY_RELEASE_CHANNELS, isNativeReleaseChannel, parseReleaseChannelList, RELEASE_CHANNELS } from '../src/desktop-release-channels.mjs'
import { assertFeedLayout, compatMirrorEvidence, compatMirrorIsCurrent, compatMirrorPlan, compatMirrorUploads, feedObjectKey, FEED_LAYOUTS, parseFeedLayoutList, verifyMirroredFeed } from '../src/desktop-release-feed.mjs'

const STUDIO_ROOT = resolve(new URL('..', import.meta.url).pathname)
const TARGET = 'mac-arm64'

function required(value, name) {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  if (!trimmed) throw new Error(`${name} is required`)
  return trimmed
}

function origin(value, allowLoopback = false) {
  const parsed = new URL(required(value, '--origin'))
  if (parsed.protocol !== 'https:') {
    if (!(allowLoopback && parsed.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(parsed.hostname))) {
      throw new Error('--origin must be an HTTPS origin')
    }
  }
  if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('--origin must be an origin without credentials, path, query, or fragment')
  }
  if (/example\.(?:com|org|net)$/iu.test(parsed.hostname)) throw new Error('--origin cannot use an example domain')
  return parsed.origin
}

function channel(value, name = '--channel') { return assertReleaseChannel(value, name) }

function feedPrefix(layout) { return `${layout === 'studio' ? 'studio' : 'dsh-desk'}/feeds/${TARGET}/` }
function targetPrefix(originValue, layout) { return `${originValue}/${feedPrefix(layout)}` }

async function sha512File(path) {
  const hash = createHash('sha512')
  let size = 0
  for await (const bytes of createReadStream(path)) { hash.update(bytes); size += bytes.length }
  return { size, sha512: hash.digest('base64') }
}

async function readCandidate(directory, selectedChannel) {
  const root = resolve(required(directory, '--candidate'))
  const entries = await (await import('node:fs/promises')).readdir(root)
  const metadataName = channelMetadataFilename(selectedChannel)
  const metadataPath = join(root, metadataName)
  const releasePath = join(root, 'mac-arm64-release.json')
  const metadata = YAML.parse(await readFile(metadataPath, 'utf8'))
  const release = JSON.parse(await readFile(releasePath, 'utf8'))
  if (!metadata || typeof metadata !== 'object' || typeof metadata.version !== 'string') throw new Error('candidate metadata is invalid')
  if (release.version !== metadata.version || release.target !== TARGET) throw new Error('candidate release record does not match metadata')
  // DSH 0.2.2-rc.1 writes the sealed channel into the release record. A candidate
  // built for another channel must not be relabeled by the publication command.
  if (release.channel !== undefined && release.channel !== selectedChannel) {
    throw new Error(`candidate release record was packaged for channel ${String(release.channel)}, not ${selectedChannel}`)
  }
  const file = metadata.files?.[0]
  const zipName = typeof file?.url === 'string' ? basename(file.url) : ''
  const expectedBase = `deepseek-harness-${metadata.version}-mac-arm64`
  if (zipName !== `${expectedBase}.zip`) throw new Error('candidate metadata does not name the expected ZIP')
  const names = [`${expectedBase}.dmg`, `${expectedBase}.zip`, `${expectedBase}.zip.blockmap`, metadataName, 'mac-arm64-release.json']
  for (const name of names) if (!entries.includes(name)) throw new Error(`candidate is missing ${name}`)
  const zip = join(root, `${expectedBase}.zip`)
  const integrity = await sha512File(zip)
  if (integrity.size !== file.size || integrity.sha512 !== file.sha512) throw new Error('candidate ZIP does not match its feed metadata')
  return { root, metadata, release, zip, zipName, expectedBase, metadataPath }
}

async function fetchBytes(url, options = {}) {
  const response = await fetch(url, { redirect: 'error', cache: 'no-store', ...options })
  if (!response.ok || !response.body) {
    await response.body?.cancel()
    throw new Error(`feed request failed: ${response.status} ${url}`)
  }
  return { response, bytes: Buffer.from(await response.arrayBuffer()) }
}

/** Read a feed that may legitimately not exist yet; undefined means "create it". */
async function readExistingFeed(url) {
  const response = await fetch(url, { redirect: 'error', cache: 'no-store' })
  if (response.status === 404) {
    await response.body?.cancel()
    return undefined
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel()
    throw new Error(`feed request failed: ${response.status} ${url}`)
  }
  return Buffer.from(await response.arrayBuffer())
}

async function digestResponse(response) {
  if (!response.ok || !response.body) {
    await response.body?.cancel()
    throw new Error(`feed request failed: ${response.status}`)
  }
  const hash = createHash('sha512')
  let size = 0
  const reader = response.body.getReader()
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      hash.update(next.value)
      size += next.value.byteLength
    }
  } finally { reader.releaseLock() }
  return { size, sha512: hash.digest('base64') }
}

async function verifyFeed({ feedOrigin, selectedChannel, expectedVersion, expectedPreviousVersion, output, allowLoopback, layout = 'legacy', storageOrigin = feedOrigin, captureFeedPath }) {
  const feedRoot = targetPrefix(feedOrigin, layout)
  const feedUrl = `${feedRoot}${channelMetadataFilename(selectedChannel)}`
  const { response, bytes } = await fetchBytes(feedUrl)
  // Rollback keeps the exact bytes that were live before a publication.
  if (captureFeedPath) await writeFile(captureFeedPath, bytes, { mode: 0o600, flag: 'w' })
  const feed = YAML.parse(bytes.toString('utf8'))
  if (feed?.version !== expectedVersion) throw new Error(`feed version ${String(feed?.version)} does not equal ${expectedVersion}`)
  if (expectedPreviousVersion !== undefined && feed.version === expectedPreviousVersion) throw new Error('feed did not advance to the expected release')
  const file = feed.files?.[0]
  const zipParsed = new URL(file?.url ?? '', feedRoot)
  const zipUrl = zipParsed.toString()
  const expectedPath = layout === 'studio'
    ? `/studio/${expectedVersion}/${feed.agentkitUpdateMode === 'full' ? 'full/' : ''}AgentKit-Studio-${TARGET}.zip`
    : `/dsh-desk/bin/${TARGET}/deepseek-harness-${expectedVersion}-${TARGET}.zip`
  if (zipParsed.origin !== storageOrigin || zipParsed.pathname !== expectedPath || zipParsed.search || zipParsed.hash) throw new Error('feed ZIP URL escapes the Studio binary target prefix')
  const head = await fetch(zipUrl, { method: 'HEAD', redirect: 'error', cache: 'no-store' })
  if (!head.ok) throw new Error(`feed ZIP HEAD failed: ${head.status}`)
  const size = Number(head.headers.get('content-length'))
  if (!Number.isSafeInteger(size) || size !== file.size) throw new Error('feed ZIP Content-Length does not match metadata')
  const range = await fetch(zipUrl, { headers: { Range: 'bytes=0-0' }, redirect: 'error', cache: 'no-store' })
  if (range.status !== 206 || range.headers.get('accept-ranges')?.toLowerCase() !== 'bytes') throw new Error('feed ZIP does not provide byte ranges')
  const rangeBytes = Buffer.from(await range.arrayBuffer())
  if (rangeBytes.length !== 1 || !/^bytes 0-0\//u.test(range.headers.get('content-range') ?? '')) throw new Error('feed ZIP range response is invalid')
  const downloaded = await fetch(zipUrl, { redirect: 'error', cache: 'no-store' })
  const actual = await digestResponse(downloaded)
  if (actual.size !== file.size || actual.sha512 !== file.sha512) throw new Error('public feed ZIP bytes do not match metadata')
  let fullBlockmapStatus
  if (layout === 'studio' && feed.agentkitUpdateMode === 'full') {
    const blockmap = await fetch(`${zipUrl}.blockmap`, { method: 'HEAD', redirect: 'error', cache: 'no-store' })
    fullBlockmapStatus = blockmap.status
    if (![403, 404].includes(blockmap.status)) throw new Error('full-only ZIP unexpectedly provides a blockmap')
  }
  const evidence = { schemaVersion: 1, verifiedAt: new Date().toISOString(), origin: feedOrigin, storageOrigin, layout, updateMode: feed.agentkitUpdateMode || 'incremental', feedUrl, channel: selectedChannel,
    version: feed.version, zipUrl, feedBytes: bytes.length, zipBytes: actual.size, zipSha512: actual.sha512,
    range: { status: range.status, contentRange: range.headers.get('content-range'), bytes: rangeBytes.length },
    publicUrl: feedRoot, allowLoopback, ...(fullBlockmapStatus ? { fullBlockmapStatus } : {}) }
  await mkdir(resolve(output), { recursive: true })
  const path = join(resolve(output), `feed-${selectedChannel}-${expectedVersion}.json`)
  await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600, flag: 'w' })
  console.log(`desktop feed verified: ${path}`)
  return evidence
}

/**
 * Copy one verified feed onto the compatibility channel objects for old installs.
 *
 * The bytes are published unchanged (same version, digest and absolute binary
 * URL); only the channel object name changes. Each target is read first, so a
 * repeated publication or mirror leaves an already-current object untouched and
 * records no duplicate upload evidence.
 */
async function mirrorCompatFeeds({ version, sourceChannel, sourceFeed, feedOrigin, storageOrigin, compatibilityOrigin, channels, layouts, output }) {
  const plan = compatMirrorPlan({ version, sourceChannel, target: TARGET, channels, layouts })
  if (plan.mirrors.length === 0) return []
  const origins = [...new Set([feedOrigin, storageOrigin, compatibilityOrigin].filter(Boolean))]
  const uploads = compatMirrorUploads(plan, { origins })
  const directory = resolve(output)
  await mkdir(directory, { recursive: true })
  const localPath = join(directory, `compat-${sourceChannel}-${version}-mac.yml`)
  await writeFile(localPath, sourceFeed, { mode: 0o600 })
  const mirrors = []
  for (const mirror of plan.mirrors) {
    // Validate the bytes against the target feed layout before copying: a
    // legacy dsh-desk feed may point at canonical studio binaries, while a
    // studio feed must stay inside the versioned Studio storage.
    verifyMirroredFeed(sourceFeed, { expectedVersion: version, storageOrigin, layout: mirror.targetLayout })
    const feedUrl = new URL(mirror.objectKey, feedOrigin).href
    const current = await readExistingFeed(feedUrl)
    let status = 'unchanged'
    const uploaded = []
    if (!compatMirrorIsCurrent(current, sourceFeed)) {
      status = 'updated'
      for (const upload of uploads.filter(candidate => candidate.objectKey === mirror.objectKey)) {
        uploaded.push({ origin: upload.origin, ...await uploadKs3ReleaseArtifact({ ...resolveKs3OriginCredentials(process.env, upload.origin), origin: upload.origin,
          objectKey: upload.objectKey, path: localPath, contentType: upload.contentType }) })
      }
      const published = await fetchBytes(feedUrl)
      if (!published.bytes.equals(sourceFeed)) throw new Error(`compat feed ${mirror.objectKey} does not match the published bytes`)
    }
    mirrors.push(compatMirrorEvidence({ mirror, feedUrl, bytes: sourceFeed, status, uploaded }))
    console.log(`compat feed ${status}: ${feedUrl}`)
  }
  return mirrors
}

async function publish({ candidate, feedOrigin, selectedChannel, expectedPreviousVersion, layout, storageOrigin, mode, compatibilityOrigin, compatEnabled, compatChannels, compatLayouts }) {
  // Fail before uploading anything: a prerelease feed on `latest` makes every
  // packaged client throw and stop checking for updates.
  assertChannelSupportsVersion(selectedChannel, candidate.metadata.version, 'candidate version')
  const credentialsFor = selectedOrigin => resolveKs3OriginCredentials(process.env, selectedOrigin)
  const output = join(candidate.root, '.desktop-release')
  await mkdir(output, { recursive: true })
  const previous = expectedPreviousVersion === undefined ? undefined
    : await verifyFeed({ feedOrigin, storageOrigin, layout, selectedChannel, expectedVersion: expectedPreviousVersion, output: join(candidate.root, '.prepublish'), allowLoopback: false,
      captureFeedPath: join(output, `previous-${selectedChannel}-mac.yml`) })
  const metadataName = channelMetadataFilename(selectedChannel)
  const publishedFeed = join(output, metadataName)
  const plan = layout === 'studio' ? studioDesktopPublication(candidate.metadata, { origin: storageOrigin, channel: selectedChannel, mode }) : undefined
  await writeFile(publishedFeed, YAML.stringify(plan?.metadata || publishedDesktopMetadata(candidate.metadata, candidate.metadata.version)), { mode: 0o600 })
  const uploads = desktopReleaseUploads({ expectedBase: candidate.expectedBase, plan, selectedChannel, target: TARGET, storageOrigin, feedOrigin, compatibilityOrigin })
  const uploaded = []
  for (const [filename, objectKey, contentType, uploadOrigin] of uploads) {
    console.log(`uploading ${objectKey}`)
    uploaded.push({ origin: uploadOrigin, ...await uploadKs3ReleaseArtifact({ ...credentialsFor(uploadOrigin), origin: uploadOrigin, objectKey,
      path: filename === metadataName ? publishedFeed : join(candidate.root, filename), contentType,
      onProgress: progress => console.log(`uploaded ${progress.objectKey}: ${progress.completedParts}/${progress.totalParts} parts (${progress.completedBytes}/${progress.size} bytes)`) }) })
  }
  const evidence = await verifyFeed({ feedOrigin, storageOrigin, layout, selectedChannel, expectedVersion: candidate.metadata.version,
    expectedPreviousVersion, output: join(candidate.root, '.desktop-release'), allowLoopback: false })
  let compatMirrors = []
  if (compatEnabled) {
    try {
      compatMirrors = await mirrorCompatFeeds({ version: candidate.metadata.version, sourceChannel: selectedChannel,
        sourceFeed: await readFile(publishedFeed), feedOrigin, storageOrigin, compatibilityOrigin,
        channels: compatChannels, layouts: compatLayouts, output })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const permissionHint = /403|forbidden|access ?denied|not authorized|permission/iu.test(message)
        ? ` The release credential appears unable to write the legacy dsh-desk/feeds prefix; retry with --compat-layouts ${layout}, or run 'mirror-feed --layout legacy' from a machine whose credential may write it.`
        : ''
      throw new Error(`canonical ${selectedChannel} feed is published, but the compatibility feed mirror failed: ${message}. `
        + `Re-run the mirror for the affected target layout with 'desktop-release.mjs mirror-feed' (see usage) or repeat publish with --no-compat-mirror.${permissionHint}`)
    }
  }
  const report = { ...evidence, previous: previous?.version, release: candidate.release, storage: 'ks3', uploaded, compatMirrors }
  await writeFile(join(output, 'publication.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
  return report
}

/** Copy one verified channel feed onto another channel object, byte for byte.
 *
 * A feed points at one immutable binary through an absolute URL, so mirroring
 * the metadata is how installed clients move to a new channel without
 * rebuilding or re-uploading the signed ZIP. The same command restores a saved
 * feed during a rollback and repairs a compatibility lane whose automatic
 * mirror did not finish.
 */
async function mirrorFeed({ feedOrigin, storageOrigin, layout, targetChannel, sourceChannel, sourceFile, expectedVersion, output }) {
  const target = assertReleaseChannel(targetChannel, 'target channel')
  const version = assertChannelSupportsVersion(target, required(expectedVersion, '--version'), 'mirror version')
  if (sourceChannel !== undefined) assertChannelSupportsVersion(assertReleaseChannel(sourceChannel, '--from-channel'), version, 'source feed version')
  const feedRoot = targetPrefix(feedOrigin, layout)
  let source
  let bytes
  if (sourceFile !== undefined) {
    source = resolve(required(sourceFile, '--from-file'))
    bytes = await readFile(source)
  } else {
    source = `${feedRoot}${channelMetadataFilename(sourceChannel)}`
    bytes = (await fetchBytes(source)).bytes
  }
  const feed = verifyMirroredFeed(bytes, { expectedVersion: version, storageOrigin, layout })
  const objectKey = feedObjectKey({ layout, channel: target, target: TARGET })
  const targetName = basename(objectKey)
  const directory = resolve(output)
  await mkdir(directory, { recursive: true })
  const localPath = join(directory, targetName)
  await writeFile(localPath, bytes, { mode: 0o600 })
  const uploaded = []
  for (const uploadOrigin of new Set([storageOrigin, feedOrigin])) {
    uploaded.push({ origin: uploadOrigin, ...await uploadKs3ReleaseArtifact({ ...resolveKs3OriginCredentials(process.env, uploadOrigin), origin: uploadOrigin,
      objectKey, path: localPath, contentType: 'application/yaml' }) })
  }
  const feedUrl = new URL(objectKey, feedOrigin).href
  const published = await fetchBytes(feedUrl)
  if (!published.bytes.equals(bytes)) throw new Error(`mirrored feed ${targetName} does not match the source bytes`)
  const evidence = { schemaVersion: 1, mirroredAt: new Date().toISOString(), origin: feedOrigin, storageOrigin, layout: assertFeedLayout(layout),
    targetChannel: target, sourceChannel: sourceFile === undefined ? sourceChannel : undefined, sourceFile: sourceFile === undefined ? undefined : source,
    version: feed.version, objectKey, feedUrl, feedBytes: bytes.length,
    feedSha512: createHash('sha512').update(bytes).digest('base64'), binaryUrl: feed.binaryUrl, uploaded }
  const path = join(directory, `mirror-${target}-${version}.json`)
  await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600, flag: 'w' })
  console.log(`desktop feed mirrored: ${path}`)
  return evidence
}

function usage() {
  console.error(`usage: desktop-release.mjs verify-feed --origin <https-origin> --channel <${RELEASE_CHANNELS.join('|')}> --version <version> [--output dir] [--allow-loopback]\n`
    + `       desktop-release.mjs publish --candidate dir --origin <https-origin> --channel <${RELEASE_CHANNELS.join('|')}> [--expected-previous-version version]\n`
    + `         [--compat-channels ${COMPATIBILITY_RELEASE_CHANNELS.join(',')}] [--compat-layouts ${FEED_LAYOUTS.join(',')}] [--no-compat-mirror]\n`
    + `       desktop-release.mjs mirror-feed --origin <https-origin> --channel <${RELEASE_CHANNELS.join('|')}> --version <version> (--from-channel <channel> | --from-file <path>) [--layout studio]`)
}

const { positionals, values } = parseArgs({ allowPositionals: true, options: {
  origin: { type: 'string' }, channel: { type: 'string' }, version: { type: 'string' }, candidate: { type: 'string' }, output: { type: 'string' },
  'allow-loopback': { type: 'boolean' }, 'expected-previous-version': { type: 'string' }, 'dsh-root': { type: 'string' }, patches: { type: 'string' },
  'dsh-commit': { type: 'string' }, 'dsh-version': { type: 'string' },
  'storage-origin': { type: 'string' }, layout: { type: 'string' }, 'update-mode': { type: 'string' },
  'compatibility-origin': { type: 'string' }, 'from-channel': { type: 'string' }, 'from-file': { type: 'string' },
  'compat-channels': { type: 'string' }, 'compat-layouts': { type: 'string' }, 'no-compat-mirror': { type: 'boolean' },
} })
const command = positionals[0]
if (!['verify-feed', 'publish', 'mirror-feed'].includes(command)) { usage(); process.exitCode = 2 }
else {
  try {
    const feedOrigin = origin(values.origin, values['allow-loopback'] === true)
    const selectedChannel = channel(values.channel)
    if (!isNativeReleaseChannel(selectedChannel)) {
      console.warn(`desktop release: ${selectedChannel} is a legacy channel; DSH 0.2.2-rc.1 only accepts nightly or latest in a packaged manifest`)
    }
    const layout = values.layout || 'studio', mode = values['update-mode'] || 'incremental'
    if (!['legacy', 'studio'].includes(layout) || !['incremental', 'full'].includes(mode) || layout === 'legacy' && mode !== 'incremental') throw new Error('unsupported publication layout or update mode')
    const storageOrigin = values['storage-origin'] ? origin(values['storage-origin'], values['allow-loopback'] === true) : feedOrigin
    if (layout === 'legacy' && storageOrigin !== feedOrigin) throw new Error('separate storage origin requires the Studio layout')
    const compatibilityOrigin = values['compatibility-origin'] ? origin(values['compatibility-origin']) : undefined
    const compatChannels = values['compat-channels'] === undefined
      ? [...COMPATIBILITY_RELEASE_CHANNELS]
      : parseReleaseChannelList(values['compat-channels'], '--compat-channels')
    // Default to the publication layout: the Studio release credential is scoped
    // to studio/*, so an automatic dsh-desk write would 403 and block the whole
    // publication. Operators whose credential covers dsh-desk/feeds opt in with
    // --compat-layouts studio,legacy (or run mirror-feed --layout legacy).
    const compatLayouts = values['compat-layouts'] === undefined
      ? [layout]
      : parseFeedLayoutList(values['compat-layouts'], '--compat-layouts')
    if (layout === 'legacy' && compatLayouts.includes('studio')) {
      throw new Error('--compat-layouts studio requires the Studio publication layout')
    }
    if (command === 'verify-feed') {
      // Verification and rollback must be able to describe a feed that is already
      // published; only publishing and copying enforce the lane/version pairing.
      const expectedVersion = required(values.version, '--version')
      await verifyFeed({ feedOrigin, storageOrigin, layout, selectedChannel, expectedVersion, output: values.output ?? join(STUDIO_ROOT, '.artifacts', 'desktop-release'), allowLoopback: values['allow-loopback'] === true })
    } else if (command === 'mirror-feed') {
      const expectedVersion = required(values.version, '--version')
      if ((values['from-channel'] === undefined) === (values['from-file'] === undefined)) throw new Error('mirror-feed requires exactly one of --from-channel or --from-file')
      const sourceChannel = values['from-channel'] === undefined ? undefined : channel(values['from-channel'], '--from-channel')
      const result = await mirrorFeed({ feedOrigin, storageOrigin, layout, targetChannel: selectedChannel, sourceChannel, sourceFile: values['from-file'],
        expectedVersion, output: values.output ?? join(STUDIO_ROOT, '.artifacts', 'desktop-release') })
      console.log(JSON.stringify(result, null, 2))
    } else {
      const candidate = await readCandidate(values.candidate, selectedChannel)
      const result = await publish({ candidate, feedOrigin, storageOrigin, layout, mode, compatibilityOrigin, selectedChannel,
        expectedPreviousVersion: values['expected-previous-version'], compatEnabled: values['no-compat-mirror'] !== true, compatChannels, compatLayouts })
      console.log(JSON.stringify(result, null, 2))
    }
  } catch (error) {
    console.error(`desktop release failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
