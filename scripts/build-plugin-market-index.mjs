#!/usr/bin/env node
/**
 * Build and check the bundled plugin market index (format 1) for the DSH plugin market.
 *
 * Generation reads `assets/plugin-market/sources.txt`, downloads each package's npm packument, and writes
 * `assets/plugin-market/index.json`. `--check` validates the committed index without touching the network.
 * Output is deterministic: plugins sort by monthly downloads (descending) then name, and no field carries a
 * generation timestamp.
 *
 * Usage:
 *   node scripts/build-plugin-market-index.mjs
 *   node scripts/build-plugin-market-index.mjs --check
 *
 * @see assets/plugin-market/README.md
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'

/** Repository root; this script lives in `scripts/`. */
const repositoryRoot = dirname(import.meta.dirname)
const assetDirectory = join(repositoryRoot, 'assets', 'plugin-market')
const sourcesPath = join(assetDirectory, 'sources.txt')
const indexPath = join(assetDirectory, 'index.json')

/** Registry API; the only network host generation contacts. */
const registryUrl = 'https://registry.npmjs.org'
const searchUrl = `${registryUrl}/-/v1/search?text=keywords:dsh-plugin&size=250`
const searchPageSize = 250
const sourceLimit = 80
const versionLimit = 20
const concurrencyLimit = 6
const requestTimeoutMs = 20_000
const maxPublishTimestamp = 1e11
const descriptionLimit = 400
const authorLimit = 60
const keywordLimit = 8
const keywordLengthLimit = 24
const packageNameLimit = 214

const indexTitle = { en: 'DSH Community Plugins', zh: 'DSH 社区插件' }
const indexDescription = { en: 'Popular community plugins for DeepSeek Harness', zh: '社区最受欢迎的 DeepSeek Harness 插件' }
const downloadsSortKey = { title: { en: 'Downloads', zh: '下载量' }, order: 'desc' }

/** Comment header written when `sources.txt` is created; blank and `#` lines are ignored when read. */
const sourcesHeader = [
  '# DSH community plugin packages, one npm package name per line.',
  '# Blank lines and lines starting with # are ignored.',
  '# Delete this file and rerun the generator to rebuild the list from the npm search ranking:',
  '#   node scripts/build-plugin-market-index.mjs',
  '',
].join('\n')

/** An npm package name, as accepted by the market index validator. */
const packageNamePattern = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u
const languageIdPattern = /^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/u
const commitPattern = /^[0-9a-f]{40}$/u
const numericIdentifier = '(?:0|[1-9]\\d*)'
const prereleaseIdentifier = `(?:${numericIdentifier}|\\d*[a-zA-Z-][0-9a-zA-Z-]*)`
const buildIdentifier = '[0-9a-zA-Z-]+'
/** SemVer 2.0.0 grammar for one exact version; kept in sync with `@deepseek-ai/dsh-plugin-market-index`. */
const semverPattern = new RegExp(
  `^${numericIdentifier}\\.${numericIdentifier}\\.${numericIdentifier}(?:-${prereleaseIdentifier}(?:\\.${prereleaseIdentifier})*)?(?:\\+${buildIdentifier}(?:\\.${buildIdentifier})*)?$`, 'u',
)
const semverParts = /^(\d+)\.(\d+)\.(\d+)(?:-(.*?))?(?:\+(.*))?$/u
const xRangeIdentifier = '(?:0|[1-9]\\d*|x|X|\\*)'
/** One partial version: `1`, `1.2`, `1.2.3`, `1.x`, `*`, with optional prerelease and build metadata. */
const rangeVersionPattern = new RegExp(
  `^[v=]?${xRangeIdentifier}(?:\\.${xRangeIdentifier}(?:\\.${xRangeIdentifier}(?:-${prereleaseIdentifier}(?:\\.${prereleaseIdentifier})*)?(?:\\+${buildIdentifier}(?:\\.${buildIdentifier})*)?)?)?$`, 'u',
)
const comparatorOperatorPattern = /^(?:~>|[<>]=?|[=~^])?/u
const operatorSpacingPattern = /(<=|>=|~>|<|>|=|~|\^)\s+/gu
const hyphenRangePattern = /^(.*?)\s+-\s+(.*)$/u

