import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, realpathSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { scope } from './fixtures.mjs';
const worker = fileURLToPath(new URL('./fixtures/artifact-runtime-process.mjs', import.meta.url));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

for (const checkpoint of ['archive-published', 'receipt-committed']) test(`actual SIGKILL at ${checkpoint}: durable archive grants follow the receipt, and the original mutation never repeats`,
  { timeout: 20000 }, async t => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'artifact-process-'))), messages = [], children = []; let errors = '';
    t.after(() => { for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      rmSync(root, { recursive: true, force: true }); });
    const start = mode => {
      const child = spawn(process.execPath, [worker, mode, root, checkpoint], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      children.push(child); child.stderr.on('data', data => { errors += data; }); child.on('message', message => messages.push(message)); return child;
    };
    const original = start('run');
    const ready = await Promise.race([once(original, 'message'), once(original, 'exit').then(([code]) => { throw new Error(`${code}: ${errors}`); })]);
    assert.equal(ready[0].checkpoint, checkpoint);
    const closed = once(original, 'exit'); original.kill('SIGKILL'); assert.deepEqual(await closed, [null, 'SIGKILL']);
    let store = new SqliteRunStore(join(root, 'runs.sqlite')), record = store.load(scope, 'run'); store.close();
    assert.equal(record.snapshot.artifactRefs.length, checkpoint === 'receipt-committed' ? 1 : 0);
    await delay(Math.max(0, (record.lease?.expiresAt ?? 0) - Date.now() + 20));
    const replacement = start('recover'), exited = once(replacement, 'exit');
    const [exitCode] = await exited; assert.equal(exitCode, 0, errors);
    const done = messages.find(message => message.done); assert.ok(done, errors); assert.notEqual(done.pid, original.pid);
    assert.equal(readFileSync(join(root, 'mutations'), 'utf8').trim(), String(original.pid));
    assert.equal(done.phase, checkpoint === 'receipt-committed' ? 'completed' : 'interrupted');
    assert.equal(done.artifactRefs.length, checkpoint === 'receipt-committed' ? 1 : 0);
    if (checkpoint === 'archive-published') {
      assert.equal(done.outcome, 'unverified'); assert.equal(done.reason, 'effect_outcome_unknown');
      assert.equal(done.receipts.at(-1).status, 'uncertain'); assert.deepEqual(done.reads, []);
    } else {
      assert.equal(done.reads.length, 1); assert.equal(done.reads[0].uri, done.artifactRefs[0].uri);
      assert.equal(done.reads[0].returned_chars, 32); assert.ok(done.receipts.some(receipt => receipt.result.results?.[0]?.content?.committed));
    }
  });
