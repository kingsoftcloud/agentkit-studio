import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeWorkspaceTools } from '../src/native/workspace-tools.mjs';
import { prepareWorkspaceEdits } from '../src/native/workspace-edit-match.mjs';
import { NativeKernel, emptyUsage } from '../../agentkit-harness-core/dist/index.mjs';
import { fixture, scope, digest } from '../../agentkit-harness-core/test/fixtures.mjs';
import { SqliteRunStore } from '../src/native/sqlite-store.mjs';

function setup(t, text, { policy = true, authorize = async () => 'allow' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'native-zcode-edit-')), workspace = join(root, 'workspace');
  mkdirSync(workspace); const path = join(workspace, 'a.txt'); if (text !== undefined) writeFileSync(path, text);
  const create = () => createNativeWorkspaceTools({ workspaceRoot: workspace, stateDir: join(root, 'state'), sessionId: 'session', authorize });
  const port = create();
  let seq = 0;
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const call = (name, args, options = {}) => port.execute({ sessionId: 'session', operationKey: `op-${++seq}`,
    call: { name, callId: `call-${seq}`, arguments: { path: 'a.txt', ...args } },
    definition: { ...port.definitions.find(item => item.name === name),
      ...(policy && ['edit_workspace_file', 'multi_edit_workspace_file'].includes(name) ? { workspaceEditPolicy: typeof policy === 'string' ? policy : 'zcode-match/v1' } : {}) },
    signal: new AbortController().signal, ...options });
  return { root, port, create, path, call, read: () => readFileSync(path, 'utf8') };
}

const cases = [
  ['exact', 'keep\nold\n', 'old', '$& $$ $`', 'keep\n$& $$ $`\n'],
  ['quote_normalized', 'say “hello”\n', '"hello"', '"bye"', 'say “bye”\n'],
  ['line_number_prefix_stripped', 'one\ntwo\n', '1: one\n2: two', 'done', 'done\n'],
  ['escape_normalized', 'one\n\ttwo\n', 'one\\n\\ttwo', 'new\\n\\tvalue', 'new\n\tvalue\n'],
  ['unicode_escape_normalized', '你好\n', '\\u4f60\\u597d', '完成', '完成\n'],
  ['line_trimmed', '  one\n    two\n', 'one\ntwo', 'done', 'done\n'],
  ['indentation_flexible', '  one\n    two\n', 'one\n  two', 'done', 'done\n'],
  ['block_anchor', 'begin\nhello world\nend\n', 'begin\nhello worle\nend', 'done', 'done\n'],
  ['exact', 'keep\r\nremove\r\nlast\r\n', 'remove', '', 'keep\r\nlast\r\n'],
];
// line_trimmed precedes indentation_flexible in the reference. The indentation
// case therefore resolves through line_trimmed; both strategies remain upstream.
for (const [strategy, content, old_text, new_text, expected] of cases) test(`owned workspace uses ZCode ${strategy} matching`, async t => {
  const f = setup(t, content); await f.call('read_workspace_file', {});
  const result = await f.call('edit_workspace_file', { old_text, new_text });
  assert.equal(result.status, 'ok', JSON.stringify(result)); assert.equal(f.read(), expected);
  assert.equal(result.content.match_strategy, strategy === 'indentation_flexible' ? 'line_trimmed' : strategy);
});

test('v2 empty-old-text edit creates an absent nested file and establishes full read authority', async t => {
  const f = setup(t, undefined, { policy: 'zcode-match/v2' });
  const args = { path: 'nested/new.txt', old_text: '', new_text: 'first\r\nsecond\r\n' };
  const created = await f.call('edit_workspace_file', args);
  assert.equal(created.status, 'ok', JSON.stringify(created));
  assert.equal(readFileSync(join(f.root, 'workspace/nested/new.txt'), 'utf8'), 'first\nsecond\n');
  assert.equal(created.content.diff_additions, 2);
  const next = await f.call('edit_workspace_file', { ...args, old_text: 'second', new_text: 'updated' });
  assert.equal(next.status, 'ok', 'a committed creation supplies the next edit read state');
  assert.equal(readFileSync(join(f.root, 'workspace/nested/new.txt'), 'utf8'), 'first\nupdated\n');
});

