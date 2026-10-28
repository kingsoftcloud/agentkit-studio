/** Real packed Studio Host and SDK, deterministic model HTTP, actual instruction files. */
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export function createInstructionsProof() {
  const rootRule = 'ROOT_RULE_7c0b: preserve existing exports.';
  const nestedRule = 'NESTED_RULE_9da2: keep this module synchronous.';
  const changedRule = 'NESTED_RULE_b174: retain the compatibility export.';
  const blocks = messages => JSON.stringify(messages);
  async function respond({ request, response, raw, requests }) {
    assert.equal(request.url, '/v1/chat/completions');
    const body = JSON.parse(raw); requests.push(body);
    const count = requests.length; assert.ok(count <= 4);
    assert.ok(blocks(body.messages).includes(rootRule), 'baseline must enter the actual first model request');
    assert.deepEqual(new Set(body.tools.map(tool => tool.function.name)),
      new Set(['read_workspace_file', 'ArtifactRead', 'ArtifactSearch', 'ArtifactList']));
    if (count === 1) assert.equal(blocks(body.messages).includes(nestedRule), false);
    if (count === 2) assert.ok(blocks(body.messages).includes(nestedRule), 'nested guidance must enter the immediately following request');
    if (count === 4) assert.ok(blocks(body.messages).includes(changedRule), 'cold Host must refresh changed nested guidance');
    const call = count % 2 ? { name: 'read_workspace_file', arguments: { path: 'pkg/file.ts' } } : null;
    const delta = call ? { tool_calls: [{ index: 0, id: `instruction-${count}`, type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] }
      : { content: count === 2 ? 'Scoped instructions applied.' : 'Changed instructions applied.' };
    response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
    response.end(`data: ${JSON.stringify({ id: `instructions-${count}`, choices: [{ index: 0, delta,
      finish_reason: call ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 7 } })}\n\ndata: [DONE]\n\n`);
  }
  async function run({ harness: initial, DeepSeekHarness, options, root, sessions, requests, failures }) {
    let harness = initial;
    const workspace = join(root, 'workspace');
    await mkdir(join(workspace, '.git'), { recursive: true });
    await mkdir(join(workspace, 'pkg'), { recursive: true });
    await writeFile(join(workspace, 'AGENTS.md'), rootRule);
    await writeFile(join(workspace, 'pkg/AGENTS.md'), nestedRule);
    await writeFile(join(workspace, 'pkg/file.ts'), 'export const value = 1;\n');
    const turns = [];
    try {
      let session = harness.session('native-studio-session');
      turns.push(await session.run('Read pkg/file.ts and report completion.'));
      await writeFile(join(root, 'instructions-first-turn.json'), JSON.stringify(turns[0], null, 2));
      assert.equal(turns[0].finalResponse, 'Scoped instructions applied.', JSON.stringify(turns[0]));
      await harness.close();
      await writeFile(join(workspace, 'pkg/AGENTS.md'), changedRule);
      harness = new DeepSeekHarness(options);
      session = await harness.resumeSession('native-studio-session');
      turns.push(await session.run('Read pkg/file.ts again and report completion.'));
      assert.equal(turns[1].finalResponse, 'Changed instructions applied.');
    } finally { await harness.close(); }
    assert.deepEqual(failures, []); assert.equal(requests.length, 4);
    const admissions = (await readFile(join(root, 'tool-admissions.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(admissions.map(item => item.name), ['read_workspace_file', 'read_workspace_file']);
    const probes = (await readFile(join(root, 'mounted-host-http.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(new Set(probes.map(probe => probe.hostPid)).size, 2);
    const logs = (await readdir(sessions, { recursive: true })).filter(file => file.endsWith('.jsonl'));
    const events = (await Promise.all(logs.map(file => readFile(join(sessions, file), 'utf8'))))
      .flatMap(text => text.trim().split('\n').filter(Boolean).map(JSON.parse));
    const updates = events.filter(event => event.type === 'user/message' && event.data.source.kind === 'agent-instructions');
    assert.equal(updates.filter(event => blocks(event.data.message ?? event.data).includes(nestedRule)).length, 1);
    assert.equal(updates.filter(event => blocks(event.data.message ?? event.data).includes(changedRule)).length, 1);
    await writeFile(join(root, 'instruction-session.json'), JSON.stringify(events, null, 2));
    await writeFile(join(root, 'instructions-proof.json'), JSON.stringify({ passed: true, modelRequests: requests.length,
      hostPids: probes.map(probe => probe.hostPid), instructionUpdates: updates.length,
      scope: 'Packed Studio + maintained Host + SDK, real files and persisted Session, deterministic model HTTP. Baseline, immediate nested discovery, cold Host refresh; no live model quality or crash-window claim.' }, null, 2));
    console.log('Studio Native instructions PASS: baseline, next-request scoped guidance, persisted history, changed guidance after cold Host restart.');
  }
  return { respond, run };
}
