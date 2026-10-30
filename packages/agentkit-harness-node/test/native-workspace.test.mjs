import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeWorkspaceTools } from '../src/native/workspace-tools.mjs';

function setup({ authorize, sessionId = 's1' } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'nws-main-'));
  const workspaceRoot = join(base, 'workspace');
  const stateDir = join(base, 'state');
  mkdirSync(workspaceRoot, { recursive: true });
  const tools = createNativeWorkspaceTools({
    workspaceRoot, stateDir, sessionId,
    authorize: authorize || (async () => 'allow'),
  });
  let seq = 0;
  const call = (name, args, { signal, interaction } = {}) => tools.execute({
    call: { callId: `c-${name}-${++seq}`, name, arguments: args },
    definition: tools.definitions.find((d) => d.name === name),
    operationKey: `op-${name}`,
    signal: signal || new AbortController().signal,
    sessionId,
    interaction,
  });
  return { base, workspaceRoot, stateDir, tools, call, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

test('definitions expose all ten tools with correct read-only and permission metadata', () => {
  const { tools, cleanup } = setup();
  try {
    const names = tools.definitions.map((d) => d.name);
    assert.deepEqual(names.sort(), [
      'delete_workspace_file', 'edit_workspace_file', 'lint_workspace_file',
      'list_workspace_files', 'multi_edit_workspace_file', 'read_workspace_file',
      'search_workspace_files', 'workspace_status', 'write_workspace_file',
      'write_workspace_files',
    ]);
    const byName = Object.fromEntries(tools.definitions.map((d) => [d.name, d]));
    for (const ro of ['workspace_status', 'list_workspace_files', 'read_workspace_file', 'lint_workspace_file', 'search_workspace_files']) {
      assert.equal(byName[ro].readOnly, true, `${ro} should be readOnly`);
      assert.equal(byName[ro].concurrentSafe, true, `${ro} should be concurrentSafe`);
      assert.deepEqual(byName[ro].permissions, []);
    }
    for (const m of ['write_workspace_file', 'write_workspace_files', 'edit_workspace_file', 'multi_edit_workspace_file']) {
      assert.equal(byName[m].readOnly, false);
      assert.equal(byName[m].concurrentSafe, false);
      assert.deepEqual(byName[m].permissions, ['workspace:write']);
    }
    assert.equal(byName.delete_workspace_file.readOnly, false);
    assert.deepEqual(byName.delete_workspace_file.permissions, ['workspace:delete']);
    assert.equal(byName.read_workspace_file.contextRole, 'workspace_read');
    assert.equal(byName.list_workspace_files.contextRole, 'workspace_list');
    assert.equal(byName.search_workspace_files.contextRole, 'workspace_search');
    for (const d of tools.definitions) {
      assert.equal(d.observationRole, 'none');
      assert.equal(d.progressObservation, false);
      assert.equal(d.contextRetention, 'normal');
      assert.ok(typeof d.parameters === 'object' && d.parameters.type === 'object');
    }
  } finally { cleanup(); }
});

test('workspace_status samples up to 50 files and creates the root', async () => {
  const { tools, workspaceRoot, cleanup } = setup();
  try {
    for (let i = 0; i < 3; i++) writeFileSync(join(workspaceRoot, `f${i}.txt`), `c${i}\n`);
    const res = await tools.execute({ call: { callId: 'cs', name: 'workspace_status', arguments: {} }, definition: tools.definitions[0], operationKey: 'op', signal: new AbortController().signal, sessionId: 's1' });
    assert.equal(res.status, 'ok');
    assert.equal(res.content.ok, true);
    assert.equal(res.content.file_count_sampled, 3);
    assert.deepEqual(res.content.files.map((f) => f.path).sort(), ['f0.txt', 'f1.txt', 'f2.txt']);
  } finally { cleanup(); }
});

test('list_workspace_files lists, filters, sorts and truncates', async () => {
  const { call, workspaceRoot, cleanup } = setup();
  try {
    writeFileSync(join(workspaceRoot, 'a.py'), 'x');
    writeFileSync(join(workspaceRoot, 'b.md'), 'x');
    mkdirSync(join(workspaceRoot, 'sub'), { recursive: true });
    writeFileSync(join(workspaceRoot, 'sub/c.py'), 'x');
    const all = await call('list_workspace_files', { recursive: true });
    assert.equal(all.status, 'ok');
    const paths = all.content.entries.map((e) => e.path);
    assert.ok(paths.includes('a.py'));
    assert.ok(paths.includes('sub/c.py'));
    assert.ok(paths.includes('sub')); // directories included by default
    const pyOnly = await call('list_workspace_files', { glob: '*.py', recursive: true });
    assert.deepEqual(pyOnly.content.entries.map((e) => e.path).sort(), ['a.py', 'sub/c.py']);
    const noDirs = await call('list_workspace_files', { recursive: true, include_dirs: false });
    assert.ok(noDirs.content.entries.every((e) => e.type === 'file'));
    const limited = await call('list_workspace_files', { recursive: true, max_results: 1 });
    assert.equal(limited.content.entries.length, 1);
    assert.equal(limited.content.truncated, true);
  } finally { cleanup(); }
});

test('read_workspace_file returns numbered content for a full read and records state', async () => {
  const { call, workspaceRoot, cleanup } = setup();
  try {
    writeFileSync(join(workspaceRoot, 'a.txt'), 'one\ntwo\nthree\n');
    const r = await call('read_workspace_file', { path: 'a.txt' });
    assert.equal(r.status, 'ok');
    assert.equal(r.content.content, '1 | one\n2 | two\n3 | three');
    assert.equal(r.content.total_lines, 3);
    assert.equal(r.content.start_line, 1);
    assert.equal(r.content.end_line, 3);
    assert.equal(r.content.partial, false);
    assert.equal(r.workspaceChangedPaths, undefined); // reads must not report changed paths
    const plain = await call('read_workspace_file', { path: 'a.txt', include_line_numbers: false });
    assert.equal(plain.content.content, 'one\ntwo\nthree');
  } finally { cleanup(); }
});

test('read_workspace_file paginates with start_line/end_line and marks partial', async () => {
  const { call, workspaceRoot, cleanup } = setup();
  try {
    writeFileSync(join(workspaceRoot, 'a.txt'), 'l1\nl2\nl3\nl4\nl5\n');
    const r = await call('read_workspace_file', { path: 'a.txt', start_line: 2, end_line: 4 });
    assert.equal(r.status, 'ok');
    assert.equal(r.content.content, '2 | l2\n3 | l3\n4 | l4');
    assert.equal(r.content.start_line, 2);
    assert.equal(r.content.end_line, 4);
    assert.equal(r.content.partial, true);
  } finally { cleanup(); }
});

test('read_workspace_file truncates on max_chars at a line boundary and reports next_start_line', async () => {
  const { call, workspaceRoot, cleanup } = setup();
  try {
    // many lines so the numbered content exceeds the 1000-char minimum budget.
    const lines = Array.from({ length: 200 }, (_, i) => `line${i}`);
    writeFileSync(join(workspaceRoot, 'big.txt'), lines.join('\n') + '\n');
    const r = await call('read_workspace_file', { path: 'big.txt', max_chars: 1000 });
    assert.equal(r.status, 'ok');
    assert.equal(r.content.truncated, true);
    assert.equal(r.content.partial, true);
    assert.ok(typeof r.content.next_start_line === 'number');
    assert.ok(r.content.next_start_line > 1);
    // continuation reads the remainder
    const r2 = await call('read_workspace_file', { path: 'big.txt', start_line: r.content.next_start_line });
    assert.equal(r2.status, 'ok');
    assert.ok(r2.content.end_line >= r.content.next_start_line);
  } finally { cleanup(); }
});

test('read_workspace_file rejects missing, >2MB and non-utf-8 files', async () => {
  const { call, workspaceRoot, cleanup } = setup();
  try {
    const missing = await call('read_workspace_file', { path: 'nope.txt' });
    assert.equal(missing.status, 'error');
    assert.match(missing.content.error_message, /not found/);
    writeFileSync(join(workspaceRoot, 'big.bin'), Buffer.alloc(2 * 1024 * 1024 + 1, 0x61));
    const big = await call('read_workspace_file', { path: 'big.bin' });
    assert.equal(big.status, 'error');
    assert.match(big.content.error_message, /2MB/);
    writeFileSync(join(workspaceRoot, 'bin.dat'), Buffer.from([0xff, 0xfe, 0xfd]));
    const bin = await call('read_workspace_file', { path: 'bin.dat' });
    assert.equal(bin.status, 'error');
    assert.match(bin.content.error_message, /utf-8/);
  } finally { cleanup(); }
});

test('write_workspace_file creates new files, records state for further writes, and requires a read for external files', async () => {
  const { call, workspaceRoot, cleanup } = setup();
  try {
    const created = await call('write_workspace_file', { path: 'new.txt', content: 'hello\n' });
    assert.equal(created.status, 'ok');
    assert.equal(created.content.path, 'new.txt');
    assert.equal(readFileSync(join(workspaceRoot, 'new.txt'), 'utf-8'), 'hello\n');
    assert.deepEqual(created.workspaceChangedPaths, ['new.txt']);
    assert.equal(created.content.diff_additions, 1);
    // a successful write records the revision: a further overwrite needs no read
    const again = await call('write_workspace_file', { path: 'new.txt', content: 'world\n' });
    assert.equal(again.status, 'ok');
    assert.equal(readFileSync(join(workspaceRoot, 'new.txt'), 'utf-8'), 'world\n');
    // an external file the session never read or wrote must be read before overwriting
    writeFileSync(join(workspaceRoot, 'ext.txt'), 'orig\n');
    const unread = await call('write_workspace_file', { path: 'ext.txt', content: 'new\n' });
    assert.equal(unread.status, 'error');
    assert.equal(unread.content.error_type, 'file_not_read');
    await call('read_workspace_file', { path: 'ext.txt' });
    const afterRead = await call('write_workspace_file', { path: 'ext.txt', content: 'new\n' });
    assert.equal(afterRead.status, 'ok');
    assert.equal(readFileSync(join(workspaceRoot, 'ext.txt'), 'utf-8'), 'new\n');
  } finally { cleanup(); }
});

test('write_workspace_file overwrite=false refuses an existing file', async () => {
  const { call, workspaceRoot, cleanup } = setup();
  try {
    writeFileSync(join(workspaceRoot, 'e.txt'), 'x');
    const r = await call('write_workspace_file', { path: 'e.txt', content: 'y', overwrite: false });
    assert.equal(r.status, 'error');
    assert.equal(r.content.error_type, 'file_exists');
  } finally { cleanup(); }
});

test('write_workspace_files checks all preconditions before writing and reports per-file results', async () => {
  const { call, workspaceRoot, cleanup } = setup();
  try {
    // second file already exists but unread -> the whole batch must fail before any write
    writeFileSync(join(workspaceRoot, 'exists.txt'), 'old\n');
    const r = await call('write_workspace_files', {
      files: [
        { path: 'fresh1.txt', content: 'a\n' },
        { path: 'exists.txt', content: 'b\n' },
      ],
    });
    assert.equal(r.status, 'error');
    assert.equal(r.content.error_type, 'file_not_read');
    // the fresh file must NOT have been written
    assert.equal(existsSync(join(workspaceRoot, 'fresh1.txt')), false);
    // a clean batch writes both
    await call('read_workspace_file', { path: 'exists.txt' });
    const ok = await call('write_workspace_files', {
      files: [
        { path: 'fresh1.txt', content: 'a\n' },
        { path: 'exists.txt', content: 'b\n' },
      ],
    });
    assert.equal(ok.status, 'ok');
    assert.equal(ok.content.written.length, 2);
    assert.deepEqual(ok.content.written.map((w) => w.path), ['fresh1.txt', 'exists.txt']);
  } finally { cleanup(); }
});

test('lint_workspace_file runs generic, json and Node-only Python syntax checks', async () => {
  const { call, workspaceRoot, cleanup } = setup();
  try {
    writeFileSync(join(workspaceRoot, 'clean.txt'), 'no issues\n');
    const clean = await call('lint_workspace_file', { path: 'clean.txt' });
    assert.equal(clean.status, 'ok');
    assert.equal(clean.content.ok, true);
    assert.equal(clean.content.language, 'text');

    writeFileSync(join(workspaceRoot, 'nul.txt'), 'a\0b\n');
    const nul = await call('lint_workspace_file', { path: 'nul.txt' });
    assert.equal(nul.content.ok, false);
    assert.ok(nul.content.issues.some((i) => i.severity === 'error' && i.message === 'NUL byte found'));

    writeFileSync(join(workspaceRoot, 'trail.txt'), 'ok   \n');
    const trail = await call('lint_workspace_file', { path: 'trail.txt' });
    assert.ok(trail.content.issues.some((i) => i.message === 'trailing whitespace'));

    writeFileSync(join(workspaceRoot, 'good.json'), '{"a": 1}');
    assert.equal((await call('lint_workspace_file', { path: 'good.json' })).content.ok, true);
    writeFileSync(join(workspaceRoot, 'bad.json'), '{"a": }');
    const bad = await call('lint_workspace_file', { path: 'bad.json' });
    assert.equal(bad.content.ok, false);
    assert.equal(bad.content.language, 'json');
    assert.ok(bad.content.issues.some((i) => i.severity === 'error'));

    writeFileSync(join(workspaceRoot, 'code.py'), 'def f(:\n');
    const py = await call('lint_workspace_file', { path: 'code.py' });
    assert.equal(py.content.language, 'python');
    assert.equal(py.status, 'error');
    assert.equal(py.content.ok, false);
    assert.equal(py.content.issues.length, 1);
    assert.equal(py.content.issues[0].severity, 'error');
    assert.equal(py.content.issues[0].line, 1);
    assert.ok(py.content.issues[0].column > 0);
    assert.equal(py.content.syntax_engine.targetVersion, 'py312');
    assert.equal(py.content.lint_model, 'built_in_lightweight');
    writeFileSync(join(workspaceRoot, 'code.py'), 'def f():\n    return 1  \n');
    const fixed = await call('lint_workspace_file', { path: 'code.py' });
    assert.equal(fixed.status, 'ok');
    assert.deepEqual(fixed.content.issues, []);
  } finally { cleanup(); }
});

test('search_workspace_files matches literal and regex with context and truncation', async () => {
  const { call, workspaceRoot, cleanup } = setup();
  try {
    writeFileSync(join(workspaceRoot, 'a.txt'), 'alpha\nbeta\ngamma\n');
    writeFileSync(join(workspaceRoot, 'b.txt'), 'BETA\nother\n');
    const literal = await call('search_workspace_files', { query: 'beta' });
    assert.equal(literal.status, 'ok');
    assert.equal(literal.content.match_count, 2); // a.txt:2 'beta' and b.txt:1 'BETA' (case-insensitive default)
    assert.deepEqual(literal.content.results.map((r) => r.path).sort(), ['a.txt', 'b.txt']);
    assert.equal(literal.content.search_backend, 'node');
    const aRes = literal.content.results.find((r) => r.path === 'a.txt');
    assert.equal(aRes.line, 2);
    const caseSensitive = await call('search_workspace_files', { query: 'beta', case_sensitive: true });
    assert.equal(caseSensitive.content.match_count, 1);
    assert.equal(caseSensitive.content.results[0].path, 'a.txt');
    const regex = await call('search_workspace_files', { query: 'b.*a', is_regex: true });
    assert.ok(regex.content.match_count >= 1);
    const ctx = await call('search_workspace_files', { query: 'beta', context_lines: 1 });
    const ctxA = ctx.content.results.find((r) => r.path === 'a.txt');
    assert.deepEqual(ctxA.context_before, ['alpha']);
    assert.deepEqual(ctxA.context_after, ['gamma']);
    const limited = await call('search_workspace_files', { query: '.', is_regex: true, max_results: 1 });
    assert.equal(limited.content.truncated, true);
    const invalid = await call('search_workspace_files', { query: '[', is_regex: true });
    assert.equal(invalid.status, 'error');
    assert.equal(invalid.content.error_code, 'invalid_search_pattern');
    const empty = await call('search_workspace_files', { query: '   ' });
    assert.equal(empty.status, 'error');
    assert.match(empty.content.error_message, /query is required/);
  } finally { cleanup(); }
});

test('delete_workspace_file removes files and empty dirs and refuses root and non-empty dirs', async () => {
  const { call, workspaceRoot, cleanup } = setup();
  try {
    writeFileSync(join(workspaceRoot, 'f.txt'), 'x');
    const del = await call('delete_workspace_file', { path: 'f.txt' });
    assert.equal(del.status, 'ok');
    assert.equal(del.content.deleted, 'f.txt');
    mkdirSync(join(workspaceRoot, 'empty'), { recursive: true });
    const delDir = await call('delete_workspace_file', { path: 'empty' });
    assert.equal(delDir.status, 'ok');
    mkdirSync(join(workspaceRoot, 'full'), { recursive: true });
    writeFileSync(join(workspaceRoot, 'full/inner.txt'), 'x');
    const delNonEmpty = await call('delete_workspace_file', { path: 'full' });
    assert.equal(delNonEmpty.status, 'error');
    const delRoot = await call('delete_workspace_file', { path: '.' });
    assert.equal(delRoot.status, 'error');
    assert.match(delRoot.content.error_message, /root/);
    const delMissing = await call('delete_workspace_file', { path: 'nope.txt' });
    assert.equal(delMissing.status, 'error');
    assert.match(delMissing.content.error_message, /not found/);
  } finally { cleanup(); }
});
