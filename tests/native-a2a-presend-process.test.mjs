import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
const worker = fileURLToPath(new URL('./fixtures/native-a2a-presend-process.mjs', import.meta.url));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
for (const ownerKind of ['native', 'dsh']) for (const boundary of ['cancel-wins', 'send-wins', 'local-cancel-crash', 'send-marker-crash']) {
  test(`${ownerKind} independent processes arbitrate initial send and cancel: ${boundary}`, { timeout: 20000 }, async t => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'a2a-presend-process-')));
    const children = [], messages = [], errors = [], httpFailures = [];
    const counts = { discovery: 0, send: 0, get: 0, cancel: 0 };
    let stream, wrap, state = 'TASK_STATE_WORKING';
    const record = () => {
      const directory = join(root, 'state', readdirSync(join(root, 'state'))[0]);
      return JSON.parse(readFileSync(join(directory, readdirSync(directory).find(name => name.endsWith('.json')))));
    };
    const task = () => ({ id: 'original-task', contextId: 'original-context', status: { state } });
    const server = createServer((req, res) => void (async () => {
      let raw = ''; for await (const chunk of req) raw += chunk; const body = JSON.parse(raw);
      if (req.url === '/agentengine/api/v1/ListAToASpaceAgents') {
        counts.discovery++; res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ Code: 0, Data: { Agents: [{ A2AAgentId: 'remote', VersionId: 'version', AgentCard: {
          capabilities: { streaming: true }, supportedInterfaces: [{ url: origin + '/rpc', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
        } }] } })); return;
      }
      const envelope = result => ({ jsonrpc: '2.0', id: body.id, result });
      if (body.method === 'SendStreamingMessage') {
        counts.send++; assert.equal(counts.send, 1); assert.equal(record().phase, 'sending');
        stream = res; wrap = envelope; res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders();
        res.write('id: 1\ndata: ' + JSON.stringify(wrap({ task: task() })) + '\n\n'); return;
      }
      assert.equal(body.params.id, 'original-task');
      if (body.method === 'GetTask') counts.get++;
      else {
        assert.equal(body.method, 'CancelTask'); counts.cancel++; state = 'TASK_STATE_CANCELED';
        assert.equal(Object.values(record().controls).find(row => row.command.kind === 'cancel').phase, 'sending');
      }
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(envelope(task())));
    })().catch(error => { httpFailures.push(error.stack); res.statusCode = 500; res.end('{}'); }));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const origin = `http://127.0.0.1:${server.address().port}`;
    const start = mode => {
      const child = spawn(process.execPath, [worker, mode, root, origin, ownerKind], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      children.push(child); child.stderr.on('data', data => errors.push(data.toString())); child.on('message', value => messages.push(value));
      return child;
    };
    const until = async (check, label) => { const end = Date.now() + 10000;
      while (!check()) { assert.ok(Date.now() < end, label + ': ' + errors.join('')); await delay(10); } };
    const exited = child => child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve([child.exitCode, child.signalCode]) : once(child, 'exit');
    const kill = async child => { const done = exited(child); assert.equal(child.kill('SIGKILL'), true);
      assert.deepEqual(await done, [null, 'SIGKILL']); };
    const release = mode => writeFileSync(join(root, mode + '-release'), 'release');
    const ready = mode => until(() => existsSync(join(root, mode + '-ready')), mode);
    const completed = async child => { assert.equal((await exited(child))[0], 0, errors.join(''));
      const result = messages.find(value => value.pid === child.pid && value.result)?.result; assert.ok(result); return result; };
    t.after(async () => {
      for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await Promise.all(children.map(exited)); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
      rmSync(root, { recursive: true, force: true }); assert.deepEqual(httpFailures, []);
    });
    const preparing = start('prepare'); await ready('prepare');
    assert.equal(record().phase, 'prepared'); const initial = record(); await kill(preparing);
    assert.deepEqual(counts, { discovery: 1, send: 0, get: 0, cancel: 0 });
    if (boundary === 'send-wins') {
      const cancelling = start('cancel-before'); await ready('cancel-before');
      const sending = start('dispatch'); await until(() => record().projection.taskId, 'actual task bound');
      release('cancel-before'); const result = await completed(cancelling);
      assert.equal(result.outcome, 'remote_cancelled');
      stream.end('id: 2\ndata: ' + JSON.stringify(wrap({ statusUpdate: { taskId: 'original-task', contextId: 'original-context',
        status: { state: 'TASK_STATE_WORKING' } } })) + '\n\n');
      assert.equal((await completed(sending)).state, 'cancelled');
      assert.deepEqual(counts, { discovery: 1, send: 1, get: 2, cancel: 1 });
    } else if (boundary === 'send-marker-crash') {
      const sending = start('dispatch-after'); await ready('dispatch-after');
      assert.equal(record().phase, 'sending'); await kill(sending);
      assert.equal((await completed(start('dispatch'))).state, 'unknown');
      assert.equal(record().phase, 'sending', 'possible send marker is never reset to prepared');
      assert.deepEqual(counts, { discovery: 1, send: 0, get: 0, cancel: 0 });
    } else {
      const sending = boundary === 'cancel-wins' ? start('dispatch-before') : null;
      if (sending) await ready('dispatch-before');
      const cancelling = start(boundary === 'local-cancel-crash' ? 'cancel-after' : 'cancel');
      if (boundary === 'local-cancel-crash') {
        await ready('cancel-after'); assert.equal(record().phase, 'terminal'); await kill(cancelling);
        assert.equal(messages.some(value => value.pid === cancelling.pid && value.result), false, 'acknowledgement was lost');
      } else assert.equal((await completed(cancelling)).outcome, 'local_cancelled_before_send');
      const result = await completed(start('cancel'));
      assert.equal(result.outcome, 'local_cancelled_before_send');
      assert.equal(result.remote_task_id, null); assert.equal(result.task_id, initial.platformTaskId);
      if (sending) release('dispatch-before');
      assert.equal((await completed(sending ?? start('dispatch'))).state, 'cancelled');
      assert.deepEqual(counts, { discovery: 1, send: 0, get: 0, cancel: 0 });
      assert.equal(record().localCancel.state, 'local_confirmed');
    }
    assert.equal(record().requestDigest, initial.requestDigest);
    assert.equal(record().platformTaskId, initial.platformTaskId);
    const proof = { boundary, ownerKind, parentPid: process.pid, pids: children.map(child => child.pid), counts,
      state: record().projection.state, phase: record().phase, approvals: messages.filter(value => value.approval) };
    if (process.env.A2A_PROOF_DIRECTORY) {
      mkdirSync(process.env.A2A_PROOF_DIRECTORY, { recursive: true });
      writeFileSync(join(process.env.A2A_PROOF_DIRECTORY,
        `presend-${ownerKind}-${boundary}-${process.pid}.json`), JSON.stringify(proof, null, 2) + '\n');
    }
  });
}
