import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { NativeKernel, emptyUsage, canonical } from '../dist/index.mjs';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { scope, digest, verificationReport } from './fixtures.mjs';
const data = findings => ({ requirements: [{ requirement: 'Keep zero accounts.', implementation_evidence: 'ledger.ts', verification_evidence: 'Missing host semantics.' }], findings });
const finding = { issue: 'Missing zero case.', recommended_check: 'Inspect and repair.' };
for (const boundary of ['pending', 'suffix', 'applied', 'cancel']) test(`actual review SIGKILL at ${boundary} preserves candidate, private protocol and effect identity`, { timeout: 15000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'native-review-kill-')), filename = join(root, 'run.sqlite'), file = join(root, 'ledger.ts');
  const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/delivery-review-worker.mjs', import.meta.url)), filename, boundary],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, PATH: '/nonexistent-native-review-path' } });
  let stderr = '', store; child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); store?.close(); rmSync(root, { recursive: true, force: true }); });
  const ready = await Promise.race([once(child, 'message').then(([row]) => row),
    once(child, 'exit').then(([code, signal]) => { throw Error(`Review worker exited ${code}/${signal}: ${stderr}`); })]);
  assert.equal(ready.pid, child.pid); assert.notEqual(ready.pid, process.pid);
  assert.equal(ready.models, boundary === 'suffix' ? 3 : boundary === 'applied' ? 4 : 2);
  const exit = once(child, 'exit'); child.kill('SIGKILL'); const [code, signal] = await exit;
  assert.equal(code, null); assert.equal(signal, 'SIGKILL'); assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
  store = new SqliteRunStore(filename); const before = store.load(scope, 'run');
  assert.equal(readFileSync(join(root, 'effects.jsonl'), 'utf8').trim().split('\n').length, boundary === 'applied' ? 2 : 1);
  assert.equal(readFileSync(file, 'utf8'), boundary === 'applied' ? 'fixed' : 'broken');
  let models = 0, writes = 0;
  const response = (kind, text = '', toolCalls = []) => ({ kind, text, toolCalls, usage: emptyUsage() });
  const worker = new NativeKernel({ store, digest, owner: 'cold-review-owner', now: () => Date.now() + 60000, ports: {
    model: { generate: async request => {
      models++;
      if (models === 1 && boundary === 'suffix') return response('final_candidate', canonical(data([finding])).slice(100));
      if (request.purpose === 'delivery_review') return response('tool_calls', '', [{ callId: `cold-review-${models}`, name: 'submit_delivery_review',
        arguments: data(models === 1 ? [finding] : []) }]);
      return models === 2 ? response('tool_calls', '', [{ callId: 'cold-repair', name: 'write', arguments: { text: 'fixed' } }])
        : response('final_candidate', 'Repaired.');
    } }, tools: { execute: async request => { writes++; writeFileSync(file, request.call.arguments.text);
      return { status: 'ok', content: 'written', workspaceChangedPaths: ['ledger.ts'] }; } },
    workspace: { observe: async () => ({ status: 'ok', revision: digest(readFileSync(file, 'utf8')), changedPaths: ['ledger.ts'] }) },
    verification: { verify: async request => verificationReport(request, { status: 'unverified', checks: [{ id: 'test', status: 'not_run', verifierId: 'fixture',
      verifierVersion: '1', verificationMethod: 'human', safeSummary: 'No semantic verifier.', evidenceRefs: ['fixture://public-test'] }] }) },
  } });
  worker.attach(scope, 'run', before.configuration);
  if (boundary === 'cancel') worker.submit(scope, 'run', { commandId: 'cancel-pending-review', kind: 'cancel', payload: {} });
  const result = await worker.runUntilIdle(scope, 'run');
  if (boundary === 'cancel') { assert.equal(result.phase, 'canceled'); assert.equal(models + writes, 0); }
  else if (boundary === 'applied') { assert.equal(result.reason, 'effect_outcome_unknown'); assert.equal(models + writes, 0); }
  else { assert.equal(result.phase, 'completed'); assert.equal(result.finalText, 'Repaired.'); assert.equal(result.outcome, 'unverified');
    assert.equal(models, 4); assert.equal(writes, 1); assert.equal(result.usage.modelCalls, boundary === 'suffix' ? 7 : 6); }
  assert.deepEqual(store.load(scope, 'run').receipts.slice(0, before.receipts.length), before.receipts);
});
