/** Tests for GitHub ref resolution. No internet; controlled fetch transport. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveGithubCommit } from '../src/skill-github-ref.mjs';

const COMMIT_SHA = 'a'.repeat(40);
const PEELED_SHA = 'b'.repeat(40);
const TAG_SHA = 'c'.repeat(40);
const HEADS_SHA = 'd'.repeat(40);
const trueAuthority = () => true;

for (const target of ['REST', 'Git']) test(`${target} body timeout uses an independent request signal and never waits on cancel`, async t => {
  const timers = [], urls = [], user = new AbortController();
  t.mock.method(AbortSignal, 'timeout', ms => {
    assert.equal(ms, 20000); const timer = new AbortController(); timers.push(timer); return timer.signal;
  });
  const fetchImpl = async url => {
    urls.push(url); const rest = url.startsWith('https://api.github.com');
    if ((target === 'REST' && rest) || (target === 'Git' && !rest)) return { ok: true, headers: new Headers(),
      body: { getReader() { return { read() { timers.at(-1).abort(new DOMException('deadline', 'TimeoutError')); return new Promise(() => {}); },
        cancel: () => new Promise(() => {}), releaseLock() {} }; } } };
    return rest ? new Response('', { status: 429 }) : new Response(buildAdvertisement([[HEADS_SHA, 'refs/heads/main']]));
  };
  const pending = resolveGithubCommit({ fetchImpl, owner: 'o', repository: 'r', ref: 'main', signal: user.signal, assertCurrent: trueAuthority });
  if (target === 'REST') assert.equal(await pending, HEADS_SHA);
  else await assert.rejects(pending, { code: 'skill_github_ref_invalid' });
  assert.equal(timers.length, 2); assert.equal(urls.length, 2); assert.equal(user.signal.aborted, false);
});

test('authority loss after a response disposes its body without a fallback request', async () => {
  let active = true, calls = 0, canceled = 0;
  await assert.rejects(resolveGithubCommit({ owner: 'o', repository: 'r', ref: 'main', signal: new AbortController().signal,
    assertCurrent: () => active, fetchImpl: async () => { calls++; active = false;
      return { ok: true, body: { cancel() { canceled++; return new Promise(() => {}); } } }; } }), { code: 'skill_github_authority_lost' });
  assert.equal(calls, 1); assert.equal(canceled, 1);
});

test('synchronous cancellation inside authority cannot dispatch a request or return an exact SHA', async () => {
  for (const ref of ['main', COMMIT_SHA]) {
    const controller = new AbortController(); let calls = 0;
    await assert.rejects(resolveGithubCommit({ owner: 'o', repository: 'r', ref, signal: controller.signal,
      assertCurrent() { controller.abort(Error('retired')); return true; }, fetchImpl: async () => { calls++; } }), /retired/);
    assert.equal(calls, 0);
  }
});

test('extra flush and high-bit length bytes are invalid packet framing', async () => {
  const valid = buildAdvertisement([[HEADS_SHA, 'refs/heads/main']]), high = Buffer.from(valid); high[0] |= 0x80;
  for (const bytes of [Buffer.concat([valid, Buffer.from('0000')]), high])
    await assert.rejects(resolveGithubCommit({ owner: 'o', repository: 'r', ref: 'main', ...{ signal: new AbortController().signal, assertCurrent: trueAuthority },
      fetchImpl: async url => url.startsWith('https://api.github.com') ? new Response('', { status: 429 }) : new Response(bytes) }),
    { code: 'skill_github_ref_invalid' });
});

function jsonResponse(status, body) {
  const text = JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status,
    headers: { get: n => n === 'content-length' ? String(Buffer.byteLength(text)) : null },
    body: { getReader() { const b = Buffer.from(text); let d = false; return {
      read() { if (d) return Promise.resolve({ done: true }); d = true; return Promise.resolve({ value: b, done: false }); },
      cancel() { return Promise.resolve(); }, releaseLock() {} }; } } };
}
function rawResponse(status, buf) {
  return { ok: status >= 200 && status < 300, status,
    headers: { get: n => n === 'content-length' ? String(buf.byteLength) : null },
    body: { getReader() { let d = false; return {
      read() { if (d) return Promise.resolve({ done: true }); d = true; return Promise.resolve({ value: buf, done: false }); },
      cancel() { return Promise.resolve(); }, releaseLock() {} }; } } };
}
/** Hanging reader: returns a body whose read() never resolves.
 *  The hangingReadDelay param, if set, will call readCb for each read() call. */
