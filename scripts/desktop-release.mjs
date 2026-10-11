/** Publish and qualify one signed AgentKit Studio macOS release.
 * The publish command delegates writes to the pinned DSH desktop-upload-plan.ts
 * and desktop-upload-run.ts through the official upload:mac:arm64 entrypoint.
 */
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { basename, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import YAML from 'yaml'
import { withDesktopCheckout } from './desktop-checkout.mjs'

const run = promisify(execFile)
const STUDIO_ROOT = resolve(new URL('..', import.meta.url).pathname)
const DSH_DEFAULT = resolve(STUDIO_ROOT, '../../deepseek-harness')
const DSH_COMMIT_DEFAULT = '639ed015397290b3745d163aafe02ffee4aa3f84'
const DSH_VERSION_DEFAULT = '0.2.0-rc.2'
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

function targetPrefix(originValue) { return `${originValue}/dsh-desk/feeds/${TARGET}/` }

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

async function verifyFeed({ feedOrigin, selectedChannel, expectedVersion, expectedPreviousVersion, output, allowLoopback }) {
  const feedRoot = targetPrefix(feedOrigin)
  const feedUrl = `${feedRoot}${selectedChannel}-mac.yml`
  const { response, bytes } = await fetchBytes(feedUrl)
  const feed = YAML.parse(bytes.toString('utf8'))
  if (feed?.version !== expectedVersion) throw new Error(`feed version ${String(feed?.version)} does not equal ${expectedVersion}`)
  if (expectedPreviousVersion !== undefined && feed.version === expectedPreviousVersion) throw new Error('feed did not advance to the expected release')
  const file = feed.files?.[0]
  const zipParsed = new URL(file?.url ?? '', feedRoot)
  const zipUrl = zipParsed.toString()
  if (zipParsed.origin !== feedOrigin || !zipParsed.pathname.startsWith('/dsh-desk/bin/mac-arm64/')
    || basename(zipParsed.pathname) !== `deepseek-harness-${expectedVersion}-mac-arm64.zip`) throw new Error('feed ZIP URL escapes the Studio binary target prefix')
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
  const evidence = { schemaVersion: 1, verifiedAt: new Date().toISOString(), origin: feedOrigin, feedUrl, channel: selectedChannel,
    version: feed.version, zipUrl, feedBytes: bytes.length, zipBytes: actual.size, zipSha512: actual.sha512,
    range: { status: range.status, contentRange: range.headers.get('content-range'), bytes: rangeBytes.length },
    publicUrl: feedRoot, allowLoopback }
  await mkdir(resolve(output), { recursive: true })
  const path = join(resolve(output), `feed-${selectedChannel}-${expectedVersion}.json`)
  await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600, flag: 'w' })
  console.log(`desktop feed verified: ${path}`)
  return evidence
}

