/** Packed Studio + maintained Host + SDK, actual MCP and controlled model HTTP. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonical, parseNativeJson } from '../packages/agentkit-harness-core/dist/index.mjs';

export function createToolSearchProof({ native = false } = {}) {
  const target = 'write_workspace_file', integer = 9007199254740993n;
  async function respondNative({ request, response, raw, requests }) {
    assert.equal(request.url, '/v1/messages');
    assert.ok(request.headers['anthropic-beta'].split(',').includes('advanced-tool-use-2025-11-20'));
    const body = parseNativeJson(raw); requests.push(body);
    const count = requests.length, names = body.tools.map(tool => tool.name);
    assert.ok(count <= 5); assert.ok(names.includes('ToolSearch')); assert.equal(names.includes('DeferredToolCall'), false);
    assert.equal(Object.hasOwn(body, 'provider_tool_search'), false);
    const definition = body.tools.find(tool => tool.name === target);
    assert.equal(definition.input_schema.properties.id.minimum, integer);
    assert.equal(definition.input_schema.properties.id.maximum, integer);
    assert.equal(definition.defer_loading, count <= 3 ? true : undefined);
    assert.equal(canonical(body.messages).includes('private-mcp-schema-audit'), false);
    const blocks = body.messages.flatMap(message => Array.isArray(message.content) ? message.content : []);
    if (count >= 2) {
      const receipt = blocks.find(block => block.type === 'tool_result'
        && Array.isArray(block.content) && block.content.some(item => item.type === 'tool_reference'));
      assert.ok(receipt, 'kernel search receipt must become actual provider references');
      assert.deepEqual(receipt.content, [{ type: 'tool_reference', tool_name: target }]);
    }
    if (count >= 3) {
      const call = blocks.find(block => block.type === 'tool_use' && block.name === target);
      assert.equal(call.input.id, integer);
    }
    const input = turn => ({ path: `published-${turn}.txt`, content: `marker ${turn}`, id: integer });
    const call = count === 1 ? { name: 'ToolSearch', input: { query: `select:${target}` } }
      : count === 2 ? { name: target, input: input(1) }
      : count === 4 ? { name: target, input: input(2) } : null;
    const event = (type, payload) => `event: ${type}\ndata: ${canonical({ type, ...payload })}\n\n`;
    const events = [event('message_start', { message: { id: `tool-search-${count}`, role: 'assistant',
      model: 'pinned', content: [], usage: { input_tokens: 5, output_tokens: 0 } } }),
    event('content_block_start', { index: 0, content_block: call
      ? { type: 'tool_use', id: `search-proof-${count}`, name: call.name, input: {} }
      : { type: 'text', text: '' } }),
    event('content_block_delta', { index: 0, delta: call
      ? { type: 'input_json_delta', partial_json: canonical(call.input) }
      : { type: 'text_delta', text: `Published marker ${count === 3 ? 1 : 2}.` } }),
    event('content_block_stop', { index: 0 }),
    event('message_delta', { delta: { stop_reason: call ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 7 } }),
    event('message_stop', {})];
    response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' }); response.end(events.join(''));
  }
  async function respond({ request, response, raw, requests }) {
    if (native) return respondNative({ request, response, raw, requests });
    assert.equal(request.url, '/v1/chat/completions');
    const body = parseNativeJson(raw); requests.push(body);
    const count = requests.length, names = body.tools.map(tool => tool.function.name);
    assert.ok(count <= 5); assert.ok(names.includes('ToolSearch')); assert.ok(names.includes('DeferredToolCall'));
    if (count <= 3) assert.equal(names.includes(target), false, 'deferred schema must not enter the resident catalog');
    else {
      const schema = body.tools.find(tool => tool.function.name === target).function.parameters;
      assert.equal(schema.properties.id.minimum, integer); assert.equal(schema.properties.id.maximum, integer);
    }
    assert.equal(canonical(body.messages).includes('private-mcp-schema-audit'), false);
    if (count === 2) {
      const output = body.messages.filter(message => message.role === 'tool').at(-1).content;
      const loaded = parseNativeJson(output);
      assert.deepEqual(loaded.tool_names, [target]);
      assert.equal(loaded.definitions[0].parameters.properties.id.minimum, integer);
      assert.equal(loaded.definitions[0].parameters.properties.id.maximum, integer);
    }
    if (count >= 3) {
      const call = body.messages.filter(message => message.role === 'assistant').flatMap(message => message.tool_calls ?? [])
        .find(call => call.function.name === 'DeferredToolCall');
      assert.equal(call.function.name, 'DeferredToolCall');
      assert.equal(parseNativeJson(call.function.arguments).input.id, integer);
    }
    const input = turn => ({ path: `published-${turn}.txt`, content: `marker ${turn}`, id: integer });
    const call = count === 1 ? { name: 'ToolSearch', arguments: { query: `select:${target}` } }
      : count === 2 ? { name: 'DeferredToolCall', arguments: { name: target, input: input(1) } }
      : count === 4 ? { name: target, arguments: input(2) } : null;
    const delta = call ? { tool_calls: [{ index: 0, id: `search-proof-${count}`, type: 'function',
      function: { name: call.name, arguments: canonical(call.arguments) } }] }
      : { content: `Published marker ${count === 3 ? 1 : 2}.` };
    response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
    response.end(`data: ${canonical({ id: `tool-search-${count}`, choices: [{ index: 0, delta,
      finish_reason: call ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 7 } })}\n\ndata: [DONE]\n\n`);
  }
  async function run({ harness: initial, DeepSeekHarness, options, root, installed, requests, failures, mcpEffects }) {
    let harness = initial;
    try {
      const first = await harness.session('native-studio-session').run('Publish marker 1 and report completion.');
      await writeFile(join(root, 'tool-search-first-turn.json'), JSON.stringify(first, null, 2));
      assert.equal(first.finalResponse, 'Published marker 1.', JSON.stringify(first));
      await harness.close(); harness = new DeepSeekHarness(options);
      const session = await harness.resumeSession('native-studio-session');
      const second = await session.run('Publish marker 2 and report completion.');
      await writeFile(join(root, 'tool-search-second-turn.json'), JSON.stringify(second, null, 2));
      assert.equal(second.finalResponse, 'Published marker 2.', JSON.stringify(second));
    } finally { await harness.close(); }
    assert.deepEqual(failures, []); assert.equal(requests.length, 5);
    assert.deepEqual(mcpEffects, ['published-1.txt', 'published-2.txt']);
    for (const turn of [1, 2]) assert.equal(await readFile(join(root, 'workspace', `published-${turn}.txt`), 'utf8'), `marker ${turn}`);
    const { id: agentId } = JSON.parse(await readFile(join(root, 'agent-id.json'), 'utf8'));
    const scope = { tenantId: 'local', workspaceId: createHash('sha256').update(JSON.stringify(resolve(root, 'workspace'))).digest('hex'), userId: 'local-user', agentId };
    const { SqliteRunStore } = await import(pathToFileURL(join(installed, 'packages/agentkit-harness/src/native/sqlite-store.mjs')).href);
    const store = new SqliteRunStore(join(root, 'studio/native-harness/runs.sqlite'));
    try {
      const records = store.list(scope, 'native-studio-session').map(run => store.load(scope, run.runId));
      assert.equal(records.length, 2);
      for (const record of records) {
        assert.equal(record.configuration.toolDiscoveryPolicy, 'local-tool-search/v1');
        assert.equal(record.configuration.profile.providerToolSearchPolicy, native ? 'anthropic-deferred/v1' : 'local-only/v1');
        assert.ok(record.snapshot.toolDiscovery.discovered.includes(target));
        const toolCalls = record.intents.filter(intent => intent.kind === 'tool').flatMap(intent => intent.payload.calls);
        assert.equal(toolCalls.some(call => call.name === 'DeferredToolCall'), false);
        assert.equal(toolCalls.filter(call => call.name === target).length, 1);
        assert.ok(record.receipts.some(receipt => receipt.result.results?.some(result => result.content?.structuredContent?.id === integer)));
      }
      assert.equal(records.filter(record => record.snapshot.toolDiscovery.promoted.includes(target)).length, 1);
    } finally { store.close(); }
    const admissions = (await readFile(join(root, 'tool-admissions.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(admissions.map(item => item.name), [target, target]);
    const probes = (await readFile(join(root, 'mounted-host-http.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(new Set(probes.map(probe => probe.hostPid)).size, 2);
    await writeFile(join(root, 'tool-search-proof.json'), JSON.stringify({ passed: true, native, modelRequests: 5,
      mcpEffects, hostPids: [...new Set(probes.map(probe => probe.hostPid))],
      scope: `Packed Studio + maintained Host + SDK, default deferred MCP schema, exact integer, real tool policy/intent/effects, ${native ? 'Anthropic references and direct calls' : 'history wrapper'}, cold Host next-turn promotion. Controlled model; no live model quality or savings claim.` }, null, 2));
    console.log(`Studio Native tool search PASS: ${native ? 'Anthropic references' : 'local discovery'}, exact MCP schema, actual-target execution and policy, cold Host next-turn promotion.`);
  }
  return { respond, run };
}