/** A package that cannot be listed; generation warns about it and continues. */
class PackageSkipped extends Error {}

function warn(message) {
  console.warn(`warning: ${message}`)
}

function displayPath(absolutePath) {
  return relative(repositoryRoot, absolutePath)
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPackageName(value) {
  return typeof value === 'string' && value.length <= packageNameLimit && packageNamePattern.test(value)
}

/** Code-unit order, so the output never depends on the host locale. */
function compareText(left, right) {
  if (left === right) return 0
  return left < right ? -1 : 1
}

function isNumericIdentifier(value) {
  return /^\d+$/u.test(value)
}

function versionParts(version) {
  const match = semverParts.exec(version)
  if (match === null) throw new Error(`not a SemVer version: ${version}`)
  return {
    numbers: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  }
}

/**
 * Compare two exact SemVer versions by precedence; build metadata is ignored.
 * @param left - an exact version accepted by {@link semverPattern}.
 * @param right - an exact version accepted by {@link semverPattern}.
 * @returns a negative, zero, or positive number when `left` precedes, equals, or follows `right`.
 */
function compareSemver(left, right) {
  const leftParts = versionParts(left)
  const rightParts = versionParts(right)
  for (let index = 0; index < 3; index += 1) {
    if (leftParts.numbers[index] !== rightParts.numbers[index]) return leftParts.numbers[index] - rightParts.numbers[index]
  }
  if (leftParts.prerelease.length === 0 && rightParts.prerelease.length === 0) return 0
  if (leftParts.prerelease.length === 0) return 1
  if (rightParts.prerelease.length === 0) return -1
  const length = Math.max(leftParts.prerelease.length, rightParts.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = leftParts.prerelease[index]
    const rightIdentifier = rightParts.prerelease[index]
    if (leftIdentifier === undefined) return -1
    if (rightIdentifier === undefined) return 1
    if (leftIdentifier === rightIdentifier) continue
    const leftNumeric = isNumericIdentifier(leftIdentifier)
    const rightNumeric = isNumericIdentifier(rightIdentifier)
    if (leftNumeric && rightNumeric) return Number(leftIdentifier) - Number(rightIdentifier)
    if (leftNumeric) return -1
    if (rightNumeric) return 1
    return leftIdentifier < rightIdentifier ? -1 : 1
  }
  return 0
}

function isValidComparator(token) {
  const operator = comparatorOperatorPattern.exec(token)[0]
  const version = token.slice(operator.length).trim()
  return version !== '' && rangeVersionPattern.test(version)
}

function isValidRangeAlternative(alternative) {
  if (alternative === '') return true
  const hyphen = hyphenRangePattern.exec(alternative)
  if (hyphen !== null) return rangeVersionPattern.test(hyphen[1].trim()) && rangeVersionPattern.test(hyphen[2].trim())
  return alternative.split(/\s+/u).every(isValidComparator)
}

/**
 * Whether a `engines.dsh` value is a SemVer range the market index validator accepts.
 * Mirrors `semver.validRange(range) !== null` without the dependency; `workspace:` ranges are rejected.
 * @param range - the candidate range text.
 * @returns whether the text is a SemVer range.
 */
function isValidRange(range) {
  const text = range.trim()
  if (text === '' || text.startsWith('workspace:')) return false
  return text.split('||').every(alternative => isValidRangeAlternative(alternative.trim().replace(operatorSpacingPattern, '$1')))
}

/**
 * Collapse whitespace (including line breaks), trim, and truncate one display string.
 * @param value - the candidate text; non-strings yield `undefined`.
 * @param limit - maximum length of the returned text, in characters.
 * @returns the cleaned text, or `undefined` when nothing printable remains.
 */
function cleanText(value, limit) {
  if (typeof value !== 'string') return undefined
  const text = value.replace(/\s+/gu, ' ').trim()
  if (text === '') return undefined
  return text.length > limit ? text.slice(0, limit).trim() : text
}

function authorName(value) {
  if (typeof value === 'string') return cleanText(value, authorLimit)
  if (isRecord(value)) return cleanText(value.name, authorLimit)
  return undefined
}

/** Parse a candidate URL, accepting only credential-free https after dropping npm's `git+` prefix. */
function httpsUrl(value) {
  if (typeof value !== 'string') return undefined
  const text = value.trim().replace(/^git\+/u, '')
  if (text === '') return undefined
  let url
  try {
    url = new URL(text)
  } catch {
    return undefined
  }
  if (url.protocol !== 'https:') return undefined
  if (url.username !== '' || url.password !== '') return undefined
  return url
}

function homepageUrl(value) {
  return httpsUrl(value)?.href
}

function repositoryUrl(value) {
  const raw = typeof value === 'string' ? value : isRecord(value) ? value.url : undefined
  const url = httpsUrl(raw)
  if (url === undefined) return undefined
  url.search = ''
  url.hash = ''
  const path = url.pathname.replace(/\/+$/u, '').replace(/\.git$/u, '')
  url.pathname = path === '' ? '/' : path
  return url.href
}

function keywordsOf(value) {
  const source = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/\s+/u) : []
  const keywords = []
  for (const entry of source) {
    if (typeof entry !== 'string') continue
    const keyword = entry.trim().slice(0, keywordLengthLimit).trim()
    if (keyword === '' || keywords.includes(keyword)) continue
    keywords.push(keyword)
    if (keywords.length === keywordLimit) break
  }
  return keywords
}

