import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { StudioNativeMemoryExtractionStore } from '../src/host/services/native-memory-extraction-store.mjs';
import { scope } from '../packages/agentkit-harness-core/test/fixtures.mjs';

for (const checkpoint of ['before-enqueue', 'queued', 'effect-committed']) {
  test(`real SIGKILL at Memory ${checkpoint}: cold Host discovery retains identity and never replays the write`,
    { timeout: checkpoint === 'effect-committed' ? 120000 : 15000 }, async t => {
      const root = mkdtempSync(join(tmpdir(), 'memory-process-')), requests = [];
      const server = createServer(async (request, response) => {
        let raw = ''; for await (const chunk of request) raw += chunk;
        const body = JSON.parse(raw); requests.push(body);
        const called = body.messages.some(message => message.role === 'tool');
        const input = JSON.parse(body.messages.find(message => message.role === 'user').content);
        const message = called ? { role: 'assistant', content: 'Memory saved.' } : { role: 'assistant', content: null,
          tool_calls: [{ id: 'original-write', type: 'function', function: { name: 'manage_memory', arguments: JSON.stringify({
            action: 'remember', scope: 'user', content: 'Financial reports use UTC.', memory_type: 'fact',
            source_event_ids: [input.source.messages.find(message => message.role === 'user' && !message.modelOnly).id] }) } }] };
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ choices: [{ message, finish_reason: called ? 'stop' : 'tool_calls' }],
          usage: { prompt_tokens: 11, completion_tokens: 7 } }));
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const children = [];
      t.after(async () => {
        for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(root, { recursive: true, force: true });
      });
      const start = async phase => {
        const child = spawn(process.execPath, [new URL('./fixtures/native-memory-extraction-process.mjs', import.meta.url).pathname,
          root, phase, `http://127.0.0.1:${server.address().port}/v1`], {
          stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, PATH: dirname(process.execPath), AGENTKIT_PYTHON: '/unavailable/python' } });
        children.push(child);
        let stderr = ''; child.stderr.on('data', data => { stderr += data; });
        const [code, signal] = await once(child, 'exit');
        return { pid: child.pid, code, signal, stderr };
      };
      const original = await start(checkpoint);
      assert.equal(original.signal, 'SIGKILL', original.stderr); assert.equal(original.code, null);
      assert.equal(JSON.parse(readFileSync(join(root, 'checkpoint.json'))).pid, original.pid);
      const before = new StudioNativeMemoryExtractionStore(join(root, 'native-harness', 'memory-extraction.sqlite'));
      const admitted = before.list({ scope, sessionId: 'session' }); before.close();
      if (checkpoint === 'before-enqueue') assert.equal(admitted.length, 0);
      else {
        assert.equal(admitted.length, 1);
        assert.equal(admitted[0].status, checkpoint === 'queued' ? 'queued' : 'running');
      }
      if (checkpoint === 'effect-committed') {
        // Observe the production 90s job lease, without lowering it, editing
        // stored records or advancing the clock. The uncertain effect's full
        // elapsed time remains chargeable against its original 60s budget.
        await new Promise(resolve => setTimeout(resolve, Math.max(0, admitted[0].lease.expiresAt - Date.now() + 30)));
      }
      const cold = await start('recover'); assert.equal(cold.code, 0, cold.stderr);
      assert.notEqual(cold.pid, original.pid);
      const result = JSON.parse(readFileSync(join(root, 'recovered.json')));
      assert.deepEqual(result.errors, []);
      assert.equal(result.parent.phase, 'completed'); assert.equal(result.parent.usage.modelCalls, 1);
      assert.equal(result.facts.length, 1); assert.equal(result.facts[0].version, 1);
      assert.equal(result.state.jobs.length, 1);
      if (admitted.length) assert.equal(result.state.jobs[0].jobId, admitted[0].jobId);
      const run = result.auxiliary[0];
      t.diagnostic(JSON.stringify({ checkpoint, originalPid: original.pid, coldPid: cold.pid,
        modelRequests: requests.length, facts: result.facts.length, status: result.state.jobs[0].status,
        phase: run.snapshot.phase, outcome: run.snapshot.outcome, reason: run.snapshot.reason }));
      assert.equal(run.intents.filter(intent => intent.kind === 'tool').length, 1);
      if (checkpoint === 'effect-committed') {
        assert.equal(requests.length, 1, 'expired wall budget must not admit another model request');
        assert.equal(run.events.filter(event => event.kind === 'tool.receipt_reconciled').length, 0,
          'the original wall budget also gates a newly admitted receipt query');
        assert.equal(run.snapshot.outcome, 'budget_exhausted');
        assert.equal(run.receipts.find(receipt => receipt.operationKey === run.intents.find(intent => intent.kind === 'tool').operationKey)?.status, 'uncertain');
        assert.equal(result.state.jobs[0].status, 'error');
        assert.equal(result.state.cursor, null, 'confirmed write is not proof that the whole extraction completed');
      } else {
        assert.equal(requests.length, 2);
        assert.equal(result.state.jobs[0].status, 'success'); assert.ok(result.state.cursor);
        const repeated = await start('recover'); assert.equal(repeated.code, 0, repeated.stderr);
        assert.equal(requests.length, 2);
        assert.deepEqual(JSON.parse(readFileSync(join(root, 'recovered.json'))).state, result.state);
      }
    });
}
