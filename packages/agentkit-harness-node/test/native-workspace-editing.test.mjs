import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeWorkspaceTools } from '../src/native/workspace-tools.mjs';

function setup() {
  const base = mkdtempSync(join(tmpdir(), 'nws-edit-'));
  const workspaceRoot = join(base, 'workspace');
  const stateDir = join(base, 'state');
  mkdirSync(workspaceRoot, { recursive: true });
  const tools = createNativeWorkspaceTools({ workspaceRoot, stateDir, sessionId: 's1', authorize: async () => 'allow' });
  let seq = 0;
  const call = (name, args) => tools.execute({
    call: { callId: `c-${name}-${++seq}`, name, arguments: args },
    definition: tools.definitions.find((d) => d.name === name),
    operationKey: `op-${name}`,
    signal: new AbortController().signal,
    sessionId: 's1',
  });
  return { base, workspaceRoot, call, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

test('edit_workspace_file replaces exact text after a read and records the new revision', async () => {
  const { call, workspaceRoot, cleanup } = setup();
  try {
    writeFileSync(join(workspaceRoot, 'a.txt'), 'alpha\nbeta\ngamma\n');
    await call('read_workspace_file', { path: 'a.txt' });
    const r = await call('edit_workspace_file', { path: 'a.txt', old_text: 'beta', new_text: 'BETA' });
    assert.equal(r.status, 'ok');
    assert.equal(r.content.replacements, 1);
    assert.equal(r.content.path, 'a.txt');
    assert.equal(readFileSync(join(workspaceRoot, 'a.txt'), 'utf-8'), 'alpha\nBETA\ngamma\n');
    assert.equal(r.content.diff_additions, 1);
    assert.equal(r.content.diff_deletions, 1);
    assert.deepEqual(r.workspaceChangedPaths, ['a.txt']);
    // the edit recorded the new revision; a further edit needs no re-read
    const r2 = await call('edit_workspace_file', { path: 'a.txt', old_text: 'BETA', new_text: 'beta' });
    assert.equal(r2.status, 'ok');
  } finally { cleanup(); }
});

test('edit_workspace_file rejects an unread file with file_not_read', async () => {
  const { call, workspaceRoot, cleanup } = setup();
  try {
    writeFileSync(join(workspaceRoot, 'a.txt'), 'alpha\nbeta\n');
    const r = await call('edit_workspace_file', { path: 'a.txt', old_text: 'alpha', new_text: 'x' });
    assert.equal(r.status, 'error');
    assert.equal(r.content.error_type, 'file_not_read');
    // file unchanged
    assert.equal(readFileSync(join(workspaceRoot, 'a.txt'), 'utf-8'), 'alpha\nbeta\n');
  } finally { cleanup(); }
});

test('edit_workspace_file rejects a stale file modified since the read', async () => {
  const { call, workspaceRoot, cleanup } = setup();
  try {
    writeFileSync(join(workspaceRoot, 'a.txt'), 'alpha\nbeta\n');
    await call('read_workspace_file', { path: 'a.txt' });
    // external mutation after the read
    writeFileSync(join(workspaceRoot, 'a.txt'), 'alpha\nCHANGED\n');
    const r = await call('edit_workspace_file', { path: 'a.txt', old_text: 'alpha', new_text: 'x' });
    assert.equal(r.status, 'error');
    assert.equal(r.content.error_type, 'file_modified_since_read');
  } finally { cleanup(); }
});

test('edit_workspace_file reports snippet_not_found and ambiguous_edit', async () => {
  const { call, workspaceRoot, cleanup } = setup();
  try {
    writeFileSync(join(workspaceRoot, 'a.txt'), 'foo\nfoo\nbar\n');
    await call('read_workspace_file', { path: 'a.txt' });
    const missing = await call('edit_workspace_file', { path: 'a.txt', old_text: 'nope', new_text: 'x' });
    assert.equal(missing.status, 'error');
    assert.equal(missing.content.error_type, 'snippet_not_found');
    assert.ok(Array.isArray(missing.content.nearby_candidates));
    // 'foo' occurs twice; expected_replacements=1 by default -> ambiguous
    const ambig = await call('edit_workspace_file', { path: 'a.txt', old_text: 'foo', new_text: 'x' });
    assert.equal(ambig.status, 'error');
    assert.equal(ambig.content.error_type, 'ambiguous_edit');
    assert.equal(ambig.content.occurrences, 2);
    // expected_replacements=2 disambiguates
    const two = await call('edit_workspace_file', { path: 'a.txt', old_text: 'foo', new_text: 'x', expected_replacements: 2 });
    assert.equal(two.status, 'ok');
    assert.equal(two.content.replacements, 2);
    assert.equal(readFileSync(join(workspaceRoot, 'a.txt'), 'utf-8'), 'x\nx\nbar\n');
  } finally { cleanup(); }
});

test('edit_workspace_file replace_all replaces every occurrence', async () => {
  const { call, workspaceRoot, cleanup } = setup();
  try {
    writeFileSync(join(workspaceRoot, 'a.txt'), 'foo foo foo\n');
    await call('read_workspace_file', { path: 'a.txt' });
    const r = await call('edit_workspace_file', { path: 'a.txt', old_text: 'foo', new_text: 'bar', replace_all: true });
    assert.equal(r.status, 'ok');
    assert.equal(r.content.replacements, 3);
    assert.equal(readFileSync(join(workspaceRoot, 'a.txt'), 'utf-8'), 'bar bar bar\n');
  } finally { cleanup(); }
});

test('edit_workspace_file requires old_text', async () => {
  const { call, workspaceRoot, cleanup } = setup();
  try {
    writeFileSync(join(workspaceRoot, 'a.txt'), 'x\n');
    await call('read_workspace_file', { path: 'a.txt' });
    const r = await call('edit_workspace_file', { path: 'a.txt', old_text: '', new_text: 'y' });
    assert.equal(r.status, 'error');
    assert.equal(r.content.error_type, 'missing_old_text');
  } finally { cleanup(); }
});

test('edit_workspace_file tolerates smart/straight quote substitution', async () => {
  const { call, workspaceRoot, cleanup } = setup();
  try {
    writeFileSync(join(workspaceRoot, 'a.txt'), 'say “hello” now\n');
    await call('read_workspace_file', { path: 'a.txt' });
    // old_text uses straight quotes; text has smart quotes -> normalize and match
    const r = await call('edit_workspace_file', { path: 'a.txt', old_text: '"hello"', new_text: "'hi'" });
    assert.equal(r.status, 'ok');
    assert.equal(r.content.used_quote_normalization, true);
    assert.equal(readFileSync(join(workspaceRoot, 'a.txt'), 'utf-8'), "say 'hi' now\n");
  } finally { cleanup(); }
});

test('edit_workspace_file retains CRLF endings and untouched UTF-8 bytes', async () => {
  const { call, workspaceRoot, cleanup } = setup();
  try {
    const original = Buffer.from('# 前缀\r\nanswer = 1\r\nother = 2\r\n# 保留\r\n');
    writeFileSync(join(workspaceRoot, 'calc.py'), original);
    await call('read_workspace_file', { path: 'calc.py' });
    // old_text uses LF; the edit must adopt the file's CRLF convention and leave other bytes intact
    const r = await call('edit_workspace_file', {
      path: 'calc.py',
      old_text: 'answer = 1\nother = 2',
      new_text: 'answer = 42\nother = 2',
    });
    assert.equal(r.status, 'ok');
    const expected = Buffer.from('# 前缀\r\nanswer = 42\r\nother = 2\r\n# 保留\r\n');
    assert.equal(readFileSync(join(workspaceRoot, 'calc.py')).equals(expected), true);
  } finally { cleanup(); }
});

test('multi_edit_workspace_file applies sequential edits and reports per-edit diagnostics', async () => {
  const { call, workspaceRoot, cleanup } = setup();
  try {
    writeFileSync(join(workspaceRoot, 'a.txt'), 'one\ntwo\nthree\n');
    await call('read_workspace_file', { path: 'a.txt' });
    const r = await call('multi_edit_workspace_file', {
      path: 'a.txt',
      edits: [
        { old_text: 'one', new_text: '1' },
        { old_text: 'three', new_text: '3' },
      ],
    });
    assert.equal(r.status, 'ok');
    assert.equal(r.content.edit_count, 2);
    assert.equal(r.content.replacements, 2);
    assert.equal(r.content.edits.length, 2);
    assert.equal(readFileSync(join(workspaceRoot, 'a.txt'), 'utf-8'), '1\ntwo\n3\n');
  } finally { cleanup(); }
});

test('multi_edit_workspace_file is atomic: a failed edit leaves the file unchanged', async () => {
  const { call, workspaceRoot, cleanup } = setup();
  try {
    writeFileSync(join(workspaceRoot, 'a.txt'), 'one\ntwo\nthree\n');
    const before = readFileSync(join(workspaceRoot, 'a.txt'), 'utf-8');
    await call('read_workspace_file', { path: 'a.txt' });
    const r = await call('multi_edit_workspace_file', {
      path: 'a.txt',
      edits: [
        { old_text: 'one', new_text: '1' },
        { old_text: 'NOTHERE', new_text: 'x' },
      ],
    });
    assert.equal(r.status, 'error');
    assert.equal(r.content.error_type, 'snippet_not_found');
    assert.equal(r.content.failed_edit_index, 1);
    assert.equal(r.content.edit_count, 2);
    // the first edit must NOT have been committed
    assert.equal(readFileSync(join(workspaceRoot, 'a.txt'), 'utf-8'), before);
  } finally { cleanup(); }
});

test('multi_edit_workspace_file rejects invalid edits lists and items', async () => {
  const { call, workspaceRoot, cleanup } = setup();
  try {
    writeFileSync(join(workspaceRoot, 'a.txt'), 'x\n');
    await call('read_workspace_file', { path: 'a.txt' });
    const empty = await call('multi_edit_workspace_file', { path: 'a.txt', edits: [] });
    assert.equal(empty.status, 'error');
    assert.equal(empty.content.error_type, 'invalid_edits');
    const badItem = await call('multi_edit_workspace_file', { path: 'a.txt', edits: [{ old_text: 'x', new_text: 'y' }, 'notobject'] });
    assert.equal(badItem.status, 'error');
    assert.equal(badItem.content.error_type, 'invalid_edit');
    assert.equal(badItem.content.failed_edit_index, 1);
  } finally { cleanup(); }
});

test('write_workspace_file rejects overwriting a partially read file', async () => {
  const { call, workspaceRoot, cleanup } = setup();
  try {
    writeFileSync(join(workspaceRoot, 'a.txt'), 'l1\nl2\nl3\nl4\n');
    // partial read (only the first two lines)
    await call('read_workspace_file', { path: 'a.txt', start_line: 1, end_line: 2 });
    const r = await call('write_workspace_file', { path: 'a.txt', content: 'replaced\n' });
    assert.equal(r.status, 'error');
    assert.equal(r.content.error_type, 'file_not_fully_read');
    // a complete read then allows the overwrite
    await call('read_workspace_file', { path: 'a.txt' });
    const ok = await call('write_workspace_file', { path: 'a.txt', content: 'replaced\n' });
    assert.equal(ok.status, 'ok');
  } finally { cleanup(); }
});

test('a successful write satisfies the edit precondition without a re-read', async () => {
  const { call, workspaceRoot, cleanup } = setup();
  try {
    await call('write_workspace_file', { path: 'a.txt', content: 'hello\n' });
    // no read; the write recorded the revision
    const r = await call('edit_workspace_file', { path: 'a.txt', old_text: 'hello', new_text: 'world' });
    assert.equal(r.status, 'ok');
    assert.equal(readFileSync(join(workspaceRoot, 'a.txt'), 'utf-8'), 'world\n');
  } finally { cleanup(); }
});
