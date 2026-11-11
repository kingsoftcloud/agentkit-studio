import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { registerStudioManagedNativeRemote } from '../src/host/services/native-managed-remote.mjs';
import { command, permitIssuer, scope, target } from './fixtures/native-managed-kernel.mjs';

const nodeModule = import.meta.resolve('@kingsoftcloud/agentkit-harness-node/native/managed-kernel');
const { createEngineService } = await import(new URL('engine-service.mjs', nodeModule));

test('Studio routes signed commands and resumable event delivery to the independent Harness ledger', async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'studio-remote-managed-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const issuer = permitIssuer();
  const token = 'fixture-managed-service-authentication';
  const expected = 'Verified result.';
  let calls = 0;
  const options = {
    token, startup: { workspace, stateDir: join(root, 'state'), scope,
      model: { name: 'fixture', baseUrl: 'https://example.test/v1', apiKeyEnv: 'FIXTURE_MODEL_KEY' } },
    env: { FIXTURE_MODEL_KEY: 'fixture-model-key' },
    managed: { buildId: 'fixture-build', controlPublicKeys: { server: issuer.publicKeyPem },
      authorizeInteraction: async ({ authorization, command: control }) => authorization.subjectRef === 'server-user'
        && control.payload.token_ref === 'fixture-owner-consent' },
    fetchImpl: async () => {
      const step = ++calls;
      assert(step <= 2);
      const delta = step === 1 ? { tool_calls: [{ index: 0, id: 'fixture-write', type: 'function',
        function: { name: 'write_workspace_file', arguments: '{"path":"verified.txt","content":"once"}' } }] }
        : { content: expected };
      return new Response('data: ' + JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta,
        finish_reason: step === 1 ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } }) + '\n\ndata: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } });
    },
  };
  let engine = createEngineService(options), host;
  const dispose = [];
  t.after(async () => {
    for (const close of dispose.reverse()) close();
    if (host) await new Promise(resolve => host.close(resolve));
    await engine?.close();
    await rm(root, { recursive: true, force: true });
  });
  const listen = (server, port = 0) => new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server.address().port);
    });
  });
  const port = await listen(engine.server);
  let route;
  registerStudioManagedNativeRemote({
    effect(fn) { dispose.push(fn()); },
    inject(_deps, mount) {
      mount({ effect(fn) { dispose.push(fn()); }, webServer: { register(value) {
        route = value;
        return () => { route = undefined; };
      } } });
    },
  }, { endpoint: 'http://127.0.0.1:' + port, token });
  host = createServer(route.handler);
  const origin = 'http://127.0.0.1:' + await listen(host) + route.path;
  const post = (path, body, signal = AbortSignal.timeout(8000)) => fetch(origin + '/' + path, {
    method: 'POST', signal,
    // Studio must replace the inbound authorization with its service token.
    headers: { authorization: 'Bearer not-the-service-token', 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const input = command({ payload: { content: 'Write and verify the file.' } });
  const send = (value, permit = issuer.issue(value)) => post('commands', { command: value, permit });
  const query = { tenant_id: target.tenantId, agent_instance_id: target.agentInstanceId,
    session_id: input.session_id, authorization_ref: 'fixture-status' };
  const getStatus = value => post('status', { query: value, permit: issuer.issue(value, 'get_status') });
  async function eventWhere(eventType, afterSeq = 0) {
    const subscription = { ...query, after_seq: afterSeq };
    const stream = await post('events', { subscription, permit: issuer.issue(subscription, 'subscribe_events') });
    assert.equal(stream.status, 200);
    assert.equal(stream.headers.get('content-type'), 'text/event-stream');
    const reader = stream.body.getReader(), decoder = new TextDecoder();
    let pending = '';
    try {
      for (;;) {
        const chunk = await reader.read();
        assert.equal(chunk.done, false, 'Stream ended before ' + eventType);
        pending += decoder.decode(chunk.value, { stream: true });
        const frames = pending.split('\n\n');
        pending = frames.pop();
        for (const frame of frames) {
          const line = frame.split('\n').find(value => value.startsWith('data: '));
          const event = line && JSON.parse(line.slice(6));
          if (!event || event.event_type !== eventType) continue;
          assert(event.seq > afterSeq);
          assert(frame.startsWith('id: ' + event.seq + '\n'));
          assert(!frame.includes(token));
          return event;
        }
      }
    } finally { await reader.cancel(); }
  }
  const rejected = await send(input, { ...issuer.issue(input), signature: 'invalid' });
  assert.equal(rejected.status, 403);
  assert.equal((await rejected.json()).error.code, 'NATIVE_KERNEL_AUTHORIZATION_FAILED');
  assert.equal((await post('commands', '{"permit":1,"permit":2}')).status, 400);
  assert.equal((await post('commands', ' '.repeat(2 * 1024 ** 2 + 1))).status, 400);
  assert.equal((await post('commands?extra=1', {})).status, 404);
  assert.equal((await post('execution-grants/ensure', {})).status, 404);
  assert.equal(calls, 0);
  const admitted = await send(input);
  assert.equal(admitted.status, 202);
  const receipt = await admitted.json();
  const approval = await eventWhere('interaction.requested');
  assert.equal(approval.run_id, receipt.run_id);
  assert.equal(calls, 1);
  const unrelated = await getStatus({ ...query, session_id: 'unrelated-session' });
  assert.deepEqual((await unrelated.json()).runs, []);

  await engine.close();
  engine = null;
  const unavailable = await getStatus(query);
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json()).error.code, 'NATIVE_KERNEL_UNAVAILABLE');
  engine = createEngineService(options);
  await listen(engine.server, port);
  const retry = await send(input);
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).run_id, receipt.run_id);
  assert.equal((await (await getStatus(query)).json()).runs[0].phase, 'awaiting_interaction');
  const decision = await send(command({ session_id: input.session_id, command_type: 'submit_interaction',
    payload: { run_id: receipt.run_id, interaction_id: approval.payload.interaction_id,
      token_ref: 'fixture-owner-consent', response: 'approve' } }));
  assert.equal(decision.status, 202);
  const terminal = await eventWhere('run.completed', approval.seq);
  assert.equal(terminal.run_id, receipt.run_id);
  assert.equal(await readFile(join(workspace, 'verified.txt'), 'utf8'), 'once');
  assert.equal(calls, 2);
});
