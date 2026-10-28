import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createManagedNativeKernel } from '../src/providers/native-managed-kernel.mjs';
import { permitIssuer, command, target, scope, binding, response } from './fixtures/native-managed-kernel.mjs';

const pause = () => new Promise(resolve => setTimeout(resolve, 10));
async function until(check) { const deadline = Date.now() + 5000;
  for (;;) { const value = check(); if (value) return value; assert.ok(Date.now() < deadline, 'timed out waiting for durable scoped delivery'); await pause(); } }
function setup(t, options = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'scoped-native-'))), issuer = permitIssuer();
  const entered = Promise.withResolvers(), finish = Promise.withResolvers();
  const counts = { models: 0, effects: 0, prepared: 0, delivered: 0 }, deliveries = [];
  const config = { directory, target, permitVerifier: issuer.verifier, assertCurrent: () => true, autoStart: false,
    resolveBinding: ({ command }) => binding(command, { model: { generate: async () => {
      counts.models++; entered.resolve(); await finish.promise; return response();
    } } }),
    scopedControl: {
      prepare: async ({ command, run }) => { counts.prepared++; assert.equal(run.record.snapshot.phase, 'requesting_model');
        if (command.payload.scope_id !== 'a2a-original') throw Object.assign(Error('scope missing'), { code: 'NATIVE_MANAGED_SCOPE_NOT_FOUND' });
        return { scopeId: 'a2a-original', originalRun: run.runId }; },
      execute: async input => { counts.delivered++; input.assertCurrent(); deliveries.push(input);
        return options.deliver ? options.deliver(input, counts) : { outcome: 'remote_cancelled' }; },
    }, ...options.config };
  let runtime = createManagedNativeKernel(config), db = new DatabaseSync(join(directory, 'commands.sqlite'));
  t.after(async () => { finish.resolve(); await runtime.close(); db.close(); rmSync(directory, { recursive: true, force: true }); });
  const receive = cmd => runtime.receive(cmd, issuer.issue(cmd));
  return { directory, config, issuer, receive, counts, deliveries, entered, finish, get runtime() { return runtime; },
    row: id => db.prepare('SELECT * FROM managed_scoped_controls WHERE command_id=?').get(id),
    async start() { const cmd = command(), receipt = await receive(cmd); const running = runtime.drain(cmd.session_id); void running.catch(() => {});
      await entered.promise; return { cmd, receipt, running, query: { scope, sessionId: cmd.session_id, runId: receipt.run_id } }; },
    scoped: (root, more = {}) => command({ command_type: 'interrupt', payload: { run_id: root.receipt.run_id, scope_id: 'a2a-original' }, ...more }),
    async close() { await runtime.close(); },
    async reopen() { await runtime.close(); db.close(); runtime = createManagedNativeKernel(config); db = new DatabaseSync(join(directory, 'commands.sqlite')); },
  };
}

test('signed scoped interrupt persists delivery independently and leaves its original root live', async t => {
  const f = setup(t), root = await f.start(), cancel = f.scoped(root);
  assert.equal((await f.receive(cancel)).status, 'accepted');
  const row = await until(() => f.row(cancel.command_id)?.state === 'delivered' && f.row(cancel.command_id));
  assert.equal(JSON.parse(row.result).outcome, 'remote_cancelled');
  assert.equal(f.deliveries[0].actor, 'server-user'); assert.equal(f.deliveries[0].target.originalRun, root.receipt.run_id);
  assert.equal(f.runtime.inspectSession(root.query).record.snapshot.phase, 'requesting_model');
  assert.ok(!f.runtime.inspectSession(root.query).record.commands.some(row => row.command.kind === 'cancel'));
  assert.equal((await f.receive(cancel)).status, 'duplicate');
  await pause(); assert.equal(f.counts.delivered, 1);
  f.finish.resolve(); await root.running;
  assert.equal(f.runtime.inspectSession(root.query).record.snapshot.phase, 'completed');
  const original = f.runtime.inspectSession(root.query).record;
  await f.reopen(); assert.deepEqual(f.runtime.inspectSession(root.query).record, original);
  assert.equal((await f.receive(cancel)).status, 'duplicate'); assert.equal(f.counts.models, 1); assert.equal(f.counts.delivered, 1);
});

