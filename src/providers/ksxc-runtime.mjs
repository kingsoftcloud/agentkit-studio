import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';
import { probeKsxcPayload } from './ksxc-probe.mjs';
import { createAppServerRuntime } from './app-server-runtime.mjs';
import { KsxcRuntimeError, prepareKsxcHome, resolveKsxcCommand } from './ksxc-command.mjs';

const SYSTEM_ENV = ['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL'];
const SHELL_CONFIG = [
  '-c', 'shell_environment_policy.inherit="none"',
  '-c', 'shell_environment_policy.exclude=["KSXC_*","*TOKEN*","*SECRET*","*KEY*"]',
  '-c', 'shell_environment_policy.experimental_use_profile=false',
];
const TOOL_OUTCOME_INSTRUCTIONS = '只依据实际工具结果报告操作状态。工具未绑定、失败、退出码非零或结果未确认时，请明确说明。不得把失败的调用描述为成功，也不得从失败结果推断文件或内容。';

function classifyError(message) {
  if (/\b401\b|unauthorized|invalid (?:credential|token)/i.test(message)) {
    return new KsxcRuntimeError('KSXC_CONNECTION_EXPIRED', 'KSXC 企业连接已失效，请重新授权。');
  }
  if (/\b403\b|ModelForbidden/i.test(message)) {
    return new KsxcRuntimeError('KSXC_MODEL_FORBIDDEN', '当前账号无权使用此模型，请重新选择。');
  }
  if (/\b429\b/i.test(message)) return new KsxcRuntimeError('KSXC_MODEL_RATE_LIMITED', 'KSXC 模型服务限流，请稍后重试。');
  if (/目录为空|可用模型为空|(?:model list|catalog) is empty|returned an empty catalog|no (?:available )?models/i.test(message)) {
    return new KsxcRuntimeError('KSXC_CATALOG_EMPTY', '这个 KSXC 账号还没有可用模型。');
  }
}

function assertKsxcThreadModel(result, model) {
  if (result?.modelProvider !== 'ksxc' || result?.model !== model) {
    throw new KsxcRuntimeError('KSXC_MODEL_MISMATCH', 'KSXC 实际使用的服务商或模型与所选模型不一致，请重新选择。');
  }
}

export function ksxcCatalogModels(models) {
  const visible = models.flatMap(entry => {
    if (entry?.hidden || typeof entry?.model !== 'string' || !entry.model.trim()) return [];
    return [{ id: entry.model, name: typeof entry.displayName === 'string' && entry.displayName || entry.model, provider: 'ksxc' }];
  });
  return [...new Map(visible.map(model => [model.id, model])).values()];
}

export function assertKsxcCatalogModel(models, model) {
  if (!models.length) throw new KsxcRuntimeError('KSXC_CATALOG_EMPTY', '这个 KSXC 账号还没有可用模型。');
  if (!models.some(item => item.id === model)) throw new KsxcRuntimeError('KSXC_MODEL_FORBIDDEN', '请从当前 KSXC 企业账号的模型目录中重新选择。');
}

export function ksxcEnvironment(home, token, env = process.env) {
  return {
    ...Object.fromEntries(SYSTEM_ENV.filter(key => env[key] !== undefined).map(key => [key, env[key]])),
    HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home, XDG_DATA_HOME: home, XDG_CACHE_HOME: home,
    KSXC_HOME: home, CODEX_HOME: home, KSXC_DISABLE_UPDATE: '1',
    ...(token ? { KSXC_AUTH_TOKEN: token } : {}),
  };
}

