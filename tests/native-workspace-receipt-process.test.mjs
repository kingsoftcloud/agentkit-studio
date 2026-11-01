import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

for (const policy of ['accept', 'reject']) test(`actual Host gateway SIGKILL: ${policy === 'accept' ? 'cold fenced receipt read resumes without a second write' : 'raw success cannot bypass rejected post-policy output'}`, { timeout: 20000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'native-workspace-receipt-process-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  async function start(phase) {
    const child = fork(new URL('./fixtures/native-workspace-receipt.mjs', import.meta.url), [root, phase, policy],
      { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: { ...process.env, PATH: dirname(process.execPath), PYTHON: '/unavailable/python' } });
    let stderr = ''; child.stderr.on('data', data => { stderr += data; });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    const exited = once(child, 'exit');
    const message = once(child, 'message', { signal: AbortSignal.timeout(10000) });
    const report = await Promise.race([message.then(([value]) => value), exited.then(([code, signal]) => { throw Error(`${phase} exited ${code}/${signal}: ${stderr}`); })]);
    return { child, exited, report };
  }
  const first = await start('write');
  assert.equal(first.report.phase, 'awaiting_reconciliation'); assert.equal(first.report.effects, 1); assert.equal(first.report.models, 1);
  assert.equal(first.child.kill('SIGKILL'), true); const [code, signal] = await first.exited;
  assert.equal(code, null); assert.equal(signal, 'SIGKILL');
  const cold = await start('read'); assert.equal((await cold.exited)[0], 0);
  assert.notEqual(cold.report.pid, first.report.pid); assert.equal(cold.report.effects, 0);
  assert.equal(cold.report.configDigest, first.report.configDigest); assert.equal(cold.report.originalOperationKey, first.report.originalOperationKey);
  assert.equal(cold.report.originalClaimedFence, first.report.originalClaimedFence); assert.deepEqual(cold.report.originalReceipt, first.report.originalReceipt);
  assert.equal(cold.report.phase, policy === 'accept' ? 'completed' : 'awaiting_reconciliation');
  assert.equal(cold.report.models, policy === 'accept' ? 1 : 0); assert.equal(cold.report.toolCalls, 1);
  assert.equal(cold.report.queryReceipt?.status, 'committed'); assert.equal(cold.report.queryReceipt.result.result === null, policy === 'reject');
  assert.equal(cold.report.reconciled, policy === 'accept' ? 1 : 0);
  assert.equal(readFileSync(join(root, 'workspace/once.txt'), 'utf8'), 'Original Host publication');
  t.diagnostic(JSON.stringify({ killed: first.report.pid, cold: cold.report.pid, policy, effects: 1, originalReceiptUnchanged: true }));
});
