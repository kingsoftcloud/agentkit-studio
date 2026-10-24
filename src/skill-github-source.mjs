/**
 * Bounded Node GitHub Skill source. Read-only inspection of GitHub repositories
 * for Agent Skills, by an injected Host fetch. No credentials, no environment
 * lookup, no caching, no state, no code execution. The parent owns the trusted
 * callback, durable storage of all bytes, and the abort/deadline signal.
 *
 * Exports createGithubSkillSource({fetchImpl}) -> {search, inspect}.
 *
 * search(query, {limit=5, signal, assertCurrent}) ->
 *   {repositories:[{full_name,url,description,owner,stars,default_branch,archived}]}
 * inspect(source, {ref='main', signal, assertCurrent}) ->
 *   {repository:{owner,name,url}, commit, candidates:[{candidateId,path,name,description,version,
 *     files:[{path,bytes:Uint8Array}]}]}
 *
 * Authority contract: assertCurrent is a SYNCHRONOUS callback that must return
 * exactly true. A thenable (or any non-true value) is observed and rejected.
 * assertCurrent is checked before AND after every await. The caller AbortSignal
 * is required; fetch and reader.read race against it so a noncooperative
 * transport cannot hang the caller. reader.cancel in finally is fire-and-forget
 * (never awaited unbounded). redirect:'error' on every request; no Authorization.
 *
 * Commit/tree SHA separation: a resolved commit SHA is verified via
 * /git/commits/<commit> (response.sha === commit, tree.sha extracted); the tree
 * is fetched by that tree SHA and response.sha === treeSHA is enforced. Git
 * blobs are read only by immutable blob SHAs; the Git blob sha1 over
 * "blob <len>\0<bytes>" is validated to match the returned id.
 *
 * All endpoints reconstructed as exact https://api.github.com/repos/<owner>/<repo>/...
 * — never from an API response. Candidate metadata uses parseFrontmatter/skillSlug
 * from skill-discovery.mjs. Version must match exact semver (require_exact_version).
 */
import { createHash } from 'node:crypto';
import { skillSlug, parseFrontmatter, SkillDiscoveryError } from './skill-discovery.mjs';
import { skillCandidateExcluded } from './skill-candidate-metadata.mjs';

export const GITHUB_SKILL_SOURCE_CONTRACT = 'agentkit.github-skill-source/v1';

const API_ORIGIN = 'https://api.github.com';
const GITHUB_HOST = 'github.com';
const HEX40 = /^[0-9a-f]{40}$/;
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const SAFE_OWNER_REPO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const EXACT_SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const MAX_TREE_ENTRIES = 10000;
const MAX_CANDIDATES = 5000;
const MAX_FILES_PER_CANDIDATE = 1000;
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_CANDIDATE_BYTES = 100 * 1024 * 1024;
const MAX_TOTAL_INSPECTION_BYTES = 200 * 1024 * 1024;
const MAX_BLOB_REQUESTS = 5000;
const MAX_SEARCH_LIMIT = 10;

// Git tree entry modes.
const MODE_TREE = '040000';
const MODE_FILE = '100644';
const MODE_EXEC = '100755';
const MODE_SYMLINK = '120000';
const MODE_SUBMODULE = '160000';
const VALID_BLOB_MODES = new Set([MODE_FILE, MODE_EXEC, MODE_SYMLINK]);

const fail = (code, message) => { const e = new SkillDiscoveryError(code, message); e.code = code; return e; };

function observeThenable(value) {
  if (value && typeof value.then === 'function') Promise.resolve(value).catch(() => {});
}

function checkAuthority(assertCurrent, signal) {
  signal?.throwIfAborted();
  if (typeof assertCurrent !== 'function') throw fail('skill_github_authority_required', 'assertCurrent is required');
  const result = assertCurrent();
  if (result !== true) {
    observeThenable(result);
    throw fail('skill_github_authority_lost', 'assertCurrent did not return true');
  }
  signal?.throwIfAborted();
}

/** Race a promise against a signal. On abort, reject immediately with the
 *  signal reason; the underlying work is observed (not cancelled) so a
 *  noncooperative transport cannot hang the caller. */
