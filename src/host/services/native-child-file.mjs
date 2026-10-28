import { constants, lstatSync, openSync, closeSync, fstatSync, readSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { createHash } from 'node:crypto';

const CONTRACT = 'agentkit.native-child-file/v1';
class ChildFileError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const check = (value, code) => { if (!value) throw new ChildFileError(code); };
const identity = stat => [stat.dev, stat.ino, stat.mode, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');

function requestBody(value) {
  check(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every(key => ['agentId', 'sessionId', 'runId', 'childRunId', 'path', 'offset', 'limit'].includes(key)),
  'native_child_file_request_invalid');
  const body = structuredClone(value);
  check(['agentId', 'sessionId', 'runId', 'childRunId'].every(key => typeof body[key] === 'string'
    && body[key].trim() && body[key].length <= 256), 'native_child_file_request_invalid');
  check(typeof body.path === 'string' && body.path.length <= 1024 && !/[\0\\]/.test(body.path)
    && body.path.split('/').every(part => part && part !== '.' && part !== '..'), 'native_child_file_path_invalid');
  body.offset ??= 0; body.limit ??= 32768;
  check(Number.isSafeInteger(body.offset) && body.offset >= 0 && !Object.is(body.offset, -0)
    && Number.isSafeInteger(body.limit) && body.limit >= 4 && body.limit <= 65536, 'native_child_file_page_invalid');
  return Object.freeze(body);
}

function inspect(root, file) {
  const ancestors = [];
  for (let path = dirname(file);; path = dirname(path)) {
    const stat = lstatSync(path, { bigint: true });
    check(stat.isDirectory() && !stat.isSymbolicLink(), 'native_child_file_path_unsafe');
    ancestors.push([path, identity(stat)]);
    if (dirname(path) === path) break;
  }
  check(ancestors.some(([path]) => path === root), 'native_child_file_path_unsafe');
  const stat = lstatSync(file, { bigint: true });
  check(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n, 'native_child_file_path_unsafe');
  return { ancestors, stat };
}

async function withinSignal(operation, signal) {
  if (!signal) return operation();
  let abort;
  const stopped = new Promise((_, reject) => {
    abort = () => reject(new ChildFileError('native_child_file_canceled'));
    signal.addEventListener('abort', abort, { once: true });
  });
  try { return await Promise.race([Promise.resolve().then(operation), stopped]); }
  finally { signal.removeEventListener('abort', abort); }
}

/** A trusted capability resolves the original child execution root. This
 * observer never creates a tool result, changes a file or grants edit authority.
 */
export function createNativeChildFileReader({ resolveChild, isClosed = () => false }) {
  check(typeof resolveChild === 'function' && typeof isClosed === 'function', 'native_child_file_binding_invalid');
  return { async read(request, signal) {
    let fd;
    try {
      const body = requestBody(request);
      const available = () => {
        check(isClosed() === false, 'native_child_file_closed');
        check(!signal?.aborted, 'native_child_file_canceled');
      };
      check(signal === undefined || signal instanceof AbortSignal, 'native_child_file_signal_invalid');
      available();
      const capability = await withinSignal(() => resolveChild(body, signal), signal);
      available();
      check(capability && typeof capability.root === 'string' && isAbsolute(capability.root)
        && typeof capability.assertCurrent === 'function', 'native_child_file_binding_invalid');
      const root = capability.root, assertCurrent = capability.assertCurrent;
      const guard = () => {
        available(); const current = assertCurrent();
        if (current && typeof current.then === 'function') {
          Promise.resolve(current).catch(() => {}); throw new ChildFileError('native_child_file_binding_invalid');
        }
        check(current !== false, 'native_child_file_owner_changed'); available();
      };
      guard();
      const file = join(root, body.path), before = inspect(root, file);
      check(before.stat.size <= BigInt(Number.MAX_SAFE_INTEGER) && BigInt(body.offset) <= before.stat.size,
        'native_child_file_page_invalid');
      fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      check(identity(fstatSync(fd, { bigint: true })) === identity(before.stat), 'native_child_file_changed');
      const totalBytes = Number(before.stat.size), buffer = Buffer.alloc(Math.min(body.limit, totalBytes - body.offset));
      const length = buffer.length ? readSync(fd, buffer, 0, buffer.length, body.offset) : 0;
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, length),
        { stream: body.offset + length < totalBytes }); }
      catch { throw new ChildFileError('native_child_file_text_invalid'); }
      const consumed = Buffer.byteLength(text), next = body.offset + consumed;
      check(next > body.offset || body.offset === totalBytes, 'native_child_file_page_invalid');
      const after = inspect(root, file);
      check(identity(fstatSync(fd, { bigint: true })) === identity(before.stat)
        && identity(after.stat) === identity(before.stat)
        && before.ancestors.every(([path, id], index) => after.ancestors[index]?.[0] === path
          && after.ancestors[index]?.[1] === id), 'native_child_file_changed');
      guard();
      return { contract: CONTRACT, workspace: 'child', path: body.path, offset: body.offset,
        nextOffset: next < totalBytes ? next : null, totalBytes, text,
        pageDigest: 'sha256:' + createHash('sha256').update(buffer.subarray(0, consumed)).digest('hex'), readOnly: true };
    } catch (error) {
      if (error instanceof ChildFileError) throw error;
      throw new ChildFileError('native_child_file_unavailable');
    } finally { if (fd !== undefined) closeSync(fd); }
  } };
}