function titleOf(display, packument, name) {
  for (const candidate of [display.displayName, packument.displayName]) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
  }
  return name
}

/**
 * Build the listed versions of one package: valid SemVer, published, not deprecated, not private, newest first.
 * @param packument - the full npm packument.
 * @returns at most {@link versionLimit} version entries.
 */
function buildVersions(packument) {
  const manifests = isRecord(packument.versions) ? packument.versions : {}
  const times = isRecord(packument.time) ? packument.time : {}
  const versions = []
  for (const [version, manifest] of Object.entries(manifests)) {
    if (!semverPattern.test(version) || !isRecord(manifest)) continue
    if (manifest.private === true) continue
    if (typeof manifest.deprecated === 'string' && manifest.deprecated.trim() !== '') continue
    const published = times[version]
    if (typeof published !== 'string') continue
    const publishTimestamp = Math.floor(Date.parse(published) / 1000)
    if (!Number.isInteger(publishTimestamp) || publishTimestamp < 0 || publishTimestamp >= maxPublishTimestamp) continue
    const dsh = isRecord(manifest.engines) ? manifest.engines.dsh : undefined
    versions.push({
      version,
      publishTimestamp,
      source: { type: 'npm' },
      engines: typeof dsh === 'string' && isValidRange(dsh) ? { dsh } : {},
    })
  }
  versions.sort((left, right) => compareSemver(right.version, left.version))
  return versions.slice(0, versionLimit)
}

/**
 * Build one plugin entry from its packument, using `dist-tags.latest` for display information.
 * @param packument - the full npm packument.
 * @param downloads - the package's monthly downloads from the npm search ranking.
 * @returns the plugin entry.
 * @throws {PackageSkipped} when the package publishes no listable version.
 */
