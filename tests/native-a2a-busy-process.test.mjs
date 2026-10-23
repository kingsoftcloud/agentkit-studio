import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
const worker = fileURLToPath(new URL('./fixtures/native-a2a-busy-process.mjs', import.meta.url));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
for (const checkpoint of ['queued', 'cancel-entered-not-applied', 'cancel-entered-applied']) {
  test(`real separate busy stream process survives control SIGKILL at ${checkpoint}`, { timeout: 20000 }, async t => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'a2a-busy-process-')));
    const children = [], messages = [], errors = [], httpFailures = [];
    let stream, wrap, cancelEntered = false, state = 'TASK_STATE_WORKING';
    const counts = { send: 0, get: 0, cancel: 0, discovery: 0 };
    const record = () => {
      const directory = join(root, 'state', readdirSync(join(root, 'state'))[0]);
      return JSON.parse(readFileSync(join(directory, readdirSync(directory).find(name => name.endsWith('.json')))));
    };
    const task = () => ({ id: 'original-task', contextId: 'original-context', status: { state } });
    const bind = () => stream.write('id: 1\ndata: ' + JSON.stringify(wrap({ task: task() })) + '\n\n');
    const server = createServer((req, res) => void (async () => {
      let raw = ''; for await (const chunk of req) raw += chunk; const body = JSON.parse(raw);
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/agentengine/api/v1/ListAToASpaceAgents') {
        counts.discovery++; res.end(JSON.stringify({ Code: 0, Data: { Agents: [{ A2AAgentId: 'remote', VersionId: 'version', AgentCard: {
          capabilities: { streaming: true }, supportedInterfaces: [{ url: origin + '/rpc', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
        } }] } })); return;
      }
      const envelope = result => ({ jsonrpc: '2.0', id: body.id, result });
      if (body.method === 'SendStreamingMessage') {
        counts.send++; assert.equal(counts.send, 1); stream = res; wrap = envelope;
        res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders();
        if (checkpoint !== 'queued') bind(); return;
      }
      assert.equal(body.params.id, 'original-task');
      if (body.method === 'GetTask') counts.get++;
      else {
        assert.equal(body.method, 'CancelTask'); counts.cancel++;
        assert.equal(Object.values(record().controls).find(row => row.command.kind === 'cancel').phase, 'sending');
        cancelEntered = true;
        if (checkpoint !== 'cancel-entered-not-applied') state = 'TASK_STATE_CANCELED';
        if (checkpoint !== 'queued') return; // No response; the control process will be killed.
      }
      res.end(JSON.stringify(envelope(task())));
    })().catch(error => { httpFailures.push(error.message); res.statusCode = 500; res.end('{}'); }));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const origin = `http://127.0.0.1:${server.address().port}`;
    const start = mode => {
      const child = spawn(process.execPath, [worker, mode, root, origin], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      children.push(child); child.stderr.on('data', data => errors.push(data.toString())); child.on('message', value => messages.push(value));
      return child;
    };
    const until = async (check, label) => { const end = Date.now() + 10000;
      while (!check()) { assert.ok(Date.now() < end, label + ': ' + errors.join('')); await delay(10); } };
    const exited = child => child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve([child.exitCode, child.signalCode]) : once(child, 'exit');
    t.after(async () => {
      for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await Promise.all(children.map(exited)); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
      rmSync(root, { recursive: true, force: true }); assert.deepEqual(httpFailures, []);
    });
    const original = start('dispatch'); await until(() => counts.send === 1, 'original send');
    if (checkpoint !== 'queued') await until(() => record().projection.taskId, 'durable task binding');
    const control = start('cancel');
    if (checkpoint === 'queued') await until(() => Object.values(record().controls ?? {}).some(row => row.phase === 'queued'), 'queued intent committed');
    else await until(() => cancelEntered, 'cancel HTTP entered');
    const before = record(), dead = once(control, 'exit'); assert.equal(control.kill('SIGKILL'), true);
    const [code, signal] = await dead; assert.equal(code, null); assert.equal(signal, 'SIGKILL');
    assert.equal(original.exitCode, null); assert.equal(original.signalCode, null, 'original stream remains live in a different process');
    if (checkpoint === 'queued') { assert.equal(counts.cancel, 0); bind(); await until(() => record().projection.taskId, 'task bound after control crash'); }
    const replacement = start('cancel'), [replacementCode] = await exited(replacement); assert.equal(replacementCode, 0, errors.join(''));
    const result = messages.find(message => message.pid === replacement.pid && message.result)?.result; assert.ok(result);
    assert.notEqual(replacement.pid, control.pid);
    if (checkpoint === 'queued') {
      assert.equal(result.outcome, 'remote_cancelled');
      assert.deepEqual(messages.filter(message => message.approval).map(message => [message.pid, message.readOnly]), [[control.pid, false], [replacement.pid, false]]);
    } else {
      assert.equal(result.outcome, 'unknown');
      assert.equal(messages.find(message => message.approval && message.pid === replacement.pid).readOnly, true);
    }
    assert.equal(counts.cancel, 1); assert.equal(counts.send, 1);
    // Close the original stream only after the replacement completed. Its late
    // WORKING observation must preserve any already confirmed terminal.
    stream.write('id: 2\ndata: ' + JSON.stringify(wrap({ statusUpdate: { taskId: 'original-task', contextId: 'original-context',
      status: { state: 'TASK_STATE_WORKING' } } })) + '\n\n'); stream.end();
    // If cancellation was not applied, leave a paused original Task so the
    // original dispatcher exits without an unbounded poll in this fixture.
    if (checkpoint === 'cancel-entered-not-applied') state = 'TASK_STATE_INPUT_REQUIRED';
    const [originalCode] = await exited(original); assert.equal(originalCode, 0, errors.join(''));
    const beforeGet = counts.cancel, inspector = start('inspect'), [inspectorCode] = await exited(inspector);
    assert.equal(inspectorCode, 0, errors.join('')); assert.equal(counts.cancel, beforeGet);
    const observed = messages.find(message => message.pid === inspector.pid && message.result).result;
    assert.equal(observed.state, checkpoint === 'cancel-entered-not-applied' ? 'input_required' : 'cancelled');
    assert.equal(counts.discovery, 1); assert.equal(counts.send, 1); assert.deepEqual(httpFailures, []);
    if (process.env.AGENTKIT_A2A_BUSY_EVIDENCE_DIR) {
      mkdirSync(process.env.AGENTKIT_A2A_BUSY_EVIDENCE_DIR, { recursive: true });
      writeFileSync(join(process.env.AGENTKIT_A2A_BUSY_EVIDENCE_DIR, checkpoint + '.json'), JSON.stringify({ checkpoint,
        node: process.version, pids: children.map(child => child.pid), killed: { pid: control.pid, code, signal }, counts, before,
        after: record(), messages, originalRemainedLiveDuringRecovery: true }, null, 2));
    }
  });
}

