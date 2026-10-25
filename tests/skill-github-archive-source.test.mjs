import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createZip } from '../src/zip.mjs';
import { createGithubArchiveSkillSource } from '../src/skill-github-archive-source.mjs';

const commit = 'a'.repeat(40), options = () => ({ signal: new AbortController().signal, assertCurrent: () => true });
const manifest = name => `---\nname: ${name}\ndescription: Unicode 技能 😀\nversion: 1.2.3\n---\nInstructions`;
const zip = files => createZip(files.map(([path, data]) => ({ name: `repo-${commit}/${path}`, data })));

test('production Skill inspection accepts a Python ZIP64 archive and retains manifest and binary files', async () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/skill-zip64-reference.json', import.meta.url), 'utf8'))
    .cases.find(row => row.name === 'central-and-end-deflated');
  const source = createGithubArchiveSkillSource({ fetchImpl: async () => new Response(Buffer.from(fixture.archiveBase64, 'base64')) });
  const result = await source.inspect('https://github.com/o/r', { ...options(), ref: commit });
  assert.equal(result.candidates.length, 1); assert.equal(result.candidates[0].status, undefined);
  assert.equal(result.candidates[0].name, 'zip64');
  assert.equal(result.candidates[0].description, 'Reference archive');
  assert.deepEqual(result.candidates[0].files.map(file => ({ path: file.path, base64: Buffer.from(file.bytes).toString('base64') })), fixture.expected);
});

test('production inspection follows GitHub repository moves and orders Unicode candidates and files like Python', async () => {
  const first = '\ue000', last = '\u{10000}', archive = zip([
    [`${last}/SKILL.md`, manifest('same')], [`${first}/SKILL.md`, manifest('same')],
    [`${first}/${last}.txt`, 'later'], [`${first}/${first}.txt`, 'earlier']]), calls = [];
  const source = createGithubArchiveSkillSource({ fetchImpl: async (url, init) => {
    calls.push(url); assert.equal(init.redirect, 'manual'); assert.equal(init.headers.Authorization, undefined);
    if (url === 'https://api.github.com/repos/o/r/commits/main')
      return new Response('', { status: 301, headers: { location: '/repositories/123/commits/main' } });
    if (url === 'https://api.github.com/repositories/123/commits/main') return Response.json({ sha: commit });
    if (url === `https://codeload.github.com/o/r/zip/${commit}`)
      return new Response('', { status: 307, headers: { location: `/o/renamed/zip/${commit}` } });
    assert.equal(url, `https://codeload.github.com/o/renamed/zip/${commit}`); return new Response(archive);
  } });
  const result = await source.inspect('https://github.com/o/r', options());
  assert.equal(result.commit, commit); assert.equal(calls.length, 4);
  assert.deepEqual(result.candidates.map(value => value.path), [first, last]);
  assert.deepEqual(result.candidates[0].files.map(value => value.path), ['SKILL.md', `${first}.txt`, `${last}.txt`]);
});

test('archive redirects cannot escape public GitHub HTTPS, loop, or exceed the reference hop limit', async () => {
  for (const location of ['https://evil.example/file', 'http://github.com/o/r', 'https://user:pass@github.com/o/r',
    'https://github.com:444/o/r', 'https://127.0.0.1/file', '']) {
    let calls = 0;
    const source = createGithubArchiveSkillSource({ fetchImpl: async () => {
      calls++; return new Response('', { status: 302, headers: { location } });
    } });
    await assert.rejects(source.inspect('https://github.com/o/r', { ...options(), ref: commit }), { code: 'skill_github_archive_fetch_failed' });
    assert.equal(calls, 1);
  }
  for (const looping of [true, false]) {
    let calls = 0;
    const source = createGithubArchiveSkillSource({ fetchImpl: async () => {
      calls++; return new Response('', { status: 308, headers: { location: looping ? `/o/r/zip/${commit}` : `/o/r/zip/${commit}?hop=${calls}` } });
    } });
    await assert.rejects(source.inspect('https://github.com/o/r', { ...options(), ref: commit }), { code: 'skill_github_archive_fetch_failed' });
    assert.equal(calls, looping ? 1 : 21);
  }
});

