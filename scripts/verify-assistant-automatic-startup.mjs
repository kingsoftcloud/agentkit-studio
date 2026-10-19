/**
 * Opt-in installed bundle CLI smoke with a loopback-only model and private state.
 * Usage: node scripts/verify-assistant-automatic-startup.mjs INSTALLATION TGZ REPORT EXPECTED_SHA256
 * Named arguments: --installation --tgz --report --expected-sha256 [--source-commit].
 * Never imports index.apply, mounts bootstrap/guards, or patches the running Host.
 */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { once } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, lstat, realpath, symlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

const BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@kingsoftcloud/agentkit-studio'];
const SINGLETONS = ['@deepseek-ai/cordis', '@deepseek-ai/dsh-llm'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export function parseSmokeOptions(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true,
    options: { ...Object.fromEntries(['installation', 'tgz', 'report', 'expected-sha256', 'source-commit'].map(name => [name, { type: 'string' }])), 'profile-migration': { type: 'boolean', default: false } } });
  const names = ['installation', 'tgz', 'report', 'expected-sha256'];
  assert.ok(positionals.length === 0 || positionals.length === 4, 'Supply four positional arguments or the named options');
  assert.ok(!positionals.length || names.every(name => values[name] === undefined), 'Do not mix positional and named paths');
  const selected = Object.fromEntries(names.map((name, index) => [name, values[name] ?? positionals[index]]));
  assert.ok(names.every(name => selected[name]), 'installation, tgz, report and expected-sha256 are required');
  assert.match(selected['expected-sha256'], /^[a-f0-9]{64}$/, 'expected-sha256 must be the exact lowercase archive SHA256');
  if (values['source-commit']) assert.match(values['source-commit'], /^[a-f0-9]{40}$/, 'source-commit must be a full commit ID');
  return { installation: resolve(selected.installation), tgz: resolve(selected.tgz), target: resolve(selected.report),
    expectedArchive: selected['expected-sha256'], sourceCommit: values['source-commit'] || null, profileMigration: values['profile-migration'] };
}

/** The production profile delays official Schedule until portable bootstrap is ready. */
export function assertAutomaticProfilePatch(text, { requireScheduleReadiness = true } = {}) {
  const rows = parseYaml(text);
  assert.ok(Array.isArray(rows), 'profile patch must be an array');
  let scheduleReadinessRows = 0, providerSettingsRows = 0;
  for (const row of rows) {
    if (row?.id === 'schedule') {
      scheduleReadinessRows++;
      assert.ok(Object.keys(row).every(key => ['id', 'name', 'disabled', 'inject', 'config'].includes(key)), 'unexpected Schedule override');
      if (row.name !== undefined) assert.equal(row.name, '@deepseek-ai/dsh-schedule', 'Schedule must remain the official plugin');
      if (row.disabled !== undefined) assert.equal(row.disabled, false, 'Schedule must remain enabled');
      if (row.config !== undefined) assert.ok(row.config && typeof row.config === 'object' && !Array.isArray(row.config), 'Schedule Settings must remain an object');
      assert.deepEqual(row.inject, ['studioFrozenRuntimeReady'], 'Schedule must wait for the production frozen runtime');
      continue;
    }
    assert.equal(row?.id, 'llm-pi-ai', 'the smoke must not insert a bootstrap plugin or override Studio');
    assert.ok(Object.keys(row).every(key => ['id', 'name', 'disabled', 'config'].includes(key)), 'unexpected profile override');
    if (row.name !== undefined) assert.equal(row.name, '@deepseek-ai/dsh-llm-pi-ai');
    if (row.disabled !== undefined) assert.equal(row.disabled, false, 'model provider must remain enabled');
    assert.ok(row.config && typeof row.config === 'object' && !Array.isArray(row.config));
    providerSettingsRows++;
  }
  assert.ok(scheduleReadinessRows <= 1, 'duplicate Schedule readiness gates are forbidden');
  if (requireScheduleReadiness) assert.equal(scheduleReadinessRows, 1, 'the profile requires exactly one Schedule readiness gate');
  assert.ok(providerSettingsRows <= 1, 'duplicate model Settings patches are forbidden');
  return { providerSettingsRows, scheduleReadinessRows, studioOverride: false, insertedBootstrap: false };
}

export function assertManagedSnapshot(snapshot) {
  assert.equal(snapshot.capabilities.execution.profile, 'workspace-managed/v1');
  assert.equal(snapshot.capabilities.execution.managed, true);
  assert.equal(snapshot.capabilities.execution.permission, 'workspace-write');
  assert.equal(snapshot.capabilities.execution.approval, 'ask');
}

/** Title/context helpers may reuse user text but never carry native tool schemas. */
export function selectFixturePlan(body, plans) {
  if (!Array.isArray(body.tools) || !body.tools.length) return undefined;
  const last = body.messages.findLast(item => item.role === 'user');
  const input = typeof last?.content === 'string' ? last.content : (last?.content || []).map(part => part.text || '').join('');
  return plans.find(item => input.includes(item.prompt));
}

