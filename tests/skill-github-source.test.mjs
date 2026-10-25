/** Tests for the bounded GitHub Skill source. A controlled fetch transport
 *  asserts exact endpoints, redirect policy, commit/tree SHA separation,
 *  immutable blob SHA/sha1 validation, canonical base64, binary bytes, Unicode,
 *  and all failure boundaries. No internet or real credentials are used. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createGithubSkillSource, GITHUB_SKILL_SOURCE_CONTRACT } from '../src/skill-github-source.mjs';

function gitBlobSha1(bytes) {
  const buf = Buffer.from(bytes);
  const hash = createHash('sha1');
  hash.update(Buffer.from(`blob ${buf.byteLength}\0`, 'utf8')); hash.update(buf);
  return hash.digest('hex');
}

const SKILL_MD = '---\nname: my-skill\ndescription: A test skill 😀\nversion: 1.2.0\n---\n# My Skill\nHello 世界\n';
const SKILL_SHA = gitBlobSha1(Buffer.from(SKILL_MD, 'utf8'));
const SCRIPT = 'echo hello\n';
const SCRIPT_SHA = gitBlobSha1(Buffer.from(SCRIPT, 'utf8'));
const BINARY = Buffer.from([0, 1, 255, 128, 255, 0]);
const BINARY_SHA = gitBlobSha1(BINARY);
const COMMIT_SHA = 'a'.repeat(40);
const TREE_SHA = 'b'.repeat(40);
const TREE_SHA_2 = 'e'.repeat(40);

function jsonResponse(status, body) {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300, status, headers: { get: () => null },
    body: { getReader() {
      const buf = Buffer.from(text, 'utf8'); let done = false;
      return {
        read() { if (done) return Promise.resolve({ done: true }); done = true; return Promise.resolve({ value: buf, done: false }); },
        cancel() { return Promise.resolve(); }, releaseLock() {},
      };
    } },
  };
}
function errorResponse(status) { return { ok: false, status, headers: { get: () => null }, body: { getReader() { let d = false; return { read() { if (d) return Promise.resolve({ done: true }); d = true; return Promise.resolve({ value: Buffer.from('e'), done: false }); }, cancel() { return Promise.resolve(); }, releaseLock() {} }; } } }; }
function redirectResponse() { return { ok: false, status: 302, headers: { get: () => 'https://evil.com' }, body: { getReader() { return { read: () => Promise.resolve({ done: true }), cancel: () => Promise.resolve(), releaseLock: () => {} }; } } }; }

function treeEntry(path, sha, mode = '100644', type = 'blob') { return { path, sha, mode, type }; }
function recursiveTree(entries, sha = TREE_SHA, truncated = false) { return { sha, tree: entries, truncated }; }
function commitResponse(sha = COMMIT_SHA, treeSha = TREE_SHA) { return { sha, tree: { sha: treeSha } }; }

function makeTransport(routes) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), method: init?.method, redirect: init?.redirect, headers: init?.headers });
    const route = routes[String(url)];
    if (typeof route === 'function') return route();
    if (route) return route;
    return errorResponse(404);
  };
  return { fetchImpl, calls };
}

const trueAuthority = () => true;
function blobRoute(sha, content) {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  return () => jsonResponse(200, { sha, encoding: 'base64', content: buf.toString('base64'), size: buf.byteLength });
}

// Helper: standard routes for commit→tree→blob with the new commit/tree separation.
function standardRoutes(entries, opts = {}) {
  const commit = opts.commit || COMMIT_SHA;
  const treeSha = opts.treeSha || TREE_SHA;
  const routes = {};
  routes[`https://api.github.com/repos/o/r/commits/main`] = () => jsonResponse(200, { sha: commit });
  routes[`https://api.github.com/repos/o/r/git/commits/${commit}`] = () => jsonResponse(200, commitResponse(commit, treeSha));
  routes[`https://api.github.com/repos/o/r/git/trees/${treeSha}?recursive=1`] = () => jsonResponse(200, recursiveTree(entries, treeSha));
  return routes;
}

test('1000-file Skill excludes build/dependency directories and downloads identical blobs only once per inspection', async () => {
  const entries = [treeEntry('SKILL.md', SKILL_SHA)];
  for (let i = 0; i < 999; i++) entries.push(treeEntry(`assets/f${i}`, SCRIPT_SHA));
  for (const dir of ['.git', '.venv', 'venv', 'node_modules', 'dist', 'build', '__pycache__']) {
    entries.push(treeEntry(`${dir}/SKILL.md`, SKILL_SHA), treeEntry(`${dir}/bad-link`, 'f'.repeat(40), '120000'));
  }
  const routes = standardRoutes(entries);
  routes[`https://api.github.com/repos/o/r/git/blobs/${SKILL_SHA}`] = blobRoute(SKILL_SHA, SKILL_MD);
  routes[`https://api.github.com/repos/o/r/git/blobs/${SCRIPT_SHA}`] = blobRoute(SCRIPT_SHA, SCRIPT);
  const { fetchImpl, calls } = makeTransport(routes), src = createGithubSkillSource({ fetchImpl });
  const result = await src.inspect('https://github.com/o/r', { signal: new AbortController().signal, assertCurrent: trueAuthority });
  assert.equal(result.candidates.length, 1); assert.equal(result.candidates[0].files.length, 1000);
  assert.equal(calls.filter(call => call.url.includes('/git/blobs/')).length, 2);
  assert.ok(result.candidates[0].files.every(file => file.path === 'SKILL.md' || file.path.startsWith('assets/')));
});

test('bad candidate metadata preserves healthy siblings; oversized tree metadata needs no blob download', async () => {
  const invalid = Buffer.from('---\nname: incomplete\n---'), invalidSha = gitBlobSha1(invalid);
  const entries = [treeEntry('good/SKILL.md', SKILL_SHA), treeEntry('bad/SKILL.md', invalidSha),
    { ...treeEntry('large/SKILL.md', SKILL_SHA), size: 100 * 1024 * 1024 + 1 }];
  const routes = standardRoutes(entries);
  routes[`https://api.github.com/repos/o/r/git/blobs/${SKILL_SHA}`] = blobRoute(SKILL_SHA, SKILL_MD);
  routes[`https://api.github.com/repos/o/r/git/blobs/${invalidSha}`] = blobRoute(invalidSha, invalid);
  const { fetchImpl, calls } = makeTransport(routes), src = createGithubSkillSource({ fetchImpl });
  const result = await src.inspect('https://github.com/o/r', { signal: new AbortController().signal, assertCurrent: trueAuthority });
  assert.equal(result.candidates.length, 3);
  assert.equal(result.candidates.find(candidate => candidate.path === 'good').name, 'my-skill');
  for (const [path, code] of [['bad', 'skill_github_manifest_invalid'], ['large', 'skill_github_candidate_bytes_limit']]) {
    const candidate = result.candidates.find(candidate => candidate.path === path);
    assert.equal(candidate.status, 'invalid'); assert.deepEqual(candidate.files, []); assert.equal(candidate.diagnostics[0].code, code);
  }
  assert.equal(calls.filter(call => call.url.includes('/git/blobs/')).length, 2);
});

test('repository byte budget counts distinct paths even when identical Git blobs share one HTTP response', async () => {
  const bytes = Buffer.alloc(9 * 1024 * 1024, 0xab), sha = gitBlobSha1(bytes), entries = [];
  for (const root of ['one', 'two', 'three']) {
    entries.push(treeEntry(`${root}/SKILL.md`, SKILL_SHA));
    for (let i = 0; i < 8; i++) entries.push(treeEntry(`${root}/asset-${i}`, sha));
  }
  const routes = standardRoutes(entries);
  routes[`https://api.github.com/repos/o/r/git/blobs/${SKILL_SHA}`] = blobRoute(SKILL_SHA, SKILL_MD);
  routes[`https://api.github.com/repos/o/r/git/blobs/${sha}`] = blobRoute(sha, bytes);
  const { fetchImpl, calls } = makeTransport(routes), src = createGithubSkillSource({ fetchImpl });
  await assert.rejects(src.inspect('https://github.com/o/r', { signal: new AbortController().signal, assertCurrent: trueAuthority }),
    { code: 'skill_github_inspection_limit' });
  assert.equal(calls.filter(call => call.url.includes('/git/blobs/')).length, 2);
});

test('verified blob bytes must also match declared Git tree sizes', async () => {
  for (const manifest of [true, false]) {
    const entries = [{ ...treeEntry('SKILL.md', SKILL_SHA), size: Buffer.byteLength(SKILL_MD) + (manifest ? 1 : 0) },
      { ...treeEntry('script.sh', SCRIPT_SHA), size: Buffer.byteLength(SCRIPT) + (manifest ? 0 : 1) }];
    const routes = standardRoutes(entries);
    routes[`https://api.github.com/repos/o/r/git/blobs/${SKILL_SHA}`] = blobRoute(SKILL_SHA, SKILL_MD);
    routes[`https://api.github.com/repos/o/r/git/blobs/${SCRIPT_SHA}`] = blobRoute(SCRIPT_SHA, SCRIPT);
    const { fetchImpl } = makeTransport(routes), src = createGithubSkillSource({ fetchImpl });
    await assert.rejects(src.inspect('https://github.com/o/r', { signal: new AbortController().signal, assertCurrent: trueAuthority }),
      { code: 'skill_github_blob_invalid' });
  }
});

test('inspect fetches commit→git/commits→tree by tree SHA, verifying identity at each step', async () => {
  const entries = [treeEntry('SKILL.md', SKILL_SHA), treeEntry('scripts/run.sh', SCRIPT_SHA), treeEntry('assets/data.bin', BINARY_SHA)];
  const routes = standardRoutes(entries);
  routes[`https://api.github.com/repos/o/r/git/blobs/${SKILL_SHA}`] = blobRoute(SKILL_SHA, SKILL_MD);
  routes[`https://api.github.com/repos/o/r/git/blobs/${SCRIPT_SHA}`] = blobRoute(SCRIPT_SHA, SCRIPT);
  routes[`https://api.github.com/repos/o/r/git/blobs/${BINARY_SHA}`] = blobRoute(BINARY_SHA, BINARY);
  const { fetchImpl, calls } = makeTransport(routes);
  const src = createGithubSkillSource({ fetchImpl });
  const result = await src.inspect('https://github.com/o/r', { signal: new AbortController().signal, assertCurrent: trueAuthority });
  assert.equal(result.commit, COMMIT_SHA);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].path, ''); // root = empty string
  assert.equal(result.candidates[0].name, 'my-skill');
  assert.equal(result.candidates[0].files.length, 3);
  // Root candidate includes nested scripts directory resources
  assert.ok(result.candidates[0].files.some(f => f.path === 'scripts/run.sh'));
  // Exact binary bytes
  assert.deepEqual(result.candidates[0].files.find(f => f.path === 'assets/data.bin').bytes, new Uint8Array(BINARY));
  // Endpoint sequence: commits→git/commits→git/trees→3 blobs
  assert.equal(calls.length, 6);
  for (const c of calls) { assert.equal(c.redirect, 'manual'); assert.equal(c.headers.Authorization, undefined); }
});

test('inspect rejects when git/commits response sha does not match resolved commit', async () => {
  const routes = standardRoutes([]);
  // Tamper: git/commits returns a different sha
  routes[`https://api.github.com/repos/o/r/git/commits/${COMMIT_SHA}`] = () => jsonResponse(200, commitResponse('d'.repeat(40), TREE_SHA));
  const { fetchImpl } = makeTransport(routes);
  const src = createGithubSkillSource({ fetchImpl });
  await assert.rejects(() => src.inspect('https://github.com/o/r', { signal: new AbortController().signal, assertCurrent: trueAuthority }), { code: 'skill_github_commit_failed' });
});

test('inspect rejects when tree response sha does not match the tree SHA from the commit', async () => {
  const entries = [treeEntry('SKILL.md', SKILL_SHA)];
  const routes = standardRoutes(entries);
  // Tamper: tree response has a different sha
  routes[`https://api.github.com/repos/o/r/git/trees/${TREE_SHA}?recursive=1`] = () => jsonResponse(200, recursiveTree(entries, 'f'.repeat(40)));
  const { fetchImpl } = makeTransport(routes);
  const src = createGithubSkillSource({ fetchImpl });
  await assert.rejects(() => src.inspect('https://github.com/o/r', { signal: new AbortController().signal, assertCurrent: trueAuthority }), { code: 'skill_github_tree_failed' });
});

test('inspect accepts two different valid tree SHA values', async () => {
  for (const treeSha of [TREE_SHA, TREE_SHA_2]) {
    const entries = [treeEntry('SKILL.md', SKILL_SHA)];
    const routes = standardRoutes(entries, { treeSha });
    routes[`https://api.github.com/repos/o/r/git/blobs/${SKILL_SHA}`] = blobRoute(SKILL_SHA, SKILL_MD);
    const { fetchImpl } = makeTransport(routes);
    const src = createGithubSkillSource({ fetchImpl });
    const result = await src.inspect('https://github.com/o/r', { signal: new AbortController().signal, assertCurrent: trueAuthority });
    assert.equal(result.commit, COMMIT_SHA);
    assert.equal(result.candidates.length, 1);
  }
});

test('inspect accepts a 40-hex ref but still verifies git/commits and tree SHA', async () => {
  const sha = 'c'.repeat(40);
  const entries = [treeEntry('SKILL.md', SKILL_SHA)];
  const routes = {};
  routes[`https://api.github.com/repos/o/r/git/commits/${sha}`] = () => jsonResponse(200, commitResponse(sha, TREE_SHA));
  routes[`https://api.github.com/repos/o/r/git/trees/${TREE_SHA}?recursive=1`] = () => jsonResponse(200, recursiveTree(entries, TREE_SHA));
  routes[`https://api.github.com/repos/o/r/git/blobs/${SKILL_SHA}`] = blobRoute(SKILL_SHA, SKILL_MD);
  const { fetchImpl, calls } = makeTransport(routes);
  const src = createGithubSkillSource({ fetchImpl });
  const result = await src.inspect('https://github.com/o/r', { ref: sha, signal: new AbortController().signal, assertCurrent: trueAuthority });
  assert.equal(result.commit, sha);
  assert.equal(calls.length, 3); // git/commits + tree + blob
});

test('inspect accepts a git@ SSH URL with .git suffix and uses the ref argument', async () => {
  const entries = [treeEntry('SKILL.md', SKILL_SHA)];
  const routes = standardRoutes(entries);
  routes[`https://api.github.com/repos/o/r/commits/v1.0`] = () => jsonResponse(200, { sha: COMMIT_SHA });
  routes[`https://api.github.com/repos/o/r/git/blobs/${SKILL_SHA}`] = blobRoute(SKILL_SHA, SKILL_MD);
  const { fetchImpl } = makeTransport(routes);
  const src = createGithubSkillSource({ fetchImpl });
  const result = await src.inspect('git@github.com:o/r.git', { ref: 'v1.0', signal: new AbortController().signal, assertCurrent: trueAuthority });
  assert.equal(result.commit, COMMIT_SHA);
  assert.equal(result.candidates[0].name, 'my-skill');
});

test('inspect scopes candidates to tree/<ref>/<subdir>', async () => {
  const nested = '---\nname: nested\ndescription: nested skill\nversion: 1.0.0\n---\n# Nested\n';
  const nestedSha = gitBlobSha1(Buffer.from(nested, 'utf8'));
  const entries = [treeEntry('SKILL.md', SKILL_SHA), treeEntry('skills/sub/SKILL.md', nestedSha), treeEntry('skills/sub/run.sh', SCRIPT_SHA)];
  const routes = standardRoutes(entries);
  routes[`https://api.github.com/repos/o/r/git/blobs/${nestedSha}`] = blobRoute(nestedSha, nested);
  routes[`https://api.github.com/repos/o/r/git/blobs/${SCRIPT_SHA}`] = blobRoute(SCRIPT_SHA, SCRIPT);
  const { fetchImpl } = makeTransport(routes);
  const src = createGithubSkillSource({ fetchImpl });
  const result = await src.inspect('https://github.com/o/r/tree/main/skills/sub', { signal: new AbortController().signal, assertCurrent: trueAuthority });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].path, 'skills/sub');
  assert.equal(result.candidates[0].files.length, 2);
});

test('inspect returns both parent root and nested skill as complete valid candidates', async () => {
  const nested = '---\nname: nested\ndescription: nested skill\nversion: 1.0.0\n---\n# Nested\n';
  const nestedSha = gitBlobSha1(Buffer.from(nested, 'utf8'));
  const entries = [
    treeEntry('SKILL.md', SKILL_SHA),
    treeEntry('scripts/run.sh', SCRIPT_SHA),
    treeEntry('skills/inner/SKILL.md', nestedSha),
    treeEntry('skills/inner/lib.js', SCRIPT_SHA),
  ];
  const routes = standardRoutes(entries);
  routes[`https://api.github.com/repos/o/r/git/blobs/${SKILL_SHA}`] = blobRoute(SKILL_SHA, SKILL_MD);
  routes[`https://api.github.com/repos/o/r/git/blobs/${SCRIPT_SHA}`] = blobRoute(SCRIPT_SHA, SCRIPT);
  routes[`https://api.github.com/repos/o/r/git/blobs/${nestedSha}`] = blobRoute(nestedSha, nested);
  const { fetchImpl } = makeTransport(routes);
  const src = createGithubSkillSource({ fetchImpl });
  const result = await src.inspect('https://github.com/o/r', { signal: new AbortController().signal, assertCurrent: trueAuthority });
  assert.equal(result.candidates.length, 2);
  const root = result.candidates.find(c => c.path === '');
  const inner = result.candidates.find(c => c.path === 'skills/inner');
  assert.ok(root, 'root candidate exists');
  assert.ok(inner, 'nested candidate exists');
  // Root candidate includes its complete subtree (scripts + nested skill files)
  assert.ok(root.files.some(f => f.path === 'scripts/run.sh'));
  assert.ok(root.files.some(f => f.path === 'skills/inner/SKILL.md'));
  assert.ok(root.files.some(f => f.path === 'skills/inner/lib.js'));
  // Inner candidate has its own files
  assert.ok(inner.files.some(f => f.path === 'SKILL.md'));
  assert.ok(inner.files.some(f => f.path === 'lib.js'));
  assert.equal(inner.name, 'nested');
});

test('manifest blob is fetched and counted once', async () => {
  const entries = [treeEntry('SKILL.md', SKILL_SHA)];
  const routes = standardRoutes(entries);
  let blobCalls = 0;
  routes[`https://api.github.com/repos/o/r/git/blobs/${SKILL_SHA}`] = () => { blobCalls++; return blobRoute(SKILL_SHA, SKILL_MD)(); };
  const { fetchImpl } = makeTransport(routes);
  const src = createGithubSkillSource({ fetchImpl });
  const result = await src.inspect('https://github.com/o/r', { signal: new AbortController().signal, assertCurrent: trueAuthority });
  assert.equal(blobCalls, 1, 'manifest blob fetched exactly once');
  assert.equal(result.candidates[0].files.length, 1);
});

test('inspect rejects a blob with noncanonical base64 (padding mismatch)', async () => {
  const entries = [treeEntry('SKILL.md', SKILL_SHA)];
  const routes = standardRoutes(entries);
  // content has a valid alphabet but wrong padding (not canonical)
  const noncanonical = Buffer.from(SKILL_MD, 'utf8').toString('base64').slice(0, -1) + '=';
  routes[`https://api.github.com/repos/o/r/git/blobs/${SKILL_SHA}`] = () => jsonResponse(200, { sha: SKILL_SHA, encoding: 'base64', content: noncanonical, size: Buffer.byteLength(SKILL_MD) });
  const { fetchImpl } = makeTransport(routes);
  const src = createGithubSkillSource({ fetchImpl });
  await assert.rejects(() => src.inspect('https://github.com/o/r', { signal: new AbortController().signal, assertCurrent: trueAuthority }), { code: 'skill_github_blob_invalid' });
});

test('inspect accepts base64 content with CR/LF line breaks', async () => {
  const content = Buffer.from(SKILL_MD, 'utf8');
  const b64 = content.toString('base64');
  // Insert CR/LF every 76 chars (MIME-style)
  const withBreaks = b64.match(/.{1,76}/g).join('\r\n');
  const entries = [treeEntry('SKILL.md', SKILL_SHA)];
  const routes = standardRoutes(entries);
  routes[`https://api.github.com/repos/o/r/git/blobs/${SKILL_SHA}`] = () => jsonResponse(200, { sha: SKILL_SHA, encoding: 'base64', content: withBreaks, size: content.byteLength });
  const { fetchImpl } = makeTransport(routes);
  const src = createGithubSkillSource({ fetchImpl });
  const result = await src.inspect('https://github.com/o/r', { signal: new AbortController().signal, assertCurrent: trueAuthority });
  assert.equal(result.candidates[0].files.length, 1);
  assert.deepEqual(result.candidates[0].files[0].bytes, new Uint8Array(content));
});

test('inspect rejects a blob whose size metadata does not match decoded bytes', async () => {
  const entries = [treeEntry('SKILL.md', SKILL_SHA)];
  const routes = standardRoutes(entries);
  routes[`https://api.github.com/repos/o/r/git/blobs/${SKILL_SHA}`] = () => jsonResponse(200, { sha: SKILL_SHA, encoding: 'base64', content: Buffer.from(SKILL_MD, 'utf8').toString('base64'), size: 999 });
  const { fetchImpl } = makeTransport(routes);
  const src = createGithubSkillSource({ fetchImpl });
  await assert.rejects(() => src.inspect('https://github.com/o/r', { signal: new AbortController().signal, assertCurrent: trueAuthority }), { code: 'skill_github_blob_invalid' });
});

test('inspect preserves a binary above the old 512KiB/file and 8MiB/inspection caps', async () => {
  const big = Buffer.alloc(9 * 1024 * 1024 + 1, 0xff);
  const bigSha = gitBlobSha1(big);
  const entries = [treeEntry('SKILL.md', SKILL_SHA), treeEntry('big.txt', bigSha)];
  const routes = standardRoutes(entries);
  routes[`https://api.github.com/repos/o/r/git/blobs/${SKILL_SHA}`] = blobRoute(SKILL_SHA, SKILL_MD);
  routes[`https://api.github.com/repos/o/r/git/blobs/${bigSha}`] = blobRoute(bigSha, big);
  const { fetchImpl } = makeTransport(routes);
  const src = createGithubSkillSource({ fetchImpl });
  const result = await src.inspect('https://github.com/o/r', { signal: new AbortController().signal, assertCurrent: trueAuthority });
  assert.deepEqual(Buffer.from(result.candidates[0].files.find(file => file.path === 'big.txt').bytes), big);
});

test('inspect rejects a blob whose sha1 does not match the content', async () => {
  const entries = [treeEntry('SKILL.md', SKILL_SHA)];
  const routes = standardRoutes(entries);
  const wrong = '---\nname: x\ndescription: y\nversion: 1.0.0\n---\ntampered';
  routes[`https://api.github.com/repos/o/r/git/blobs/${SKILL_SHA}`] = () => jsonResponse(200, { sha: SKILL_SHA, encoding: 'base64', content: Buffer.from(wrong, 'utf8').toString('base64'), size: Buffer.byteLength(wrong) });
  const { fetchImpl } = makeTransport(routes);
  const src = createGithubSkillSource({ fetchImpl });
  await assert.rejects(() => src.inspect('https://github.com/o/r', { signal: new AbortController().signal, assertCurrent: trueAuthority }), { code: 'skill_github_blob_invalid' });
});

test('inspect rejects a blob whose returned sha does not match the requested sha', async () => {
  const entries = [treeEntry('SKILL.md', SKILL_SHA)];
  const routes = standardRoutes(entries);
  routes[`https://api.github.com/repos/o/r/git/blobs/${SKILL_SHA}`] = () => jsonResponse(200, { sha: '0'.repeat(40), encoding: 'base64', content: '', size: 0 });
  const { fetchImpl } = makeTransport(routes);
  const src = createGithubSkillSource({ fetchImpl });
  await assert.rejects(() => src.inspect('https://github.com/o/r', { signal: new AbortController().signal, assertCurrent: trueAuthority }), { code: 'skill_github_blob_invalid' });
});

test('inspect rejects invalid base64 alphabet', async () => {
  const entries = [treeEntry('SKILL.md', SKILL_SHA)];
  const routes = standardRoutes(entries);
  routes[`https://api.github.com/repos/o/r/git/blobs/${SKILL_SHA}`] = () => jsonResponse(200, { sha: SKILL_SHA, encoding: 'base64', content: '!!!not-base64!!!', size: 10 });
  const { fetchImpl } = makeTransport(routes);
  const src = createGithubSkillSource({ fetchImpl });
  await assert.rejects(() => src.inspect('https://github.com/o/r', { signal: new AbortController().signal, assertCurrent: trueAuthority }), { code: 'skill_github_blob_invalid' });
});

test('inspect rejects SKILL.md with missing name', async () => {
  const badMd = '---\ndescription: no name\nversion: 1.0.0\n---\n# Skill\n';
  const badSha = gitBlobSha1(Buffer.from(badMd, 'utf8'));
  const entries = [treeEntry('SKILL.md', badSha)];
  const routes = standardRoutes(entries);
  routes[`https://api.github.com/repos/o/r/git/blobs/${badSha}`] = blobRoute(badSha, badMd);
  const { fetchImpl } = makeTransport(routes);
  const src = createGithubSkillSource({ fetchImpl });
  const result = await src.inspect('https://github.com/o/r', { signal: new AbortController().signal, assertCurrent: trueAuthority });
  assert.equal(result.candidates[0].status, 'invalid');
  assert.deepEqual(result.candidates[0].files, []);
  assert.equal(result.candidates[0].diagnostics[0].code, 'skill_github_manifest_invalid');
});

test('inspect rejects SKILL.md with invalid semver version', async () => {
  const badMd = '---\nname: x\ndescription: y\nversion: latest\n---\n# Skill\n';
  const badSha = gitBlobSha1(Buffer.from(badMd, 'utf8'));
  const entries = [treeEntry('SKILL.md', badSha)];
  const routes = standardRoutes(entries);
  routes[`https://api.github.com/repos/o/r/git/blobs/${badSha}`] = blobRoute(badSha, badMd);
  const { fetchImpl } = makeTransport(routes);
  const src = createGithubSkillSource({ fetchImpl });
  const result = await src.inspect('https://github.com/o/r', { signal: new AbortController().signal, assertCurrent: trueAuthority });
  assert.equal(result.candidates[0].status, 'invalid');
  assert.deepEqual(result.candidates[0].files, []);
  assert.equal(result.candidates[0].diagnostics[0].code, 'skill_github_manifest_invalid');
});

test('inspect rejects non-UTF-8 manifest', async () => {
  const badBytes = Buffer.from([0xff, 0xfe, 0xff]);
  const badSha = gitBlobSha1(badBytes);
  const entries = [treeEntry('SKILL.md', badSha)];
  const routes = standardRoutes(entries);
  routes[`https://api.github.com/repos/o/r/git/blobs/${badSha}`] = blobRoute(badSha, badBytes);
  const { fetchImpl } = makeTransport(routes);
  const src = createGithubSkillSource({ fetchImpl });
  const result = await src.inspect('https://github.com/o/r', { signal: new AbortController().signal, assertCurrent: trueAuthority });
  assert.equal(result.candidates[0].status, 'invalid');
  assert.deepEqual(result.candidates[0].files, []);
  assert.equal(result.candidates[0].diagnostics[0].code, 'skill_github_manifest_invalid');
});

test('inspect rejects a truncated tree', async () => {
  const routes = standardRoutes([treeEntry('SKILL.md', SKILL_SHA)]);
  routes[`https://api.github.com/repos/o/r/git/trees/${TREE_SHA}?recursive=1`] = () => jsonResponse(200, { sha: TREE_SHA, tree: [treeEntry('SKILL.md', SKILL_SHA)], truncated: true });
  const { fetchImpl } = makeTransport(routes);
  const src = createGithubSkillSource({ fetchImpl });
  await assert.rejects(() => src.inspect('https://github.com/o/r', { signal: new AbortController().signal, assertCurrent: trueAuthority }), { code: 'skill_github_tree_truncated' });
});

test('inspect rejects a ref that does not resolve to a 40-hex SHA', async () => {
  const routes = {};
  routes[`https://api.github.com/repos/o/r/commits/main`] = () => jsonResponse(200, { sha: 'short' });
  const { fetchImpl } = makeTransport(routes);
  const src = createGithubSkillSource({ fetchImpl });
  await assert.rejects(() => src.inspect('https://github.com/o/r', { signal: new AbortController().signal, assertCurrent: trueAuthority }), { code: 'skill_github_ref_invalid' });
});

test('inspect rejects a symlink SKILL.md entry', async () => {
  const entries = [treeEntry('SKILL.md', 'e'.repeat(40), '120000')];
  const routes = standardRoutes(entries);
  const { fetchImpl } = makeTransport(routes);
  const src = createGithubSkillSource({ fetchImpl });
  await assert.rejects(() => src.inspect('https://github.com/o/r', { signal: new AbortController().signal, assertCurrent: trueAuthority }), { code: 'skill_github_unsafe_entry' });
});

test('inspect rejects a submodule entry inside a candidate', async () => {
  const entries = [treeEntry('SKILL.md', SKILL_SHA), treeEntry('vendor/sub', 'f'.repeat(40), '160000')];
  const routes = standardRoutes(entries);
  routes[`https://api.github.com/repos/o/r/git/blobs/${SKILL_SHA}`] = blobRoute(SKILL_SHA, SKILL_MD);
  const { fetchImpl } = makeTransport(routes);
  const src = createGithubSkillSource({ fetchImpl });
  await assert.rejects(() => src.inspect('https://github.com/o/r', { signal: new AbortController().signal, assertCurrent: trueAuthority }), { code: 'skill_github_unsafe_entry' });
});

test('inspect rejects a tree entry with an invalid mode for a blob', async () => {
  const entries = [treeEntry('SKILL.md', SKILL_SHA, '100600')]; // unknown mode
  const routes = standardRoutes(entries);
  const { fetchImpl } = makeTransport(routes);
  const src = createGithubSkillSource({ fetchImpl });
  await assert.rejects(() => src.inspect('https://github.com/o/r', { signal: new AbortController().signal, assertCurrent: trueAuthority }), { code: 'skill_github_unsafe_entry' });
});

test('inspect rejects a tree entry with an invalid mode for a directory', async () => {
  const entries = [treeEntry('SKILL.md', SKILL_SHA), { path: 'scripts', sha: '1'.repeat(40), mode: '100644', type: 'tree' }];
  const routes = standardRoutes(entries);
  const { fetchImpl } = makeTransport(routes);
  const src = createGithubSkillSource({ fetchImpl });
  await assert.rejects(() => src.inspect('https://github.com/o/r', { signal: new AbortController().signal, assertCurrent: trueAuthority }), { code: 'skill_github_unsafe_entry' });
});

test('inspect rejects a tree with duplicate paths', async () => {
  const entries = [treeEntry('SKILL.md', SKILL_SHA), treeEntry('SKILL.md', '1'.repeat(40))];
  const routes = standardRoutes(entries);
  const { fetchImpl } = makeTransport(routes);
  const src = createGithubSkillSource({ fetchImpl });
  await assert.rejects(() => src.inspect('https://github.com/o/r', { signal: new AbortController().signal, assertCurrent: trueAuthority }), { code: 'skill_github_duplicate_path' });
});

test('inspect rejects a tree with a file/directory path conflict', async () => {
  // 'scripts' is a blob (file) but 'scripts/run.sh' treats it as a directory — conflict.
  const entries = [treeEntry('SKILL.md', SKILL_SHA), treeEntry('scripts', '1'.repeat(40)), treeEntry('scripts/run.sh', '2'.repeat(40))];
  const routes = standardRoutes(entries);
  const { fetchImpl } = makeTransport(routes);
  const src = createGithubSkillSource({ fetchImpl });
  await assert.rejects(() => src.inspect('https://github.com/o/r', { signal: new AbortController().signal, assertCurrent: trueAuthority }), { code: 'skill_github_path_conflict' });
});

test('inspect rejects a tree entry with a backslash path', async () => {
  const entries = [treeEntry('SKILL.md', SKILL_SHA), treeEntry('evil\\.sh', SCRIPT_SHA)];
  const routes = standardRoutes(entries);
  const { fetchImpl } = makeTransport(routes);
  const src = createGithubSkillSource({ fetchImpl });
  await assert.rejects(() => src.inspect('https://github.com/o/r', { signal: new AbortController().signal, assertCurrent: trueAuthority }), { code: 'skill_github_unsafe_path' });
});

test('inspect rejects a tree entry with a dot-segment path', async () => {
  const entries = [treeEntry('SKILL.md', SKILL_SHA), treeEntry('../escape.sh', SCRIPT_SHA)];
  const routes = standardRoutes(entries);
  const { fetchImpl } = makeTransport(routes);
  const src = createGithubSkillSource({ fetchImpl });
  await assert.rejects(() => src.inspect('https://github.com/o/r', { signal: new AbortController().signal, assertCurrent: trueAuthority }), { code: 'skill_github_unsafe_path' });
});

test('inspect rejects a tree entry with a trailing slash path', async () => {
  const entries = [treeEntry('SKILL.md', SKILL_SHA), treeEntry('scripts/', '1'.repeat(40), '040000', 'tree')];
  const routes = standardRoutes(entries);
  const { fetchImpl } = makeTransport(routes);
  const src = createGithubSkillSource({ fetchImpl });
  await assert.rejects(() => src.inspect('https://github.com/o/r', { signal: new AbortController().signal, assertCurrent: trueAuthority }), { code: 'skill_github_unsafe_path' });
});

test('inspect rejects a tree entry with a non-40-hex SHA', async () => {
  const entries = [treeEntry('SKILL.md', 'short')];
  const routes = standardRoutes(entries);
  const { fetchImpl } = makeTransport(routes);
  const src = createGithubSkillSource({ fetchImpl });
  await assert.rejects(() => src.inspect('https://github.com/o/r', { signal: new AbortController().signal, assertCurrent: trueAuthority }), { code: 'skill_github_blob_invalid' });
});

test('inspect rejects a malformed SKILL.md tree entry (type tree, not blob)', async () => {
  const entries = [treeEntry('SKILL.md', SKILL_SHA, '040000', 'tree')];
  const routes = standardRoutes(entries);
  const { fetchImpl } = makeTransport(routes);
  const src = createGithubSkillSource({ fetchImpl });
  await assert.rejects(() => src.inspect('https://github.com/o/r', { signal: new AbortController().signal, assertCurrent: trueAuthority }), { code: 'skill_github_unsafe_entry' });
});

test('inspect rejects a URL with a query string', async () => {
  const src = createGithubSkillSource({ fetchImpl: async () => errorResponse(200) });
  await assert.rejects(() => src.inspect('https://github.com/o/r?token=x', { signal: new AbortController().signal, assertCurrent: trueAuthority }), { code: 'skill_github_url_invalid' });
});

test('inspect rejects a URL with a port', async () => {
  const src = createGithubSkillSource({ fetchImpl: async () => errorResponse(200) });
  await assert.rejects(() => src.inspect('https://github.com:8080/o/r', { signal: new AbortController().signal, assertCurrent: trueAuthority }), { code: 'skill_github_url_invalid' });
});

test('inspect rejects a URL with userinfo', async () => {
  const src = createGithubSkillSource({ fetchImpl: async () => errorResponse(200) });
  await assert.rejects(() => src.inspect('https://user@github.com/o/r', { signal: new AbortController().signal, assertCurrent: trueAuthority }), { code: 'skill_github_url_invalid' });
});

test('inspect rejects a non-github hostname', async () => {
  const src = createGithubSkillSource({ fetchImpl: async () => errorResponse(200) });
  await assert.rejects(() => src.inspect('https://evil.com/o/r', { signal: new AbortController().signal, assertCurrent: trueAuthority }), { code: 'skill_github_url_invalid' });
});

test('inspect rejects a dot-traversal subdir', async () => {
  const src = createGithubSkillSource({ fetchImpl: async () => errorResponse(200) });
  await assert.rejects(() => src.inspect('https://github.com/o/r/tree/main/../etc', { signal: new AbortController().signal, assertCurrent: trueAuthority }), { code: 'skill_github_url_invalid' });
});

test('inspect rejects a path-escape ref', async () => {
  const src = createGithubSkillSource({ fetchImpl: async () => errorResponse(200) });
  await assert.rejects(() => src.inspect('https://github.com/o/r', { ref: '..', signal: new AbortController().signal, assertCurrent: trueAuthority }), { code: 'skill_github_ref_invalid' });
});

test('inspect rejects an SSH URL with an arbitrary suffix path', async () => {
  const src = createGithubSkillSource({ fetchImpl: async () => errorResponse(200) });
  await assert.rejects(() => src.inspect('git@github.com:o/r.git/extra/path', { signal: new AbortController().signal, assertCurrent: trueAuthority }), { code: 'skill_github_url_invalid' });
});

test('inspect requires a signal', async () => {
  const src = createGithubSkillSource({ fetchImpl: async () => errorResponse(200) });
  await assert.rejects(() => src.inspect('https://github.com/o/r', { assertCurrent: trueAuthority }), { code: 'skill_github_signal_required' });
});

test('inspect rejects a thenable assertCurrent before any fetch', async () => {
  const { fetchImpl, calls } = makeTransport({});
  const src = createGithubSkillSource({ fetchImpl });
  let observed = false;
  const thenable = { then(resolve) { observed = true; resolve(); } };
  await assert.rejects(() => src.inspect('https://github.com/o/r', { signal: new AbortController().signal, assertCurrent: () => thenable }), { code: 'skill_github_authority_lost' });
  assert.equal(observed, true);
  assert.equal(calls.length, 0);
});

test('inspect rejects authority that returns false', async () => {
  const { fetchImpl, calls } = makeTransport({});
  const src = createGithubSkillSource({ fetchImpl });
  await assert.rejects(() => src.inspect('https://github.com/o/r', { signal: new AbortController().signal, assertCurrent: () => false }), { code: 'skill_github_authority_lost' });
  assert.equal(calls.length, 0);
});

test('inspect detects authority drift after commit verification', async () => {
  let authority = true;
  const entries = [treeEntry('SKILL.md', SKILL_SHA)];
  const routes = standardRoutes(entries);
  routes[`https://api.github.com/repos/o/r/git/commits/${COMMIT_SHA}`] = () => { authority = false; return jsonResponse(200, commitResponse(COMMIT_SHA, TREE_SHA)); };
  const { fetchImpl, calls } = makeTransport(routes);
  const src = createGithubSkillSource({ fetchImpl });
  await assert.rejects(() => src.inspect('https://github.com/o/r', { signal: new AbortController().signal, assertCurrent: () => authority }), { code: 'skill_github_authority_lost' });
  assert.equal(calls.filter(c => c.url.includes('/git/trees/')).length, 0, 'no tree fetch after authority drift');
});

test('inspect cancellation via signal propagates: no blob fetch after abort', async () => {
  const entries = [treeEntry('SKILL.md', SKILL_SHA)];
  const controller = new AbortController();
  let blobCalled = false;
  const routes = standardRoutes(entries);
  routes[`https://api.github.com/repos/o/r/git/commits/${COMMIT_SHA}`] = () => { controller.abort(); return jsonResponse(200, commitResponse(COMMIT_SHA, TREE_SHA)); };
  routes[`https://api.github.com/repos/o/r/git/blobs/${SKILL_SHA}`] = () => { blobCalled = true; return blobRoute(SKILL_SHA, SKILL_MD)(); };
  const { fetchImpl } = makeTransport(routes);
  const src = createGithubSkillSource({ fetchImpl });
  await assert.rejects(() => src.inspect('https://github.com/o/r', { signal: controller.signal, assertCurrent: trueAuthority }));
  assert.equal(blobCalled, false, 'no blob fetch after cancellation');
});

test('inspect races a hanging fetch against the signal and rejects boundedly', async () => {
  const entries = [treeEntry('SKILL.md', SKILL_SHA)];
  const controller = new AbortController();
  const routes = standardRoutes(entries);
  // commits endpoint hangs forever (noncooperative)
  routes[`https://api.github.com/repos/o/r/commits/main`] = () => new Promise(() => {});
  const { fetchImpl } = makeTransport(routes);
  const src = createGithubSkillSource({ fetchImpl });
  const pending = src.inspect('https://github.com/o/r', { signal: controller.signal, assertCurrent: trueAuthority });
  // Abort after a short delay
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(() => pending);
  // If we reach here, the hanging fetch did not block the caller
});

test('inspect races a hanging reader.read against the signal and rejects boundedly', async () => {
  const entries = [treeEntry('SKILL.md', SKILL_SHA)];
  const controller = new AbortController();
  const routes = standardRoutes(entries);
  // git/commits response body reader hangs forever
  routes[`https://api.github.com/repos/o/r/git/commits/${COMMIT_SHA}`] = () => ({
    ok: true, status: 200, headers: { get: () => null },
    body: { getReader() { return { read: () => new Promise(() => {}), cancel: () => Promise.resolve(), releaseLock: () => {} }; } },
  });
  const { fetchImpl } = makeTransport(routes);
  const src = createGithubSkillSource({ fetchImpl });
  const pending = src.inspect('https://github.com/o/r', { signal: controller.signal, assertCurrent: trueAuthority });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(() => pending);
});

test('inspect races a hanging reader.cancel (fire-and-forget, no unbounded await)', async () => {
  const entries = [treeEntry('SKILL.md', SKILL_SHA)];
  const controller = new AbortController();
  const routes = standardRoutes(entries);
  // git/commits reader.cancel hangs forever; read hangs until abort
  routes[`https://api.github.com/repos/o/r/git/commits/${COMMIT_SHA}`] = () => ({
    ok: true, status: 200, headers: { get: () => null },
    body: { getReader() { return { read: () => new Promise(() => {}), cancel: () => new Promise(() => {}), releaseLock: () => {} }; } },
  });
  const { fetchImpl } = makeTransport(routes);
  const src = createGithubSkillSource({ fetchImpl });
  const pending = src.inspect('https://github.com/o/r', { signal: controller.signal, assertCurrent: trueAuthority });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(() => pending);
  // If we reach here, the hanging cancel did not block the caller
});

test('inspect reports more than 1000 files as an invalid candidate before blob fetch', async () => {
  const entries = [treeEntry('SKILL.md', SKILL_SHA)];
  for (let i = 0; i < 1000; i++) { const b = Buffer.from(String(i)); entries.push(treeEntry(`f${i}`, gitBlobSha1(b))); }
  const routes = standardRoutes(entries);
  const { fetchImpl } = makeTransport(routes);
  const src = createGithubSkillSource({ fetchImpl });
  const result = await src.inspect('https://github.com/o/r', { signal: new AbortController().signal, assertCurrent: trueAuthority });
  assert.equal(result.candidates[0].status, 'invalid');
  assert.equal(result.candidates[0].diagnostics[0].code, 'skill_github_file_limit');
});

test('inspect rejects more than 5000 candidates', async () => {
  const entries = [];
  for (let i = 0; i < 5001; i++) entries.push(treeEntry(`skill${i}/SKILL.md`, SKILL_SHA));
  const routes = standardRoutes(entries);
  const { fetchImpl } = makeTransport(routes);
  const src = createGithubSkillSource({ fetchImpl });
  await assert.rejects(() => src.inspect('https://github.com/o/r', { signal: new AbortController().signal, assertCurrent: trueAuthority }), { code: 'skill_github_candidate_limit' });
});

test('inspect rejects a redirect outside GitHub before dispatch', async () => {
  const routes = {};
  routes[`https://api.github.com/repos/o/r/commits/main`] = () => redirectResponse();
  const { fetchImpl } = makeTransport(routes);
  const src = createGithubSkillSource({ fetchImpl });
  await assert.rejects(() => src.inspect('https://github.com/o/r', { signal: new AbortController().signal, assertCurrent: trueAuthority }), { code: 'skill_github_http_failed' });
});

test('inspect rejects a missing fetchImpl', () => {
  assert.throws(() => createGithubSkillSource({}), { code: 'skill_github_fetch_required' });
});

test('inspect does not cache: repeated calls make the same requests', async () => {
  const entries = [treeEntry('SKILL.md', SKILL_SHA)];
  let commitCalls = 0;
  const routes = standardRoutes(entries);
  routes[`https://api.github.com/repos/o/r/commits/main`] = () => { commitCalls++; return jsonResponse(200, { sha: COMMIT_SHA }); };
  routes[`https://api.github.com/repos/o/r/git/blobs/${SKILL_SHA}`] = blobRoute(SKILL_SHA, SKILL_MD);
  const { fetchImpl } = makeTransport(routes);
  const src = createGithubSkillSource({ fetchImpl });
  const a = await src.inspect('https://github.com/o/r', { signal: new AbortController().signal, assertCurrent: trueAuthority });
  const b = await src.inspect('https://github.com/o/r', { signal: new AbortController().signal, assertCurrent: trueAuthority });
  assert.equal(commitCalls, 2);
  assert.deepEqual(a, b);
});

test('inspect preserves hidden files and binary files', async () => {
  const hidden = '# config\n';
  const hiddenSha = gitBlobSha1(Buffer.from(hidden, 'utf8'));
  const entries = [treeEntry('SKILL.md', SKILL_SHA), treeEntry('.well-known/config', hiddenSha), treeEntry('assets/data.bin', BINARY_SHA)];
  const routes = standardRoutes(entries);
  routes[`https://api.github.com/repos/o/r/git/blobs/${SKILL_SHA}`] = blobRoute(SKILL_SHA, SKILL_MD);
  routes[`https://api.github.com/repos/o/r/git/blobs/${hiddenSha}`] = blobRoute(hiddenSha, hidden);
  routes[`https://api.github.com/repos/o/r/git/blobs/${BINARY_SHA}`] = blobRoute(BINARY_SHA, BINARY);
  const { fetchImpl } = makeTransport(routes);
  const src = createGithubSkillSource({ fetchImpl });
  const result = await src.inspect('https://github.com/o/r', { signal: new AbortController().signal, assertCurrent: trueAuthority });
  const paths = result.candidates[0].files.map(f => f.path);
  assert.ok(paths.includes('.well-known/config'));
  assert.ok(paths.includes('assets/data.bin'));
});

test('inspect rejects authority drift during body read', async () => {
  let authority = true;
  let readCount = 0;
  const entries = [treeEntry('SKILL.md', SKILL_SHA)];
  const routes = standardRoutes(entries);
  routes[`https://api.github.com/repos/o/r/git/commits/${COMMIT_SHA}`] = () => ({
    ok: true, status: 200, headers: { get: () => null },
    body: { getReader() {
      const buf = Buffer.from(JSON.stringify(commitResponse()), 'utf8');
      return {
        read() { readCount++; if (readCount === 1) { authority = false; return Promise.resolve({ value: buf, done: false }); } return Promise.resolve({ done: true }); },
        cancel() { return Promise.resolve(); }, releaseLock() {},
      };
    } },
  });
  const { fetchImpl, calls } = makeTransport(routes);
  const src = createGithubSkillSource({ fetchImpl });
  await assert.rejects(() => src.inspect('https://github.com/o/r', { signal: new AbortController().signal, assertCurrent: () => authority }), { code: 'skill_github_authority_lost' });
  assert.equal(calls.filter(c => c.url.includes('/git/trees/')).length, 0);
});

test('inspect candidateId is stable for repo/commit/path', async () => {
  const entries = [treeEntry('SKILL.md', SKILL_SHA)];
  const routes = standardRoutes(entries);
  routes[`https://api.github.com/repos/o/r/git/blobs/${SKILL_SHA}`] = blobRoute(SKILL_SHA, SKILL_MD);
  const { fetchImpl } = makeTransport(routes);
  const src = createGithubSkillSource({ fetchImpl });
  const a = await src.inspect('https://github.com/o/r', { signal: new AbortController().signal, assertCurrent: trueAuthority });
  const b = await src.inspect('https://github.com/o/r', { signal: new AbortController().signal, assertCurrent: trueAuthority });
  assert.equal(a.candidates[0].candidateId, b.candidates[0].candidateId);
  assert.match(a.candidates[0].candidateId, /^skill_[0-9a-f]{16}$/);
});

test('contract is exported', () => {
  const src = createGithubSkillSource({ fetchImpl: async () => errorResponse(200) });
  assert.equal(src.contract, GITHUB_SKILL_SOURCE_CONTRACT);
});

test('inspect rejects a response body exceeding the byte limit', async () => {
  const routes = {};
  routes[`https://api.github.com/repos/o/r/commits/main`] = () => ({
    ok: true, status: 200, headers: { get: () => null },
    body: { getReader() {
      let sent = 0;
      return {
        read() { if (sent >= 3 * 1024 * 1024) return Promise.resolve({ done: true }); sent += 1024 * 1024; return Promise.resolve({ value: Buffer.alloc(1024 * 1024, 65), done: false }); },
        cancel() { return Promise.resolve(); }, releaseLock() {},
      };
    } },
  });
  const { fetchImpl } = makeTransport(routes);
  const src = createGithubSkillSource({ fetchImpl });
  await assert.rejects(() => src.inspect('https://github.com/o/r', { signal: new AbortController().signal, assertCurrent: trueAuthority }), { code: 'skill_github_response_limit' });
});

// Search tests
test('search returns repositories with in:name,description and reconstructed URL', async () => {
  const { fetchImpl, calls } = makeTransport({
    'https://api.github.com/search/repositories?q=hello%20world%20in%3Aname%2Cdescription&per_page=5': () => jsonResponse(200, {
      items: [
        { full_name: 'o/r1', html_url: 'https://evil.com/o/r1', description: 'one 😀', stargazers_count: 10, default_branch: 'main', archived: false },
        { full_name: 'o/r2', html_url: 'https://github.com/o/r2', description: '', stargazers_count: 5, default_branch: 'dev', archived: true },
      ],
    }),
  });
  const src = createGithubSkillSource({ fetchImpl });
  const result = await src.search('hello world', { limit: 5, signal: new AbortController().signal, assertCurrent: trueAuthority });
  assert.equal(result.repositories.length, 2);
  // URL is reconstructed, never the API html_url (o/r1's html_url was evil.com)
  assert.equal(result.repositories[0].url, 'https://github.com/o/r1');
  assert.equal(result.repositories[0].description, 'one 😀');
  assert.equal(result.repositories[0].owner, 'o');
  assert.equal(result.repositories[1].archived, true);
  assert.equal(calls[0].redirect, 'manual');
  assert.equal(calls[0].headers.Authorization, undefined);
});

test('search clamps limit to 1..10', async () => {
  const { fetchImpl, calls } = makeTransport({
    'https://api.github.com/search/repositories?q=x%20in%3Aname%2Cdescription&per_page=1': () => jsonResponse(200, { items: [] }),
    'https://api.github.com/search/repositories?q=x%20in%3Aname%2Cdescription&per_page=10': () => jsonResponse(200, { items: [] }),
  });
  const src = createGithubSkillSource({ fetchImpl });
  await src.search('x', { limit: 0, signal: new AbortController().signal, assertCurrent: trueAuthority });
  assert.match(calls[0].url, /per_page=1/);
  await src.search('x', { limit: 999, signal: new AbortController().signal, assertCurrent: trueAuthority });
  assert.match(calls[1].url, /per_page=10/);
});

test('search rejects empty query', async () => {
  const src = createGithubSkillSource({ fetchImpl: async () => errorResponse(200) });
  await assert.rejects(() => src.search('  ', { signal: new AbortController().signal, assertCurrent: trueAuthority }), { code: 'skill_github_query_invalid' });
});

test('search rejects HTTP failure', async () => {
  const { fetchImpl } = makeTransport({ 'https://api.github.com/search/repositories?q=x%20in%3Aname%2Cdescription&per_page=5': () => errorResponse(403) });
  const src = createGithubSkillSource({ fetchImpl });
  await assert.rejects(() => src.search('x', { signal: new AbortController().signal, assertCurrent: trueAuthority }), { code: 'skill_github_http_failed' });
});

test('search rejects an item with invalid full_name', async () => {
  const { fetchImpl } = makeTransport({
    'https://api.github.com/search/repositories?q=x%20in%3Aname%2Cdescription&per_page=5': () => jsonResponse(200, { items: [{ full_name: 'no-slash', html_url: '', description: '', stargazers_count: 0, default_branch: '', archived: false }] }),
  });
  const src = createGithubSkillSource({ fetchImpl });
  await assert.rejects(() => src.search('x', { signal: new AbortController().signal, assertCurrent: trueAuthority }), { code: 'skill_github_search_failed' });
});

test('search requires a signal', async () => {
  const src = createGithubSkillSource({ fetchImpl: async () => errorResponse(200) });
  await assert.rejects(() => src.search('x', { assertCurrent: trueAuthority }), { code: 'skill_github_signal_required' });
});

test('full 512KiB binary blob with canonical wrapped base64 survives inspection exactly', async () => {
  const bytes = Buffer.alloc(512 * 1024, 0xff), sha = gitBlobSha1(bytes);
  const routes = standardRoutes([treeEntry('SKILL.md', SKILL_SHA), treeEntry('assets/large.bin', sha)]);
  routes[`https://api.github.com/repos/o/r/git/blobs/${SKILL_SHA}`] = blobRoute(SKILL_SHA, SKILL_MD);
  routes[`https://api.github.com/repos/o/r/git/blobs/${sha}`] = () => jsonResponse(200,
    { sha, encoding: 'base64', size: bytes.length, content: bytes.toString('base64').match(/.{1,76}/g).join('\r\n') });
  const { fetchImpl } = makeTransport(routes), result = await createGithubSkillSource({ fetchImpl }).inspect('https://github.com/o/r',
    { signal: new AbortController().signal, assertCurrent: trueAuthority });
  assert.deepEqual(Buffer.from(result.candidates[0].files.find(file => file.path === 'assets/large.bin').bytes), bytes);
});

test('submodule outside chosen Skill is preserved as repository metadata; inside a chosen Skill is rejected', async () => {
  const entries = [treeEntry('skills/demo/SKILL.md', SKILL_SHA), treeEntry('vendor', 'f'.repeat(40), '160000', 'commit')];
  const routes = standardRoutes(entries); routes[`https://api.github.com/repos/o/r/git/blobs/${SKILL_SHA}`] = blobRoute(SKILL_SHA, SKILL_MD);
  const { fetchImpl } = makeTransport(routes);
  const result = await createGithubSkillSource({ fetchImpl }).inspect('https://github.com/o/r', { signal: new AbortController().signal, assertCurrent: trueAuthority });
  assert.equal(result.candidates.length, 1);
  const bad = makeTransport(standardRoutes([...entries, treeEntry('skills/demo/vendor', 'f'.repeat(40), '160000', 'commit')]));
  await assert.rejects(createGithubSkillSource(bad).inspect('https://github.com/o/r', { signal: new AbortController().signal, assertCurrent: trueAuthority }),
    { code: 'skill_github_unsafe_entry' });
});

test('file-directory ancestor conflict is rejected regardless of tree order and directory marker type', async () => {
  const values = [treeEntry('file', SCRIPT_SHA), treeEntry('file/dir', TREE_SHA, '040000', 'tree')];
  for (const entries of [values, [...values].reverse()]) {
    const source = createGithubSkillSource(makeTransport(standardRoutes([treeEntry('SKILL.md', SKILL_SHA), ...entries])));
    await assert.rejects(source.inspect('https://github.com/o/r', { signal: new AbortController().signal, assertCurrent: trueAuthority }), { code: 'skill_github_path_conflict' });
  }
});

test('URL normalization cannot hide default ports, encoded dot segments, repeated separators or backslashes', async () => {
  const source = createGithubSkillSource({ fetchImpl: async () => assert.fail('invalid URL must not fetch') });
  for (const url of ['https://github.com:443/o/r', 'https://github.com/o/./r', 'https://github.com/o/%2e%2e/r',
    'https://github.com/o//r', 'https://github.com/o\\r', 'https://github.com/o/r/tree/main/%2e%2e/other']) {
    await assert.rejects(source.inspect(url, { signal: new AbortController().signal, assertCurrent: trueAuthority }), { code: 'skill_github_url_invalid' });
  }
});

test('cancelled noncooperative fetch disposes its late response without reading or dispatching another request', async () => {
  const controller = new AbortController(); let deliver, cancelled = 0, calls = 0;
  const transport = new Promise(resolve => { deliver = resolve; });
  const source = createGithubSkillSource({ fetchImpl: () => { calls++; return transport; } });
  const pending = source.inspect('https://github.com/o/r', { signal: controller.signal, assertCurrent: trueAuthority });
  const reason = new Error('cancel original'); controller.abort(reason); await assert.rejects(pending, error => error === reason);
  deliver({ body: { cancel: async () => { cancelled++; } } });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(cancelled, 1); assert.equal(calls, 1);
});

test('fetch that aborts synchronously and rejects is observed, with no unhandled rejection', async () => {
  const controller = new AbortController(), reason = new Error('abort in fetch');
  const source = createGithubSkillSource({ fetchImpl: () => { controller.abort(reason); return Promise.reject(new Error('late transport')); } });
  await assert.rejects(source.inspect('https://github.com/o/r', { signal: controller.signal, assertCurrent: trueAuthority }), error => error === reason);
  await new Promise(resolve => setImmediate(resolve));
});

test('search rejects malformed owner/name even when full_name has one slash', async () => {
  for (const full_name of ['../repo', 'owner/repo?query', 'owner/repo#fragment', 'owner /repo']) {
    const source = createGithubSkillSource({ fetchImpl: async () => jsonResponse(200, { items: [{ full_name }] }) });
    await assert.rejects(source.search('x', { signal: new AbortController().signal, assertCurrent: trueAuthority }), { code: 'skill_github_search_failed' });
  }
});