function hangingResponse(status = 200, contentLength = null) {
  return { ok: true, status,
    headers: { get: n => n === 'content-length' ? contentLength : null },
    body: { getReader: () => ({ read: () => new Promise(() => {}), cancel: () => Promise.resolve(), releaseLock: () => {} }) } };
}
function errorResponse(status) { return { ok: false, status, headers: { get: () => null },
  body: { getReader() { let d = false; return { read() { if (d) return Promise.resolve({ done: true }); d = true; return Promise.resolve({ value: Buffer.from('e'), done: false }); }, cancel() { return Promise.resolve(); }, releaseLock() {} }; } } }; }
function makeTransport(routes) {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url: String(url), redirect: init?.redirect, headers: init?.headers });
    const r = routes[String(url)]; if (typeof r === 'function') return r(); return r || errorResponse(404); };
  return { fetchImpl, calls };
}

/** Build a proper Git pkt-line advertisement. */
function buildAdvertisement(entries) {
  const parts = [];
  const svc = '# service=git-upload-pack\n';
  parts.push(Buffer.from(`${(svc.length + 4).toString(16).padStart(4, '0')}${svc}`));
  parts.push(Buffer.from('0000')); // flush after service header
  for (const [sha, ref] of entries) {
    const line = `${sha} ${ref}\n`;
    parts.push(Buffer.from(`${(line.length + 4).toString(16).padStart(4, '0')}${line}`));
  }
  parts.push(Buffer.from('0000')); // final flush
  return Buffer.concat(parts);
}

/** Build raw bytes for malformed pkt-line tests. */
function rawAd(bytes) { return rawResponse(200, Buffer.from(bytes)); }

// ---- SHA shortcut with guard ------------------------------------------------

test('exact 40-hex SHA: guard checked before return (no fetch)', async () => {
  const { fetchImpl, calls } = makeTransport({});
  const sha = await resolveGithubCommit({ fetchImpl, owner: 'o', repository: 'r', ref: COMMIT_SHA,
    signal: new AbortController().signal, assertCurrent: trueAuthority });
  assert.equal(sha, COMMIT_SHA); assert.equal(calls.length, 0);
});

test('exact SHA: assertCurrent=false rejects', () => {
  assert.rejects(() => resolveGithubCommit({ fetchImpl: async () => ({}), owner: 'o', repository: 'r', ref: COMMIT_SHA,
    signal: new AbortController().signal, assertCurrent: () => false }), { code: 'skill_github_authority_lost' });
});

test('exact SHA: pre-aborted signal rejects', () => {
  const c = new AbortController(); c.abort(new Error('pre-cancel'));
  assert.rejects(() => resolveGithubCommit({ fetchImpl: async () => ({}), owner: 'o', repository: 'r', ref: COMMIT_SHA,
    signal: c.signal, assertCurrent: trueAuthority }), { message: 'pre-cancel' });
});

test('uppercase SHA returns lowercase after guard', async () => {
  assert.equal(await resolveGithubCommit({ fetchImpl: async () => ({}), owner: 'o', repository: 'r', ref: 'A'.repeat(40),
    signal: new AbortController().signal, assertCurrent: trueAuthority }), 'a'.repeat(40));
});

// ---- REST commit resolution -------------------------------------------------

