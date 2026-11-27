/** Verify a published Harness release with the packaged Studio and Electron. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const [target, requestedVersion] = process.argv.slice(2);
assert.ok(target, 'Pass a packaged macOS app or Windows executable');

async function verifyApprovedCommand(load, root, runtime, version) {
  const { createNativeEngineRuntime } = await load('providers/native-engine-runtime.mjs');
  const { startStarHarness } = await load('host/services/star-harness-release.mjs');
  const { compareStarHarnessVersions } = await load('host/services/star-harness-catalog.mjs');
  const desktopSandbox = compareStarHarnessVersions(version, '0.0.34') >= 0;
  const workspace = join(root, 'workspace');
  const confinedFile = join(workspace, 'confined.txt');
  const markerFile = join(desktopSandbox ? root : workspace, 'approval.txt');
  await mkdir(workspace);
  const modelName = 'desktop-approval-fixture';
  const apiKey = 'desktop-approval-fixture';
  let requests = 0;
  const model = createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain the fixture request */ }
    const step = requests++;
    const command = desktopSandbox ? [
      { command: 'printf confined >> confined.txt' },
      { command: 'printf approved >> ../approval.txt', sandbox_permissions: 'danger-full-access' },
    ][step] : step === 0 ? { command: 'printf approved >> approval.txt' } : undefined;
    const delta = command ? { role: 'assistant', tool_calls: [{ index: 0, id: `approval-step-${step}`, type: 'function',
      function: { name: 'run_command', arguments: JSON.stringify({ ...command, timeout: 8 }) } }] }
      : { role: 'assistant', content: 'Approved command completed.' };
    const frame = (delta, finish_reason) => `data: ${JSON.stringify({ id: 'desktop-approval-' + requests,
      object: 'chat.completion.chunk', model: modelName, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(frame(delta, null) + frame({}, command ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n');
  });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${model.address().port}/v1`;
  let service;
  try {
    service = await startStarHarness({ packageDirectory: runtime, version, workspaceRoot: workspace,
      stateDir: join(root, 'engine'), profile: { modelName, baseUrl, apiKey } });
    assert.equal(service.version, version);
    // Harness local commands are supported on macOS. Windows still verifies
    // that the signed, separately installed worker launches and handshakes.
    if (process.platform !== 'darwin') return;
    const studio = createNativeEngineRuntime({ stateRoot: join(root, 'studio-state'), env: {
      AGENTKIT_ENGINE_SERVICE_URL: service.endpoint, AGENTKIT_ENGINE_SERVICE_TOKEN: service.token,
      AGENTKIT_ENGINE_SERVICE_WORKSPACE: workspace, AGENTKIT_ENGINE_SERVICE_MODEL: modelName,
    } });
    let approvals = 0;
    const results = [];
    for await (const result of studio.stream({ cwd: workspace, sessionId: 'desktop-approval', turnId: 'first',
      input: 'Use the terminal to append a marker to approval.txt.', model: modelName, modelProvider: { baseUrl, apiKey },
      sandbox: 'workspace-write', signal: AbortSignal.timeout(25000), requestApproval: async request => {
        assert.equal(request.toolName, 'native/run_command');
        await assert.rejects(readFile(markerFile), { code: 'ENOENT' });
        if (desktopSandbox) assert.equal(await readFile(confinedFile, 'utf8'), 'confined');
        approvals++;
        return 'allowed-once';
      },
    })) results.push(result);
    assert.equal(approvals, 1);
    assert.equal(requests, desktopSandbox ? 3 : 2);
    assert.equal(await readFile(markerFile, 'utf8'), 'approved');
    assert.deepEqual(results.filter(chunk => chunk.event?.kind === 'tool.completed').map(chunk => chunk.event.status),
      desktopSandbox ? ['ok', 'ok'] : ['ok']);
    assert.equal(results.findLast(chunk => chunk.type === 'text')?.text, 'Approved command completed.');
  } finally {
    await service?.stop();
    await new Promise(resolve => { model.closeAllConnections(); model.close(resolve); });
  }
}

if (process.versions.electron) {
  const studioSource = join(target, 'dsh/node_modules/@kingsoftcloud/agentkit-studio/src');
  const load = path => import(pathToFileURL(join(studioSource, path)));
  const { fetchStarHarnessProof, starHarnessVersion, verifyStarHarnessProof } = await load('host/services/star-harness-catalog.mjs');
  const root = await mkdtemp(join(tmpdir(), 'studio-harness-release-'));
  const cachePath = join(root, 'trust');
  try {
    const support = join(process.resourcesPath, 'runtime');
    const pnpm = join(support, 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs');
    const packageManager = { command: process.execPath, args: ['--expose-internals', pnpm], env: {
      DSH_DESKTOP_NODE_EXECUTABLE: process.execPath,
      PATH: join(support, 'bin') + delimiter + (process.env.PATH ?? ''),
      pnpm_config_pm_on_fail: 'ignore',
    } };
    const { createStarHarnessReleases } = await load('host/services/star-harness-release.mjs');
    const store = createStarHarnessReleases({ directory: join(root, 'releases'), packageManager });
    const version = requestedVersion ?? await store.latest();
    assert.ok(starHarnessVersion(version), 'A published and signed StarOrigin Harness version is required');
    const proof = await fetchStarHarnessProof(version, { fetchImpl: fetch });
    const release = await verifyStarHarnessProof(version, proof, { cachePath });
    assert.equal(release.packages['@kingsoftcloud/agentkit-harness-node'].version, version);
    assert.equal(release.packages['@kingsoftcloud/agentkit-harness-ui'].version, version);
    const altered = structuredClone(proof);
    const signedEntry = altered.bundle.verificationMaterial.tlogEntries.find(entry => entry.inclusionPromise);
    const timestamp = Buffer.from(signedEntry.inclusionPromise.signedEntryTimestamp, 'base64');
    timestamp[timestamp.length - 1] ^= 1;
    signedEntry.inclusionPromise.signedEntryTimestamp = timestamp.toString('base64');
    await assert.rejects(verifyStarHarnessProof(version, altered, { cachePath, offline: true }),
      { code: 'TLOG_INCLUSION_PROMISE_ERROR' });
    await assert.rejects(verifyStarHarnessProof(version, { ...proof, manifest: Buffer.from('{}').toString('base64') },
      { cachePath, offline: true }), /differs from the attested artifact/);
    await verifyApprovedCommand(load, root, await store.install(version), version);
    console.log(`Electron ${process.versions.electron} validated the signed StarOrigin Harness ${version} release`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
} else {
  const app = resolve(target);
  const executable = process.platform === 'darwin' ? join(app, 'Contents/MacOS/AgentKit Studio') : app;
  const archive = process.platform === 'darwin' ? join(app, 'Contents/Resources/app.asar')
    : join(dirname(app), 'resources/app.asar');
  const { stdout, stderr } = await promisify(execFile)(executable, [fileURLToPath(import.meta.url), archive, ...(requestedVersion === undefined ? [] : [requestedVersion])], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 240000,
  });
  assert.match(stdout, /validated the signed StarOrigin Harness/);
  process.stdout.write(stdout);
  process.stderr.write(stderr);
}
