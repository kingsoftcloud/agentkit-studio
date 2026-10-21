/** Keyless shipped SDK profile proof: exact Native arguments through real DSH policy and MCP HTTP. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { canonical, parseNativeJson } from '../packages/agentkit-harness-core/dist/index.mjs';

const { values } = parseArgs({ options: { source: { type: 'string' }, 'studio-mcp': { type: 'boolean', default: false } } });
assert.ok(values.source, 'Use --source <built maintained DSH checkout>');
const source = resolve(values.source), root = await mkdtemp(join(tmpdir(), 'native-dsh-numeric-'));
const exact = '{"id":9007199254740993,"zero":-0.0,"float":1.0000000000000001e+18,"ordinary":7,"record":{"rawJSON":"9007199254740993"}}';
const expected = parseNativeJson(exact), failures = [], modelRequests = [], mcpEffects = [];
const toolName = values['studio-mcp'] ? 'echo' : 'mcp__exact__echo';
let harness;
const server = createServer(async (request, response) => {
  try {
    if (request.method !== 'POST') { response.writeHead(405); response.end(); return; }
    let body = '';
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body);
    if (request.url === '/mcp') {
      if (input.id === undefined) { response.writeHead(202); response.end(); return; }
      if (input.method === 'server/discover') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ jsonrpc: '2.0', id: input.id, error: { code: -32601, message: 'Method not found' } }));
        return;
      }
      let result;
      if (input.method === 'initialize') result = { protocolVersion: input.params.protocolVersion,
        serverInfo: { name: 'exact-numeric-fixture', version: '1' }, capabilities: { tools: {} } };
      else if (input.method === 'tools/list') result = { tools: [{ name: 'echo', description: 'Echo exact JSON numbers.',
        ...(values['studio-mcp'] ? { outputSchema: { type: 'object', required: ['id'],
          properties: { id: { type: 'integer', minimum: expected.id, maximum: expected.id } } } } : {}),
        inputSchema: { type: 'object', properties: { id: { type: 'integer' }, zero: { type: 'number' }, float: { type: 'number' }, ordinary: { type: 'number' },
          record: { type: 'object', properties: { rawJSON: { type: 'string' } }, required: ['rawJSON'], additionalProperties: false } },
        required: ['id', 'zero', 'float', 'ordinary', 'record'], additionalProperties: false } }] };
      else if (input.method === 'tools/call') {
        assert.equal(input.params.name, 'echo');
        const received = parseNativeJson(body).params.arguments;
        assert.equal(canonical(received), canonical(expected));
        assert.equal(received.id, 9007199254740993n);
        assert.equal(Object.is(received.zero, -0), true);
        mcpEffects.push(body);
        result = { content: [{ type: 'text', text: canonical(received) }] };
        if (values['studio-mcp']) Object.assign(result, { structuredContent: { count: 7, ...received }, _meta: { privateAudit: 'private-mcp-audit' } });
      } else throw Error(`Unexpected MCP method ${input.method}`);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(values['studio-mcp'] ? canonical({ jsonrpc: '2.0', id: input.id, result }) : JSON.stringify({ jsonrpc: '2.0', id: input.id, result }));
      return;
    }
    assert.equal(request.url, '/v1/chat/completions');
    modelRequests.push(input);
    const delta = modelRequests.length === 1 ? { role: 'assistant', tool_calls: [{ index: 0, id: 'exact-call', type: 'function',
      function: { name: toolName, arguments: exact } }] } : { role: 'assistant', content: 'Exact numeric turn completed.' };
    if (modelRequests.length > 1) assert.ok(input.messages.some(message => message.role === 'tool'
      && message.content.includes('9007199254740993') && message.content.includes('-0.0')));
    if (values['studio-mcp'] && modelRequests.length > 1) {
      assert.ok(input.messages.some(message => message.role === 'tool'
        && message.content.includes(`"structuredContent":${canonical({ count: 7, ...expected })}`)));
      assert.equal(JSON.stringify(input.messages).includes('private-mcp-audit'), false);
    }
    response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
    response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: modelRequests.length === 1 ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 7 } })}\n\ndata: [DONE]\n\n`);
  } catch (error) { failures.push(error); response.writeHead(500); response.end('verification failed'); }
});
try {
  await mkdir(join(root, 'workspace'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const { DeepSeekHarness } = await import(pathToFileURL(join(source, 'packages/sdk/client/lib/index.js')).href);
  const fixture = fileURLToPath(new URL('../tests/fixtures/native-dsh-numeric.mjs', import.meta.url));
  const patch = join(root, 'numeric.patch.yml');
  await writeFile(patch, [
    '- id: session-persistence-jsonl', "  name: '@deepseek-ai/dsh-session-persistence-jsonl'", '  config:',
    `    root: ${JSON.stringify(join(root, 'sessions'))}`, '    compression: none', '- insert:',
    ...values['studio-mcp'] ? [] : [
      '    - id: exact-mcp', "      name: '@deepseek-ai/dsh-mcp-client'", '      config:', '        transport: streamable-http',
      '        serverName: exact', `        url: ${JSON.stringify(`${origin}/mcp`)}`, '        failOnStartupError: true',
    ],
    '    - id: numeric-verification', `      name: ${JSON.stringify(pathToFileURL(fixture).href)}`, '      config:',
    `        directory: ${JSON.stringify(root)}`, `        modelUrl: ${JSON.stringify(`${origin}/v1`)}`,
    `        studioMcpUrl: ${JSON.stringify(values['studio-mcp'] ? `${origin}/mcp` : '')}`,
    `        promptModule: ${JSON.stringify(join(source, 'packages/core/system-prompt/lib/index.js'))}`, '',
  ].join('\n'));
  harness = new DeepSeekHarness({ dshBin: join(source, 'apps/cli/lib/bin.js'), profile: 'sdk', patches: [patch],
    dshHome: join(root, 'home'), cwd: join(root, 'workspace'), processCwd: root, provider: 'native-fixture', model: 'pinned',
    initializeTimeoutMs: 30_000, requestTimeoutMs: 30_000,
    env: { ...process.env, DSH_TELEMETRY_DISABLED: '1', DSH_AGENTS_HOME: join(root, 'agents') } });
  const result = await harness.session('numeric-sdk-session').run('Echo the exact numeric JSON through the tool and finish.');
  assert.equal(result.finalResponse, 'Exact numeric turn completed.', JSON.stringify({
    failures: failures.map(String), modelRequests: modelRequests.length, mcpEffects: mcpEffects.length,
    events: result.events.filter(event => ['tool/result', 'turn/end'].includes(event.type)),
    checkpoint: await readFile(join(root, 'native-status.json'), 'utf8').catch(error => String(error)),
  }));
  assert.equal(result.events.filter(event => event.type === 'tool/call').length, 1);
  assert.equal(result.events.filter(event => event.type === 'tool/result').length, 1);
  assert.equal(modelRequests.length, 2, JSON.stringify({ failures: failures.map(String), mcpEffects,
    requests: modelRequests.map(request => request.messages.filter(message => message.role !== 'system')),
    checkpoint: await readFile(join(root, 'native-status.json'), 'utf8').catch(String),
  }));
  assert.equal(mcpEffects.length, 1);
  const policies = (await readFile(join(root, 'policy.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(policies.length, 1); assert.equal(policies[0].encoding, 'dsh.raw-json-number/v1');
  assert.equal(canonical(parseNativeJson(policies[0].arguments)), canonical(expected));
  const receipts = await readFile(join(root, 'native-receipts.json'), 'utf8');
  assert.ok(receipts.includes('9007199254740993')); assert.deepEqual(failures, []);
  if (values['studio-mcp']) assert.ok(receipts.includes('structuredContent'));
  await harness.close(); harness = null;
  console.log('PASS: shipped SDK profile; Native exact model arguments → DSH policy → MCP HTTP → ledger receipt → model continuation; replay dispatched no second effect.');
} finally {
  try { await harness?.close(); } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
}
