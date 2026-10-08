/** Download once using platform-injected credentials, then start from verified local bytes. */
import { mkdir, lstat, realpath, readFile, writeFile, link, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createKs3BundleStore, validateKs3BundleReference, verifyKs3Bundle } from './ks3-bundle-store.mjs';
import { portableError } from './portable-resources.mjs';

export async function prepareBundleArchive({ archive, cache, env = process.env, fetchImpl = fetch }) {
  if (!env.AGENTKIT_BUNDLE_SOURCE) return resolve(archive);
  let reference;
  try { reference = JSON.parse(env.AGENTKIT_BUNDLE_SOURCE); }
  catch { throw portableError('KS3_RECEIPT_INVALID', '运行包存储配置无效'); }
  validateKs3BundleReference(reference);
  if (reference.sha256 !== env.AGENTKIT_BUNDLE_SHA256) throw portableError('DEPLOYMENT_BUNDLE_MISMATCH', '存储配置与部署指定摘要不一致');
  await mkdir(cache, { recursive: true, mode: 0o700 });
  if (!(await lstat(cache)).isDirectory()) throw portableError('BUNDLE_HOST_STATE_INVALID', '运行包缓存必须是独立目录');
  const root = await realpath(cache), path = join(root, `${reference.sha256}.zip`);
  async function existing() {
    const info = await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!info) return false;
    if (!info.isFile() || info.size !== reference.bytes) throw portableError('DEPLOYMENT_BUNDLE_MISMATCH', '已有运行包缓存与固定摘要不一致');
    verifyKs3Bundle(await readFile(path), reference);
    return true;
  }
  if (await existing()) return path;
  const store = createKs3BundleStore({ accessKey: env.KSYUN_ACCESS_KEY, secretKey: env.KSYUN_SECRET_KEY, sessionToken: env.KSYUN_SESSION_TOKEN || '', fetchImpl });
  const zip = await store.download(reference), temporary = join(root, `.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, zip, { mode: 0o600, flag: 'wx' });
    try { await link(temporary, path); }
    catch (error) { if (error.code !== 'EEXIST') throw error; await existing(); }
  } finally { await rm(temporary, { force: true }); }
  return path;
}
