import { execFile, fork } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { connectEngineService, ENGINE_COMMAND_VERIFIER, ENGINE_VERIFICATION } from '../../providers/engine-service-client.mjs';
import { ENGINE_PROTOCOL } from '../../providers/engine-protocol-client.mjs';

export const STAR_HARNESS_PACKAGE = '@kingsoftcloud/agentkit-harness-node';
export const STAR_HARNESS_REGISTRY = 'https://registry.npmjs.org';
export const starHarnessVersion = version => typeof version === 'string' && /^\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(version);
export const starHarnessError = (code, message) => Object.assign(new Error(message), { code });
const run = promisify(execFile);
const workerEntry = fileURLToPath(new URL('./star-harness-worker.mjs', import.meta.url));

function childEnvironment(env) {
  const names = /^(?:PATH|HOME|LANG|LC_ALL|TMPDIR|USER|LOGNAME|SHELL|SystemRoot|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|NODE_EXTRA_CA_CERTS)$/i;
  return Object.fromEntries(Object.entries(env).filter(([name]) => names.test(name)));
}

function npmCommand(env) {
  if (process.platform !== 'win32') return ['npm'];
  const directories = [dirname(process.execPath), ...String(env.Path ?? env.PATH ?? '').split(delimiter)];
  const cli = directories.filter(Boolean).map(dir => join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js')).find(existsSync);
  if (!cli) throw starHarnessError('STAR_HARNESS_NPM_MISSING', 'Studio 宿主找不到 npm，请安装 Node.js 和 npm 后重试。');
  return [process.execPath, cli];
}

export function createStarHarnessReleases({ directory, env = process.env, packageManager, fetchImpl = fetch } = {}) {
  const revision = version => join(directory, version);
  const entry = folder => join(folder, 'node_modules', STAR_HARNESS_PACKAGE);
  const assertRelease = async (folder, version) => {
    const manifest = JSON.parse(await readFile(join(entry(folder), 'package.json'), 'utf8'));
    if (manifest.name !== STAR_HARNESS_PACKAGE || manifest.version !== version)
      throw starHarnessError('STAR_HARNESS_RELEASE_INVALID', '下载的 Star Harness 版本与请求不一致。');
    return entry(folder);
  };
  return {
    entry: version => assertRelease(revision(version), version),
    async latest(signal) {
      const response = await fetchImpl(STAR_HARNESS_REGISTRY + '/' + encodeURIComponent(STAR_HARNESS_PACKAGE) + '/latest',
        { signal: AbortSignal.any([AbortSignal.timeout(6000), signal].filter(Boolean)), redirect: 'error' });
      if (!response.ok) { await response.body?.cancel(); throw Error('registry unavailable'); }
      const release = await response.json();
      if (release.name !== STAR_HARNESS_PACKAGE || !starHarnessVersion(release.version)) throw Error('registry release invalid');
      return release.version;
    },
    async install(version, signal) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      try { return await assertRelease(revision(version), version); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const stage = await mkdtemp(join(directory, '.install-'));
      try {
        const config = join(stage, '.npmrc');
        await writeFile(config, '', { mode: 0o600 });
        await writeFile(join(stage, 'package.json'), JSON.stringify({ name: 'studio-star-harness-runtime', version: '1.0.0', private: true }), { mode: 0o600 });
        try {
          const [command, ...prefix] = packageManager ? [packageManager.command, ...packageManager.args] : npmCommand(env);
          const installArgs = packageManager ? ['add', '--ignore-workspace'] : ['install', '--no-audit', '--no-fund'];
          await run(command, [...prefix, ...installArgs, '--save-exact', '--ignore-scripts',
            '--registry=' + STAR_HARNESS_REGISTRY, STAR_HARNESS_PACKAGE + '@' + version,
          ], {
            cwd: stage, signal, timeout: 180000, windowsHide: true,
            env: { ...childEnvironment(env), ...packageManager?.env,
              ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
              npm_config_fetch_retries: '1', npm_config_userconfig: config,
              npm_config_globalconfig: join(stage, '.npmrc-global') },
          });
        } catch (error) {
          signal?.throwIfAborted();
          if (error.code === 'STAR_HARNESS_NPM_MISSING') throw error;
          if (error.code === 'ENOENT') throw starHarnessError('STAR_HARNESS_NPM_MISSING', 'Studio 宿主找不到 npm，请安装 Node.js 和 npm 后重试。');
          throw starHarnessError('STAR_HARNESS_DOWNLOAD_FAILED', 'Star Harness 下载失败，请检查 npm 网络连接和版本号。');
        }
        await assertRelease(stage, version);
        signal?.throwIfAborted();
        try { await rename(stage, revision(version)); }
        catch (error) {
          if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code)) throw error;
        }
        return await assertRelease(revision(version), version);
      } finally { await rm(stage, { recursive: true, force: true }); }
    },
  };
}

