/** Streamed public release uploads over the KS3 KSS signing contract. */
import { createHash, createHmac } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { uploadKs3Multipart } from './ks3-release-multipart.mjs';

const DEFAULT_TIMEOUT_MS = 900_000;
const BUCKET_FROM_ORIGIN = /^([a-z0-9][a-z0-9-]{1,61}[a-z0-9])\.ks3-[a-z0-9-]+\.ksyuncs\.com$/u;

function required(value, name) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) throw new Error(`${name} is required`);
  if (/[\r\n\0]/u.test(trimmed)) throw new Error(`${name} contains an invalid control character`);
  return trimmed;
}

function firstEnvironmentValue(environment, names, label) {
  for (const name of names) {
    const value = environment[name]?.trim();
    if (value) return value;
  }
  throw new Error(`${label} is required; checked ${names.join(', ')}`);
}

function releaseUrl(origin, objectKey) {
  const base = new URL(required(origin, 'KS3 release origin'));
  if (base.protocol !== 'https:' || base.username || base.password || base.pathname !== '/' || base.search || base.hash) {
    throw new Error('KS3 release origin must be an HTTPS origin without a path or credentials');
  }
  if (!/^dsh-desk\/(?:bin|feeds)\/[a-z0-9-]+\/[a-z0-9._-]+$/u.test(objectKey)
    && !/^studio\/(?:(?:feeds\/mac-arm64\/(?:preview-mac\.yml|stable-mac\.yml|mac-arm64-release\.json)|feeds\/win-x64\/(?:preview\.yml|stable\.yml|win-x64-release\.json))|[0-9]+\.[0-9]+\.[0-9]+(?:[-.][0-9A-Za-z.-]+)?\/(?:(?:full\/)?AgentKit-Studio-mac-arm64\.(?:dmg|zip|zip\.blockmap)|AgentKit-Studio-win-x64\.exe(?:\.blockmap)?))$/u.test(objectKey)) {
    throw new Error(`invalid KS3 release object key: ${objectKey}`);
  }
  return new URL(objectKey, base);
}

async function fileDigest(path) {
  const md5 = createHash('md5');
  const sha512 = createHash('sha512');
  let size = 0;
  for await (const bytes of createReadStream(path)) {
    md5.update(bytes);
    sha512.update(bytes);
    size += bytes.length;
  }
  return { size, md5: md5.digest('base64'), sha512: sha512.digest('base64') };
}

async function reconcileBinary(url, digest, fetchImpl, timeoutMs, { bucket, accessKey, secretKey, now }) {
  const response = await fetchImpl(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
  if (response.status === 404) { await response.body?.cancel(); return false; }
  if (response.status === 403) {
    await response.body?.cancel();
    // A private bucket conceals missing keys from anonymous readers. Only a
    // signed 404 authorizes creation; never mistake a denied existing object
    // for a missing immutable release.
    const signedHeaders = method => {
      const Date = now().toUTCString();
      const signature = createHmac('sha1', secretKey).update(`${method}\n\n\n${Date}\n/${bucket}${url.pathname}`).digest('base64');
      return { Date, Authorization: `KSS ${accessKey}:${signature}` };
    };
    const head = await fetchImpl(url, { method: 'HEAD', headers: signedHeaders('HEAD'), redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    await head.body?.cancel();
    if (head.status === 404) return false;
    if (!head.ok) throw new Error(`KS3 authenticated reconciliation failed: ${head.status}`);
    throw new Error('Existing immutable release object is not publicly readable; review its object ACL before publishing');
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(`KS3 release reconciliation failed: ${response.status}`);
  }
  const hash = createHash('sha512');
  let size = 0;
  for await (const chunk of response.body) { hash.update(chunk); size += chunk.length; }
  if (size !== digest.size || hash.digest('base64') !== digest.sha512) {
    throw new Error(`KS3 immutable release binary already exists with different bytes: ${url.pathname}`);
  }
  return true;
}

/** Resolve KS3 credentials without ever logging their values. */
export function resolveKs3ReleaseCredentials(environment, origin) {
  const parsed = new URL(required(origin, 'KS3 release origin'));
  const bucket = environment.STUDIO_DOWNLOAD_PROD_KS3_BUCKET?.trim()
    || environment.DOWNLOAD_PROD_KS3_BUCKET?.trim()
    || environment.KS3_BUCKET?.trim()
    || parsed.hostname.match(BUCKET_FROM_ORIGIN)?.[1];
  return {
    bucket: required(bucket, 'KS3 bucket'),
    accessKey: firstEnvironmentValue(environment, [
      'STUDIO_DOWNLOAD_PROD_KS3_ACCESS_KEY', 'DOWNLOAD_PROD_KS3_ACCESS_KEY', 'KS3_ACCESS_KEY', 'KSYUN_ACCESS_KEY',
    ], 'KS3 access key'),
    secretKey: firstEnvironmentValue(environment, [
      'STUDIO_DOWNLOAD_PROD_KS3_SECRET_KEY', 'DOWNLOAD_PROD_KS3_SECRET_KEY', 'KS3_SECRET_KEY', 'KSYUN_SECRET_KEY',
    ], 'KS3 secret key'),
  };
}

/** Upload one release object exactly once; callers reconcile any ambiguous failure before retrying. */
export async function uploadKs3ReleaseArtifact({ origin, bucket, accessKey, secretKey, objectKey, path, contentType,
  fetchImpl = fetch, now = () => new Date(), timeoutMs = DEFAULT_TIMEOUT_MS, onProgress = () => {} }) {
  const url = releaseUrl(origin, objectKey);
  const details = await stat(path);
  if (!details.isFile() || details.size <= 0) throw new Error(`KS3 release artifact is not a non-empty file: ${path}`);
  const digest = await fileDigest(path);
  if ((objectKey.startsWith('dsh-desk/bin/') || /^studio\/[0-9]/.test(objectKey)) && await reconcileBinary(url, digest, fetchImpl, timeoutMs, { bucket, accessKey, secretKey, now })) {
    return { objectKey, bytes: digest.size, md5: digest.md5, sha512: digest.sha512, alreadyPresent: true };
  }
  if (digest.size >= 32 * 1024 * 1024) {
    const multipart = await uploadKs3Multipart({ url, bucket, accessKey, secretKey, objectKey, path,
      size: digest.size, contentType: required(contentType, 'KS3 release content type'), fetchImpl, now, onProgress });
    return { objectKey, bytes: digest.size, md5: digest.md5, ...multipart };
  }
  const headers = {
    Date: now().toUTCString(),
    'Content-Length': String(digest.size),
    'Content-MD5': digest.md5,
    'Content-Type': required(contentType, 'KS3 release content type'),
    'x-kss-acl': 'public-read',
  };
  const canonicalHeaders = Object.keys(headers).filter(name => name.startsWith('x-kss-')).sort()
    .map(name => `${name}:${headers[name]}\n`).join('');
  const canonical = `PUT\n${headers['Content-MD5']}\n${headers['Content-Type']}\n${headers.Date}\n${canonicalHeaders}/${bucket}/${objectKey}`;
  headers.Authorization = `KSS ${required(accessKey, 'KS3 access key')}:${createHmac('sha1', required(secretKey, 'KS3 secret key')).update(canonical).digest('base64')}`;
  const response = await fetchImpl(url, {
    method: 'PUT', headers, body: createReadStream(path), duplex: 'half', redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  });
  await response.body?.cancel();
  if (!response.ok) throw new Error(`KS3 release upload failed: ${response.status} ${objectKey}`);
  return { objectKey, bytes: digest.size, md5: digest.md5 };
}
