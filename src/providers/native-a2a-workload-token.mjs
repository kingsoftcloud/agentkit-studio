/** Rotating workload JWTs, based on control_plane.py:95–207 @355059d.
 * Node has no openat: validated paths/descriptors fail closed on observed
 * drift, but cannot exclude an adversarial same-user ABA filesystem race.
 * Signature verification is the remote service's responsibility. */
import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, openSync, readlinkSync, readSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
export const A2A_WORKLOAD_TOKEN = 'agentkit.a2a-workload-token/v1';
const limit = 16 * 1024;
function fail() { const error = new Error('A2A workload token unavailable or invalid'); error.code = 'A2A_WORKLOAD_TOKEN_INVALID'; throw error; }
const stat = path => lstatSync(path, { bigint: true });
const same = (a, b, file = false) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode
  && (!file || a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs);
function directory(path) { const value = stat(path); if (!value.isDirectory() || value.isSymbolicLink()) fail(); return value; }
function jwt(token, audience, clock) {
  const segments = token.split('.');
  if (segments.length !== 3 || !segments.every(value => /^[A-Za-z0-9_-]+$/u.test(value))) fail();
  const bytes = Buffer.from(segments[1], 'base64url');
  if (bytes.toString('base64url') !== segments[1]) fail();
  const payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes), (key, value, context) => {
    if (typeof value === 'number' && !Number.isSafeInteger(value) && /^-?(0|[1-9][0-9]*)$/u.test(context?.source ?? '')) return BigInt(context.source);
    return value;
  });
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail();
  const aud = payload.aud;
  if (!(typeof aud === 'string' && aud === audience || Array.isArray(aud) && aud.every(value => typeof value === 'string') && aud.includes(audience))) fail();
  const exp = payload.exp;
  if (!(typeof exp === 'bigint' || Number.isSafeInteger(exp) || typeof exp === 'string' && /^(0|[1-9][0-9]*)$/u.test(exp))) fail();
  const now = clock(); if (!Number.isSafeInteger(now) || now < 0 || BigInt(exp) * 1000n <= BigInt(now)) fail();
}
export function createFileWorkloadTokenProvider({ tokenDirectory, clock = () => Date.now() } = {}) {
  try {
    if (typeof tokenDirectory !== 'string' || !tokenDirectory.trim() || typeof clock !== 'function' || !constants.O_NOFOLLOW) fail();
    const configured = resolve(tokenDirectory), root = realpathSync(configured), ancestry = [];
    for (let path = root;; path = dirname(path)) { ancestry.push([path, directory(path)]); if (dirname(path) === path) break; }
    function checkRoot() {
      if (realpathSync(configured) !== root) fail();
      for (const [path, pinned] of ancestry) if (!same(pinned, directory(path))) fail();
    }
    const binding = Object.freeze({ contract: A2A_WORKLOAD_TOKEN, tokenDirectoryDigest: createHash('sha256').update(root).digest('hex') });
    function getToken(request) {
      let originalSignal;
      try {
        const { audience, signal, assertCurrent } = request ?? {};
        if (typeof audience !== 'string' || !/^[!-~]{1,128}$/u.test(audience) || /[/\\]/u.test(audience)
          || ['.', '..'].includes(audience) || !(signal instanceof AbortSignal) || typeof assertCurrent !== 'function') fail();
        originalSignal = signal;
        const checks = [];
        function unchanged() {
          if (request.audience !== audience || request.signal !== signal || request.assertCurrent !== assertCurrent) fail();
          signal.throwIfAborted();
        }
        function guard() {
          unchanged(); const verdict = assertCurrent();
          if (verdict && typeof verdict.then === 'function') void Promise.resolve(verdict).catch(() => {});
          if (verdict !== true) fail(); unchanged(); checkRoot(); for (const check of checks) check();
        }
        guard(); const key = join(root, audience + '.jwt'), keyStat = stat(key); let path = key;
        if (keyStat.isSymbolicLink()) {
          const keyLink = readlinkSync(key); if (keyLink !== '..data/' + audience + '.jwt') fail();
          const data = join(root, '..data'), dataStat = stat(data);
          if (!dataStat.isSymbolicLink()) fail(); const dataLink = readlinkSync(data), generation = resolve(root, dataLink);
          if (!generation.startsWith(root + sep)) fail();
          // The designated ..data link is allowed; every resolved generation
          // component must be a real directory inside the pinned volume.
          for (let component = generation; component !== root; component = dirname(component)) {
            const pinned = directory(component), captured = component;
            checks.push(() => { if (!same(pinned, directory(captured))) fail(); });
          }
          checks.push(() => { if (!same(keyStat, stat(key)) || readlinkSync(key) !== keyLink
            || !same(dataStat, stat(data)) || readlinkSync(data) !== dataLink) fail(); });
          path = join(generation, audience + '.jwt');
        } else if (!keyStat.isFile()) fail();
        const before = stat(path);
        if (!before.isFile() || before.isSymbolicLink() || ![0o400n, 0o440n].includes(before.mode & 0o7777n) || before.size > BigInt(limit)) fail();
        checks.push(() => { if (!same(before, stat(path), true)) fail(); });
        guard(); const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        let bytes;
        try {
          if (!same(before, fstatSync(fd, { bigint: true }), true)) fail();
          const buffer = Buffer.alloc(limit + 1); let total = 0;
          while (total < buffer.length) { const count = readSync(fd, buffer, total, buffer.length - total, null); if (!count) break; total += count; }
          if (total > limit || BigInt(total) !== before.size || !same(before, fstatSync(fd, { bigint: true }), true)) fail();
          bytes = buffer.subarray(0, total);
        } finally { closeSync(fd); }
        guard(); if (bytes.some(byte => byte > 127)) fail(); const token = bytes.toString('ascii').trim(); if (!token) fail();
        jwt(token, audience, clock); guard(); return token;
      } catch {
        if (originalSignal?.aborted) throw new DOMException('A2A workload token request aborted', 'AbortError');
        fail();
      }
    }
    return Object.freeze({ binding, getToken });
  } catch { fail(); }
}