test('missing, foreign and unowned scopes cannot become root cancellation', async t => {
  const f = setup(t), root = await f.start();
  for (const payload of [{ scope_id: 'missing' }, { run_id: 'foreign', scope_id: 'a2a-original' }]) {
    const result = await f.receive(f.scoped(root, { payload })); assert.equal(result.status, 'rejected');
    assert.equal(result.error.code, 'native_child_scope_not_found');
  }
  const other = f.scoped(root, { session_id: 'foreign-session' });
  assert.equal((await f.receive(other)).error.code, 'native_child_scope_not_found');
  const unsupported = command({ command_type: 'pause', payload: { run_id: root.receipt.run_id, scope_id: 'a2a-original' } });
  assert.equal((await f.receive(unsupported)).status, 'unsupported');
  assert.equal(f.counts.delivered, 0); assert.equal(f.runtime.inspectSession(root.query).record.snapshot.phase, 'requesting_model');
});

test('scope without run_id selects the active original command ahead of queued roots', async t => {
  const f = setup(t), root = await f.start();
  const queued = await f.receive(command());
  const cancel = f.scoped(root, { payload: { scope_id: 'a2a-original' } });
  const receipt = await f.receive(cancel); assert.equal(receipt.run_id, root.receipt.run_id); assert.notEqual(receipt.run_id, queued.run_id);
  await until(() => f.row(cancel.command_id)?.state === 'delivered');
  assert.equal(f.deliveries[0].run.runId, root.receipt.run_id);
});

test('admission fault rolls back cancellation queue, public receipt and control facts together', async t => {
  let fail = false;
  const f = setup(t, { config: { beforeCommit: () => { if (fail) throw Error('atomic fault'); } } }), root = await f.start();
  const cancel = f.scoped(root); fail = true;
  await assert.rejects(f.receive(cancel), /atomic fault/u); fail = false;
  assert.equal(f.row(cancel.command_id), undefined); assert.equal(f.counts.delivered, 0);
  assert.equal((await f.receive(cancel)).status, 'accepted');
  await until(() => f.row(cancel.command_id)?.state === 'delivered'); assert.equal(f.counts.delivered, 1);
});

test('two actual receivers claim a scoped delivery once and duplicate permits do not duplicate it', async t => {
  const held = Promise.withResolvers(), seen = Promise.withResolvers();
  const f = setup(t, { deliver: async input => { seen.resolve(); await held.promise; input.assertCurrent(); return { outcome: 'remote_cancelled' }; } });
  const root = await f.start(), cancel = f.scoped(root), receipt = await f.receive(cancel);
  await seen.promise;
  const peer = createManagedNativeKernel(f.config); t.after(() => peer.close());
  assert.equal((await peer.receive(cancel, f.issuer.issue(cancel))).status, 'duplicate');
  peer.startRecovery(); await pause(); assert.equal(f.counts.delivered, 1);
  held.resolve(); await until(() => f.row(cancel.command_id)?.state === 'delivered'); assert.equal(receipt.run_id, root.receipt.run_id);
  await peer.close();
});

test('shutdown retires an uncooperative callback; a late result cannot publish or cancel the root', async t => {
  const held = Promise.withResolvers(), seen = Promise.withResolvers();
  const f = setup(t, { deliver: input => { seen.resolve(input); return held.promise; } }), root = await f.start(), cancel = f.scoped(root);
  await f.receive(cancel); const attempt = await seen.promise;
  f.finish.resolve(); await f.close();
  assert.throws(attempt.assertCurrent); held.resolve({ outcome: 'remote_cancelled' }); await pause();
  assert.equal(f.row(cancel.command_id).state, 'queued');
  assert.equal(f.counts.delivered, 1);
});

test('permanent loss of original permission rejects delivery without retrying or cancelling the root', async t => {
  const f = setup(t, { deliver: () => { throw Object.assign(Error('original consent unavailable'), { code: 'STUDIO_NATIVE_A2A_PERMISSION_UNAVAILABLE' }); } });
  const root = await f.start(), cancel = f.scoped(root); await f.receive(cancel);
  await until(() => f.row(cancel.command_id)?.state === 'rejected');
  assert.equal(f.counts.delivered, 1); assert.equal(f.runtime.inspectSession(root.query).record.snapshot.phase, 'requesting_model');
  assert.equal((await f.receive(cancel)).status, 'duplicate'); assert.equal(f.counts.delivered, 1);
});