test('v2 observed absence never authorizes overwriting a file created before publication', async t => {
  for (const afterCheck of [1, 3]) {
    const f = setup(t, undefined, { policy: 'zcode-match/v2' }); let checks = 0;
    const definition = { ...f.port.definitions.find(tool => tool.name === 'edit_workspace_file'), workspaceEditPolicy: 'zcode-match/v2' };
    const request = { sessionId: 'session', operationKey: 'race', call: { name: definition.name, callId: 'race',
      arguments: { path: 'a.txt', old_text: '', new_text: 'must not publish' } }, definition, signal: new AbortController().signal };
    const result = await f.port.execute(request, { assertCurrent() {
      if (++checks === afterCheck) writeFileSync(f.path, 'external creator');
      return true;
    } });
    assert.equal(result.status, 'error'); assert.equal(result.content.error_type, 'file_modified_since_read');
    assert.equal(f.read(), 'external creator');
  }
});

test('v2 fills only full-fresh-read whitespace files and preserves their newline convention', async t => {
  for (const [before, expected] of [['', 'new\nline\n'], [' \r\n\t\r\n', 'new\r\nline\r\n'],
    ['\r\n\n\n', 'new\nline\n'], ['\r\n\n', 'new\nline\n']]) {
    const f = setup(t, before, { policy: 'zcode-match/v2' });
    const args = { old_text: '', new_text: 'new\nline\n' };
    assert.equal((await f.call('edit_workspace_file', args)).content.error_type, 'file_not_read');
    await f.call('read_workspace_file', {});
    const result = await f.call('edit_workspace_file', args); assert.equal(result.status, 'ok', JSON.stringify(result));
    assert.equal(f.read(), expected);
    assert.equal((await f.call('edit_workspace_file', args)).content.error_type, 'file_exists_no_old_text');
    assert.equal(f.read(), expected);
  }
});

test('v2 retains stale, partial, no-change and nonblank protections for empty-old-text edits', async t => {
  const f = setup(t, ' \n\n', { policy: 'zcode-match/v2' }), args = { old_text: '', new_text: 'new' };
  await f.call('read_workspace_file', { start_line: 1, end_line: 1 });
  assert.equal((await f.call('edit_workspace_file', args)).content.error_type, 'file_not_fully_read');
  await f.call('read_workspace_file', {}); writeFileSync(f.path, '\t\n');
  assert.equal((await f.call('edit_workspace_file', args)).content.error_type, 'file_modified_since_read');
  const none = setup(t, undefined, { policy: 'zcode-match/v2' });
  assert.equal((await none.call('edit_workspace_file', { old_text: '', new_text: 'new', expected_replacements: 2 })).content.error_type, 'ambiguous_edit');
  assert.equal((await none.call('edit_workspace_file', { old_text: '', new_text: '' })).content.error_type, 'no_change');
  assert.throws(() => none.read(), { code: 'ENOENT' });
  const existing = setup(t, 'source code', { policy: 'zcode-match/v2' });
  assert.equal((await existing.call('edit_workspace_file', args)).content.error_type, 'file_exists_no_old_text', 'nonblank refusal precedes read-state validation as in ZCode');
  await existing.call('read_workspace_file', {});
  assert.equal((await existing.call('edit_workspace_file', args)).content.error_type, 'file_exists_no_old_text');
  assert.equal(existing.read(), 'source code');
});

test('v1 and legacy Runs never acquire empty-old-text creation and v2 multi-edit is unchanged', async t => {
  for (const policy of [false, 'zcode-match/v1']) {
    const f = setup(t, '', { policy }); await f.call('read_workspace_file', {});
    assert.equal((await f.call('edit_workspace_file', { old_text: '', new_text: 'new' })).content.error_type, 'missing_old_text');
    assert.equal(f.read(), '');
  }
  const f = setup(t, '', { policy: 'zcode-match/v2' }); await f.call('read_workspace_file', {});
  assert.equal((await f.call('multi_edit_workspace_file', { edits: [{ old_text: '', new_text: 'new' }] })).content.error_type, 'missing_old_text');
  assert.equal(f.read(), '');
});

