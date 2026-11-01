import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

for (const policy of ['accept', 'external', 'denied', 'session', 'rejected', 'lost', 'mid']) test(`cold explicit workspace compensation: ${policy}`, { timeout: 25000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'native-workspace-repair-process-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  async function start(phase) {
    const child = fork(new URL('./fixtures/native-workspace-repair.mjs', import.meta.url), [root, phase, policy],
      { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: { ...process.env, PATH: dirname(process.execPath), PYTHON: '/unavailable/python' } });
    let stderr = ''; child.stderr.on('data', data => { stderr += data; });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    const exited = once(child, 'exit'), message = once(child, 'message', { signal: AbortSignal.timeout(15000) });
    const report = await Promise.race([message.then(([value]) => value), exited.then(([code, signal]) => { throw Error(`${phase} exited ${code}/${signal}: ${stderr}`); })]);
    return { child, exited, report };
  }
  async function kill(process) {
    assert.equal(process.child.kill('SIGKILL'), true); const [code, signal] = await process.exited;
    assert.equal(code, null); assert.equal(signal, 'SIGKILL');
  }
  const first = await start('write');
  assert.equal(first.report.phase, 'awaiting_reconciliation'); assert.equal(first.report.first, 'First publication\n');
  assert.equal(first.report.second, false); assert.equal(first.report.dispatches, 1); await kill(first);
  const repaired = await start('repair');
  assert.notEqual(repaired.report.pid, first.report.pid);
  if (policy === 'mid') {
    assert.equal(repaired.report.stage, 'inverse-published-before-completion'); await kill(repaired);
    await new Promise(resolve => setTimeout(resolve, Math.max(0, repaired.report.leaseExpiresAt - Date.now()) + 30));
    const retry = await start('retry'); assert.equal((await retry.exited)[0], 0);
    assert.equal(retry.report.phase, 'completed'); assert.equal(retry.report.repairs, 1); assert.equal(retry.report.toolCalls, 1);
    assert.deepEqual(retry.report.originalReceipt, first.report.originalReceipt);
    assert.equal(retry.report.first, null); assert.equal(retry.report.second, false);
    t.diagnostic(JSON.stringify({ killed: first.report.pid, partialRepairKilled: repaired.report.pid, cold: retry.report.pid })); return;
  }
  assert.equal(repaired.report.phase, policy === 'accept' ? 'completed' : 'awaiting_reconciliation');
  assert.equal(repaired.report.models, policy === 'accept' ? 1 : 0); assert.equal(repaired.report.toolCalls, 1);
  assert.equal(repaired.report.configDigest, first.report.configDigest);
  assert.deepEqual(repaired.report.originalReceipt, first.report.originalReceipt);
  assert.deepEqual(repaired.report.originalIntent, first.report.originalIntent);
  assert.equal(repaired.report.first, policy === 'external' ? 'External user bytes' : ['denied', 'session'].includes(policy) ? 'First publication\n' : null);
  assert.equal(repaired.report.second, false);
  if (policy === 'accept') assert.equal(repaired.report.repairs, 1);
  if (policy === 'lost') {
    await kill(repaired); const retry = await start('retry'); assert.equal((await retry.exited)[0], 0);
    assert.equal(retry.report.phase, 'completed'); assert.equal(retry.report.models, 1); assert.equal(retry.report.repairs, 1);
    assert.equal(retry.report.toolCalls, 1); assert.deepEqual(retry.report.originalReceipt, first.report.originalReceipt);
    assert.equal(retry.report.first, null); assert.equal(retry.report.second, false);
  } else {
    assert.equal((await repaired.exited)[0], 0);
    if (policy === 'rejected') {
      const retry = await start('retry'); assert.equal((await retry.exited)[0], 0);
      assert.equal(retry.report.phase, 'completed'); assert.equal(retry.report.models, 1);
      assert.equal(retry.report.toolCalls, 1); assert.deepEqual(retry.report.originalReceipt, first.report.originalReceipt);
    }
  }
  t.diagnostic(JSON.stringify({ killed: first.report.pid, cold: repaired.report.pid, policy, originalEffectReplayed: false }));
});
