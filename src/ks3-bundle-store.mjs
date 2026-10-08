/** Node-only private artifact delivery over the documented KS3 REST contract. */
import { createHash, createHmac } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { verifyPortableBundle } from './portable-bundle.mjs';
import { portableError, sha256, validatePortableCredentialNames } from './portable-resources.mjs';

const MAX_BYTES = 20 * 1024 * 1024;
const REGIONS = new Set(['cn-beijing', 'cn-shanghai', 'cn-guangzhou', 'cn-ningbo', 'cn-qinghai', 'cn-qingyang', 'cn-hongkong', 'rus', 'sgp']);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const KEY = /^studio-bundles\/v1\/ar-local-[a-f0-9]{16}\/build_[a-f0-9]{20}\/[a-f0-9]{64}\/[a-f0-9-]{36}\.zip$/;
const fail = (code, message, status = 0) => { throw Object.assign(portableError(code, message), { status }); };

export function ks3BundleEndpoint(region, internal = false) {
  const normalized = String(region || '').replace(/-\d+$/, '');
  if (!REGIONS.has(normalized)) fail('KS3_REGION_UNSUPPORTED', '运行包存储区域不受支持');
  return `https://ks3-${normalized}${internal ? '-internal' : ''}.ksyuncs.com`;
}

function target(endpoint, bucket, objectKey) {
  let url;
  try { url = new URL(endpoint); } catch { fail('KS3_ENDPOINT_INVALID', 'KS3 地址无效'); }
  const allowed = [...REGIONS].flatMap(region => [ks3BundleEndpoint(region), ks3BundleEndpoint(region, true)]);
  if (!allowed.includes(url.origin) || url.pathname !== '/' || url.username || url.password || url.search || url.hash) fail('KS3_ENDPOINT_INVALID', '运行包仅支持官方 KS3 HTTPS 地址');
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket || '')) fail('KS3_BUCKET_INVALID', 'KS3 Bucket 名称无效');
  if (!KEY.test(objectKey || '')) fail('KS3_OBJECT_INVALID', '运行包对象路径无效');
  url.hostname = `${bucket}.${url.hostname}`; url.pathname = `/${objectKey}`;
  return url;
}

export function planKs3BundleUpload(zip, { endpoint, bucket, uploadId }) {
  if (!Buffer.isBuffer(zip) || zip.length > MAX_BYTES) fail('PORTABLE_ARCHIVE_SIZE_INVALID', '运行包不能超过 20 MiB');
  if (!UUID.test(uploadId || '')) fail('KS3_UPLOAD_ID_INVALID', '请为上传生成独立 UUID 并先保存上传意图');
  const { manifest } = verifyPortableBundle(zip);
  validatePortableCredentialNames(manifest.requirements);
  const digest = sha256(zip);
  const objectKey = `studio-bundles/v1/${manifest.agentId}/${manifest.buildId}/${digest}/${uploadId}.zip`;
  target(endpoint, bucket, objectKey);
  return { format: 'agentkit.ks3-bundle/v1', endpoint: new URL(endpoint).origin, bucket, objectKey,
    sha256: digest, bytes: zip.length, agentId: manifest.agentId, buildId: manifest.buildId, bundleId: manifest.bundleId };
}

async function readBounded(response) {
  if (Number(response.headers.get('content-length')) > MAX_BYTES) { await response.body?.cancel(); fail('PORTABLE_ARCHIVE_SIZE_INVALID', '运行包不能超过 20 MiB'); }
  const chunks = []; let total = 0;
  if (!response.body) fail('KS3_OBJECT_EMPTY', 'KS3 未返回运行包内容');
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > MAX_BYTES) fail('PORTABLE_ARCHIVE_SIZE_INVALID', '运行包不能超过 20 MiB');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function validateKs3BundleReference(reference) {
  if (reference?.format !== 'agentkit.ks3-bundle/v1' || !/^[a-f0-9]{64}$/.test(reference.sha256 || '')
    || !Number.isInteger(reference.bytes) || reference.bytes < 1 || reference.bytes > MAX_BYTES
    || !reference.objectKey?.includes(`/${reference.sha256}/`)) fail('KS3_RECEIPT_INVALID', '运行包存储回执无效');
  return target(reference.endpoint, reference.bucket, reference.objectKey);
}

export function verifyKs3Bundle(zip, reference) {
  validateKs3BundleReference(reference);
  if (zip.length !== reference.bytes || sha256(zip) !== reference.sha256) fail('DEPLOYMENT_BUNDLE_MISMATCH', '下载运行包与固定摘要不一致');
  const { manifest } = verifyPortableBundle(zip);
  validatePortableCredentialNames(manifest.requirements);
  if (manifest.agentId !== reference.agentId || manifest.buildId !== reference.buildId || manifest.bundleId !== reference.bundleId) fail('KS3_RECEIPT_INVALID', '存储回执与运行包身份不一致');
  return zip;
}

