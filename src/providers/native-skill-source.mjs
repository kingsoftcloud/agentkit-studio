/**
 * Formal Native Skill source: admitted file sources for the production Native
 * skills. Sources are explicitly passed definitions or an explicitly configured
 * Host local-Skill directory; workspace content never selects the directory.
 *
 * API: createStudioNativeSkillSource({definitions, expectedBinding}) → {source, binding}
 * source: async manifest(skillId), fullText(skillId), resource(skillId, ref), refs
 * binding: {contract, skills:[{skillId, manifestDigest, contentDigest, resourceDigests}]}
 */
import { createHash } from 'node:crypto';
import {
  closeSync, constants, existsSync, fstatSync, lstatSync, openSync, opendirSync,
  readSync, realpathSync,
} from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { canonical } from '@kingsoftcloud/agentkit-harness-core';
import { runtimeSkill } from '../skill-files.mjs';

export const SKILL_SOURCE_CONTRACT = 'agentkit.studio-native-skill-source/v1';

const MAX_ENTRIES = 2048;
const MAX_DEPTH = 64;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_RESOURCE_BYTES = 32768;
const MAX_SUMMARY_CHARS = 512;

class SkillSourceError extends Error {
  constructor(code, message) { super(message); this.name = 'SkillSourceError'; this.code = code; }
}

function fsError(code, msg) { return new SkillSourceError(code, msg); }
function safeLstat(path, code = 'skill_source_unavailable') {
  try { return lstatSync(path, { bigint: true }); }
  catch (e) { if (e instanceof SkillSourceError) throw e; throw fsError(code, 'Stat failed'); }
}
function safeExists(path) { try { return existsSync(path); } catch { return false; } }
function safeRealpath(path, code = 'skill_source_unavailable') {
  try { return realpathSync(path); }
  catch (e) { if (e instanceof SkillSourceError) throw e; throw fsError(code, 'Resolve failed'); }
}

// ---- alias ----

function sanitizeName(name) {
  const s = String(name || '').replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[-._]+|[-._]+$/g, '');
  return s || 'provider-skill';
}
function skillAlias(name) { return `skill://${sanitizeName(name)}@1.0.0`; }

// ---- frontmatter ----

function parseFrontmatter(source) {
  const text = String(source || '');
  if (!text.startsWith('---')) return {};
  const end = text.indexOf('\n---', 3);
  if (end < 0) return {};
  try {
    const p = parseYaml(text.slice(3, end), { maxAliasCount: 0 });
    if (p && typeof p === 'object' && !Array.isArray(p)) return p;
  } catch {}
  const m = {};
  for (const line of text.slice(3, end).split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line.trim());
    if (match) m[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
  }
  return m;
}

function deriveSummary(content, metadata) {
  const desc = String(metadata?.description || '').trim();
  if (desc) return desc.slice(0, MAX_SUMMARY_CHARS);
  const body = String(content || '');
  const lines = body.startsWith('---') ? body.slice(body.indexOf('\n---', 3) + 4).split(/\r?\n/) : body.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.replace(/^#+\s*/, '').replace(/^-+$/, '').trim();
    if (trimmed && !trimmed.startsWith('---')) return trimmed.slice(0, MAX_SUMMARY_CHARS);
  }
  return '';
}

// ---- root identity (pin dev+ino) ----

function validateRoot(declaredPath) {
  const resolved = resolve(declaredPath);
  if (resolved === sep) throw new SkillSourceError('skill_source_root_invalid', 'Root cannot be /');
  const parts = resolved.split(sep);
  for (let i = 1; i <= parts.length; i++) {
    const ancestor = parts.slice(0, i).join(sep) || sep;
    const st = safeLstat(ancestor, 'skill_source_root_missing');
    if (st.isSymbolicLink()) throw new SkillSourceError('skill_source_root_symlink', 'Ancestor is a symlink');
  }
  const rootStat = safeLstat(resolved);
  if (rootStat.isSymbolicLink()) throw new SkillSourceError('skill_source_root_symlink', 'Root is a symlink');
  if (!rootStat.isDirectory()) throw new SkillSourceError('skill_source_root_invalid', 'Root is not a directory');
  const real = safeRealpath(resolved);
  return { real, declared: resolved, dev: rootStat.dev, ino: rootStat.ino };
}