async function publish({ candidate, dshRoot, patches, dshCommit, dshVersion, feedOrigin, selectedChannel, expectedPreviousVersion }) {
  const bucket = required(process.env.DOWNLOAD_PROD_COS_BUCKET, 'DOWNLOAD_PROD_COS_BUCKET')
  const secretId = required(process.env.DOWNLOAD_PROD_COS_SECRET_ID, 'DOWNLOAD_PROD_COS_SECRET_ID')
  const secretKey = required(process.env.DOWNLOAD_PROD_COS_SECRET_KEY, 'DOWNLOAD_PROD_COS_SECRET_KEY')
  const previous = expectedPreviousVersion === undefined ? undefined
    : await verifyFeed({ feedOrigin, selectedChannel, expectedVersion: expectedPreviousVersion, output: join(candidate.root, '.prepublish'), allowLoopback: false })
  const output = join(candidate.root, '.desktop-release')
  await withDesktopCheckout({ source: dshRoot, output, patches, commit: dshCommit }, async checkout => {
    const artifacts = join(checkout, 'apps/desktop/.desktop-build/targets/mac-arm64/artifacts')
    await mkdir(artifacts, { recursive: true })
    for (const name of [`${candidate.expectedBase}.dmg`, `${candidate.expectedBase}.zip`, `${candidate.expectedBase}.zip.blockmap`, `${selectedChannel}-mac.yml`, 'mac-arm64-release.json']) {
      await cp(join(candidate.root, name), join(artifacts, name))
    }
    const dotenv = join(checkout, 'apps/desktop/.env.macos')
    const contents = [
      'DSH_DESKTOP_AUTO_UPDATE_ENV=production', `DSH_DESKTOP_UPDATE_ORIGIN=${feedOrigin}`,
      `DSH_DESKTOP_UPDATE_CHANNEL=${selectedChannel}`, 'DSH_DESKTOP_APP_ID=com.kingsoftcloud.agentkit-studio',
      `DOWNLOAD_PROD_COS_BUCKET=${bucket}`, `DOWNLOAD_PROD_COS_SECRET_ID=${secretId}`, `DOWNLOAD_PROD_COS_SECRET_KEY=${secretKey}`,
    ].join('\n') + '\n'
    await writeFile(dotenv, contents, { mode: 0o600, flag: 'wx' })
    try {
      await run('pnpm', ['install', '--frozen-lockfile'], { cwd: checkout, maxBuffer: 16 * 1024 * 1024 })
      await run('pnpm', ['--dir', 'apps/desktop', 'run', 'upload:mac:arm64'], { cwd: checkout, maxBuffer: 16 * 1024 * 1024 })
    } finally { await rm(dotenv, { force: true }) }
  })
  const evidence = await verifyFeed({ feedOrigin, selectedChannel, expectedVersion: candidate.metadata.version,
    expectedPreviousVersion, output: join(candidate.root, '.desktop-release'), allowLoopback: false })
  return { ...evidence, previous: previous?.version, release: candidate.release }
}

function usage() {
  console.error('usage: desktop-release.mjs verify-feed --origin <https-origin> --channel <stable|preview> --version <version> [--output dir] [--allow-loopback]\n'
    + '       desktop-release.mjs publish --candidate dir --origin <https-origin> --channel <stable|preview> [--expected-previous-version version] [--dsh-root dir] [--patches dir] [--dsh-commit sha] [--dsh-version version]')
}

const { positionals, values } = parseArgs({ allowPositionals: true, options: {
  origin: { type: 'string' }, channel: { type: 'string' }, version: { type: 'string' }, candidate: { type: 'string' }, output: { type: 'string' },
  'allow-loopback': { type: 'boolean' }, 'expected-previous-version': { type: 'string' }, 'dsh-root': { type: 'string' }, patches: { type: 'string' },
  'dsh-commit': { type: 'string' }, 'dsh-version': { type: 'string' },
} })
const command = positionals[0]
if (!['verify-feed', 'publish'].includes(command)) { usage(); process.exitCode = 2 }
else {
  try {
    const feedOrigin = origin(values.origin, values['allow-loopback'] === true)
    const selectedChannel = channel(values.channel)
    if (command === 'verify-feed') {
      const expectedVersion = required(values.version, '--version')
      await verifyFeed({ feedOrigin, selectedChannel, expectedVersion, output: values.output ?? join(STUDIO_ROOT, '.artifacts', 'desktop-release'), allowLoopback: values['allow-loopback'] === true })
    } else {
      const candidate = await readCandidate(values.candidate, selectedChannel)
      const result = await publish({ candidate, dshRoot: resolve(values['dsh-root'] ?? DSH_DEFAULT), patches: resolve(values.patches ?? join(STUDIO_ROOT, 'patches/dsh-v0.2.0-rc.2')),
        dshCommit: values['dsh-commit'] ?? DSH_COMMIT_DEFAULT, dshVersion: values['dsh-version'] ?? DSH_VERSION_DEFAULT, feedOrigin, selectedChannel,
        expectedPreviousVersion: values['expected-previous-version'] })
      console.log(JSON.stringify(result, null, 2))
    }
  } catch (error) {
    console.error(`desktop release failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