test('redirect retirement or cancellation releases the response and cannot dispatch another request', async () => {
  for (const abort of [false, true]) {
    let calls = 0, released = 0, current = true;
    const controller = new AbortController();
    const source = createGithubArchiveSkillSource({ fetchImpl: async () => {
      calls++; return { status: 302, headers: new Headers({ location: '/renamed' }), body: { cancel() {
        released++; if (abort) controller.abort(Error('stopped')); else current = false;
        return new Promise(() => {});
      } } };
    } });
    await assert.rejects(source.inspect('https://github.com/o/r', { ref: commit, signal: controller.signal,
      assertCurrent: () => current }), error => abort ? /stopped/.test(error.message) : error.code === 'skill_github_authority_lost');
    assert.equal(calls, 1); assert.equal(released, 1);
  }
});
const packet = text => (Buffer.byteLength(text) + 4).toString(16).padStart(4, '0') + text;
const refs = packet('# service=git-upload-pack\n') + '0000' + packet(`${commit} refs/heads/main\0multi_ack\n`) + '0000';

test('REST quota failure falls back to Git advertisement then one immutable ZIP; binary and candidate errors are preserved', async () => {
  const binary = Buffer.from([0, 255, 128]), archive = zip([['good/SKILL.md', manifest('good')], ['good/assets/.binary', binary],
    ['bad/SKILL.md', 'missing frontmatter'], ['node_modules/SKILL.md', 'excluded']]), calls = [];
  const source = createGithubArchiveSkillSource({ fetchImpl: async (url, init) => {
    calls.push(String(url)); assert.equal(init.redirect, 'manual'); assert.equal(init.headers?.Authorization, undefined);
    if (url === 'https://api.github.com/repos/o/r/commits/main') return new Response('', { status: 429 });
    if (url === 'https://github.com/o/r.git/info/refs?service=git-upload-pack') return new Response(refs);
    assert.equal(url, `https://codeload.github.com/o/r/zip/${commit}`); return new Response(archive);
  } });
  const result = await source.inspect('https://github.com/o/r', options());
  assert.equal(calls.length, 3); assert.equal(result.commit, commit); assert.equal(result.candidates.length, 2);
  const good = result.candidates.find(candidate => candidate.name === 'good'), bad = result.candidates.find(candidate => candidate.path === 'bad');
  assert.deepEqual(Buffer.from(good.files.find(file => file.path === 'assets/.binary').bytes), binary);
  assert.equal(bad.status, 'invalid'); assert.deepEqual(bad.files, []); assert.equal(bad.diagnostics[0].code, 'skill_github_manifest_invalid');
});

test('exact commit bypasses mutable resolution, selects requested subtree and still validates excluded/outside content', async () => {
  const files = [['one/SKILL.md', manifest('one')], ['two/SKILL.md', manifest('two')]], calls = [];
  const source = createGithubArchiveSkillSource({ fetchImpl: async url => { calls.push(url); return new Response(zip(files)); } });
  const result = await source.inspect(`https://github.com/o/r/tree/${commit}/two`, options());
  assert.deepEqual(result.candidates.map(candidate => candidate.path), ['two']);
  assert.deepEqual(calls, [`https://codeload.github.com/o/r/zip/${commit}`]);
  files.push(['unselected/../escape', 'unsafe']);
  await assert.rejects(source.inspect(`https://github.com/o/r/tree/${commit}/two`, options()), { code: 'skill_github_archive_unsafe' });
});

test('a candidate above 1000 files is invalid while a healthy sibling remains inspectable', async () => {
  const files = [['large/SKILL.md', manifest('large')], ['small/SKILL.md', manifest('small')]];
  for (let i = 0; i < 1000; i++) files.push([`large/f-${i}`, '']);
  const source = createGithubArchiveSkillSource({ fetchImpl: async () => new Response(zip(files)) });
  const result = await source.inspect('https://github.com/o/r', { ...options(), ref: commit });
  assert.equal(result.candidates.length, 2); assert.equal(result.candidates.find(candidate => candidate.path === 'large').status, 'invalid');
  assert.equal(result.candidates.find(candidate => candidate.path === 'small').files.length, 1);
});