for (const confirmed of [false, true]) test(`continuation admission rechecks ${confirmed ? 'confirmed terminal' : 'queued cancel'} from a different process`, { timeout: 20000 }, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'a2a-admission-process-'))), children = [], messages = [], errors = [], failures = [];
  let state = 'TASK_STATE_INPUT_REQUIRED', finishCancelRead;
  const counts = { send: 0, continue: 0, get: 0, cancel: 0, discovery: 0 };
  const task = () => ({ id: 'original-task', contextId: 'original-context', status: { state },
    ...(counts.get >= 2 ? { artifacts: [{ artifactId: 'observation', parts: [{ text: 'after-continuation-observe' }] }] } : {}) });
  const readRecord = () => {
    const directory = join(root, 'state', readdirSync(join(root, 'state'))[0]);
    return JSON.parse(readFileSync(join(directory, readdirSync(directory).find(name => name.endsWith('.json')))));
  };
  const server = createServer((req, res) => void (async () => {
    let raw = ''; for await (const chunk of req) raw += chunk; const body = JSON.parse(raw);
    const reply = value => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: value })); };
    if (req.url === '/agentengine/api/v1/ListAToASpaceAgents') {
      counts.discovery++; res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ Code: 0, Data: { Agents: [{ A2AAgentId: 'remote', VersionId: 'version', AgentCard: {
        capabilities: { streaming: true }, supportedInterfaces: [{ url: origin + '/rpc', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
      } }] } })); return;
    }
    if (body.method === 'SendStreamingMessage') {
      counts.send++; res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('id: 1\ndata: ' + JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { task: task() } }) + '\n\n'); return;
    }
    if (body.method === 'SendMessage') { counts.continue++; reply({ task: task() }); return; }
    assert.equal(body.params.id, 'original-task');
    if (body.method === 'GetTask') {
      counts.get++;
      if (counts.get === 3 && !confirmed) { finishCancelRead = () => reply(task()); return; }
      reply(task()); return;
    }
    assert.equal(body.method, 'CancelTask'); counts.cancel++; state = 'TASK_STATE_CANCELED'; reply(task());
  })().catch(error => { failures.push(error.message); res.statusCode = 500; res.end('{}'); }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const origin = `http://127.0.0.1:${server.address().port}`;
  const exited = child => child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve([child.exitCode, child.signalCode]) : once(child, 'exit');
  const start = mode => {
    const child = spawn(process.execPath, [worker, mode, root, origin], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }); children.push(child);
    child.stderr.on('data', data => errors.push(data.toString())); child.on('message', value => messages.push(value)); return child;
  };
  const until = async check => { const end = Date.now() + 10000; while (!check()) {
    assert.ok(Date.now() < end, errors.join('')); await delay(10);
  } };
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await Promise.all(children.map(exited)); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    rmSync(root, { recursive: true, force: true }); assert.deepEqual(failures, []);
  });
  const original = start('dispatch'); assert.equal((await exited(original))[0], 0, errors.join(''));
  const continuation = start('continue-race');
  await until(() => readdirSync(root).includes('continuation-ready'));
  const observed = readRecord(); assert.equal(observed.projection.state, 'input_required');
  assert.match(JSON.stringify(observed.projection.snapshots), /after-continuation-observe/);
  assert.equal(Object.values(observed.controls).some(row => row.command.kind === 'continue'), false);
  const cancel = start('cancel');
  if (confirmed) { assert.equal((await exited(cancel))[0], 0, errors.join('')); assert.equal(readRecord().projection.state, 'cancelled'); }
  else await until(() => Boolean(finishCancelRead));
  const checkpoint = readRecord();
  writeFileSync(join(root, 'continuation-release'), 'release');
  assert.equal((await exited(continuation))[0], 0, errors.join(''));
  assert.equal(messages.find(value => value.pid === continuation.pid && value.error)?.error,
    confirmed ? 'A2A_CONTROL_TASK_ALREADY_TERMINAL' : 'A2A_CANCEL_ALREADY_REQUESTED');
  assert.equal(counts.continue, 0, 'no continuation HTTP request after the other process admitted or confirmed cancellation');
  if (!confirmed) { finishCancelRead(); assert.equal((await exited(cancel))[0], 0, errors.join('')); }
  assert.equal(counts.cancel, 1); assert.equal(counts.send, 1); assert.equal(counts.discovery, 1);
  assert.equal(readRecord().projection.state, 'cancelled');
  assert.equal(Object.values(readRecord().controls).some(row => row.command.kind === 'continue'), false);
  if (process.env.AGENTKIT_A2A_BUSY_EVIDENCE_DIR) {
    mkdirSync(process.env.AGENTKIT_A2A_BUSY_EVIDENCE_DIR, { recursive: true });
    writeFileSync(join(process.env.AGENTKIT_A2A_BUSY_EVIDENCE_DIR, `admission-${confirmed ? 'terminal' : 'queued'}.json`), JSON.stringify({
      node: process.version, pids: children.map(child => child.pid), counts, observed, checkpoint, after: readRecord(), messages,
    }, null, 2));
  }
});
