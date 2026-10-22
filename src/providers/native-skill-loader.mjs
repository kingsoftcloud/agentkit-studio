import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { hostFetch } from '../http-fetch.mjs';
import { materializeCloudSkill } from '../skill-files.mjs';
import { parseFrontmatter } from '../skill-discovery.mjs';
import { canonical, copy, invariant } from '../../packages/agentkit-harness-core/dist/index.mjs';

export const NATIVE_SKILL_LOADER = 'agentkit.native-skill-loader/v1';
const fail = code => Object.assign(new Error(code), { code });

/** Download only the exact selected resource. No name lookup, script execution
 * or installation/binding occurs here. Cache publication is content addressed. */
export function createNativeSkillLoader({ serviceClient, cacheDir, fetchImpl = hostFetch,
  maxArchiveBytes = 20 * 1024 * 1024 } = {}) {
  invariant(typeof serviceClient?.downloadSkillArchive === 'function', 'native_skill_download_service_required');
  invariant(typeof cacheDir === 'string' && cacheDir.trim(), 'native_skill_cache_required');
  invariant(Number.isSafeInteger(maxArchiveBytes) && maxArchiveBytes > 0 && maxArchiveBytes <= 20 * 1024 * 1024,
    'native_skill_archive_limit_invalid');
  const directory = resolve(cacheDir);
  return async function load(request) {
    const { skillId, versionId, name, spaceId, contentHash = '', signal, assertCurrent } = request;
    invariant([skillId, name, spaceId].every(value => typeof value === 'string' && value.trim())
      && typeof versionId === 'string' && typeof contentHash === 'string', 'native_skill_load_identity_invalid');
    invariant(signal instanceof AbortSignal && typeof assertCurrent === 'function', 'native_skill_load_authority_required');
    const selected = { skillId, versionId, name, spaceId, contentHash }, fixed = canonical(selected);
    const check = () => {
      signal.throwIfAborted();
      if (request.signal !== signal || canonical({ skillId: request.skillId, versionId: request.versionId,
        name: request.name, spaceId: request.spaceId, contentHash: request.contentHash ?? '' }) !== fixed)
        throw fail('SKILL_LOAD_IDENTITY_CHANGED');
      const verdict = assertCurrent();
      if (verdict && typeof verdict.then === 'function') Promise.resolve(verdict).catch(() => {});
      if (verdict !== true) throw fail('SKILL_LOAD_AUTHORITY_CHANGED');
      return true;
    };
    check();
    const expected = contentHash.toLowerCase().replace(/^sha256:/, '');
    if (expected && !/^[a-f0-9]{64}$/.test(expected)) throw fail('SKILL_ARCHIVE_HASH_INVALID');
    const download = await serviceClient.downloadSkillArchive(copy(selected), { signal, assertCurrent: check });
    check();
    const { archive, archiveHash } = await fetchNativeSkillArchive({ url: download?.url, contentHash,
      signal, assertCurrent: check, fetchImpl, maxArchiveBytes });
    const manifests = await materializeCloudSkill(archive, directory, name, { assertCurrent: check });
    check();
    const matches = manifests.filter(item => String(parseFrontmatter(item.content).name || name).toLowerCase() === name.toLowerCase());
    if (matches.length !== 1) throw fail(matches.length ? 'SKILL_MANIFEST_AMBIGUOUS' : 'SKILL_MANIFEST_IDENTITY_MISMATCH');
    const manifest = matches[0];
    if (manifest.invocation.modelInvocable === false) throw fail('SKILL_MODEL_INVOCATION_DISABLED');
    return { ...selected, content: manifest.content, rootDir: manifest.resourceBase.path,
      manifestPath: manifest.path, definition: copy(manifest),
      archiveHash, manifestHash: createHash('sha256').update(manifest.content).digest('hex'),
      contract: NATIVE_SKILL_LOADER, cacheHit: false };
  };
}

/** Shared with pre-Run resource admission; the caller supplies its own trusted
 * authority. Only the Native ToolPort supplies a live intent/fence guard. */
export async function fetchNativeSkillArchive({ url: rawUrl, contentHash = '', signal, assertCurrent,
  fetchImpl = hostFetch, maxArchiveBytes = 20 * 1024 * 1024 }) {
  invariant(signal instanceof AbortSignal && typeof assertCurrent === 'function', 'native_skill_load_authority_required');
  invariant(Number.isSafeInteger(maxArchiveBytes) && maxArchiveBytes > 0 && maxArchiveBytes <= 20 * 1024 * 1024,
    'native_skill_archive_limit_invalid');
  const check = () => {
    signal.throwIfAborted();
    const verdict = assertCurrent();
    if (verdict && typeof verdict.then === 'function') Promise.resolve(verdict).catch(() => {});
    if (verdict !== true) throw fail('SKILL_LOAD_AUTHORITY_CHANGED');
  };
  check();
  const expected = String(contentHash).toLowerCase().replace(/^sha256:/, '');
  if (expected && !/^[a-f0-9]{64}$/.test(expected)) throw fail('SKILL_ARCHIVE_HASH_INVALID');
  let url;
  try { url = new URL(rawUrl); } catch { throw fail('SKILL_DOWNLOAD_URL_INVALID'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw fail('SKILL_DOWNLOAD_URL_INVALID');
  let response;
  try { response = await fetchImpl(url.href, { signal, redirect: 'error', credentials: 'omit' }); }
  catch { signal.throwIfAborted(); throw fail('SKILL_DOWNLOAD_FAILED'); }
  try { check(); }
  catch (error) { await response?.body?.cancel().catch(() => {}); throw error; }
  if (!response?.ok || !response.body) {
    await response?.body?.cancel().catch(() => {}); throw fail('SKILL_DOWNLOAD_FAILED');
  }
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxArchiveBytes)) {
    await response.body.cancel().catch(() => {}); throw fail('SKILL_ARCHIVE_TOO_LARGE');
  }
  const reader = response.body.getReader(), chunks = []; let bytes = 0;
  try {
    for (;;) {
      check(); let chunk;
      try { chunk = await reader.read(); }
      catch { signal.throwIfAborted(); throw fail('SKILL_DOWNLOAD_FAILED'); }
      check();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxArchiveBytes) throw fail('SKILL_ARCHIVE_TOO_LARGE');
      chunks.push(Buffer.from(chunk.value));
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  const archive = Buffer.concat(chunks, bytes), archiveHash = createHash('sha256').update(archive).digest('hex');
  if (expected && archiveHash !== expected) throw fail('SKILL_ARCHIVE_HASH_MISMATCH');
  check(); return { archive, archiveHash };
}