function recheckRoot(pinned) {
  const declared = pinned.declared;
  const parts = declared.split(sep);
  for (let i = 1; i <= parts.length; i++) {
    const ancestor = parts.slice(0, i).join(sep) || sep;
    const st = safeLstat(ancestor, 'skill_source_root_changed');
    if (st.isSymbolicLink()) throw new SkillSourceError('skill_source_root_changed', 'Ancestor became symlink');
  }
  const rootStat = safeLstat(declared, 'skill_source_root_changed');
  if (rootStat.isSymbolicLink()) throw new SkillSourceError('skill_source_root_changed', 'Root became symlink');
  if (!rootStat.isDirectory()) throw new SkillSourceError('skill_source_root_changed', 'Root is not a directory');
  if (rootStat.dev !== pinned.dev || rootStat.ino !== pinned.ino)
    throw new SkillSourceError('skill_source_root_changed', 'Root directory object changed');
  const live = safeRealpath(declared);
  if (live !== pinned.real) throw new SkillSourceError('skill_source_root_changed', 'Canonical path changed');
}

// ---- directory digest (bounded opendirSync iteration) ----

function directoryDigests(root) {
  const h = createHash('sha256');
  // Use a null-prototype object so __proto__ filenames are real keys, not
  // prototype setters. This is the fix for the __proto__ probe.
  const resources = Object.create(null);
  scanDir(root, '', h, resources, { entryCount: 0, totalBytes: 0, depth: 0 });
  return { directoryDigest: 'sha256:' + h.digest('hex'), resourceDigests: resources };
}

function scanDir(root, rel, h, resources, state) {
  const dir = rel ? join(root, rel) : root;
  const dirStat = safeLstat(dir);
  if (dirStat.isSymbolicLink()) throw new SkillSourceError('skill_source_symlink', 'Symlink in scan');
  if (!dirStat.isDirectory()) throw new SkillSourceError('skill_source_unavailable', 'Not a directory');
  // Bounded iteration: opendirSync + readSync, stop at MAX_ENTRIES, close in finally.
  let dirHandle;
  try { dirHandle = opendirSync(dir); }
  catch (e) { if (e instanceof SkillSourceError) throw e; throw fsError('skill_source_unavailable', 'opendir failed'); }
  // Collect entries in batches, stop at limit.
  const batch = [];
  try {
    let entry;
    while ((entry = dirHandle.readSync()) !== null) {
      state.entryCount++;
      if (state.entryCount > MAX_ENTRIES) throw new SkillSourceError('skill_source_too_many_entries', 'Entry limit exceeded');
      batch.push(entry);
    }
  } catch (e) {
    if (e instanceof SkillSourceError) throw e;
    throw fsError('skill_source_unavailable', 'readdir failed');
  } finally { try { dirHandle.closeSync(); } catch {} }
  // Sort by name for deterministic order.
  batch.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  for (const entry of batch) {
    const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entryRel.includes('\\') || entryRel.includes('\0')) throw new SkillSourceError('skill_source_path_invalid', 'Invalid path');
    const abs = join(root, entryRel);
    const info = safeLstat(abs);
    if (info.isSymbolicLink()) throw new SkillSourceError('skill_source_symlink', 'Symlink in directory');
    if (info.isDirectory()) {
      const relBytes = Buffer.from(entryRel, 'utf-8');
      const lenBuf = Buffer.allocUnsafe(4);
      lenBuf.writeUInt32BE(relBytes.length, 0);
      h.update(lenBuf); h.update(relBytes);
      h.update(Buffer.from('dir\0', 'utf-8'));
      const modeBuf = Buffer.allocUnsafe(2);
      modeBuf.writeUInt16BE(Number(info.mode) & 0o777);
      h.update(modeBuf);
      state.depth++;
      if (state.depth > MAX_DEPTH) throw new SkillSourceError('skill_source_too_deep', 'Nesting limit exceeded');
      scanDir(root, entryRel, h, resources, state);
      state.depth--;
    } else if (info.isFile()) {
      const content = readFileBounded(abs, Number(info.size), MAX_TOTAL_BYTES - state.totalBytes, info);
      state.totalBytes += content.length;
      if (state.totalBytes > MAX_TOTAL_BYTES) throw new SkillSourceError('skill_source_too_large', 'Size limit exceeded');
      const relBytes = Buffer.from(entryRel, 'utf-8');
      const lenBuf = Buffer.allocUnsafe(4);
      lenBuf.writeUInt32BE(relBytes.length, 0);
      h.update(lenBuf); h.update(relBytes);
      const contentLenBuf = Buffer.allocUnsafe(8);
      contentLenBuf.writeBigUInt64BE(BigInt(content.length), 0);
      h.update(contentLenBuf); h.update(content);
      h.update(Buffer.from([Number(info.mode) & 0o111]));
      // Use Object.defineProperty on the null-prototype resources so __proto__
      // and other dangerous keys are stored as own properties, not prototype
      // setters.
      Object.defineProperty(resources, entryRel, { value: 'sha256:' + createHash('sha256').update(content).digest('hex'), writable: true, enumerable: true, configurable: true });
    } else {
      throw new SkillSourceError('skill_source_special', 'Special file');
    }
  }
}

