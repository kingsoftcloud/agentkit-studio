import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createManagedNativeKernel } from '../src/providers/native-managed-kernel.mjs';
import { createManagedNativeKernelHttp, MANAGED_NATIVE_KERNEL_PATH } from '../src/providers/native-managed-kernel-http.mjs';
import { permitIssuer, command, target, binding } from './fixtures/native-managed-kernel.mjs';
import { assertManagedRuntimeFacts } from './fixtures/native-managed-runtime-schema.mjs';

async function fixture(t) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'managed-kernel-http-'))), issuer = permitIssuer();
  const runtime = createManagedNativeKernel({ directory, target, permitVerifier: issuer.verifier,
    resolveBinding: ({ command }) => binding(command), assertCurrent: () => true, autoStart: false });
  const transport = createManagedNativeKernelHttp(runtime), server = createServer(transport.handle);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { transport.close(); await runtime.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(directory, { recursive: true, force: true }); });
  const send = (path, body, options = {}) => fetch(origin + MANAGED_NATIVE_KERNEL_PATH + path, {
    method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), signal: AbortSignal.timeout(5000), ...options,
  });
  const query = session => ({ tenant_id: target.tenantId, agent_instance_id: target.agentInstanceId, session_id: session, authorization_ref: randomUUID() });
  return { issuer, runtime, transport, send, query };
}

test('versioned real HTTP accepts a signed command, serves durable status/SSE and replays original receipt', async t => {
  const f = await fixture(t), cmd = command(), payload = { command: cmd, permit: f.issuer.issue(cmd) };
  const admitted = await f.send('/commands', payload); assert.equal(admitted.status, 202); const receipt = await admitted.json();
  await f.runtime.drain(cmd.session_id);
  const retry = await f.send('/commands', { command: cmd, permit: f.issuer.issue(cmd) }); assert.equal(retry.status, 200);
  const duplicate = await retry.json(); assert.equal(duplicate.status, 'duplicate'); assert.equal(duplicate.message_id, receipt.message_id);
  const query = f.query(cmd.session_id), status = await f.send('/status', { query, permit: f.issuer.issue(query, 'get_status') });
  assert.equal(status.status, 200); assert.equal((await status.json()).runs[0].phase, 'completed');
  const subscription = { ...f.query(cmd.session_id), after_seq: 0 }, controller = new AbortController();
  const stream = await f.send('/events', { subscription, permit: f.issuer.issue(subscription, 'subscribe_events') }, { signal: controller.signal });
  assert.equal(stream.status, 200); const reader = stream.body.getReader(); let text = '';
  for (;;) { const next = await reader.read(); text += new TextDecoder().decode(next.value);
    if (text.includes('"state":"completed"')) break; assert.equal(next.done, false); }
  controller.abort(); await reader.cancel().catch(() => {});
  const facts = text.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
  assert.equal(facts.at(-1).payload.state, 'completed'); assert.ok(facts.every(fact => text.includes(`id: ${fact.seq}\n`)));
  assertManagedRuntimeFacts(facts);
  assert.doesNotMatch(text, /signature|token_ref|authorization_ref/u);
});

test('unsigned, altered, ambiguous and invalid-cursor requests fail before work or SSE headers', async t => {
  const f = await fixture(t), cmd = command();
  assert.equal((await f.send('/commands', { command: cmd, permit: {} })).status, 403);
  assert.equal((await f.send('/commands', 'null')).status, 400);
  assert.equal((await f.send('/commands', '{"command":1,"command":2}')).status, 400);
  const subscription = { ...f.query(cmd.session_id), after_seq: -1 };
  assert.equal((await f.send('/events', { subscription, permit: f.issuer.issue(subscription, 'subscribe_events') })).status, 400);
  const query = f.query(cmd.session_id); assert.deepEqual((await (await f.send('/status', { query, permit: f.issuer.issue(query, 'get_status') })).json()).runs, []);
});

test('HTTP can reference trusted grants but cannot create them or invoke their management methods', async t => {
  const f = await fixture(t), spec = { grant_id: 'http-occurrence', tenant_id: target.tenantId, agent_instance_id: target.agentInstanceId,
    session_id: 'a2a-kernel-managed', owner_ref: 'trusted-composition' };
  const cmd = command({ payload: { content: 'x', execution_grant_id: spec.grant_id } });
  const missing = await f.send('/commands', { command: cmd, permit: f.issuer.issue(cmd) });
  assert.equal(missing.status, 400); assert.equal((await missing.json()).error.code, 'execution_grant_not_found');
  assert.equal((await f.send('/execution-grants/ensure', { spec })).status, 404);
  const invalid = command({ payload: { content: 'x', execution_grant_attempt_epoch: 1 } });
  assert.equal((await f.send('/commands', { command: invalid, permit: f.issuer.issue(invalid) })).status, 400);
  f.runtime.executionGrants.ensure(spec);
  assert.equal((await f.send('/commands', { command: cmd, permit: f.issuer.issue(cmd) })).status, 202);
  f.runtime.executionGrants.setState(spec, 'revoked', { expected_revision: 1, idempotency_key: 'stop' });
  await f.runtime.drain(cmd.session_id);
  assert.equal(f.runtime.executionGrants.get(spec).discarded_message_ids.length, 1);
});

test('closing an idle SSE reader leaves its durable command pending; transport close destroys open streams', async t => {
  const f = await fixture(t), cmd = command(); await f.send('/commands', { command: cmd, permit: f.issuer.issue(cmd) });
  const subscription = { ...f.query(cmd.session_id), after_seq: 1 }, controller = new AbortController();
  const response = await f.send('/events', { subscription, permit: f.issuer.issue(subscription, 'subscribe_events') }, { signal: controller.signal });
  assert.equal(response.status, 200); const reader = response.body.getReader(), pending = reader.read();
  f.transport.close(); await assert.rejects(pending); controller.abort();
  const query = f.query(cmd.session_id), status = await f.runtime.getStatus(query, f.issuer.issue(query, 'get_status'));
  assert.equal(status.runs[0].phase, 'pending');
  await f.runtime.drain(cmd.session_id); assert.equal((await f.runtime.getStatus(query, f.issuer.issue(query, 'get_status'))).runs[0].phase, 'completed');
});