export function assertReplayUnchanged(before, after, requestId) {
  assert.equal(after.status, 'completed');
  assert.equal(after.queuedCount, 0);
  assert.equal(after.lastTurnEndSeq, before.lastTurnEndSeq);
  assert.equal(after.asOfSeq, before.asOfSeq);
  assert.deepEqual(after.events, before.events);
  assert.equal(after.events.filter(event => event.type === 'user/message' && event.data.source?.rpcId === requestId).length, 1);
}

export function assertRestoredSchedule({ schedule, created, sessionId, snapshot, startedAt }) {
  assert.ok(schedule, 'persisted schedule must remain in the catalog');
  assert.equal(schedule.id, created.id);
  assert.equal(schedule.status, 'inactive');
  assert.equal(schedule.sessionId, sessionId);
  assert.equal(schedule.lastDelivery?.scheduledAt, created.scheduledAt);
  const deliveredAt = Date.parse(schedule.lastDelivery?.deliveredAt);
  assert.ok(Number.isFinite(deliveredAt) && deliveredAt >= startedAt, 'delivery must be acknowledged by the restarted process');
  const events = snapshot.events.filter(event => event.type === 'user/message' && event.data.source?.kind === 'schedule');
  assert.equal(events.length, 1, 'one persisted schedule must produce exactly one visible message');
  assert.equal(events[0].data.id, schedule.lastDelivery.messageId);
}

async function assertPortClosed(port) {
  await new Promise((accept, reject) => {
    const socket = createConnection({ port, host: '127.0.0.1' });
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('Port closure probe timed out')); }, 1500);
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); reject(new Error('Stopped runtime port still accepts connections')); });
    socket.once('error', error => { clearTimeout(timer); socket.destroy(); error.code === 'ECONNREFUSED' ? accept() : reject(error); });
  });
}