test('REST commits returns SHA, redirect:error, no Authorization', async () => {
  const routes = { 'https://api.github.com/repos/o/r/commits/main': () => jsonResponse(200, { sha: COMMIT_SHA }) };
  const { fetchImpl, calls } = makeTransport(routes);
  const sha = await resolveGithubCommit({ fetchImpl, owner: 'o', repository: 'r', ref: 'main',
    signal: new AbortController().signal, assertCurrent: trueAuthority });
  assert.equal(sha, COMMIT_SHA);
  assert.equal(calls[0].redirect, 'error');
  assert.equal(calls[0].headers.Authorization, undefined);
});

test('REST slash-in-ref encoded', async () => {
  const routes = { 'https://api.github.com/repos/o/r/commits/feature%2Fbranch': () => jsonResponse(200, { sha: COMMIT_SHA }) };
  const { fetchImpl } = makeTransport(routes);
  assert.equal(await resolveGithubCommit({ fetchImpl, owner: 'o', repository: 'r', ref: 'feature/branch',
    signal: new AbortController().signal, assertCurrent: trueAuthority }), COMMIT_SHA);
});

// ---- REST failure → Git fallback -------------------------------------------

test('REST 429 → fallback peeled tag', async () => {
  const ad = buildAdvertisement([[PEELED_SHA, 'refs/tags/v1.0^{}'], [TAG_SHA, 'refs/tags/v1.0'], [HEADS_SHA, 'refs/heads/v1.0']]);
  const routes = { 'https://api.github.com/repos/o/r/commits/v1.0': () => errorResponse(429),
    'https://github.com/o/r.git/info/refs?service=git-upload-pack': () => rawResponse(200, ad) };
  const { fetchImpl, calls } = makeTransport(routes);
  assert.equal(await resolveGithubCommit({ fetchImpl, owner: 'o', repository: 'r', ref: 'v1.0',
    signal: new AbortController().signal, assertCurrent: trueAuthority }), PEELED_SHA);
  assert.equal(calls.length, 2);
});

test('REST 500 → fallback branch wins over raw tag', async () => {
  const ad = buildAdvertisement([[TAG_SHA, 'refs/tags/v1.0'], [HEADS_SHA, 'refs/heads/v1.0']]);
  const routes = { 'https://api.github.com/repos/o/r/commits/v1.0': () => errorResponse(500),
    'https://github.com/o/r.git/info/refs?service=git-upload-pack': () => rawResponse(200, ad) };
  const { fetchImpl } = makeTransport(routes);
  assert.equal(await resolveGithubCommit({ fetchImpl, owner: 'o', repository: 'r', ref: 'v1.0',
    signal: new AbortController().signal, assertCurrent: trueAuthority }), HEADS_SHA);
});

test('REST invalid JSON → fallback raw tag', async () => {
  const ad = buildAdvertisement([[TAG_SHA, 'refs/tags/v1.0']]);
  const routes = { 'https://api.github.com/repos/o/r/commits/v1.0': () => rawResponse(200, Buffer.from('not json')),
    'https://github.com/o/r.git/info/refs?service=git-upload-pack': () => rawResponse(200, ad) };
  const { fetchImpl } = makeTransport(routes);
  assert.equal(await resolveGithubCommit({ fetchImpl, owner: 'o', repository: 'r', ref: 'v1.0',
    signal: new AbortController().signal, assertCurrent: trueAuthority }), TAG_SHA);
});

test('REST missing/invalid SHA → fallback', async () => {
  for (const restBody of [{ not_sha: 'x' }, { sha: 'short' }]) {
    const ad = buildAdvertisement([[HEADS_SHA, 'refs/heads/main']]);
    const routes = { 'https://api.github.com/repos/o/r/commits/main': () => jsonResponse(200, restBody),
      'https://github.com/o/r.git/info/refs?service=git-upload-pack': () => rawResponse(200, ad) };
    const { fetchImpl } = makeTransport(routes);
    assert.equal(await resolveGithubCommit({ fetchImpl, owner: 'o', repository: 'r', ref: 'main',
      signal: new AbortController().signal, assertCurrent: trueAuthority }), HEADS_SHA);
  }
});

