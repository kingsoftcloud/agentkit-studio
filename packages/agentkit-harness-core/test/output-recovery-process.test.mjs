import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NativeKernel, emptyUsage } from '../dist/index.mjs';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { digest, scope } from './fixtures.mjs';

for (const boundary of ['task_resume', 'suffix', 'restart', 'cancel']) test(`actual SIGKILL at ${boundary} restores original output contract without replaying effects`, { timeout: 15000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'native-output-kill-')), filename = join(root, 'run.sqlite'), artifact = join(root, 'result.txt');
  const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/output-recovery-worker.mjs', import.meta.url)), filename,
    boundary === 'cancel' ? 'task_resume' : boundary], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, PATH: '/nonexistent-native-output-test' } });
  let stderr = ''; child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
  let store;
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    store?.close(); rmSync(root, { recursive: true, force: true }); });
  const ready = await Promise.race([once(child, 'message').then(([message]) => message),
    once(child, 'exit').then(([code, signal]) => { throw Error(`Worker exited ${code}/${signal}: ${stderr}`); })]);
  assert.equal(ready.kind, 'ready'); assert.equal(ready.pid, child.pid); assert.notEqual(child.pid, process.pid);
  if (boundary === 'restart') { assert.equal(ready.outputRestarts, 1); assert.equal(ready.modelCalls, 2); }
  else assert.equal(ready.mode, 'task_resume' === boundary || boundary === 'cancel' ? 'task_resume' : 'suffix');
  const exited = once(child, 'exit'); child.kill('SIGKILL');
  const [code, signal] = await exited; assert.equal(code, null); assert.equal(signal, 'SIGKILL');
  assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
  store = new SqliteRunStore(filename);
  const original = store.load(scope, 'run'); let models = 0, writes = 0;
  assert.equal(original.receipts.length, ready.modelCalls);
  const worker = new NativeKernel({ store, digest, owner: 'replacement-output-owner', now: () => Date.now() + 60000, ports: {
    model: { generate: async request => {
      models++;
      if (boundary === 'suffix') return { kind: 'final_candidate', text: 'answer.', toolCalls: [], usage: emptyUsage() };
      if (models === 1) {
        assert.equal(request.messages.at(-1).kind, boundary === 'restart' ? 'output_limit_restart_observation' : 'continuation_observation');
        return { kind: 'tool_calls', text: '', toolCalls: [{ callId: 'after-kill', name: 'write', arguments: {} }], usage: emptyUsage() };
      }
      return { kind: 'final_candidate', text: 'Actual file delivered.', toolCalls: [], usage: emptyUsage() };
    } }, tools: { execute: async () => { writes++; writeFileSync(artifact, 'correct'); return { status: 'ok', content: 'written' }; } },
  } });
  worker.attach(scope, 'run', original.configuration);
  if (boundary === 'cancel') worker.submit(scope, 'run', { commandId: 'cancel-before-recovery', kind: 'cancel', payload: {} });
  const result = await worker.runUntilIdle(scope, 'run');
  if (boundary === 'cancel') { assert.equal(result.phase, 'canceled'); assert.equal(models, 0); assert.equal(writes, 0); assert.equal(existsSync(artifact), false); }
  else if (boundary === 'suffix') { assert.equal(result.finalText, 'Unfinished original answer.'); assert.equal(models, 1); assert.equal(writes, 0); }
  else { assert.equal(result.finalText, 'Actual file delivered.'); assert.equal(models, 2); assert.equal(writes, 1); assert.equal(readFileSync(artifact, 'utf8'), 'correct'); }
  assert.deepEqual(store.load(scope, 'run').receipts.slice(0, original.receipts.length), original.receipts);
});