async function archiveFixture(tgz, expectedArchive, root) {
  assert.equal(digest(await readFile(tgz)), expectedArchive, 'tested archive SHA256');
  const entries = execFileSync('tar', ['-tzf', tgz], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim().split('\n');
  for (const entry of entries) assert.ok(entry.startsWith('package/') && !entry.split('/').includes('..') && !entry.includes('\\'), 'non-package archive entry');
  const extracted = join(root, 'archive-check'); await mkdir(extracted);
  execFileSync('tar', ['-xzf', tgz, '-C', extracted]);
  const files = new Map();
  for (const entry of entries) {
    const path = join(extracted, entry), info = await lstat(path);
    if (info.isDirectory()) continue;
    assert.ok(info.isFile() && !info.isSymbolicLink(), 'archive must contain ordinary package files');
    files.set(entry.slice('package/'.length), await readFile(path));
  }
  assert.ok(files.has('src/index.mjs') && files.has('scripts/start-agent-bundle.mjs'));
  return files;
}

async function comparePackage(plugin, files) {
  for (const [path, expected] of files) assert.deepEqual(await readFile(join(plugin, path)), expected, 'installed archive bytes: ' + path);
  return files.size;
}

async function singletonResolution(anchors, canonical) {
  const result = {};
  for (const [label, anchor] of Object.entries(anchors)) {
    const require = createRequire(await realpath(anchor));
    result[label] = Object.fromEntries(await Promise.all(SINGLETONS.map(async name => [name, await realpath(require.resolve(name))])));
    if (canonical) assert.deepEqual(result[label], canonical, label + ' must resolve the canonical Cordis and LLM module files');
  }
  return result;
}

/** Read-only resolver probe in a separate process; it never loads Studio.apply. */
function profileSingletonResolution(cliEntry, profile, home, canonical) {
  const script = `
    import assert from 'node:assert/strict';
    import { createRequire } from 'node:module';
    import { realpathSync } from 'node:fs';
    import { dirname, join } from 'node:path';
    import { pathToFileURL } from 'node:url';
    const [cliEntry, profileDir, home] = process.argv.slice(1);
    const require = createRequire(cliEntry), installAnchor = join(dirname(dirname(cliEntry)), 'package.json');
    const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')));
    const { createRuntimeResolution, loadProfileDirectory, PluginPackages } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')));
    const profile = loadProfileDirectory('dsh', profileDir, installAnchor);
    const resolution = await createRuntimeResolution({ installAnchor, home, profile });
    const ctx = new Context();
    try {
      await ctx.plugin(PluginPackages, { resolution });
      const importer = join(profileDir, 'node_modules/@kingsoftcloud/agentkit-studio/src/index.mjs');
      const local = createRequire(importer), modules = {};
      for (const name of ${JSON.stringify(SINGLETONS)}) {
        const entry = resolution.entries.find(item => item.name === name);
        assert.ok(entry, 'Host module entry must exist: ' + name);
        assert.equal(entry.scope, 'installation');
        const selected = ctx.get('pluginPackages').packageOf(name, pathToFileURL(importer).href);
        assert.ok(selected, 'Studio importer must resolve: ' + name);
        assert.equal(realpathSync(selected.dir), realpathSync(entry.packageDir));
        const hostEntry = realpathSync(createRequire(entry.declarer).resolve(name));
        const studioEntry = realpathSync(local.resolve(name));
        assert.equal(studioEntry, hostEntry, 'Studio must use the canonical Host singleton: ' + name);
        modules[name] = studioEntry;
      }
      console.log('AUTOMATIC_PROFILE_RESOLUTION ' + JSON.stringify(modules));
    } finally { await ctx.fiber.dispose(); }
  `;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', script, cliEntry, profile, home], {
    encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024,
    env: { PATH: process.env.PATH, LANG: 'C.UTF-8', TZ: 'UTC' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const line = output.split('\n').find(value => value.startsWith('AUTOMATIC_PROFILE_RESOLUTION '));
  assert.ok(line, 'public Host resolution probe must produce its result');
  const modules = JSON.parse(line.slice('AUTOMATIC_PROFILE_RESOLUTION '.length));
  assert.deepEqual(modules, canonical);
  return { evidence: 'read-only-public-profile-resolution-probe; actual Host startup checked separately', modules };
}

/** Real installed native lock, two processes, and a killed owner's rename journal. */
async function verifyProfilePreparationExclusion({ plugin, installation, archive, env, state }) {
  const { prepareBundleHost } = await import(pathToFileURL(join(plugin, 'src/bundle-host.mjs')));
  const options = { installation, archive, env, state };
  const plan = await prepareBundleHost(options), profile = join(plan.env.DSH_HOME, 'profiles/agentkit-runtime');
  await rm(join(profile, '.agentkit-runtime-profile.json'));
  await rm(join(profile, 'node_modules'), { recursive: true });
  await symlink(await realpath(join(installation, 'node_modules')), join(profile, 'node_modules'), 'dir');
  await writeFile(join(profile, 'cordis.patch.yml'), '[]\n');
  const script = `
    import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
    import { once } from 'node:events'; import { pathToFileURL } from 'node:url';
    const [init] = await once(process, 'message');
    process.on('message', () => {}); // Keep the paused owner's IPC handle alive.
    if (init.pause) {
      const rename = fs.promises.rename;
      fs.promises.rename = async (source, target) => {
        await rename(source, target);
        if (source === init.profile) { process.send({ kind: 'paused-after-rename' }); await new Promise(() => {}); }
      };
      syncBuiltinESMExports();
    }
    try { const { prepareBundleHost } = await import(pathToFileURL(init.entry)); await prepareBundleHost(init.options); process.send({ kind: 'complete' }); }
    catch (error) { process.send({ kind: 'failed', code: error.code || 'UNKNOWN' }); }
    process.disconnect();
  `;
  const spawnProbe = pause => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: { PATH: process.env.PATH }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const done = once(child, 'exit'); void done.catch(() => {});
    const reply = new Promise((accept, reject) => {
      const timer = setTimeout(() => reject(Error('Profile lock probe timed out')), 30000);
      child.once('message', message => { clearTimeout(timer); accept(message); });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); reject(Error('Profile lock probe exited before its reply')); });
    });
    child.send({ pause, entry: join(plugin, 'src/bundle-host.mjs'), options, profile });
    return { child, done, reply };
  };
  const holder = spawnProbe(true);
  try {
    assert.equal((await holder.reply).kind, 'paused-after-rename');
    assert.equal(holder.child.exitCode, null, 'the lock holder must still be alive at the barrier');
    const journalPath = join(plan.env.DSH_HOME, 'profiles/.agentkit-runtime-profile-transaction.json');
    const journal = await readFile(journalPath), transaction = JSON.parse(journal);
    const staging = join(plan.env.DSH_HOME, 'profiles', transaction.staging);
    assert.equal((await lstat(staging)).isDirectory(), true);
    const competing = spawnProbe(false);
    assert.deepEqual(await competing.reply, { kind: 'failed', code: 'BUNDLE_HOST_PROFILE_BUSY' }); await competing.done;
    assert.deepEqual(await readFile(journalPath), journal, 'a live contender must not run journal recovery');
    assert.equal((await lstat(staging)).isDirectory(), true, 'a live contender must not delete staging');
    holder.child.kill('SIGKILL'); await holder.done;
    const successor = spawnProbe(false); assert.equal((await successor.reply).kind, 'complete'); await successor.done;
    assert.equal((await lstat(join(profile, 'node_modules'))).isDirectory(), true);
    await assert.rejects(lstat(journalPath), { code: 'ENOENT' });
    assert.equal(JSON.parse(await readFile(join(profile, '.agentkit-runtime-profile.json'))).identity.bundleSha256, plan.identity.sha256);
  } finally {
    if (holder.child.exitCode === null && holder.child.signalCode === null) { holder.child.kill('SIGKILL'); await holder.done; }
  }
}