function raceAbort(promise, signal, lateValue) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = () => { if (!settled) { settled = true; cleanup(); reject(signal.reason); } };
    const cleanup = () => { signal.removeEventListener('abort', onAbort); };
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(
      value => { if (!settled) { settled = true; cleanup(); resolve(value); }
        else { try { Promise.resolve(lateValue?.(value)).catch(() => {}); } catch {} } },
      error => { if (!settled) { settled = true; cleanup(); reject(error); } },
    );
    if (signal.aborted) onAbort();
  });
}

/** Read a bounded JSON body via a reader racing the signal. */
async function readJson(response, signal, assertCurrent, maxBytes, contextCode) {
  if (!response.ok) throw fail('skill_github_http_failed', `GitHub API request failed (status ${response.status})`);
  if (!response.body || typeof response.body.getReader !== 'function')
    throw fail(contextCode, 'GitHub API response has no readable body');
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      checkAuthority(assertCurrent, signal);
      if (signal.aborted) throw signal.reason;
      const next = await raceAbort(reader.read(), signal);
      checkAuthority(assertCurrent, signal);
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxBytes) throw fail('skill_github_response_limit', 'GitHub API response exceeds the byte limit');
      chunks.push(next.value);
    }
  } finally {
    // Fire-and-forget cancel: never await unbounded; observe late rejection.
    try { Promise.resolve(reader.cancel()).catch(() => {}); } catch {}
    try { reader.releaseLock(); } catch {}
  }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw fail(contextCode, 'GitHub API response is not valid JSON'); }
}

/** Validate a POSIX-safe relative path: reject absolute, trailing slash, empty,
 *  dot components, backslash, null, control chars. */
function safeRelativePath(value) {
  if (typeof value !== 'string' || !value) return false;
  if (value.includes('\\') || value.includes('\0')) return false;
  if (value.startsWith('/')) return false;
  if (value.endsWith('/')) return false;
  const parts = value.split('/');
  for (const part of parts) {
    if (!part) return false;
    if (part === '.' || part === '..') return false;
    for (const ch of part) {
      const code = ch.codePointAt(0);
      if (code < 32 || code === 127) return false;
    }
  }
  return true;
}