test('authority rejection keeps its typed error even if a later check succeeds', async () => {
  let fetched = false, rejectOnce = false, cancels = 0;
  const source = createGithubArchiveSkillSource({ fetchImpl: async () => {
    fetched = true;
    return { ok: true, body: { cancel() { cancels++; } } };
  } });
  await assert.rejects(source.inspect('https://github.com/o/r', { ...options(), ref: commit, assertCurrent() {
    if (fetched && !rejectOnce) { rejectOnce = true; return false; }
    return true;
  } }), { code: 'skill_github_authority_lost' });
  assert.equal(cancels, 1);
});

test('declared ZIP length is bounded before reading; streamed bytes cannot bypass the 50MiB limit', async () => {
  let reads = 0, cancels = 0;
  const declared = createGithubArchiveSkillSource({ fetchImpl: async () => ({ ok: true,
    headers: new Headers({ 'Content-Length': String(50 * 1024 * 1024 + 1) }),
    body: { getReader() { reads++; assert.fail('oversized body must not be read'); }, cancel() { cancels++; } } }) });
  await assert.rejects(declared.inspect('https://github.com/o/r', { ...options(), ref: commit }), { code: 'skill_github_archive_limit' });
  assert.equal(reads, 0); assert.equal(cancels, 1);
  const chunk = new Uint8Array(26 * 1024 * 1024);
  const streamed = createGithubArchiveSkillSource({ fetchImpl: async () => ({ ok: true, headers: new Headers(),
    body: { getReader() { return { async read() { reads++; return { value: chunk, done: false }; }, cancel() { cancels++; }, releaseLock() {} }; } } }) });
  await assert.rejects(streamed.inspect('https://github.com/o/r', { ...options(), ref: commit }), { code: 'skill_github_archive_limit' });
  assert.equal(reads, 2); assert.equal(cancels, 2);
});

for (const hang of ['fetch', 'read', 'cancel']) test(`cancellation bounds noncooperative archive ${hang}`, async () => {
  const controller = new AbortController(); let deliver;
  const source = createGithubArchiveSkillSource({ fetchImpl: () => hang === 'fetch' ? new Promise(resolve => { deliver = resolve; })
    : Promise.resolve({ ok: true, headers: new Headers(), body: { getReader() { return {
      read: () => new Promise(() => {}), cancel: () => hang === 'cancel' ? new Promise(() => {}) : Promise.resolve(), releaseLock() {},
    }; } } }) });
  const pending = source.inspect('https://github.com/o/r', { ref: commit, signal: controller.signal, assertCurrent: () => true });
  setTimeout(() => controller.abort(Error('stop')), 15); await assert.rejects(pending, /stop/);
  if (deliver) { let canceled = false; deliver({ body: { cancel() { canceled = true; } } });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(canceled, true); }
});

test('lost or asynchronous authority cannot publish bytes or select a fallback transport', async () => {
  let active = true, calls = 0, canceled = false;
  const source = createGithubArchiveSkillSource({ fetchImpl: async () => {
    calls++; active = false; return { ok: true, body: { cancel() { canceled = true; } } };
  } });
  await assert.rejects(source.inspect('https://github.com/o/r', { ref: commit, signal: new AbortController().signal, assertCurrent: () => active }),
    { code: 'skill_github_authority_lost' });
  assert.equal(calls, 1); assert.equal(canceled, true);
  await assert.rejects(source.inspect('https://github.com/o/r', { ref: commit, signal: new AbortController().signal, assertCurrent: async () => true }),
    { code: 'skill_github_authority_lost' });
  assert.equal(calls, 1);
});

test('transport exceptions are redacted and immutable archive failure is not replayed', async () => {
  let calls = 0;
  const source = createGithubArchiveSkillSource({ fetchImpl: async () => { calls++; throw Error('secret credential detail'); } });
  await assert.rejects(source.inspect('https://github.com/o/r', { ...options(), ref: commit }), error => {
    assert.equal(error.code, 'skill_github_archive_fetch_failed'); assert.equal(error.message.includes('secret'), false); return true;
  });
  assert.equal(calls, 1);
});
