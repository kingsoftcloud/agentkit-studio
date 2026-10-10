/** Node-owned IAM identity checks. Never accept a renderer-supplied operator UUID. */
import { createHash } from 'node:crypto';
import aws4 from 'aws4';
import { createCloudEndpointPolicy } from './cloud-endpoints.mjs';

const MAX_BYTES = 1024 * 1024;
const fail = (code = 'CLOUD_IDENTITY_UNVERIFIED', message = '无法核验当前云端凭证的操作人，请检查 IAM 查询权限与连接后重试；尚未发送部署请求') => {
  throw Object.assign(new Error(message), { code });
};
const text = value => typeof value === 'string' && value === value.trim() && !/[\x00-\x1f\x7f]/.test(value);

async function readBounded(response) {
  if (Number(response.headers.get('content-length')) > MAX_BYTES) { await response.body?.cancel(); fail(); }
  const chunks = []; let size = 0;
  if (!response.body) fail();
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_BYTES) fail();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function ownKey(response, accessKey, allowMissing = false) {
  const result = response?.ListAccessKeyResult;
  const entries = result?.AccessKeyMetadata?.member;
  // An incomplete response or missing key is unknown, never evidence of a root key.
  for (const item of [response, result]) {
    if (!item || item.NextMarker || (item.IsTruncated !== undefined && item.IsTruncated !== false)) fail();
  }
  if (!Array.isArray(entries)) fail();
  const matches = entries.filter(item => item?.AccessKeyId === accessKey);
  if (!matches.length && allowMissing) return null;
  if (matches.length !== 1 || matches[0].Status !== 'Active' || !text(matches[0].UserName)) fail();
  return matches[0];
}

function matchingUser(response, accessKey) {
  if (!response || response.NextMarker || (response.IsTruncated !== undefined && response.IsTruncated !== false)
    || !Array.isArray(response.AccessKeyList)) fail();
  const matches = response.AccessKeyList.filter(item => item?.AccessKey === accessKey);
  if (matches.length !== 1 || !text(matches[0].UserName) || !matches[0].UserName) fail();
  return matches[0].UserName;
}

function subaccount(response, expectedName) {
  const user = response?.GetUserResult?.User;
  if (!user || user.UserName !== expectedName || !text(user.UserId) || !/^[A-Za-z0-9_-]{1,128}$/.test(user.UserId)) fail();
  const match = typeof user.Krn === 'string' && /^krn:ksc:iam::([0-9]{1,20}):user\/([^/]+)$/.exec(user.Krn);
  if (!match || match[2] !== expectedName) fail();
  return { kind: 'subaccount', accountId: match[1], userUuid: user.UserId, userName: expectedName };
}

