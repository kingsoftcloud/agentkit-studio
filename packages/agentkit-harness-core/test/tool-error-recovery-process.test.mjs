import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NativeKernel, emptyUsage } from '../dist/index.mjs';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { scope, digest } from './fixtures.mjs';

for (const boundary of ['window', 'prepared', 'applied', 'cancel']) test(`actual SIGKILL at diagnostic ${boundary} preserves the single original trial and unknown-effect fence`, { timeout: 15000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'native-diagnostic-kill-')), filename = join(root, 'run.sqlite'), file = join(root, 'result.txt');
  const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/tool-error-recovery-worker.mjs', import.meta.url)), filename, boundary],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, PATH: '/nonexistent-native-diagnostic-test' } });
  let stderr = '', store;
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); store?.close(); rmSync(root, { recursive: true, force: true }); });
  const ready = await Promise.race([once(child, 'message').then(([row]) => row),
    once(child, 'exit').then(([code, signal]) => { throw Error(`Worker exited ${code}/${signal}: ${stderr}`); })]);
  assert.equal(ready.pid, child.pid); assert.notEqual(child.pid, process.pid); assert.equal(ready.recovery.startedModelCall, 6);
  assert.equal(ready.models, boundary === 'window' ? 6 : 8); assert.equal(ready.recovery.trialConsumed, boundary !== 'window');
  const exit = once(child, 'exit'); child.kill('SIGKILL'); const [code, signal] = await exit;
  assert.equal(code, null); assert.equal(signal, 'SIGKILL'); assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
  store = new SqliteRunStore(filename); const before = store.load(scope, 'run');
  const originalCalls = readFileSync(join(root, 'original-effects.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(originalCalls.length, boundary === 'window' ? 6 : boundary === 'applied' ? 8 : 7);
  let models = 0, tools = 0, writes = 0;
  const worker = new NativeKernel({ store, digest, owner: 'replacement-diagnostic-owner', now: () => Date.now() + 60000, ports: {
    model: { generate: async () => {
      models++;
      const name = boundary === 'window' && models === 1 ? 'read' : boundary === 'window' && models === 2 ? 'write' : null;
      return { kind: name ? 'tool_calls' : 'final_candidate', text: name ? '' : 'Actual correction delivered.',
        toolCalls: name ? [{ callId: `replacement-${models}`, name, arguments: { text: 'corrected' } }] : [], usage: emptyUsage() };
    } }, tools: { execute: async request => {
      tools++;
      if (request.call.name === 'read') return { status: 'ok', content: { actual: 'corrected content required' } };
      writes++; writeFileSync(file, 'correct'); return { status: 'ok', content: 'written', workspaceChangedPaths: ['result.txt'] };
    } },
  } });
  worker.attach(scope, 'run', before.configuration);
  if (boundary === 'cancel') worker.submit(scope, 'run', { commandId: 'cancel-original-trial', kind: 'cancel', payload: {} });
  const result = await worker.runUntilIdle(scope, 'run');
  if (boundary === 'applied') {
    assert.equal(result.reason, 'effect_outcome_unknown'); assert.equal(models, 0); assert.equal(tools, 0); assert.equal(writes, 0);
    assert.equal(result.toolErrorRecovery.trialConsumed, true); assert.equal(readFileSync(file, 'utf8'), 'correct');
  } else if (boundary === 'cancel') {
    assert.equal(result.phase, 'canceled'); assert.equal(models + tools + writes, 0); assert.equal(existsSync(file), false);
  } else {
    assert.equal(result.phase, 'completed'); assert.equal(result.toolErrorRecovery, null); assert.equal(writes, 1);
    assert.equal(result.finalText, 'Actual correction delivered.'); assert.equal(readFileSync(file, 'utf8'), 'correct');
    assert.equal(models, boundary === 'window' ? 3 : 1); assert.equal(tools, boundary === 'window' ? 2 : 1);
  }
  assert.deepEqual(store.load(scope, 'run').receipts.slice(0, before.receipts.length), before.receipts);
});