test('REST transport failure → fallback', async () => {
  const ad = buildAdvertisement([[HEADS_SHA, 'refs/heads/main']]);
  const routes = { 'https://api.github.com/repos/o/r/commits/main': () => { throw new Error('network'); },
    'https://github.com/o/r.git/info/refs?service=git-upload-pack': () => rawResponse(200, ad) };
  const { fetchImpl } = makeTransport(routes);
  assert.equal(await resolveGithubCommit({ fetchImpl, owner: 'o', repository: 'r', ref: 'main',
    signal: new AbortController().signal, assertCurrent: trueAuthority }), HEADS_SHA);
});

test('REST Content-Length over limit → fallback', async () => {
  const ad = buildAdvertisement([[HEADS_SHA, 'refs/heads/main']]);
  const routes = { 'https://api.github.com/repos/o/r/commits/main': () => ({
      ok: true, status: 200,
      headers: { get: () => String(2 * 1024 * 1024 + 1) },
      body: { getReader: () => ({ read: () => Promise.resolve({ done: true }), cancel: () => Promise.resolve(), releaseLock: () => {} }) },
    }),
    'https://github.com/o/r.git/info/refs?service=git-upload-pack': () => rawResponse(200, ad) };
  const { fetchImpl } = makeTransport(routes);
  assert.equal(await resolveGithubCommit({ fetchImpl, owner: 'o', repository: 'r', ref: 'main',
    signal: new AbortController().signal, assertCurrent: trueAuthority }), HEADS_SHA);
});

// ---- REST hanging body → timeout → fallback --------------------------------

test('REST hanging body observes user cancellation', async () => {
  const ad = buildAdvertisement([[HEADS_SHA, 'refs/heads/main']]);
  const routes = {
    'https://api.github.com/repos/o/r/commits/main': () => hangingResponse(200),
    'https://github.com/o/r.git/info/refs?service=git-upload-pack': () => rawResponse(200, ad),
  };
  const { fetchImpl } = makeTransport(routes);
  // The 20s timeout would take too long; use a manual timeout signal
  const c = new AbortController();
  setTimeout(() => c.abort(new Error('test-timeout')), 50);
  // The user signal abort will propagate (not a timeout), so this should reject.
  // But we can't test the real 20s timeout. Instead, verify that a hanging body
  // + user cancel rejects (not fallback):
  await assert.rejects(() => resolveGithubCommit({ fetchImpl, owner: 'o', repository: 'r', ref: 'main',
    signal: c.signal, assertCurrent: trueAuthority }), { message: 'test-timeout' });
});

// ---- User cancel / authority loss never falls back -------------------------

test('user cancel during REST fetch does not fall back', async () => {
  const c = new AbortController();
  const routes = { 'https://api.github.com/repos/o/r/commits/main': () => { c.abort(new Error('user-cancel')); return errorResponse(429); },
    'https://github.com/o/r.git/info/refs?service=git-upload-pack': () => rawResponse(200, buildAdvertisement([[HEADS_SHA, 'refs/heads/main']])) };
  const { fetchImpl } = makeTransport(routes);
  await assert.rejects(() => resolveGithubCommit({ fetchImpl, owner: 'o', repository: 'r', ref: 'main',
    signal: c.signal, assertCurrent: trueAuthority }), { message: 'user-cancel' });
});

test('authority loss during REST fetch does not fall back', async () => {
  let callCount = 0;
  const fetchImpl = async () => { callCount++; return errorResponse(429); };
  const assertCurrent = () => { if (callCount >= 1) throw new Error('auth-lost'); return true; };
  await assert.rejects(() => resolveGithubCommit({ fetchImpl, owner: 'o', repository: 'r', ref: 'main',
    signal: new AbortController().signal, assertCurrent }), { message: 'auth-lost' });
  assert.equal(callCount, 1, 'Git ad was not fetched after authority loss');
});