function buildPlugin(packument, downloads) {
  const name = packument.name
  const versions = buildVersions(packument)
  if (versions.length === 0) throw new PackageSkipped('has no publishable version')
  const latestTag = isRecord(packument['dist-tags']) ? packument['dist-tags'].latest : undefined
  const latest = typeof latestTag === 'string' && isRecord(packument.versions) ? packument.versions[latestTag] : undefined
  const display = isRecord(latest) ? latest : packument
  const description = cleanText(display.description ?? packument.description, descriptionLimit)
  const author = authorName(display.author ?? packument.author)
  const homepage = homepageUrl(display.homepage ?? packument.homepage)
  const repository = repositoryUrl(display.repository ?? packument.repository)
  return {
    name,
    title: titleOf(display, packument, name),
    ...description === undefined ? {} : { description },
    ...author === undefined ? {} : { author },
    ...homepage === undefined ? {} : { homepage },
    ...repository === undefined ? {} : { repository: { url: repository } },
    metadata: { keywords: keywordsOf(display.keywords ?? packument.keywords), sortKeys: { downloads } },
    versions,
  }
}

function comparePlugins(left, right) {
  const difference = right.metadata.sortKeys.downloads - left.metadata.sortKeys.downloads
  return difference === 0 ? compareText(left.name, right.name) : difference
}

/**
 * Run `worker` over `items` with at most `limit` calls in flight.
 * @param items - the values to process.
 * @param limit - maximum concurrent invocations.
 * @param worker - the async operation for one item.
 * @returns results in input order.
 */
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length)
  let next = 0
  const run = async () => {
    while (next < items.length) {
      const index = next
      next += 1
      results[index] = await worker(items[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run))
  return results
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'dsh-plugin-market-index' },
    signal: AbortSignal.timeout(requestTimeoutMs),
  })
  if (!response.ok) throw new Error(`GET ${url} failed with HTTP ${response.status}`)
  return await response.json()
}

function describeError(error) {
  const cause = error?.cause
  if (cause instanceof Error && cause.message !== '') return `${error.message}: ${cause.message}`
  return error instanceof Error ? error.message : String(error)
}

/** Monthly downloads per package, from the npm search ranking that defines the community list. */
async function fetchSearchDownloads() {
  const payload = await fetchJson(searchUrl)
  const objects = Array.isArray(payload?.objects) ? payload.objects : []
  if (objects.length === 0) throw new Error(`npm search returned no packages: ${searchUrl}`)
  const downloads = new Map()
  for (const object of objects.slice(0, searchPageSize)) {
    const name = isRecord(object) && isRecord(object.package) ? object.package.name : undefined
    if (typeof name !== 'string' || downloads.has(name)) continue
    const monthly = isRecord(object.downloads) ? object.downloads.monthly : undefined
    downloads.set(name, typeof monthly === 'number' && Number.isFinite(monthly) ? Math.max(0, Math.trunc(monthly)) : 0)
  }
  return downloads
}

async function writeInitialSources(downloads) {
  const names = [...downloads.entries()]
    .filter(([name]) => isPackageName(name))
    .sort(([leftName, leftDownloads], [rightName, rightDownloads]) => rightDownloads - leftDownloads || compareText(leftName, rightName))
    .slice(0, sourceLimit)
    .map(([name]) => name)
  if (names.length === 0) throw new Error(`npm search returned no valid package names: ${searchUrl}`)
  await mkdir(assetDirectory, { recursive: true })
  const text = `${sourcesHeader}${names.join('\n')}\n`
  await writeFile(sourcesPath, text, 'utf8')
  console.log(`created ${displayPath(sourcesPath)} with ${names.length} packages from the npm search ranking`)
  return text
}

function parseSources(text) {
  const names = []
  const seen = new Set()
  for (const line of text.split(/\r?\n/u)) {
    const name = line.trim()
    if (name === '' || name.startsWith('#')) continue
    if (!isPackageName(name)) {
      warn(`${displayPath(sourcesPath)}: ignoring invalid package name ${JSON.stringify(name)}`)
      continue
    }
    if (seen.has(name)) continue
    seen.add(name)
    names.push(name)
  }
  return names
}

