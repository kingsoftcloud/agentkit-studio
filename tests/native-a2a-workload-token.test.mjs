/** Comprehensive tests for the A2A workload token provider.
 *
 * Synthetic tokens and temp directories only. These tests are AUTHORED here and
 * RUN BY THE PARENT — they are not executed by the implementer.
 *
 * Reference behavior: ksadk/a2a/control_plane.py:FileWorkloadTokenProvider @355059d.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync,
  symlinkSync, writeFileSync, realpathSync,
} from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { createFileWorkloadTokenProvider, A2A_WORKLOAD_TOKEN } from '../src/providers/native-a2a-workload-token.mjs';

const NOW = 2_000_000_000_000; // ms — fixed clock for deterministic expiry
const clock = () => NOW;
const AUD = 'a2a-registry';
const VALID_EXP = 2_000_000_500; // sec → 2000000500000 ms > NOW → not expired

function b64url(obj) { return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url'); }
function makeToken({ exp = VALID_EXP, aud = AUD, extra, header = { alg: 'RS256', kid: 'k1' } } = {}) {
  const payload = { ...(extra || {}), exp, aud };
  return `${b64url(header)}.${b64url(payload)}.sig`;
}

function withDir(fn) {
  return async () => {
    const dir = mkdtempSync(join(os.tmpdir(), 'a2a-tok-'));
    try { await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
  };
}

function writeRegular(dir, audience, token, mode = 0o400) {
  const p = join(dir, `${audience}.jwt`);
  writeFileSync(p, token);
  chmodSync(p, mode);
  return p;
}

function setupProjected(dir, audience, token, { mode = 0o400, gen = '..gen1' } = {}) {
  mkdirSync(join(dir, gen));
  const file = join(dir, gen, `${audience}.jwt`);
  writeFileSync(file, token);
  chmodSync(file, mode);
  symlinkSync(gen, join(dir, '..data'));
  symlinkSync(`..data/${audience}.jwt`, join(dir, `${audience}.jwt`));
  return { file, gen };
}

function ac() { return new AbortController(); }
const ok = () => true;

// ---- binding & construction -------------------------------------------------

test('binding is frozen and exposes contract + digest, no plain path', withDir((dir) => {
  const provider = createFileWorkloadTokenProvider({ tokenDirectory: dir, clock });
  assert.equal(provider.binding.contract, A2A_WORKLOAD_TOKEN);
  assert.match(provider.binding.tokenDirectoryDigest, /^[0-9a-f]{64}$/);
  assert.ok(Object.isFrozen(provider));
  assert.ok(Object.isFrozen(provider.binding));
  assert.equal(JSON.stringify(provider.binding).includes(dir), false, 'no plain directory in binding');
}));

test('digest is the sha256 of the realpath and differs across directories', withDir((dir) => {
  const a = createFileWorkloadTokenProvider({ tokenDirectory: dir, clock });
  mkdirSync(join(dir, 'sub'));
  const b = createFileWorkloadTokenProvider({ tokenDirectory: join(dir, 'sub'), clock });
  assert.notEqual(a.binding.tokenDirectoryDigest, b.binding.tokenDirectoryDigest);
  const same = createFileWorkloadTokenProvider({ tokenDirectory: dir, clock });
  assert.equal(a.binding.tokenDirectoryDigest, same.binding.tokenDirectoryDigest);
  assert.equal(a.binding.tokenDirectoryDigest, createHash('sha256').update(realpathSync(dir)).digest('hex'));
}));

test('tokenDirectory must be a non-empty string', () => {
  assert.throws(() => createFileWorkloadTokenProvider({ tokenDirectory: '', clock }), { code: 'A2A_WORKLOAD_TOKEN_INVALID' });
  assert.throws(() => createFileWorkloadTokenProvider({ tokenDirectory: '   ', clock }), { code: 'A2A_WORKLOAD_TOKEN_INVALID' });
  assert.throws(() => createFileWorkloadTokenProvider({ tokenDirectory: 42, clock }), { code: 'A2A_WORKLOAD_TOKEN_INVALID' });
  assert.throws(() => createFileWorkloadTokenProvider({ clock }), { code: 'A2A_WORKLOAD_TOKEN_INVALID' });
});

test('non-existent tokenDirectory is rejected', () => {
  assert.throws(() => createFileWorkloadTokenProvider({ tokenDirectory: join(os.tmpdir(), 'a2a-does-not-exist-xyz'), clock }), { code: 'A2A_WORKLOAD_TOKEN_INVALID' });
});

test('tokenDirectory that is a file (not a directory) is rejected', withDir((dir) => {
  const f = join(dir, 'notadir');
  writeFileSync(f, 'x');
  assert.throws(() => createFileWorkloadTokenProvider({ tokenDirectory: f, clock }), { code: 'A2A_WORKLOAD_TOKEN_INVALID' });
}));

// ---- ordinary regular-file tokens ------------------------------------------

test('ordinary token file mode 0400 is read and returned trimmed', withDir((dir) => {
  const token = makeToken();
  writeRegular(dir, AUD, token + '\n', 0o400);
  const provider = createFileWorkloadTokenProvider({ tokenDirectory: dir, clock });
  assert.equal(provider.getToken({ audience: AUD, signal: ac().signal, assertCurrent: ok }), token);
}));

test('ordinary token file mode 0440 is accepted (fsGroup group-read)', withDir((dir) => {
  const token = makeToken();
  writeRegular(dir, AUD, token, 0o440);
  const provider = createFileWorkloadTokenProvider({ tokenDirectory: dir, clock });
  assert.equal(provider.getToken({ audience: AUD, signal: ac().signal, assertCurrent: ok }), token);
}));

test('no cache: every call re-reads rotated regular-file content', withDir((dir) => {
  const a = makeToken({ extra: { n: 1 } });
  const b = makeToken({ extra: { n: 2 } });
  const p = writeRegular(dir, AUD, a, 0o400);
  const provider = createFileWorkloadTokenProvider({ tokenDirectory: dir, clock });
  assert.equal(provider.getToken({ audience: AUD, signal: ac().signal, assertCurrent: ok }), a);
  chmodSync(p, 0o600); writeFileSync(p, b); chmodSync(p, 0o400);
  assert.equal(provider.getToken({ audience: AUD, signal: ac().signal, assertCurrent: ok }), b);
  chmodSync(p, 0o600); writeFileSync(p, a); chmodSync(p, 0o400);
  assert.equal(provider.getToken({ audience: AUD, signal: ac().signal, assertCurrent: ok }), a);
}));

// ---- Kubernetes projected ..data layout -----------------------------------

test('projected ..data layout is accepted', withDir((dir) => {
  const token = makeToken();
  setupProjected(dir, AUD, token);
  const provider = createFileWorkloadTokenProvider({ tokenDirectory: dir, clock });
  assert.equal(provider.getToken({ audience: AUD, signal: ac().signal, assertCurrent: ok }), token);
}));

test('projected ..data generation rotation is observed on every call', withDir((dir) => {
  const a = makeToken({ extra: { gen: 1 } });
  const b = makeToken({ extra: { gen: 2 } });
  setupProjected(dir, AUD, a, { gen: '..gen1' });
  const provider = createFileWorkloadTokenProvider({ tokenDirectory: dir, clock });
  assert.equal(provider.getToken({ audience: AUD, signal: ac().signal, assertCurrent: ok }), a);
  // Rotate to a new generation: create it, then atomically re-point ..data.
  mkdirSync(join(dir, '..gen2'));
  writeFileSync(join(dir, '..gen2', `${AUD}.jwt`), b);
  chmodSync(join(dir, '..gen2', `${AUD}.jwt`), 0o400);
  rmSync(join(dir, '..data'));
  symlinkSync('..gen2', join(dir, '..data'));
  assert.equal(provider.getToken({ audience: AUD, signal: ac().signal, assertCurrent: ok }), b);
}));

test('projected generation target read every call (no cache across projected reads)', withDir((dir) => {
  const a = makeToken({ extra: { v: 1 } });
  const b = makeToken({ extra: { v: 2 } });
  setupProjected(dir, AUD, a, { gen: '..gen1' });
  const provider = createFileWorkloadTokenProvider({ tokenDirectory: dir, clock });
  const file = join(dir, '..gen1', `${AUD}.jwt`);
  assert.equal(provider.getToken({ audience: AUD, signal: ac().signal, assertCurrent: ok }), a);
  chmodSync(file, 0o600); writeFileSync(file, b); chmodSync(file, 0o400);
  assert.equal(provider.getToken({ audience: AUD, signal: ac().signal, assertCurrent: ok }), b);
}));

// ---- symlink / ancestor / outside rejection --------------------------------

test('key symlink to a non-..data target is rejected', withDir((dir) => {
  writeFileSync(join(dir, 'evil.jwt'), makeToken());
  chmodSync(join(dir, 'evil.jwt'), 0o400);
  symlinkSync('evil.jwt', join(dir, `${AUD}.jwt`));
  const provider = createFileWorkloadTokenProvider({ tokenDirectory: dir, clock });
  assert.throws(() => provider.getToken({ audience: AUD, signal: ac().signal, assertCurrent: ok }), { code: 'A2A_WORKLOAD_TOKEN_INVALID' });
}));

test('key symlink to wrong audience inside ..data is rejected', withDir((dir) => {
  mkdirSync(join(dir, '..gen1'));
  writeFileSync(join(dir, '..gen1', 'other.jwt'), makeToken({ aud: 'other' }));
  chmodSync(join(dir, '..gen1', 'other.jwt'), 0o400);
  symlinkSync('..gen1', join(dir, '..data'));
  symlinkSync('..data/other.jwt', join(dir, `${AUD}.jwt`)); // audience mismatch in link target
  const provider = createFileWorkloadTokenProvider({ tokenDirectory: dir, clock });
  assert.throws(() => provider.getToken({ audience: AUD, signal: ac().signal, assertCurrent: ok }), { code: 'A2A_WORKLOAD_TOKEN_INVALID' });
}));

test('..data pointing outside root (../../etc) is rejected', withDir((dir) => {
  mkdirSync(join(dir, '..gen1'));
  writeFileSync(join(dir, '..gen1', `${AUD}.jwt`), makeToken());
  chmodSync(join(dir, '..gen1', `${AUD}.jwt`), 0o400);
  symlinkSync('../../etc', join(dir, '..data')); // contains '/'
  symlinkSync(`..data/${AUD}.jwt`, join(dir, `${AUD}.jwt`));
  const provider = createFileWorkloadTokenProvider({ tokenDirectory: dir, clock });
  assert.throws(() => provider.getToken({ audience: AUD, signal: ac().signal, assertCurrent: ok }), { code: 'A2A_WORKLOAD_TOKEN_INVALID' });
}));

test('..data pointing to an absolute path is rejected', withDir((dir) => {
  mkdirSync(join(dir, '..gen1'));
  writeFileSync(join(dir, '..gen1', `${AUD}.jwt`), makeToken());
  chmodSync(join(dir, '..gen1', `${AUD}.jwt`), 0o400);
  symlinkSync('/etc', join(dir, '..data'));
  symlinkSync(`..data/${AUD}.jwt`, join(dir, `${AUD}.jwt`));
  const provider = createFileWorkloadTokenProvider({ tokenDirectory: dir, clock });
  assert.throws(() => provider.getToken({ audience: AUD, signal: ac().signal, assertCurrent: ok }), { code: 'A2A_WORKLOAD_TOKEN_INVALID' });
}));

test('generation that is itself a symlink is rejected', withDir((dir) => {
  mkdirSync(join(dir, 'real-gen'));
  writeFileSync(join(dir, 'real-gen', `${AUD}.jwt`), makeToken());
  chmodSync(join(dir, 'real-gen', `${AUD}.jwt`), 0o400);
  symlinkSync('real-gen', join(dir, '..genlink')); // generation is a symlink
  symlinkSync('..genlink', join(dir, '..data'));
  symlinkSync(`..data/${AUD}.jwt`, join(dir, `${AUD}.jwt`));
  const provider = createFileWorkloadTokenProvider({ tokenDirectory: dir, clock });
  assert.throws(() => provider.getToken({ audience: AUD, signal: ac().signal, assertCurrent: ok }), { code: 'A2A_WORKLOAD_TOKEN_INVALID' });
}));

test('projected final target that is a symlink is rejected (O_NOFOLLOW + lstat)', withDir((dir) => {
  mkdirSync(join(dir, '..gen1'));
  writeFileSync(join(dir, 'real.jwt'), makeToken());
  chmodSync(join(dir, 'real.jwt'), 0o400);
  symlinkSync('../real.jwt', join(dir, '..gen1', `${AUD}.jwt`)); // target is a symlink
  symlinkSync('..gen1', join(dir, '..data'));
  symlinkSync(`..data/${AUD}.jwt`, join(dir, `${AUD}.jwt`));
  const provider = createFileWorkloadTokenProvider({ tokenDirectory: dir, clock });
  assert.throws(() => provider.getToken({ audience: AUD, signal: ac().signal, assertCurrent: ok }), { code: 'A2A_WORKLOAD_TOKEN_INVALID' });
}));

// ---- wrong mode / type / FIFO without hang ---------------------------------

test('regular file mode 0644 is rejected', withDir((dir) => {
  writeRegular(dir, AUD, makeToken(), 0o644);
  const provider = createFileWorkloadTokenProvider({ tokenDirectory: dir, clock });
  assert.throws(() => provider.getToken({ audience: AUD, signal: ac().signal, assertCurrent: ok }), { code: 'A2A_WORKLOAD_TOKEN_INVALID' });
}));

test('regular file mode 0600 is rejected (only 0400/0440)', withDir((dir) => {
  writeRegular(dir, AUD, makeToken(), 0o600);
  const provider = createFileWorkloadTokenProvider({ tokenDirectory: dir, clock });
  assert.throws(() => provider.getToken({ audience: AUD, signal: ac().signal, assertCurrent: ok }), { code: 'A2A_WORKLOAD_TOKEN_INVALID' });
}));

test('regular file mode 0444 is rejected (only 0400/0440)', withDir((dir) => {
  writeRegular(dir, AUD, makeToken(), 0o444);
  const provider = createFileWorkloadTokenProvider({ tokenDirectory: dir, clock });
  assert.throws(() => provider.getToken({ audience: AUD, signal: ac().signal, assertCurrent: ok }), { code: 'A2A_WORKLOAD_TOKEN_INVALID' });
}));

test('regular file mode 0000 is rejected', withDir((dir) => {
  writeRegular(dir, AUD, makeToken(), 0o000);
  const provider = createFileWorkloadTokenProvider({ tokenDirectory: dir, clock });
  assert.throws(() => provider.getToken({ audience: AUD, signal: ac().signal, assertCurrent: ok }), { code: 'A2A_WORKLOAD_TOKEN_INVALID' });
}));

test('a directory named <audience>.jwt is rejected', withDir((dir) => {
  mkdirSync(join(dir, `${AUD}.jwt`));
  const provider = createFileWorkloadTokenProvider({ tokenDirectory: dir, clock });
  assert.throws(() => provider.getToken({ audience: AUD, signal: ac().signal, assertCurrent: ok }), { code: 'A2A_WORKLOAD_TOKEN_INVALID' });
}));

test('a FIFO at the projected generation target is rejected without hanging', withDir((dir) => {
  mkdirSync(join(dir, '..gen1'));
  execFileSync('mkfifo', [join(dir, '..gen1', `${AUD}.jwt`)]);
  chmodSync(join(dir, '..gen1', `${AUD}.jwt`), 0o400);
  symlinkSync('..gen1', join(dir, '..data'));
  symlinkSync(`..data/${AUD}.jwt`, join(dir, `${AUD}.jwt`));
  const provider = createFileWorkloadTokenProvider({ tokenDirectory: dir, clock });
  // Must reject quickly (lstat isFile === false) and never block on open.
  assert.throws(() => provider.getToken({ audience: AUD, signal: ac().signal, assertCurrent: ok }), { code: 'A2A_WORKLOAD_TOKEN_INVALID' });
}));

// ---- empty / oversize / nonASCII / boundary --------------------------------

test('empty token file is rejected', withDir((dir) => {
  writeRegular(dir, AUD, '', 0o400);
  const provider = createFileWorkloadTokenProvider({ tokenDirectory: dir, clock });
  assert.throws(() => provider.getToken({ audience: AUD, signal: ac().signal, assertCurrent: ok }), { code: 'A2A_WORKLOAD_TOKEN_INVALID' });
}));

test('whitespace-only token file is rejected after trim', withDir((dir) => {
  writeRegular(dir, AUD, '   \n\t  ', 0o400);
  const provider = createFileWorkloadTokenProvider({ tokenDirectory: dir, clock });
  assert.throws(() => provider.getToken({ audience: AUD, signal: ac().signal, assertCurrent: ok }), { code: 'A2A_WORKLOAD_TOKEN_INVALID' });
}));

test('oversized token (>16 KiB) is rejected by bounded read', withDir((dir) => {
  const big = makeToken({ extra: { x: 'A'.repeat(17000) } });
  writeRegular(dir, AUD, big, 0o400);
  const provider = createFileWorkloadTokenProvider({ tokenDirectory: dir, clock });
  assert.throws(() => provider.getToken({ audience: AUD, signal: ac().signal, assertCurrent: ok }), { code: 'A2A_WORKLOAD_TOKEN_INVALID' });
}));

test('exactly 16 KiB valid JWT is accepted (boundary inclusive)', withDir((dir) => {
  const header = b64url({ alg: 'none' });
  const payload = b64url({ exp: VALID_EXP, aud: AUD });
  const sigLen = 16 * 1024 - header.length - 1 - payload.length - 1;
  assert.ok(sigLen > 0, 'signature length must be positive');
  const token = `${header}.${payload}.${'A'.repeat(sigLen)}`;
  assert.equal(token.length, 16 * 1024);
  writeRegular(dir, AUD, token, 0o400);
  const provider = createFileWorkloadTokenProvider({ tokenDirectory: dir, clock });
  assert.equal(provider.getToken({ audience: AUD, signal: ac().signal, assertCurrent: ok }), token);
}));

test('16 KiB + 1 bytes is rejected (strictly over the limit)', withDir((dir) => {
  const header = b64url({ alg: 'none' });
  const payload = b64url({ exp: VALID_EXP, aud: AUD });
  const sigLen = 16 * 1024 + 1 - header.length - 1 - payload.length - 1;
  assert.ok(sigLen > 0, 'signature length must be positive');
  const token = `${header}.${payload}.${'A'.repeat(sigLen)}`;
  assert.equal(token.length, 16 * 1024 + 1);
  writeRegular(dir, AUD, token, 0o400);
  const provider = createFileWorkloadTokenProvider({ tokenDirectory: dir, clock });
  assert.throws(() => provider.getToken({ audience: AUD, signal: ac().signal, assertCurrent: ok }), { code: 'A2A_WORKLOAD_TOKEN_INVALID' });
}));

test('non-ASCII byte (>127) is rejected even though TextDecoder ascii would mask it', withDir((dir) => {
  const token = makeToken();
  writeRegular(dir, AUD, token + '\xff', 0o400);
  const provider = createFileWorkloadTokenProvider({ tokenDirectory: dir, clock });
  assert.throws(() => provider.getToken({ audience: AUD, signal: ac().signal, assertCurrent: ok }), { code: 'A2A_WORKLOAD_TOKEN_INVALID' });
}));

test('leading non-ASCII byte is rejected', withDir((dir) => {
  writeRegular(dir, AUD, '\xff' + makeToken(), 0o400);
  const provider = createFileWorkloadTokenProvider({ tokenDirectory: dir, clock });
  assert.throws(() => provider.getToken({ audience: AUD, signal: ac().signal, assertCurrent: ok }), { code: 'A2A_WORKLOAD_TOKEN_INVALID' });
}));

// ---- JWT validation: audience / malformed / expiry ------------------------

test('audience mismatch (string aud) is rejected', withDir((dir) => {
  writeRegular(dir, AUD, makeToken({ aud: 'a2a-task-sink' }), 0o400);
  const provider = createFileWorkloadTokenProvider({ tokenDirectory: dir, clock });
  assert.throws(() => provider.getToken({ audience: AUD, signal: ac().signal, assertCurrent: ok }), { code: 'A2A_WORKLOAD_TOKEN_INVALID' });
}));

test('audience match inside an array is accepted', withDir((dir) => {
  const token = makeToken({ aud: [AUD, 'a2a-gateway'] });
  writeRegular(dir, AUD, token, 0o400);
  const provider = createFileWorkloadTokenProvider({ tokenDirectory: dir, clock });
  assert.equal(provider.getToken({ audience: AUD, signal: ac().signal, assertCurrent: ok }), token);
}));

test('audience absent from array is rejected', withDir((dir) => {
  writeRegular(dir, AUD, makeToken({ aud: ['a2a-task-sink', 'a2a-gateway'] }), 0o400);
  const provider = createFileWorkloadTokenProvider({ tokenDirectory: dir, clock });
  assert.throws(() => provider.getToken({ audience: AUD, signal: ac().signal, assertCurrent: ok }), { code: 'A2A_WORKLOAD_TOKEN_INVALID' });
}));

test('non-string aud (number) is rejected — no Python str() coercion', withDir((dir) => {
  const token = `${b64url({ alg: 'none' })}.${b64url({ exp: VALID_EXP, aud: 1 })}.sig`;
  writeRegular(dir, AUD, token, 0o400);
  const provider = createFileWorkloadTokenProvider({ tokenDirectory: dir, clock });
  assert.throws(() => provider.getToken({ audience: AUD, signal: ac().signal, assertCurrent: ok }), { code: 'A2A_WORKLOAD_TOKEN_INVALID' });
}));

test('array aud with non-string element is rejected', withDir((dir) => {
  const token = `${b64url({ alg: 'none' })}.${b64url({ exp: VALID_EXP, aud: [AUD, 1] })}.sig`;
  writeRegular(dir, AUD, token, 0o400);
  const provider = createFileWorkloadTokenProvider({ tokenDirectory: dir, clock });
  assert.throws(() => provider.getToken({ audience: AUD, signal: ac().signal, assertCurrent: ok }), { code: 'A2A_WORKLOAD_TOKEN_INVALID' });
}));

test('missing aud is rejected', withDir((dir) => {
  const token = `${b64url({ alg: 'none' })}.${b64url({ exp: VALID_EXP })}.sig`;
  writeRegular(dir, AUD, token, 0o400);
  const provider = createFileWorkloadTokenProvider({ tokenDirectory: dir, clock });
  assert.throws(() => provider.getToken({ audience: AUD, signal: ac().signal, assertCurrent: ok }), { code: 'A2A_WORKLOAD_TOKEN_INVALID' });
}));

test('malformed JWT with two segments is rejected', withDir((dir) => {
  writeRegular(dir, AUD, 'only.two', 0o400);
  const provider = createFileWorkloadTokenProvider({ tokenDirectory: dir, clock });
  assert.throws(() => provider.getToken({ audience: AUD, signal: ac().signal, assertCurrent: ok }), { code: 'A2A_WORKLOAD_TOKEN_INVALID' });
}));

test('malformed JWT with four segments is rejected', withDir((dir) => {
  writeRegular(dir, AUD, 'a.b.c.d', 0o400);
  const provider = createFileWorkloadTokenProvider({ tokenDirectory: dir, clock });
  assert.throws(() => provider.getToken({ audience: AUD, signal: ac().signal, assertCurrent: ok }), { code: 'A2A_WORKLOAD_TOKEN_INVALID' });
}));

test('malformed JWT with no dots is rejected', withDir((dir) => {
  writeRegular(dir, AUD, 'nojwt', 0o400);
  const provider = createFileWorkloadTokenProvider({ tokenDirectory: dir, clock });
  assert.throws(() => provider.getToken({ audience: AUD, signal: ac().signal, assertCurrent: ok }), { code: 'A2A_WORKLOAD_TOKEN_INVALID' });
}));

test('empty JWT segment is rejected', withDir((dir) => {
  writeRegular(dir, AUD, `${b64url({ alg: 'none' })}..sig`, 0o400);
  const provider = createFileWorkloadTokenProvider({ tokenDirectory: dir, clock });
  assert.throws(() => provider.getToken({ audience: AUD, signal: ac().signal, assertCurrent: ok }), { code: 'A2A_WORKLOAD_TOKEN_INVALID' });
}));

test('expired token (integer exp in the past) is rejected', withDir((dir) => {
  writeRegular(dir, AUD, makeToken({ exp: 2_000_000_000 - 3600 }), 0o400);
  const provider = createFileWorkloadTokenProvider({ tokenDirectory: dir, clock });
  assert.throws(() => provider.getToken({ audience: AUD, signal: ac().signal, assertCurrent: ok }), { code: 'A2A_WORKLOAD_TOKEN_INVALID' });
}));

test('exp exactly equal to now is rejected (<= now is expired)', withDir((dir) => {
  writeRegular(dir, AUD, makeToken({ exp: 2_000_000_000 }), 0o400);
  const provider = createFileWorkloadTokenProvider({ tokenDirectory: dir, clock });
  assert.throws(() => provider.getToken({ audience: AUD, signal: ac().signal, assertCurrent: ok }), { code: 'A2A_WORKLOAD_TOKEN_INVALID' });
}));

test('large decimal string exp is compared without rounding (far future, not expired)', withDir((dir) => {
  const farFuture = '99999999999999999999'; // > MAX_SAFE_INTEGER
  const token = makeToken({ exp: farFuture });
  writeRegular(dir, AUD, token, 0o400);
  const provider = createFileWorkloadTokenProvider({ tokenDirectory: dir, clock });
  assert.equal(provider.getToken({ audience: AUD, signal: ac().signal, assertCurrent: ok }), token);
}));

test('small decimal string exp in the past is rejected via BigInt', withDir((dir) => {
  // exp sec = 1 (string) → 1000 ms <= NOW → expired. A Number cast would also
  // be past, but this confirms the string path compares without rounding.
  writeRegular(dir, AUD, makeToken({ exp: '1' }), 0o400);
  const provider = createFileWorkloadTokenProvider({ tokenDirectory: dir, clock });
  assert.throws(() => provider.getToken({ audience: AUD, signal: ac().signal, assertCurrent: ok }), { code: 'A2A_WORKLOAD_TOKEN_INVALID' });
}));

test('missing exp is rejected', withDir((dir) => {
  const token = `${b64url({ alg: 'none' })}.${b64url({ aud: AUD })}.sig`;
  writeRegular(dir, AUD, token, 0o400);
  const provider = createFileWorkloadTokenProvider({ tokenDirectory: dir, clock });
  assert.throws(() => provider.getToken({ audience: AUD, signal: ac().signal, assertCurrent: ok }), { code: 'A2A_WORKLOAD_TOKEN_INVALID' });
}));

test('float exp is rejected (Python int() truncates; Node rejects)', withDir((dir) => {
  const token = `${b64url({ alg: 'none' })}.${b64url({ exp: VALID_EXP + 0.5, aud: AUD })}.sig`;
  writeRegular(dir, AUD, token, 0o400);
  const provider = createFileWorkloadTokenProvider({ tokenDirectory: dir, clock });
  assert.throws(() => provider.getToken({ audience: AUD, signal: ac().signal, assertCurrent: ok }), { code: 'A2A_WORKLOAD_TOKEN_INVALID' });
}));

test('boolean exp is rejected', withDir((dir) => {
  const token = `${b64url({ alg: 'none' })}.${b64url({ exp: true, aud: AUD })}.sig`;
  writeRegular(dir, AUD, token, 0o400);
  const provider = createFileWorkloadTokenProvider({ tokenDirectory: dir, clock });
  assert.throws(() => provider.getToken({ audience: AUD, signal: ac().signal, assertCurrent: ok }), { code: 'A2A_WORKLOAD_TOKEN_INVALID' });
}));

test('non-numeric string exp is rejected', withDir((dir) => {
  const token = `${b64url({ alg: 'none' })}.${b64url({ exp: 'soon', aud: AUD })}.sig`;
  writeRegular(dir, AUD, token, 0o400);
  const provider = createFileWorkloadTokenProvider({ tokenDirectory: dir, clock });
  assert.throws(() => provider.getToken({ audience: AUD, signal: ac().signal, assertCurrent: ok }), { code: 'A2A_WORKLOAD_TOKEN_INVALID' });
}));

test('payload not a JSON object is rejected', withDir((dir) => {
  // payload decodes to a JSON array
  const token = `${b64url({ alg: 'none' })}.${b64url([1, 2, 3])}.sig`;
  writeRegular(dir, AUD, token, 0o400);
  const provider = createFileWorkloadTokenProvider({ tokenDirectory: dir, clock });
  assert.throws(() => provider.getToken({ audience: AUD, signal: ac().signal, assertCurrent: ok }), { code: 'A2A_WORKLOAD_TOKEN_INVALID' });
}));

// ---- strict base64url payload decoding -------------------------------------

test('payload segment with invalid base64url char (+) is rejected', withDir((dir) => {
  const token = `${b64url({ alg: 'none' })}.e+y.sig`;
  writeRegular(dir, AUD, token, 0o400);
  const provider = createFileWorkloadTokenProvider({ tokenDirectory: dir, clock });
  assert.throws(() => provider.getToken({ audience: AUD, signal: ac().signal, assertCurrent: ok }), { code: 'A2A_WORKLOAD_TOKEN_INVALID' });
}));

test('payload segment containing padding (=) is rejected (JWT segments are unpadded)', withDir((dir) => {
  const token = `${b64url({ alg: 'none' })}.${b64url({ exp: VALID_EXP, aud: AUD })}=.sig`;
  writeRegular(dir, AUD, token, 0o400);
  const provider = createFileWorkloadTokenProvider({ tokenDirectory: dir, clock });
  assert.throws(() => provider.getToken({ audience: AUD, signal: ac().signal, assertCurrent: ok }), { code: 'A2A_WORKLOAD_TOKEN_INVALID' });
}));

test('payload segment length mod 4 == 1 is rejected', withDir((dir) => {
  const token = `${b64url({ alg: 'none' })}.e.sig`; // "e" is length 1
  writeRegular(dir, AUD, token, 0o400);
  const provider = createFileWorkloadTokenProvider({ tokenDirectory: dir, clock });
  assert.throws(() => provider.getToken({ audience: AUD, signal: ac().signal, assertCurrent: ok }), { code: 'A2A_WORKLOAD_TOKEN_INVALID' });
}));

test('non-canonical base64url payload (non-zero trailing bits) is rejected', withDir((dir) => {
  // "e31" decodes to bytes whose canonical base64url re-encoding is "e9U", not
  // "e31"; a lenient decoder would accept it, but the canonical check rejects.
  const token = `${b64url({ alg: 'none' })}.e31.sig`;
  writeRegular(dir, AUD, token, 0o400);
  const provider = createFileWorkloadTokenProvider({ tokenDirectory: dir, clock });
  assert.throws(() => provider.getToken({ audience: AUD, signal: ac().signal, assertCurrent: ok }), { code: 'A2A_WORKLOAD_TOKEN_INVALID' });
}));

test('canonical base64url payload round-trips and is accepted', withDir((dir) => {
  // b64url() produces canonical base64url, so a normal token must pass.
  const token = makeToken({ extra: { sub: 'svc-x', iss: 'agentengine' } });
  writeRegular(dir, AUD, token, 0o400);
  const provider = createFileWorkloadTokenProvider({ tokenDirectory: dir, clock });
  assert.equal(provider.getToken({ audience: AUD, signal: ac().signal, assertCurrent: ok }), token);
}));

// ---- no secret in error messages ------------------------------------------

test('expired error does not leak the token', withDir((dir) => {
  const token = makeToken({ exp: 2_000_000_000 - 3600 });
  writeRegular(dir, AUD, token, 0o400);
  const provider = createFileWorkloadTokenProvider({ tokenDirectory: dir, clock });
  try {
    provider.getToken({ audience: AUD, signal: ac().signal, assertCurrent: ok });
    assert.fail('expected throw');
  } catch (err) {
    assert.equal(err.code, 'A2A_WORKLOAD_TOKEN_INVALID');
    assert.equal(err.message.includes(token), false, 'token leaked in message');
    assert.equal(JSON.stringify(err).includes(token), false, 'token leaked in error JSON');
  }
}));

test('audience-mismatch error does not leak the token', withDir((dir) => {
  const token = makeToken({ aud: 'a2a-task-sink' });
  writeRegular(dir, AUD, token, 0o400);
  const provider = createFileWorkloadTokenProvider({ tokenDirectory: dir, clock });
  try {
    provider.getToken({ audience: AUD, signal: ac().signal, assertCurrent: ok });
    assert.fail('expected throw');
  } catch (err) {
    assert.equal(err.code, 'A2A_WORKLOAD_TOKEN_INVALID');
    assert.equal(err.message.includes(token), false, 'token leaked');
    assert.equal(JSON.stringify(err).includes(token), false, 'token leaked in JSON');
  }
}));

test('non-ASCII error does not leak the readable token prefix', withDir((dir) => {
  const token = makeToken();
  writeRegular(dir, AUD, token + '\xff', 0o400);
  const provider = createFileWorkloadTokenProvider({ tokenDirectory: dir, clock });
  try {
    provider.getToken({ audience: AUD, signal: ac().signal, assertCurrent: ok });
    assert.fail('expected throw');
  } catch (err) {
    assert.equal(err.code, 'A2A_WORKLOAD_TOKEN_INVALID');
    assert.equal(err.message.includes(token), false, 'token leaked');
  }
}));

// ---- request shape & audience validation -----------------------------------

test('missing audience is rejected', withDir((dir) => {
  const provider = createFileWorkloadTokenProvider({ tokenDirectory: dir, clock });
  assert.throws(() => provider.getToken({ signal: ac().signal, assertCurrent: ok }), { code: 'A2A_WORKLOAD_TOKEN_INVALID' });
}));

test('missing signal is rejected', withDir((dir) => {
  writeRegular(dir, AUD, makeToken(), 0o400);
  const provider = createFileWorkloadTokenProvider({ tokenDirectory: dir, clock });
  assert.throws(() => provider.getToken({ audience: AUD, assertCurrent: ok }), { code: 'A2A_WORKLOAD_TOKEN_INVALID' });
}));

test('missing assertCurrent is rejected', withDir((dir) => {
  writeRegular(dir, AUD, makeToken(), 0o400);
  const provider = createFileWorkloadTokenProvider({ tokenDirectory: dir, clock });
  assert.throws(() => provider.getToken({ audience: AUD, signal: ac().signal }), { code: 'A2A_WORKLOAD_TOKEN_INVALID' });
}));

test('non-object request is rejected', withDir((dir) => {
  const provider = createFileWorkloadTokenProvider({ tokenDirectory: dir, clock });
  assert.throws(() => provider.getToken(null), { code: 'A2A_WORKLOAD_TOKEN_INVALID' });
  assert.throws(() => provider.getToken('x'), { code: 'A2A_WORKLOAD_TOKEN_INVALID' });
}));

test('audience containing slash is rejected', withDir((dir) => {
  const provider = createFileWorkloadTokenProvider({ tokenDirectory: dir, clock });
  assert.throws(() => provider.getToken({ audience: 'a/b', signal: ac().signal, assertCurrent: ok }), { code: 'A2A_WORKLOAD_TOKEN_INVALID' });
}));

test('audience containing backslash is rejected', withDir((dir) => {
  const provider = createFileWorkloadTokenProvider({ tokenDirectory: dir, clock });
  assert.throws(() => provider.getToken({ audience: 'a\\b', signal: ac().signal, assertCurrent: ok }), { code: 'A2A_WORKLOAD_TOKEN_INVALID' });
}));

test('audience "." and ".." are rejected', withDir((dir) => {
  const provider = createFileWorkloadTokenProvider({ tokenDirectory: dir, clock });
  assert.throws(() => provider.getToken({ audience: '.', signal: ac().signal, assertCurrent: ok }), { code: 'A2A_WORKLOAD_TOKEN_INVALID' });
  assert.throws(() => provider.getToken({ audience: '..', signal: ac().signal, assertCurrent: ok }), { code: 'A2A_WORKLOAD_TOKEN_INVALID' });
}));

test('audience with NUL is rejected', withDir((dir) => {
  const provider = createFileWorkloadTokenProvider({ tokenDirectory: dir, clock });
  assert.throws(() => provider.getToken({ audience: 'a\0b', signal: ac().signal, assertCurrent: ok }), { code: 'A2A_WORKLOAD_TOKEN_INVALID' });
}));

test('audience with space is rejected (strict printable ASCII)', withDir((dir) => {
  const provider = createFileWorkloadTokenProvider({ tokenDirectory: dir, clock });
  assert.throws(() => provider.getToken({ audience: 'a b', signal: ac().signal, assertCurrent: ok }), { code: 'A2A_WORKLOAD_TOKEN_INVALID' });
}));

test('audience with non-ASCII is rejected', withDir((dir) => {
  const provider = createFileWorkloadTokenProvider({ tokenDirectory: dir, clock });
  assert.throws(() => provider.getToken({ audience: 'aé', signal: ac().signal, assertCurrent: ok }), { code: 'A2A_WORKLOAD_TOKEN_INVALID' });
}));

test('audience with a dot in the middle is accepted', withDir((dir) => {
  const aud = 'a2a.registry';
  const token = makeToken({ aud });
  writeRegular(dir, aud, token, 0o400);
  const provider = createFileWorkloadTokenProvider({ tokenDirectory: dir, clock });
  assert.equal(provider.getToken({ audience: aud, signal: ac().signal, assertCurrent: ok }), token);
}));

// ---- authority guard: abort / false / undefined / async -------------------

test('pre-aborted signal is rejected before any read', withDir((dir) => {
  writeRegular(dir, AUD, makeToken(), 0o400);
  const provider = createFileWorkloadTokenProvider({ tokenDirectory: dir, clock });
  const c = ac(); c.abort();
  assert.throws(() => provider.getToken({ audience: AUD, signal: c.signal, assertCurrent: ok }), { name: 'AbortError' });
}));

test('assertCurrent returning false is rejected', withDir((dir) => {
  writeRegular(dir, AUD, makeToken(), 0o400);
  const provider = createFileWorkloadTokenProvider({ tokenDirectory: dir, clock });
  assert.throws(() => provider.getToken({ audience: AUD, signal: ac().signal, assertCurrent: () => false }), { code: 'A2A_WORKLOAD_TOKEN_INVALID' });
}));

test('assertCurrent returning undefined is rejected', withDir((dir) => {
  writeRegular(dir, AUD, makeToken(), 0o400);
  const provider = createFileWorkloadTokenProvider({ tokenDirectory: dir, clock });
  assert.throws(() => provider.getToken({ audience: AUD, signal: ac().signal, assertCurrent: () => undefined }), { code: 'A2A_WORKLOAD_TOKEN_INVALID' });
}));

test('assertCurrent returning a truthy non-true value (1) is rejected', withDir((dir) => {
  writeRegular(dir, AUD, makeToken(), 0o400);
  const provider = createFileWorkloadTokenProvider({ tokenDirectory: dir, clock });
  assert.throws(() => provider.getToken({ audience: AUD, signal: ac().signal, assertCurrent: () => 1 }), { code: 'A2A_WORKLOAD_TOKEN_INVALID' });
}));

test('assertCurrent returning a thenable is rejected as async authority', withDir((dir) => {
  writeRegular(dir, AUD, makeToken(), 0o400);
  const provider = createFileWorkloadTokenProvider({ tokenDirectory: dir, clock });
  const thenable = { then(resolve) { resolve(true); } };
  assert.throws(() => provider.getToken({ audience: AUD, signal: ac().signal, assertCurrent: () => thenable }), { code: 'A2A_WORKLOAD_TOKEN_INVALID' });
}));

test('assertCurrent returning a resolved Promise is rejected as async authority', withDir((dir) => {
  writeRegular(dir, AUD, makeToken(), 0o400);
  const provider = createFileWorkloadTokenProvider({ tokenDirectory: dir, clock });
  assert.throws(() => provider.getToken({ audience: AUD, signal: ac().signal, assertCurrent: () => Promise.resolve(true) }), { code: 'A2A_WORKLOAD_TOKEN_INVALID' });
}));

test('assertCurrent returning a rejected Promise is rejected and causes no unhandled rejection', async () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'a2a-tok-'));
  try {
    writeRegular(dir, AUD, makeToken(), 0o400);
    const provider = createFileWorkloadTokenProvider({ tokenDirectory: dir, clock });
    let unhandled = null;
    const handler = (err) => { unhandled = err; };
    process.once('unhandledRejection', handler);
    assert.throws(() => provider.getToken({ audience: AUD, signal: ac().signal, assertCurrent: () => Promise.reject(new Error('boom')) }), { code: 'A2A_WORKLOAD_TOKEN_INVALID' });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 10));
    process.removeListener('unhandledRejection', handler);
    assert.equal(unhandled, null, 'rejected promise was left unhandled');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- reentrant request mutation -------------------------------------------

test('assertCurrent mutating request.audience is rejected by post-callback re-check', withDir((dir) => {
  writeRegular(dir, AUD, makeToken(), 0o400);
  const provider = createFileWorkloadTokenProvider({ tokenDirectory: dir, clock });
  const request = {
    audience: AUD,
    signal: ac().signal,
    assertCurrent() { request.audience = 'a2a-task-sink'; return true; },
  };
  assert.throws(() => provider.getToken(request), { code: 'A2A_WORKLOAD_TOKEN_INVALID' });
}));

test('assertCurrent mutating request.signal is rejected', withDir((dir) => {
  writeRegular(dir, AUD, makeToken(), 0o400);
  const provider = createFileWorkloadTokenProvider({ tokenDirectory: dir, clock });
  const c1 = ac();
  const c2 = ac();
  const request = {
    audience: AUD,
    signal: c1.signal,
    assertCurrent() { request.signal = c2.signal; return true; },
  };
  assert.throws(() => provider.getToken(request), { code: 'A2A_WORKLOAD_TOKEN_INVALID' });
}));

test('assertCurrent mutating request.assertCurrent is rejected', withDir((dir) => {
  writeRegular(dir, AUD, makeToken(), 0o400);
  const provider = createFileWorkloadTokenProvider({ tokenDirectory: dir, clock });
  const request = {
    audience: AUD,
    signal: ac().signal,
    assertCurrent() { request.assertCurrent = ok; return true; },
  };
  assert.throws(() => provider.getToken(request), { code: 'A2A_WORKLOAD_TOKEN_INVALID' });
}));

test('a stable request is accepted (mutation guard does not false-positive)', withDir((dir) => {
  writeRegular(dir, AUD, makeToken(), 0o400);
  const provider = createFileWorkloadTokenProvider({ tokenDirectory: dir, clock });
  let calls = 0;
  const request = {
    audience: AUD,
    signal: ac().signal,
    assertCurrent() { calls += 1; return true; },
  };
  assert.equal(provider.getToken(request), makeToken());
  // guard runs before fs, after fs, and before return → at least 3 authority calls
  assert.ok(calls >= 3, `expected >=3 assertCurrent calls, got ${calls}`);
}));

// ---- root / inode drift ----------------------------------------------------

test('root replaced (new inode at same path) is rejected as drift', withDir((dir) => {
  writeRegular(dir, AUD, makeToken(), 0o400);
  const provider = createFileWorkloadTokenProvider({ tokenDirectory: dir, clock });
  // replace the directory with a fresh one at the same path (new inode)
  const staging = mkdtempSync(join(os.tmpdir(), 'a2a-tok-'));
  rmSync(dir, { recursive: true, force: true });
  renameSync(staging, dir);
  writeRegular(dir, AUD, makeToken(), 0o400);
  assert.throws(() => provider.getToken({ audience: AUD, signal: ac().signal, assertCurrent: ok }), { code: 'A2A_WORKLOAD_TOKEN_INVALID' });
}));

test('root deleted is rejected as drift', withDir((dir) => {
  writeRegular(dir, AUD, makeToken(), 0o400);
  const provider = createFileWorkloadTokenProvider({ tokenDirectory: dir, clock });
  rmSync(dir, { recursive: true, force: true });
  assert.throws(() => provider.getToken({ audience: AUD, signal: ac().signal, assertCurrent: ok }), { code: 'A2A_WORKLOAD_TOKEN_INVALID' });
}));

test('root replaced by a symlink is rejected as drift', withDir((dir) => {
  writeRegular(dir, AUD, makeToken(), 0o400);
  const provider = createFileWorkloadTokenProvider({ tokenDirectory: dir, clock });
  const realdir = mkdtempSync(join(os.tmpdir(), 'a2a-tok-'));
  rmSync(dir, { recursive: true, force: true });
  symlinkSync(realdir, dir); // root path is now a symlink, not the pinned dir
  assert.throws(() => provider.getToken({ audience: AUD, signal: ac().signal, assertCurrent: ok }), { code: 'A2A_WORKLOAD_TOKEN_INVALID' });
}));

test('a token file replaced between calls is re-read from the new inode', withDir((dir) => {
  const a = makeToken({ extra: { v: 1 } });
  const b = makeToken({ extra: { v: 2 } });
  const p = writeRegular(dir, AUD, a, 0o400);
  const provider = createFileWorkloadTokenProvider({ tokenDirectory: dir, clock });
  assert.equal(provider.getToken({ audience: AUD, signal: ac().signal, assertCurrent: ok }), a);
  rmSync(p); // new inode on recreate
  writeRegular(dir, AUD, b, 0o400);
  assert.equal(provider.getToken({ audience: AUD, signal: ac().signal, assertCurrent: ok }), b);
}));

test('token file swapped between read and final return is rejected by verifyPinned', withDir((dir) => {
  const a = makeToken({ extra: { v: 1 } });
  const b = makeToken({ extra: { v: 2 } });
  const p = writeRegular(dir, AUD, a, 0o400);
  const provider = createFileWorkloadTokenProvider({ tokenDirectory: dir, clock });
  // assertCurrent swaps the token file during the final pre-return guard, after
  // the read but before verifyPinned runs; verifyPinned re-lstats the path and
  // detects the new inode.
  let pass = 0;
  const request = {
    audience: AUD,
    signal: ac().signal,
    assertCurrent() {
      pass += 1;
      // On the 3rd guard call (final pre-return authority), swap the file so the
      // subsequent verifyPinned sees a different inode.
      if (pass === 3) {
        rmSync(p);
        writeRegular(dir, AUD, b, 0o400);
      }
      return true;
    },
  };
  assert.throws(() => provider.getToken(request), { code: 'A2A_WORKLOAD_TOKEN_INVALID' });
}));