export async function inspectStarHarness(connection, { version, signal, required = false } = {}) {
  const check = AbortSignal.any([AbortSignal.timeout(7000), signal].filter(Boolean));
  const engine = connectEngineService({ ...connection, sessionId: 'studio-star-harness-inspect', observeOnly: !required,
    ...(required ? { onApproveTool: async () => 'deny', onVerifyGoal: async () => ({}) } : {}),
    fetchImpl: (url, options) => (connection.fetchImpl ?? fetch)(url, {
      ...options, signal: AbortSignal.any([check, options.signal].filter(Boolean)),
    }) });
  const abort = () => void engine.close().catch(() => {});
  check.addEventListener('abort', abort, { once: true });
  try {
    check.throwIfAborted();
    const hello = await engine.initialize();
    if (hello.protocolVersion !== ENGINE_PROTOCOL || required && (hello.engine?.name !== STAR_HARNESS_PACKAGE
      || hello.engine?.version !== version || hello.capabilities?.hostVerification !== ENGINE_VERIFICATION
      || hello.capabilities?.workspaceCommandVerification !== ENGINE_COMMAND_VERIFIER
      || hello.capabilities?.approvals !== 'durable'))
      throw starHarnessError('STAR_HARNESS_INCOMPATIBLE', '此 Star Harness 版本与当前 Studio 不兼容。');
    return { version: hello.engine?.version ?? null, images: Number(hello.capabilities?.inputImages?.maxCount) > 0 };
  } finally {
    check.removeEventListener('abort', abort);
    await engine.close();
  }
}

export async function startStarHarness({ packageDirectory, version, workspaceRoot, stateDir, profile, env = process.env, signal }) {
  signal?.throwIfAborted();
  const token = randomBytes(32).toString('base64url');
  const search = Object.fromEntries(Object.entries(env).filter(([name]) =>
    /^(?:(?:AGENTKIT_ENGINE|KSADK|OPENCLAW)_WEB_SEARCH_(?:PROVIDER|BASE_URL|API_KEY|SCOPE)|KSADK_MCP_KEY|KSC_AIPRO_API_KEY|KSC_AIPRO_APIKEY|AIPRO_API_KEY)$/.test(name)));
  const child = fork(workerEntry, [packageDirectory, '--workspace', workspaceRoot, '--state-dir', stateDir,
    '--agent', 'studio-local-harness'], {
    execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: { ...childEnvironment(env), ...search, ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
      AGENTKIT_ENGINE_SERVICE_TOKEN: token, AGENTKIT_ENGINE_MODEL_BASE_URL: profile.baseUrl,
      AGENTKIT_ENGINE_MODEL_API_KEY: profile.apiKey, AGENTKIT_ENGINE_MODEL_NAME: profile.modelName,
      AGENTKIT_ENGINE_MODEL_PROTOCOL: profile.protocol || 'openai-chat',
      ...(profile.images ? { AGENTKIT_ENGINE_MODEL_IMAGES: '1' } : {}),
      ...(profile.contextWindow ? { AGENTKIT_ENGINE_MODEL_CONTEXT_WINDOW: String(profile.contextWindow) } : {}),
      ...(profile.maxOutputTokens ? { AGENTKIT_ENGINE_MODEL_MAX_OUTPUT_TOKENS: String(profile.maxOutputTokens) } : {}),
      ...(env.KSADK_MODEL_COMPAT_RULE ? { AGENTKIT_ENGINE_MODEL_COMPAT_RULE: env.KSADK_MODEL_COMPAT_RULE } : {}),
    },
  });
  let alive = true;
  const ready = new Promise(resolve => child.once('message', resolve));
  const closed = new Promise(resolve => {
    child.once('exit', () => { alive = false; resolve(); });
    child.once('error', () => { alive = false; resolve(); });
  });
  const stop = async () => {
    if (alive && child.connected) child.disconnect();
    const timer = setTimeout(() => child.kill('SIGKILL'), 4000);
    timer.unref();
    try { await closed; } finally { clearTimeout(timer); }
  };
  const check = AbortSignal.any([AbortSignal.timeout(12000), signal].filter(Boolean));
  try {
    const readyOrExit = await new Promise((resolve, reject) => {
      const aborted = () => reject(check.reason);
      check.addEventListener('abort', aborted, { once: true });
      Promise.race([ready, closed]).then(resolve);
      Promise.race([ready, closed]).finally(() => check.removeEventListener('abort', aborted));
      if (check.aborted) aborted();
    });
    if (!Number.isInteger(readyOrExit?.port) || readyOrExit.port < 1 || readyOrExit.port > 65535 || !alive) throw Error('engine not listening');
    const connection = { endpoint: 'http://127.0.0.1:' + readyOrExit.port, token };
    const info = await inspectStarHarness(connection, { version, signal: check, required: true });
    return { ...connection, ...info, get alive() { return alive; }, stop };
  } catch (error) {
    await stop();
    signal?.throwIfAborted();
    if (error.code === 'STAR_HARNESS_INCOMPATIBLE') throw error;
    if (error.code === 'NATIVE_ENGINE_VERIFICATION_UNAVAILABLE')
      throw starHarnessError('STAR_HARNESS_INCOMPATIBLE', '此 Star Harness 版本与当前 Studio 不兼容。');
    throw starHarnessError('STAR_HARNESS_START_FAILED', 'Star Harness 服务启动或握手失败。');
  }
}

export async function probeStarHarness({ root, packageDirectory, version, env, signal }) {
  const area = await mkdtemp(join(root, '.probe-'));
  try {
    const workspaceRoot = join(area, 'project');
    await mkdir(workspaceRoot);
    const process = await startStarHarness({ packageDirectory, version, workspaceRoot, stateDir: join(area, 'state'),
      profile: { modelName: 'studio-install-probe', baseUrl: 'http://127.0.0.1:1/v1', apiKey: randomUUID() }, env, signal });
    await process.stop();
  } finally {
    await rm(area, { recursive: true, force: true });
  }
}
