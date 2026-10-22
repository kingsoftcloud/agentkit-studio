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

const STUDIO_ROOT = resolve(new URL('..', import.meta.url).pathname)
const TARGET = 'mac-arm64'
const CHANNELS = new Set(['stable', 'preview'])

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

function channel(value) {
  const selected = required(value, '--channel')
  if (!CHANNELS.has(selected)) throw new Error('--channel must be stable or preview')
  return selected
}

function targetPrefix(originValue, layout) { return `${originValue}/${layout === 'studio' ? 'studio' : 'dsh-desk'}/feeds/${TARGET}/` }

async function sha512File(path) {
  const hash = createHash('sha512')
  let size = 0
  for await (const bytes of createReadStream(path)) { hash.update(bytes); size += bytes.length }
  return { size, sha512: hash.digest('base64') }
}

async function readCandidate(directory, selectedChannel) {
  const root = resolve(required(directory, '--candidate'))
  const entries = await (await import('node:fs/promises')).readdir(root)
  const metadataPath = join(root, `${selectedChannel}-mac.yml`)
  const releasePath = join(root, 'mac-arm64-release.json')
  const metadata = YAML.parse(await readFile(metadataPath, 'utf8'))
  const release = JSON.parse(await readFile(releasePath, 'utf8'))
  if (!metadata || typeof metadata !== 'object' || typeof metadata.version !== 'string') throw new Error('candidate metadata is invalid')
  if (release.version !== metadata.version || release.target !== TARGET) throw new Error('candidate release record does not match metadata')
  const file = metadata.files?.[0]
  const zipName = typeof file?.url === 'string' ? basename(file.url) : ''
  const expectedBase = `deepseek-harness-${metadata.version}-mac-arm64`
  if (zipName !== `${expectedBase}.zip`) throw new Error('candidate metadata does not name the expected ZIP')
  const names = [`${expectedBase}.dmg`, `${expectedBase}.zip`, `${expectedBase}.zip.blockmap`, `${selectedChannel}-mac.yml`, 'mac-arm64-release.json']
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

async function verifyFeed({ feedOrigin, selectedChannel, expectedVersion, expectedPreviousVersion, output, allowLoopback, layout = 'legacy', storageOrigin = feedOrigin }) {
  const feedRoot = targetPrefix(feedOrigin, layout)
  const feedUrl = `${feedRoot}${selectedChannel}-mac.yml`
  const { response, bytes } = await fetchBytes(feedUrl)
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

async function publish({ candidate, feedOrigin, selectedChannel, expectedPreviousVersion, layout, storageOrigin, mode, compatibilityOrigin }) {
  const credentialsFor = selectedOrigin => resolveKs3OriginCredentials(process.env, selectedOrigin)
  const previous = expectedPreviousVersion === undefined ? undefined
    : await verifyFeed({ feedOrigin, storageOrigin, layout, selectedChannel, expectedVersion: expectedPreviousVersion, output: join(candidate.root, '.prepublish'), allowLoopback: false })
  const output = join(candidate.root, '.desktop-release')
  await mkdir(output, { recursive: true })
  const publishedFeed = join(output, `${selectedChannel}-mac.yml`)
  const plan = layout === 'studio' ? studioDesktopPublication(candidate.metadata, { origin: storageOrigin, channel: selectedChannel, mode }) : undefined
  await writeFile(publishedFeed, YAML.stringify(plan?.metadata || publishedDesktopMetadata(candidate.metadata, candidate.metadata.version)), { mode: 0o600 })
  const uploads = desktopReleaseUploads({ expectedBase: candidate.expectedBase, plan, selectedChannel, target: TARGET, storageOrigin, feedOrigin, compatibilityOrigin })
  const uploaded = []
  for (const [filename, objectKey, contentType, uploadOrigin] of uploads) {
    console.log(`uploading ${objectKey}`)
    uploaded.push({ origin: uploadOrigin, ...await uploadKs3ReleaseArtifact({ ...credentialsFor(uploadOrigin), origin: uploadOrigin, objectKey,
      path: filename === `${selectedChannel}-mac.yml` ? publishedFeed : join(candidate.root, filename), contentType,
      onProgress: progress => console.log(`uploaded ${progress.objectKey}: ${progress.completedParts}/${progress.totalParts} parts (${progress.completedBytes}/${progress.size} bytes)`) }) })
  }
  const evidence = await verifyFeed({ feedOrigin, storageOrigin, layout, selectedChannel, expectedVersion: candidate.metadata.version,
    expectedPreviousVersion, output: join(candidate.root, '.desktop-release'), allowLoopback: false })
  const report = { ...evidence, previous: previous?.version, release: candidate.release, storage: 'ks3', uploaded }
  await writeFile(join(output, 'publication.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
  return report
}

function usage() {
  console.error('usage: desktop-release.mjs verify-feed --origin <https-origin> --channel <stable|preview> --version <version> [--output dir] [--allow-loopback]\n'
    + '       desktop-release.mjs publish --candidate dir --origin <https-origin> --channel <stable|preview> [--expected-previous-version version]')
}

const { positionals, values } = parseArgs({ allowPositionals: true, options: {
  origin: { type: 'string' }, channel: { type: 'string' }, version: { type: 'string' }, candidate: { type: 'string' }, output: { type: 'string' },
  'allow-loopback': { type: 'boolean' }, 'expected-previous-version': { type: 'string' }, 'dsh-root': { type: 'string' }, patches: { type: 'string' },
  'dsh-commit': { type: 'string' }, 'dsh-version': { type: 'string' },
  'storage-origin': { type: 'string' }, layout: { type: 'string' }, 'update-mode': { type: 'string' },
  'compatibility-origin': { type: 'string' },
} })
const command = positionals[0]
if (!['verify-feed', 'publish'].includes(command)) { usage(); process.exitCode = 2 }
else {
  try {
    const feedOrigin = origin(values.origin, values['allow-loopback'] === true)
    const selectedChannel = channel(values.channel)
    const layout = values.layout || 'studio', mode = values['update-mode'] || 'incremental'
    if (!['legacy', 'studio'].includes(layout) || !['incremental', 'full'].includes(mode) || layout === 'legacy' && mode !== 'incremental') throw new Error('unsupported publication layout or update mode')
    const storageOrigin = values['storage-origin'] ? origin(values['storage-origin'], values['allow-loopback'] === true) : feedOrigin
    if (layout === 'legacy' && storageOrigin !== feedOrigin) throw new Error('separate storage origin requires the Studio layout')
    const compatibilityOrigin = values['compatibility-origin'] ? origin(values['compatibility-origin']) : undefined
    if (command === 'verify-feed') {
      const expectedVersion = required(values.version, '--version')
      await verifyFeed({ feedOrigin, storageOrigin, layout, selectedChannel, expectedVersion, output: values.output ?? join(STUDIO_ROOT, '.artifacts', 'desktop-release'), allowLoopback: values['allow-loopback'] === true })
    } else {
      const candidate = await readCandidate(values.candidate, selectedChannel)
      const result = await publish({ candidate, feedOrigin, storageOrigin, layout, mode, compatibilityOrigin, selectedChannel, expectedPreviousVersion: values['expected-previous-version'] })
      console.log(JSON.stringify(result, null, 2))
    }
  } catch (error) {
    console.error(`desktop release failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