test('v2 creation rejects denial, abort and path escape without publication', async t => {
  const f = setup(t, undefined, { policy: 'zcode-match/v2', authorize: async () => 'deny' }), args = { old_text: '', new_text: 'new' };
  assert.equal((await f.call('edit_workspace_file', args)).content.code, 'policy_denied');
  const allowed = setup(t, undefined, { policy: 'zcode-match/v2' }), controller = new AbortController(); controller.abort();
  assert.equal((await allowed.call('edit_workspace_file', args, { signal: controller.signal })).content.code, 'canceled');
  assert.equal((await allowed.call('edit_workspace_file', { ...args, path: '../escape.txt' })).content.error_type, 'path_escape');
  assert.throws(() => allowed.read(), { code: 'ENOENT' }); assert.throws(() => f.read(), { code: 'ENOENT' });
});

test('legacy absence keeps quote replacement and missing-prefix behavior unchanged', async t => {
  const f = setup(t, 'say “hello”\n', { policy: false }); await f.call('read_workspace_file', {});
  assert.equal((await f.call('edit_workspace_file', { old_text: '1: say “hello”', new_text: 'x' })).status, 'error');
  assert.equal((await f.call('edit_workspace_file', { old_text: '"hello"', new_text: '"bye"' })).status, 'ok');
  assert.equal(f.read(), 'say "bye"\n');
});

test('different normalized fragments remain ambiguous even for replace_all; broad replacement is not enabled by replace_all', async t => {
  const f = setup(t, '“value”\n”value“\n'); await f.call('read_workspace_file', {});
  const result = await f.call('edit_workspace_file', { old_text: '"value"', new_text: 'x', replace_all: true });
  assert.equal(result.content.error_type, 'ambiguous_edit'); assert.equal(f.read(), '“value”\n”value“\n');
  const broad = setup(t, '  abc\n'); await broad.call('read_workspace_file', {});
  assert.equal((await broad.call('edit_workspace_file', { old_text: 'abc  ', new_text: 'x', replace_all: true })).status, 'error');
  assert.equal(broad.read(), '  abc\n');
});

test('sequential multi-edits retain all-or-none publication and CRLF/unrelated bytes', async t => {
  const f = setup(t, 'prefix\r\n  one\r\n尾部\n'); await f.call('read_workspace_file', {});
  const edits = [{ old_text: '2:   one', new_text: 'two' }, { old_text: 'missing', new_text: 'x' }];
  const failed = await f.call('multi_edit_workspace_file', { edits });
  assert.equal(failed.content.failed_edit_index, 1); assert.equal(f.read(), 'prefix\r\n  one\r\n尾部\n');
  edits[1] = { old_text: 'two', new_text: 'three\nfour' };
  assert.equal((await f.call('multi_edit_workspace_file', { edits })).status, 'ok');
  assert.equal(f.read(), 'prefix\r\nthree\r\nfour\r\n尾部\n');
});

test('new matching retains unread, stale, denial and cancellation boundaries', async t => {
  const f = setup(t, 'old\n');
  assert.equal((await f.call('edit_workspace_file', { old_text: 'old', new_text: 'new' })).content.error_type, 'file_not_read');
  await f.call('read_workspace_file', {}); writeFileSync(f.path, 'external\n');
  assert.equal((await f.call('edit_workspace_file', { old_text: 'old', new_text: 'new' })).content.error_type, 'file_modified_since_read');
  assert.equal(f.read(), 'external\n');
  const denied = setup(t, 'old\n', { authorize: async () => 'deny' }); await denied.call('read_workspace_file', {});
  assert.equal((await denied.call('edit_workspace_file', { old_text: 'old', new_text: 'new' })).content.code, 'policy_denied');
  const controller = new AbortController(); controller.abort();
  assert.equal((await f.call('edit_workspace_file', { old_text: 'external', new_text: 'new' }, { signal: controller.signal })).content.code, 'canceled');
  assert.equal(denied.read(), 'old\n');
});

