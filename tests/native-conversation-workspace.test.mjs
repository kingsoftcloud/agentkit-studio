import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeKernel, MemoryRunStore, emptyUsage, projectSessionHistory } from '@kingsoftcloud/agentkit-harness-core';
import { fixture, digest, scope } from './fixtures/native-core.mjs';
import { createNativeWorkspaceTools } from '@kingsoftcloud/agentkit-harness-node/native/workspace-tools';
import { committedWorkspaceCheckpoint } from '@kingsoftcloud/agentkit-harness-node/native/workspace-checkpoints';
import { createNativeToolAuthority } from '../src/providers/native-tool-authority.mjs';
import { nativeDshOwnership } from '@kingsoftcloud/agentkit-harness-node/native/dsh-turn-ownership';
import { NATIVE_DSH_TURN_CONTRACT } from '@kingsoftcloud/agentkit-harness-node/native/dsh-turn-contract';
import { nativeConversationWorkspaceCheckpoint } from '../src/providers/native-conversation-workspace.mjs';

async function history() {
  const root = mkdtempSync(join(tmpdir(), 'native-workspace-')), workspace = join(root, 'workspace'),
    stateDir = join(root, 'state'); mkdirSync(workspace);
  const store = new MemoryRunStore(), tools = createNativeWorkspaceTools({ workspaceRoot: workspace, stateDir,
    sessionId: 'session', authorize: async () => 'allow', enablePatches: true, enableRewind: true });
  const committed = row => committedWorkspaceCheckpoint(row, { store, scope, sessionId: 'session' });
  const authority = createNativeToolAuthority({ scope, sessionId: 'session', store });
  const sources = [], events = [], checkpoints = [];
  for (const turn of [1, 2]) {
    const runId = `native-dsh-${digest({ contract: NATIVE_DSH_TURN_CONTRACT, scope, sessionId: 'session', turn })}`;
    const { config, snapshot } = fixture({ tools: tools.definitions });
    const identity = { ...snapshot, sessionId: 'session', turnId: String(turn), runId };
    let calls = 0;
    const kernel = new NativeKernel({ store, digest, owner: `turn-${turn}`, ports: {
      workspace: tools,
      tools: { ...tools, execute: async request => {
        const result = await tools.execute(request, { checkpointCommitted: committed, assertCurrent: authority });
        tools.recordReceipt(request, result, { assertCurrent: authority });
        return result;
      } },
      model: { generate: async () => ++calls === 1 ? { kind: 'tool_calls', text: '', usage: emptyUsage(),
        toolCalls: [{ name: 'write_workspace_file', callId: `call-${turn}`, arguments: { path: `file-${turn}.txt`, content: `content ${turn}` } }] }
        : { kind: 'final_candidate', text: `Answer ${turn}`, toolCalls: [], usage: emptyUsage() } } } });
    kernel.start(identity, config); await kernel.runUntilIdle(scope, runId);
    const record = store.load(scope, runId); sources.push(record);
    const intent = record.intents.find(item => item.kind === 'tool');
    const call = intent.payload.calls[0];
    const receipt = record.receipts.find(item => item.operationKey === intent.operationKey && item.status === 'committed');
    const checkpointId = receipt.result.results[0].content.checkpoint_id;
    checkpoints.push({ id: checkpointId, seq: turn, status: 'completed', sessionId: 'session',
      binding: { scope, sessionId: 'session', runId, turnId: String(turn), buildId: record.snapshot.buildId,
        operationKey: intent.operationKey, executionFence: intent.claimedFence, callId: call.callId, toolName: call.name } });
    const messages = [{ id: `input-${turn}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `Input ${turn}` }] }];
    for (const event of [{ type: 'turn/start', data: { turn } },
      { type: 'turn/owner', data: nativeDshOwnership({ identity: Object.fromEntries(['scope', 'runId', 'sessionId', 'turnId', 'buildId', 'parentRunId', 'taskChainId']
        .map(key => [key, record.snapshot[key]])), configuration: config, input: { messages }, source: { provider: 'fixture', model: 'fixture' } }) },
      { type: 'user/message', data: messages[0] }, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } }])
      events.push({ ...event, seq: events.length });
  }
  const [first, head] = sources, prefix = events.slice(0, 6);
  const seed = { contract: 'native-conversation-fork/v1', source: { parentSessionId: 'session', sessionId: 'session', runId: first.snapshot.runId,
    turnId: '1', boundarySeq: 6, snapshotRevision: first.snapshot.revision, configDigest: first.snapshot.configDigest,
    snapshotDigest: digest(first.snapshot), transcriptDigest: 'prefix' }, messages: projectSessionHistory(first, first.configuration, digest, { identityNamespace: 'rewind' }) };
  return { root, scope, store, tools, sources, first, head, prefix, seed, events, checkpoints };
}

test('workspace checkpoint selection keeps closed turns and selects the earliest not-kept mutation', async t => {
  const h = await history(); t.after(() => rmSync(h.root, { recursive: true, force: true }));
  const select = (seed = h.seed, prefix = h.prefix) => nativeConversationWorkspaceCheckpoint({ store: h.store, scope: h.scope,
    record: h.head, seed, prefix, sourceEvents: h.events, checkpoints: h.checkpoints });
  assert.equal(select(), h.checkpoints[1].id, 'turn 1 is closed in prefix; turn 2 owner is in prefix without its input');
  assert.equal(select({ ...h.seed, messages: [] }), h.checkpoints[1].id, 'a closed turn is kept even when model history was compacted');
  assert.equal(select(h.seed, h.events.slice(0, 1)), h.checkpoints[0].id, 'before the first owner no turn is kept, so the earliest mutation is selected');
  assert.equal(select(h.seed, h.events.slice(0, 3)), h.checkpoints[1].id, 'a partial turn is kept when seed history points at its original call');
  assert.equal(select({ ...h.seed, messages: [] }, h.events.slice(0, 3)), h.checkpoints[0].id, 'a partial turn without its kept call is not retained');
  const ignored = [{ ...h.checkpoints[0], id: 'failed-row', seq: 0, status: 'failed' },
    { ...h.checkpoints[0], id: 'undone-row', seq: 0, status: 'undone' }, ...h.checkpoints];
  assert.equal(nativeConversationWorkspaceCheckpoint({ store: h.store, scope: h.scope, record: h.head,
    seed: h.seed, prefix: h.prefix, sourceEvents: h.events, checkpoints: ignored }), h.checkpoints[1].id,
    'failed and undone rows are ignored, not rejected');
  assert.throws(() => nativeConversationWorkspaceCheckpoint({ store: h.store, scope: h.scope, record: h.head,
    seed: h.seed, prefix: h.prefix, sourceEvents: h.events, checkpoints: [] }), { code: 'native_conversation_checkpoint_missing' },
  'a missing journal must not silently preserve removed successful file writes');
});

test('Host administrative control rows are skipped for Native selection', async t => {
  const h = await history(); t.after(() => rmSync(h.root, { recursive: true, force: true }));
  const controlRow = { id: 'control-row', seq: 0, status: 'completed', controlBinding: { contract: 'agentkit.native-conversation-workspace-control/v1',
    commandId: 'rewind', sessionId: 'session' } };
  const result = nativeConversationWorkspaceCheckpoint({ store: h.store, scope: h.scope, record: h.head, seed: h.seed,
    prefix: h.prefix, sourceEvents: h.events, checkpoints: [controlRow, ...h.checkpoints] });
  assert.equal(result, h.checkpoints[1].id, 'the control row is skipped; the earliest not-kept Native mutation is still selected');
});

test('a recovered original writer receipt still requires its private checkpoint', async t => {
  const h = await history(); t.after(() => rmSync(h.root, { recursive: true, force: true }));
  const store = { load(...args) {
    const record = structuredClone(h.store.load(...args));
    const original = record.intents.find(intent => intent.kind === 'tool');
    const receipt = record.receipts.find(item => item.operationKey === original.operationKey);
    const result = receipt.result.results[0]; receipt.status = 'uncertain'; receipt.result = {};
    record.intents.push({ kind: 'tool_receipt', operationKey: 'observed-original-writer', payload: {
      originalOperationKey: original.operationKey, originalClaimedFence: original.claimedFence, callId: original.payload.calls[0].callId } });
    record.receipts.push({ operationKey: 'observed-original-writer', status: 'committed', result: {
      contract: 'agentkit.tool-receipt-observation/v1', originalOperationKey: original.operationKey,
      callId: original.payload.calls[0].callId, result } });
    return record;
  } };
  assert.throws(() => nativeConversationWorkspaceCheckpoint({ store, scope: h.scope, record: h.head, seed: h.seed,
    prefix: h.prefix, sourceEvents: h.events, checkpoints: [] }), { code: 'native_conversation_checkpoint_missing' });
});

test('uncommitted, foreign and missing-owner checkpoint rows are rejected', async t => {
  const h = await history(); t.after(() => rmSync(h.root, { recursive: true, force: true }));
  const call = (checkpoints, sourceEvents = h.events) => nativeConversationWorkspaceCheckpoint({ store: h.store, scope: h.scope,
    record: h.head, seed: h.seed, prefix: h.prefix, sourceEvents, checkpoints });
  assert.throws(() => call([{ ...h.checkpoints[0], id: '00000000-0000-4000-8000-000000000000' }]),
    { code: 'native_conversation_checkpoint_uncommitted' }, 'a completed row without a committed Native receipt is rejected');
  assert.throws(() => call([{ ...h.checkpoints[0], binding: { ...h.checkpoints[0].binding, scope: { ...h.scope, workspaceId: 'other' } } }]),
    { code: 'native_conversation_checkpoint_uncommitted' }, 'a row bound to another scope is never imported from a fork');
  assert.throws(() => call(h.checkpoints, []), { code: 'native_conversation_checkpoint_source_unavailable' },
    'the source Run actual Native turn admission must be present');
  assert.throws(() => call([{ ...h.checkpoints[0], status: 'prepared' }]),
    { code: 'native_conversation_checkpoint_outcome_unknown' }, 'an unsettled outcome leaves the workspace unknown');
});
