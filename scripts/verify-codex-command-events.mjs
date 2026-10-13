/** Actual pinned CLI against a loopback model; no cloud credentials or model cost. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCodexRuntime } from '../src/providers/codex-runtime.mjs';
import { createCodexToolRecorder } from '../src/providers/codex-tool-events.mjs';

const root = await mkdtemp(join(tmpdir(), 'studio-command-events-'));
await mkdir(join(root, 'codex'));
const outputs = [], recorded = [];
let requests = 0;
const server = createServer(async (request, response) => {
  try {
    let body = '';
    for await (const chunk of request) body += chunk;
    const data = JSON.parse(body);
    assert(++requests <= 3, 'fixture must not loop indefinitely');
    const result = data.messages.filter(message => message.role === 'tool').at(-1);
    if (result) outputs.push(result.content);
    const command = data.tools.find(tool => tool.function?.description?.startsWith('Tool: exec_command\n'));
    assert(command, 'pinned CLI command tool missing');
    const delta = result ? { content: 'The command failed.' } : { tool_calls: [{
      index: 0, id: 'command-events-probe', type: 'function', function: {
        name: command.function.name,
        // Use on a Linux deployment that reproduces the known startup failure.
        // A working command sandbox should fail this diagnostic's final assertion.
        arguments: JSON.stringify({ cmd: 'python3 -c "print(7)"', max_output_tokens: 100 }),
      },
    }] };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: result ? 'stop' : 'tool_calls' }] })}\n\n`);
    response.end('data: [DONE]\n\n');
  } catch { response.writeHead(500); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  const recorder = createCodexToolRecorder({ append(type, data) { recorded.push({ type, data }); } });
  const runtime = createCodexRuntime({ executable: process.env.AGENTKIT_CODEX_BIN, cwd: root,
    inheritEnv: false, env: { PATH: process.env.PATH, CODEX_HOME: join(root, 'codex') },
    approvalPolicy: 'never', sandbox: 'read-only', timeoutMs: 30_000 });
  for await (const chunk of runtime.stream({ input: 'Use Python to print seven.', model: 'probe-model',
    modelProvider: { api: 'chat-completions', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'loopback-fixture-key' },
  })) recorder.record(chunk);
  recorder.close();
  assert.equal(outputs.length, 1, 'actual CLI must return the command error to the model');
  assert.equal(recorded.length, 2, 'one command card with a start and result, no duplicates');
  assert.deepEqual(recorded.map(event => event.data.phase), ['started', 'failed']);
  assert(recorded[1].data.content.some(part => part.text === outputs[0]), 'visible failure must preserve actual executor output');
  assert(recorded[1].data.arguments.includes('print(7)'));
  console.log(JSON.stringify({ passed: true, actualCodexCLI: true, model: 'loopback fixture',
    commandErrors: outputs.length, toolEvents: recorded.length, errorCode: recorded[1].data.error.code }));
} finally {
  await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