test('authority loss during REST read does not fall back', async () => {
  let readCount = 0;
  const fetchImpl = async () => ({ ok: true, status: 200, headers: { get: () => null },
    body: { getReader: () => ({ read: () => { readCount++; if (readCount >= 1) throw new Error('auth-lost-read'); return Promise.resolve({ done: true }); }, cancel: () => Promise.resolve(), releaseLock: () => {} }) } });
  const assertCurrent = () => { if (readCount >= 1) throw new Error('auth-lost'); return true; };
  await assert.rejects(() => resolveGithubCommit({ fetchImpl, owner: 'o', repository: 'r', ref: 'main',
    signal: new AbortController().signal, assertCurrent }), { message: 'auth-lost' });
});

// ---- Hanging fetch / read / cancel -----------------------------------------

test('hanging fetch interrupted by user abort', async () => {
  const c = new AbortController();
  const fetchImpl = () => new Promise(() => {});
  setTimeout(() => c.abort(new Error('user-timeout')), 10);
  await assert.rejects(() => resolveGithubCommit({ fetchImpl, owner: 'o', repository: 'r', ref: 'main',
    signal: c.signal, assertCurrent: trueAuthority }), { message: 'user-timeout' });
});

test('hanging reader.read interrupted by user abort', async () => {
  const c = new AbortController();
  const fetchImpl = () => ({ ok: true, status: 200, headers: { get: () => null },
    body: { getReader: () => ({ read: () => new Promise(() => {}), cancel: () => Promise.resolve(), releaseLock: () => {} }) } });
  setTimeout(() => c.abort(new Error('read-timeout')), 10);
  await assert.rejects(() => resolveGithubCommit({ fetchImpl, owner: 'o', repository: 'r', ref: 'main',
    signal: c.signal, assertCurrent: trueAuthority }), { message: 'read-timeout' });
});

test('non-cooperative cancel does not hang', async () => {
  const c = new AbortController();
  const fetchImpl = () => ({ ok: true, status: 200, headers: { get: () => null },
    body: { getReader: () => ({ read: () => new Promise(() => {}), cancel: () => new Promise(() => {}), releaseLock: () => {} }) } });
  setTimeout(() => c.abort(new Error('cancel-stuck')), 10);
  await assert.rejects(() => resolveGithubCommit({ fetchImpl, owner: 'o', repository: 'r', ref: 'main',
    signal: c.signal, assertCurrent: trueAuthority }), { message: 'cancel-stuck' });
});

// ---- Ref / owner / repo validation ------------------------------------------

test('invalid refs rejected', () => {
  for (const ref of ['', ' ', '/main', 'a/../b', 'a'.repeat(129), 'main;rm', 'main\0', 'main\n', 'main\x7f', 'main|cat', '分支']) {
    assert.rejects(() => resolveGithubCommit({ fetchImpl: async () => ({}), owner: 'o', repository: 'r', ref,
      signal: new AbortController().signal, assertCurrent: trueAuthority }), { code: 'skill_github_ref_invalid' }, `ref: ${JSON.stringify(ref)}`);
  }
});

test('invalid owner/repo rejected', () => {
  for (const owner of ['', 'a/b', '..', 'a b', 'a'.repeat(101)]) {
    assert.rejects(() => resolveGithubCommit({ fetchImpl: async () => ({}), owner, repository: 'r', ref: 'main',
      signal: new AbortController().signal, assertCurrent: trueAuthority }), { code: 'skill_github_url_invalid' }, `owner: ${JSON.stringify(owner)}`);
  }
  for (const repo of ['', 'a/b', '..', 'a b']) {
    assert.rejects(() => resolveGithubCommit({ fetchImpl: async () => ({}), owner: 'o', repository: repo, ref: 'main',
      signal: new AbortController().signal, assertCurrent: trueAuthority }), { code: 'skill_github_url_invalid' }, `repo: ${JSON.stringify(repo)}`);
  }
});

