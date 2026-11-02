import assert from 'node:assert/strict';
import { access, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { parseNativeJson } from '@kingsoftcloud/agentkit-harness-core';

/** Mounted production Host, real SDK Session and ToolRegistry; no model credentials. */
export function createSessionWorkspaceProof() {
  const contents = ['42\n', ' \t42\r\n\n'];
  async function respond({ request, response, raw, requests }) {
    assert.equal(request.url, '/v1/chat/completions');
    const body = JSON.parse(raw); requests.push(body);
    const count = requests.length, turn = Math.floor((count - 1) / 3), step = (count - 1) % 3;
    assert.ok(turn < contents.length, 'bounded proof model calls');
    assert.ok(body.tools.some(tool => tool.function.name === 'write_workspace_file'), 'tools exist before first model assembly');
    const call = step === 0 ? { name: 'write_workspace_file', arguments: { path: 'answer.txt', content: contents[turn] } }
      : step === 1 ? { name: 'read_workspace_file', arguments: { path: 'answer.txt' } } : null;
    if (step === 1) assert.doesNotMatch(body.messages.filter(row => row.role === 'tool').at(-1)?.content ?? '', /tool_preflight_failed|permission_denied/i);
    const delta = call ? { tool_calls: [{ index: 0, id: `bytes-${count}`, type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] } : { content: `Bytes verified ${turn + 1}` };
    response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
    response.end(`data: ${JSON.stringify({ id: `bytes-${count}`, choices: [{ index: 0, delta, finish_reason: call ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 7 } })}\n\ndata: [DONE]\n\n`);
  }
  async function run({ harness: initial, DeepSeekHarness, options, root, installed, requests, failures }) {
    let harness = initial;
    const { SqliteRunStore } = await import(pathToFileURL(createRequire(join(installed, 'package.json'))
      .resolve('@kingsoftcloud/agentkit-harness-node/native/sqlite-store')).href);
    const sessionId = 'native-studio-session', selected = join(root, 'selected-project');
    const receipts = [];
    try {
      for (let turn = 0; turn < contents.length; turn++) {
        if (turn) { await harness.close(); harness = new DeepSeekHarness(options); }
        const session = turn ? await harness.resumeSession(sessionId) : harness.session(sessionId);
        const result = await session.run('Write answer.txt, read it back, then finish. Preserve all bytes.');
        assert.equal(result.finalResponse, `Bytes verified ${turn + 1}`);
        assert.deepEqual(await readFile(join(selected, 'answer.txt')), Buffer.from(contents[turn]));
        await assert.rejects(access(join(root, 'workspace/answer.txt')), { code: 'ENOENT' });
        const identity = parseNativeJson(result.events.find(event => event.type === 'turn/owner').data.binding).identity;
        const store = new SqliteRunStore(join(root, 'studio/native-harness/runs.sqlite'));
        try {
          const record = store.load(identity.scope, identity.runId);
          assert.equal(record.snapshot.phase, 'completed');
          assert.equal(record.configuration.modelSurface.environment.cwd, await realpath(selected));
          assert.equal(record.configuration.hostRecoveryBinding.workspaceContext.workspaceRoot, await realpath(selected));
          const calls = record.snapshot.messages.flatMap(row => row.toolCalls ?? []);
          assert.equal(calls.filter(call => call.name === 'write_workspace_file').at(-1).arguments.content, contents[turn]);
          assert.ok(record.receipts.flatMap(row => row.result?.results ?? []).every(row => row.status === 'ok'));
          receipts.push({ runId: identity.runId, hex: Buffer.from(contents[turn]).toString('hex'), workspace: 'selected-project' });
        } finally { store.close(); }
      }
      assert.equal(requests.length, 6); assert.deepEqual(failures, []);
      await writeFile(join(root, 'session-workspace-proof.json'), JSON.stringify({ passed: true, modelCalls: requests.length,
        receipts, launchRootUntouched: true, coldContinuation: true,
        scope: 'Packed Studio + maintained Host + real SDK Session/preset/ToolRegistry/SQLite; deterministic model SSE, exact UTF-8 bytes and restored Session. No live model quality claim.' }, null, 2));
      console.log('Studio Native Session workspace PASS: selected directory, exact bytes and cold continuation.');
    } finally { await harness.close(); }
  }
  return { respond, run };
}
