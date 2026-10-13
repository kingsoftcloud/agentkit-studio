/** Exercise a signed macOS app through the real Electron updater and retain evidence. */
import { execFile, spawn } from 'node:child_process'
import { mkdir, open, readFile, readdir, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import asar from '@electron/asar'
import { createHash } from 'node:crypto'
import { parseArgs } from 'node:util'
import { observeInstalledSuccessor } from './installed-update-successor.mjs'

const run = promisify(execFile)
const STUDIO_ROOT = resolve(new URL('..', import.meta.url).pathname)

function required(value, name) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) throw new Error(`${name} is required`)
  return text
}

async function plist(path, key) {
  return (await run('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', path])).stdout.trim()
}

async function appVersion(app) {
  const archive = join(app, 'Contents/Resources/app.asar')
  // Squirrel replaces this archive in place; do not reuse asar's cached header.
  asar.uncacheAll()
  const manifest = JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8'))
  const plugin = asar.extractFile(archive, 'dsh/node_modules/@kingsoftcloud/agentkit-studio/src/index.mjs')
  const productPrefix = '/dsh/node_modules/@kingsoftcloud/agentkit-studio/';
  const productHash = createHash('sha256');
  for (const name of asar.listPackage(archive).filter(name => name.startsWith(productPrefix)
    && /^(src\/.*\.(?:mjs|js)|dist\/client\.js|studio\.plugin\.json)$/.test(name.slice(productPrefix.length))).sort()) {
    productHash.update(name.slice(productPrefix.length)).update('\0').update(asar.extractFile(archive, name.slice(1)));
  }
  const version = await plist(join(app, 'Contents/Info.plist'), 'CFBundleShortVersionString')
  if (version !== manifest.version) throw new Error('bundle and archived package versions differ')
  return { version, commit: manifest.dshBuildCommit, studioEntrySha256: createHash('sha256').update(plugin).digest('hex'), studioSourceSha256: productHash.digest('hex') }
}

async function mountDmg(dmg, directory) {
  await mkdir(directory, { recursive: true })
  await run('/usr/bin/hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', directory, resolve(dmg)])
  try {
    const result = await run('/usr/bin/find', [directory, '-maxdepth', '2', '-name', '*.app', '-type', 'd'])
    const app = result.stdout.split('\n').map(value => value.trim()).find(Boolean)
    if (!app) throw new Error('DMG has no application bundle')
    return app
  } catch (error) {
    await run('/usr/bin/hdiutil', ['detach', directory, '-force']).catch(() => undefined)
    throw error
  }
}

async function waitForVersion(app, version, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    try {
      last = await appVersion(app)
      if (last.version === version) return last
    } catch { /* updater may be replacing the bundle */ }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 1000))
  }
  throw new Error(`installed app did not reach ${version}; last observed ${last?.version ?? 'unknown'}`)
}

