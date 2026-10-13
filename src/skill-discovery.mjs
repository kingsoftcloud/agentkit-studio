/** Local skill discovery for the Studio plugin Node host.
 *
 * The legacy Studio Host owned workspace skill scanning; the plugin Node half
 * now owns the same contract: scan directories for `SKILL.md` manifests,
 * project candidates with risk markers, preview files, and import into the
 * Studio store. Paths are only read, never executed.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';

const DEFAULT_SCAN_RELATIVES = ['skills', '.agents/skills', '.codex/skills', '.claude/skills'];
const MAX_DEPTH = 4;
const MAX_FILE_BYTES = 512 * 1024;
const RECORD_TTL_MS = 30 * 60 * 1000;

export class SkillDiscoveryError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SkillDiscoveryError';
    this.code = code;
    this.details = details;
  }
}

export function skillSlug(value) {
  const slug = String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) throw new SkillDiscoveryError('SKILL_NAME_INVALID', 'SKILL.md 的 name 无法生成目录 slug');
  return slug.slice(0, 64);
}

export function parseFrontmatter(source) {
  const text = String(source || '');
  if (!text.startsWith('---')) return {};
  const end = text.indexOf('\n---', 3);
  if (end < 0) return {};
  const metadata = {};
  for (const line of text.slice(3, end).split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line.trim());
    if (match) metadata[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
  }
  return metadata;
}

function relativeDisplay(path, roots) {
  for (const root of roots) {
    const rel = relative(root, path);
    if (!rel) return '.';
    if (!rel.startsWith('..')) return rel.split(sep).join('/');
  }
  return path.split(sep).join('/');
}

async function listFiles(directory, base = directory, depth = 0, out = []) {
  if (depth > MAX_DEPTH) return out;
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const full = join(directory, entry.name);
    if (entry.name.startsWith('.') && entry.name !== '.well-known') continue;
    if (entry.isDirectory()) await listFiles(full, base, depth + 1, out);
    else if (entry.isFile()) {
      let size = 0;
      try { size = (await stat(full)).size; } catch { continue; }
      out.push({ absolute: full, relative: relative(base, full).split(sep).join('/'), size });
    }
  }
  return out;
}

async function directoryDigest(files) {
  const hash = createHash('sha256');
  for (const file of files.slice().sort((a, b) => a.relative.localeCompare(b.relative))) {
    hash.update(file.relative);
    hash.update(await readFile(file.absolute).catch(() => Buffer.alloc(0)));
  }
  return hash.digest('hex');
}

export function createSkillDiscovery({ home = homedir(), storeDir } = {}) {
  const store = resolve(storeDir || join(home, '.agentkit', 'studio', 'skills'));
  const records = new Map();

  function expandScanPaths(scanPaths) {
    const requested = (Array.isArray(scanPaths) && scanPaths.length ? scanPaths : []).map(item => String(item || '').trim()).filter(Boolean);
    if (requested.length) {
      return requested.map(item => ({ root: resolve(item.startsWith('~') ? join(home, item.slice(1)) : item), source: 'custom', displayRoot: item }));
    }
    return DEFAULT_SCAN_RELATIVES.map(relative => ({ root: resolve(home, relative), source: relative, displayRoot: `~/${relative}` }));
  }

  async function discover(scanPaths = null) {
    const scans = expandScanPaths(scanPaths);
    const candidates = [], sourceDirectories = new Map();
    const seen = new Set();
    for (const scan of scans) {
      let manifests;
      try { manifests = await listFiles(scan.root, scan.root, 0).then(files => files.filter(file => basename(file.absolute) === 'SKILL.md' && file.relative.split('/').length <= MAX_DEPTH + 1)); }
      catch { continue; }
      for (const manifest of manifests) {
        const directory = await realpath(dirname(manifest.absolute));
        const relativePath = relativeDisplay(dirname(manifest.absolute), [scan.root]);
        const identity = directory;
        if (seen.has(identity)) continue;
        seen.add(identity);
        const candidate = await inspectCandidate(directory, scan, relativePath);
        candidates.push(candidate);
        sourceDirectories.set(candidate.candidateId, directory);
      }
    }
    candidates.sort((a, b) => (a.name || '').localeCompare(b.name || '') || a.path.localeCompare(b.path));
    const token = `skd_${randomUUID().replace(/-/g, '')}`;
    records.set(token, { token, candidates, sourceDirectories, expiresAt: Date.now() + RECORD_TTL_MS });
    for (const [key, value] of records) if (value.expiresAt < Date.now()) records.delete(key);
    return { format: 'agentkit.skill-discovery/v1', inspectionToken: token, scanPaths: scans.map(scan => scan.displayRoot), candidates, requiresConfirmation: true };
  }

  async function inspectCandidate(directory, scan, relativePath) {
    const candidateId = 'skill_' + createHash('sha256').update(directory).digest('hex').slice(0, 16);
    const displayPath = relativePath === '.' ? scan.displayRoot : `${scan.displayRoot}/${relativePath}`;
    try {
      const files = await listFiles(directory);
      const metadata = parseFrontmatter(await readFile(join(directory, 'SKILL.md'), 'utf8'));
      const name = skillSlug(metadata.name || basename(directory));
      const version = String(metadata.version || '1.0.0');
      const scripts = files.filter(file => ['.py', '.sh', '.js', '.ts', '.ps1'].some(ext => file.relative.toLowerCase().endsWith(ext)));
      const lower = (await readFile(join(directory, 'SKILL.md'), 'utf8')).toLowerCase();
      const networkMarkers = ['http://', 'https://', 'curl ', 'wget ', 'network'].filter(marker => lower.includes(marker));
      const destination = join(store, name);
      let conflict = false;
      try { conflict = (await stat(destination)).isDirectory(); } catch { conflict = false; }
      return {
        candidateId, path: displayPath, source: scan.source, relativePath,
        name, displayName: String(metadata.name || basename(directory)),
        description: String(metadata.description || ''), version,
        digest: await directoryDigest(files), status: conflict ? 'conflict' : 'ready',
        fileCount: files.length, totalBytes: files.reduce((sum, file) => sum + file.size, 0),
        risk: { containsScripts: scripts.length > 0, scripts: scripts.map(file => file.relative), networkMarkers, requiresReview: scripts.length > 0 || networkMarkers.length > 0 },
        diagnostics: [],
      };
    } catch (error) {
      return {
        candidateId, path: displayPath, source: scan.source, relativePath,
        name: basename(directory), displayName: basename(directory), description: '',
        version: '0.0.0', digest: null, status: 'invalid', fileCount: 0, totalBytes: 0,
        risk: { containsScripts: false, scripts: [], networkMarkers: [], requiresReview: false },
        diagnostics: [String(error?.message || error)],
      };
    }
  }

  function record(token) {
    const value = records.get(String(token || ''));
    if (!value || value.expiresAt < Date.now()) {
      records.delete(String(token || ''));
      throw new SkillDiscoveryError('SKILL_DISCOVERY_TOKEN_INVALID', '发现会话不存在或已过期，请重新扫描', {}, );
    }
    return value;
  }

  function candidateOf(token, candidateId) {
    const found = record(token).candidates.find(item => item.candidateId === String(candidateId || ''));
    if (!found) throw new SkillDiscoveryError('SKILL_CANDIDATE_NOT_FOUND', '候选 Skill 不存在', { candidateId });
    return found;
  }

  function sourceDirectory(token, candidate) {
    // Only the server-recorded directory from this explicit scan is admitted.
    // Display paths and browser payloads never become filesystem authority.
    const directory = record(token).sourceDirectories.get(candidate.candidateId);
    if (!directory) throw new SkillDiscoveryError('SKILL_DISCOVERY_PATH_INVALID', '候选目录不在本次扫描中');
    return directory;
  }

  async function previewDiscovered(token, candidateId, filePath = '') {
    const candidate = candidateOf(token, candidateId);
    const directory = sourceDirectory(token, candidate);
    if (!filePath) {
      const files = await listFiles(directory);
      return { files: files.map(file => ({ path: file.relative, size: file.size })) };
    }
    const target = resolve(directory, filePath);
    if (!target.startsWith(directory + sep)) throw new SkillDiscoveryError('SKILL_PREVIEW_PATH_INVALID', '预览路径越界', { path: filePath });
    const info = await stat(target).catch(() => null);
    if (!info?.isFile()) throw new SkillDiscoveryError('SKILL_PREVIEW_NOT_FOUND', '文件不存在', { path: filePath });
    if (info.size > MAX_FILE_BYTES) return { path: filePath, size: info.size, truncated: true, content: '' };
    const content = await readFile(target, 'utf8');
    return { path: filePath, size: info.size, content };
  }

  async function commitDiscovered(token, candidateId, overwrite = false) {
    const candidate = candidateOf(token, candidateId);
    if (candidate.status === 'invalid') throw new SkillDiscoveryError('SKILL_IMPORT_FAILED', '候选 Skill 无法解析', { candidateId });
    const directory = sourceDirectory(token, candidate);
    const destination = join(store, candidate.name);
    if (!overwrite) {
      let exists = false;
      try { exists = (await stat(destination)).isDirectory(); } catch { exists = false; }
      if (exists) throw new SkillDiscoveryError('SKILL_ALREADY_EXISTS', '同名 Skill 已导入，确认覆盖后重试', { name: candidate.name });
    }
    await rm(destination, { recursive: true, force: true });
    const files = await listFiles(directory);
    for (const file of files) {
      const target = join(destination, file.relative);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, await readFile(file.absolute));
    }
    return { resourceId: `skill-${candidate.name}-${candidate.version}`, name: candidate.name, displayName: candidate.displayName, description: candidate.description, version: candidate.version, status: 'ready', kind: 'skill', source: 'local-import' };
  }

  async function listInstalled() {
    let entries;
    try { entries = await readdir(store, { withFileTypes: true }); } catch { return { items: [], nextCursor: null, total: 0, source: 'local-store' }; }
    const items = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const directory = join(store, entry.name);
      const manifest = join(directory, 'SKILL.md');
      try {
        const metadata = parseFrontmatter(await readFile(manifest, 'utf8'));
        const files = await listFiles(directory);
        items.push({
          resourceId: `skill-${entry.name}-${String(metadata.version || '1.0.0')}`,
          name: entry.name, displayName: String(metadata.name || entry.name),
          description: String(metadata.description || ''), version: String(metadata.version || '1.0.0'),
          status: 'ready', kind: 'skill', source: 'local-import', fileCount: files.length,
        });
      } catch { /* unreadable skill directory is skipped, not fatal for the list */ }
    }
    items.sort((a, b) => a.name.localeCompare(b.name));
    return { items, nextCursor: null, total: items.length, source: 'local-store' };
  }

  async function previewInstalled(resourceId, filePath = '') {
    const name = String(resourceId || '').replace(/^skill-/, '').replace(/-[0-9][0-9.]*$/, '');
    const directory = join(store, name);
    const resolvedStore = resolve(store);
    if (!resolve(directory).startsWith(resolvedStore + sep)) throw new SkillDiscoveryError('SKILL_PREVIEW_PATH_INVALID', '路径越界', { resourceId });
    if (!filePath) {
      const files = await listFiles(directory);
      return { files: files.map(file => ({ path: file.relative, size: file.size })) };
    }
    const target = resolve(directory, filePath);
    if (!target.startsWith(resolve(directory) + sep)) throw new SkillDiscoveryError('SKILL_PREVIEW_PATH_INVALID', '预览路径越界', { path: filePath });
    const info = await stat(target).catch(() => null);
    if (!info?.isFile()) throw new SkillDiscoveryError('SKILL_PREVIEW_NOT_FOUND', '文件不存在', { path: filePath });
    if (info.size > MAX_FILE_BYTES) return { path: filePath, size: info.size, truncated: true, content: '' };
    return { path: filePath, size: info.size, content: await readFile(target, 'utf8') };
  }

  return { discover, previewDiscovered, commitDiscovered, listInstalled, previewInstalled, store };
}
