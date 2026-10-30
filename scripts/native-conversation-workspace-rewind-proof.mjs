import { createRequire } from 'node:module';
/** Actual packed Host: preview, files-first cut, repeated root cut and cold use. */
import assert from 'node:assert/strict';
import { readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseNativeJson } from '@kingsoftcloud/agentkit-harness-core';

export function createConversationWorkspaceRewindProof({ active = false } = {}) {
  const secondReady = Promise.withResolvers();
  async function respond({ request, response, raw, requests }) {
    assert.equal(request.url, '/v1/chat/completions'); const body = JSON.parse(raw); requests.push(body);
    const count = requests.length; assert.ok(count <= 7);
    if (active && count === 4) { secondReady.resolve(); return; }
    if (count >= 5) assert.doesNotMatch(JSON.stringify(body.messages), /Remove workspace turn|Removed workspace answer/);
    if (count === 7) assert.doesNotMatch(JSON.stringify(body.messages), /Keep workspace turn|Kept workspace answer|Continue retained workspace/);
    if (count === 6) assert.match(body.messages.filter(message => message.role === 'tool').at(-1).content, /Kept bytes/);
    const call = count === 1 ? { name: 'write_workspace_file', arguments: { path: 'kept.txt', content: 'Kept bytes' } }
      : count === 3 ? { name: 'write_workspace_file', arguments: { path: 'removed.txt', content: 'Removed bytes' } }
        : count === 5 ? { name: 'read_workspace_file', arguments: { path: 'kept.txt' } } : null;
    const answers = { 2: 'Kept workspace answer', 4: 'Removed workspace answer', 6: 'Retained workspace verified', 7: 'Root combined rewind verified' };
    const delta = call ? { tool_calls: [{ index: 0, id: `combined-${count}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] }
      : { content: answers[count] };
    response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
    response.end(`data: ${JSON.stringify({ id: `combined-${count}`, choices: [{ index: 0, delta, finish_reason: call ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 7 } })}\n\ndata: [DONE]\n\n`);
  }
  async function run({ harness: initial, DeepSeekHarness, options, root, installed, requests, failures }) {
    let harness = initial;
    const sessionId = 'native-studio-session';
    const { SqliteRunStore } = await import(pathToFileURL(createRequire(join(installed, 'package.json')).resolve('@kingsoftcloud/agentkit-harness-node/native/sqlite-store')).href);
    const load = (scope, runId) => { const store = new SqliteRunStore(join(root, 'studio/native-harness/runs.sqlite'));
      try { return store.load(scope, runId ?? store.sessionHead(scope, sessionId).runId); } finally { store.close(); } };
    const rpc = async (method, payload, ok = true) => {
      const { origin, cookie } = JSON.parse(await readFile(join(root, 'mounted-host-connection.json'), 'utf8'));
      const response = await fetch(origin + '/agentkit', { method: 'POST', headers: { origin, cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ method, payload }), signal: AbortSignal.timeout(15000) });
      assert.equal(response.status, 200); const result = (await response.json()).result;
      if (ok) assert.equal(result.ok, true, JSON.stringify(result)); else assert.equal(result.ok, false);
      return ok ? result.value : result.error;
    };
    try {
      const first = await harness.session(sessionId).run('Keep workspace turn'); assert.equal(first.finalResponse, 'Kept workspace answer');
      const scope = parseNativeJson(first.events.find(event => event.type === 'turn/owner').data.binding).identity.scope;
      const identity = { agentId: scope.agentId, sessionId }, kept = load(scope);
      const second = harness.session(sessionId).run('Remove workspace turn'); second.catch(() => {});
      if (active) {
        let timer;
        try { await Promise.race([secondReady.promise, new Promise((_, reject) => {
          timer = setTimeout(() => reject(Error('active workspace turn not observed')), 20000);
        })]); } finally { clearTimeout(timer); }
      } else assert.equal((await second).finalResponse, 'Removed workspace answer');
      let removed = load(scope);
      const status = await rpc('sessions/native-conversation-status', identity);
      assert.equal(status.canRewindWorkspace, true);
      const request = { ...identity, expectedHeadRunId: status.headRunId, expectedGeneration: status.generation, scope: 'both',
        commandId: 'actual-combined-cut', targetMessageId: status.inputs.find(input => input.text === 'Remove workspace turn').messageId };
      const preview = await rpc('sessions/native-conversation-workspace-preview', request);
      if (active) { await second; removed = load(scope); assert.equal(removed.snapshot.phase, 'canceled');
        assert.ok(removed.receipts.some(receipt => receipt.status === 'uncertain'), 'Canceled model usage is preserved'); }
      assert.equal(preview.canApply, true); assert.deepEqual(preview.files.map(file => file.path), ['removed.txt']);
      assert.equal(await readFile(join(root, 'workspace/removed.txt'), 'utf8'), 'Removed bytes');
      const cutRequest = { ...request, workspacePreviewToken: preview.previewToken };
      await writeFile(join(root, 'workspace/removed.txt'), 'External bytes');
      assert.equal((await rpc('sessions/native-conversation-rewind', cutRequest, false)).code, 'checkpoint_rewind_conflict');
      assert.equal((await rpc('sessions/native-conversation-status', identity)).generation, 0);
      assert.equal(await readFile(join(root, 'workspace/removed.txt'), 'utf8'), 'External bytes');
      await writeFile(join(root, 'workspace/removed.txt'), 'Removed bytes');
      const applied = await rpc('sessions/native-conversation-rewind', cutRequest); assert.equal(applied.generation, 1);
      assert.deepEqual(applied.workspaceCleanup.changedPaths, ['removed.txt']);
      await assert.rejects(access(join(root, 'workspace/removed.txt')), { code: 'ENOENT' });
      assert.equal(await readFile(join(root, 'workspace/kept.txt'), 'utf8'), 'Kept bytes');
      assert.deepEqual(await rpc('sessions/native-conversation-rewind', cutRequest), applied);
      assert.deepEqual(load(scope, kept.snapshot.runId), kept); assert.deepEqual(load(scope, removed.snapshot.runId), removed);
      await harness.close(); harness = new DeepSeekHarness(options);
      assert.equal((await (await harness.resumeSession(sessionId)).run('Continue retained workspace')).finalResponse, 'Retained workspace verified');
      const next = load(scope); assert.equal(next.snapshot.conversationBranch.generation, 1);
      const state = await rpc('sessions/native-conversation-status', identity);
      const rootRequest = { ...identity, expectedHeadRunId: state.headRunId, expectedGeneration: state.generation, scope: 'both',
        commandId: 'actual-combined-root-cut', targetMessageId: state.inputs.find(input => input.text === 'Keep workspace turn').messageId };
      const rootPreview = await rpc('sessions/native-conversation-workspace-preview', rootRequest); assert.equal(rootPreview.canApply, true);
      assert.equal((await rpc('sessions/native-conversation-rewind', { ...rootRequest, workspacePreviewToken: rootPreview.previewToken })).generation, 2);
      await assert.rejects(access(join(root, 'workspace/kept.txt')), { code: 'ENOENT' });
      await assert.rejects(access(join(root, 'workspace/removed.txt')), { code: 'ENOENT' });
      await harness.close(); harness = new DeepSeekHarness(options);
      assert.equal((await (await harness.resumeSession(sessionId)).run('After root rewind')).finalResponse, 'Root combined rewind verified');
      assert.equal(requests.length, 7); assert.deepEqual(failures, []);
      await writeFile(join(root, 'conversation-workspace-rewind-proof.json'), JSON.stringify({ passed: true, modelCalls: requests.length,
        activeStop: active,
        sourceRunId: kept.snapshot.runId, removedRunId: removed.snapshot.runId, firstBranchRunId: next.snapshot.runId,
        scope: 'Actual packed Host, authenticated preview and combined cut, external-edit refusal, duplicate request, cold retained read, earlier root cut without resurrecting undone files, third cold Host. Controlled model, local workspace only.' }, null, 2));
      console.log('Studio Native combined rewind PASS: preview-bound files-first cut, cold use, repeated root cut without file resurrection.');
    } finally { await harness.close(); }
  }
  return { respond, run };
}
