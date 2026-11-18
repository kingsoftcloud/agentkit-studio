/** Local skill discovery for the Studio plugin Node host.
 *
 * The legacy Studio Host owned workspace skill scanning; the plugin Node half
 * now owns the same contract: scan directories for `SKILL.md` manifests,
 * project candidates with risk markers, preview files, and import into the
 * Studio store. Paths are only read, never executed.
 */
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, lstatSync, realpathSync, renameSync, unlinkSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { atomicPrivate, lockUntil, privateDirectory, syncDirectory } from '@kingsoftcloud/agentkit-harness-node/native/local-command-state';

const DEFAULT_SCAN_RELATIVES = ['skills', '.agents/skills', '.codex/skills', '.claude/skills'];
const MAX_DEPTH = 4;
const MAX_FILE_BYTES = 512 * 1024;
const RECORD_TTL_MS = 30 * 60 * 1000;
export const LOCAL_SKILL_INSTALLATION_FILE = '.studio-installation.json';

export class SkillDiscoveryError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SkillDiscoveryError';
    this.code = code;
    this.details = details;
  }
}

/** Python string ordering compares Unicode code points, independent of locale. */
export function compareSkillText(a, b) {
  const left = Array.from(a, value => value.codePointAt(0)), right = Array.from(b, value => value.codePointAt(0));
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return left.length - right.length;
}

export function skillSlug(value) {
  const slug = String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) throw new SkillDiscoveryError('SKILL_NAME_INVALID', 'SKILL.md 的 name 无法生成目录 slug');
  return slug.slice(0, 64);
}

