/** Resolve only the explicitly configured KSXC payload. Never substitute Codex. */
import { constants, createReadStream } from 'node:fs';
import { access, readFile, stat, lstat, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { AppServerRuntimeError } from './app-server-runtime.mjs';

// This names the Studio client compatibility profile. It is not a wire-version
// field claimed by initialize, nor evidence that a KSXC release passed M0.
export const KSXC_PROTOCOL_PROFILE = 'codex-app-server/v1';

export class KsxcRuntimeError extends AppServerRuntimeError {
  constructor(code, message, details = {}) {
    super(code, message, details);
    this.name = 'KsxcRuntimeError';
  }
}

function companyUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

/** Read only an explicitly selected company file; never discover account directories. */
export async function readKsxcCompanyConfig({ companyConfigPath, env = {} } = {}) {
  const source = String(companyConfigPath ?? env.AGENTKIT_KSXC_COMPANY_CONFIG_PATH ?? '').trim();
  if (!source || !isAbsolute(source)) throw new KsxcRuntimeError('KSXC_COMPANY_CONFIG_UNAVAILABLE',
    'KSXC 需要显式的企业配置路径。');
  let config;
  try { config = JSON.parse(await readFile(source, 'utf8')); }
  catch { throw new KsxcRuntimeError('KSXC_COMPANY_CONFIG_UNAVAILABLE', '无法读取指定的 KSXC 公司配置。'); }
  if (!config || typeof config !== 'object' || Array.isArray(config)
    || !companyUrl(config.baseUrl) || !companyUrl(config.installerUrl)
    || typeof config.code !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(config.code)) {
    throw new KsxcRuntimeError('KSXC_COMPANY_CONFIG_INVALID', 'KSXC 公司配置必须包含合法的 baseUrl、code 和 installerUrl，URL 不得包含凭证。');
  }
  // Account tokens and unknown fields are intentionally not projected.
  return { baseUrl: config.baseUrl, code: config.code, installerUrl: config.installerUrl };
}

/** Copy the non-secret company projection into an explicitly owned isolated home. */
export async function prepareKsxcHome({ home, companyConfig: pinnedCompany, companyConfigPath, env = {} } = {}) {
  if (typeof home !== 'string' || !isAbsolute(home)) throw new KsxcRuntimeError('KSXC_COMPANY_CONFIG_INVALID',
    'KSXC 隔离 home 必须是显式绝对路径。');
  const companyConfig = pinnedCompany ?? await readKsxcCompanyConfig({ companyConfigPath, env });
  await mkdir(home, { recursive: true, mode: 0o700 });
  const directory = await lstat(home);
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new KsxcRuntimeError('KSXC_COMPANY_CONFIG_INVALID',
    'KSXC 隔离 home 必须是目录，不能是符号链接。');
  const configPath = join(home, 'config.json');
  const staging = join(home, `.company-${randomUUID()}.tmp`);
  try {
    await writeFile(staging, JSON.stringify(companyConfig) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(staging, configPath);
  } finally { await rm(staging, { force: true }); }
  return { home, configPath, companyConfig };
}

export function resolveKsxcCommand({ executable, expectedSha256, protocolProfile, env = process.env,
  companyConfigPath, allowedTargets, platform = process.platform, arch = process.arch } = {}) {
  const configured = String(executable ?? env.AGENTKIT_KSXC_EXECUTABLE ?? '').trim();
  const expected = String(expectedSha256 ?? env.AGENTKIT_KSXC_SHA256 ?? '').trim().toLowerCase();
  const profile = String(protocolProfile ?? env.AGENTKIT_KSXC_PROTOCOL_PROFILE ?? '').trim();
  const target = `${platform}-${arch}`;
  return {
    executable: configured,
    prefixArgs: [],
    async validate({ requireProtocol = true, requireCompanyConfig = true } = {}) {
      if (!configured) throw new KsxcRuntimeError('RUNTIME_PROFILE_UNAVAILABLE',
        '尚未配置 KSXC 二进制。请设置 AGENTKIT_KSXC_EXECUTABLE 或显式 executable。');
      if (!isAbsolute(configured)) throw new KsxcRuntimeError('KSXC_PAYLOAD_INVALID',
        'KSXC 二进制必须使用显式绝对路径，不能通过 PATH 或 Codex 回退。');
      if (!/^[a-f0-9]{64}$/.test(expected)) throw new KsxcRuntimeError('KSXC_PAYLOAD_INVALID',
        'KSXC expectedSha256 必须是 64 位十六进制 SHA-256。');
      // A target matrix is release evidence supplied by the caller, not inferred
      // from a product name or an outdated operating-system support claim.
      if (allowedTargets !== undefined && (!Array.isArray(allowedTargets)
        || !allowedTargets.length || allowedTargets.some(value => typeof value !== 'string'))) {
        throw new KsxcRuntimeError('KSXC_PAYLOAD_INVALID', 'KSXC allowedTargets 必须是非空目标列表。');
      }
      if (allowedTargets && !allowedTargets.includes(target)) throw new KsxcRuntimeError('RUNTIME_UNSUPPORTED',
        `配置的 KSXC payload 不支持当前目标 ${target}。`, { target });
      let metadata;
      try {
        metadata = await stat(configured);
        await access(configured, platform === 'win32' ? constants.F_OK : constants.X_OK);
      } catch {
        throw new KsxcRuntimeError('RUNTIME_PROFILE_UNAVAILABLE', '配置的 KSXC 二进制不存在或不可执行。');
      }
      if (!metadata.isFile()) throw new KsxcRuntimeError('KSXC_PAYLOAD_INVALID', 'KSXC payload 必须是可执行文件。');
      let actual;
      if (expected) {
        try {
          const hash = createHash('sha256');
          for await (const chunk of createReadStream(configured)) hash.update(chunk);
          actual = hash.digest('hex');
        }
        catch { throw new KsxcRuntimeError('RUNTIME_PROFILE_UNAVAILABLE', '无法读取配置的 KSXC payload。'); }
        if (actual !== expected) throw new KsxcRuntimeError('KSXC_PAYLOAD_INTEGRITY_FAILED',
          'KSXC payload 与配置的 SHA-256 不匹配。');
      }
      const compatibilityDeclared = profile === KSXC_PROTOCOL_PROFILE;
      if (requireProtocol && !compatibilityDeclared) throw new KsxcRuntimeError('RUNTIME_PROTOCOL_UNSUPPORTED',
        'KSXC 尚未声明受支持的客户端兼容 profile；完成 M0 核验后显式配置 AGENTKIT_KSXC_PROTOCOL_PROFILE。');
      if (requireCompanyConfig) await readKsxcCompanyConfig({ companyConfigPath, env });
      return { target, sha256: actual || null, integrityVerified: Boolean(expected),
        protocolProfile: profile || null, compatibilityDeclared,
        companyConfigValid: requireCompanyConfig, catalogReachability: 'not-probed' };
    },
  };
}

/** Inspect availability without executing the payload or reading account files. */
export async function inspectKsxcCommand(options = {}) {
  const command = resolveKsxcCommand(options);
  try {
    const result = await command.validate({ requireProtocol: false });
    return { executable: command.executable, available: true, ...result,
      status: result.compatibilityDeclared ? 'ready' : 'unverified',
      ...(result.compatibilityDeclared ? {} : { code: 'RUNTIME_PROTOCOL_UNSUPPORTED',
        reason: '已找到 KSXC payload，但尚未声明受支持的客户端兼容 profile。' }) };
  } catch (error) {
    return { executable: command.executable, available: false, status: 'unavailable',
      target: `${options.platform || process.platform}-${options.arch || process.arch}`,
      integrityVerified: false, compatibilityDeclared: false,
      code: error.code || 'RUNTIME_PROFILE_UNAVAILABLE', reason: error.message };
  }
}
