import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const archive = process.argv[2];
const source = join(archive, 'dsh/node_modules/@kingsoftcloud/agentkit-studio/src');
const { createStarHarnessReleases } = await import(pathToFileURL(join(source, 'host/services/star-harness-release.mjs')));
const root = await mkdtemp(join(tmpdir(), 'studio-win-probe-'));
try {
  const runtime = join(process.resourcesPath, 'runtime');
  const dependencies = join(runtime, 'primary-runtime', 'dependencies');
  const pnpm = join(dependencies, 'pnpm', 'bin', 'pnpm.mjs');
  const bundledNode = join(dependencies, 'node', 'bin', 'node.exe');
  const releases = createStarHarnessReleases({ directory: join(root, 'releases'),
    packageManager: { command: process.execPath, args: ['--expose-internals', pnpm], env: {
      DSH_DESKTOP_NODE_EXECUTABLE: process.execPath,
      PATH: join(runtime, 'bin') + delimiter + (process.env.PATH ?? ''),
      pnpm_config_pm_on_fail: 'ignore',
    } } });
  const worker = join(source, 'host/services/star-harness-worker.mjs');
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const materialized = join(root, 'worker.mjs');
  const workerSource = readFileSync(worker, 'utf8');
  await writeFile(materialized, workerSource);
  console.log(JSON.stringify({ electron: process.versions.electron, bundledNode: existsSync(bundledNode) }));
  const version = '0.0.28';
  const packageDirectory = await releases.install(version);
  const common = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    /^(?:PATH|HOME|LANG|LC_ALL|TMPDIR|USER|LOGNAME|SHELL|SystemRoot|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|NODE_EXTRA_CA_CERTS)$/i.test(name)));
  for (const [mode, entry, execPath, execArgv] of [
    ['official', worker, existsSync(bundledNode) ? bundledNode : process.execPath,
      existsSync(bundledNode) ? ['--input-type=module', '--eval', workerSource, '--'] : []],
    ['file', materialized, existsSync(bundledNode) ? bundledNode : process.execPath, []],
  ]) {
    const child = fork(entry, [packageDirectory, '--workspace', workspace, '--state-dir', join(root, mode), '--agent', 'fixture'], {
      execPath, execArgv, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: { ...common, ...(execPath === process.execPath ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
        AGENTKIT_ENGINE_SERVICE_TOKEN: randomUUID(), AGENTKIT_ENGINE_MODEL_BASE_URL: 'http://127.0.0.1:1/v1',
        AGENTKIT_ENGINE_MODEL_API_KEY: 'fixture', AGENTKIT_ENGINE_MODEL_NAME: 'fixture', AGENTKIT_ENGINE_MODEL_PROTOCOL: 'openai-chat',
      },
    });
    let stderr = '', ready = false;
    child.stderr.on('data', chunk => { if (stderr.length < 12000) stderr += String(chunk).slice(0, 12000 - stderr.length); });
    child.on('message', message => { ready = Number.isInteger(message.port); if (child.connected) child.disconnect(); });
    const timer = setTimeout(() => child.kill(), 15000);
    const outcome = await new Promise(resolve => {
      child.once('error', error => resolve({ error: error.code, detail: error.message }));
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    clearTimeout(timer);
    console.log(JSON.stringify({ version, mode, ready, ...outcome, stderr }));
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
