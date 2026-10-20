/** Run-owned loopback files for browser_inspect_workspace. No shell or Python. */
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const within = (root, path) => path === root || path.startsWith(root + sep);
const fail = code => { const error = new Error(code); error.code = code; throw error; };
const stamp = info => `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}`;
const ignored = new Set(['.artifacts', '.git', 'node_modules', '__pycache__']);
const types = { '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.wasm': 'application/wasm', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.mp4': 'video/mp4', '.webm': 'video/webm' };

function safeRelative(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0')
    || isAbsolute(value) || value.split('/').includes('..')) fail('workspace_path_invalid');
  return value;
}

function bound(root, path) {
  const target = realpathSync(path);
  if (!within(root, target)) fail('workspace_path_outside_scope');
  return target;
}

/** Snapshot regular-file identity and bounded bytes. Path identity is rechecked around open.
 * The Host still owns the workspace root; arbitrary concurrent ancestor replacement is
 * not a filesystem sandbox. No directories, devices, or outside symlink targets are served. */
function readBoundFile(root, path, maxBytes) {
  const target = bound(root, path), before = statSync(target, { bigint: true });
  if (!before.isFile()) fail('browser_file_not_found');
  if (before.size > BigInt(maxBytes)) fail('browser_file_too_large');
  const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino
      || bound(root, path) !== target) fail('browser_file_changed');
    const parts = []; let length = 0;
    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(65536, maxBytes - length + 1));
      const count = readSync(fd, chunk);
      if (!count) break;
      length += count;
      if (length > maxBytes) fail('browser_file_too_large');
      parts.push(chunk.subarray(0, count));
    }
    const after = statSync(target, { bigint: true });
    if (stamp(after) !== stamp(opened) || bound(root, path) !== target) fail('browser_file_changed');
    return { bytes: Buffer.concat(parts, length), target };
  } finally { closeSync(fd); }
}

export function resolveBrowserWorkspaceEntry(root, path) {
  if (typeof root !== 'string' || !isAbsolute(root)) fail('workspace_root_invalid');
  const workspace = realpathSync(root);
  let entry = bound(workspace, resolve(workspace, safeRelative(path)));
  if (statSync(entry).isDirectory()) entry = bound(workspace, join(entry, 'index.html'));
  if (!statSync(entry).isFile() || !['.html', '.htm'].includes(extname(entry).toLowerCase())) fail('browser_entry_not_found');
  return { workspace, entry, servedRoot: dirname(entry) };
}

export async function createBrowserWorkspaceServer({ root, path, maxFileBytes = 32 * 1024 * 1024,
  maxFiles = 4096, signal } = {}) {
  signal?.throwIfAborted();
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1 || maxFileBytes > 2 ** 30
    || !Number.isSafeInteger(maxFiles) || maxFiles < 1 || maxFiles > 65536) fail('browser_server_limits_invalid');
  const { workspace, entry, servedRoot } = resolveBrowserWorkspaceEntry(root, path);
  const prefix = `/${randomBytes(24).toString('hex')}/`, generated = new Map();
  let origin, closed = false, closing;

  function revision() {
    if (closed) fail('browser_server_closed');
    const digest = createHash('sha256').update('agentkit.browser-served-files/v1\0');
    let count = 0;
    const walk = directory => {
      if (bound(servedRoot, directory) !== directory) fail('browser_served_revision_unavailable');
      for (const name of readdirSync(directory).sort()) {
        const filename = join(directory, name), info = lstatSync(filename, { bigint: true });
        if (info.isSymbolicLink()) continue;
        if (info.isDirectory()) { if (!ignored.has(name)) walk(filename); continue; }
        if (!info.isFile() || generated.get(filename) === stamp(info)) continue;
        if (++count > maxFiles) fail('browser_served_file_limit_exceeded');
        digest.update(`${relative(servedRoot, filename).split(sep).join('/')}\0${stamp(info)}\0`);
      }
    };
    walk(servedRoot); return digest.digest('hex');
  }

  const initialRevision = revision();
  const server = createServer((request, response) => {
    const reply = (status, text) => { response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); response.end(text); };
    try {
      if (closed) return reply(503, 'Browser owner closed');
      if (!['GET', 'HEAD'].includes(request.method)) return reply(405, 'Read-only browser files');
      if (request.headers.host !== origin.slice('http://'.length)) return reply(403, 'Invalid host');
      const raw = request.url;
      if (!raw?.startsWith(prefix)) return reply(403, 'Outside browser page');
      const rawPath = raw.split('?')[0], pathname = decodeURIComponent(rawPath.slice(prefix.length));
      const lexical = resolve(servedRoot, pathname ? safeRelative(pathname) : '.');
      if (!within(servedRoot, lexical)) return reply(403, 'Outside browser page');
      let target = bound(servedRoot, lexical);
      if (statSync(target).isDirectory()) {
        const index = ['index.html', 'index.htm'].map(name => join(target, name))
          .find(candidate => { try { return statSync(candidate).isFile(); } catch { return false; } });
        if (!index) return reply(403, 'Directory listing unavailable');
        target = bound(servedRoot, index);
        if (!rawPath.endsWith('/')) {
          response.writeHead(301, { location: `${rawPath}/${raw.slice(rawPath.length)}`, 'cache-control': 'no-store' });
          response.end(); return;
        }
      }
      const { bytes, target: actual } = readBoundFile(servedRoot, target, maxFileBytes);
      response.writeHead(200, { 'content-type': types[extname(actual).toLowerCase()] ?? 'application/octet-stream',
        'content-length': bytes.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      response.end(request.method === 'HEAD' ? undefined : bytes);
    } catch (error) {
      const status = error.code === 'browser_file_too_large' ? 413
        : error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 404
        : error.code === 'browser_file_changed' ? 409 : 403;
      reply(status, status === 404 ? 'File unavailable' : 'Browser file request rejected');
    }
  });
  server.requestTimeout = 10000; server.headersTimeout = 10000;
  server.maxRequestsPerSocket = 100;
  server.maxConnections = 16;
  try {
    await new Promise((resolve, reject) => {
      const error = value => { server.off('listening', ready); reject(value); };
      const ready = () => { server.off('error', error); resolve(); };
      server.once('error', error); server.once('listening', ready); server.listen(0, '127.0.0.1');
    });
    origin = `http://127.0.0.1:${server.address().port}`;
    signal?.throwIfAborted();
  } catch (error) { server.close(); server.closeAllConnections(); throw error; }

  const close = () => {
    if (closing) return closing;
    closed = true;
    signal?.removeEventListener('abort', abort);
    closing = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    server.closeAllConnections();
    return closing;
  };
  const abort = () => { void close().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  return { workspace, servedRoot, entry, origin, url: `${origin}${prefix}${encodeURIComponent(basename(entry))}`, initialRevision,
    revision, close,
    allows(value) {
      if (closed || typeof value !== 'string') return false;
      try { const url = new URL(value); return url.origin === origin && !url.username && !url.password && url.pathname.startsWith(prefix); }
      catch { return false; }
    },
    markGenerated(filename) {
      const target = bound(workspace, filename);
      const info = statSync(target, { bigint: true });
      if (!info.isFile()) fail('browser_generated_file_invalid');
      generated.set(target, stamp(info));
    },
  };
}