export async function runAutomaticStartupSmoke(options) {
  const { installation, tgz, target, expectedArchive, sourceCommit, profileMigration = false } = options;
  const plugin = join(installation, 'node_modules/@kingsoftcloud/agentkit-studio');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'assistant-automatic-startup-'))), state = join(root, 'state');
  const report = { evidence: 'automatic-installed-studio-bundle-cli-cold-start-and-process-restart',
    archiveSha256: expectedArchive, sourceCommit, sourceCommitProvenance: sourceCommit ? 'caller-supplied; archive SHA256 and file comparisons identify tested bytes' : 'not supplied',
    platform: process.platform, automaticIndexApply: false, directMountBootstrapOrGuard: false, disabledStudioOverlay: false,
    controlledLoopbackModel: true, realProductionCredentials: false, checks: [], processes: [], passed: false,
    limits: ['Controlled local fixture only; no production account, browser UI, Desktop or OS-upgrade acceptance.',
      'Targeted automatic-entry lifecycle and routine managed-write smoke; not a broad permission audit or proof of all startup denial races.',
      'SIGTERM exit code does not distinguish successful disposal from the DSH bounded-shutdown fallback.'] };
  const check = (name, details = {}) => { report.checks.push({ name, passed: true, ...details }); console.log(JSON.stringify({ check: name, passed: true })); };
  let stage = 'archive-and-installation', host, modelFailure, runtimePort, archiveFiles, canonical, cliEntry;
  const requests = [], progress = new Set();
  const plans = [
    { prompt: 'cold startup write', file: 'cold.txt', text: 'written by automatic cold startup' },
    { prompt: 'scheduled restoration write', file: 'scheduled.txt', text: 'written by restored schedule' },
    { prompt: 'restart continuation write', file: 'restarted.txt', text: 'written after process restart' },
  ];
  const count = prompt => requests.filter(item => item.prompt === prompt).length;
  const frame = value => `data: ${JSON.stringify(value)}\n\n`;
  const model = createServer(async (request, response) => {
    try {
      if (request.url === '/v1/models') { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ data: [{ id: 'controlled-model' }] })); return; }
      assert.equal(request.url, '/v1/chat/completions');
      let raw = ''; for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw), plan = selectFixturePlan(body, plans);
      requests.push({ prompt: plan?.prompt || 'auxiliary', at: Date.now(), priorReply: JSON.stringify(body.messages).includes('AUTOMATIC_STARTUP_DONE'), model: body.model });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      if (plan && !progress.has(plan.prompt)) {
        assert.ok(body.tools?.some(item => item.function?.name === 'write'), 'official write tool must be offered');
        progress.add(plan.prompt);
        response.write(frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'write-' + requests.length, type: 'function', function: { name: 'write', arguments: JSON.stringify({ file_path: plan.file, content: plan.text }) } }] }, finish_reason: 'tool_calls' }] }));
      } else {
        response.write(frame({ choices: [{ delta: { content: 'AUTOMATIC_STARTUP_' }, finish_reason: null }] }));
        await pause(100);
        response.write(frame({ choices: [{ delta: { content: 'DONE' }, finish_reason: 'stop' }] }));
      }
      response.end('data: [DONE]\n\n');
    } catch (error) {
      modelFailure = { name: error.name, message: error.message.slice(0, 200) };
      if (!response.headersSent) response.writeHead(500);
      response.end('controlled fixture failed');
    }
  });
  const fetchBounded = (url, init = {}, ms = 15000) => fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
  async function until(test, label, timeout = 30000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (modelFailure) throw Error('Controlled model assertion: ' + modelFailure.message);
      if (host?.ended) throw Error('Host exited during ' + label);
      const value = await test(); if (value) return value;
      await pause(100);
    }
    throw Error('Timed out: ' + label);
  }
  async function stop() {
    if (!host) return;
    const current = host;
    if (!current.ended) current.child.kill('SIGTERM');
    const timer = setTimeout(() => current.child.kill('SIGKILL'), 20000);
    let result;
    try { result = await current.done; } finally { clearTimeout(timer); }
    current.record.exit = result; current.record.stoppedAt = Date.now();
    assert.notEqual(result.signal, 'SIGKILL', 'launcher must exit within its stop timeout');
    assert.equal(result.code, 0, 'expected DSH SIGTERM exit code');
    host = undefined;
    await assertPortClosed(runtimePort);
    current.record.runtimePortClosed = true;
  }
  const profile = join(state, 'dsh/profiles/agentkit-runtime');
  async function verifyProfile(label) {
    const config = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'));
    assert.deepEqual(config.dsh.profile.bundles, BUNDLES);
    const patch = assertAutomaticProfilePatch(await readFile(join(profile, 'cordis.patch.yml'), 'utf8'));
    try { assertAutomaticProfilePatch(await readFile(join(state, 'dsh/cordis.patch.yml'), 'utf8'), { requireScheduleReadiness: false }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const localPlugin = join(profile, 'node_modules/@kingsoftcloud/agentkit-studio');
    for (const owned of [join(profile, 'node_modules'), join(profile, 'node_modules/@kingsoftcloud'), localPlugin]) {
      assert.equal(await realpath(owned), resolve(owned), 'Studio importer must remain physically inside its runtime profile');
    }
    const filesCompared = await comparePackage(localPlugin, archiveFiles);
    const resolution = profileSingletonResolution(cliEntry, profile, join(state, 'dsh'), canonical);
    check(label + '-profile-installed-package-and-module-identity', { filesCompared, ...patch, resolution });
  }
  try {
    archiveFiles = await archiveFixture(tgz, expectedArchive, root);
    report.installedArchiveFilesCompared = await comparePackage(plugin, archiveFiles);
    report.package = JSON.parse(archiveFiles.get('package.json').toString());
    report.package = { name: report.package.name, version: report.package.version };
    cliEntry = join(await realpath(join(installation, 'node_modules/@deepseek-ai/dsh')), 'lib/bin.js');
    const initialModules = await singletonResolution({ installation: cliEntry });
    canonical = initialModules.installation;
    check('canonical-installation-matches-tested-archive', { filesCompared: archiveFiles.size, singletonModules: canonical });
    model.listen(0, '127.0.0.1'); await once(model, 'listening');
    const load = relative => import(pathToFileURL(join(plugin, relative)));
    const { createStudioBuild } = await load('src/studio-build.mjs');
    const { createPortableBundles } = await load('src/portable-bundle.mjs');
    const storeDir = join(root, 'export-source'), build = createStudioBuild({ storeDir }), agentId = 'ar-local-' + randomBytes(8).toString('hex');
    const bindings = { modelProfileId: 'automatic-fixture' };
    const built = await build.build({ agentId, agentName: 'automatic startup fixture', revision: 1,
      metadata: { id: agentId, name: 'automatic startup fixture', local: true, revision: 1 }, bindings,
      spec: { runtime: { type: 'dsh-native' }, bindings, instructions: { system: 'Follow the controlled user request.' }, security: { assistantPermissions: { profile: 'workspace-managed/v1' } } } });
    const portable = createPortableBundles({ storeDir, build,
      models: { profile: async () => ({ id: 'automatic-fixture', provider: 'openai-compatible', modelName: 'controlled-model', baseUrl: `http://127.0.0.1:${model.address().port}/v1`, credentialName: 'AUTOMATIC_FIXTURE_KEY', input: ['text'] }) },
      adapters: {}, configuration: { resolve: async () => ({ values: {} }) } });
    const exported = await portable.prepare(agentId, built.id), archive = join(root, 'portable.zip');
    const bytes = Buffer.from((await portable.download(agentId, built.id, exported.bundleId)).base64, 'base64');
    await writeFile(archive, bytes); await rm(storeDir, { recursive: true });
    const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
    runtimePort = probe.address().port; await new Promise(resolve => probe.close(resolve));
    const bundleSha256 = digest(bytes), token = randomBytes(32).toString('hex'), origin = `http://127.0.0.1:${runtimePort}`;
    const env = { PATH: process.env.PATH, LANG: 'C.UTF-8', TZ: 'UTC', AUTOMATIC_FIXTURE_KEY: 'synthetic-local-fixture', AGENTKIT_RUNTIME_TOKEN: token, AGENTKIT_RUNTIME_PORT: String(runtimePort), AGENTKIT_RUNTIME_HOST: '127.0.0.1' };
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    async function api(operation, payload = {}) {
      const response = await fetchBounded(origin + '/v1/assistant/' + operation, { method: 'POST', headers, body: JSON.stringify(payload) });
      const value = await response.json(); assert.ok(response.ok, operation + ': ' + (value.error?.code || response.status)); return value;
    }
    async function start(label) {
      const startedAt = Date.now();
      // The installed production launcher alone prepares the profile and starts
      // the installed DSH CLI. No --patch option, loader shim or direct mounting.
      const child = spawn(process.execPath, [join(plugin, 'scripts/start-agent-bundle.mjs'), '--archive', archive, '--state', state, '--installation', installation, '--sha256', bundleSha256], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      const record = { label, startedAt, launcherPid: child.pid }, current = { child, record, ended: false, output: '', url: null };
      report.processes.push(record); host = current;
      current.done = new Promise((accept, reject) => { child.once('error', reject); child.once('exit', (code, signal) => { current.ended = true; accept({ code, signal }); }); });
      void current.done.catch(() => {});
      const capture = data => {
        current.output = (current.output + String(data)).slice(-20000);
        const match = current.output.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+)/);
        if (match) current.url = match[1];
      };
      child.stdout.on('data', capture); child.stderr.on('data', capture);
      await until(async () => { try { return (await fetchBounded(origin + '/health', {}, 500)).ok; } catch { return false; } }, label + ' runtime startup', 90000);
      record.readyMs = Date.now() - startedAt;
      const identityResponse = await fetchBounded(origin + '/v1/agentkit/runtime', { headers }); assert.equal(identityResponse.status, 200);
      const identity = await identityResponse.json();
      assert.equal(identity.agentId, agentId); assert.equal(identity.buildId, built.id); assert.equal(identity.bundleSha256, bundleSha256);
      assert.ok(identity.capabilities.includes('personal-assistant/v1'));
      await verifyProfile(label + '-ready');
      const receipt = JSON.parse(await readFile(join(state, '.agentkit-runtime.json'), 'utf8'));
      assert.equal(receipt.format, 'agentkit.runtime-state/v1'); assert.equal(receipt.bundleSha256, bundleSha256);
      await until(() => current.url, label + ' official web readiness');
      const login = await fetchBounded(current.url, { redirect: 'manual' }); assert.equal(login.status, 303);
      const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; '), web = new URL(current.url).origin;
      assert.ok(cookie);
      const index = await fetchBounded(web + '/', { headers: { cookie } }); assert.equal(index.status, 200);
      assert.match(await index.text(), /__AGENTKIT_STUDIO__/);
      const response = await fetchBounded(web + '/agentkit', { method: 'POST', headers: { cookie, origin: web, 'content-type': 'application/json' }, body: JSON.stringify({ method: 'host/compatibility', payload: {}, rpcId: label }) });
      assert.equal(response.status, 200);
      const compatibility = (await response.json()).result;
      assert.equal(compatibility.ok, true); assert.equal(compatibility.value.baseline.compatible, true); assert.equal(compatibility.value.contract.compatible, true);
      assert.ok(Object.values(compatibility.value.features).every(value => value.available));
      record.automaticIndexApplyVerified = true; report.automaticIndexApply = true;
      check(label + '-automatic-profile-index-and-runtime-ready', { readyMs: record.readyMs, bundleIdentityVerified: true, officialCookie: true });
      return record;
    }
    if (profileMigration) {
      stage = 'native-profile-lock-exclusion';
      await verifyProfilePreparationExclusion({ plugin, installation, archive, env, state: join(root, 'lock-fixture') });
      check('native-kernel-profile-lock-excludes-live-process-and-recovers-killed-owner');
    }
    stage = 'cold-automatic-launch'; await start('cold');
    const first = { requestId: 'automatic-cold-task', text: plans[0].prompt }, accepted = await api('submit', first);
    assert.equal(accepted.accepted, true); const sessionId = accepted.sessionId;
    const userEvent = (snapshot, id) => snapshot.events.find(event => event.type === 'user/message' && event.data.source?.rpcId === id);
    const completed = await until(async () => { const value = await api('snapshot'); return value.status === 'completed' && userEvent(value, first.requestId) ? value : null; }, 'cold task completion');
    assertManagedSnapshot(completed);
    assert.ok(completed.events.some(event => event.type === 'tool/result' && event.data.message?.isError === false));
    const ownerDigest = digest(JSON.stringify([agentId, sessionId]));
    assert.deepEqual(await readdir(join(state, 'assistant-workspaces')), [ownerDigest]);
    const workspace = join(state, 'assistant-workspaces', ownerDigest, 'files');
    const owner = JSON.parse(await readFile(join(workspace, '../owner.json'), 'utf8'));
    assert.deepEqual(owner, { profile: 'workspace-managed/v1', agentId, sessionId, bundleSha256 });
    assert.equal(await readFile(join(workspace, plans[0].file), 'utf8'), plans[0].text);
    assert.equal(count(plans[0].prompt), 2);
    check('cold-native-prompt-and-managed-write-complete', { sessionId, nativeEvents: completed.events.length });
    stage = 'schedule-before-process-stop';
    await api('identity-update', { assistantName: '启动验证', ownerName: '隔离测试' });
    const scheduled = await api('schedule-create', { spec: { title: 'restore controlled task', prompt: plans[1].prompt, after_seconds: 10 } });
    const dueAt = Date.parse(scheduled.scheduledAt); assert.ok(Number.isFinite(dueAt) && dueAt > Date.now());
    const schedules = (await api('schedule-list')).items;
    assert.equal(schedules.length, 1); assert.equal(schedules[0].id, scheduled.id); assert.equal(schedules[0].status, 'active');
    const beforeRestartCalls = count(plans[0].prompt);
    await stop();
    await assert.rejects(readFile(join(workspace, plans[1].file)), { code: 'ENOENT' });
    assert.equal(count(plans[1].prompt), 0, 'schedule must not run in the first process');
    await verifyProfile('before-restart');
    while (Date.now() <= dueAt) await pause(Math.min(1000, dueAt - Date.now() + 1));
    assert.equal(count(plans[1].prompt), 0, 'stopped Host must have no surviving scheduler');
    await assert.rejects(readFile(join(workspace, plans[1].file)), { code: 'ENOENT' });
    let retainedPatch, retainedReceipt, retainedHomePatch;
    if (profileMigration) {
      stage = 'legacy-profile-migration-fixture';
      const patchPath = join(profile, 'cordis.patch.yml');
      retainedPatch = await readFile(patchPath, 'utf8');
      const homePatch = join(state, 'dsh/cordis.patch.yml');
      // Legitimate model Settings can be persisted at Host scope independently
      // of the old launcher's empty profile patch. Keep their exact bytes.
      const extraSettings = parseYaml(retainedPatch).filter(row => row.id !== 'schedule');
      retainedHomePatch = stringifyYaml(extraSettings);
      await assert.rejects(lstat(homePatch), { code: 'ENOENT' });
      await writeFile(homePatch, retainedHomePatch, { mode: 0o600 });
      // Exact pre-readiness launcher patch; other user Settings are separate
      // preserved files and the real provider Settings in DSH home.
      await writeFile(patchPath, '[]\n');
      await writeFile(join(profile, 'retained-other-settings.json'), '{"retained":true}');
      retainedReceipt = await readFile(join(state, '.agentkit-runtime.json'));
      await rm(join(profile, '.agentkit-runtime-profile.json'));
      await rm(join(profile, 'node_modules'), { recursive: true });
      await symlink(await realpath(join(installation, 'node_modules')), join(profile, 'node_modules'), 'dir');
      check('exact-legacy-profile-layout-retains-real-history-and-overdue-schedule', { sameBundleSha256: bundleSha256, sessionId, scheduleId: scheduled.id });
    }
    stage = 'restart-automatic-launch'; const restarted = await start('restarted');
    if (profileMigration) {
      const migratedPatch = await readFile(join(profile, 'cordis.patch.yml'), 'utf8');
      assert.deepEqual(parseYaml(migratedPatch), parseYaml(retainedPatch));
      retainedPatch = migratedPatch;
      assert.equal(await readFile(join(state, 'dsh/cordis.patch.yml'), 'utf8'), retainedHomePatch);
      assert.deepEqual(await readFile(join(state, '.agentkit-runtime.json')), retainedReceipt);
      assert.equal(await readFile(join(profile, 'retained-other-settings.json'), 'utf8'), '{"retained":true}');
      assert.equal((await readdir(join(state, 'dsh/profiles'))).filter(name => name.startsWith('.previous-')).length, 1);
      const backup = (await readdir(join(state, 'dsh/profiles'))).find(name => name.startsWith('.previous-'));
      assert.equal(await readFile(join(state, 'dsh/profiles', backup, 'cordis.patch.yml'), 'utf8'), '[]\n');
      check('legacy-launcher-profile-migrates-to-owned-code-with-rollback-and-settings');
    }
    assert.notEqual(report.processes[0].launcherPid, restarted.launcherPid);
    // The first restored Session access must be the native scheduler. Poll the
    // isolated file, not snapshot/submit/native-open/ensure, until its write ran.
    await until(async () => { try { return await readFile(join(workspace, plans[1].file), 'utf8') === plans[1].text; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }, 'restored schedule automatic write');
    const restored = await until(async () => { const value = await api('snapshot'); return value.status === 'completed' && value.events.some(event => event.type === 'user/message' && event.data.source?.kind === 'schedule') ? value : null; }, 'restored schedule completion');
    assertManagedSnapshot(restored);
    assert.deepEqual(restored.identity, { assistantName: '启动验证', ownerName: '隔离测试' });
    const restoredSchedule = (await api('schedule-list')).items.find(item => item.id === scheduled.id);
    assertRestoredSchedule({ schedule: restoredSchedule, created: scheduled, sessionId, snapshot: restored, startedAt: restarted.startedAt });
    assert.equal(count(plans[1].prompt), 2);
    assert.ok(requests.filter(item => item.prompt === plans[1].prompt).every(item => item.at >= restarted.startedAt));
    assert.equal(await readFile(join(workspace, plans[0].file), 'utf8'), plans[0].text);
    check('new-process-restores-due-native-schedule-without-session-prewarm', { scheduleId: scheduled.id, scheduledAt: scheduled.scheduledAt,
      deliveredAt: restoredSchedule.lastDelivery.deliveredAt, sameSessionId: true, preservedWorkspace: true, managedWriteCompleted: true });
    stage = 'durable-replay-after-restart';
    assert.equal((await api('submit', first)).accepted, true);
    assertReplayUnchanged(restored, await api('snapshot'), first.requestId);
    assert.equal(count(plans[0].prompt), beforeRestartCalls);
    check('durable-request-replay-after-process-restart-preserves-terminal-history');
    stage = 'continued-message-after-restart';
    const second = await api('submit', { requestId: 'automatic-restart-task', text: plans[2].prompt }); assert.equal(second.sessionId, sessionId);
    const continued = await until(async () => { const value = await api('snapshot'); return value.status === 'completed' && userEvent(value, 'automatic-restart-task') ? value : null; }, 'continued completion');
    assertManagedSnapshot(continued); assert.equal(continued.queuedCount, 0);
    assert.match(continued.messages.at(-1).text, /AUTOMATIC_STARTUP_DONE/);
    assert.equal(await readFile(join(workspace, plans[2].file), 'utf8'), plans[2].text);
    assert.ok(requests.find(item => item.prompt === plans[2].prompt)?.priorReply);
    assert.equal(count(plans[0].prompt), beforeRestartCalls); assert.equal(count(plans[1].prompt), 2); assert.equal(count(plans[2].prompt), 2);
    check('new-process-continues-original-history-and-native-managed-tools');
    if (profileMigration) {
      stage = 'same-bundle-image-code-refresh'; await stop();
      const markerPath = join(profile, '.agentkit-runtime-profile.json'), previousMarker = JSON.parse(await readFile(markerPath));
      // A private inert source file changes the installed image code digest;
      // all published archive files stay byte-identical throughout this probe.
      const sentinel = join(plugin, '.profile-code-upgrade-probe.mjs');
      await writeFile(sentinel, '// controlled image-code upgrade probe\n', { flag: 'wx' });
      await start('code-upgraded');
      const refreshedMarker = JSON.parse(await readFile(markerPath));
      assert.deepEqual(refreshedMarker.identity, previousMarker.identity);
      assert.notEqual(refreshedMarker.code.studioDigest, previousMarker.code.studioDigest);
      assert.equal(await readFile(join(profile, 'node_modules/@kingsoftcloud/agentkit-studio/.profile-code-upgrade-probe.mjs'), 'utf8'), '// controlled image-code upgrade probe\n');
      assert.deepEqual(await readFile(join(state, '.agentkit-runtime.json')), retainedReceipt);
      assert.equal(await readFile(join(profile, 'cordis.patch.yml'), 'utf8'), retainedPatch);
      assert.equal(await readFile(join(state, 'dsh/cordis.patch.yml'), 'utf8'), retainedHomePatch);
      const afterUpgrade = await api('snapshot');
      assert.deepEqual(afterUpgrade.events, continued.events); assert.deepEqual(afterUpgrade.identity, continued.identity);
      const afterSchedule = (await api('schedule-list')).items.find(item => item.id === scheduled.id);
      assert.equal(afterSchedule.lastDelivery.messageId, restoredSchedule.lastDelivery.messageId);
      assert.equal(afterSchedule.sessionId, sessionId);
      assert.equal((await readdir(join(state, 'dsh/profiles'))).filter(name => name.startsWith('.previous-')).length, 2);
      assert.equal(count(plans[1].prompt), 2, 'code refresh must not redeliver an expired schedule');
      check('same-bundle-image-code-refresh-retains-session-settings-and-delivery');
      await stop(); await rm(sentinel);
      // Boot once more without the sentinel: the verified owner marker permits
      // a code rollback, while retaining the same session and Settings.
      await start('code-rollback');
      assert.deepEqual((await api('snapshot')).events, continued.events);
      check('verified-image-code-rollback-preserves-original-session');
    }
    stage = 'shutdown'; await stop(); await verifyProfile('after-final-stop');
    assert.equal(count(plans[0].prompt), beforeRestartCalls, 'replayed work must not run later');
    assert.equal(count(plans[1].prompt), 2); assert.equal(count(plans[2].prompt), 2); assert.equal(modelFailure, undefined);
    await comparePackage(plugin, archiveFiles);
    check('all-launcher-processes-exit-after-sigterm-and-runtime-port-closes');
    report.passed = true;
  } catch (error) {
    report.failure = { stage, code: error.code || 'SMOKE_ASSERTION_FAILED', message: String(error.message).slice(0, 350) };
    if (host?.output) report.startupDiagnostic = host.output.replace(/token=[A-Za-z0-9_-]+/g, 'token=[redacted]').replace(/Bearer\s+[^\s"']+/g, 'Bearer [redacted]').slice(-5000);
    process.exitCode = 1;
  } finally {
    await stop().catch(error => { report.cleanupFailure = { code: error.code || 'SHUTDOWN_FAILED', message: error.message.slice(0, 200) }; process.exitCode = 1; report.passed = false; });
    model.closeAllConnections(); if (model.listening) await new Promise(resolve => model.close(resolve));
    report.modelRequests = requests; report.auxiliaryModelCalls = count('auxiliary');
    if (modelFailure) { report.modelFailure = modelFailure; report.passed = false; process.exitCode = 1; }
    report.fixtureStateRemoved = false;
    if (report.passed) { await rm(root, { recursive: true }); report.fixtureStateRemoved = true; }
    else report.privateFixtureRoot = root;
    await mkdir(dirname(target), { recursive: true }); await writeFile(target, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, failure: report.failure, target }));
  }
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runAutomaticStartupSmoke(parseSmokeOptions(process.argv.slice(2)));
}
