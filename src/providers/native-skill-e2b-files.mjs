/** Guarded E2B JS SDK file port. The Host owns sandbox creation/lifetime.
 * SDK metadata is observed before/after transfers; this cannot promise atomic
 * no-follow operations inside a remote OS against concurrent same-user writers.
 * No discovery, command execution, fallback target or unbounded byte reads. */
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { canonical, copy, invariant } from '../../packages/agentkit-harness-core/dist/index.mjs';

export const NATIVE_SKILL_E2B_FILES = 'agentkit.native-skill-e2b-files/v1';

const FILE_LIMIT = 20 * 1024 ** 2, TOTAL_LIMIT = 50 * 1024 ** 2, ENTRY_LIMIT = 4000;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const body = request => canonical(Object.fromEntries(Object.keys(request).filter(key => !['signal', 'assertCurrent'].includes(key))
  .map(key => [key, copy(request[key])])));
const observe = promise => { void Promise.resolve(promise).catch(() => {}); };
const discardStream = value => { try { if (typeof value?.cancel === 'function') observe(value.cancel()); } catch {} };

export function createNativeSkillE2BFiles({ sandbox, remoteRoot, maxFileBytes = FILE_LIMIT } = {}) {
  invariant(sandbox && typeof sandbox.sandboxId === 'string' && sandbox.sandboxId, 'SKILL_E2B_SANDBOX_REQUIRED');
  invariant(Number.isSafeInteger(maxFileBytes) && maxFileBytes >= 0 && maxFileBytes <= FILE_LIMIT, 'SKILL_E2B_FILE_LIMIT');
  const sandboxId = sandbox.sandboxId, files = sandbox.files;
  invariant(files && ['read', 'write', 'list', 'getInfo'].every(name => typeof files[name] === 'function'), 'SKILL_E2B_FILES_REQUIRED');
  const methods = Object.fromEntries(['read', 'write', 'list', 'getInfo'].map(name => [name, files[name]]));
  function path(value) {
    invariant(typeof value === 'string' && value.startsWith('/') && value.length <= 4096 && value !== '/'
      && !value.includes('\\') && !value.includes('\0') && !value.split('/').some(part => ['.', '..'].includes(part))
      && !value.endsWith('/') && posix.normalize(value) === value, 'SKILL_E2B_PATH_INVALID');
    invariant(value === remoteRoot || value.startsWith(remoteRoot + '/'), 'SKILL_E2B_PATH_OUTSIDE_ROOT'); return value;
  }
  path(remoteRoot);
  function context(request) {
    invariant(request && typeof request === 'object', 'SKILL_E2B_REQUEST_REQUIRED');
    const signal = request.signal, authority = request.assertCurrent;
    invariant(signal instanceof AbortSignal && typeof authority === 'function', 'SKILL_E2B_AUTHORITY_REQUIRED');
    const original = body(request);
    const unchanged = () => {
      invariant(request.signal === signal && request.assertCurrent === authority && body(request) === original, 'SKILL_E2B_REQUEST_CHANGED');
      invariant(sandbox.sandboxId === sandboxId && sandbox.files === files && Object.entries(methods).every(([key, value]) => files[key] === value),
        'SKILL_E2B_SANDBOX_CHANGED');
    };
    function guard() {
      signal.throwIfAborted(); unchanged(); const verdict = authority();
      if (verdict && typeof verdict.then === 'function') observe(verdict);
      invariant(verdict === true, 'SKILL_E2B_AUTHORITY_LOST'); unchanged(); signal.throwIfAborted(); return true;
    }
    async function step(effect, discard = () => {}) {
      guard(); let abort, abandoned = false, value, arrived = false;
      const canceled = new Promise((_, reject) => { abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }); });
      const pending = Promise.resolve().then(() => { guard(); return effect(); });
      observe(pending.then(result => { value = result; arrived = true; if (abandoned) discard(result); }));
      try { signal.throwIfAborted(); const result = await Promise.race([pending, canceled]); guard(); return result; }
      catch (error) { abandoned = true; if (arrived) discard(value); throw error; }
      finally { signal.removeEventListener('abort', abort); }
    }
    const sdk = (method, ...args) => step(() => methods[method].call(files, ...args,
      { signal, requestTimeoutMs: 30000, ...(method === 'read' ? { format: 'stream', streamIdleTimeoutMs: 30000 } : {}),
        ...(method === 'list' ? { depth: 1 } : {}) }), method === 'read' ? discardStream : undefined);
    return { signal, guard, step, sdk };
  }
  function info(value, expectedPath, expectedType) {
    invariant(value && value.path === expectedPath && value.name === posix.basename(expectedPath) && ['file', 'dir'].includes(value.type)
      && (!expectedType || value.type === expectedType) && Number.isSafeInteger(value.size) && value.size >= 0
      && Number.isSafeInteger(value.mode) && value.mode >= 0 && value.mode <= 0o177777, 'SKILL_E2B_METADATA_INVALID');
    if (value.type === 'dir') invariant((value.mode & 0o022) === 0, 'SKILL_E2B_DIRECTORY_WRITABLE');
    return { path: value.path, name: value.name, type: value.type, size: value.size, mode: value.mode,
      modifiedTime: value.modifiedTime instanceof Date ? value.modifiedTime.getTime() : value.modifiedTime ?? null };
  }
  async function ancestors(ctx, target, type) {
    path(target); let current = remoteRoot;
    const rootInfo = info(await ctx.sdk('getInfo', current), current, 'dir'); ctx.guard();
    if (current === target) { invariant(!type || type === 'dir', 'SKILL_E2B_FILE_REQUIRED'); return rootInfo; }
    const parts = target.slice(remoteRoot.length + 1).split('/');
    for (let i = 0; i < parts.length; i++) {
      current = posix.join(current, parts[i]);
      const item = info(await ctx.sdk('getInfo', current), current, i === parts.length - 1 ? type : 'dir'); ctx.guard();
      if (i === parts.length - 1) return item;
    }
  }
  async function listing(ctx, target) {
    await ancestors(ctx, target, 'dir'); const entries = await ctx.sdk('list', target); ctx.guard();
    invariant(Array.isArray(entries) && entries.length <= ENTRY_LIMIT, 'SKILL_E2B_ENTRY_LIMIT');
    let total = 0; const seen = new Set();
    const normalized = entries.map(entry => {
      path(entry?.path); invariant(posix.dirname(entry.path) === target && !seen.has(entry.path), 'SKILL_E2B_LIST_INVALID');
      seen.add(entry.path); const result = info(entry, entry.path);
      if (result.type === 'file') total += result.size;
      invariant(total <= TOTAL_LIMIT, 'SKILL_E2B_TOTAL_LIMIT'); return result;
    });
    await ancestors(ctx, target, 'dir'); ctx.guard(); return normalized;
  }
  async function readBytes(ctx, target, maxBytes) {
    invariant(Number.isSafeInteger(maxBytes) && maxBytes >= 0 && maxBytes <= maxFileBytes, 'SKILL_E2B_READ_LIMIT');
    const before = await ancestors(ctx, target, 'file'); invariant(before.size <= maxBytes, 'SKILL_E2B_FILE_LIMIT');
    const stream = await ctx.sdk('read', target);
    invariant(stream && typeof stream.getReader === 'function', 'SKILL_E2B_STREAM_REQUIRED');
    const reader = stream.getReader(), chunks = []; let total = 0;
    try {
      for (;;) {
        const chunk = await ctx.step(() => reader.read()); ctx.guard();
        invariant(chunk && typeof chunk.done === 'boolean', 'SKILL_E2B_STREAM_INVALID');
        if (chunk.done) break;
        invariant(chunk.value instanceof Uint8Array && total + chunk.value.byteLength <= maxBytes, 'SKILL_E2B_FILE_LIMIT');
        chunks.push(Buffer.from(chunk.value)); total += chunk.value.byteLength;
      }
      ctx.guard(); const after = await ancestors(ctx, target, 'file');
      invariant(canonical(before) === canonical(after) && total === before.size, 'SKILL_E2B_FILE_CHANGED');
      const bytes = Buffer.concat(chunks, total); ctx.guard(); return { path: target, bytes, size: total, sha256: digest(bytes) };
    } catch (error) { try { observe(reader.cancel()); } catch {} throw error; }
    finally { try { reader.releaseLock(); } catch {} }
  }
  async function upload(request) {
    const ctx = context(request); ctx.guard();
    invariant(Array.isArray(request.files) && request.files.length <= ENTRY_LIMIT, 'SKILL_E2B_ENTRY_LIMIT');
    let total = 0; const seen = new Set();
    // Validate the ENTIRE batch before the first SDK read or write. Decode only
    // after bounding encoded size, and retain private immutable byte copies.
    const batch = request.files.map(item => {
      const target = path(item?.path);
      invariant(target !== remoteRoot && !seen.has(target) && typeof item.base64 === 'string'
        && item.base64.length <= Math.ceil(maxFileBytes / 3) * 4 && /^[a-f0-9]{64}$/u.test(item.sha256 ?? ''), 'SKILL_E2B_UPLOAD_INVALID');
      seen.add(target); const bytes = Buffer.from(item.base64, 'base64'); total += bytes.length;
      invariant(bytes.toString('base64') === item.base64 && bytes.length <= maxFileBytes && total <= TOTAL_LIMIT
        && digest(bytes) === item.sha256, 'SKILL_E2B_UPLOAD_INVALID');
      return { path: target, bytes, sha256: item.sha256 };
    }); ctx.guard();
    const results = [];
    for (const item of batch) {
      const parent = posix.dirname(item.path), entries = await listing(ctx, parent);
      invariant(!entries.some(entry => entry.path === item.path), 'SKILL_E2B_UPLOAD_EXISTS');
      const payload = item.bytes.buffer.slice(item.bytes.byteOffset, item.bytes.byteOffset + item.bytes.byteLength);
      const ack = await ctx.sdk('write', item.path, payload); ctx.guard();
      invariant(ack && ack.path === item.path && ack.name === posix.basename(item.path), 'SKILL_E2B_UPLOAD_ACK_INVALID');
      const written = await readBytes(ctx, item.path, item.bytes.length);
      invariant(written.sha256 === item.sha256, 'SKILL_E2B_UPLOAD_CHANGED');
      results.push({ path: item.path, sha256: written.sha256, size: written.size });
    }
    ctx.guard(); return { files: results };
  }
  async function read(request) { const ctx = context(request); ctx.guard(); const target = path(request.path);
    return readBytes(ctx, target, request.maxBytes ?? maxFileBytes); }
  async function list(request) { const ctx = context(request); ctx.guard(); const entries = await listing(ctx, path(request.path));
    ctx.guard(); return { entries, count: entries.length }; }
  return Object.freeze({ upload, read, list });
}
