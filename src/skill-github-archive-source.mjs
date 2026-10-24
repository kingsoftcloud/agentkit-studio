import { createGithubSkillSource, GITHUB_SKILL_SOURCE_CONTRACT, parseGithubUrl, candidateId,
  requireExactVersion, checkAuthority, raceAbort, parseFrontmatter, skillSlug } from './skill-github-source.mjs';
import { resolveGithubCommit } from './skill-github-ref.mjs';
import { readGithubSkillArchive } from './skill-github-archive.mjs';

const fail = code => Object.assign(new Error(code), { code });
const sortPath = (a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
const cancel = value => { try { Promise.resolve(value?.cancel()).catch(() => {}); } catch {} };

async function download(fetchImpl, url, signal, assertCurrent) {
  const current = AbortSignal.any([signal, AbortSignal.timeout(20000)]);
  const guard = () => { checkAuthority(assertCurrent, signal); current.throwIfAborted(); };
  let response, reader;
  try {
    guard(); response = await raceAbort(fetchImpl(url, { method: 'GET', redirect: 'error', signal: current,
      headers: { Accept: 'application/zip' } }), current, value => cancel(value?.body)); guard();
    if (!response.ok) throw fail('skill_github_archive_fetch_failed');
    const length = response.headers?.get('content-length');
    if (length && (!/^\d+$/.test(length) || Number(length) > 50 * 1024 * 1024)) throw fail('skill_github_archive_limit');
    if (typeof response.body?.getReader !== 'function') throw fail('skill_github_archive_fetch_failed');
    reader = response.body.getReader(); const chunks = []; let bytes = 0;
    for (;;) {
      guard(); const next = await raceAbort(reader.read(), current); guard();
      if (next.done) break;
      if (!(next.value instanceof Uint8Array)) throw fail('skill_github_archive_fetch_failed');
      bytes += next.value.byteLength;
      if (bytes > 50 * 1024 * 1024) throw fail('skill_github_archive_limit');
      chunks.push(next.value);
    }
    return Buffer.concat(chunks);
  } catch (error) {
    checkAuthority(assertCurrent, signal);
    if (['skill_github_archive_limit', 'skill_github_archive_fetch_failed', 'skill_github_authority_lost'].includes(error?.code)) throw error;
    throw fail('skill_github_archive_fetch_failed');
  } finally {
    cancel(reader ?? response?.body); try { reader?.releaseLock(); } catch {}
  }
}

/** Studio's production GitHub inspection path: REST/Git ref resolution followed
 * by one immutable codeload ZIP. Search retains the existing public API port. */
export function createGithubArchiveSkillSource({ fetchImpl } = {}) {
  const search = createGithubSkillSource({ fetchImpl }).search;
  return { contract: GITHUB_SKILL_SOURCE_CONTRACT, transport: 'github-archive/v1', search,
    async inspect(source, { ref = 'main', signal, assertCurrent } = {}) {
      if (!(signal instanceof AbortSignal)) throw fail('skill_github_signal_required');
      checkAuthority(assertCurrent, signal);
      const { owner, repo, ref: urlRef, subdir } = parseGithubUrl(source);
      const commit = await resolveGithubCommit({ fetchImpl, owner, repository: repo, ref: urlRef || ref, signal, assertCurrent });
      checkAuthority(assertCurrent, signal);
      const bytes = await download(fetchImpl, `https://codeload.github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/zip/${commit}`,
        signal, assertCurrent); checkAuthority(assertCurrent, signal);
      const files = readGithubSkillArchive(bytes, { assertCurrent: () => checkAuthority(assertCurrent, signal) });
      const manifests = files.filter(file => file.path === 'SKILL.md' || file.path.endsWith('/SKILL.md'));
      const candidates = [];
      for (const manifest of manifests) {
        checkAuthority(assertCurrent, signal);
        const root = manifest.path === 'SKILL.md' ? '' : manifest.path.slice(0, -9);
        if (subdir && root !== subdir && !root.startsWith(subdir + '/')) continue;
        const id = candidateId(owner, repo, commit, root);
        const selected = files.filter(file => !root || file.path.startsWith(root + '/'))
          .map(file => ({ path: root ? file.path.slice(root.length + 1) : file.path, bytes: file.bytes })).sort(sortPath);
        let code;
        if (selected.length > 1000 || selected.reduce((n, file) => n + file.bytes.byteLength, 0) > 100 * 1024 * 1024)
          code = 'skill_github_candidate_limit';
        let metadata, name, version;
        if (!code) {
          try {
            metadata = parseFrontmatter(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(manifest.bytes), { strict: true });
            if (typeof metadata.name !== 'string' || !metadata.name.trim()
              || typeof metadata.description !== 'string' || !metadata.description.trim()) throw fail('skill_github_manifest_invalid');
            name = skillSlug(metadata.name); version = String(metadata.version || '1.0.0'); requireExactVersion(version);
          } catch { code = 'skill_github_manifest_invalid'; }
        }
        if (code) candidates.push({ candidateId: id, path: root, status: 'invalid', name: root.split('/').pop() || repo,
          version: '', description: '', files: [], diagnostics: [{ code, message: 'Skill candidate could not be inspected.' }] });
        else candidates.push({ candidateId: id, path: root, name, version, description: metadata.description, files: selected });
      }
      candidates.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : sortPath(a, b));
      checkAuthority(assertCurrent, signal);
      return { repository: { owner, name: repo, url: `https://github.com/${owner}/${repo}` }, commit, candidates };
    },
  };
}
