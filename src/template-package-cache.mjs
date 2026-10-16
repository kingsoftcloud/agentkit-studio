/** Streamed, resumable, content-addressed KS3 downloads. No signed URL is persisted. */
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, mkdir, open, readFile, rename, rm, stat, writeFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve, relative } from 'node:path';
import { readZipFiles } from './zip.mjs';
const MAX = 128 * 1024 * 1024, EXPANDED = 512 * 1024 * 1024;
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const cancelled = () => Object.assign(new Error('已取消下载，可重新召唤继续'), { code: 'TEMPLATE_CANCELLED' });
async function checksum(path) { const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest('hex'); }
export function createTemplatePackageCache({ directory, client, fetchImpl = fetch, allowTestLoopback = false }) {
  const pending = new Map();
  function validate(asset) {
    if (!/^[a-f0-9]{64}$/.test(asset?.sha256 || '') || !asset.catalogId || !Number.isInteger(asset.bytes) || asset.bytes <= 0 || asset.bytes > MAX || asset.expandedBytes > EXPANDED) fail('TEMPLATE_ARCHIVE_INVALID', '模板资源包声明无效或超过大小限制');
  }
  async function transfer(asset, signal, emit) {
    validate(asset); await mkdir(directory, { recursive: true, mode: 0o700 });
    const target = join(directory, asset.sha256 + '.blob'), partial = target + '.part', stateFile = partial + '.json';
    if (await stat(target).catch(() => null)) {
      if ((await stat(target)).size === asset.bytes && await checksum(target) === asset.sha256) { emit({ phase: 'cache-hit', received: asset.bytes, total: asset.bytes, cacheHit: true }); return target; }
      await rm(target, { force: true });
    }
    let offset = 0, state;
    try { state = JSON.parse(await readFile(stateFile)); const info = await stat(partial); if (state.sha256 === asset.sha256 && state.etag && info.size < asset.bytes) offset = info.size; } catch {}
    for (let attempt = 0; attempt < 2; attempt++) {
      signal.throwIfAborted();
      const ticket = await client.action('GetStudioTemplateDownload', { CatalogId: asset.catalogId, AssetId: asset.sha256 }, { signal });
      if (ticket.sha256 !== asset.sha256 || ticket.bytes !== asset.bytes) fail('TEMPLATE_DOWNLOAD_CHANGED', '下载资源与锁定版本不一致');
      const url = new URL(ticket.DownloadUrl);
      if (!(url.protocol === 'https:' && /^[a-z0-9.-]+\.ks3-[a-z0-9-]+\.ksyuncs\.com$/.test(url.hostname)) && !(allowTestLoopback && url.hostname === '127.0.0.1')) fail('TEMPLATE_DOWNLOAD_ORIGIN_INVALID', '模板资源必须来自已授权的 KS3 地址');
      const headers = offset ? { Range: `bytes=${offset}-`, 'If-Range': state.etag } : {};
      let response;
      try { response = await fetchImpl(url, { headers, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]) }); }
      catch { if (signal.aborted) throw cancelled(); fail('TEMPLATE_DOWNLOAD_FAILED', '资源下载中断，可重试继续'); }
      if ([401,403].includes(response.status) && attempt === 0) { await response.body?.cancel(); continue; }
      if (offset && (response.status !== 206 || response.headers.get('content-range') !== `bytes ${offset}-${asset.bytes-1}/${asset.bytes}` || response.headers.get('etag') !== state.etag)) {
        await response.body?.cancel(); offset = 0; state = null; continue;
      }
      if (!response.ok || !response.body || Number(response.headers.get('content-length') || asset.bytes - offset) !== asset.bytes - offset) { await response.body?.cancel(); fail('TEMPLATE_DOWNLOAD_FAILED', '资源下载失败或长度不匹配，请重试'); }
      const etag = response.headers.get('etag');
      await writeFile(stateFile, JSON.stringify({ sha256: asset.sha256, etag: etag && !/[\r\n]/.test(etag) ? etag : null }), { mode: 0o600 });
      const file = await open(partial, offset ? 'a' : 'w', 0o600); let received = offset;
      emit({ phase: 'downloading', received, total: asset.bytes, resumed: offset > 0 });
      try {
        for await (const chunk of response.body) {
          if (signal.aborted) throw cancelled(); received += chunk.length;
          if (received > asset.bytes) fail('TEMPLATE_DOWNLOAD_SIZE_MISMATCH', '资源包超过声明大小');
          await file.write(chunk); emit({ phase: 'downloading', received, total: asset.bytes, resumed: offset > 0 });
        }
      } catch (error) { if (signal.aborted) throw cancelled(); if (error.code?.startsWith('TEMPLATE_')) throw error; fail('TEMPLATE_DOWNLOAD_FAILED', '资源下载中断，可重试继续'); }
      finally { await file.close(); }
      if (received !== asset.bytes) fail('TEMPLATE_DOWNLOAD_INCOMPLETE', '资源未下载完整，可重试继续');
      emit({ phase: 'verifying', received, total: asset.bytes });
      if (await checksum(partial) !== asset.sha256) { await rm(partial, { force: true }); await rm(stateFile, { force: true }); fail('TEMPLATE_DOWNLOAD_DIGEST_MISMATCH', '资源包校验失败，已拒绝安装'); }
      signal.throwIfAborted(); await rename(partial, target); await rm(stateFile, { force: true }); return target;
    }
    fail('TEMPLATE_DOWNLOAD_FAILED', '资源地址过期或无法续传，请重试');
  }
  function download(asset, { signal = new AbortController().signal, onProgress = () => {} } = {}) {
    validate(asset);
    if (signal.aborted) return Promise.reject(cancelled());
    const key = asset.sha256;
    let job = pending.get(key);
    if (!job) {
      job = { controller: new AbortController(), consumers: new Map() }; pending.set(key, job);
      job.promise = Promise.resolve().then(() => transfer(asset, job.controller.signal, event => { job.latest = event; for (const listener of job.consumers.values()) listener(event); })).finally(() => pending.delete(key));
      job.promise.catch(() => {});
    }
    return new Promise((accept, reject) => {
      const id = randomUUID(); let done = false;
      const cleanup = () => { done = true; signal.removeEventListener('abort', abort); job.consumers.delete(id); };
      const abort = () => { cleanup(); if (!job.consumers.size) { job.controller.abort(); job.promise.then(() => reject(cancelled()), () => reject(cancelled())); } else reject(cancelled()); };
      job.consumers.set(id, onProgress); signal.addEventListener('abort', abort, { once: true }); if (job.latest) onProgress(job.latest);
      job.promise.then(value => { if (!done) { cleanup(); accept(value); } }, error => { if (!done) { cleanup(); reject(error.name === 'AbortError' ? cancelled() : error); } });
    });
  }
  const unpacking = new Map();
  async function ensure(bundle, { destination, verify, signal, onProgress = () => {} }) {
    if (await stat(destination).catch(() => null)) { await verify(destination, bundle); onProgress({ phase: 'cache-hit', received: bundle.archive.bytes, total: bundle.archive.bytes, cacheHit: true }); return; }
    const archive = await download(bundle.archive, { signal, onProgress });
    signal?.throwIfAborted();
    if (!unpacking.has(bundle.digest)) unpacking.set(bundle.digest, (async () => {
      onProgress({ phase: 'installing', received: bundle.archive.bytes, total: bundle.archive.bytes });
      const temporary = `${destination}.prepare-${randomUUID()}`; await mkdir(temporary, { recursive: true, mode: 0o700 });
      try {
        const files = readZipFiles(await readFile(archive), { maxArchiveBytes: MAX, maxEntries: 12000, maxFileBytes: 64 * 1024 * 1024, maxExpandedBytes: EXPANDED });
        if (files.length !== bundle.files.length) fail('TEMPLATE_ARCHIVE_CONTENT_MISMATCH', '资源包文件清单不匹配');
        const inventory = new Map(bundle.files.map(file => [file.path,file]));
        for (const file of files) {
          const expected = inventory.get(file.name), path = resolve(temporary,file.name);
          if (!expected || relative(temporary,path).startsWith('..') || file.data.length !== expected.size || Boolean(file.executable) !== Boolean(expected.executable) || createHash('sha256').update(file.data).digest('hex') !== expected.sha256) fail('TEMPLATE_ARCHIVE_CONTENT_MISMATCH', '资源文件摘要或权限不匹配');
          await mkdir(dirname(path), { recursive: true, mode: 0o700 }); await writeFile(path,file.data,{mode:expected.executable?0o700:0o600,flag:'wx'});
        }
        await verify(temporary,bundle); await rename(temporary,destination);
      } finally { await rm(temporary,{recursive:true,force:true}); }
    })().finally(() => unpacking.delete(bundle.digest)));
    await unpacking.get(bundle.digest);
    signal?.throwIfAborted();
  }
  return { download, ensure, async stats() {
    const files = (await readdir(directory).catch(() => [])).filter(name => /^[a-f0-9]{64}\.blob$/.test(name));
    return { files: files.length, bytes: (await Promise.all(files.map(name=>stat(join(directory,name))))).reduce((sum,row)=>sum+row.size,0), activeDownloads: pending.size+unpacking.size };
  }, async clear() {
    if (pending.size||unpacking.size) fail('TEMPLATE_CACHE_BUSY','下载或安装进行中，请稍后清理缓存');
    for (const name of await readdir(directory).catch(()=>[])) if (/^[a-f0-9]{64}\.blob(?:\.part(?:\.json)?)?$/.test(name)) await rm(join(directory,name),{force:true});
    return { cleared:true, installedSkillsPreserved:true };
  } };
}
