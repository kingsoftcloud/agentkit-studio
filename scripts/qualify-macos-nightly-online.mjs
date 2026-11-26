import { _electron as electron, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import asar from '@electron/asar';

const exec = promisify(execFile);
const [installedBundle, evidencePath] = process.argv.slice(2);
if (process.platform !== 'darwin' || process.env.GITHUB_ACTIONS !== 'true') throw new Error('This qualification requires a disposable Mac Actions runner');
const bundle = await realpath(installedBundle);
const evidence = resolve(evidencePath);
const journalDir = join(evidence, 'journals');
const baseline = '0.2.2-rc.1.20261124.1';
const target = '0.2.2-rc.1.20261125.2';
const executable = join(bundle, 'Contents/MacOS/AgentKit Studio');
await mkdir(journalDir, { recursive: true });

async function verifySignature() {
  await exec('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
  await exec('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=4', bundle]);
}
async function journal() {
  const lines = await Promise.all((await readdir(journalDir)).filter(name => name.endsWith('.jsonl'))
    .map(name => readFile(join(journalDir, name), 'utf8')));
  return lines.flatMap(content => content.trim().split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { return null; }
  })).filter(Boolean);
}
async function processes() {
  const response = await exec('/bin/ps', ['-axo', 'pid=,ppid=,command=']);
  return response.stdout.split('\n').map(line => line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/))
    .filter(Boolean).map(([, pid, parent, command]) => ({ pid: Number(pid), parent: Number(parent), command }));
}
const noTelemetry = { DSH_TELEMETRY_DISABLED: '1', AGENTKIT_TELEMETRY_DISABLED: '1', DSH_DESKTOP_UPDATE_JOURNAL_DIR: journalDir };
let app;
let confirmed = false;
try {
  for (const [name, value] of Object.entries(noTelemetry)) await exec('/bin/launchctl', ['setenv', name, value]);
  await verifySignature();
  // No custom profile data: the automatic successor inherits the same fresh user profile.
  app = await electron.launch({ executablePath: executable, cwd: bundle, env: { ...process.env, ...noTelemetry }, timeout: 120000 });
  const main = await app.firstWindow({ timeout: 120000 });
  await expect(main.getByRole('button', { name: /^(智能体|Agents)$/ })).toBeVisible({ timeout: 120000 });
  const before = await app.evaluate(({ app }) => ({ version: app.getVersion(), pid: process.pid }));
  if (before.version !== baseline) throw new Error('The started client was not the signed 20261124.1 baseline');
  await main.screenshot({ path: join(evidence, 'baseline-workspace.png') });

  // Open the real native menu action on the installed Electron app.
  await app.evaluate(({ Menu, BrowserWindow }) => {
    const item = Menu.getApplicationMenu()?.items.flatMap(section => section.submenu?.items ?? [])
      .find(candidate => /检查更新|check for updates/i.test(candidate.label));
    if (!item) throw new Error('The desktop update menu item is unavailable');
    item.click(item, BrowserWindow.getFocusedWindow() ?? undefined, {});
  });
  const promptDeadline = Date.now() + 14 * 60_000;
  while (!confirmed && Date.now() < promptDeadline) {
    for (const view of app.windows()) {
      if (view.url() !== 'dsh-app://shell/update-dialog.html') continue;
      const status = await view.evaluate(() => window.dshUpdateDialog.status()).catch(() => null);
      if (!status) continue;
      const download = status.buttons.findIndex(label => /下载更新|download update/i.test(label));
      const install = status.buttons.findIndex(label => /安装并重启|install and restart/i.test(label));
      if (download >= 0 && status.message.includes(target)) {
        await view.screenshot({ path: join(evidence, 'update-available.png') });
        await view.evaluate(({ revision, index }) => window.dshUpdateDialog.respond(revision, index), { revision: status.revision, index: download });
        break;
      }
      if (install >= 0 && status.message.includes(target)) {
        await view.screenshot({ path: join(evidence, 'update-ready.png') });
        confirmed = true;
        await view.evaluate(({ revision, index }) => window.dshUpdateDialog.respond(revision, index), { revision: status.revision, index: install }).catch(() => {});
        break;
      }
      if (/失败|Could not|Cannot find channel|404/.test(status.message)) throw new Error('The native updater showed an error dialog');
    }
    if (!confirmed) await sleep(500);
  }
  if (!confirmed) throw new Error('The signed update did not reach native installation confirmation');

  let successor;
  let event;
  let child;
  const restartDeadline = Date.now() + 240000;
  while (Date.now() < restartDeadline) {
    const running = await processes();
    if (!running.some(process => process.pid === before.pid)) {
      successor = running.find(process => process.command === executable);
      if (successor) {
        const recorded = await journal();
        event = recorded.find(record => record.pid === successor.pid && record.version === target && record.event === 'workspace-ready');
        child = running.find(process => process.parent === successor.pid && process.command.startsWith(executable + ' ')
          && process.command.includes('dsh-desktop-host/lib/index.js'));
        if (event && child) break;
      }
    }
    await sleep(1000);
  }
  if (!successor || !event || !child) throw new Error('Automatic restart did not bring the signed target to a running workspace');
  const info = (await exec('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', join(bundle, 'Contents/Info.plist')])).stdout.trim();
  const installed = JSON.parse(asar.extractFile(join(bundle, 'Contents/Resources/app.asar'), 'package.json').toString());
  if (info !== target || installed.version !== target) throw new Error('The restarted executable is not the target version');
  await verifySignature();

  const states = (await journal()).filter(record => record.pid === before.pid);
  const manual = states.find(record => record.event === 'check-requested');
  const download = states.find(record => record.event === 'download-requested');
  const complete = states.findLast(record => record.event === 'state' && record.phase === 'verifying'
    && record.targetVersion === target);
  const install = states.find(record => record.event === 'install-confirmed');
  const quit = states.find(record => record.event === 'quit-requested');
  if (!manual || !download || !complete || !install || !quit) throw new Error('The baseline journal did not record the full native update sequence');
  const result = {
    baselineVersion: baseline, installedVersion: target, beforePid: before.pid, restartedPid: successor.pid,
    workspaceHostPid: child.pid, workspaceReady: event.time, notarizedAfterInstall: true, realPublicFeed: true,
    actualDownloadBytes: complete.transferredBytes, downloadedAt: complete.time, installConfirmedAt: install.time,
    oldProcessQuitAt: quit.time, noManualRelaunch: true,
  };
  await writeFile(join(evidence, 'macos-nightly-online.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
} catch (error) {
  if (app && !confirmed) {
    for (const [index, window] of app.windows().entries()) {
      await window.screenshot({ path: join(evidence, `failure-${index}.png`) }).catch(() => {});
    }
  }
  throw error;
} finally {
  if (app && !confirmed) await app.close().catch(() => {});
  for (const name of Object.keys(noTelemetry)) await exec('/bin/launchctl', ['unsetenv', name]).catch(() => {});
}
