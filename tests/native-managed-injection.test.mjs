import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { canonical } from '@kingsoftcloud/agentkit-harness-core';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { createManagedNativeKernel } from '../src/providers/native-managed-kernel.mjs';
import { binding, command, scope, target, permitIssuer, response } from './fixtures/native-managed-kernel.mjs';

function setup(t, options = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'managed-injection-'))), issuer = permitIssuer(), requests = [];
  const resolveBinding = Object.assign(({ command }) => binding(command, { model: { generate: async request => {
    requests.push(request); return response();
  } } }), { resolveInjectionScope: async () => scope });
  const configuration = { directory, target, permitVerifier: issuer.verifier, resolveBinding, assertCurrent: () => true,
    autoStart: false, ...options };
  let runtime = createManagedNativeKernel(configuration);
  t.after(async () => { await runtime.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, issuer, requests, configuration, get runtime() { return runtime; },
    receive: (value, permit = issuer.issue(value)) => runtime.receive(value, permit),
    async reopen() { await runtime.close(); runtime = createManagedNativeKernel(configuration); },
  };
}
const injection = (index, options = {}) => command({ command_type: 'inject', payload: { content: `Silent ${index}` }, ...options });
const records = request => request.messages.filter(message => message.kind === 'session_injection').map(message => JSON.parse(message.content));

test('managed C2: 100 signed injections do not create Runs or call models; a later enqueue consumes them in order after reopening', async t => {
  const f = setup(t), commands = [];
  for (let index = 0; index < 100; index++) {
    const value = injection(index); commands.push(value);
    const receipt = await f.receive(value);
    assert.equal(receipt.status, 'accepted'); assert.equal(receipt.run_id, null);
  }
  assert.equal(f.runtime.capabilities.inject, true); assert.equal(f.requests.length, 0);
  await f.runtime.drain(commands[0].session_id); assert.equal(f.requests.length, 0);
  await f.reopen(); assert.equal(f.requests.length, 0);
  const wake = command(), accepted = await f.receive(wake); await f.runtime.drain(wake.session_id);
  assert.equal(f.requests.length, 1);
  assert.deepEqual(records(f.requests[0]).map(row => row.text), Array.from({ length: 100 }, (_, index) => `Silent ${index}`));
  assert.equal((await f.receive(commands[0])).status, 'duplicate');
  const store = new SqliteRunStore(join(f.directory, 'runs.sqlite')); t.after(() => store.close());
  assert.equal(store.load(scope, accepted.run_id).snapshot.sessionInjections.length, 100);
  const next = command(); const second = await f.receive(next); await f.runtime.drain(next.session_id);
  assert.equal(store.load(scope, second.run_id).snapshot.sessionInjections, undefined);
  assert.equal(f.requests.length, 2);
});

test('managed injection verifies its own operation, rejects identity/payload drift and never enters a model binding', async t => {
  let lookups = 0;
  const f = setup(t, { resolveBinding: Object.assign(() => { lookups++; assert.fail('Injection must not resolve execution ports'); },
    { resolveInjectionScope: async () => scope }) });
  const value = injection(1);
  await assert.rejects(f.receive(value, f.issuer.issue(value, 'enqueue')), { code: 'NATIVE_KERNEL_PERMIT_INVALID' });
  assert.equal((await f.receive(value)).status, 'accepted');
  assert.equal((await f.receive({ ...value, payload: { content: 'Changed' } })).error.code, 'idempotency_conflict');
  await assert.rejects(f.receive(injection(2, { payload: { content: 'Data', role: 'system' } })), { code: 'NATIVE_KERNEL_COMMAND_INVALID' });
  f.configuration.resolveBinding.resolveInjectionScope = async () => ({ ...scope, tenantId: 'foreign' });
  await assert.rejects(f.receive(injection(3)), { code: 'NATIVE_MANAGED_INJECTION_BINDING_UNAVAILABLE' });
  assert.equal(lookups, 0); assert.equal(f.requests.length, 0);
});

test('managed outbox cold recovery redelivers an unacknowledged inbox insert once without starting a task', async t => {
  const f = setup(t), value = injection(9), accepted = await f.receive(value);
  assert.equal(accepted.status, 'accepted'); await f.runtime.close();
  // This is the durable state after the RunStore commit but before the command-store ACK.
  const db = new DatabaseSync(join(f.directory, 'commands.sqlite'));
  db.prepare("UPDATE managed_commands SET state='injection_pending' WHERE command_id=?").run(value.command_id); db.close();
  await f.reopen();
  const store = new SqliteRunStore(join(f.directory, 'runs.sqlite')); t.after(() => store.close());
  const row = { injectionId: value.command_id, text: value.payload.content,
    source: { kind: value.source.kind, ref: value.source.ref } };
  assert.equal(store.inject(scope, value.session_id, row).status, 'duplicate'); assert.equal(f.requests.length, 0);
  const wake = command(); await f.receive(wake); await f.runtime.drain(wake.session_id);
  assert.deepEqual(records(f.requests[0]).map(row => row.text), ['Silent 9']);
  assert.equal(canonical(records(f.requests[0])).includes('permission'), false);
});

test('a full bounded inbox cannot deadlock an accepted wake; overflow stays durable for the following turn', async t => {
  const f = setup(t), store = new SqliteRunStore(join(f.directory, 'runs.sqlite'));
  t.after(() => store.close());
  for (let index = 0; index < 1000; index++) store.inject(scope, 'a2a-kernel-managed', {
    injectionId: `existing-${index}`, text: `Queued ${index}`, source: { kind: 'channel', ref: 'existing' },
  });
  const extra = injection(1001); assert.equal((await f.receive(extra)).status, 'accepted');
  const first = command(), admitted = await f.receive(first); await f.runtime.drain(first.session_id);
  assert.equal(store.load(scope, admitted.run_id).snapshot.sessionInjections.length, 1000);
  assert.equal(f.requests.length, 1, 'Outbox delivery itself must not start another turn');
  const next = command(), second = await f.receive(next); await f.runtime.drain(next.session_id);
  assert.deepEqual(store.load(scope, second.run_id).snapshot.sessionInjections, [{ injectionId: extra.command_id, sequence: 1001 }]);
  assert.equal(f.requests.length, 2);
});
