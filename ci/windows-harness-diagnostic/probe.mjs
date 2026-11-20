import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const version = '0.0.28';
const [archive, candidateDirectory] = process.argv.slice(2);
const source = join(archive, 'dsh/node_modules/@kingsoftcloud/agentkit-studio/src');
const load = path => import(pathToFileURL(join(source, path)));

async function verifyOutputResume(load, root, runtime) {
  const { createNativeEngineRuntime } = await load('providers/native-engine-runtime.mjs');
  const { startStarHarness } = await load('host/services/star-harness-release.mjs');
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const modelName = 'desktop-output-fixture';
  const apiKey = 'desktop-output-fixture';
  const requests = [];
  const frame = (delta, finish_reason = null, extra = {}) => 'data: ' + JSON.stringify({
    id: 'desktop-output-acceptance', object: 'chat.completion.chunk', model: modelName,
    choices: [{ index: 0, delta, finish_reason }], ...extra,
  }) + '\n\n';
  const end = 'data: [DONE]\n\n';
  const toolArgs = JSON.stringify({ path: 'proof.txt', content: 'One confirmed write.\n' });
  const first = frame({ role: 'assistant', tool_calls: [{ index: 0, id: 'write-once', type: 'function',
    function: { name: 'write_workspace_file', arguments: '' } }] });
  const pieces = Array.from({ length: 280 }, (_, index) => frame({ tool_calls: [
    { index: 0, function: { arguments: toolArgs[index] ?? '' } },
  ] }, null, { system_fingerprint: 'p'.repeat(31_000) }));
  const largeResponse = first + pieces.join('') + frame({}, 'tool_calls') + end;
  assert.ok(Buffer.byteLength(largeResponse) > 8 * 1024 * 1024);
  const cutoff = frame({ role: 'assistant', reasoning_content: 'Planning the next step.' }) +
    frame({}, 'length', { usage: { prompt_tokens: 10, completion_tokens: 32000, total_tokens: 32010,
      completion_tokens_details: { reasoning_tokens: 32000 } } }) + end;
  const finalText = 'Continued the original task.';
  const final = frame({ role: 'assistant', content: finalText }, 'stop') + end;
  const model = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks)));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(requests.length === 1 ? largeResponse : requests.length < 5 ? cutoff : final);
  });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${model.address().port}/v1`;
  let service;
  try {
    service = await startStarHarness({ packageDirectory: runtime, version, workspaceRoot: workspace,
      stateDir: join(root, 'engine'), profile: { modelName, baseUrl, apiKey } });
    assert.equal(service.version, version);
    const studio = createNativeEngineRuntime({ stateRoot: join(root, 'studio-state'), env: {
      AGENTKIT_ENGINE_SERVICE_URL: service.endpoint, AGENTKIT_ENGINE_SERVICE_TOKEN: service.token,
      AGENTKIT_ENGINE_SERVICE_WORKSPACE: workspace, AGENTKIT_ENGINE_SERVICE_MODEL: modelName,
    } });
    const chunks = [];
    for await (const chunk of studio.stream({ cwd: workspace, sessionId: 'desktop-output', turnId: 'first',
      input: 'Write proof.txt and finish the original task.', model: modelName, modelProvider: { baseUrl, apiKey },
      sandbox: 'danger-full-access', signal: AbortSignal.timeout(90000),
    })) chunks.push(chunk);
    assert.equal(chunks.findLast(chunk => chunk.type === 'text')?.text, finalText);
    const events = chunks.filter(chunk => chunk.type === 'engine-event');
    assert.equal(new Set(events.map(chunk => chunk.runId)).size, 1);
    assert.equal(events.filter(chunk => chunk.event.kind === 'run.started').length, 1);
    assert.equal(events.filter(chunk => chunk.event.kind === 'tool.completed').length, 1);
    assert.equal(await readFile(join(workspace, 'proof.txt'), 'utf8'), 'One confirmed write.\n');
    assert.equal(requests.length, 5);
    assert.ok(requests.at(-1).messages.some(message => message.role === 'tool'));
    console.log(JSON.stringify({ studio: '0.0.22', harness: version, wireBytes: Buffer.byteLength(largeResponse),
      requests: requests.length, runId: events[0].runId, completedWrites: 1 }));
  } finally {
    await service?.stop();
    await new Promise(resolve => { model.closeAllConnections(); model.close(resolve); });
  }
}

const root = await mkdtemp(join(tmpdir(), 'studio-win-proof-'));
try {
  await verifyOutputResume(load, root, candidateDirectory);
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
}
