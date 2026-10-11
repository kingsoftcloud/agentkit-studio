/** Exercise a signed macOS app through the real Electron updater and retain evidence. */
import { execFile, spawn } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { parseArgs } from 'node:util'

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
  const manifest = JSON.parse(await readFile(join(app, 'Contents/Resources/app/package.json'), 'utf8'))
  if (typeof manifest.version !== 'string') throw new Error('installed app package.json has no version')
  return { version: manifest.version, commit: typeof manifest.dshBuildCommit === 'string' ? manifest.dshBuildCommit : undefined }
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

async function runAppleScript(appName, timeoutMs) {
  const script = `
tell application "System Events"
  set deadline to (current date) + ${Math.ceil(timeoutMs / 1000)}
  set clickedMenu to false
  repeat while (current date) is less than deadline
    if not (exists process "${appName.replaceAll('"', '\\"')}") then exit repeat
    tell process "${appName.replaceAll('"', '\\"')}"
      try
        if not clickedMenu and exists menu bar item 1 of menu bar 1 then
          click menu bar item 1 of menu bar 1
          if exists menu 1 of menu bar item 1 of menu bar 1 then
            repeat with itemRef in (menu items of menu 1 of menu bar item 1 of menu bar 1)
              set itemName to name of itemRef
              if itemName contains "Check for Updates" or itemName contains "检查更新" then
                click itemRef
                set clickedMenu to true
                exit repeat
              end if
            end repeat
          end if
        end if
      end try
      repeat with windowRef in (windows)
        try
          repeat with buttonRef in (buttons of windowRef)
            set buttonName to name of buttonRef
            if buttonName contains "Download" or buttonName contains "下载" then click buttonRef
            if buttonName contains "Install" or buttonName contains "安装" or buttonName contains "Restart" then click buttonRef
          end repeat
        end try
      end repeat
    end tell
    delay 1
  end repeat
end tell
`
  const path = join(tmpdir(), `agentkit-studio-update-${process.pid}.applescript`)
  await writeFile(path, script, { mode: 0o600 })
  try { await run('/usr/bin/osascript', [path], { timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 }) }
  finally { await rm(path, { force: true }) }
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
    dmg: { type: 'string' }, origin: { type: 'string' }, channel: { type: 'string' }, version: { type: 'string' },
    'expected-commit': { type: 'string' }, evidence: { type: 'string' }, timeout: { type: 'string' },
  } })
  const dmg = required(values.dmg, '--dmg')
  const feedOrigin = required(values.origin, '--origin')
  const selectedChannel = required(values.channel, '--channel')
  const targetVersion = required(values.version, '--version')
  const timeoutMs = Number(values.timeout ?? '300000')
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 30_000 || timeoutMs > 900_000) throw new Error('--timeout must be 30000..900000')
  const evidenceRoot = resolve(values.evidence ?? join(STUDIO_ROOT, '.artifacts', 'desktop-release', `installed-${Date.now()}`))
  await mkdir(evidenceRoot, { recursive: true, mode: 0o700 })
  const root = await (await import('node:fs/promises')).mkdtemp(join(tmpdir(), 'agentkit-studio-installed-'))
  const mount = join(root, 'mount')
  const install = join(root, 'AgentKit Studio.app')
  const userData = join(root, 'user-data')
  const harnessHome = join(root, 'dsh-home')
  const journals = join(root, 'journals')
  await mkdir(userData, { recursive: true }); await mkdir(harnessHome, { recursive: true }); await mkdir(journals, { recursive: true })
  await writeFile(join(harnessHome, 'p1-1-marker.txt'), 'retained across update\n', { mode: 0o600 })
  await run(process.execPath, [join(STUDIO_ROOT, 'scripts/desktop-release.mjs'), 'verify-feed', '--origin', feedOrigin,
    '--channel', selectedChannel, '--version', targetVersion, '--output', evidenceRoot])
  const mounted = await mountDmg(dmg, mount)
  const appName = await plist(join(mounted, 'Contents/Info.plist'), 'CFBundleName')
  const appId = await plist(join(mounted, 'Contents/Info.plist'), 'CFBundleIdentifier')
  if (appId !== 'com.kingsoftcloud.agentkit-studio') throw new Error(`unexpected App ID ${appId}`)
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', mounted])
  await run('/usr/bin/spctl', ['--assess', '--type', 'execute', '--verbose=4', mounted])
  await run('/usr/bin/ditto', [mounted, install])
  await run('/usr/bin/hdiutil', ['detach', mount, '-force'])
  const before = await appVersion(install)
  const executable = join(install, 'Contents/MacOS', await plist(join(install, 'Contents/Info.plist'), 'CFBundleExecutable'))
  const child = spawn(executable, ['--user-data-dir', userData], { env: { ...process.env, DSH_HOME: harnessHome, DSH_DESKTOP_UPDATE_JOURNAL_DIR: journals }, stdio: 'ignore', detached: true })
  child.unref()
  try {
    await runAppleScript(appName, timeoutMs)
    const after = await waitForVersion(install, targetVersion, timeoutMs)
    const marker = await readFile(join(harnessHome, 'p1-1-marker.txt'), 'utf8')
    if (marker !== 'retained across update\n') throw new Error('DSH_HOME marker was not retained')
    if (values['expected-commit'] !== undefined && after.commit !== values['expected-commit']) throw new Error(`updated app commit ${after.commit ?? 'unknown'} does not match expected rollback commit`)
    const report = { schemaVersion: 1, accepted: true, realElectron: true, appId, appName, before, after,
      targetVersion, origin: feedOrigin, channel: selectedChannel, dataRetained: true, journals, installedApp: install,
      completedAt: new Date().toISOString() }
    await writeFile(join(evidenceRoot, 'installed-update.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
    console.log(`installed update accepted: ${join(evidenceRoot, 'installed-update.json')}`)
  } finally {
    await run('/usr/bin/pkill', ['-TERM', '-f', `${install}/Contents/MacOS/`]).catch(() => undefined)
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 })
  }
}

main().catch(error => { console.error(`installed update failed: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1 })