export function createKsxcRuntime({ commandFor, connectionFor, companyConfig, companyConfigPath, stateRoot, env = process.env, ...options }) {
  const verifiedModel = new AsyncLocalStorage();
  const toolPath = [...new Set([
    ...String(env.PATH || env.Path || '').split(delimiter).filter(isAbsolute),
    ...(process.platform === 'win32' ? [] : ['/usr/bin', '/bin', '/usr/sbin', '/sbin']),
  ])].join(delimiter);
  // The tool shell inherits no process environment. Restore its executable
  // search path explicitly without forwarding the WPS credential or home.
  const configArgs = [...SHELL_CONFIG, ...(toolPath ? ['-c', `shell_environment_policy.set.PATH=${JSON.stringify(toolPath)}`] : [])];
  async function* withConnection(input, operation) {
    if (!isAbsolute(stateRoot)) throw new TypeError('KSXC state root must be absolute');
    input.signal?.throwIfAborted();
    const command = await commandFor();
    const payload = await command.validate();
    const connection = await connectionFor({ userId: input.userId, signal: input.signal });
    if (!connection?.token || !connection?.accountId) {
      throw new KsxcRuntimeError('KSXC_CONNECTION_REQUIRED', '请先连接你自己的 KSXC 企业账号。');
    }
    input.signal?.throwIfAborted();
    const scope = createHash('sha256').update(JSON.stringify([input.userId, connection.accountId, input.agentId, input.cwd])).digest('hex');
    const directory = join(stateRoot, scope);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const home = await mkdtemp(join(directory, 'turn-'));
    try {
      await prepareKsxcHome({ home, companyConfig, companyConfigPath });
      const runtime = createAppServerRuntime({
        ...options, env: ksxcEnvironment(home, connection.token, env), inheritEnv: false, cwd: home,
        sandbox: 'read-only', configArgs, awaitProcessExit: true,
      }, {
        id: 'ksxc', label: 'KSXC', ErrorClass: KsxcRuntimeError, command, classifyError,
        verifyModel(result, model) {
          assertKsxcThreadModel(result, model);
          if (payload?.integrityVerified) input.onRuntimeVerified?.({ runtime: 'ksxc', provider: result.modelProvider,
            model: result.model, binarySha256: payload.sha256, ...(command.version ? { version: command.version } : {}) });
        },
        admitModel: (catalog, model) => assertKsxcCatalogModel(ksxcCatalogModels(catalog), model),
      });
      yield* operation(runtime);
    } finally {
      await rm(home, { recursive: true, force: true, maxRetries: 3 });
    }
  }
  const list = async (runtime, signal) => {
    try { return ksxcCatalogModels(await runtime.listModels({ signal })); }
    catch (error) {
      if (error?.code === 'KSXC_CATALOG_EMPTY') return [];
      throw error;
    }
  };
  return {
    withVerifiedModel: (id, run) => verifiedModel.run({ provider: 'ksxc', id, name: id }, run),
    verifiedModel: () => verifiedModel.getStore(),
    async listModels({ userId, signal } = {}) {
      for await (const models of withConnection({ userId, signal }, async function* (runtime) {
        yield await list(runtime, signal);
      })) return models;
      return [];
    },
    async *stream(input = {}) {
      if (input.modelProvider || typeof input.model !== 'string' || !input.model.trim()) {
        throw new KsxcRuntimeError('KSXC_MODEL_INVALID', '请选择当前 KSXC 企业账号的模型。');
      }
      if (input.sandbox === 'danger-full-access') {
        throw new KsxcRuntimeError('KSXC_SANDBOX_REQUIRED', 'KSXC 使用企业模型凭证，工具需在沙箱中运行。请选择「仅可查看」或「工作区内修改」。');
      }
      const systemPrompt = [String(input.systemPrompt || '').trim(), TOOL_OUTCOME_INSTRUCTIONS].filter(Boolean).join('\n\n');
      yield* withConnection(input, runtime => runtime.stream({ ...input, systemPrompt }));
    },
  };
}

// Retain the DSH base adapter methods, including its retry policy and
// attachment support. The global managed directory never contains a caller's
// models; selection sees only the authorized model scoped to the active run.
export function createKsxcModelAdapter({ adapter, runtime, desktopUser }) {
  return Object.assign(Object.create(Object.getPrototypeOf(adapter)), adapter, {
    providerInfo: () => ({ id: 'ksxc', name: 'KSXC' }),
    async listModels() {
      if (desktopUser) return runtime.listModels({ userId: desktopUser });
      const model = runtime.verifiedModel();
      return model ? [model] : [];
    },
  });
}

export function createManagedKsxcCommand(env = process.env) {
  return resolveKsxcCommand({ env, companyConfigPath: env.AGENTKIT_KSXC_COMPANY_CONFIG_PATH });
}

export async function verifyManagedKsxcPayload(env = process.env) {
  const command = createManagedKsxcCommand(env);
  const payload = await command.validate();
  const report = await probeKsxcPayload({ executable: command.executable, expectedSha256: payload.sha256 });
  if (!report.version.detected || (env.AGENTKIT_KSXC_VERSION && report.version.detected !== env.AGENTKIT_KSXC_VERSION)) {
    throw new KsxcRuntimeError('KSXC_VERSION_MISMATCH', '已安装的 KSXC 版本与镜像声明不一致。');
  }
  return { version: report.version.detected, sha256: report.payloadSha256 };
}