function readFileBounded(abs, size, maxRemaining, pathStat) {
  if (pathStat && !pathStat.isFile()) throw new SkillSourceError('skill_source_special', 'Not a regular file');
  if (size > maxRemaining) throw new SkillSourceError('skill_source_too_large', 'Size limit exceeded');
  let fd;
  try { fd = openSync(abs, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (e) { if (e instanceof SkillSourceError) throw e; throw fsError('skill_source_unavailable', 'Open failed'); }
  try {
    const st = fstatSync(fd, { bigint: true });
    if (!st.isFile()) throw new SkillSourceError('skill_source_special', 'Not a regular file');
    if (pathStat && (st.dev !== pathStat.dev || st.ino !== pathStat.ino
      || Number(st.size) !== Number(pathStat.size) || st.mode !== pathStat.mode
      || st.mtimeNs !== pathStat.mtimeNs || st.ctimeNs !== pathStat.ctimeNs))
      throw new SkillSourceError('skill_source_changed', 'File identity changed before read');
    if (Number(st.size) !== size) throw new SkillSourceError('skill_source_changed', 'Size changed');
    const buf = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const n = readSync(fd, buf, offset, size - offset, null);
      if (n === 0) throw new SkillSourceError('skill_source_changed', 'Short read');
      offset += n;
    }
    const after = fstatSync(fd, { bigint: true });
    if (after.ino !== st.ino || after.dev !== st.dev || Number(after.size) !== Number(st.size)
      || after.mtimeNs !== st.mtimeNs || after.ctimeNs !== st.ctimeNs || after.mode !== st.mode)
      throw new SkillSourceError('skill_source_changed', 'File identity changed during read');
    return buf;
  } catch (e) {
    if (e instanceof SkillSourceError) throw e;
    throw fsError('skill_source_unavailable', 'Read failed');
  } finally { try { closeSync(fd); } catch {} }
}

function stableDirectoryDigests(root) {
  const first = directoryDigests(root);
  const second = directoryDigests(root);
  if (first.directoryDigest !== second.directoryDigest) throw new SkillSourceError('skill_source_changed', 'Directory changed during capture');
  return first;
}

// ---- ref validation ----

function validateRelativeRef(ref) {
  if (typeof ref !== 'string' || !ref) throw new SkillSourceError('skill_source_ref_invalid', 'Ref must be non-empty');
  if (ref.includes('\0')) throw new SkillSourceError('skill_source_ref_invalid', 'NUL in ref');
  if (ref.includes('\\')) throw new SkillSourceError('skill_source_ref_invalid', 'Backslash in ref');
  if (ref.startsWith('/')) throw new SkillSourceError('skill_source_ref_invalid', 'Absolute ref');
  const parts = ref.split('/');
  if (parts.some(p => !p || p === '.' || p === '..')) throw new SkillSourceError('skill_source_ref_invalid', 'Non-canonical ref');
}

// ---- manifest digest = SHA256 of the raw content UTF-8 bytes ----

function manifestDigest(content) {
  return 'sha256:' + createHash('sha256').update(Buffer.from(content, 'utf-8')).digest('hex');
}

// ---- skill entry ----

function buildSkillEntry(definition) {
  if (!definition || typeof definition !== 'object') throw new SkillSourceError('skill_source_definition_invalid', 'Definition must be an object');
  const name = definition.name;
  if (typeof name !== 'string' || !name.trim()) throw new SkillSourceError('skill_source_name_missing', 'Name required');
  const content = definition.content;
  if (typeof content !== 'string') throw new SkillSourceError('skill_source_content_missing', 'Content required');
  const alias = skillAlias(name);
  const metadata = parseFrontmatter(content);
  const summary = deriveSummary(content, metadata);

  const resourceBase = definition.resourceBase;
  let pinned = null, resourceDigests = Object.create(null), contentDigest = '';
  let manifestPath = null, manifestContent = content;
  if (resourceBase) {
    if (resourceBase.kind !== 'directory') throw new SkillSourceError('skill_source_resource_base_invalid', 'kind must be directory');
    if (typeof resourceBase.path !== 'string' || !resourceBase.path.trim()) throw new SkillSourceError('skill_source_resource_base_invalid', 'path required');
    pinned = validateRoot(resourceBase.path);
    const digests = stableDirectoryDigests(pinned.real);
    contentDigest = digests.directoryDigest;
    resourceDigests = digests.resourceDigests;
    manifestPath = definition.path || findManifest(pinned.real);
    if (!manifestPath) throw new SkillSourceError('skill_source_manifest_missing', 'No SKILL.md found');
    const manifestAbs = resolve(manifestPath);
    const manifestReal = safeRealpath(manifestAbs);
    if (!manifestReal.startsWith(pinned.real + sep) && manifestReal !== pinned.real)
      throw new SkillSourceError('skill_source_manifest_outside_root', 'Manifest outside root');
    const pathStat = safeLstat(manifestAbs);
    if (pathStat.isSymbolicLink()) throw new SkillSourceError('skill_source_manifest_symlink', 'Manifest is symlink');
    const fileContent = readFileBounded(manifestAbs, Number(pathStat.size), MAX_TOTAL_BYTES, pathStat);
    if (fileContent.toString('utf-8') !== content) throw new SkillSourceError('skill_source_manifest_mismatch', 'Manifest bytes differ');
    manifestContent = fileContent.toString('utf-8');
  } else {
    contentDigest = 'sha256:' + createHash('sha256').update(Buffer.from(content, 'utf-8')).digest('hex');
  }

  const mDigest = manifestDigest(manifestContent);
  return {
    skillId: alias, name, content: manifestContent, summary, metadata,
    pinned, resourceBase: resourceBase || null,
    manifestDigest: mDigest, contentDigest, resourceDigests,
    manifestPath: manifestPath ? resolve(manifestPath) : null,
  };
}

function findManifest(root) {
  const c = join(root, 'SKILL.md');
  return safeExists(c) ? c : null;
}

// ---- source ----

function createSource(entries) {
  const sorted = [...entries].sort((a, b) => a.skillId < b.skillId ? -1 : a.skillId > b.skillId ? 1 : 0);
  const byId = new Map(sorted.map(e => [e.skillId, e]));
  const refs = Object.freeze(sorted.map(e => e.skillId));

  function checkEntry(skillId) {
    const entry = byId.get(skillId);
    if (!entry) throw new SkillSourceError('skill_source_unbound', 'Skill not bound');
    if (entry.pinned) {
      recheckRoot(entry.pinned);
      const digests = stableDirectoryDigests(entry.pinned.real);
      if (digests.directoryDigest !== entry.contentDigest) throw new SkillSourceError('skill_source_content_changed', 'Content changed');
      if (entry.manifestPath) {
        const manifestAbs = entry.manifestPath;
        if (!safeExists(manifestAbs)) throw new SkillSourceError('skill_source_manifest_changed', 'Manifest missing');
        const pathStat = safeLstat(manifestAbs);
        if (pathStat.isSymbolicLink()) throw new SkillSourceError('skill_source_manifest_changed', 'Manifest is symlink');
        const fileContent = readFileBounded(manifestAbs, Number(pathStat.size), MAX_TOTAL_BYTES, pathStat);
        if (fileContent.toString('utf-8') !== entry.content) throw new SkillSourceError('skill_source_manifest_changed', 'Manifest bytes changed');
      }
    }
    return entry;
  }

  // Get keys from a null-prototype object safely.
  function resourceKeys(obj) { return Object.keys(obj).sort(); }

  return {
    refs,
    async manifest(skillId) {
      const entry = checkEntry(skillId);
      const result = { name: entry.name, summary: entry.summary, resourceRefs: entry.pinned ? resourceKeys(entry.resourceDigests) : [] };
      checkEntry(skillId);
      return result;
    },
    async fullText(skillId) {
      const entry = checkEntry(skillId);
      checkEntry(skillId);
      return entry.content;
    },
    async resource(skillId, ref) {
      const entry = checkEntry(skillId);
      if (!entry.pinned) throw new SkillSourceError('skill_source_no_resources', 'No resource directory');
      validateRelativeRef(ref);
      // Use Object.hasOwn or direct lookup on null-prototype object.
      const expectedHash = Object.hasOwn(entry.resourceDigests, ref) ? entry.resourceDigests[ref] : undefined;
      if (!expectedHash) throw new SkillSourceError('skill_source_ref_unbound', 'Ref not in digests');
      const abs = join(entry.pinned.real, ref);
      const parts = ref.split('/');
      for (let i = 1; i <= parts.length; i++) {
        const ancestor = join(entry.pinned.real, ...parts.slice(0, i));
        if (safeExists(ancestor)) {
          const st = safeLstat(ancestor);
          if (st.isSymbolicLink()) throw new SkillSourceError('skill_source_path_changed', 'Symlink in path');
        }
      }
      recheckRoot(entry.pinned);
      const digests = stableDirectoryDigests(entry.pinned.real);
      if (digests.directoryDigest !== entry.contentDigest) throw new SkillSourceError('skill_source_content_changed', 'Content changed');
      const info = safeLstat(abs, 'skill_source_resource_missing');
      if (info.isSymbolicLink() || !info.isFile()) throw new SkillSourceError('skill_source_resource_invalid', 'Not a regular file');
      if (Number(info.size) > MAX_RESOURCE_BYTES) throw new SkillSourceError('skill_source_resource_too_large', 'Resource too large');
      let fd;
      try { fd = openSync(abs, constants.O_RDONLY | constants.O_NOFOLLOW); }
      catch (e) { if (e instanceof SkillSourceError) throw e; throw fsError('skill_source_resource_missing', 'Open failed'); }
      let content;
      try {
        const st = fstatSync(fd, { bigint: true });
        if (!st.isFile()) throw new SkillSourceError('skill_source_resource_invalid', 'Not a regular file');
        if (st.dev !== info.dev || st.ino !== info.ino || Number(st.size) !== Number(info.size)
          || st.mode !== info.mode || st.mtimeNs !== info.mtimeNs || st.ctimeNs !== info.ctimeNs)
          throw new SkillSourceError('skill_source_resource_changed', 'File identity changed before read');
        content = Buffer.alloc(Number(info.size));
        let offset = 0;
        while (offset < Number(info.size)) {
          const n = readSync(fd, content, offset, Number(info.size) - offset, null);
          if (n === 0) throw new SkillSourceError('skill_source_resource_changed', 'Short read');
          offset += n;
        }
        const after = fstatSync(fd, { bigint: true });
        if (after.ino !== st.ino || after.dev !== st.dev || Number(after.size) !== Number(st.size)
          || after.mtimeNs !== st.mtimeNs || after.ctimeNs !== st.ctimeNs || after.mode !== st.mode)
          throw new SkillSourceError('skill_source_resource_changed', 'File identity changed during read');
      } catch (e) {
        if (e instanceof SkillSourceError) throw e;
        throw fsError('skill_source_resource_changed', 'Read failed');
      } finally { try { closeSync(fd); } catch {} }
      if (content.length > MAX_RESOURCE_BYTES) throw new SkillSourceError('skill_source_resource_too_large', 'Resource too large');
      const actualHash = 'sha256:' + createHash('sha256').update(content).digest('hex');
      if (actualHash !== expectedHash) throw new SkillSourceError('skill_source_resource_changed', 'Resource bytes changed');
      checkEntry(skillId);
      return content;
    },
  };
}

// ---- binding ----

function buildBinding(entries) {
  const sorted = [...entries].sort((a, b) => a.skillId < b.skillId ? -1 : a.skillId > b.skillId ? 1 : 0);
  return {
    contract: SKILL_SOURCE_CONTRACT,
    skills: sorted.map(e => ({
      skillId: e.skillId,
      manifestDigest: e.manifestDigest,
      contentDigest: e.contentDigest,
      resourceDigests: sortDigests(e.resourceDigests),
    })),
  };
}

// sortDigests on a null-prototype object: use Object.keys, build a new
// null-prototype sorted object so __proto__ keys survive JSON canonical.
function sortDigests(d) {
  const s = Object.create(null);
  for (const k of Object.keys(d).sort()) Object.defineProperty(s, k, { value: d[k], writable: true, enumerable: true, configurable: true });
  return s;
}
function bindingEquals(a, b) { return canonical(a) === canonical(b); }

// ---- main export ----

/** Python runtime/loader.py's KSADK_LOCAL_SKILLS_DIR: immediate child
 * directories containing an exact SKILL.md, in Python's Unicode path order.
 * The Host opts in; this never searches the workspace or executes scripts.
 * Existing source identity/digest checks also cover discovered packages. */
export function loadConfiguredNativeSkills({ directory, definitions = [] } = {}) {
  if (directory === undefined || directory === '') return structuredClone(definitions);
  if (typeof directory !== 'string' || !directory.trim())
    throw fsError('skill_source_directory_invalid', 'Local Skill directory must be a path');
  const declared = resolve(directory.trim());
  try { lstatSync(declared); }
  catch (error) { if (error.code === 'ENOENT') return structuredClone(definitions); throw error; }
  const pinned = validateRoot(declared), children = [], discovered = [];
  const handle = opendirSync(pinned.real);
  try {
    for (let entry, count = 0; (entry = handle.readSync()) !== null;) {
      if (++count > MAX_ENTRIES) throw fsError('skill_source_too_many_entries', 'Entry limit exceeded');
      if (entry.isSymbolicLink()) throw fsError('skill_source_symlink', 'Symlink in local Skill directory');
      if (entry.isDirectory()) children.push(entry.name);
    }
  } finally { handle.closeSync(); }
  children.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  for (const name of children) {
    recheckRoot(pinned);
    const root = join(pinned.real, name), path = join(root, 'SKILL.md');
    validateRoot(root);
    let info;
    try { info = lstatSync(path, { bigint: true }); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (info.isSymbolicLink()) throw fsError('skill_source_manifest_symlink', 'Manifest is symlink');
    const bytes = readFileBounded(path, Number(info.size), 512 * 1024, info);
    let content;
    try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { throw fsError('skill_source_manifest_encoding', 'Manifest must be UTF-8'); }
    discovered.push(runtimeSkill({ name, content, path }));
    if (discovered.length > 100) throw fsError('skill_source_too_many_skills', 'Local Skill limit exceeded');
  }
  const combined = structuredClone(definitions);
  for (const definition of discovered) {
    const existing = combined.find(item => item.name === definition.name);
    if (existing) {
      if (existing.path !== definition.path || existing.content !== definition.content)
        throw fsError('skill_source_alias_conflict', 'Configured and bound Skills conflict');
    } else combined.push(definition);
  }
  createStudioNativeSkillSource({ definitions: combined });
  recheckRoot(pinned);
  return combined;
}

export function createStudioNativeSkillSource({ definitions, expectedBinding } = {}) {
  if (!Array.isArray(definitions)) throw new SkillSourceError('skill_source_definitions_invalid', 'definitions must be an array');
  const activeDefs = definitions.filter(def => def?.invocation?.modelInvocable !== false);
  const entries = [];
  const seen = new Set();
  for (const def of activeDefs) {
    const entry = buildSkillEntry(def);
    if (seen.has(entry.skillId)) throw new SkillSourceError('skill_source_alias_conflict', 'Duplicate alias');
    seen.add(entry.skillId);
    entries.push(entry);
  }
  const binding = buildBinding(entries);
  if (expectedBinding !== undefined) {
    const exp = typeof expectedBinding === 'object' && expectedBinding ? expectedBinding : null;
    if (!exp || !bindingEquals(exp, binding)) throw new SkillSourceError('skill_source_binding_mismatch', 'expectedBinding mismatch');
  }
  return { source: createSource(entries), binding };
}