// ---- Missing signal / assertCurrent / fetchImpl -----------------------------

test('missing signal, assertCurrent, fetchImpl each rejected', () => {
  assert.rejects(() => resolveGithubCommit({ fetchImpl: async () => ({}), owner: 'o', repository: 'r', ref: 'main', assertCurrent: trueAuthority }), { code: 'skill_github_signal_required' });
  assert.rejects(() => resolveGithubCommit({ fetchImpl: async () => ({}), owner: 'o', repository: 'r', ref: 'main', signal: new AbortController().signal }), { code: 'skill_github_authority_required' });
  assert.rejects(() => resolveGithubCommit({ owner: 'o', repository: 'r', ref: 'main', signal: new AbortController().signal, assertCurrent: trueAuthority }), { code: 'skill_github_fetch_required' });
});

test('assertCurrent thenable rejected', () => {
  assert.rejects(() => resolveGithubCommit({ fetchImpl: async () => ({}), owner: 'o', repository: 'r', ref: 'main',
    signal: new AbortController().signal, assertCurrent: () => Promise.resolve(true) }), { code: 'skill_github_authority_lost' });
});

// ---- Both fail → error -----------------------------------------------------

test('both REST and Git ad fail → skill_github_ref_invalid', async () => {
  const routes = { 'https://api.github.com/repos/o/r/commits/main': () => errorResponse(404),
    'https://github.com/o/r.git/info/refs?service=git-upload-pack': () => errorResponse(404) };
  const { fetchImpl } = makeTransport(routes);
  await assert.rejects(() => resolveGithubCommit({ fetchImpl, owner: 'o', repository: 'r', ref: 'main',
    signal: new AbortController().signal, assertCurrent: trueAuthority }), { code: 'skill_github_ref_invalid' });
});

test('Git ad missing ref → rejected', async () => {
  const ad = buildAdvertisement([[HEADS_SHA, 'refs/heads/other']]);
  const routes = { 'https://api.github.com/repos/o/r/commits/main': () => errorResponse(404),
    'https://github.com/o/r.git/info/refs?service=git-upload-pack': () => rawResponse(200, ad) };
  const { fetchImpl } = makeTransport(routes);
  await assert.rejects(() => resolveGithubCommit({ fetchImpl, owner: 'o', repository: 'r', ref: 'main',
    signal: new AbortController().signal, assertCurrent: trueAuthority }), { code: 'skill_github_ref_invalid' });
});

// ---- pkt-line malformed input rejected -------------------------------------

test('pkt-line 0001 (len=1, too short) → rejected', async () => {
  const routes = { 'https://api.github.com/repos/o/r/commits/main': () => errorResponse(404),
    'https://github.com/o/r.git/info/refs?service=git-upload-pack': () => rawAd('001e# service=git-upload-pack\n00000001') };
  const { fetchImpl } = makeTransport(routes);
  await assert.rejects(() => resolveGithubCommit({ fetchImpl, owner: 'o', repository: 'r', ref: 'main',
    signal: new AbortController().signal, assertCurrent: trueAuthority }), { code: 'skill_github_ref_invalid' });
});

test('pkt-line 0002/0003 (too short) → rejected', async () => {
  for (const len of ['0002', '0003']) {
    const routes = { 'https://api.github.com/repos/o/r/commits/main': () => errorResponse(404),
      'https://github.com/o/r.git/info/refs?service=git-upload-pack': () => rawAd(`001e# service=git-upload-pack\n0000${len}x`) };
    const { fetchImpl } = makeTransport(routes);
    await assert.rejects(() => resolveGithubCommit({ fetchImpl, owner: 'o', repository: 'r', ref: 'main',
      signal: new AbortController().signal, assertCurrent: trueAuthority }), { code: 'skill_github_ref_invalid' });
  }
});

