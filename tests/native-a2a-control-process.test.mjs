import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const driver = new URL('./fixtures/native-a2a-control-process.mjs', import.meta.url);
for (const kind of ['continue', 'cancel']) for (const effectApplied of [false, true]) {
  test(`actual SIGKILL ${kind}, remote effect ${effectApplied ? 'applied' : 'unconfirmed'}: cold Host never replays`, async t => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'a2a-control-kill-')));
    let child, replacement, originalSends = 0, effects = 0, errors = '', output = '';
    const task = { id: 'original-task', contextId: 'original-context', status: { state: 'TASK_STATE_INPUT_REQUIRED' } };
    const records = () => {
      const directory = join(root, 'state', readdirSync(join(root, 'state'))[0]);
      return JSON.parse(readFileSync(join(directory, readdirSync(directory).find(file => file.endsWith('.json')))));
    };
    const failures = [];
    const server = createServer((req, res) => void (async () => {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks)); res.setHeader('Content-Type', 'application/json');
      const reply = result => res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
      if (req.url === '/agentengine/api/v1/ListAToASpaceAgents') {
        res.end(JSON.stringify({ Code: 0, Data: { Agents: [{ A2AAgentId: 'remote', VersionId: 'version', AgentCard: {
          supportedInterfaces: [{ url: origin + '/rpc', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
        } }] } })); return;
      }
      if (body.method === 'GetTask') { assert.equal(body.params.id, task.id); reply(task); return; }
      if (body.method === 'SendMessage' && !body.params.message.taskId) { originalSends++; reply({ task }); return; }
      assert.equal(body.method, kind === 'continue' ? 'SendMessage' : 'CancelTask');
      assert.equal(kind === 'continue' ? body.params.message.taskId : body.params.id, task.id);
      const entry = Object.values(records().controls).find(entry => entry.command.commandId === 'one-effect');
      assert.equal(entry.phase, 'sending'); assert.equal(entry.command.kind, kind);
      assert.equal(entry.command.operation_locator.runId, 'original-run');
      if (kind === 'continue') {
        assert.equal(body.params.message.contextId, task.contextId); assert.deepEqual(body.params.message.parts, [{ data: { answer: 42 } }]);
      }
      if (effectApplied) task.status.state = kind === 'continue' ? 'TASK_STATE_COMPLETED' : 'TASK_STATE_CANCELED';
      effects++; // Hold the real response until this process is SIGKILLed.
    })().catch(error => { failures.push(error); res.statusCode = 500; res.end('{}'); }));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    t.after(async () => {
      for (const process of [child, replacement]) if (process?.exitCode === null && process.signalCode === null) process.kill('SIGKILL');
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(root, { recursive: true, force: true });
    });
    child = spawn(process.execPath, [driver.pathname, 'run', kind, root, origin], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stderr.on('data', data => { errors += data; });
    const deadline = Date.now() + 10000;
    while (effects !== 1) {
      assert.equal(child.exitCode, null, errors); assert.ok(Date.now() < deadline, errors);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const saved = records(), exited = once(child, 'exit'); child.kill('SIGKILL');
    assert.deepEqual(await exited, [null, 'SIGKILL']); assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
    replacement = spawn(process.execPath, [driver.pathname, 'recover', kind, root, origin], { stdio: ['ignore', 'pipe', 'pipe'] });
    replacement.stderr.on('data', data => { errors += data; }); replacement.stdout.on('data', data => { output += data; });
    assert.equal((await once(replacement, 'exit'))[0], 0, errors);
    const result = JSON.parse(output); assert.notEqual(result.pid, child.pid);
    assert.equal(result.result.outcome, 'unknown'); assert.equal(effects, 1); assert.equal(originalSends, 1);
    assert.equal(result.observed.state, effectApplied ? kind === 'continue' ? 'completed' : 'cancelled' : 'input_required');
    if (kind === 'continue' && !effectApplied) assert.equal(result.blocked, 'A2A_CONTINUATION_ALREADY_REQUESTED');
    const before = Object.values(saved.controls).find(entry => entry.command.commandId === 'one-effect');
    const after = Object.values(records().controls).find(entry => entry.command.commandId === 'one-effect');
    assert.deepEqual(after, before, 'read-only reconciliation preserves the original unresolved effect intent');
    assert.deepEqual(failures, []);
    if (process.env.AGENTKIT_A2A_CONTROL_EVIDENCE_DIR) {
      const directory = process.env.AGENTKIT_A2A_CONTROL_EVIDENCE_DIR; mkdirSync(directory, { recursive: true, mode: 0o700 });
      writeFileSync(join(directory, `${kind}-${effectApplied ? 'applied' : 'unconfirmed'}.json`), JSON.stringify({
        node: process.version, kind, effectApplied, originalPid: child.pid, replacementPid: result.pid,
        originalExit: { code: null, signal: 'SIGKILL' }, originalSends, effects, originalIntent: before,
        coldIntent: after, result, originalCheckpoint: saved.projection, coldCheckpoint: records().projection,
      }, null, 2) + '\n', { mode: 0o600 });
    }
  });
}
