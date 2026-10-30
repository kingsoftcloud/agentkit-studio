// Synthetic JWTs and actual regular/projected files. No issuer/signature or
// atomic-openat claim; reentrant authority callbacks exercise observed drift.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFileWorkloadTokenProvider } from '../src/providers/native-a2a-workload-token.mjs';
const aud = 'a2a-registry', future = 2000000000, now = 1000000000000;
const jwt = (payload = { aud, exp: future }, suffix = '') => 'e30.' + Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload)).toString('base64url') + '.c2ln' + suffix;
const request = fields => ({ audience: aud, signal: new AbortController().signal, assertCurrent: () => true, ...fields });
function setup(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'a2a-tokens-'))), volume = join(root, 'volume'); mkdirSync(volume);
  const file = join(volume, aud + '.jwt');
  function put(path, value = jwt(), mode = 0o400) { writeFileSync(path + '.new', value, { mode }); chmodSync(path + '.new', mode); renameSync(path + '.new', path); }
  put(file); const provider = createFileWorkloadTokenProvider({ tokenDirectory: volume, clock: () => now });
  t.after(() => rmSync(root, { force: true, recursive: true })); return { root, volume, file, provider, put };
}
test('0400/0440 credentials rotate every call and public binding contains only a root digest', t => {
  const f = setup(t); assert.equal(f.provider.getToken(request()), jwt());
  const next = jwt({ aud: [aud, 'other'], exp: String(future), serial: 2 }); f.put(f.file, next, 0o440);
  assert.equal(f.provider.getToken(request()), next);
  assert.deepEqual(Object.keys(f.provider.binding).sort(), ['contract', 'tokenDirectoryDigest']);
  assert.equal(Object.isFrozen(f.provider), true); assert.doesNotMatch(JSON.stringify(f.provider.binding), /volume|e30\./u);
});
test('Kubernetes exact keys rotate generations, including a nested real generation inside the same volume', t => {
  const f = setup(t); unlinkSync(f.file); mkdirSync(join(f.volume, '..first')); mkdirSync(join(f.volume, 'generations'));
  mkdirSync(join(f.volume, 'generations', 'second')); f.put(join(f.volume, '..first', aud + '.jwt'));
  const next = jwt({ aud, exp: future, serial: 2 }); f.put(join(f.volume, 'generations', 'second', aud + '.jwt'), next);
  symlinkSync('..first', join(f.volume, '..data')); symlinkSync('..data/' + aud + '.jwt', f.file);
  assert.equal(f.provider.getToken(request()), jwt());
  symlinkSync('generations/second', join(f.volume, '..data-new')); renameSync(join(f.volume, '..data-new'), join(f.volume, '..data'));
  assert.equal(f.provider.getToken(request()), next);
});
test('ordinary key links, outside generations, symlinked generation ancestors and non-files are refused', t => {
  const f = setup(t), outside = join(f.root, 'outside'); mkdirSync(outside); f.put(join(outside, aud + '.jwt'));
  unlinkSync(f.file); symlinkSync(join(outside, aud + '.jwt'), f.file); assert.throws(() => f.provider.getToken(request()), { code: 'A2A_WORKLOAD_TOKEN_INVALID' });
  unlinkSync(f.file); symlinkSync('..data/' + aud + '.jwt', f.file); symlinkSync('../outside', join(f.volume, '..data'));
  assert.throws(() => f.provider.getToken(request()), { code: 'A2A_WORKLOAD_TOKEN_INVALID' });
  unlinkSync(join(f.volume, '..data')); symlinkSync(outside, join(f.volume, 'alias')); symlinkSync('alias', join(f.volume, '..data'));
  assert.throws(() => f.provider.getToken(request()), { code: 'A2A_WORKLOAD_TOKEN_INVALID' });
  unlinkSync(f.file); mkdirSync(f.file); assert.throws(() => f.provider.getToken(request()), { code: 'A2A_WORKLOAD_TOKEN_INVALID' });
  rmSync(f.file, { recursive: true }); execFileSync('/usr/bin/mkfifo', [f.file]);
  const start = Date.now(); assert.throws(() => f.provider.getToken(request()), { code: 'A2A_WORKLOAD_TOKEN_INVALID' });
  assert.ok(Date.now() - start < 1000, 'FIFO cannot block credential acquisition');
});
test('wrong permission bits, non-ASCII, empty, oversized and malformed claims are refused without secret paths or bytes', t => {
  const f = setup(t), variants = ['', Buffer.from([0xff]), 'x'.repeat(16385), 'e30.%%%.c2ln', 'e30.A.c2ln',
    jwt({ aud: 'wrong', exp: future }), jwt({ aud, exp: 1000000000 }), jwt({ aud, exp: 1.5 }), jwt({ aud, exp: '02000000000' }),
    jwt({ aud, exp: true }), jwt({ aud, exp: null }), jwt({ aud }), jwt([aud]), jwt({ aud, exp: future }, '\r\nsecret')];
  for (const value of variants) {
    f.put(f.file, value); assert.throws(() => f.provider.getToken(request()), error => {
      assert.equal(error.code, 'A2A_WORKLOAD_TOKEN_INVALID'); assert.equal(error.cause, undefined);
      assert.doesNotMatch(error.message, /secret|volume|a2a-registry|e30\./u); return true;
    });
  }
  for (const mode of [0o600, 0o644, 0o4400]) { f.put(f.file, jwt(), mode); assert.throws(() => f.provider.getToken(request())); }
});
test('false, missing, asynchronous, aborted or reentrant authority cannot release token bytes', async t => {
  const f = setup(t);
  for (const assertCurrent of [() => false, () => undefined, () => Promise.resolve(true), () => Promise.reject(Error('secret'))])
    assert.throws(() => f.provider.getToken(request({ assertCurrent })), { code: 'A2A_WORKLOAD_TOKEN_INVALID' });
  const abort = new AbortController(); abort.abort(Error('secret-abort-reason'));
  assert.throws(() => f.provider.getToken(request({ signal: abort.signal })), error => {
    assert.equal(error.name, 'AbortError'); assert.doesNotMatch(String(error), /secret-abort-reason/u); return true;
  });
  for (const mutation of [r => { r.audience = 'other'; }, r => { r.signal = new AbortController().signal; }, r => { r.assertCurrent = () => true; }]) {
    const r = request(); r.assertCurrent = () => { mutation(r); return true; }; assert.throws(() => f.provider.getToken(r));
  }
  await new Promise(resolve => setImmediate(resolve));
});
test('final authority cannot substitute already-read file or configured root and still release old credentials', t => {
  const f = setup(t); let guards = 0;
  assert.throws(() => f.provider.getToken(request({ assertCurrent: () => {
    if (++guards === 3) f.put(f.file, jwt({ aud, exp: future, serial: 99 })); return true;
  } })), { code: 'A2A_WORKLOAD_TOKEN_INVALID' });
  const configured = join(f.root, 'configured'); symlinkSync(f.volume, configured);
  const provider = createFileWorkloadTokenProvider({ tokenDirectory: configured, clock: () => now });
  const replacement = join(f.root, 'replacement'); mkdirSync(replacement); f.put(join(replacement, aud + '.jwt'));
  unlinkSync(configured); symlinkSync(replacement, configured); assert.throws(() => provider.getToken(request()));
  renameSync(f.volume, f.volume + '-old'); mkdirSync(f.volume); f.put(f.file); assert.throws(() => f.provider.getToken(request()));
});
test('integer JWT expiry preserves large JSON integers; invalid clocks fail closed', t => {
  const f = setup(t); const huge = jwt('{"aud":"a2a-registry","exp":9007199254740993}'); f.put(f.file, huge);
  assert.equal(f.provider.getToken(request()), huge);
  for (const clock of [() => NaN, () => -1, () => 1.5, () => Infinity]) {
    const provider = createFileWorkloadTokenProvider({ tokenDirectory: f.volume, clock }); assert.throws(() => provider.getToken(request()));
  }
});
