import { openSync, closeSync, fstatSync, readSync, realpathSync, statSync } from 'node:fs';
import { dirname, extname, relative, resolve, sep } from 'node:path';
import { parse } from 'parse5';
import { realpathExisting } from '@kingsoftcloud/agentkit-harness-node/native/workspace-paths';

export class NativeWebEntryBindingError extends Error {
  constructor(message) { super(message); this.code = 'studio_native_web_entry_unavailable'; }
}
const blocked = message => { throw new NativeWebEntryBindingError(`Web entry binding blocked: ${message}`); };
const inside = (root, path) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
const available = path => { try { return statSync(path).isFile(); } catch { return false; } };
const WEB_SUFFIXES = new Set(['.html', '.htm', '.js', '.jsx', '.css']);
const PAGE_SUFFIXES = new Set(['.html', '.htm']);
const identity = value => [value.dev, value.ino, value.size, value.mtimeMs, value.ctimeMs].join(':');

/** Bounded standard HTML parsing, with no script execution or network requests. */
function pageReferencesAsset(page, asset, root) {
  let fd;
  try {
    if (!inside(root, realpathSync(page))) return false;
    fd = openSync(page, 'r');
    const before = fstatSync(fd);
    if (!before.isFile()) return false;
    const bytes = Buffer.alloc(Math.min(before.size, 4 * 1024 * 1024));
    let offset = 0;
    while (offset < bytes.length) { const count = readSync(fd, bytes, offset, bytes.length - offset, offset); if (!count) break; offset += count; }
    if (identity(before) !== identity(fstatSync(fd)) || identity(before) !== identity(statSync(page))
      || !inside(root, realpathSync(page))) return false;
    const html = Array.from(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset), { stream: before.size > bytes.length }))
      .slice(0, 1024 * 1024).join('');
    let duplicateAttribute = false, hasBase = false;
    const document = parse(html, { onParseError: error => { if (error.code === 'duplicate-attribute') duplicateAttribute = true; } });
    const paths = [], pending = [document];
    while (pending.length) {
      const node = pending.pop(), tag = node.tagName?.toLowerCase();
      if (tag === 'base') hasBase = true;
      const attribute = tag === 'script' ? 'src' : tag === 'link' ? 'href' : null;
      if (attribute) { const value = node.attrs?.find(item => item.name === attribute)?.value; if (value) paths.push(value); }
      for (const child of node.childNodes ?? []) pending.push(child);
      if (node.content) pending.push(node.content);
    }
    if (hasBase || duplicateAttribute) return false;
    const base = new URL(relative(root, page).split(sep).join('/').split('/').map(encodeURIComponent).join('/'), 'http://studio.invalid/');
    for (const value of paths) {
      if (!value.split(/[?#]/, 1)[0]) continue;
      if (/^[a-z][a-z0-9+.-]*:/i.test(value.trimStart()) || value.trimStart().startsWith('//')) continue;
      const url = new URL(value, base);
      if (url.origin !== base.origin) continue;
      const target = realpathExisting(resolve(root, '.' + decodeURIComponent(url.pathname)));
      if (inside(root, target) && target === asset) return true;
    }
  } catch { /* Unavailable/ambiguous source does not establish an entry binding. */ }
  finally { if (fd !== undefined) closeSync(fd); }
  return false;
}

/** Select only from committed workspace facts and a canonical Host observation. */
export function writtenNativeWebEntry(snapshot, workspaceRoot) {
  const root = realpathSync(workspaceRoot), changed = snapshot.workspaceModifiedPaths;
  if (!Array.isArray(changed) || Array.from(changed).some(path => typeof path !== 'string')) blocked('invalid committed workspace paths.');
  const written = [...new Set(changed.filter(path => WEB_SUFFIXES.has(extname(path))))];
  if (!written.length) return null;
  let observed = null;
  if (typeof snapshot.lastBrowserObservation?.entryPath === 'string') {
    const candidate = realpathExisting(resolve(root, snapshot.lastBrowserObservation.entryPath));
    if (inside(root, candidate) && PAGE_SUFFIXES.has(extname(candidate)) && available(candidate)) observed = candidate;
  }
  const candidates = new Set();
  for (const path of written) {
    const target = realpathExisting(resolve(root, path));
    if (!inside(root, target)) blocked('changed files leave the workspace.');
    if (PAGE_SUFFIXES.has(extname(target))) {
      if (!available(target)) blocked('the changed page is unavailable.');
      candidates.add(target); continue;
    }
    let directory = dirname(target), found = false;
    while (inside(root, directory)) {
      const localProject = directory !== root || dirname(target) === root;
      if (observed && dirname(observed) === directory && (localProject || pageReferencesAsset(observed, target, root))) {
        candidates.add(observed); found = true; break;
      }
      const entry = realpathExisting(resolve(directory, 'index.html'));
      if (inside(root, entry) && available(entry) && (localProject || pageReferencesAsset(entry, target, root))) {
        candidates.add(entry); found = true; break;
      }
      if (directory === root) break;
      directory = dirname(directory);
    }
    if (!found) blocked('no page is bound to the changed web files. Inspect the intended project entry before verifying.');
  }
  if (candidates.size !== 1) blocked('changed files belong to multiple pages; the Host must bind the intended delivery entry.');
  return relative(root, [...candidates][0]).split(sep).join('/');
}