export function parseFrontmatter(source, { strict = false } = {}) {
  if (strict) {
    // Python read_text normalizes universal newlines before safe_load. Keep the
    // legacy local-display recovery below, but never recover malformed imports.
    const text = String(source || '').replace(/\r\n?/g, '\n'), end = text.indexOf('\n---\n', 4);
    if (!text.startsWith('---\n') || end < 0) throw new SkillDiscoveryError('SKILL_MANIFEST_INVALID', 'Skill manifest frontmatter is invalid');
    let parsed;
    try { parsed = parseYaml(text.slice(4, end), { version: '1.1', uniqueKeys: false, maxAliasCount: 100 }); }
    catch { throw new SkillDiscoveryError('SKILL_MANIFEST_INVALID', 'Skill manifest YAML is invalid'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !parsed.name || !parsed.description)
      throw new SkillDiscoveryError('SKILL_MANIFEST_INVALID', 'Skill manifest name and description are required');
    return parsed;
  }
  const text = String(source || '');
  if (!text.startsWith('---')) return {};
  const end = text.indexOf('\n---', 3);
  if (end < 0) return {};
  try {
    const parsed = parseYaml(text.slice(3, end), { maxAliasCount: 0 });
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch { /* retain scalar recovery for malformed upstream headers */ }
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

async function directoryDigest(files, manifest) {
  const hash = createHash('sha256');
  for (const file of files.slice().sort((a, b) => compareSkillText(a.relative, b.relative))) {
    const contents = manifest && file.relative === 'SKILL.md' ? manifest : await readFile(file.absolute);
    hash.update(JSON.stringify([file.relative, contents.length]));
    hash.update(contents);
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

  async function discover(scanPaths = null, { fromInstalled = false } = {}) {
    const scans = fromInstalled ? [] : expandScanPaths(scanPaths);
    const candidates = [], sourceDirectories = new Map();
    const seen = new Set();
    async function addCandidate(directory, scan, relativePath, installedName) {
      if (seen.has(directory)) return;
      seen.add(directory);
      const candidate = await inspectCandidate(directory, scan, relativePath);
      if (installedName && candidate.status !== 'invalid' && candidate.name !== installedName) {
        candidate.status = 'invalid';
        candidate.diagnostics = ['源目录中的 Skill 已改名，请重新扫描该目录以导入新名称'];
      }
      candidates.push(candidate);
      sourceDirectories.set(candidate.candidateId, directory);
    }
    let unknownSourceCount = 0;
    if (fromInstalled) {
      for (const { name, sourceDirectory } of await localInstallations(store, { withSource: true })) {
        if (typeof sourceDirectory !== 'string' || resolve(sourceDirectory) !== sourceDirectory) { unknownSourceCount++; continue; }
        await addCandidate(sourceDirectory, { source: 'custom', displayRoot: sourceDirectory }, '.', name);
      }
    }
    for (const scan of scans) {
      let manifests;
      try { manifests = await listFiles(scan.root, scan.root, 0).then(files => files.filter(file => basename(file.absolute) === 'SKILL.md' && file.relative.split('/').length <= MAX_DEPTH + 1)); }
      catch { continue; }
      for (const manifest of manifests) {
        const directory = await realpath(dirname(manifest.absolute)).catch(() => '');
        if (!directory) continue;
        const relativePath = relativeDisplay(dirname(manifest.absolute), [scan.root]);
        await addCandidate(directory, scan, relativePath);
      }
    }
    candidates.sort((a, b) => compareSkillText(a.name || '', b.name || '') || compareSkillText(a.path, b.path));
    const token = `skd_${randomUUID().replace(/-/g, '')}`;
    records.set(token, { token, candidates, sourceDirectories, expiresAt: Date.now() + RECORD_TTL_MS });
    for (const [key, value] of records) if (value.expiresAt < Date.now()) records.delete(key);
    return { format: 'agentkit.skill-discovery/v1', inspectionToken: token, scanPaths: scans.map(scan => scan.displayRoot), candidates,
      requiresConfirmation: true, ...(fromInstalled ? { unknownSourceCount } : {}) };
  }

  async function inspectCandidate(directory, scan, relativePath) {
    const candidateId = 'skill_' + createHash('sha256').update(directory).digest('hex').slice(0, 16);
    const displayPath = relativePath === '.' ? scan.displayRoot : `${scan.displayRoot}/${relativePath}`;
    try {
      if (await realpath(directory).catch(() => '') !== directory) throw new SkillDiscoveryError('SKILL_SOURCE_CHANGED', 'Skill 源目录已移动，请重新扫描');
      const files = await listFiles(directory);
      const manifestPath = files.find(file => file.relative === 'SKILL.md')?.absolute;
      if (!manifestPath) throw new SkillDiscoveryError('SKILL_MANIFEST_INVALID', 'Skill 源目录缺少 SKILL.md');
      const manifest = await readFile(manifestPath);
      const content = manifest.toString('utf8');
      const metadata = parseFrontmatter(content);
      const name = skillSlug(metadata.name || basename(directory));
      const version = String(metadata.version || '1.0.0');
      const scripts = files.filter(file => ['.py', '.sh', '.js', '.ts', '.ps1'].some(ext => file.relative.toLowerCase().endsWith(ext)));
      const lower = content.toLowerCase();
      const networkMarkers = ['http://', 'https://', 'curl ', 'wget ', 'network'].filter(marker => lower.includes(marker));
      const destination = join(store, name);
      let conflict = false;
      try { conflict = (await stat(destination)).isDirectory(); } catch { conflict = false; }
      return {
        candidateId, path: displayPath, source: scan.source, relativePath,
        name, displayName: String(metadata.name || basename(directory)),
        description: String(metadata.description || ''), version,
        digest: await directoryDigest(files, manifest), status: conflict ? 'conflict' : 'ready',
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
    if (await realpath(directory).catch(() => '') !== directory) throw new SkillDiscoveryError('SKILL_SOURCE_CHANGED', 'Skill 源目录已移动，请重新扫描');
    if (!filePath) {
      const files = await listFiles(directory);
      return { files: files.map(file => ({ path: file.relative, size: file.size })) };
    }
    const target = resolve(directory, filePath);
    if (!target.startsWith(directory + sep)) throw new SkillDiscoveryError('SKILL_PREVIEW_PATH_INVALID', '预览路径越界', { path: filePath });
    if (await realpath(target).catch(() => '') !== target) throw new SkillDiscoveryError('SKILL_PREVIEW_NOT_FOUND', '文件不存在', { path: filePath });
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
    return mutateLocal(async (root, staging) => {
      if (directory === root || directory.startsWith(root + sep) || root.startsWith(directory + sep)) {
        throw new SkillDiscoveryError('SKILL_DISCOVERY_PATH_INVALID', '请选择资源库之外的 Skill 源目录');
      }
      if (await realpath(directory).catch(() => '') !== directory) throw new SkillDiscoveryError('SKILL_SOURCE_CHANGED', 'Skill 源目录已移动，请重新扫描');
      const destination = join(root, candidate.name);
      const existing = await lstat(destination).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (existing && (!overwrite || !existing.isDirectory())) {
        throw new SkillDiscoveryError('SKILL_ALREADY_EXISTS', '同名 Skill 已导入，确认覆盖后重试', { name: candidate.name });
      }
      const previous = existing ? await localInstallation(root, candidate.name) : null;
      const resourceId = previous?.resourceId || `skill-${candidate.name}-${candidate.version}`;
      const temporary = await mkdtemp(join(staging, 'import-'));
      const prepared = join(temporary, 'skill'), backup = join(temporary, 'previous');
      let keepBackup = false;
      try {
        for (const file of await listFiles(directory)) {
          if (await realpath(file.absolute).catch(() => '') !== file.absolute) throw new SkillDiscoveryError('SKILL_SOURCE_CHANGED', 'Skill 文件已变动，请重新扫描');
          const target = join(prepared, file.relative);
          await mkdir(dirname(target), { recursive: true, mode: 0o700 });
          await writeFile(target, await readFile(file.absolute), { mode: (await stat(file.absolute)).mode & 0o700 });
        }
        if (await directoryDigest(await listFiles(prepared)) !== candidate.digest) {
          throw new SkillDiscoveryError('SKILL_SOURCE_CHANGED', 'Skill 文件已变动，请重新扫描');
        }
        await writeFile(join(prepared, LOCAL_SKILL_INSTALLATION_FILE), JSON.stringify({ resourceId, sourceDirectory: directory }), { mode: 0o600 });
        if (existing) { renameSync(destination, backup); keepBackup = true; }
        try { renameSync(prepared, destination); }
        catch (error) {
          if (keepBackup) { renameSync(backup, destination); keepBackup = false; }
          throw error;
        }
        keepBackup = false;
        return { resourceId, name: candidate.name, displayName: candidate.displayName, description: candidate.description,
          version: candidate.version, status: 'ready', kind: 'skill', source: 'local-import' };
      } finally {
        // Preserve the previous copy if an external filesystem change prevents rollback.
        if (!keepBackup) await rm(temporary, { recursive: true, force: true });
      }
    });
  }

  async function mutateLocal(change) {
    await mkdir(store, { recursive: true, mode: 0o700 });
    const root = await realpath(store), staging = join(root, '.local-imports');
    privateDirectory(staging, true);
    const unlock = await lockUntil(join(staging, 'lock.sqlite'), performance.now() + 5000);
    try { return await change(root, staging); }
    finally { unlock(); }
  }

  async function localInstallation(root, name, { withSource = false } = {}) {
    const directory = join(root, name);
    const metadata = parseFrontmatter(await readFile(join(directory, 'SKILL.md'), 'utf8'));
    const saved = await readFile(join(directory, LOCAL_SKILL_INSTALLATION_FILE), 'utf8').then(JSON.parse).catch(() => null);
    const version = String(metadata.version || '1.0.0');
    const resourceId = typeof saved?.resourceId === 'string' && saved.resourceId.startsWith(`skill-${name}-`)
      ? saved.resourceId : `skill-${name}-${version}`;
    return { resourceId, name, displayName: String(metadata.name || name), description: String(metadata.description || ''),
      version, status: 'ready', kind: 'skill', source: 'local-import', ...(withSource ? { sourceDirectory: saved?.sourceDirectory } : {}) };
  }

  async function localInstallations(root = store, options) {
    let entries;
    try { entries = await readdir(root, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const items = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      try {
        items.push(await localInstallation(root, entry.name, options));
      } catch { /* unreadable skill directory is skipped, not fatal for the list */ }
    }
    return items;
  }

  async function listInstalled() {
    const items = await Promise.all((await localInstallations()).map(async item => ({ ...item,
      fileCount: (await listFiles(join(store, item.name))).length })));
    for (const { directory, ...item } of Object.values(await bundleRecords())) items.push(item);
    items.sort((a, b) => compareSkillText(a.name, b.name));
    return { items, nextCursor: null, total: items.length, source: 'local-store' };
  }

  async function previewInstalled(resourceId, filePath = '') {
    const directory = await resolveInstalled(resourceId);
    if (!filePath) {
      const files = await listFiles(directory);
      return { files: files.map(file => ({ path: file.relative, size: file.size })) };
    }
    const target = resolve(directory, filePath);
    if (!target.startsWith(resolve(directory) + sep)) throw new SkillDiscoveryError('SKILL_PREVIEW_PATH_INVALID', '预览路径越界', { path: filePath });
    if (target === join(resolve(directory), LOCAL_SKILL_INSTALLATION_FILE)) throw new SkillDiscoveryError('SKILL_PREVIEW_NOT_FOUND', '文件不存在', { path: filePath });
    const info = await stat(target).catch(() => null);
    if (!info?.isFile()) throw new SkillDiscoveryError('SKILL_PREVIEW_NOT_FOUND', '文件不存在', { path: filePath });
    if (info.size > MAX_FILE_BYTES) return { path: filePath, size: info.size, truncated: true, content: '' };
    return { path: filePath, size: info.size, content: await readFile(target, 'utf8') };
  }

  async function removeInstalled(resourceId) {
    return mutateLocal(async (root, staging) => {
      const installed = (await localInstallations(root)).find(item => item.resourceId === resourceId);
      if (!installed) throw new SkillDiscoveryError('SKILL_NOT_INSTALLED', '本地导入的 Skill 不存在', { resourceId });
      const removed = join(staging, `removed-${randomUUID()}`);
      renameSync(join(root, installed.name), removed);
      await rm(removed, { recursive: true, force: true });
      return { resourceId, deleted: true };
    });
  }

  async function bundleRecords() { try { return JSON.parse(await readFile(join(store, '.catalog-skills.json'), 'utf8')); } catch (error) { if (error.code === 'ENOENT') return {}; throw error; } }
  let registration = Promise.resolve();
  function registerBundleSkills(entries, { assertCurrent = () => true, overwrite = false, rejectNameConflict = false } = {}) {
    const guard = () => {
      const current = assertCurrent();
      if (current && typeof current.then === 'function') Promise.resolve(current).catch(() => {});
      if (current !== true) throw new SkillDiscoveryError('SKILL_PUBLICATION_AUTHORITY_LOST', 'Skill publication authority is no longer current');
    };
    const sealed = structuredClone(entries);
    const pending = registration.then(async () => {
      guard(); await mkdir(store, { recursive: true, mode: 0o700 }); guard();
      // Existing explicit Skill stores may be readable by other users. Keep
      // their permissions; lock and staging data have their own private root.
      const root = realpathSync(store), inode = lstatSync(store);
      const publication = join(root, '.catalog-publication'); privateDirectory(publication, true);
      const live = () => {
        guard(); const current = lstatSync(store);
        if (!current.isDirectory() || current.isSymbolicLink() || realpathSync(store) !== root
          || current.dev !== inode.dev || current.ino !== inode.ino)
          throw new SkillDiscoveryError('SKILL_PUBLICATION_ROOT_CHANGED', 'Skill store changed during publication');
        privateDirectory(publication);
      };
      live(); const unlock = await lockUntil(join(publication, 'lock.sqlite'), performance.now() + 5000);
      try {
        live(); const records = await bundleRecords(); live();
        const installed = rejectNameConflict ? (await listInstalled()).items : []; live();
        for (const item of sealed) {
          if (!/^skill-catalog-[a-f0-9]{24}$/.test(item.resourceId) || !item.directory || !item.digest) throw new SkillDiscoveryError('SKILL_BUNDLE_INVALID', '目录 Skill 声明无效');
          if (records[item.resourceId] && JSON.stringify(records[item.resourceId]) !== JSON.stringify(item)) throw new SkillDiscoveryError('SKILL_BUNDLE_CONFLICT', '目录 Skill 内容发生冲突');
          if (rejectNameConflict && !overwrite && installed.some(previous => previous.name === item.name && previous.resourceId !== item.resourceId))
            throw new SkillDiscoveryError('SKILL_ALREADY_EXISTS', '同名 Skill 已安装，请确认覆盖后重试');
          records[item.resourceId] = item;
        }
        const temporary = join(publication, `${randomUUID()}.json`);
        try {
          live(); atomicPrivate(temporary, JSON.stringify(records)); live();
          renameSync(temporary, join(store, '.catalog-skills.json')); syncDirectory(store); syncDirectory(publication);
        } finally { if (existsSync(temporary)) unlinkSync(temporary); }
        return sealed.map(({ directory, ...item }) => item);
      } finally { unlock(); }
    });
    registration = pending.catch(() => {}); return pending;
  }
  async function resolveInstalled(resourceId) {
    const bundled = (await bundleRecords())[String(resourceId)];
    if (bundled?.directory) return bundled.directory;
    const installed = (await localInstallations()).find(item => item.resourceId === resourceId);
    if (!installed) throw new SkillDiscoveryError('SKILL_NOT_INSTALLED', '本地导入的 Skill 不存在', { resourceId });
    return join(store, installed.name);
  }
  return { discover, previewDiscovered, commitDiscovered, listInstalled, previewInstalled, removeInstalled, registerBundleSkills, resolveInstalled, store };
}