test('bounded worker terminates expensive matching without blocking the parent event loop', async () => {
  const input = { text: `begin\n${'a'.repeat(200000)}\nend`, relative: 'a.txt',
    edits: [{ old_text: `begin\n${'b'.repeat(200000)}\nend`, new_text: 'x' }] };
  let responsive = false; const tick = setTimeout(() => { responsive = true; }, 5);
  assert.equal(await prepareWorkspaceEdits(input, { timeoutMs: 50 }), null);
  clearTimeout(tick); assert.equal(responsive, true);
});

test('external changes during worker preparation are rejected again before publication', async t => {
  let f;
  f = setup(t, 'old\n', { authorize: async () => {
    setTimeout(() => writeFileSync(f.path, 'external\n'), 0); return 'allow';
  } });
  await f.call('read_workspace_file', {});
  const result = await f.call('edit_workspace_file', { old_text: '1: old', new_text: 'new' });
  assert.equal(result.status, 'error'); assert.equal(result.content.error_type, 'file_modified_since_read');
  assert.equal(f.read(), 'external\n');
});

test('cancellation while the matcher is running publishes nothing', async t => {
  const f = setup(t, 'old\n'); await f.call('read_workspace_file', {});
  const controller = new AbortController();
  const pending = f.call('edit_workspace_file', { old_text: '1: old', new_text: 'new' }, { signal: controller.signal });
  const timer = setTimeout(() => controller.abort(), 1);
  assert.equal((await pending).content.code, 'canceled'); clearTimeout(timer); assert.equal(f.read(), 'old\n');
});

test('SQLite approval and workspace reopen retain the frozen matcher and commit one actual edit', async t => {
  const f = setup(t, 'old\n', { authorize: async () => 'approval_required' }), database = join(f.root, 'runs.sqlite');
  let store = new SqliteRunStore(database); t.after(() => store.close());
  const tools = f.port.definitions.map(tool => tool.name === 'edit_workspace_file' ? { ...tool, workspaceEditPolicy: 'zcode-match/v1' } : tool);
  const { config, snapshot } = fixture({ tools });
  const model = { generate: async request => {
    const results = request.messages.filter(message => message.role === 'tool');
    if (results.length < 2) return { kind: 'tool_calls', text: '', usage: emptyUsage(), toolCalls: [{
      name: results.length ? 'edit_workspace_file' : 'read_workspace_file', callId: results.length ? 'edit' : 'read',
      arguments: results.length ? { path: 'a.txt', old_text: '1: old', new_text: 'new' } : { path: 'a.txt' },
    }] };
    assert.match(results.at(-1).content, /line_number_prefix_stripped/);
    return { kind: 'final_candidate', text: 'Edited', toolCalls: [], usage: emptyUsage() };
  } };
  const first = new NativeKernel({ store, digest, owner: 'first', ports: { model, tools: f.port, workspace: f.port } });
  first.start(snapshot, config); const waiting = await first.runUntilIdle(scope, 'run');
  assert.equal(waiting.phase, 'awaiting_interaction'); assert.equal(f.read(), 'old\n');
  store.close(); store = new SqliteRunStore(database); const port = f.create();
  const second = new NativeKernel({ store, digest, owner: 'second', ports: { model, tools: port, workspace: port } });
  second.submit(scope, 'run', { commandId: 'approve', kind: 'submit_interaction', payload: {
    interactionId: waiting.pendingInteraction.interactionId, decision: 'allow' } });
  const done = await second.runUntilIdle(scope, 'run'); assert.equal(done.phase, 'completed'); assert.equal(f.read(), 'new\n');
  assert.equal(store.load(scope, 'run').configuration.tools.find(tool => tool.name === 'edit_workspace_file').workspaceEditPolicy, 'zcode-match/v1');
  assert.equal(store.load(scope, 'run').receipts.filter(row => row.result.results?.[0]?.content?.match_strategy === 'line_number_prefix_stripped').length, 1);
  assert.equal((await second.runUntilIdle(scope, 'run')).phase, 'completed'); assert.equal(f.read(), 'new\n');
});