export function createCloudIdentityResolver({ fetchImpl = fetch, timeoutMs = 15000, now = Date.now, innerKopUrl = '', innerIamUrl = '', endpointPolicy } = {}) {
  const endpoints = endpointPolicy || createCloudEndpointPolicy({ innerKopUrl, innerIamUrl });
  // Cache verified results only, keyed by the entire credential tuple. Rotation of
  // the SK or STS token must not reuse an identity verified with old credentials.
  const cache = new Map();
  async function request(origin, action, params, credentials, signal) {
    const url = new URL('/', origin);
    const body = new URLSearchParams({ ...params, Service: 'iam', Action: action, Version: '2015-11-01',
      SdkVersion: 'agentkit-studio', Region: 'cn-beijing-6', Accesskey: credentials.cloudAccessKey }).toString();
    const signed = aws4.sign({ host: url.host, path: '/', method: 'POST', service: 'iam', region: 'cn-beijing-6', body,
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' } },
    { accessKeyId: credentials.cloudAccessKey, secretAccessKey: credentials.cloudSecretKey, sessionToken: credentials.cloudSessionToken });
    let response, raw;
    try {
      response = await fetchImpl(url, { method: 'POST', headers: signed.headers, body, redirect: 'error',
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) });
      raw = await readBounded(response);
    } catch { fail(); }
    let payload;
    try { payload = JSON.parse(raw); } catch { /* KOP may return XML errors. */ }
    const errorCode = payload?.Error?.Code || raw.match(/<Code>([^<]{1,100})<\/Code>/)?.[1];
    const innerOnly = errorCode === 'InnerAccountCanOnlyAccessThroughIntranet'
      || /(?:inner account can only access through intranet|InnerAccountCanOnlyAccessThroughIntranet)/i.test(raw);
    if (endpoints.isPublicIam(origin) && response.status === 403 && innerOnly && endpoints.innerIam) {
      return request(endpoints.innerIam, action, params, credentials, signal);
    }
    if (!response.ok || !payload || payload.Error) fail();
    return { payload, origin };
  }
  async function resolve(values, { signal, forceRefresh = false } = {}) {
    let base;
    try { base = new URL(values.cloudServerUrl || endpoints.publicKop); } catch { fail('SERVER_URL_INVALID', '控制面地址无效'); }
    if (!endpoints.isAllowedControlPlane(base)
      || (base.protocol !== 'https:' && !endpoints.isInnerKop(base))) {
      fail('CLOUD_IDENTITY_TARGET_UNSUPPORTED', 'IAM 操作人核验仅用于官方 KOP 控制面');
    }
    const { cloudAccessKey, cloudSecretKey, cloudSessionToken = '' } = values;
    if (![cloudAccessKey, cloudSecretKey].every(value => text(value) && value) || !text(cloudSessionToken)) {
      fail('CLOUD_CREDENTIALS_MISSING', '请在模型与凭证中配置有效的云端 AK/SK');
    }
    const credentials = { cloudAccessKey, cloudSecretKey, cloudSessionToken };
    const origin = endpoints.isPublicKop(base) ? endpoints.publicIam : endpoints.innerIam;
    if (!origin) fail('CLOUD_IDENTITY_TARGET_UNSUPPORTED', '内网 KOP 需要由受信任运行时注入 IAM 地址');
    const cacheKey = createHash('sha256').update(JSON.stringify([origin, cloudAccessKey, cloudSecretKey, cloudSessionToken])).digest('hex');
    const cached = cache.get(cacheKey);
    let identity;
    if (!forceRefresh && cached && now() - cached.verifiedAt < 300000 && now() >= cached.verifiedAt) identity = cached;
    else {
      cache.delete(cacheKey);
      const listed = await request(origin, 'ListAccessKeys', {}, credentials, signal);
      let key = ownKey(listed.payload, cloudAccessKey, true);
      if (!key) {
        // Some IAM deployments default ListAccessKeys to the owner's keys even
        // when signed by a subaccount. A missing key is not a root identity.
        // Resolve only this exact AK, then verify its active user-specific row.
        const all = await request(listed.origin, 'ListAllUserAccessKeys', {}, credentials, signal);
        const name = matchingUser(all.payload, cloudAccessKey);
        const own = await request(all.origin, 'ListAccessKeys', { UserName: name }, credentials, signal);
        key = ownKey(own.payload, cloudAccessKey);
        if (key.UserName !== name) fail();
      }
      if (key.UserName === '') {
        // IAM's default key list matched this active key with an empty username.
        // No subaccount or owning account ID may be fabricated from that result.
        identity = { kind: 'main-account', accountId: null, userUuid: null, userName: null };
      } else {
        const user = await request(listed.origin, 'GetUser', { UserName: key.UserName }, credentials, signal);
        identity = subaccount(user.payload, key.UserName);
      }
      identity = Object.freeze({ ...identity, verifiedAt: now() });
      if (cache.size >= 8) cache.delete(cache.keys().next().value);
      cache.set(cacheKey, identity);
    }
    if (values.cloudAccountId && identity.accountId && String(values.cloudAccountId) !== identity.accountId) {
      fail('CLOUD_ACCOUNT_MISMATCH', '配置的主账号与当前凭证的 IAM 归属不一致，请更正后再部署');
    }
    return identity;
  }
  return { resolve };
}
