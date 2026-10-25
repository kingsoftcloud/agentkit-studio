import test from 'node:test';
import assert from 'node:assert/strict';
import { canonical, planNativeContext, contextMessageRef, artifactToolDefinitions, configure } from '../dist/index.mjs';
import { bindNativeContext } from '../../../src/providers/native-context.mjs';
import { fixture, digest, tool } from './fixtures.mjs';

const counters = {
  countRequest: async (messages, tools) => Math.ceil(canonical({ messages, tools }).length / 4),
  countText: async text => Math.ceil(text.length / 4),
  countMessage: async message => Math.ceil(canonical(message).length / 4),
};
function scenario(overrides = {}) {
  const { config, snapshot } = fixture({ tools: [tool({ contextRole: 'workspace_read' }),
    tool({ name: 'write', readOnly: false, concurrentSafe: false }), ...artifactToolDefinitions()],
  profile: { ...fixture().config.profile, contextWindow: 6000, maxOutputTokens: 128 },
  contextPolicy: { tokenizerId: 'fixture', tokenizerDigest: 'fixture/v1', enabled: true, triggerRatio: .1, targetRatio: .02,
    summaryMaxTokens: 128, maxCompactions: 5, maxCompactionsWithoutProgress: 4, minModelTurnsBetween: 2, maxSummaryRetries: 1,
    readWorkingSetCount: 8, readWorkingSetMaxTokens: 6000, readWorkingSetTotalMaxTokens: 16000, ...overrides } });
  snapshot.workspaceRevision = 'workspace-1';
  snapshot.messages.push({ role: 'assistant', content: 'Historical reasoning. '.repeat(60) });
  return { config, snapshot };
}
function read(snapshot, id, start, end) {
  snapshot.messages.push({ role: 'assistant', content: '', toolCalls: [{ callId: id, name: 'read', arguments: { path: 'source.ts' } }] },
    { role: 'tool', name: 'read', callId: id, content: canonical({ status: 'ok', content: { ok: true, path: 'source.ts',
      content: `source lines ${start}-${end}`, read_range: { start, end } } }) });
}
function retained(planned, snapshot, callId) {
  const index = snapshot.messages.findIndex(message => message.role === 'tool' && message.callId === callId);
  return planned.state.compaction.retainedRefs.includes(contextMessageRef(snapshot.messages[index], index, digest));
}
function compact(run) {
  run.snapshot.messages.push({ role: 'assistant', content: 'Continue reasoning after observations.' });
  return planNativeContext(run.snapshot, run.config, run.config.tools, counters, digest, false, true);
}

test('compaction retains separate read ranges above the soft target and records the workspace revision', async () => {
  const run = scenario(); read(run.snapshot, 'first', 1, 20); read(run.snapshot, 'second', 21, 40);
  const planned = await compact(run);
  assert.equal(planned.action, 'compact');
  assert.ok(retained(planned, run.snapshot, 'first')); assert.ok(retained(planned, run.snapshot, 'second'));
  assert.equal(planned.state.compaction.workspaceRevision, 'workspace-1');
  assert.ok(planned.state.compaction.sourceText.includes('Historical reasoning'));
  planned.state.compaction.proposal = 'Historical notes.';
  assert.equal(planned.state.compaction.chunk.stop, planned.state.compaction.sourceText.length);
  run.snapshot.contextState = planned.state;
  const sealed = await planNativeContext(run.snapshot, run.config, run.config.tools, counters, digest, false, true);
  assert.equal(sealed.state.history.workspaceRevision, 'workspace-1');
  run.snapshot.contextState = sealed.state; run.snapshot.workspaceRevision = 'workspace-2'; run.snapshot.usage.modelCalls = 3;
  const next = await compact(run);
  assert.equal(next.action, 'compact');
  assert.equal(retained(next, run.snapshot, 'first'), false); assert.equal(retained(next, run.snapshot, 'second'), false);
});

test('workspace mutation invalidates earlier reads while immutable observed artifact pages survive', async () => {
  const run = scenario(); read(run.snapshot, 'stale', 1, 20);
  const ref = { uri: 'artifact://source/page', digest: `sha256:${'a'.repeat(64)}`, sizeBytes: 100, mediaType: 'text/plain', metadata: {} };
  run.snapshot.artifactRefs.push(ref);
  run.snapshot.messages.push({ role: 'assistant', content: '', toolCalls: [{ callId: 'page', name: 'ArtifactRead', arguments: { uri: ref.uri } }] },
    { role: 'tool', name: 'ArtifactRead', callId: 'page', content: canonical({ uri: ref.uri, offset_chars: 0,
      returned_chars: 4, content: 'code', next_offset: null, result_truncated: false }) },
    { role: 'assistant', content: '', toolCalls: [{ callId: 'edit', name: 'write', arguments: {} }] },
    { role: 'tool', name: 'write', callId: 'edit', content: canonical({ ok: true }) });
  read(run.snapshot, 'fresh', 21, 40);
  const planned = await compact(run);
  assert.equal(planned.action, 'compact');
  assert.equal(retained(planned, run.snapshot, 'stale'), false);
  assert.ok(retained(planned, run.snapshot, 'fresh')); assert.ok(retained(planned, run.snapshot, 'page'));
});

