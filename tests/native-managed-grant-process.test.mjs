import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, realpathSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createManagedNativeKernel } from '../src/providers/native-managed-kernel.mjs';
import { permitIssuer, target, scope, binding, response } from './fixtures/native-managed-kernel.mjs';

for (const mode of ['rollback', 'qualified']) test(`actual SIGKILL preserves original grant transaction/qualification (${mode})`, async t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'managed-grant-crash-')));
  const child = fork(new URL('./fixtures/native-managed-grant-process.mjs', import.meta.url), [directory, mode],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = '', runtime; child.stderr.on('data', bytes => { stderr += bytes; });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); }
    await runtime?.close(); rmSync(directory, { recursive: true, force: true }); });
  const boundary = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Grant child timeout: ' + stderr)), 15000);
    child.on('message', value => { if (value.kind === 'held') { clearTimeout(timer); resolve(value); } });
    child.once('exit', (code, signal) => { clearTimeout(timer); reject(Error(`Grant child exited ${code}/${signal}: ${stderr}`)); });
  });
  assert.equal(boundary.pid, child.pid);
  const exit = once(child, 'exit'); child.kill('SIGKILL'); const [code, signal] = await exit;
  assert.equal(code, null); assert.equal(signal, 'SIGKILL');
  assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
  const admitted = JSON.parse(readFileSync(join(directory, 'process-admission.json'), 'utf8'));
  const issuer = permitIssuer(); let models = 0;
  const config = { directory, target, permitVerifier: issuer.verifier, assertCurrent: () => true, autoStart: false,
    resolveBinding: request => binding(request.command, { model: { generate: async () => { models++; return response(); } } }) };
  runtime = createManagedNativeKernel(config);
  const grants = runtime.executionGrants;
  const before = grants.get(admitted.spec);
  assert.equal(before.grant.state, 'active'); assert.equal(before.grant.revision, 1);
  assert.equal(grants.lookup(admitted.spec, { idempotency_key: 'crash-stop' }), null);
  if (mode === 'rollback') assert.deepEqual(before.queued_message_ids, [admitted.receipt.message_id]);
  else assert.deepEqual(before.in_flight_message_ids, [admitted.receipt.message_id]);
  const stopped = grants.setState(admitted.spec, 'revoked', { expected_revision: 1, idempotency_key: 'stop-after-crash' });
  assert.deepEqual(stopped.discarded_message_ids, mode === 'rollback' ? [admitted.receipt.message_id] : []);
  await runtime.drain(admitted.command.session_id);
  assert.equal(models, mode === 'rollback' ? 0 : 1);
  const original = runtime.inspectSession({ scope, sessionId: admitted.command.session_id, runId: admitted.receipt.run_id });
  assert.equal(original.commandState, mode === 'rollback' ? 'discarded' : 'settled');
  assert.equal(original.record?.snapshot.runId ?? null, mode === 'rollback' ? null : admitted.receipt.run_id);
  assert.equal(original.record?.snapshot.turnId ?? null, mode === 'rollback' ? null : admitted.command.command_id);
  const db = new DatabaseSync(join(directory, 'commands.sqlite'), { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM managed_runs').get().n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM managed_command_claims').get().n, mode === 'rollback' ? 0 : 1);
  } finally { db.close(); }
  const barrier = grants.get(admitted.spec); await runtime.close(); runtime = createManagedNativeKernel(config);
  assert.deepEqual(runtime.executionGrants.get(admitted.spec), barrier);
  await runtime.drain(admitted.command.session_id); assert.equal(models, mode === 'rollback' ? 0 : 1);
});