export function createKs3BundleStore({ accessKey, secretKey, sessionToken = '', fetchImpl = fetch, now = () => new Date(), timeoutMs = 60000 }) {
  if (![accessKey, secretKey].every(value => typeof value === 'string' && value.trim() && !/[\r\n\0]/.test(value))
    || typeof sessionToken !== 'string' || /[\r\n\0]/.test(sessionToken)) fail('KS3_CREDENTIAL_MISSING', '目标环境缺少有效的 KS3 凭证');
  async function request(reference, method, { body, anonymous = false, signal } = {}) {
    const url = validateKs3BundleReference(reference), headers = {};
    if (!anonymous) {
      headers.Date = now().toUTCString();
      if (sessionToken) headers['x-kss-security-token'] = sessionToken;
      if (body) Object.assign(headers, { 'Content-Type': 'application/zip', 'Content-Length': String(body.length),
        'Content-MD5': createHash('md5').update(body).digest('base64'), 'x-kss-acl': 'private', 'x-kss-meta-sha256': reference.sha256 });
      // KS3 V2 uses KSS / x-kss-* (not the control plane's AWS4 signing).
      const canonicalHeaders = Object.keys(headers).filter(key => key.startsWith('x-kss-')).sort().map(key => `${key}:${headers[key]}\n`).join('');
      const canonical = `${method}\n${headers['Content-MD5'] || ''}\n${headers['Content-Type'] || ''}\n${headers.Date}\n${canonicalHeaders}/${reference.bucket}/${reference.objectKey}`;
      headers.Authorization = `KSS ${accessKey}:${createHmac('sha1', secretKey).update(canonical).digest('base64')}`;
    } else headers.Range = 'bytes=0-0';
    try {
      return await fetchImpl(url, { method, headers, ...(body ? { body } : {}), redirect: 'error',
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) });
    } catch { fail('KS3_REQUEST_FAILED', 'KS3 请求未完成，请核对上传回执；不会自动重试写请求'); }
  }
  async function download(reference, options = {}) {
    const response = await request(reference, 'GET', options);
    if (!response.ok) { await response.body?.cancel(); fail('KS3_DOWNLOAD_FAILED', '私有运行包下载失败，请检查对象和权限', response.status); }
    const zip = await readBounded(response);
    return verifyKs3Bundle(zip, reference);
  }
  async function assertPrivate(reference, options = {}) {
    const response = await request(reference, 'GET', { ...options, anonymous: true });
    await response.body?.cancel();
    if (![403, 404].includes(response.status)) fail('KS3_OBJECT_NOT_PRIVATE', '运行包匿名访问未被拒绝，请检查 Bucket 策略', response.status);
    return response.status;
  }
  async function remove(reference, options = {}) {
    // A receipt cannot authorize deletion of an object replaced with other bytes.
    await download(reference, options);
    const response = await request(reference, 'DELETE', options); await response.body?.cancel();
    if (!response.ok) fail('KS3_DELETE_FAILED', '运行包清理未确认，请保留并核对原回执', response.status);
    return { deleted: true };
  }
  async function upload(zip, reference, options = {}) {
    validateKs3BundleReference(reference);
    const expected = planKs3BundleUpload(zip, { ...reference, uploadId: reference.objectKey.split('/').at(-1).replace(/\.zip$/, '') });
    if (!isDeepStrictEqual(expected, reference)) fail('KS3_RECEIPT_INVALID', '上传意图与运行包不一致');
    const head = await request(reference, 'HEAD', options); await head.body?.cancel();
    if (head.status !== 404) fail(head.ok ? 'KS3_OBJECT_EXISTS' : 'KS3_PREFLIGHT_FAILED', '上传对象已存在或无法确认状态，请核对原回执', head.status);
    const response = await request(reference, 'PUT', { ...options, body: zip }); await response.body?.cancel();
    if (!response.ok) fail('KS3_UPLOAD_FAILED', '私有运行包上传失败，请检查权限并核对回执', response.status);
    await download(reference, options);
    let anonymousStatus;
    try { anonymousStatus = await assertPrivate(reference, options); }
    catch (error) {
      // A bucket policy can override a private ACL. Remove only this newly
      // uploaded, hash-verified object if anonymous access actually succeeds.
      if (error.code === 'KS3_OBJECT_NOT_PRIVATE' && error.status >= 200 && error.status < 300) {
        try { await remove(reference, options); error.cleanedUp = true; }
        catch { error.cleanedUp = false; }
      }
      throw error;
    }
    return { ...reference, verified: true, anonymousStatus };
  }
  return { upload, download, assertPrivate, remove };
}
