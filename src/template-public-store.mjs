/** Maintenance-only KS3 distribution. The desktop reads these objects anonymously. */
import { createHash, createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
const sha = data => createHash('sha256').update(data).digest('hex');
const hex = /^[a-f0-9]{64}$/;

export function createTemplatePublicStore({ accessKey, secretKey, sessionToken = '', bucket, region = 'cn-beijing', environment, owner, fetchImpl = fetch }) {
  if (!accessKey || !secretKey || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket) || !/^cn-(?:beijing|shanghai|guangzhou|ningbo|qinghai|qingyang)$/.test(region) || !['pre-online','online'].includes(environment) || !hex.test(owner)) throw new Error('Invalid public template destination');
  const origin = `https://${bucket}.ks3-${region}.ksyuncs.com`, prefix = `studio-templates/${environment}/v1/`;
  async function request(method, key, data, type, conditional = {}) {
    if (!key.startsWith(prefix) || !/^(?:[a-f0-9]{64}\/[a-f0-9]{64}\.(?:zip|image)|catalogs\/[a-f0-9-]{36}\/[a-f0-9]{64}\.json|latest\.json)$/.test(key.slice(prefix.length))) throw new Error('Public template key is outside its environment');
    const headers = { Date: new Date().toUTCString(), ...conditional };
    if (sessionToken) headers['x-kss-security-token'] = sessionToken;
    if (data) Object.assign(headers, { 'Content-Type': type, 'Content-Length': String(data.length), 'Content-MD5': createHash('md5').update(data).digest('base64'), 'x-kss-acl': 'public-read', 'x-kss-meta-sha256': sha(data), 'Cache-Control': key.endsWith('/latest.json') ? 'no-cache' : 'public,max-age=31536000,immutable' });
    const canonical = Object.keys(headers).filter(k => k.startsWith('x-kss-')).sort().map(k => `${k}:${headers[k]}\n`).join('');
    const message = `${method}\n${headers['Content-MD5'] || ''}\n${headers['Content-Type'] || ''}\n${headers.Date}\n${canonical}/${bucket}/${key}`;
    headers.Authorization = `KSS ${accessKey}:${createHmac('sha1',secretKey).update(message).digest('base64')}`;
    return fetchImpl(`${origin}/${key}`, { method, headers, ...(data ? { body:data } : {}), redirect:'error', signal:AbortSignal.timeout(120000) });
  }
  async function verify(key, data) {
    const response = await fetchImpl(`${origin}/${key}`, { redirect:'error', signal:AbortSignal.timeout(120000) });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Public template verification failed (${response.status})`); }
    // Full bytes, not an authenticated HEAD, prove anonymous distribution.
    const digest = createHash('sha256'); let bytes = 0;
    for await (const chunk of response.body) { bytes += chunk.length; if (bytes > data.length) throw new Error('Public object exceeds expected size'); digest.update(chunk); }
    if (bytes !== data.length || digest.digest('hex') !== sha(data)) throw new Error('Public template bytes do not match');
  }
  async function put(key, data, type, mutable = false) {
    const existing = await request('HEAD',key); await existing.body?.cancel();
    const matches = value => value.ok && Number(value.headers.get('content-length')) === data.length && value.headers.get('x-kss-meta-sha256') === sha(data);
    if (existing.ok && !matches(existing) && !mutable) throw new Error('Immutable public template object conflicts');
    if (!existing.ok && existing.status !== 404) throw new Error(`Public template preflight failed (${existing.status})`);
    if (!matches(existing)) {
      const conditional = existing.ok ? { 'If-Match':existing.headers.get('etag') } : { 'If-None-Match':'*' };
      let result;
      try { result = await request('PUT',key,data,type,conditional); await result.body?.cancel(); } catch { /* Reconcile an unknown write outcome below. */ }
      const head = await request('HEAD',key); await head.body?.cancel();
      if (!matches(head)) throw new Error(`Public template upload did not reconcile${result ? ` (${result.status})` : ''}`);
    }
    await verify(key,data);
    return { url:`${origin}/${key}`, bytes:data.length, sha256:sha(data) };
  }
  return {
    origin, prefix,
    async putAsset(path, asset) {
      const data = await readFile(path);
      if (!hex.test(asset.sha256) || sha(data) !== asset.sha256 || data.length !== asset.bytes || !['zip','image'].includes(asset.type)) throw new Error('Public asset does not match the locked inventory');
      const key = `${prefix}${owner}/${asset.sha256}.${asset.type === 'zip' ? 'zip' : 'image'}`;
      await put(key,data,asset.type === 'zip' ? 'application/zip' : 'application/octet-stream');
      return {...asset,key};
    },
    async putSnapshot(catalogId, value) {
      if (!/^[a-f0-9-]{36}$/.test(catalogId)) throw new Error('Invalid catalog identity');
      const data = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
      JSON.parse(data.toString('utf8'));
      return put(`${prefix}catalogs/${catalogId}/${sha(data)}.json`,data,'application/json');
    },
    async activate(catalogId, manifest) {
      if (!manifest.url?.startsWith(`${origin}/${prefix}catalogs/${catalogId}/`) || !hex.test(manifest.sha256)) throw new Error('Channel cannot reference another environment');
      // All immutable files must have been uploaded and verified before this final write.
      return put(`${prefix}latest.json`,Buffer.from(JSON.stringify({format:'agentkit.public-template-channel/v1',environment,catalogId,manifest})),'application/json',true);
    },
  };
}