test('pkt-line 000g (non-hex) → rejected', async () => {
  const routes = { 'https://api.github.com/repos/o/r/commits/main': () => errorResponse(404),
    'https://github.com/o/r.git/info/refs?service=git-upload-pack': () => rawAd('001e# service=git-upload-pack\n0000000g') };
  const { fetchImpl } = makeTransport(routes);
  await assert.rejects(() => resolveGithubCommit({ fetchImpl, owner: 'o', repository: 'r', ref: 'main',
    signal: new AbortController().signal, assertCurrent: trueAuthority }), { code: 'skill_github_ref_invalid' });
});

test('pkt-line missing final flush → rejected', async () => {
  // Service header + flush, but no final flush
  const ad = Buffer.from('001e# service=git-upload-pack\n0000' + '003d' + HEADS_SHA + ' refs/heads/main\n');
  const routes = { 'https://api.github.com/repos/o/r/commits/main': () => errorResponse(404),
    'https://github.com/o/r.git/info/refs?service=git-upload-pack': () => rawResponse(200, ad) };
  const { fetchImpl } = makeTransport(routes);
  await assert.rejects(() => resolveGithubCommit({ fetchImpl, owner: 'o', repository: 'r', ref: 'main',
    signal: new AbortController().signal, assertCurrent: trueAuthority }), { code: 'skill_github_ref_invalid' });
});

test('pkt-line trailing garbage after final flush → rejected', async () => {
  const ad = Buffer.concat([buildAdvertisement([[HEADS_SHA, 'refs/heads/main']]), Buffer.from('00')]);
  const routes = { 'https://api.github.com/repos/o/r/commits/main': () => errorResponse(404),
    'https://github.com/o/r.git/info/refs?service=git-upload-pack': () => rawResponse(200, ad) };
  const { fetchImpl } = makeTransport(routes);
  await assert.rejects(() => resolveGithubCommit({ fetchImpl, owner: 'o', repository: 'r', ref: 'main',
    signal: new AbortController().signal, assertCurrent: trueAuthority }), { code: 'skill_github_ref_invalid' });
});

test('pkt-line data before service flush → rejected', async () => {
  // Service header without flush, then a ref line
  const line = `${HEADS_SHA} refs/heads/main\n`;
  const ad = Buffer.from(`001e# service=git-upload-pack\n${(line.length + 4).toString(16).padStart(4, '0')}${line}0000`);
  const routes = { 'https://api.github.com/repos/o/r/commits/main': () => errorResponse(404),
    'https://github.com/o/r.git/info/refs?service=git-upload-pack': () => rawResponse(200, ad) };
  const { fetchImpl } = makeTransport(routes);
  await assert.rejects(() => resolveGithubCommit({ fetchImpl, owner: 'o', repository: 'r', ref: 'main',
    signal: new AbortController().signal, assertCurrent: trueAuthority }), { code: 'skill_github_ref_invalid' });
});

test('pkt-line flush before service header → rejected', async () => {
  const ad = Buffer.from('0000001e# service=git-upload-pack\n0000' + '003d' + HEADS_SHA + ' refs/heads/main\n' + '0000');
  const routes = { 'https://api.github.com/repos/o/r/commits/main': () => errorResponse(404),
    'https://github.com/o/r.git/info/refs?service=git-upload-pack': () => rawResponse(200, ad) };
  const { fetchImpl } = makeTransport(routes);
  await assert.rejects(() => resolveGithubCommit({ fetchImpl, owner: 'o', repository: 'r', ref: 'main',
    signal: new AbortController().signal, assertCurrent: trueAuthority }), { code: 'skill_github_ref_invalid' });
});