test('source identity and token ceilings retain atomic groups without exceeding the hard request', async () => {
  for (const policy of [{ readWorkingSetCount: 1 }, { readWorkingSetMaxTokens: 1 }, { readWorkingSetTotalMaxTokens: 1 }]) {
    const run = scenario(policy); read(run.snapshot, 'first', 1, 20); read(run.snapshot, 'second', 21, 40);
    const planned = await compact(run);
    assert.equal(planned.action, 'compact'); assert.equal(retained(planned, run.snapshot, 'first'), false);
    assert.equal(retained(planned, run.snapshot, 'second'), policy.readWorkingSetCount === 1);
    assert.ok(planned.state.compaction.chunk.countedInputTokens + 128 <= run.config.profile.contextWindow);
  }
});

test('fresh Studio bindings receive bounded source defaults; restored policies keep absent fields', () => {
  const description = { protocol: 'openai-chat', modelName: 'test', contextWindow: 32000, maxOutputTokens: 1000 };
  const fresh = bindNativeContext({ description, readWorkingSetDefaults: true, recentToolBatchDefaults: true }).policy;
  assert.deepEqual([fresh.readWorkingSetCount, fresh.readWorkingSetMaxTokens, fresh.readWorkingSetTotalMaxTokens], [8, 6000, 16000]);
  assert.deepEqual([fresh.recentToolBatchCount, fresh.recentToolBatchMaxTokens, fresh.recentToolBatchesTotalMaxTokens], [4, 5333, 8000]);
  const restored = bindNativeContext({ description }).policy;
  assert.equal(Object.hasOwn(restored, 'readWorkingSetCount'), false);
  assert.equal(Object.hasOwn(restored, 'recentToolBatchCount'), false);
  const run = scenario();
  assert.throws(() => configure({ ...run.config, contextPolicy: { ...run.config.contextPolicy, readWorkingSetMaxTokens: -1 } }),
    /invalid_context_working_set_policy/);
});

test('new retention keeps a chronological suffix instead of replaying small older reasoning across a dropped recent unit', async () => {
  const run = scenario({ triggerRatio: .5, targetRatio: .45, readWorkingSetCount: 0, recentToolBatchCount: 1,
    recentToolBatchMaxTokens: 512, recentToolBatchesTotalMaxTokens: 512 });
  const older = run.snapshot.messages.length;
  run.snapshot.messages.push({ role: 'assistant', content: 'OLDER_SMALL_REASONING' }, { role: 'assistant', content: 'x'.repeat(12000) });
  const planned = await compact(run);
  assert.equal(planned.action, 'compact');
  assert.equal(planned.state.compaction.retainedRefs.includes(contextMessageRef(run.snapshot.messages[older], older, digest)), false);
  assert.ok(planned.state.compaction.sourceText.includes('OLDER_SMALL_REASONING'));
});

test('complete granted artifact search observations can survive compaction but clipped feedback cannot claim complete source identity', async () => {
  for (const complete of [true, false]) {
    const run = scenario(), ref = { uri: 'artifact://source/search', digest: `sha256:${'b'.repeat(64)}`, sizeBytes: 10,
      mediaType: 'text/plain', metadata: {} };
    run.snapshot.artifactRefs.push(ref);
    run.snapshot.messages.push({ role: 'assistant', content: '', toolCalls: [{ callId: 'search', name: 'ArtifactSearch',
      arguments: { uris: [ref.uri], query: 'code' } }] }, { role: 'tool', name: 'ArtifactSearch', callId: 'search',
      content: canonical({ observation_type: 'scoped-artifact-search/v1', query: 'code', complete, results: [{ uri: ref.uri,
        coordinate_space: 'artifact', complete, matches: [{ offset_chars: 0, excerpt: 'code', excerpt_truncated: !complete }] }] }) });
    const planned = await compact(run);
    assert.equal(planned.action, 'compact'); assert.equal(retained(planned, run.snapshot, 'search'), complete);
  }
});
