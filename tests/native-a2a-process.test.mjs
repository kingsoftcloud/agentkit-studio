import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
const fixture = fileURLToPath(new URL('./fixtures/native-a2a-process.mjs', import.meta.url));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
for (const checkpoint of ['send-entered', 'task-bound', 'receipt-entered']) {
  test(`real SIGKILL after ${checkpoint}: replacement records uncertainty and never sends again`, async t => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'a2a-sigkill-')));
    let sends = 0, gets = 0, child, replacement, observer, killedQueryPid = null, output = '', errors = '';
    const expire = async () => {
      const db = new DatabaseSync(join(root, 'runs.sqlite'), { readOnly: true });
      let expiry;
      try { expiry = JSON.parse(db.prepare('SELECT data FROM native_runs').get().data).lease?.expiresAt ?? 0; }
      finally { db.close(); }
      await delay(Math.max(0, expiry - Date.now()) + 30);
    };
    function records() {
      const directory = join(root, 'state/a2a-calls');
      if (!existsSync(directory)) return [];
      return readdirSync(directory).flatMap(owner => readdirSync(join(directory, owner)).filter(file => file.endsWith('.json'))
        .map(file => JSON.parse(readFileSync(join(directory, owner, file), 'utf8'))));
    }
    const server = createServer(async (req, res) => {
      let raw = ''; for await (const data of req) raw += data;
      const body = JSON.parse(raw);
      if (req.url === '/agentengine/api/v1/ListAToASpaceAgents') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ Code: 0, Data: { Agents: [{ A2AAgentId: 'remote', VersionId: 'version', AgentCard: {
          name: 'remote', capabilities: { streaming: true }, supportedInterfaces: [{ protocolBinding: 'JSONRPC', protocolVersion: '1.0', url: origin + '/rpc' }],
        } }] } })); return;
      }
      if (body.method === 'GetTask') {
        gets++; assert.notEqual(checkpoint, 'send-entered'); assert.equal(body.params.id, 'remote-original');
        if (checkpoint === 'receipt-entered' && gets === 1) return; // actual query stays open until SIGKILL
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id,
          result: { id: 'remote-original', contextId: 'context-original', status: { state: 'TASK_STATE_COMPLETED' },
            artifacts: [{ artifactId: 'cold-answer', parts: [{ text: 'cold verified result' }] }] } })); return;
      }
      assert.equal(body.method, 'SendStreamingMessage'); sends++;
      const record = records()[0]; assert.equal(record.phase, 'sending'); assert.equal(record.projection.taskId, null);
      if (checkpoint !== 'send-entered') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('id: first\ndata: ' + JSON.stringify({ jsonrpc: '2.0', id: body.id,
          result: { task: { id: 'remote-original', contextId: 'context-original', status: { state: 'TASK_STATE_WORKING' } } } }) + '\n\n');
      }
      // Leave the actual network operation open until its process is killed.
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    t.after(async () => {
      if (child?.exitCode === null && child?.signalCode === null) child.kill('SIGKILL');
      if (replacement?.exitCode === null && replacement?.signalCode === null) replacement.kill('SIGKILL');
      if (observer?.exitCode === null && observer?.signalCode === null) observer.kill('SIGKILL');
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(root, { recursive: true, force: true });
    });
    child = spawn(process.execPath, [fixture, 'run', root, origin], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stderr.on('data', data => { errors += data; });
    const deadline = Date.now() + 10000;
    while (!(sends === 1 && (checkpoint === 'send-entered' || records()[0]?.projection.taskId === 'remote-original'))) {
      assert.equal(child.exitCode, null, errors); assert.ok(Date.now() < deadline, `checkpoint not reached: ${errors}`); await delay(10);
    }
    const original = records()[0], exited = once(child, 'exit');
    child.kill('SIGKILL'); const [code, signal] = await exited;
    assert.equal(code, null); assert.equal(signal, 'SIGKILL');
    assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
    await expire(); // read the real lease; never edit the database to force recovery
    replacement = spawn(process.execPath, [fixture, 'recover', root, origin], { stdio: ['ignore', 'pipe', 'pipe'] });
    replacement.stdout.on('data', data => { output += data; }); replacement.stderr.on('data', data => { errors += data; });
    const [replacementCode] = await once(replacement, 'exit');
    assert.equal(replacementCode, 0, errors);
    const result = JSON.parse(output); assert.equal(result.phase, 'awaiting_reconciliation');
    assert.equal(sends, 1); assert.equal(existsSync(join(root, 'forbidden.jsonl')), false);
    assert.equal(readFileSync(join(root, 'models.jsonl'), 'utf8'), 'model\n');
    assert.deepEqual(records()[0], original, 'the original send/task checkpoint survives unchanged');
    let observedOutput = '';
    observer = spawn(process.execPath, [fixture, 'observe', root, origin], { stdio: ['ignore', 'pipe', 'pipe'] });
    observer.stdout.on('data', data => { observedOutput += data; }); observer.stderr.on('data', data => { errors += data; });
    if (checkpoint === 'receipt-entered') {
      const deadline = Date.now() + 10000;
      while (!gets) { assert.equal(observer.exitCode, null, errors); assert.ok(Date.now() < deadline); await delay(10); }
      const exited = once(observer, 'exit'); killedQueryPid = observer.pid; observer.kill('SIGKILL');
      assert.deepEqual(await exited, [null, 'SIGKILL']); await expire();
      let duplicateOutput = '';
      observer = spawn(process.execPath, [fixture, 'observe', root, origin], { stdio: ['ignore', 'pipe', 'pipe'] });
      observer.stdout.on('data', data => { duplicateOutput += data; }); observer.stderr.on('data', data => { errors += data; });
      const [duplicateCode] = await once(observer, 'exit'); assert.equal(duplicateCode, 0, errors);
      const duplicate = JSON.parse(duplicateOutput);
      assert.equal(duplicate.phase, 'awaiting_reconciliation'); assert.equal(duplicate.command.status, 'duplicate');
      assert.equal(duplicate.receiptReads, 1); assert.equal(gets, 1, 'a lost query is never automatically repeated');
      observer = spawn(process.execPath, [fixture, 'observe', root, origin, 'explicit-query-again'], { stdio: ['ignore', 'pipe', 'pipe'] });
      observer.stdout.on('data', data => { observedOutput += data; }); observer.stderr.on('data', data => { errors += data; });
    }
    const [observerCode] = await once(observer, 'exit'); assert.equal(observerCode, 0, errors);
    const observed = JSON.parse(observedOutput);
    assert.notEqual(observed.pid, child.pid); assert.notEqual(observed.pid, replacement.pid);
    assert.equal(observed.runId, 'run'); assert.deepEqual(observed.retained, observed.original);
    assert.equal(observed.receiptReads, checkpoint === 'receipt-entered' ? 2 : 1); assert.equal(observed.usage.toolCalls, 1); assert.equal(sends, 1);
    assert.equal(observed.phase, checkpoint === 'send-entered' ? 'awaiting_reconciliation' : 'completed');
    assert.equal(gets, checkpoint === 'send-entered' ? 0 : checkpoint === 'receipt-entered' ? 2 : 1);
    assert.equal(readFileSync(join(root, 'models.jsonl'), 'utf8'), checkpoint === 'send-entered' ? 'model\n' : 'model\nmodel\n');
    if (process.env.NATIVE_A2A_PROOF_DIR) {
      mkdirSync(process.env.NATIVE_A2A_PROOF_DIR, { recursive: true });
      writeFileSync(join(process.env.NATIVE_A2A_PROOF_DIR, `${checkpoint}.json`), JSON.stringify({ node: process.version,
        checkpoint, originalPid: child.pid, replacementPid: replacement.pid, killedQueryPid, observerPid: observed.pid, sends, gets, observed }, null, 2));
    }
  });
}