test('pkt-line post-service-header comment → rejected', async () => {
  const comment = '# unexpected\n';
  const ad = Buffer.from(`001e# service=git-upload-pack\n0000${(comment.length + 4).toString(16).padStart(4, '0')}${comment}0000`);
  const routes = { 'https://api.github.com/repos/o/r/commits/main': () => errorResponse(404),
    'https://github.com/o/r.git/info/refs?service=git-upload-pack': () => rawResponse(200, ad) };
  const { fetchImpl } = makeTransport(routes);
  await assert.rejects(() => resolveGithubCommit({ fetchImpl, owner: 'o', repository: 'r', ref: 'main',
    signal: new AbortController().signal, assertCurrent: trueAuthority }), { code: 'skill_github_ref_invalid' });
});

test('pkt-line duplicate ref → rejected', async () => {
  const line = `${HEADS_SHA} refs/heads/main\n`;
  const ad = Buffer.from(`001e# service=git-upload-pack\n0000${(line.length + 4).toString(16).padStart(4, '0')}${line}${(line.length + 4).toString(16).padStart(4, '0')}${line}0000`);
  const routes = { 'https://api.github.com/repos/o/r/commits/main': () => errorResponse(404),
    'https://github.com/o/r.git/info/refs?service=git-upload-pack': () => rawResponse(200, ad) };
  const { fetchImpl } = makeTransport(routes);
  await assert.rejects(() => resolveGithubCommit({ fetchImpl, owner: 'o', repository: 'r', ref: 'main',
    signal: new AbortController().signal, assertCurrent: trueAuthority }), { code: 'skill_github_ref_invalid' });
});

test('Git ad oversize Content-Length → rejected', async () => {
  const routes = { 'https://api.github.com/repos/o/r/commits/main': () => errorResponse(404),
    'https://github.com/o/r.git/info/refs?service=git-upload-pack': () => ({
      ok: true, status: 200, headers: { get: () => String(5 * 1024 * 1024 + 1) },
      body: { getReader: () => ({ read: () => Promise.resolve({ done: true }), cancel: () => Promise.resolve(), releaseLock: () => {} }) },
    }) };
  const { fetchImpl } = makeTransport(routes);
  await assert.rejects(() => resolveGithubCommit({ fetchImpl, owner: 'o', repository: 'r', ref: 'main',
    signal: new AbortController().signal, assertCurrent: trueAuthority }), { code: 'skill_github_response_limit' });
});

// ---- Peeled tag priority ---------------------------------------------------

test('peeled tag > branch > raw tag (all present)', async () => {
  const ad = buildAdvertisement([[TAG_SHA, 'refs/tags/v1.0'], [HEADS_SHA, 'refs/heads/v1.0'], [PEELED_SHA, 'refs/tags/v1.0^{}']]);
  const routes = { 'https://api.github.com/repos/o/r/commits/v1.0': () => errorResponse(404),
    'https://github.com/o/r.git/info/refs?service=git-upload-pack': () => rawResponse(200, ad) };
  const { fetchImpl } = makeTransport(routes);
  assert.equal(await resolveGithubCommit({ fetchImpl, owner: 'o', repository: 'r', ref: 'v1.0',
    signal: new AbortController().signal, assertCurrent: trueAuthority }), PEELED_SHA);
});

// ---- redirect policy -------------------------------------------------------

test('redirect:error on every request', async () => {
  const routes = {
    'https://api.github.com/repos/o/r/commits/main': () => jsonResponse(200, { sha: COMMIT_SHA }),
    'https://github.com/o/r.git/info/refs?service=git-upload-pack': () => rawResponse(200, buildAdvertisement([[HEADS_SHA, 'refs/heads/main']])),
  };
  const { fetchImpl, calls } = makeTransport(routes);
  await resolveGithubCommit({ fetchImpl, owner: 'o', repository: 'r', ref: 'main',
    signal: new AbortController().signal, assertCurrent: trueAuthority });
  for (const c of calls) assert.equal(c.redirect, 'error');
});
