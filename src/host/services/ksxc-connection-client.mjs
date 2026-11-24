import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hostFetch } from '../../http-fetch.mjs';
import { KsxcRuntimeError } from '../../providers/ksxc-command.mjs';

const failure = (code, message, status) => Object.assign(new KsxcRuntimeError(code, message), { status });
const unavailable = () => failure('KSXC_CONNECTION_SERVICE_UNAVAILABLE', '暂时无法读取 KSXC 企业连接。', 503);
const tokenValue = value => typeof value === 'string' && /^[^\s\x00-\x1f\x7f]{1,8192}$/.test(value);
const CACHE_FORMAT = 'agentkit.ksxc.connection-cache/v1';
const cacheKey = ({ runtimeToken, agentId, companyCode }) => createHash('sha256')
  .update(`${runtimeToken}\0${agentId}\0${companyCode}`)
  .digest();
const cacheFileFor = (directory, userId) => join(directory, `${createHash('sha256').update(userId).digest('hex')}.json`);

function permitExpiry(token) {
  const payload = token.startsWith('drp1.') ? token.slice(5).split('.')[0] : token.split('.')[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return Number.isInteger(claims.expires_at) ? claims.expires_at * 1000 : null;
  } catch { return null; }
}

function encryptCache(value, key) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return JSON.stringify({ format: CACHE_FORMAT, iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), ciphertext: ciphertext.toString('base64url') }) + '\n';
}

function decryptCache(raw, key) {
  const record = JSON.parse(raw);
  if (record?.format !== CACHE_FORMAT) throw new Error('invalid KSXC cache');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(record.iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(record.tag, 'base64url'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(record.ciphertext, 'base64url')), decipher.final()]).toString('utf8'));
}

const callerErrors = new Map([
  ['KSXC_ENTERPRISE_CONNECTION_REQUIRED', ['KSXC_CONNECTION_REQUIRED', '请先连接你自己的 KSXC 企业账号。', 403]],
  ['KSXC_CALLER_IDENTITY_REQUIRED', ['KSXC_CALLER_REQUIRED', '运行 KSXC 需要可验证的平台调用人。', 401]],
  ['KSXC_CALLER_PERMIT_REQUIRED', ['KSXC_CALLER_PERMIT_REQUIRED', 'KSXC 需要当前用户的托管调用许可。', 403]],
  ['KSXC_CALLER_PERMIT_STALE', ['KSXC_CALLER_PERMIT_STALE', '企业连接已变更，请刷新后发起新请求。', 403]],
  ['KSXC_TARGET_VERSION_UNAVAILABLE', ['KSXC_TARGET_VERSION_UNAVAILABLE', '当前部署版本不可用，请刷新。', 409]],
  ['KSXC_RELEASE_DISABLED', ['KSXC_RELEASE_DISABLED', '此 KSXC 发布版本已停用。', 409]],
]);

export function readManagedKsxcConnectionConfig(env) {
  try {
    const root = new URL(env.AGENTENGINE_RESOURCE_SERVER_URL);
    const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(root.hostname);
    const transport = root.protocol === 'https:' || root.protocol === 'http:' && loopback && env.AGENTKIT_KSXC_ALLOW_HTTP === '1';
    const token = env.AGENTKIT_RUNTIME_TOKEN;
    if (!transport || root.username || root.password || root.search || root.hash || root.pathname !== '/' || !tokenValue(token) || token.length < 24) throw unavailable();
    return { root, token };
  } catch { throw unavailable(); }
}

export function createManagedKsxcConnectionClient({ identity, companyConfig, env, stateRoot = join(env.AGENTKIT_USER_HOME || process.cwd(), '.ksxc'), getCallerPermit, fetchImpl = hostFetch }) {
  const { root, token } = readManagedKsxcConnectionConfig(env);
  const { agentId, versionId, manifestSha256 } = identity;
  const endpoint = new URL(`/agentengine/internal/v1/dsh/agents/${encodeURIComponent(agentId)}/ksxc/connection`, root);
  const cacheDirectory = join(stateRoot, 'connections');
  const key = cacheKey({ runtimeToken: token, agentId, companyCode: companyConfig.code });
  const clear = async userId => {
    if (!userId) { await rm(cacheDirectory, { recursive: true, force: true }); return; }
    if (!/^aeu_[a-f0-9]{64}$/.test(userId)) return;
    await rm(cacheFileFor(cacheDirectory, userId), { force: true });
  };
  const readCached = async userId => {
    try {
      const value = decryptCache(await readFile(cacheFileFor(cacheDirectory, userId), 'utf8'), key);
      if (value.userId !== userId || value.agentId !== agentId || value.versionId !== versionId
        || value.manifestSha256 !== manifestSha256 || !tokenValue(value.token)
        || (value.expiresAt !== null && (!Number.isFinite(value.expiresAt) || value.expiresAt <= Date.now() + 1000))) {
        await clear(userId); return null;
      }
      return { accountId: value.accountId, token: value.token };
    } catch { return null; }
  };
  const writeCached = async (userId, connection) => {
    if (!connection?.token || !connection?.accountId) return;
    await mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
    const file = cacheFileFor(cacheDirectory, userId), temporary = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    const payload = { userId, agentId, versionId, manifestSha256, accountId: connection.accountId, token: connection.token, expiresAt: permitExpiry(connection.token) };
    await writeFile(temporary, encryptCache(payload, key), { mode: 0o600, flag: 'wx' });
    await rename(temporary, file);
  };
  const getConnection = async ({ userId, signal }) => {
    if (!/^aeu_[a-f0-9]{64}$/.test(userId || '')) throw failure('KSXC_CALLER_REQUIRED', '运行 KSXC 需要可验证的平台调用人。', 401);
    const cached = await readCached(userId);
    if (cached) return cached;
    const permit = getCallerPermit?.(userId);
    if (!permit) throw failure('KSXC_CALLER_PERMIT_REQUIRED', 'KSXC 需要当前用户的托管调用许可。', 403);
    let response, envelope;
    try {
      const timeout = AbortSignal.timeout(10000);
      response = await fetchImpl(endpoint, {
        method: 'POST', redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: { authorization: `Bearer ${token}`, 'x-agentengine-target-version-id': versionId,
          'x-agentengine-manifest-sha256': manifestSha256, 'x-agentengine-resource-permit': permit },
      });
      envelope = await response.json();
    } catch { signal?.throwIfAborted(); throw unavailable(); }
    if (!response.ok) {
      const args = callerErrors.get(envelope?.detail);
      throw args ? failure(...args) : unavailable();
    }
    const data = envelope?.Data;
    if (envelope?.Code !== 0 || data?.CompanyCode !== companyConfig.code || !tokenValue(data?.AuthToken)
      || typeof data?.ConnectionRef !== 'string' || !/^[a-f0-9]{64}$/.test(data.ConnectionRef)
      || typeof data.Environment !== 'string' || !data.Environment) throw unavailable();
    const connection = { accountId: `${data.Environment}:${data.ConnectionRef}`, token: data.AuthToken };
    await writeCached(userId, connection);
    return connection;
  };
  getConnection.clear = clear;
  getConnection.cacheDirectory = cacheDirectory;
  return getConnection;
}
