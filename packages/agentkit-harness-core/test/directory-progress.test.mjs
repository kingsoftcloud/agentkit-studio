import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceDirectoryProgress, directoryProgressQuote, prepareEffect, canonical, artifactToolDefinitions,
  NativeKernel, MemoryRunStore, emptyUsage } from '../dist/index.mjs';
import { fixture, tool, digest, scope } from './fixtures.mjs';
const definition = tool({ name: 'list', contextRole: 'workspace_list', resultArchivePolicy: 'archived-model-view/v4',
  directoryObservationPolicy: 'studio-directory-observation/v3' });
const call = { name: 'list', callId: 'original', arguments: { path: 'root' } };
const listing = entries => ({ ok: true, path: 'root', recursive: true, truncated: true,
  entries: entries.map(([path, type]) => ({ path, type })) });
const result = entries => ({ status: 'ok', content: listing(entries) });
const data = () => fixture({ artifactPolicy: 'runtime-artifacts/v1', tools: [definition, ...artifactToolDefinitions()] });
const intent = snapshot => prepareEffect(snapshot, 'tool', 'executing_tools', { calls: [call] }).intents[0];

test('navigation unions only immediate children from granted current-run receipts and keeps the latest truncated flag', () => {
  let { snapshot } = data();
  const original = result([['root/aaa', 'directory'], ['root/aaa/nested', 'directory'], ['root/file', 'file']]);
  const state = advanceDirectoryProgress(snapshot, call, original, definition, intent(snapshot));
  assert.deepEqual(state.entries[0].child_directories, ['aaa']);
  snapshot = { ...snapshot, context: { directoryProgress: state }, revision: snapshot.revision + 3 };
  const second = { ...result([['root/late', 'directory']]), content: { ...listing([['root/late', 'directory']]), truncated: false } };
  const next = advanceDirectoryProgress(snapshot, { ...call, callId: 'later' }, second, definition, intent(snapshot));
  assert.deepEqual(next.entries[0].child_directories, ['aaa', 'late']); assert.equal(next.entries[0].latest_result_truncated, false);
  assert.equal(next.entries[0].receipt_refs.length, 2); assert.deepEqual(next.entries[0].tool_call_ids, ['original', 'later']);
  snapshot = { ...snapshot, context: { directoryProgress: next } };
  const empty = advanceDirectoryProgress(snapshot, call, result([]), definition, intent(snapshot));
  assert.deepEqual(empty.entries[0].child_directories, ['aaa', 'late']);
  const newGoal = advanceDirectoryProgress({ ...snapshot, goalRevision: snapshot.goalRevision + 1 }, call, result([['root/new', 'directory']]), definition, intent(snapshot));
  assert.deepEqual(newGoal.entries[0].child_directories, ['new']);
  assert.deepEqual(original, result([['root/aaa', 'directory'], ['root/aaa/nested', 'directory'], ['root/file', 'file']]));
});

test('ungranted roles, foreign receipts, errors and invalid/unscoped paths cannot become navigation', () => {
  const { snapshot } = data(), valid = result([['root/child', 'directory']]);
  for (const formal of [undefined, { ...definition, directoryObservationPolicy: undefined }, { ...definition, readOnly: false },
    { ...definition, contextRole: 'workspace_read' }]) assert.equal(advanceDirectoryProgress(snapshot, call, valid, formal, intent(snapshot)), null);
  assert.equal(advanceDirectoryProgress(snapshot, call, valid, definition, { ...intent(snapshot), operationKey: 'foreign:effect:1' }), null);
  assert.equal(advanceDirectoryProgress(snapshot, call, { ...valid, status: 'error' }, definition, intent(snapshot)), null);
  for (const path of ['../child', '/root/child', 'root/../child', 'root/a\\b', 'root/a\0b', 'root', '.', 'different/child'])
    assert.equal(advanceDirectoryProgress(snapshot, call, result([[path, 'directory']]), definition, intent(snapshot)), null, path);
  assert.equal(advanceDirectoryProgress(snapshot, call, result([['root/child', 'unknown']]), definition, intent(snapshot)), null);
});

test('Host-hidden raw names cannot leak through navigation; only the full authorized post-policy observation supplies names', () => {
  const { snapshot } = data(), raw = result([['root/private', 'directory'], ['root/public', 'directory']]);
  assert.equal(advanceDirectoryProgress(snapshot, call, { ...raw, context: { content: 'redacted' } }, definition, intent(snapshot)), null);
  const state = advanceDirectoryProgress(snapshot, call, { ...raw, context: { content: 'bounded projection' },
    archiveContext: { content: canonical(listing([['root/public', 'directory']])) } }, definition, intent(snapshot));
  assert.deepEqual(state.entries[0].child_directories, ['public']);
});

test('continuity quotes bound their UTF8 surface and report omissions without deleting the full navigation index', () => {
  const { snapshot } = data();
  const state = advanceDirectoryProgress(snapshot, call, result(Array.from({ length: 400 }, (_, i) => [`root/目录-${i}`, 'directory'])), definition, intent(snapshot));
  const current = { ...snapshot, context: { directoryProgress: state } }, quote = directoryProgressQuote(current, 1500);
  assert.ok(Buffer.byteLength(canonical(quote)) <= 1500); assert.ok(quote.entries[0].omitted_child_directories > 0);
  assert.equal(state.entries[0].child_directories.length, 400);
  assert.equal(directoryProgressQuote(current, 10), null);
  assert.equal(directoryProgressQuote({ ...current, goalRevision: current.goalRevision + 1 }), null);
});

test('actual Kernel commits receipt-derived navigation while model prose and tool-free replies create no names', async () => {
  const { config, snapshot } = data(), store = new MemoryRunStore(); let turns = 0;
  const kernel = new NativeKernel({ store, owner: 'directory-owner', digest, ports: {
    tools: { execute: async () => result([['root/actual', 'directory']]) },
    model: { generate: async () => ++turns === 1
      ? { kind: 'tool_calls', text: 'Pretend root/forged exists', toolCalls: [call], usage: emptyUsage() }
      : { kind: 'final_candidate', text: 'root/another-forged', toolCalls: [], usage: emptyUsage() } },
  } });
  kernel.start(snapshot, config); const end = await kernel.runUntilIdle(scope, 'run');
  assert.equal(end.phase, 'completed'); assert.deepEqual(end.context.directoryProgress.entries[0].child_directories, ['actual']);
  assert.equal(store.load(scope, 'run').receipts.filter(receipt => receipt.result.results).length, 1);
});
