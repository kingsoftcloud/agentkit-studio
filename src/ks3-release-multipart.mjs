/** Bounded parallel KS3 multipart uploads; metadata still uses a single atomic PUT. */
import { createHash, createHmac } from 'node:crypto';
import { open } from 'node:fs/promises';

const MIN_PART = 5 * 1024 * 1024;
const escapeXml = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
const decodeXml = value => value.replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&amp;', '&');

export async function uploadKs3Multipart({ url, bucket, accessKey, secretKey, objectKey, path, size, contentType,
  fetchImpl = fetch, now = () => new Date(), onProgress = () => {}, partSize = 5 * 1024 * 1024,
  concurrency = 4, timeoutMs = 300_000 }) {
  if (!Number.isSafeInteger(partSize) || partSize < MIN_PART || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) {
    throw new Error('invalid KS3 multipart limits');
  }
  async function request(method, query, body, type = '', extra = {}) {
    const target = new URL(url);
    const ordered = Object.entries(query).sort(([a], [b]) => a.localeCompare(b));
    for (const [key, value] of ordered) target.searchParams.set(key, value);
    const resource = `/${bucket}/${objectKey}?${ordered.map(([key, value]) => value ? `${key}=${value}` : key).join('&')}`;
    const headers = { Date: now().toUTCString(), ...extra };
    if (type) headers['Content-Type'] = type;
    if (body) {
      headers['Content-Length'] = String(body.length);
      headers['Content-MD5'] = createHash('md5').update(body).digest('base64');
    }
    const canonicalHeaders = Object.keys(headers).filter(key => key.startsWith('x-kss-')).sort()
      .map(key => `${key}:${headers[key]}\n`).join('');
    const canonical = `${method}\n${headers['Content-MD5'] || ''}\n${type}\n${headers.Date}\n${canonicalHeaders}${resource}`;
    headers.Authorization = `KSS ${accessKey}:${createHmac('sha1', secretKey).update(canonical).digest('base64')}`;
    const response = await fetchImpl(target, { method, headers, body, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    const text = await response.text();
    if (!response.ok || /<Error[>\s]/u.test(text)) {
      const error = new Error(`KS3 multipart ${method} failed: ${response.status} ${objectKey}`);
      error.retryable = response.status === 429 || response.status >= 500;
      throw error;
    }
    return { response, text };
  }
  const initiated = await request('POST', { uploads: '' }, undefined, contentType, { 'x-kss-acl': 'public-read' });
  const uploadId = decodeXml(initiated.text.match(/<UploadId>([^<]+)<\/UploadId>/u)?.[1] || '');
  if (!uploadId || /[\r\n\0]/u.test(uploadId)) throw new Error('KS3 multipart response has no valid upload ID');
  let file;
  const totalParts = Math.ceil(size / partSize);
  const parts = Array(totalParts);
  let next = 0, completedBytes = 0, failure;
  try {
    file = await open(path, 'r');
    await Promise.allSettled(Array.from({ length: Math.min(concurrency, totalParts) }, async () => {
      while (!failure && next < totalParts) {
        const index = next++;
        try {
          const bytes = Buffer.alloc(Math.min(partSize, size - index * partSize));
          let offset = 0;
          while (offset < bytes.length) {
            const result = await file.read(bytes, offset, bytes.length - offset, index * partSize + offset);
            if (!result.bytesRead) throw new Error('KS3 release artifact was truncated during upload');
            offset += result.bytesRead;
          }
          let etag;
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              const result = await request('PUT', { partNumber: String(index + 1), uploadId }, bytes, 'application/octet-stream');
              etag = result.response.headers.get('etag');
              if (!etag || /[<>\r\n]/u.test(etag)) throw new Error('KS3 uploaded part has no valid ETag');
              break;
            } catch (error) {
              if (attempt === 2 || error.retryable === false) throw error;
            }
          }
          parts[index] = etag;
          completedBytes += bytes.length;
          onProgress({ objectKey, completedParts: parts.filter(Boolean).length, totalParts, completedBytes, size });
        } catch (error) { failure ||= error; }
      }
    }));
    if (failure) throw failure;
    const xml = `<CompleteMultipartUpload>${parts.map((etag, index) => `<Part><PartNumber>${index + 1}</PartNumber><ETag>${escapeXml(etag)}</ETag></Part>`).join('')}</CompleteMultipartUpload>`;
    const completed = await request('POST', { uploadId }, Buffer.from(xml), 'application/xml');
    if (!/<CompleteMultipartUploadResult[>\s]/u.test(completed.text)) throw new Error('KS3 multipart completion was not confirmed');
    return { multipart: true, parts: totalParts, partSize };
  } catch (error) {
    try { await request('DELETE', { uploadId }); }
    catch { throw new Error(`${error.message}; KS3 multipart cleanup failed for ${objectKey}`); }
    throw error;
  } finally { await file?.close(); }
}
