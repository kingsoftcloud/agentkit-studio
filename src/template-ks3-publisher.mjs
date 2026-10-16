/** Private immutable template objects. Never rewrites an unrelated KS3 key. */
import { createHash, createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
export function createTemplateKs3Publisher({ accessKey, secretKey, sessionToken = '', bucket, region = 'cn-beijing', prefix, fetchImpl = fetch }) {
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket) || !/^studio-templates\/v1\/[a-f0-9]{64}\/$/.test(prefix) || !/^cn-(?:beijing|shanghai|guangzhou|ningbo|qinghai|qingyang)$/.test(region)) throw new Error('Invalid template storage destination');
  async function request(method, key, data, type) {
    if (!key.startsWith(prefix) || !/^[a-f0-9]{64}\.(?:zip|image)$/.test(key.slice(prefix.length))) throw new Error('Template object key is outside its publisher namespace');
    const headers = { Date: new Date().toUTCString() };
    if (sessionToken) headers['x-kss-security-token'] = sessionToken;
    if (data) Object.assign(headers, { 'Content-Length': String(data.length), 'Content-Type': type, 'Content-MD5': createHash('md5').update(data).digest('base64'), 'x-kss-acl': 'private', 'x-kss-meta-sha256': createHash('sha256').update(data).digest('hex') });
    const kss = Object.keys(headers).filter(key => key.startsWith('x-kss-')).sort().map(key => `${key}:${headers[key]}\n`).join('');
    const message = `${method}\n${headers['Content-MD5'] || ''}\n${headers['Content-Type'] || ''}\n${headers.Date}\n${kss}/${bucket}/${key}`;
    headers.Authorization = `KSS ${accessKey}:${createHmac('sha1', secretKey).update(message).digest('base64')}`;
    return fetchImpl(`https://${bucket}.ks3-${region}.ksyuncs.com/${key}`, { method, headers, ...(data ? { body: data } : {}), redirect: 'error', signal: AbortSignal.timeout(120000) });
  }
  return { async put(path, { type = 'zip', expandedBytes, packageDigest } = {}) {
    const data = await readFile(path), sha256 = createHash('sha256').update(data).digest('hex'), key = prefix + sha256 + (type === 'zip' ? '.zip' : '.image');
    let head = await request('HEAD', key); await head.body?.cancel();
    const matches = value => Number(value.headers.get('content-length')) === data.length && value.headers.get('x-kss-meta-sha256') === sha256;
    if (head.ok && !matches(head)) throw new Error('Immutable template object conflicts with existing bytes');
    if (!head.ok) {
      if (head.status !== 404) throw new Error(`KS3 template preflight failed (${head.status})`);
      let result;
      try { result = await request('PUT', key, data, type === 'zip' ? 'application/zip' : 'application/octet-stream'); await result.body?.cancel(); }
      catch { /* Reconcile the same immutable key before deciding whether a write occurred. */ }
      head = await request('HEAD', key); await head.body?.cancel();
      if (!head.ok || !matches(head)) throw new Error('KS3 template upload could not be reconciled');
    }
    const anonymous = await fetchImpl(`https://${bucket}.ks3-${region}.ksyuncs.com/${key}`, { headers: { Range: 'bytes=0-0' }, redirect: 'error', signal: AbortSignal.timeout(15000) });
    await anonymous.body?.cancel();
    if (![403,404].includes(anonymous.status)) throw new Error('Private template object is anonymously readable; catalog was not published');
    return { key, sha256, bytes: data.length, expandedBytes: expandedBytes ?? data.length, type, ...(packageDigest ? { packageDigest } : {}) };
  } };
}
