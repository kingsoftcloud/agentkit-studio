// The Native engine provider drives a REAL engine process through the protocol
// against a local model fixture. Studio code under test imports no engine module.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { createNativeEngineRuntime, resolveEngineCommand } from '../src/providers/native-engine-runtime.mjs';

const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
const toolCall = (id, name, args) => [
  { id: 'c', choices: [{ index: 0, delta: { role: 'assistant', content: 'Writing the file now.', tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] },
  { id: 'c', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage }];
const final = text => [{ id: 'c', choices: [{ index: 0, delta: { role: 'assistant', content: text } }] },
  { id: 'c', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage }];
function fixture(script) {
  const requests = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      requests.push(JSON.parse(body));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const frame of script[Math.min(requests.length - 1, script.length - 1)]) res.write(`data: ${JSON.stringify(frame)}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  return new Promise(done => server.listen(0, '127.0.0.1', () => done({ url: `http://127.0.0.1:${server.address().port}/v1`, requests,
    close: () => new Promise(closed => { server.closeAllConnections(); server.close(closed); }) })));
}
async function setup(t, script) {
  const dir = mkdtempSync(join(tmpdir(), 'studio-engine-')), cwd = join(dir, 'workspace');
  mkdirSync(cwd);
  const model = await fixture(script);
  t.after(async () => { await model.close(); rmSync(dir, { recursive: true, force: true }); });
  const runtime = createNativeEngineRuntime({ stateRoot: join(dir, 'state'), env: { PATH: process.env.PATH, HOME: dir } });
  return { runtime, model, cwd, options: { input: 'Create out.txt with a greeting.', systemPrompt: 'You are the Studio release agent.', model: 'fixture-model',
    modelProvider: { baseUrl: model.url, apiKey: 'studio-fixture-key' }, cwd, sessionId: 'session-1', turnId: '1' } };
}
const collect = async stream => { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return chunks; };

test('an approved turn writes the file and streams engine progress as ordinary runtime chunks', async t => {
  const f = await setup(t, [toolCall('call_1', 'write_workspace_file', { path: 'out.txt', content: 'hi\n' }), final('Created out.txt.')]);
  const approvals = [];
  const chunks = await collect(f.runtime.stream({ ...f.options, requestApproval: async info => { approvals.push(info); return 'allowed-once'; } }));
  assert.equal(readFileSync(join(f.cwd, 'out.txt'), 'utf8'), 'hi\n');
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].toolName, 'native/write_workspace_file');
  assert.match(approvals[0].reason, /out\.txt/);
  const engine = chunks.find(chunk => chunk.type === 'engine').engine;
  assert.equal(engine.protocol, 'agentkit.engine/v1'); assert.equal(engine.preset.preset, 'official');
  assert.deepEqual(chunks.filter(chunk => chunk.type === 'tool'), [{ type: 'tool', name: 'write_workspace_file', phase: 'completed' }]);
  assert.ok(chunks.some(chunk => chunk.type === 'reasoning' && chunk.text === 'Writing the file now.'));
  assert.deepEqual(chunks.filter(chunk => chunk.type === 'text'), [{ type: 'text', text: 'Created out.txt.' }]);
  assert.ok(chunks.filter(chunk => chunk.type === 'usage').every(chunk => chunk.usage.inputTokens === 10 && chunk.usage.outputTokens === 5));
  // Studio's instructions reach the model inside the engine's Host slot; the base prompt is the engine's.
  const system = f.model.requests[0].messages.filter(message => message.role === 'system').map(message => message.content).join('\n');
  assert.ok(system.includes('You are the Studio release agent.') && system.includes('<host_instructions'));
  assert.ok(!JSON.stringify(chunks).includes('studio-fixture-key'));
});

test('a turn without an approval seat cannot write, and a declined approval leaves the workspace untouched', async t => {
  for (const requestApproval of [undefined, async () => 'denied']) {
    const f = await setup(t, [toolCall('call_1', 'write_workspace_file', { path: 'out.txt', content: 'hi\n' }), final('The write was not permitted.')]);
    const chunks = await collect(f.runtime.stream({ ...f.options, ...(requestApproval ? { requestApproval } : {}) }));
    assert.equal(existsSync(join(f.cwd, 'out.txt')), false);
    assert.ok(chunks.some(chunk => chunk.type === 'tool' && chunk.phase === 'failed'));
  }
});

test('configuration decides which engine runs; missing prerequisites fail with typed errors', async t => {
  assert.deepEqual(resolveEngineCommand({ AGENTKIT_ENGINE_COMMAND: '/opt/engine/bin/agentkit-engine', AGENTKIT_ENGINE_ARGS: '["--flag"]' }),
    { command: '/opt/engine/bin/agentkit-engine', args: ['--flag'], source: 'configured' });
  assert.throws(() => resolveEngineCommand({ AGENTKIT_ENGINE_COMMAND: 'x', AGENTKIT_ENGINE_ARGS: '{}' }), { code: 'NATIVE_ENGINE_CONFIG_INVALID' });
  assert.equal(resolveEngineCommand({}).source, 'installed-package');
  const f = await setup(t, [final('unused')]);
  await assert.rejects(collect(f.runtime.stream({ ...f.options, cwd: '' })), { code: 'NATIVE_ENGINE_WORKSPACE_UNAVAILABLE' });
  await assert.rejects(collect(f.runtime.stream({ ...f.options, modelProvider: {} })), { code: 'NATIVE_ENGINE_MODEL_UNAVAILABLE' });
  const broken = createNativeEngineRuntime({ stateRoot: join(tmpdir(), 'studio-engine-broken'), env: { PATH: process.env.PATH },
    resolveCommand: () => ({ command: process.execPath, args: ['-e', 'process.exit(3)'] }) });
  await assert.rejects(collect(broken.stream(f.options)), { code: 'NATIVE_ENGINE_UNAVAILABLE' });
  assert.equal(f.model.requests.length, 0);
});
