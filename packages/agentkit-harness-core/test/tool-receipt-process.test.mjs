import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, realpathSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
const fixture = fileURLToPath(new URL('./fixtures/tool-receipt-process.mjs', import.meta.url));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
for (const checkpoint of ['effect-entered', 'waiting-committed', 'query-entered']) {
  test(`real SIGKILL at ${checkpoint}: original run continues from a separate verified receipt without executing again`, { timeout: 20000 }, async t => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'receipt-process-')));
    let executions = 0, queries = 0, original, replacement, errors = '', originalRequest;
    const queryRequests = [], messages = [], entered = Promise.withResolvers();
    const server = createServer(async (req, res) => {
      let body = ''; for await (const chunk of req) body += chunk;
      const input = JSON.parse(body);
      if (req.url === '/execute') {
        executions++; originalRequest = input;
        if (checkpoint === 'effect-entered') { entered.resolve(); return; }
        res.end('{}'); return;
      }
      assert.equal(req.url, '/receipt'); queries++; queryRequests.push(input);
      assert.equal(input.originalOperationKey, originalRequest.operationKey);
      assert.equal(input.callId, originalRequest.callId);
      assert.notEqual(input.operationKey, input.originalOperationKey);
      assert.ok(input.executionFence >= input.originalClaimedFence);
      if (checkpoint === 'query-entered' && queries === 1) { entered.resolve(); return; }
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ status: 'ok', content: 'actual original remote result' }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const origin = `http://127.0.0.1:${server.address().port}`;
    const start = mode => {
      const child = spawn(process.execPath, [fixture, mode, root, origin, checkpoint], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      child.stderr.on('data', data => { errors += data; }); child.on('message', message => messages.push(message)); return child;
    };
    t.after(async () => {
      for (const child of [original, replacement]) if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(root, { recursive: true, force: true });
    });
    original = start('run');
    const until = async predicate => { const end = Date.now() + 10000;
      while (!predicate()) { assert.ok(Date.now() < end, errors || 'checkpoint timeout'); assert.equal(original.exitCode, null, errors); await delay(10); } };
    if (checkpoint === 'waiting-committed') await until(() => messages.some(message => message.ready));
    else await Promise.race([entered.promise, once(original, 'exit').then(([exitCode]) => { throw new Error(`fixture exited ${exitCode}: ${errors}`); })]);
    const oldExit = once(original, 'exit'); original.kill('SIGKILL'); const [code, signal] = await oldExit;
    assert.equal(code, null); assert.equal(signal, 'SIGKILL');
    // Use an ordinary viable execution lease. Under a concurrent test batch a
    // 90ms lease can expire during synchronous compilation, before our target
    // fault checkpoint. Observe the actual stored expiry without editing it.
    const db = new DatabaseSync(join(root, 'runs.sqlite'), { readOnly: true });
    const originalLease = JSON.parse(db.prepare('SELECT data FROM native_runs').get().data).lease; db.close();
    if (originalLease) await delay(Math.max(0, originalLease.expiresAt - Date.now() + 20));
    replacement = start('recover'); const exited = once(replacement, 'exit');
    await until(() => messages.some(message => message.observed));
    const observed = messages.find(message => message.observed); assert.equal(observed.phase, 'awaiting_reconciliation');
    const preQueries = checkpoint === 'query-entered' ? 1 : 0;
    assert.equal(queries, preQueries, 'cold recovery does not silently repeat even a receipt read'); assert.equal(executions, 1);
    replacement.send('reconcile'); const [replacementCode] = await exited; assert.equal(replacementCode, 0, errors);
    const result = messages.find(message => message.done); assert.ok(result); assert.notEqual(original.pid, result.pid);
    assert.equal(result.snapshot.phase, 'completed'); assert.equal(result.snapshot.runId, 'run'); assert.equal(result.snapshot.usage.toolCalls, 1);
    assert.equal(result.snapshot.messages.filter(message => message.role === 'tool').length, 1);
    assert.equal(result.snapshot.messages.find(message => message.role === 'tool').content, '"actual original remote result"');
    assert.equal(executions, 1); assert.equal(queries, preQueries + 1);
    assert.equal(result.intents.filter(intent => intent.kind === 'tool').length, 1);
    assert.equal(result.receipts.filter(receipt => receipt.operationKey === originalRequest.operationKey).length, 1);
    assert.equal(result.events.filter(event => event.kind === 'tool.receipt_reconciled').length, 1);
    if (process.env.AGENTKIT_TOOL_RECEIPT_EVIDENCE_DIR) {
      mkdirSync(process.env.AGENTKIT_TOOL_RECEIPT_EVIDENCE_DIR, { recursive: true });
      writeFileSync(join(process.env.AGENTKIT_TOOL_RECEIPT_EVIDENCE_DIR, checkpoint + '.json'), JSON.stringify({
        checkpoint, originalPid: original.pid, replacementPid: replacement.pid, originalExit: { code, signal },
        executions, queries, originalLease, originalRequest, queryRequests, result,
      }, null, 2));
    }
  });
}
