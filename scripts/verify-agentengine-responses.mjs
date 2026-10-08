/** Run the existing AgentEngine ChatService against the Node HTTP boundary.
 * Uses a fixture runner and synthetic credentials; this is not a cloud deployment proof.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { startBuildRuntimeHttp } from '../src/build-runtime-http.mjs';

const option = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const root = option('--server-root'), python = option('--python');
if (!root || !python) {
  console.log('Usage: node scripts/verify-agentengine-responses.mjs --server-root AGENTENGINE_SERVER_CHECKOUT --python SERVER_PYTHON');
} else {
  const requests = [], token = randomBytes(32).toString('hex');
  const server = await startBuildRuntimeHttp({ agentId: 'ar-local-transport-proof', buildId: 'build_0123456789abcdef0123', token, port: 0,
    runner: async request => {
      requests.push(request);
      request.onFrame({ kind: 'assistant', value: { type: 'chunk', attemptId: 'probe', chunk: { type: 'text-delta', index: 0, text: 'TRANSPORT-OK' } } });
      request.onFrame({ kind: 'assistant', value: { type: 'end', attemptId: 'probe', outcome: { kind: 'committed', eventType: 'assistant/message' } } });
      return { output: 'TRANSPORT-OK', tokenUsage: { inputTokens: 2, outputTokens: 3 } };
    } });
  try {
    const program = `
import asyncio, importlib.util, json, os
from pathlib import Path
# Loading this service file avoids unrelated database initialization in app.services.__init__.
spec = importlib.util.spec_from_file_location('studio_chat_transport_probe', Path('app/services/chat_service.py').resolve())
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
async def main():
    service = module.ChatService()
    kwargs = dict(endpoint=os.environ['PROBE_ENDPOINT'], messages=[{'role':'user','content':[{'type':'input_text','text':'ordinary query'}]}], session_id='transport-session', user='transport-user', account_id='transport-tenant', headers={'Authorization':'Bearer '+os.environ['PROBE_TOKEN']})
    result = await service.responses(**kwargs)
    assert result['status'] == 'completed' and result['output_text'] == 'TRANSPORT-OK'
    assert result['usage']['total_tokens'] == 5
    stream = ''.join([chunk async for chunk in service.stream_responses(**kwargs)])
    frames = [json.loads(line[6:]) for line in stream.splitlines() if line.startswith('data: ') and line != 'data: [DONE]']
    assert any(frame['type'] == 'response.output_text.delta' and frame['delta'] == 'TRANSPORT-OK' for frame in frames)
    final = next(frame for frame in frames if frame['type'] == 'response.completed')
    assert final['output_text'] == final['response']['output_text'] == 'TRANSPORT-OK'
    assert stream.endswith('data: [DONE]\\n\\n')
asyncio.run(main())
`;
    const child = spawn(resolve(python), ['-c', program], { cwd: resolve(root), env: { ...process.env, PROBE_ENDPOINT: `http://127.0.0.1:${server.address.port}`, PROBE_TOKEN: token }, stdio: ['ignore', 'ignore', 'pipe'] });
    let diagnostic = '';
    child.stderr.on('data', value => { diagnostic += value.toString(); });
    const code = await new Promise((accept, reject) => { child.once('error', reject); child.once('exit', accept); });
    if (code !== 0) throw new Error(`AgentEngine transport probe failed (${code}); ${diagnostic.split('\n').filter(line => /Error:|AssertionError/.test(line)).at(-1) || 'check the configured Python environment'}`);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].input, 'ordinary query');
    assert.equal(requests[0].sessionId, requests[1].sessionId);
    assert.notEqual(requests[0].occurrenceId, requests[1].occurrenceId);
    console.log(JSON.stringify({ passed: true, scope: 'AgentEngine-ChatService-to-Node-HTTP-fixture-runner', json: true, sse: true, inputParts: true, session: true, tokenUsage: true }));
  } finally { await server.close(); }
}
