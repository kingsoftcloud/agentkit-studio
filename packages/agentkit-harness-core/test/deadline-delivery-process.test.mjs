import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, appendFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NativeKernel, emptyUsage, wallDeliveryOnly } from '../dist/index.mjs';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { scope, digest } from './fixtures.mjs';
for (const boundary of ['prepared', 'written', 'applied', 'cancel']) test(`actual deadline SIGKILL at ${boundary} retains original time, scope and write receipt`, { timeout: 15000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'native-deadline-kill-')), filename = join(root, 'run.sqlite'); let store;
  const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/deadline-delivery-worker.mjs', import.meta.url)), filename, boundary],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, PATH: '/nonexistent-native-deadline-path' } });
  let stderr = ''; child.stderr.on('data', data => { stderr = (stderr + data).slice(-4000); });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); store?.close(); rmSync(root, { recursive: true, force: true }); });
  const ready = await Promise.race([once(child, 'message').then(([row]) => row), once(child, 'exit').then(([code, signal]) => { throw Error(`${code}/${signal}: ${stderr}`); })]);
  assert.equal(ready.pid, child.pid); assert.notEqual(child.pid, process.pid);
  const exiting = once(child, 'exit'); child.kill('SIGKILL'); assert.deepEqual(await exiting, [null, 'SIGKILL']);
  assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
  store = new SqliteRunStore(filename); const before = store.load(scope, 'run');
  assert.equal(wallDeliveryOnly(before.snapshot, before.configuration), true); assert.equal(before.snapshot.activeElapsedMs, 541000);
  let models = 0, writes = 0;
  const worker = new NativeKernel({ store, digest, owner: 'cold-deadline', ports: { model: { generate: async request => {
    models++; assert.deepEqual(request.tools.map(tool => tool.name), ['write']);
    assert.ok(request.messages.some(message => message.kind === 'deadline_delivery_policy'));
    return boundary === 'prepared' && models === 1 ? { kind: 'tool_calls', text: '', usage: emptyUsage(),
      toolCalls: [{ callId: 'cold-write', name: 'write', arguments: { path: 'report.md', content: 'Original delivery' } }] }
      : { kind: 'final_candidate', text: 'Delivered honestly, still unverified.', toolCalls: [], usage: emptyUsage() };
  } }, tools: { execute: async () => { writes++; appendFileSync(join(root, 'effects.txt'), 'write\n'); writeFileSync(join(root, 'report.md'), 'Original delivery');
    return { status: 'ok', content: { ok: true, path: 'report.md' }, workspaceChangedPaths: ['report.md'] }; } } } });
  worker.attach(scope, 'run', before.configuration);
  if (boundary === 'cancel') worker.submit(scope, 'run', { commandId: 'cancel-original', kind: 'cancel', payload: {} });
  const result = await worker.runUntilIdle(scope, 'run');
  if (boundary === 'cancel') { assert.equal(result.phase, 'canceled'); assert.equal(models + writes, 0); }
  else if (boundary === 'applied') { assert.equal(result.reason, 'effect_outcome_unknown'); assert.equal(models + writes, 0); }
  else { assert.equal(result.outcome, 'unverified'); assert.equal(result.phase, 'completed'); assert.equal(models, boundary === 'prepared' ? 2 : 1);
    assert.equal(writes, boundary === 'prepared' ? 1 : 0); assert.deepEqual(result.deliveryArtifacts.paths, ['report.md']); }
  const effects = existsSync(join(root, 'effects.txt')) ? readFileSync(join(root, 'effects.txt'), 'utf8').trim().split('\n') : [];
  assert.equal(effects.length, boundary === 'cancel' ? 0 : 1);
  assert.deepEqual(store.load(scope, 'run').receipts.slice(0, before.receipts.length), before.receipts);
});
