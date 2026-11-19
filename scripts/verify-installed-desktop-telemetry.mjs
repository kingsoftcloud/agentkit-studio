/** Run an installed Studio package against a loopback HTTPS collector with synthetic data. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { _electron as electron } from '@playwright/test';
import { maxBodyBytes } from '../src/telemetry/contract.mjs';

const fixturePort = 49331;
const endpoint = `https://127.0.0.1:${fixturePort}/v1/logs`;
const basicOnly = { basic: true, crash: false, run: false };
const allOff = { basic: false, crash: false, run: false };

async function eventually(probe, label, timeout = 90_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await probe();
    if (result) return result;
    await wait(250);
  }
  throw new Error(label);
}

function packagePaths(path) {
  if (process.platform === 'win32') return { executable: path, resources: join(dirname(path), 'resources') };
  assert.equal(process.platform, 'darwin');
  const executable = execFileSync('/usr/libexec/PlistBuddy',
    ['-c', 'Print :CFBundleExecutable', join(path, 'Contents', 'Info.plist')], { encoding: 'utf8' }).trim();
  return { executable: join(path, 'Contents', 'MacOS', executable), resources: join(path, 'Contents', 'Resources') };
}

async function installWindows(installer, destination) {
  console.log(`Installing signed ${basename(installer)}`);
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$signature = Get-AuthenticodeSignature -LiteralPath $env:STUDIO_TEST_INSTALLER',
    'if ($signature.Status -ne "Valid" -or -not $signature.TimeStamperCertificate) { throw "Installer signature invalid" }',
    '$result = Start-Process -FilePath $env:STUDIO_TEST_INSTALLER -ArgumentList @("/S", "/D=$env:STUDIO_TEST_DESTINATION") -PassThru',
    'if (-not $result.WaitForExit(120000)) { Stop-Process -Id $result.Id -Force; throw "NSIS did not exit within two minutes" }',
    'if ($result.ExitCode -ne 0) { exit $result.ExitCode }',
    '$app = Join-Path $env:STUDIO_TEST_DESTINATION "AgentKit Studio.exe"',
    '$installed = Get-AuthenticodeSignature -LiteralPath $app',
    'if ($installed.Status -ne "Valid" -or -not $installed.TimeStamperCertificate) { throw "Installed app signature invalid" }',
  ].join('\n');
  execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, STUDIO_TEST_INSTALLER: installer, STUDIO_TEST_DESTINATION: destination },
    stdio: 'inherit',
    timeout: 150_000,
  });
  console.log('Installed executable passed Authenticode verification');
  return join(destination, 'AgentKit Studio.exe');
}

async function installMacBaseline(dmg, root, destination) {
  const mount = join(root, 'baseline-mount');
  await mkdir(mount);
  execFileSync('/usr/bin/hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mount, dmg], { stdio: 'ignore' });
  try {
    const bundles = (await readdir(mount)).filter(file => file.endsWith('.app'));
    assert.equal(bundles.length, 1);
    const app = join(mount, bundles[0]);
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { stdio: 'ignore' });
    execFileSync('/usr/sbin/spctl', ['--assess', '--type', 'execute', app], { stdio: 'ignore' });
    execFileSync('/usr/bin/ditto', [app, destination]);
  } finally {
    execFileSync('/usr/bin/hdiutil', ['detach', mount], { stdio: 'ignore' });
  }
}

async function listen(root) {
  const key = join(root, 'local.key');
  const cert = join(root, 'local.pem');
  const config = join(root, 'openssl.cnf');
  await writeFile(config, '[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=local\n[dn]\nCN=127.0.0.1\n[local]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:true\n');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-keyout', key, '-out', cert, '-config', config], { stdio: 'ignore' });
  const requests = [];
  const server = createServer({ key: await readFile(key), cert: await readFile(cert) }, async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/logs') {
      response.writeHead(404).end();
      return;
    }
    try {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        assert.ok(bytes <= maxBodyBytes);
        chunks.push(chunk);
      }
      assert.equal(request.headers.authorization, undefined);
      assert.equal(request.headers.cookie, undefined);
      const records = JSON.parse(Buffer.concat(chunks)).resourceLogs[0].scopeLogs[0].logRecords;
      requests.push(records);
      response.setHeader('content-type', 'application/json');
      if (requests.length === 1) response.writeHead(503, { 'Retry-After': '1' }).end('{}');
      else response.writeHead(200).end('{}');
    } catch {
      response.writeHead(400).end();
    }
  });
  await new Promise((ready, error) => {
    server.once('error', error);
    server.listen(fixturePort, '127.0.0.1', ready);
  });
  return { requests, cert, close: () => new Promise(resolveClose => server.close(resolveClose)) };
}

async function open(executable, profile, cert, version, baseline = false) {
  await mkdir(profile, { recursive: true });
  const userData = join(profile, 'electron');
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([name]) => /^(?:path|systemroot|windir|comspec|temp|tmp|tmpdir|home|userprofile|appdata|localappdata|lang|lc_all)$/i.test(name)));
  Object.assign(env, {
    DSH_HOME: join(profile, 'dsh'), AGENTKIT_HOME: join(profile, 'studio'),
    NODE_EXTRA_CA_CERTS: cert, DSH_DESKTOP_OPEN_DEVTOOLS: '0',
  });
  if (baseline) env.DSH_TELEMETRY_DISABLED = '1';
  const app = await electron.launch({ executablePath: executable, args: [`--user-data-dir=${userData}`],
    cwd: profile, env, timeout: 120_000 });
  try {
    const identity = await app.evaluate(({ app, dialog }) => {
      app.setAsDefaultProtocolClient = () => true;
      const original = dialog.showMessageBox.bind(dialog);
      dialog.showMessageBox = (...args) => {
        if (!['Data and privacy', '数据与隐私'].includes(args.at(-1)?.message)) return original(...args);
        globalThis.telemetryNoticeShown = true;
        return new Promise(resolveNotice => { globalThis.resolveTelemetryNotice = resolveNotice; });
      };
      return { packaged: app.isPackaged, version: app.getVersion(), userData: app.getPath('userData') };
    });
    assert.equal(identity.packaged, true);
    assert.equal(identity.version, version);
    assert.equal(resolve(identity.userData), resolve(userData));
    return app;
  } catch (error) {
    await app.close();
    throw error;
  }
}

async function triggerForeground(app) {
  return await app.evaluate(({ BrowserWindow }) => {
    const windows = BrowserWindow.getAllWindows().filter(window => window.isVisible() && !window.isDestroyed());
    for (const window of windows) {
      if (!window.isFocused()) window.isFocused = () => true;
      window.emit('focus');
    }
    return windows.length > 0;
  });
}

async function waitForNotice(app) {
  await eventually(async () => {
    if (await app.evaluate(() => globalThis.telemetryNoticeShown === true)) return true;
    await triggerForeground(app);
    return false;
  }, 'The packaged desktop notice did not open');
}

async function workspace(app, baseline = false) {
  return await eventually(async () => {
    for (const page of app.windows()) {
      const ready = await page.evaluate(legacy => legacy ? Boolean(window.dshDesktop?.updates)
        : Boolean(window.dshDesktop?.telemetry), baseline).catch(() => false);
      if (ready) return page;
      await page.evaluate(() => window.dshWelcome?.skip()).catch(() => {});
    }
  }, 'The installed workspace telemetry IPC is unavailable');
}

async function main() {
  const { values } = parseArgs({ options: {
    app: { type: 'string' }, version: { type: 'string' }, output: { type: 'string' },
    baseline: { type: 'string' }, 'baseline-version': { type: 'string' }, installer: { type: 'string' },
  } });
  const windows = process.platform === 'win32';
  assert.ok(values.version && values.output && (windows ? values.installer : values.app),
    '--version, --output and a Windows --installer or macOS --app are required');
  const root = await realpath(await mkdtemp(join(tmpdir(), windows ? 'studio-qa-' : 'studio-installed-telemetry-')));
  // The visible installer acceptance may relocate an existing installation.
  const appPath = windows ? await installWindows(resolve(values.installer), join(root, 'current')) : resolve(values.app);
  const { executable, resources } = packagePaths(appPath);
  const release = JSON.parse(await readFile(join(resources, 'studio-telemetry', 'policy.json'), 'utf8'));
  assert.deepEqual(release, { endpoint, defaultBasic: true, policyRevision: 'qualification-v1' });
  const profile = join(root, 'primary');
  const outbox = join(profile, 'electron', 'studio-telemetry', 'outbox.jsonl');
  const receiver = await listen(root);
  try {
    const app = await open(executable, profile, receiver.cert, values.version);
    try {
      await waitForNotice(app);
      console.log('Reached the first-use privacy notice in the installed app');
      await wait(31_000);
      assert.equal(receiver.requests.length, 0);
      await assert.rejects(access(outbox), { code: 'ENOENT' });
      await app.evaluate(() => globalThis.resolveTelemetryNotice({ response: 0, checkboxChecked: false }));
      const page = await workspace(app);
      assert.deepEqual((await page.evaluate(() => window.dshDesktop.telemetry.status())).enabled, basicOnly);
      const initial = await page.evaluate(() => window.dshDesktop.telemetry.preview('example'));
      const sample = JSON.parse(initial).resourceLogs[0].scopeLogs[0].logRecords;
      assert.equal(sample.length, 1);
      assert.equal(sample[0].attributes.find(attribute => attribute.key === 'install_id').value.stringValue,
        '00000000-0000-4000-8000-000000000002');
      await eventually(() => receiver.requests.length >= 2, 'The installed app did not retry the failed HTTPS request', 70_000);
      assert.ok(JSON.stringify(receiver.requests[1].slice(0, receiver.requests[0].length)) === JSON.stringify(receiver.requests[0]),
        'The first batch changed during retry');
      const acceptedNames = receiver.requests[1].map(record => record.body.stringValue);
      for (const event of ['app_install', 'desktop_active_day']) {
        assert.equal(acceptedNames.filter(name => name === event).length, 1);
      }
      assert.ok(acceptedNames.every(name => ['app_install', 'desktop_active_day', 'update_check_result'].includes(name)),
        'Only basic telemetry is enabled in this profile');
      await eventually(async () => {
        const status = await page.evaluate(() => window.dshDesktop.telemetry.status());
        return status.queued === 0 && status.diagnostics.send_failed === 1;
      }, 'Queue confirmation or the package diagnostic counter is missing', 15_000);
      const stopped = await page.evaluate(() => window.dshDesktop.telemetry.stop(false));
      assert.deepEqual(stopped.enabled, allOff);
      const journal = JSON.parse((await readFile(outbox, 'utf8')).split('\n')[0]);
      assert.deepEqual(journal.choices, allOff);
    } finally {
      await app.close();
    }
    console.log('Verified credential-free delivery, stable retry IDs, the fixed preview, and local opt-out');

    const requestsAfterOptOut = receiver.requests.length;
    const restarted = await open(executable, profile, receiver.cert, values.version);
    try {
      const page = await workspace(restarted);
      await triggerForeground(restarted);
      const status = await page.evaluate(() => window.dshDesktop.telemetry.status());
      assert.deepEqual(status.enabled, allOff);
      assert.equal(status.noticePending, false);
      await wait(31_000);
      assert.equal(receiver.requests.length, requestsAfterOptOut);
    } finally {
      await restarted.close();
    }

    const declining = await open(executable, join(root, 'declined'), receiver.cert, values.version);
    try {
      await waitForNotice(declining);
      await declining.evaluate(() => globalThis.resolveTelemetryNotice({ response: 1, checkboxChecked: false }));
      const page = await workspace(declining);
      const status = await page.evaluate(() => window.dshDesktop.telemetry.status());
      assert.deepEqual(status.enabled, allOff);
      assert.equal(status.installId, null);
      await wait(31_000);
      assert.equal(receiver.requests.length, requestsAfterOptOut);
    } finally {
      await declining.close();
    }
    console.log('Verified opt-out after restart and decline in a fresh profile');

    let upgradedFrom = null;
    if (values.baseline) {
      assert.ok(values['baseline-version'] && values['baseline-version'] !== values.version);
      const old = resolve(values.baseline);
      const upgradeProfile = join(root, 'upgrade-profile');
      const destination = join(root, windows ? 'upgrade' : 'Upgraded Studio.app');
      if (process.platform === 'darwin') await installMacBaseline(old, root, destination);
      else await installWindows(old, destination);
      const installed = process.platform === 'darwin' ? destination : join(destination, 'AgentKit Studio.exe');
      const baseline = await open(packagePaths(installed).executable, upgradeProfile, receiver.cert, values['baseline-version'], true);
      try {
        await workspace(baseline, true);
      } finally {
        await baseline.close();
      }
      const marker = join(upgradeProfile, 'electron', 'qualification-profile-marker');
      await writeFile(marker, 'keep this installed profile');
      if (process.platform === 'darwin') {
        await rm(destination, { recursive: true, force: true });
        execFileSync('/usr/bin/ditto', [appPath, destination]);
      } else {
        await installWindows(resolve(values.installer), destination);
      }
      const upgraded = await open(packagePaths(installed).executable, upgradeProfile, receiver.cert, values.version);
      try {
        await waitForNotice(upgraded);
        await wait(31_000);
        assert.equal(receiver.requests.length, requestsAfterOptOut);
        assert.equal(await readFile(marker, 'utf8'), 'keep this installed profile');
        await upgraded.evaluate(() => globalThis.resolveTelemetryNotice({ response: 1, checkboxChecked: false }));
        const page = await workspace(upgraded);
        assert.deepEqual((await page.evaluate(() => window.dshDesktop.telemetry.status())).enabled, allOff);
        upgradedFrom = values['baseline-version'];
      } finally {
        await upgraded.close();
      }
    }

    await mkdir(dirname(resolve(values.output)), { recursive: true });
    const result = {
      appVersion: values.version,
      platform: process.platform,
      installedApp: true,
      testInputs: 'Injected foreground and notice actions, loopback HTTPS, isolated profiles',
      credentialFree: true,
      beforeNoticeRequests: 0,
      declinedRequests: 0,
      retryKeptEventIds: true,
      acceptedRecords: receiver.requests[1].length,
      fixedSampleVerified: true,
      sendFailureCountVerified: true,
      offPersistedAcrossLaunch: true,
      upgradedFrom,
    };
    await writeFile(values.output, JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(result));
  } finally {
    await receiver.close();
    await rm(root, { recursive: true, force: true });
  }
}

await main();