async function readSources() {
  const downloads = await fetchSearchDownloads()
  let text
  try {
    text = await readFile(sourcesPath, 'utf8')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    text = await writeInitialSources(downloads)
  }
  const names = parseSources(text)
  if (names.length === 0) throw new Error(`${displayPath(sourcesPath)} lists no npm package names`)
  return { names, downloads }
}

function validateLocalized(value, path, report, required) {
  if (value === undefined) {
    if (required) report(path, 'is required')
    return
  }
  if (typeof value === 'string') {
    if (value.trim() === '') report(path, 'must be a non-blank string')
    return
  }
  if (!isRecord(value)) {
    report(path, 'must be a string or a language-keyed object')
    return
  }
  if (!Object.hasOwn(value, 'en')) report(`${path}.en`, 'is required')
  for (const [language, text] of Object.entries(value)) {
    if (!languageIdPattern.test(language)) report(`${path}.${language}`, 'must be a lowercase language id')
    if (typeof text !== 'string' || text.trim() === '') report(`${path}.${language}`, 'must be a non-blank string')
  }
}

function validateHttpUrl(value, path, report) {
  if (typeof value !== 'string') {
    report(path, 'must be an absolute http(s) URL')
    return
  }
  let url
  try {
    url = new URL(value)
  } catch {
    report(path, 'must be an absolute http(s) URL')
    return
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') report(path, 'must use https: or http:')
  if (url.username !== '' || url.password !== '') report(path, 'must not contain credentials')
}

function validateRepository(value, path, report) {
  if (!isRecord(value)) {
    report(path, 'must be an object')
    return
  }
  validateHttpUrl(value.url, `${path}.url`, report)
  if (typeof value.url === 'string') {
    try {
      const url = new URL(value.url)
      if (url.search !== '' || url.hash !== '') report(`${path}.url`, 'must not contain a query or fragment')
    } catch {
      // Already reported by validateHttpUrl.
    }
  }
  if (value.directory !== undefined && (typeof value.directory !== 'string' || value.directory.trim() === '')) {
    report(`${path}.directory`, 'must be a non-blank string')
  }
}

function validatePluginMetadata(value, path, report) {
  if (!isRecord(value)) {
    report(path, 'must be an object')
    return
  }
  if (value.category !== undefined && (typeof value.category !== 'string' || value.category.trim() === '')) {
    report(`${path}.category`, 'must be a non-blank string')
  }
  if (!Array.isArray(value.keywords)) report(`${path}.keywords`, 'must be an array')
  else {
    value.keywords.forEach((keyword, index) => {
      if (typeof keyword !== 'string' || keyword.trim() === '') report(`${path}.keywords[${index}]`, 'must be a non-blank string')
    })
  }
  if (value.labels !== undefined) {
    if (!Array.isArray(value.labels)) report(`${path}.labels`, 'must be an array')
    else {
      value.labels.forEach((label, index) => {
        if (typeof label !== 'string' || label.trim() === '') report(`${path}.labels[${index}]`, 'must be a non-blank string')
      })
    }
  }
  if (!isRecord(value.sortKeys)) report(`${path}.sortKeys`, 'must be an object')
  else {
    for (const [key, sortValue] of Object.entries(value.sortKeys)) {
      if (typeof sortValue !== 'number' || !Number.isFinite(sortValue)) report(`${path}.sortKeys.${key}`, 'must be a finite number')
    }
  }
}

function validateSource(value, path, report) {
  if (!isRecord(value)) {
    report(path, 'must be an object')
    return
  }
  if (value.type === 'npm') {
    if (value.registry !== undefined) validateHttpUrl(value.registry, `${path}.registry`, report)
    return
  }
  if (value.type === 'git') {
    validateHttpUrl(value.url, `${path}.url`, report)
    if (typeof value.commit !== 'string' || !commitPattern.test(value.commit)) report(`${path}.commit`, 'must be a lowercase 40-hex-digit commit SHA')
    if (value.path !== undefined && (typeof value.path !== 'string' || value.path.trim() === '')) report(`${path}.path`, 'must be a non-blank string')
    return
  }
  report(`${path}.type`, 'must be "npm" or "git"')
}

function validateVersion(value, path, report, seen) {
  if (!isRecord(value)) {
    report(path, 'must be an object')
    return
  }
  if (typeof value.version !== 'string' || !semverPattern.test(value.version)) report(`${path}.version`, 'must be an exact SemVer version')
  else if (seen.has(value.version)) report(`${path}.version`, `duplicates ${value.version}`)
  else seen.add(value.version)
  const timestamp = value.publishTimestamp
  if (typeof timestamp !== 'number' || !Number.isInteger(timestamp) || timestamp < 0 || timestamp >= maxPublishTimestamp) {
    report(`${path}.publishTimestamp`, 'must be an integer number of Unix seconds in [0, 10^11)')
  }
  validateSource(value.source, `${path}.source`, report)
  if (value.engines !== undefined) {
    if (!isRecord(value.engines)) report(`${path}.engines`, 'must be an object')
    else if (value.engines.dsh !== undefined && (typeof value.engines.dsh !== 'string' || !isValidRange(value.engines.dsh))) {
      report(`${path}.engines.dsh`, 'must be a SemVer range')
    }
  }
}

function validatePlugin(value, path, report, names) {
  if (!isRecord(value)) {
    report(path, 'must be an object')
    return
  }
  if (!isPackageName(value.name)) report(`${path}.name`, 'must be a valid npm package name')
  else if (names.has(value.name)) report(`${path}.name`, `duplicates ${value.name}`)
  else names.add(value.name)
  if (value.title === undefined) report(`${path}.title`, 'is required')
  else validateLocalized(value.title, `${path}.title`, report, true)
  if (value.description !== undefined) validateLocalized(value.description, `${path}.description`, report, false)
  if (value.icon !== undefined && (typeof value.icon !== 'string' || value.icon.trim() === '')) report(`${path}.icon`, 'must be a non-blank string')
  if (value.author !== undefined && (typeof value.author !== 'string' || value.author.trim() === '')) report(`${path}.author`, 'must be a non-blank string')
  if (value.homepage !== undefined) validateHttpUrl(value.homepage, `${path}.homepage`, report)
  if (value.repository !== undefined) validateRepository(value.repository, `${path}.repository`, report)
  validatePluginMetadata(value.metadata, `${path}.metadata`, report)
  if (!Array.isArray(value.versions) || value.versions.length === 0) report(`${path}.versions`, 'must be a non-empty array')
  else {
    const seen = new Set()
    value.versions.forEach((version, index) => validateVersion(version, `${path}.versions[${index}]`, report, seen))
  }
}

/**
 * Check a parsed index against format 1, collecting every violation instead of stopping at the first.
 * @param value - the parsed JSON document.
 * @returns each violation as a JSON path and the violated rule; empty when the index is valid.
 */
function validateIndex(value) {
  if (!isRecord(value)) return [{ path: '$', reason: 'must be an object' }]
  const problems = []
  const report = (path, reason) => problems.push({ path, reason })
  if (value.format !== 1) report('$.format', 'must be 1')
  validateLocalized(value.title, '$.title', report, true)
  if (value.description !== undefined) validateLocalized(value.description, '$.description', report, false)
  if (!isRecord(value.metadata)) report('$.metadata', 'must be an object')
  else if (!isRecord(value.metadata.sortKeys)) report('$.metadata.sortKeys', 'must be an object')
  else if (!isRecord(value.metadata.sortKeys.downloads)) report('$.metadata.sortKeys.downloads', 'must declare the downloads sort key')
  else {
    validateLocalized(value.metadata.sortKeys.downloads.title, '$.metadata.sortKeys.downloads.title', report, true)
    if (value.metadata.sortKeys.downloads.order !== 'asc' && value.metadata.sortKeys.downloads.order !== 'desc') {
      report('$.metadata.sortKeys.downloads.order', 'must be "asc" or "desc"')
    }
  }
  if (!Array.isArray(value.plugins)) {
    report('$.plugins', 'must be an array')
    return problems
  }
  const names = new Set()
  value.plugins.forEach((plugin, position) => validatePlugin(plugin, `$.plugins[${position}]`, report, names))
  return problems
}

function reportProblems(problems) {
  for (const { path, reason } of problems) console.error(`  ${path} ${reason}`)
}

function formatCount(value) {
  return new Intl.NumberFormat('en-US').format(value)
}

async function generate() {
  const startedAt = performance.now()
  const { names, downloads } = await readSources()
  console.log(`building ${displayPath(indexPath)} from ${names.length} packages`)
  const results = await mapWithConcurrency(names, concurrencyLimit, async name => {
    if (!downloads.has(name)) warn(`${name}: no monthly downloads in the npm search ranking; using 0`)
    try {
      return buildPlugin(await fetchJson(`${registryUrl}/${encodeURIComponent(name)}`), downloads.get(name) ?? 0)
    } catch (error) {
      warn(`${name}: ${describeError(error)}`)
      return null
    }
  })
  const plugins = results.filter(plugin => plugin !== null)
  if (plugins.length === 0) throw new Error('no plugin could be built; see the warnings above')
  plugins.sort(comparePlugins)
  const index = {
    format: 1,
    title: indexTitle,
    description: indexDescription,
    metadata: { sortKeys: { downloads: downloadsSortKey } },
    plugins,
  }
  const text = `${JSON.stringify(index, null, 2)}\n`
  const problems = validateIndex(JSON.parse(text))
  if (problems.length > 0) {
    reportProblems(problems)
    throw new Error(`${displayPath(indexPath)} would violate format 1; the committed file was left untouched`)
  }
  await mkdir(assetDirectory, { recursive: true })
  await writeFile(indexPath, text, 'utf8')
  const versionCount = plugins.reduce((total, plugin) => total + plugin.versions.length, 0)
  console.log(`wrote ${displayPath(indexPath)}`)
  console.log(`  plugins: ${plugins.length}`)
  console.log(`  versions: ${versionCount}`)
  console.log(`  bytes: ${Buffer.byteLength(text)}`)
  console.log(`  duration: ${((performance.now() - startedAt) / 1000).toFixed(1)}s`)
  for (const plugin of plugins.slice(0, 3)) {
    console.log(`  top: ${plugin.name} (${formatCount(plugin.metadata.sortKeys.downloads)} downloads/month)`)
  }
}

async function check() {
  let text
  try {
    text = await readFile(indexPath, 'utf8')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    throw new Error(`${displayPath(indexPath)} is missing; run: node scripts/build-plugin-market-index.mjs`)
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`${displayPath(indexPath)} is not valid JSON: ${error.message}`)
  }
  const problems = validateIndex(parsed)
  if (problems.length > 0) {
    reportProblems(problems)
    throw new Error(`${displayPath(indexPath)} does not satisfy plugin market index format 1`)
  }
  const versionCount = parsed.plugins.reduce((total, plugin) => total + plugin.versions.length, 0)
  console.log(`plugin market index OK: ${displayPath(indexPath)} (${parsed.plugins.length} plugins, ${versionCount} versions, ${Buffer.byteLength(text)} bytes)`)
}

async function main() {
  const arguments_ = process.argv.slice(2)
  if (arguments_.includes('--check')) {
    const unknown = arguments_.filter(argument => argument !== '--check')
    if (unknown.length > 0) throw new Error(`unknown arguments: ${unknown.join(' ')}`)
    await check()
    return
  }
  if (arguments_.length > 0) throw new Error(`unknown arguments: ${arguments_.join(' ')}\nusage: node scripts/build-plugin-market-index.mjs [--check]`)
  await generate()
}

main().catch(error => {
  console.error(`error: ${describeError(error)}`)
  process.exitCode = 1
})
