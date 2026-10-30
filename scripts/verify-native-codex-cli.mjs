/** Actual bundled Codex app-server against a deterministic local model. No cloud credentials or Python. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, symlink, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createCodexRuntime } from '../src/providers/codex-runtime.mjs';
import { resolveCodexCommand } from '../src/providers/codex-command.mjs';

if (!process.argv.includes('--execute')) {
  console.log('Use --execute to run the bundled official Codex CLI with an isolated home and deterministic loopback model.');
} else {
  const root = await mkdtemp(join(tmpdir(), 'studio-native-codex-')), bin = join(root, 'bin');
  await mkdir(bin); await symlink(process.execPath, join(bin, 'node'));
  const command = resolveCodexCommand(), script = command.prefixArgs[0];
  assert.ok(script, 'Use the bundled official npm CLI, not an unverified replacement executable');
  const version = JSON.parse(await readFile(join(dirname(script), '..', 'package.json'), 'utf8')).version;
  const marker = 'MIGRATION_LOOKUP_CARD_CANARY', tag = 'MIGRATION_CODEX_WIRE', nonce = randomUUID();
  let mode = 'chat-completions', phase = 'normal', requestCount = 0, tools = 0, abortReady;
  const children = [], requests = [], eventsByMode = [], failures = [];
  function declarations(list, namespace) {
    return (list ?? []).flatMap(tool => tool.type === 'namespace' ? declarations(tool.tools, tool.name)
      : [{ ...(tool.function ?? tool), ...(namespace ? { namespace } : {}) }]);
  }
  function respondChat(response, call, text) {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (delta, finish_reason = null) => response.write('data: ' + JSON.stringify({ id: 'chat-probe', object: 'chat.completion.chunk',
      model: 'migration-fixture', created: 1, choices: [{ index: 0, delta, finish_reason }],
      ...(finish_reason ? { usage: { prompt_tokens: 64, completion_tokens: 16, total_tokens: 80 } } : {}) }) + '\n\n');
    if (call) {
      chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'probe-call', type: 'function', function: { name: call.name, arguments: '{"id":' } }] });
      chunk({ tool_calls: [{ index: 0, function: { arguments: '"T9"}' } }] }); chunk({}, 'tool_calls');
    } else {
      chunk({ role: 'assistant', content: text.slice(0, 20) }); chunk({ content: text.slice(20) }); chunk({}, 'stop');
    }
    response.end('data: [DONE]\n\n');
  }
  function respondResponses(response, call, text) {
    response.writeHead(200, { 'content-type': 'text/event-stream' }); let seq = 0;
    const send = (type, payload) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...payload })}\n\n`);
    const frame = { id: 'resp-probe', object: 'response', created_at: 1, model: 'migration-fixture', status: 'in_progress', output: [] };
    send('response.created', { response: frame });
    let item;
    if (call) {
      item = { id: 'fc-probe', type: 'function_call', call_id: 'probe-call', name: call.name,
        ...(call.namespace ? { namespace: call.namespace } : {}), arguments: '{"id":"T9"}', status: 'completed' };
      send('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', arguments: '' } });
      send('response.function_call_arguments.delta', { output_index: 0, item_id: item.id, delta: item.arguments });
      send('response.function_call_arguments.done', { output_index: 0, item_id: item.id, arguments: item.arguments });
    } else {
      const part = { type: 'output_text', text, annotations: [] };
      item = { id: 'msg-probe', type: 'message', role: 'assistant', status: 'completed', content: [part] };
      send('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
      send('response.content_part.added', { output_index: 0, item_id: item.id, content_index: 0, part: { ...part, text: '' } });
      for (const delta of [text.slice(0, 20), text.slice(20)]) send('response.output_text.delta', { output_index: 0, item_id: item.id, content_index: 0, delta });
      send('response.output_text.done', { output_index: 0, item_id: item.id, content_index: 0, text });
      send('response.content_part.done', { output_index: 0, item_id: item.id, content_index: 0, part });
    }
    send('response.output_item.done', { output_index: 0, item });
    send('response.completed', { response: { ...frame, status: 'completed', output: [item], usage: { input_tokens: 64, output_tokens: 16, total_tokens: 80 } } });
    response.end();
  }
  const server = createServer((request, response) => {
    void (async () => {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')), serialized = JSON.stringify(body);
      assert.equal(body.model, 'migration-fixture'); assert.ok(serialized.includes(tag), 'System instruction reaches actual CLI model request');
      assert.ok(serialized.includes(phase === 'continuation' ? 'PRIOR_TURN_CANARY' : 'T9'));
      requestCount++; requests.push({ mode, phase, path: request.url, toolCount: body.tools?.length ?? 0 });
      if (phase === 'cancel') { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write(': waiting\n\n'); abortReady(); return; }
      const found = declarations(body.tools).find(tool => tool.description?.includes(marker));
      assert.ok(found, 'Actual CLI advertises the supplied dynamic tool');
      const returned = serialized.includes(nonce);
      const call = phase === 'normal' && !returned ? found : null;
      if (phase === 'normal' && returned) assert.ok(serialized.includes('ready'), 'Actual tool result reaches next model request');
      const text = JSON.stringify({ route_tag: tag, status: 'ready', verification: nonce });
      if (mode === 'chat-completions') respondChat(response, call, text); else respondResponses(response, call, text);
    })().catch(error => { failures.push(error); response.writeHead(500, { 'content-type': 'application/json' }); response.end('{"error":"fixture assertion"}'); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    for (mode of ['chat-completions', 'responses']) {
      const home = join(root, mode); await mkdir(home);
      const runtime = createCodexRuntime({ cwd: home, inheritEnv: false,
        env: { CODEX_HOME: home, PATH: bin, TMPDIR: root, LANG: 'en_US.UTF-8', RUST_LOG: 'error' },
        sandbox: 'read-only', timeoutMs: 45000, startupTimeoutMs: 15000, idleTimeoutMs: 10000, shutdownTimeoutMs: 1000,
        spawnImpl(executable, args, options) { const child = spawn(executable, args, options);
          const row = { executable: basename(executable), pid: child.pid, exited: false }; children.push(row);
          child.once('exit', () => { row.exited = true; }); return child; },
      });
      const input = { input: 'Query T9.', systemPrompt: `Always preserve route_tag ${tag}.`, model: 'migration-fixture',
        modelProvider: { api: mode, baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'isolated-fixture-key' },
        dynamicTools: [{ name: 'lookup_card', description: marker, inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } }],
        toolHandler: async call => { assert.equal(call.name, 'lookup_card'); assert.deepEqual(call.arguments, { id: 'T9' }); tools++;
          return { status: 'ready', verification: nonce }; },
      };
      phase = 'normal'; const events = []; const before = requestCount;
      for await (const event of runtime.stream(input)) events.push(event);
      assert.deepEqual(failures, []); assert.equal(requestCount - before, 2, 'One tool round, one final model round');
      const text = events.filter(event => event.type === 'text').map(event => event.text).join('');
      assert.ok(text.includes(nonce)); assert.ok(events.some(event => event.type === 'tool' && event.phase === 'completed'));
      assert.ok(events.filter(event => event.type === 'text').length >= 2);
      phase = 'continuation'; const continuation = [];
      for await (const event of runtime.stream({ ...input, input: 'Continue PRIOR_TURN_CANARY.',
        messages: [{ role: 'user', content: 'PRIOR_TURN_CANARY' }, { role: 'assistant', content: text }] })) continuation.push(event);
      assert.deepEqual(failures, []); assert.ok(continuation.some(event => event.type === 'text'));
      phase = 'cancel'; const controller = new AbortController(), ready = new Promise(resolve => { abortReady = resolve; });
      const work = (async () => { for await (const _event of runtime.stream({ ...input, signal: controller.signal })) {} })();
      await Promise.race([ready, new Promise((_, reject) => { const timer = setTimeout(() => reject(Error('CLI never sent the cancellable model request')), 15000); timer.unref(); })]);
      controller.abort(Error('migration cancellation')); await assert.rejects(work, /migration cancellation|取消|abort/iu);
      eventsByMode.push({ mode, textDeltas: events.filter(event => event.type === 'text').length,
        toolCompleted: true, historyContinued: true, modelRequestCancelled: true });
    }
    await new Promise(resolve => setTimeout(resolve, 1500));
    assert.deepEqual(failures, []); assert.equal(tools, 2); assert.ok(children.every(child => child.exited));
    console.log(JSON.stringify({ passed: true, codexVersion: version, actualCli: true, childCount: children.length,
      allChildrenExited: true, nodeOnlyPath: true, isolatedCodexHomes: true, modelRequests: requestCount, tools, eventsByMode, requests }));
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); }
}