/** Parse and validate a github.com URL into {owner, repo, ref, subdir}. */
function parseGithubUrl(source) {
  const raw = String(source || '').trim();
  if (!raw) throw fail('skill_github_url_invalid', 'A GitHub URL is required');

  // git@github.com:owner/repo[.git] — no tree/ path form for SSH.
  const sshMatch = /^git@github\.com:([A-Za-z0-9][A-Za-z0-9._-]{0,99})\/([A-Za-z0-9][A-Za-z0-9._-]{0,99}?)(?:\.git)?$/i.exec(raw);
  if (sshMatch) {
    const owner = sshMatch[1], repo = sshMatch[2];
    if (!SAFE_OWNER_REPO.test(owner) || !SAFE_OWNER_REPO.test(repo))
      throw fail('skill_github_url_invalid', 'GitHub owner/repo contains invalid characters');
    return { owner, repo, ref: null, subdir: '' };
  }

  // Parse before URL normalization: even default ports, encoded dot segments,
  // backslashes and control characters must not silently select another repo.
  const match = /^https?:\/\/github\.com\/([^?#\\\x00-\x20\x7f]+)$/i.exec(raw);
  if (!match) throw fail('skill_github_url_invalid', 'An exact github.com repository URL is required');
  let segments;
  try { segments = match[1].replace(/\/$/, '').split('/').map(part => decodeURIComponent(part)); }
  catch { throw fail('skill_github_url_invalid', 'GitHub URL encoding is invalid'); }
  if (segments.some(part => !safeRelativePath(part) || part.includes('/')))
    throw fail('skill_github_url_invalid', 'GitHub URL contains an unsafe path');
  if (segments.length < 2) throw fail('skill_github_url_invalid', 'GitHub URL must include owner/repo');
  const owner = segments[0];
  let repo = segments[1];
  if (repo.endsWith('.git')) repo = repo.slice(0, -4);
  if (!SAFE_OWNER_REPO.test(owner) || !SAFE_OWNER_REPO.test(repo))
    throw fail('skill_github_url_invalid', 'GitHub owner/repo contains invalid characters');

  let ref = null, subdir = '';
  if (segments.length >= 3) {
    if (segments[2] !== 'tree') throw fail('skill_github_url_invalid', 'Only /tree/<ref>[/<subdir>] path form is supported');
    if (segments.length < 4) throw fail('skill_github_url_invalid', 'tree/ requires a ref');
    // Ref is a single segment; a slash-bearing ref must use the ref argument
    // with a plain /owner/repo URL (documented ambiguity avoidance).
    ref = segments[3];
    subdir = segments.slice(4).join('/');
  }
  // Reject dot traversal in subdir.
  if (subdir) {
    for (const part of subdir.split('/')) {
      if (part === '..' || part === '.') throw fail('skill_github_url_invalid', 'Subdir must not contain dot traversal');
    }
  }
  return { owner, repo, ref, subdir };
}

function candidateId(owner, repo, commit, path) {
  return 'skill_' + createHash('sha256').update(`${owner}/${repo}@${commit}:${path}`).digest('hex').slice(0, 16);
}

function validateBlobSha1(blobId, bytes) {
  const header = Buffer.from(`blob ${bytes.byteLength}\0`, 'utf8');
  const hash = createHash('sha1');
  hash.update(header); hash.update(bytes);
  return hash.digest('hex') === String(blobId).toLowerCase();
}

/** Decode base64: strip CR/LF, require canonical standard padded base64
 *  (length multiple of 4, re-encode equality). */
function decodeBase64Canonical(value) {
  if (typeof value !== 'string') return null;
  const stripped = value.replace(/[\r\n]/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(stripped)) return null;
  if (stripped.length % 4 !== 0) return null;
  let bytes;
  try { bytes = Buffer.from(stripped, 'base64'); } catch { return null; }
  // Canonical: re-encoding must produce the identical string.
  if (bytes.toString('base64') !== stripped) return null;
  return bytes;
}

function requireExactVersion(version) {
  if (typeof version !== 'string' || !EXACT_SEMVER.test(version))
    throw fail('skill_github_manifest_invalid', 'SKILL.md version must be an exact semver');
}

export function createGithubSkillSource({ fetchImpl } = {}) {
  if (typeof fetchImpl !== 'function') throw fail('skill_github_fetch_required', 'fetchImpl is required');

  async function apiGet(url, signal, assertCurrent, contextCode, maxBytes = 2 * 1024 * 1024) {
    checkAuthority(assertCurrent, signal);
    if (!(signal instanceof AbortSignal)) throw fail('skill_github_signal_required', 'An AbortSignal is required');
    signal.throwIfAborted();
    let response;
    try {
      response = await raceAbort(
        fetchImpl(url, { method: 'GET', redirect: 'error', signal, headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } }),
        signal, value => value?.body?.cancel(),
      );
    } catch (error) {
      checkAuthority(assertCurrent, signal);
      if (signal.aborted) throw signal.reason;
      throw fail('skill_github_fetch_failed', 'GitHub API request could not be completed');
    }
    checkAuthority(assertCurrent, signal);
    if (signal.aborted) throw signal.reason;
    return readJson(response, signal, assertCurrent, maxBytes, contextCode);
  }

  async function search(query, { limit = 5, signal, assertCurrent } = {}) {
    if (!(signal instanceof AbortSignal)) throw fail('skill_github_signal_required', 'An AbortSignal is required');
    if (typeof query !== 'string' || !query.trim()) throw fail('skill_github_query_invalid', 'A search query is required');
    const boundedLimit = Math.min(Math.max(1, Math.floor(limit) || 1), MAX_SEARCH_LIMIT);
    // Match pinned reference behavior: search in name and description.
    const encoded = encodeURIComponent(`${query.trim()} in:name,description`);
    const url = `${API_ORIGIN}/search/repositories?q=${encoded}&per_page=${boundedLimit}`;
    const data = await apiGet(url, signal, assertCurrent, 'skill_github_search_failed', 4 * 1024 * 1024);
    if (!data || typeof data !== 'object') throw fail('skill_github_search_failed', 'GitHub search response is invalid');
    if (!Array.isArray(data.items)) throw fail('skill_github_search_failed', 'GitHub search omitted repository items');
    const items = data.items;
    if (items.length > MAX_SEARCH_LIMIT) throw fail('skill_github_search_failed', 'GitHub search returned too many items');
    const repositories = [];
    for (const item of items) {
      if (!item || typeof item !== 'object') throw fail('skill_github_search_failed', 'GitHub search item is invalid');
      const full = String(item.full_name || '');
      const parts = full.split('/');
      if (parts.length !== 2 || parts.some(part => !SAFE_OWNER_REPO.test(part)))
        throw fail('skill_github_search_failed', 'GitHub search item has invalid full_name');
      // Reconstruct the URL; never echo the API's html_url unchecked.
      repositories.push({
        full_name: full,
        url: `https://${GITHUB_HOST}/${parts[0]}/${parts[1]}`,
        description: String(item.description || ''),
        owner: parts[0],
        stars: Number.isFinite(item.stargazers_count) ? Number(item.stargazers_count) : 0,
        default_branch: String(item.default_branch || ''),
        archived: item.archived === true,
      });
    }
    return { repositories };
  }

  /** Resolve a ref to an immutable 40-hex commit SHA via /commits/<ref>. */
  async function resolveCommit(owner, repo, ref, signal, assertCurrent) {
    if (HEX40.test(ref.toLowerCase())) return ref.toLowerCase();
    if (!ref || !SAFE_REF.test(ref)) throw fail('skill_github_ref_invalid', 'GitHub ref contains invalid characters');
    const url = `${API_ORIGIN}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(ref)}`;
    const data = await apiGet(url, signal, assertCurrent, 'skill_github_ref_invalid', 1 * 1024 * 1024);
    const sha = String(data?.sha || '').toLowerCase();
    if (!HEX40.test(sha)) throw fail('skill_github_ref_invalid', 'GitHub response omitted an immutable commit SHA');
    return sha;
  }

  /** Verify a commit SHA and extract its tree SHA via /git/commits/<commit>. */
  async function verifyCommitAndGetTreeSha(owner, repo, commit, signal, assertCurrent) {
    const url = `${API_ORIGIN}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/commits/${commit}`;
    const data = await apiGet(url, signal, assertCurrent, 'skill_github_commit_failed', 1 * 1024 * 1024);
    if (!data || typeof data !== 'object') throw fail('skill_github_commit_failed', 'GitHub commit response is invalid');
    const returnedSha = String(data.sha || '').toLowerCase();
    if (returnedSha !== commit) throw fail('skill_github_commit_failed', 'GitHub commit SHA mismatch');
    const treeSha = String(data.tree?.sha || '').toLowerCase();
    if (!HEX40.test(treeSha)) throw fail('skill_github_commit_failed', 'GitHub commit has no tree SHA');
    return treeSha;
  }

  /** Fetch a recursive Git tree by tree SHA. Enforce response.sha === treeSHA. */
  async function fetchTree(owner, repo, treeSha, signal, assertCurrent) {
    const url = `${API_ORIGIN}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${treeSha}?recursive=1`;
    const data = await apiGet(url, signal, assertCurrent, 'skill_github_tree_failed', 8 * 1024 * 1024);
    if (!data || typeof data !== 'object') throw fail('skill_github_tree_failed', 'GitHub tree response is invalid');
    const returnedSha = String(data.sha || '').toLowerCase();
    if (returnedSha !== treeSha) throw fail('skill_github_tree_failed', 'GitHub tree SHA mismatch');
    if (data.truncated === true) throw fail('skill_github_tree_truncated', 'GitHub tree is truncated; cannot inspect safely');
    if (data.truncated !== false || !Array.isArray(data.tree)) throw fail('skill_github_tree_failed', 'GitHub tree completeness is unknown');
    const entries = data.tree;
    if (entries.length > MAX_TREE_ENTRIES) throw fail('skill_github_tree_limit', 'GitHub tree exceeds the entry limit');
    return entries;
  }

  /** Validate EVERY tree entry: path safety, type/mode, SHA, duplicates, and
   *  file/directory ancestor conflicts. Done once before candidate filtering. */
  function validateTreeEntries(entries) {
    const paths = new Map(); // path -> {type, mode}
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') throw fail('skill_github_tree_invalid', 'Tree entry is not an object');
      const path = String(entry.path || '');
      const type = String(entry.type || '');
      const mode = String(entry.mode || '');
      const sha = String(entry.sha || '').toLowerCase();
      if (!path || !safeRelativePath(path)) throw fail('skill_github_unsafe_path', 'Tree entry has an unsafe path');
      if (!HEX40.test(sha)) throw fail('skill_github_blob_invalid', 'Tree entry has no immutable SHA');
      if (type === 'tree') {
        if (mode !== MODE_TREE) throw fail('skill_github_unsafe_entry', 'Tree entry has invalid mode for a directory');
      } else if (type === 'blob') {
        if (!VALID_BLOB_MODES.has(mode)) throw fail('skill_github_unsafe_entry', 'Tree entry has invalid blob mode');
      } else if (type === 'commit' && mode === MODE_SUBMODULE) {
        // A submodule outside selected Skills is valid repository metadata.
      } else {
        throw fail('skill_github_unsafe_entry', 'Tree entry has an unknown type');
      }
      // Duplicate path.
      if (paths.has(path)) throw fail('skill_github_duplicate_path', 'Tree has duplicate paths');
      paths.set(path, { type, mode });
    }
    for (const path of paths.keys()) {
      const parts = path.split('/');
      for (let i = 1; i < parts.length; i++) {
        const parent = paths.get(parts.slice(0, i).join('/'));
        if (parent && parent.type !== 'tree') throw fail('skill_github_path_conflict', 'Tree has a file/directory path conflict');
      }
    }
  }

  /** Locate SKILL.md candidate roots. Each root is a directory containing a
   *  SKILL.md blob (non-symlink, non-submodule). Nested skills are valid
   *  separate candidates. */
  function findCandidateRoots(entries) {
    const candidates = [];
    const seen = new Set();
    for (const entry of entries) {
      const path = String(entry.path || '');
      const type = String(entry.type || '');
      const mode = String(entry.mode || '');
      const base = path.split('/').pop();
      if (skillCandidateExcluded(path)) continue;
      if (base !== 'SKILL.md') continue;
      // After validateTreeEntries, type is 'blob' or 'tree'. SKILL.md must be a blob.
      if (type !== 'blob') throw fail('skill_github_unsafe_entry', 'SKILL.md is not a regular file');
      if (mode === MODE_SYMLINK || mode === MODE_SUBMODULE)
        throw fail('skill_github_unsafe_entry', 'SKILL.md is a symlink or submodule');
      const root = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
      const key = root; // empty string for repo root
      if (seen.has(key)) throw fail('skill_github_duplicate_manifest', 'Multiple SKILL.md in one candidate directory');
      seen.add(key);
      candidates.push({ root, manifestSha: String(entry.sha).toLowerCase() });
      if (candidates.length > MAX_CANDIDATES) throw fail('skill_github_candidate_limit', 'Too many Skill candidates');
    }
    return candidates;
  }

  /** Collect ALL blob entries under a candidate root (complete subtree, including
   *  nested child skills). Reject symlink/submodule entries within the candidate. */
  function collectCandidateFiles(entries, root) {
    const prefix = root ? root + '/' : '';
    const files = [];
    for (const entry of entries) {
      const path = String(entry.path || '');
      const type = String(entry.type || '');
      const mode = String(entry.mode || '');
      if (root && !path.startsWith(prefix)) continue;
      if (skillCandidateExcluded(path)) continue;
      if (mode === MODE_SYMLINK || mode === MODE_SUBMODULE)
        throw fail('skill_github_unsafe_entry', 'Candidate contains a symlink or submodule');
      if (type === 'tree') continue;
      const rel = root ? path.slice(prefix.length) : path;
      if (entry.size !== undefined && (!Number.isSafeInteger(entry.size) || entry.size < 0))
        throw fail('skill_github_tree_invalid', 'Git tree size metadata is invalid');
      files.push({ rel, sha: String(entry.sha).toLowerCase(), mode, size: entry.size });
    }
    if (files.length > MAX_FILES_PER_CANDIDATE) throw fail('skill_github_file_limit', 'Candidate exceeds the file count limit');
    if (files.reduce((n, file) => n + (file.size ?? 0), 0) > MAX_CANDIDATE_BYTES)
      throw fail('skill_github_candidate_bytes_limit', 'Skill candidate exceeds the byte limit');
    if (!files.some(f => f.rel === 'SKILL.md')) throw fail('skill_github_manifest_missing', 'Candidate root has no SKILL.md');
    return files;
  }

  async function fetchBlob(owner, repo, sha, signal, assertCurrent, blobBudget) {
    if (!HEX40.test(sha)) throw fail('skill_github_blob_invalid', 'Git blob SHA is invalid');
    blobBudget.spend();
    const url = `${API_ORIGIN}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/blobs/${sha}`;
    // base64 content has ~33% overhead; budget for the encoded JSON form.
    const data = await apiGet(url, signal, assertCurrent, 'skill_github_blob_failed', MAX_FILE_BYTES * 2 + 8192);
    if (!data || typeof data !== 'object') throw fail('skill_github_blob_invalid', 'Git blob response is invalid');
    const returnedSha = String(data.sha || '').toLowerCase();
    if (returnedSha !== sha) throw fail('skill_github_blob_invalid', 'Git blob SHA mismatch');
    if (data.encoding !== 'base64') throw fail('skill_github_blob_invalid', 'Git blob encoding is not base64');
    const bytes = decodeBase64Canonical(String(data.content || ''));
    if (!bytes) throw fail('skill_github_blob_invalid', 'Git blob content is not canonical base64');
    if (bytes.byteLength > MAX_FILE_BYTES) throw fail('skill_github_blob_limit', 'Git blob exceeds the per-file byte limit');
    if (!validateBlobSha1(sha, bytes)) throw fail('skill_github_blob_invalid', 'Git blob sha1 digest does not match the content');
    // size must be a safe integer equal to actual decoded bytes.
    if (!Number.isSafeInteger(data.size) || data.size !== bytes.byteLength)
      throw fail('skill_github_blob_invalid', 'Git blob size metadata does not match the content');
    return bytes;
  }

  async function inspect(source, { ref = 'main', signal, assertCurrent } = {}) {
    if (!(signal instanceof AbortSignal)) throw fail('skill_github_signal_required', 'An AbortSignal is required');
    const parsed = parseGithubUrl(source);
    const requestedRef = parsed.ref || ref || 'main';
    if (!requestedRef) throw fail('skill_github_ref_invalid', 'A ref is required');

    checkAuthority(assertCurrent, signal);

    // 1. Resolve ref → commit SHA.
    const commit = await resolveCommit(parsed.owner, parsed.repo, requestedRef, signal, assertCurrent);
    checkAuthority(assertCurrent, signal);

    // 1b. Verify commit and extract tree SHA (commit SHA ≠ tree SHA).
    const treeSha = await verifyCommitAndGetTreeSha(parsed.owner, parsed.repo, commit, signal, assertCurrent);
    checkAuthority(assertCurrent, signal);

    // 2. Fetch tree by tree SHA; enforce response.sha === treeSha.
    const entries = await fetchTree(parsed.owner, parsed.repo, treeSha, signal, assertCurrent);
    checkAuthority(assertCurrent, signal);

    // 7. Validate all tree entries before candidate filtering.
    validateTreeEntries(entries);
    checkAuthority(assertCurrent, signal);

    const candidateRoots = findCandidateRoots(entries);
    checkAuthority(assertCurrent, signal);

    const blobBudget = { count: 0, spend() { this.count++; if (this.count > MAX_BLOB_REQUESTS) throw fail('skill_github_blob_request_limit', 'Exceeded the maximum blob request count'); } };
    const blobs = new Map(); let totalBytes = 0;
    const blob = async sha => {
      if (blobs.has(sha)) return blobs.get(sha);
      const bytes = await fetchBlob(parsed.owner, parsed.repo, sha, signal, assertCurrent, blobBudget);
      totalBytes += bytes.byteLength;
      if (totalBytes > MAX_TOTAL_INSPECTION_BYTES) throw fail('skill_github_inspection_limit', 'Total inspection bytes exceeded the limit');
      const value = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      blobs.set(sha, value); return value;
    };

    const candidates = [], repositoryFiles = new Set(); let repositoryBytes = 0;
    for (const { root } of candidateRoots) {
      checkAuthority(assertCurrent, signal);
      if (parsed.subdir) {
        if (root !== parsed.subdir && !(root.startsWith(parsed.subdir + '/'))) continue;
      }
      try {
        const files = collectCandidateFiles(entries, root);
        checkAuthority(assertCurrent, signal);

        // Fetch manifest once; reuse for both metadata and file list.
        const manifestFile = files.find(f => f.rel === 'SKILL.md');
        if (!manifestFile) throw fail('skill_github_manifest_missing', 'Candidate root has no SKILL.md');
        const manifestBytes = await blob(manifestFile.sha);
        if (manifestFile.size !== undefined && manifestFile.size !== manifestBytes.byteLength)
          throw fail('skill_github_blob_invalid', 'Git tree and blob sizes disagree');
        checkAuthority(assertCurrent, signal);
        let candidateBytes = manifestBytes.byteLength;

        let metadata, slug, description, version;
        try {
          const manifestText = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(manifestBytes);
          metadata = parseFrontmatter(manifestText, { strict: true });
        } catch { throw fail('skill_github_manifest_invalid', 'SKILL.md is not valid UTF-8'); }
        if (!metadata || typeof metadata !== 'object')
          throw fail('skill_github_manifest_invalid', 'SKILL.md frontmatter is missing or invalid');
        if (typeof metadata.name !== 'string' || !metadata.name.trim())
          throw fail('skill_github_manifest_invalid', 'SKILL.md frontmatter must contain a name');
        if (typeof metadata.description !== 'string' || !metadata.description.trim())
          throw fail('skill_github_manifest_invalid', 'SKILL.md frontmatter must contain a description');
        version = String(metadata.version || '1.0.0');
        requireExactVersion(version);
        slug = skillSlug(String(metadata.name));
        description = String(metadata.description);
        checkAuthority(assertCurrent, signal);

        // Fetch remaining files (manifest already fetched and counted).
        const fileResults = [{ path: 'SKILL.md', bytes: manifestBytes }];
        for (const file of files) {
          if (file.rel === 'SKILL.md') continue; // reuse
          checkAuthority(assertCurrent, signal);
          const bytes = await blob(file.sha);
          if (file.size !== undefined && file.size !== bytes.byteLength)
            throw fail('skill_github_blob_invalid', 'Git tree and blob sizes disagree');
          checkAuthority(assertCurrent, signal);
          candidateBytes += bytes.byteLength;
          if (candidateBytes > MAX_CANDIDATE_BYTES) throw fail('skill_github_candidate_bytes_limit', 'Candidate exceeds the byte limit');
          fileResults.push({ path: file.rel, bytes });
        }
        for (const file of fileResults) {
          const path = root ? `${root}/${file.path}` : file.path;
          if (!repositoryFiles.has(path)) {
            repositoryFiles.add(path); repositoryBytes += file.bytes.byteLength;
            if (repositoryBytes > MAX_TOTAL_INSPECTION_BYTES || repositoryFiles.size > MAX_BLOB_REQUESTS)
              throw fail('skill_github_inspection_limit', 'Total inspection files or bytes exceeded the limit');
          }
        }

        fileResults.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

        // 3. Root path is empty string, matching parent interface.
        candidates.push({
          candidateId: candidateId(parsed.owner, parsed.repo, commit, root),
          path: root,
          name: slug,
          description,
          version,
          files: fileResults,
        });
      } catch (error) {
        checkAuthority(assertCurrent, signal);
        // Candidate validation must not hide healthy siblings. Transport,
        // authority, repository integrity and global budgets still fail closed.
        if (!['skill_github_manifest_invalid', 'skill_github_file_limit', 'skill_github_candidate_bytes_limit',
          'skill_github_blob_limit', 'SKILL_NAME_INVALID'].includes(error?.code)) throw error;
        candidates.push({ candidateId: candidateId(parsed.owner, parsed.repo, commit, root), path: root,
          status: 'invalid', name: root.split('/').pop() || parsed.repo, version: '', description: '', files: [],
          diagnostics: [{ code: error.code, message: 'Skill candidate could not be inspected.' }] });
      }
    }

    return {
      repository: { owner: parsed.owner, name: parsed.repo, url: `https://${GITHUB_HOST}/${parsed.owner}/${parsed.repo}` },
      commit,
      candidates,
    };
  }

  return { search, inspect, contract: GITHUB_SKILL_SOURCE_CONTRACT };
}

export { skillSlug, parseFrontmatter, SkillDiscoveryError, parseGithubUrl, candidateId,
  requireExactVersion, checkAuthority, raceAbort };