async function main() {
  if (process.platform !== 'darwin') throw new Error('real macOS installed-update qualification requires macOS')
  const { values } = parseArgs({ options: {
    app: { type: 'string' }, 'data-home': { type: 'string' }, 'require-differential': { type: 'boolean' },
    dmg: { type: 'string' }, origin: { type: 'string' }, channel: { type: 'string' }, version: { type: 'string' },
    'expected-commit': { type: 'string' }, evidence: { type: 'string' }, timeout: { type: 'string' },
    'expected-studio-sha256': { type: 'string' }, 'retain-file': { type: 'string', multiple: true },
    'successor-observation': { type: 'string' },
  } })
  const dmg = values.app ? undefined : required(values.dmg, '--dmg')
  const feedOrigin = required(values.origin, '--origin')
  const selectedChannel = required(values.channel, '--channel')
  const targetVersion = required(values.version, '--version')
  const timeoutMs = Number(values.timeout ?? '300000')
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 30_000 || timeoutMs > 900_000) throw new Error('--timeout must be 30000..900000')
  const evidenceRoot = resolve(values.evidence ?? join(STUDIO_ROOT, '.artifacts', 'desktop-release', `installed-${Date.now()}`))
  await mkdir(evidenceRoot, { recursive: true, mode: 0o700 })
  const root = await (await import('node:fs/promises')).mkdtemp(join(tmpdir(), 'agentkit-studio-installed-'))
  const mount = join(root, 'mount')
  const install = values.app ? resolve(values.app) : join(root, 'AgentKit Studio.app')
  const userData = join(root, 'user-data')
  const harnessHome = values['data-home'] ? resolve(values['data-home']) : join(root, 'dsh-home')
  const journals = join(evidenceRoot, 'journals')
  await mkdir(userData, { recursive: true }); await mkdir(harnessHome, { recursive: true }); await mkdir(journals, { recursive: true })
  const markerPath = join(harnessHome, `p1-1-marker-${process.pid}.txt`)
  await writeFile(markerPath, 'retained across update\n', { mode: 0o600 })
  await run(process.execPath, [join(STUDIO_ROOT, 'scripts/desktop-release.mjs'), 'verify-feed', '--origin', feedOrigin,
    '--channel', selectedChannel, '--version', targetVersion, '--output', evidenceRoot])
  const mounted = values.app ? install : await mountDmg(dmg, mount)
  const appName = await plist(join(mounted, 'Contents/Info.plist'), 'CFBundleName')
  const appId = await plist(join(mounted, 'Contents/Info.plist'), 'CFBundleIdentifier')
  if (appId !== 'com.kingsoftcloud.agentkit-studio') throw new Error(`unexpected App ID ${appId}`)
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', mounted])
  await run('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=4', mounted])
  if (!values.app) {
    await run('/usr/bin/ditto', [mounted, install])
    await run('/usr/bin/hdiutil', ['detach', mount, '-force'])
  }
  const before = await appVersion(install)
  const retention = await Promise.all((values['retain-file'] || []).map(async path => {
    const bytes = await readFile(resolve(path));
    return { path: resolve(path), bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
  }));
  if (before.version === targetVersion) throw new Error(`baseline app is already ${targetVersion}; qualification requires a strictly newer feed version`)
  const executable = join(install, 'Contents/MacOS', await plist(join(install, 'Contents/Info.plist'), 'CFBundleExecutable'))
  const logPath = join(evidenceRoot, 'electron.log')
  const log = await open(logPath, 'a', 0o600)
  const args = values.app ? [] : ['--user-data-dir', userData]
  const child = spawn(executable, args, { env: { ...process.env, DSH_HOME: harnessHome, DSH_DESKTOP_UPDATE_JOURNAL_DIR: journals }, stdio: ['ignore', log.fd, log.fd], detached: true })
  await writeFile(join(evidenceRoot, 'run.json'), JSON.stringify({ root, install, pid: child.pid, before, targetVersion, markerPath, journals, logPath }, null, 2))
  console.log(`Real app launched at ${install}; use its visible update controls to download and restart. Evidence: ${evidenceRoot}`)
  child.unref()
  try {
    const after = await waitForVersion(install, targetVersion, timeoutMs)
    const installedAt = Date.now()
    const restartDeadline = Date.now() + 90_000
    let restarted = false
    let successorReadiness
    while (Date.now() < restartDeadline) {
      const entries = (await readdir(journals)).filter(name => name.endsWith('.jsonl'))
      for (const name of entries) {
        const events = (await readFile(join(journals, name), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
        if (events.some(event => event.version === targetVersion && event.event === 'workspace-ready')) restarted = true
      }
      if (restarted) { successorReadiness = { kind: 'successor-workspace-journal' }; break }
      successorReadiness = await observeInstalledSuccessor({ file: values['successor-observation'] || join(evidenceRoot, 'successor-ui.json'), install, originalPid: child.pid, installedAt })
      if (successorReadiness) { restarted = true; break }
      await new Promise(done => setTimeout(done, 1000))
    }
    if (!restarted) throw new Error('updated version did not restart and reach workspace-ready')
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', install])
    await run('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=4', install])
    const marker = await readFile(markerPath, 'utf8')
    if (marker !== 'retained across update\n') throw new Error('DSH_HOME marker was not retained')
    if (values['expected-commit'] !== undefined && after.commit !== values['expected-commit']) throw new Error(`updated app commit ${after.commit ?? 'unknown'} does not match expected rollback commit`)
    if (values['expected-studio-sha256'] && after.studioSourceSha256 !== values['expected-studio-sha256']) throw new Error('installed Studio sources do not match the signed target')
    const retainedFiles = [];
    for (const original of retention) {
      const current = await readFile(original.path);
      if (!current.subarray(0, original.bytes.length).equals(original.bytes)) throw new Error(`persisted data changed or disappeared: ${original.path}`);
      retainedFiles.push({ path: original.path, bytesBefore: original.bytes.length, bytesAfter: current.length, sha256Before: original.sha256, originalBytesRetained: true });
    }
    const journalEvidence = join(evidenceRoot, 'journals')
    const logText = await readFile(logPath, 'utf8')
    const transfers = [...logText.matchAll(/Full: ([\d,.]+) KB, To download: ([\d,.]+) KB \(([^)]+)\)/g)].map(match => ({ fullKB: Number(match[1].replaceAll(',', '')), downloadedKB: Number(match[2].replaceAll(',', '')), percent: match[3] }))
    const differential = transfers.some(item => item.downloadedKB < item.fullKB) && !/Cannot download differentially|falling back to full download/.test(logText)
    if (values['require-differential'] && !differential) throw new Error('no successful differential download in real updater log')
    const journalFiles = (await readdir(journalEvidence)).filter(name => name.endsWith('.jsonl'))
    const journalEvents = new Set()
    for (const name of journalFiles) {
      for (const line of (await readFile(join(journalEvidence, name), 'utf8')).split('\n').filter(Boolean)) {
        const event = JSON.parse(line).event
        if (typeof event === 'string') journalEvents.add(event)
      }
    }
    for (const event of ['started', 'check-requested', 'download-requested', 'install-confirmed']) {
      if (!journalEvents.has(event)) throw new Error(`update journal is missing ${event}`)
    }
    const report = { schemaVersion: 1, accepted: true, realElectron: true, appId, appName, before, after,
      restarted: true, successorReadiness, signatureVerifiedAfter: true, differential, transfers, logPath,
      retainedFiles,
      targetVersion, origin: feedOrigin, channel: selectedChannel, dataRetained: true, journalEvents: [...journalEvents].sort(), journals: journalEvidence, installedApp: install,
      completedAt: new Date().toISOString() }
    await writeFile(join(evidenceRoot, 'installed-update.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
    console.log(`installed update accepted: ${join(evidenceRoot, 'installed-update.json')}`)
  } catch (error) {
    await writeFile(join(evidenceRoot, 'failed-update.json'), JSON.stringify({ accepted: false, error: error.message, install, root, before, targetVersion }, null, 2))
    throw error
  } finally {
    await log.close()
    // Retain failed installs and journal/log evidence for diagnosis; never delete an installed application.
    if (!values.app) await run('/usr/bin/pkill', ['-TERM', '-f', `${install}/Contents/MacOS/`]).catch(() => undefined)
  }
}

main().catch(error => { console.error(`installed update failed: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1 })
