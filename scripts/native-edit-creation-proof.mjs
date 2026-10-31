import { createRequire } from 'node:module';
/** Actual packed Studio path: versioned Edit creation, denial, and cold editing. */
import assert from 'node:assert/strict';
import { readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseNativeJson } from '@kingsoftcloud/agentkit-harness-core';

export function createEditCreationProof() {
  async function respond({ request, response, raw, requests }) {
    assert.equal(request.url, '/v1/chat/completions'); const body = JSON.parse(raw); requests.push(body);
    const count = requests.length; assert.ok(count <= 8);
    const calls = {
      1: { name: 'edit_workspace_file', arguments: { path: 'nested/created.txt', old_text: '', new_text: 'first\r\nsecond\r\n' } },
      2: { name: 'edit_workspace_file', arguments: { path: 'nested/created.txt', old_text: 'second', new_text: 'updated' } },
      3: { name: 'edit_workspace_file', arguments: { path: 'nested/created.txt', old_text: '', new_text: 'must not overwrite' } },
      4: { name: 'edit_workspace_file', arguments: { path: 'denied.txt', old_text: '', new_text: 'must not create' } },
      6: { name: 'edit_workspace_file', arguments: { path: 'nested/created.txt', old_text: 'updated', new_text: 'cold updated' } },
      7: { name: 'read_workspace_file', arguments: { path: 'nested/created.txt' } },
    };
    const tool = body.messages.filter(message => message.role === 'tool').at(-1)?.content;
    if (count === 4) assert.match(tool, /file_exists_no_old_text/);
    if (count === 5) assert.match(tool, /denied/i);
    if (count === 8) assert.match(tool, /cold updated/);
    const call = calls[count];
    const delta = call ? { tool_calls: [{ index: 0, id: `edit-create-${count}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] }
      : { content: count === 5 ? 'Created through Edit' : 'Cold Edit verified' };
    response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
    response.end(`data: ${JSON.stringify({ id: `edit-create-${count}`, choices: [{ index: 0, delta, finish_reason: call ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 7 } })}\n\ndata: [DONE]\n\n`);
  }
  async function run({ harness: first, DeepSeekHarness, options, root, installed, requests, failures }) {
    let harness = first;
    const { SqliteRunStore } = await import(pathToFileURL(createRequire(join(installed, 'package.json')).resolve('@kingsoftcloud/agentkit-harness-node/native/sqlite-store')).href);
    const sessionId = 'native-studio-session', file = join(root, 'workspace/nested/created.txt');
    const load = (scope, runId) => { const store = new SqliteRunStore(join(root, 'studio/native-harness/runs.sqlite'));
      try { return store.load(scope, runId ?? store.sessionHead(scope, sessionId).runId); } finally { store.close(); } };
    try {
      const initial = await harness.session(sessionId).run('Create and edit the file through Edit');
      assert.equal(initial.finalResponse, 'Created through Edit');
      const identity = parseNativeJson(initial.events.find(event => event.type === 'turn/owner').data.binding).identity;
      const original = load(identity.scope, identity.runId);
      assert.equal(original.configuration.tools.find(tool => tool.name === 'edit_workspace_file').workspaceEditPolicy, 'zcode-match/v2');
      const results = original.receipts.flatMap(receipt => receipt.result.results ?? []);
      const creation = results.find(result => result.content?.checkpoint_id && result.content?.diff_additions === 2);
      assert.ok(creation, 'creation has an actual committed workspace checkpoint');
      assert.ok(creation.metadata?.nativeWorkspaceReads?.states.some(state => state.path === 'nested/created.txt' && !state.partial), 'creation records full read authority');
      assert.equal(await readFile(file, 'utf8'), 'first\nupdated\n');
      await assert.rejects(access(join(root, 'workspace/denied.txt')), { code: 'ENOENT' });
      await harness.close(); harness = new DeepSeekHarness(options);
      const cold = await (await harness.resumeSession(sessionId)).run('Continue editing after reopening');
      assert.equal(cold.finalResponse, 'Cold Edit verified');
      assert.equal(await readFile(file, 'utf8'), 'first\ncold updated\n');
      assert.deepEqual(load(identity.scope, identity.runId), original, 'cold continuation never reinterprets the prior Run');
      assert.equal(requests.length, 8); assert.deepEqual(failures, []);
      await writeFile(join(root, 'edit-creation-proof.json'), JSON.stringify({ passed: true, modelCalls: requests.length,
        sourceRunId: identity.runId, creationCheckpointId: creation.content.checkpoint_id,
        scope: 'Actual packed Studio; admitted v2 Edit creation normalizes CRLF input to LF, immediate next edit without a read, nonblank refusal, actual Host policy denial and cold edit continuity. Controlled model, local workspace only.' }, null, 2));
      console.log('Studio Native Edit creation PASS: versioned creation, full read authority, Host denial and cold continuation.');
    } finally { await harness.close(); }
  }
  return { respond, run };
}
